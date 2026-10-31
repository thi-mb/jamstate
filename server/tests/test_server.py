import json
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from jamstate_server.app import App, Relay, serve

REPO = Path(__file__).resolve().parents[2]
SCHEMA_DIR = REPO / "schema"

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
        self.headers = []
        self.paths = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                fake.requests.append(body)
                fake.headers.append(dict(self.headers))
                fake.paths.append(self.path)
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
    (tmp_path / "index.html").write_text("<!doctype html><title>jamstate</title>")
    (tmp_path / "charts").mkdir()
    (tmp_path / "charts" / "a.json").write_text('{"x":1}')
    return tmp_path


def start_app(static_dir, relays=None, sessions=None, cors=()):
    httpd = serve(App(static_dir, relays or {}, sessions, tuple(cors), "fake"), "127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def post(url, body, headers=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", **(headers or {})}, method="POST")
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


def test_llm_relay_forwards_bytes_and_adds_the_servers_key_same_origin_only(static_dir):
    model = FakeModel(['{"moves":[]}', '{"moves":[]}'])
    httpd, base = start_app(static_dir, {"llm": Relay(model.url, "server-key")})
    try:
        req = {"model": "leader", "messages": [{"role": "user", "content": "hi"}]}
        status, body = post(base + "/api/relay/llm/chat/completions", req)
        assert status == 200 and body["model"] == "fake-model"
        assert model.requests[0] == req and model.paths[0] == "/v1/chat/completions"
        assert model.headers[0].get("Authorization") == "Bearer server-key"
        # The page's own key wins over the server's.
        post(base + "/api/relay/llm/chat/completions", req, {"authorization": "Bearer mine"})
        assert model.headers[1].get("Authorization") == "Bearer mine"
        # Only chat/completions is relayed, and other sites can't use it.
        assert post(base + "/api/relay/llm/models", req)[0] == 404
        assert post(base + "/api/relay/llm/chat/completions", req, {"origin": "https://evil.example"})[0] == 403
        assert post(base + "/api/relay/nope/x", req)[0] == 503
    finally:
        httpd.shutdown()
        model.close()


def test_relay_passes_provider_errors_through_and_reports_unreachable(static_dir):
    model = FakeModel([], reject_formats={"json_schema"})
    httpd, base = start_app(static_dir, {"llm": Relay(model.url), "jev": Relay("http://127.0.0.1:9/v1", timeout=1)})
    try:
        status, _ = post(base + "/api/relay/llm/chat/completions", {"response_format": {"type": "json_schema"}})
        assert status == 400
        status, body = post(base + "/api/relay/jev", {"state": {}, "questions": {}})
        assert status == 502 and "unreachable" in body["error"]
    finally:
        httpd.shutdown()
        model.close()


def test_cors_only_for_listed_origins(static_dir):
    model = FakeModel(['{"ok":1}'])
    httpd, base = start_app(static_dir, {"llm": Relay(model.url, "server-key")}, cors=("https://jam.example",))
    try:
        pre = urllib.request.Request(base + "/api/relay/llm/chat/completions", method="OPTIONS",
                                     headers={"origin": "https://jam.example", "access-control-request-method": "POST"})
        with urllib.request.urlopen(pre, timeout=5) as r:
            assert r.status == 204 and r.headers["access-control-allow-origin"] == "https://jam.example"
        bad = urllib.request.Request(base + "/api/relay/llm/chat/completions", method="OPTIONS", headers={"origin": "https://evil.example"})
        with pytest.raises(urllib.error.HTTPError):
            urllib.request.urlopen(bad, timeout=5)
        status, _ = post(base + "/api/relay/llm/chat/completions", {}, {"origin": "https://jam.example"})
        assert status == 200
        # A listed origin must bring its own key: the server's key is same-origin only.
        assert "Authorization" not in model.headers[0]
    finally:
        httpd.shutdown()
        model.close()


def test_health_lists_relays(static_dir):
    httpd, base = start_app(static_dir)
    try:
        status, _, data = get(base + "/api/health")
        h = json.loads(data)
        assert status == 200 and h["ok"] and h["relay"] == {} and h["llm_url"] is None
        # The bandleader endpoints moved into the page (ADR-0015).
        assert post(base + "/api/leader", SUMMARY)[0] == 404
    finally:
        httpd.shutdown()


def test_static_files_and_no_path_traversal(static_dir, tmp_path_factory):
    secret = static_dir.parent / "secret.txt"
    secret.write_text("nope")
    httpd, base = start_app(static_dir)
    try:
        status, ctype, data = get(base + "/")
        assert status == 200 and b"jamstate" in data and ctype.startswith("text/html")
        status, ctype, data = get(base + "/charts/a.json")
        assert status == 200 and json.loads(data) == {"x": 1}
        status, _, data = get(base + "/../secret.txt")
        assert b"nope" not in data
        status, _, data = get(base + "/%2e%2e/secret.txt")
        assert b"nope" not in data
    finally:
        httpd.shutdown()


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
    # The player ends songs; the LLM's schema leaves end_song out (the page checks the rest).
    assert "end_song" not in (SCHEMA_DIR / "moves.schema.json").read_text()


def test_sessions_are_saved_listed_and_loaded(static_dir, tmp_path):
    from jamstate_server.sessions import SessionStore

    store = SessionStore(tmp_path / "sessions")
    httpd = serve(App(static_dir, {}, store), "127.0.0.1", 0)
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
        assert post(f"{base}/api/sessions", session, {"origin": "https://evil.example"})[0] == 403
    finally:
        httpd.shutdown()


def lower(h):
    return {k.lower(): v for k, v in h.items()}


def test_claude_relay_uses_the_servers_key_only_same_origin(static_dir):
    model = FakeModel(['{"moves":[]}', '{"moves":[]}', '{"moves":[]}'])
    httpd, base = start_app(static_dir, {"anthropic": Relay(model.url.removesuffix("/v1"), "server-key")})
    try:
        req = {"model": "claude-x", "max_tokens": 10, "messages": [{"role": "user", "content": "hi"}]}
        hdr = {"x-api-key": "relay", "anthropic-version": "2023-06-01"}
        assert post(base + "/api/relay/anthropic/v1/messages", req, hdr)[0] == 200
        assert model.paths[0] == "/v1/messages"
        assert lower(model.headers[0]).get("x-api-key") == "server-key"
        assert lower(model.headers[0]).get("anthropic-version") == "2023-06-01"
        post(base + "/api/relay/anthropic/v1/messages", req, {**hdr, "x-api-key": "mine"})
        assert lower(model.headers[1]).get("x-api-key") == "mine"
        assert post(base + "/api/relay/anthropic/v1/models", req, hdr)[0] == 404
        assert post(base + "/api/relay/anthropic/v1/messages", req, {**hdr, "origin": "https://evil.example"})[0] == 403
    finally:
        httpd.shutdown()
        model.close()
