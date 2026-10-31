"""Laya on this machine, over TypeSafe's ``/v1/systemone`` wire (the Jev protocol).

The jamstate Jev brain posts ``{model, state, questions}`` and reads ``answers``;
Laya answers the same shape, so the bake-off's ``laya`` brain is the Jev brain
pointed here. ``laya`` ships its own server (``python -m laya.serve``), but it
preloads every checkpoint and goes to the Hub; this one loads one checkpoint
from the local cache and nothing else.

    LAYA_CHECKPOINT=convaiinnovations/laya-multilingual LAYA_BACKEND=torch \\
        python laya_server.py --port 8010

Backends: ``torch`` (laya's own runtime; MPS on a Mac, CUDA on the Spark) and
``mlx`` (``laya_mlx.py``, Apple silicon only).
"""
import argparse
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock


def load_agent(checkpoint: str, backend: str, revision: str | None):
    if backend == "mlx":
        from laya_mlx import MLXAgent

        return MLXAgent(checkpoint, revision=revision)
    import laya

    return laya.load(checkpoint, revision=revision)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8010)
    ap.add_argument("--checkpoint", default=os.environ.get("LAYA_CHECKPOINT", "convaiinnovations/laya-multilingual"))
    ap.add_argument("--revision", default=os.environ.get("LAYA_REVISION_SHA"))
    ap.add_argument("--backend", default=os.environ.get("LAYA_BACKEND", "torch"), choices=["torch", "mlx"])
    ap.add_argument("--max-len", type=int, default=1024)
    a = ap.parse_args()

    t0 = time.perf_counter()
    agent = load_agent(a.checkpoint, a.backend, a.revision)
    name = f"{a.checkpoint.split('/')[-1]}@{a.backend}"
    # One throwaway call, so the first real turn doesn't pay for kernel compiles.
    agent.predict("warm up", {"q": {"type": "noul", "instructions": "Is this a test?"}}, max_len=a.max_len)
    print(f"loaded {name} in {time.perf_counter() - t0:.1f}s", flush=True)
    lock = Lock()  # one forward at a time; the bake-off asks serially anyway

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        def _cors(self) -> None:
            # The page calls this straight from the browser; it only listens on 127.0.0.1.
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-headers", "content-type, authorization")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
            # Chrome's private network access check, for a page served from another host (the Spark).
            self.send_header("access-control-allow-private-network", "true")

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self._cors()
            self.send_header("content-length", "0")
            self.end_headers()

        def do_GET(self) -> None:
            self._send(200, {"ok": True, "model": name}) if self.path == "/health" else self._send(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path.rstrip("/") != "/v1/systemone":
                return self._send(404, {"error": "not found"})
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
                t = time.perf_counter()
                with lock:
                    r = agent.predict(req["state"], req["questions"], max_len=a.max_len)
                ms = (time.perf_counter() - t) * 1000
                self._send(200, {"model": name, "answers": r["answers"], "usage": {**r.get("usage", {}), "compute_ms": round(ms, 1)}})
            except Exception as e:  # noqa: BLE001
                self._send(500, {"error": f"{type(e).__name__}: {e}"})

        def log_message(self, *args) -> None:
            pass

    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
