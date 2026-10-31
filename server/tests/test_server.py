import json
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from jamstate_server.app import App, serve
from jamstate_server.leader import SCHEMA_DIR, split_moves, validate_move
from jamstate_server.llm import LLMClient, LLMError, extract_json

REPO = Path(__file__).resolve().parents[2]

SUMMARY = {
    "bar": 15,
    "section": "verse",
    "bar_in_section": 3,
    "section_bars": 8,
    "phrase_bars": 4,
    "intensity": 0.4,
    "target": 0.4,
    "layers": ["drums", "bass", "chords"],
    "feel": "normal",
    "form": ["intro", "verse", "chorus"],
    "form_pos": 1,
    "sections": ["intro", "verse", "chorus"],
    "player": {"bars": 4, "energy": 0.8, "density": 3.1, "mean_velocity": 0.8, "rest_ratio": 0.1,
               "repetition": 0.2, "register": "mid", "trend": "rising", "silent_bars": 0},
    "recent_moves": [],
}


class FakeModel:
    """A stand-in OpenAI-compatible server that records requests."""

    def __init__(self, replies, reject_formats=()):
        self.replies = list(replies)
        self.reject_formats = set(reject_formats)
        self.requests = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                fake.requests.append(body)
                fmt = (body.get("response_format") or {}).get("type")
                if fmt in fake.reject_formats:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b'{"error":"unsupported response_format"}')
                    return
                content = fake.replies.pop(0) if fake.replies else '{"moves":[]}'
                data = json.dumps({"model": "fake-model", "choices": [{"message": {"content": content}}]}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1"

    def close(self):
        self.httpd.shutdown()


@pytest.fixture
def static_dir(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>Jam State</title>")
    (tmp_path / "charts").mkdir()
    (tmp_path / "charts" / "a.json").write_text('{"x":1}')
    return tmp_path


def start_app(static_dir, llm):
    httpd = serve(App(static_dir, llm), "127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status, r.headers.get("content-type"), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("content-type"), e.read()


def test_leader_proxy_returns_valid_moves_and_reports_rejects(static_dir):
    reply = json.dumps({"moves": [
        {"move": "set_intensity", "value": 0.8, "reason": "You're pushing, so are we"},
        {"move": "jump_to_section", "section": "bridge", "reason": "nope"},
    ]})
    model = FakeModel([reply])
    httpd, base = start_app(static_dir, LLMClient(model.url, "fake"))
    try:
        status, body = post(base + "/api/leader", SUMMARY)
        assert status == 200
        assert body["moves"] == [{"move": "set_intensity", "value": 0.8, "reason": "You're pushing, so are we"}]
        assert body["rejected"][0]["error"].startswith("section must be one of")
        assert body["model"] == "fake-model"
        sent = model.requests[0]
        assert sent["response_format"]["type"] == "json_schema"
        assert sent["response_format"]["json_schema"]["schema"]["properties"]["moves"]["maxItems"] == 2
        assert json.loads(sent["messages"][1]["content"])["bar"] == 15
    finally:
        httpd.shutdown()
        model.close()


def test_falls_back_when_json_schema_unsupported():
    model = FakeModel(['{"moves":[]}'], reject_formats={"json_schema"})
    try:
        res = LLMClient(model.url).chat("s", "u", {"type": "object"})
        assert res.text == '{"moves":[]}'
        assert [ (r.get("response_format") or {}).get("type") for r in model.requests] == ["json_schema", "json_object"]
    finally:
        model.close()


def test_leader_errors_are_502_and_no_llm_is_503(static_dir):
    httpd, base = start_app(static_dir, LLMClient("http://127.0.0.1:9/v1", timeout=1))
    try:
        status, body = post(base + "/api/leader", SUMMARY)
        assert status == 502 and "unreachable" in body["error"]
    finally:
        httpd.shutdown()
    httpd, base = start_app(static_dir, None)
    try:
        assert post(base + "/api/leader", SUMMARY)[0] == 503
        status, _, data = get(base + "/api/health")
        assert status == 200 and json.loads(data)["llm_url"] is None
    finally:
        httpd.shutdown()


def test_static_files_and_no_path_traversal(static_dir, tmp_path_factory):
    secret = static_dir.parent / "secret.txt"
    secret.write_text("nope")
    httpd, base = start_app(static_dir, None)
    try:
        status, ctype, data = get(base + "/")
        assert status == 200 and b"Jam State" in data and ctype.startswith("text/html")
        status, ctype, data = get(base + "/charts/a.json")
        assert status == 200 and json.loads(data) == {"x": 1}
        status, _, data = get(base + "/../secret.txt")
        assert b"nope" not in data
        status, _, data = get(base + "/%2e%2e/secret.txt")
        assert b"nope" not in data
    finally:
        httpd.shutdown()


def test_chart_endpoint(static_dir):
    chart = json.loads((REPO / "web/public/charts/night-shift.json").read_text())
    model = FakeModel(["```json\n" + json.dumps(chart) + "\n```"])
    httpd, base = start_app(static_dir, LLMClient(model.url))
    try:
        status, body = post(base + "/api/chart", {"prompt": "moody F minor groove"})
        assert status == 200 and body["chart"]["title"] == "Night Shift"
        assert post(base + "/api/chart", {})[0] == 400
    finally:
        httpd.shutdown()
        model.close()


def test_extract_json_tolerates_chatter():
    assert extract_json('<think>hmm</think>Sure! {"moves": []} hope that helps') == {"moves": []}
    with pytest.raises(LLMError):
        extract_json("no json here")


def test_validate_move():
    assert validate_move({"move": "add_layer", "part": "drums", "reason": "x"}) is None
    assert validate_move({"move": "add_layer", "part": "keys", "reason": "x"})
    assert validate_move({"move": "set_intensity", "value": 2, "reason": "x"})
    assert validate_move({"move": "set_intensity", "value": 0.5})  # reason required
    assert validate_move({"move": "extend_section", "bars": True, "reason": "x"})
    ok, bad = split_moves({"moves": [{"move": "fire_stinger", "stinger": "fill", "reason": "a"}] * 3})
    assert len(ok) == 2 and len(bad) == 1


def test_schemas_accept_examples_and_match_validator():
    jsonschema = pytest.importorskip("jsonschema")
    chart_schema = json.loads((SCHEMA_DIR / "chart.schema.json").read_text())
    for p in sorted((REPO / "web/public/charts").glob("*.json")):
        if p.name != "index.json":
            jsonschema.validate(json.loads(p.read_text()), chart_schema)
    moves_schema = json.loads((SCHEMA_DIR / "moves.schema.json").read_text())
    good = {"moves": [{"move": "change_feel", "feel": "half_time", "reason": "space"}]}
    jsonschema.validate(good, moves_schema)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"moves": [{"move": "change_feel", "feel": "waltz", "reason": "x"}]}, moves_schema)


def test_genre_packs_match_their_schema():
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((SCHEMA_DIR / "genre.schema.json").read_text())
    packs = sorted((REPO / "genres").glob("*.json"))
    assert {p.stem for p in packs} >= {"funk", "blues-rock", "jazz"}
    for p in packs:
        jsonschema.validate(json.loads(p.read_text()), schema)


def test_end_song_is_not_a_leader_move():
    # The player ends songs; the LLM's schema and the server both leave end_song out.
    assert validate_move({"move": "end_song", "reason": "bye"})
    assert "end_song" not in (SCHEMA_DIR / "moves.schema.json").read_text()


def test_sessions_are_saved_listed_and_loaded(static_dir, tmp_path):
    from jamstate_server.sessions import SessionStore

    store = SessionStore(tmp_path / "sessions")
    httpd = serve(App(static_dir, None, store), "127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        session = {"format": "jamstate-session/0.1", "title": "Night Shift!", "chart": {}, "player": [[0, 60, 90]], "controls": [], "bars": [{"bar": 0}] * 3}
        status, body = post(f"{base}/api/sessions", session)
        assert status == 200 and body["name"].endswith("-night-shift.json")
        status, _, raw = get(f"{base}/api/sessions")
        listed = json.loads(raw)["sessions"]
        assert listed[0]["name"] == body["name"] and listed[0]["bars"] == 3
        status, _, raw = get(f"{base}/api/sessions/{body['name']}")
        assert status == 200 and json.loads(raw)["player"] == [[0, 60, 90]]
        assert post(f"{base}/api/sessions", {"format": "nope"})[0] == 400
        assert get(f"{base}/api/sessions/..%2F..%2Fetc%2Fpasswd")[0] == 404
        # The LLM endpoints still say no LLM while sessions work.
        assert post(f"{base}/api/leader", SUMMARY)[0] == 503
    finally:
        httpd.shutdown()
