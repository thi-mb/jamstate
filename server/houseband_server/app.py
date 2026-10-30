"""The houseband app server: serves the built web app and the /api endpoints.

Runs on the DGX Spark next to the model. Holds no session state: every
request carries everything it needs, so restarting it loses nothing.
"""

from __future__ import annotations

import json
import logging
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .leader import ask_leader, write_chart
from .llm import LLMClient, LLMError

log = logging.getLogger("houseband")

MAX_BODY = 64 * 1024


class App:
    def __init__(self, static_dir: Path | None, llm: LLMClient | None):
        self.static_dir = static_dir.resolve() if static_dir else None
        self.llm = llm

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "llm_url": self.llm.base_url if self.llm else None,
            "model": self.llm.model if self.llm else None,
            "static": str(self.static_dir) if self.static_dir else None,
        }


def make_handler(app: App) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "houseband"

        def log_message(self, fmt: str, *args: Any) -> None:  # route through logging
            log.debug("%s %s", self.address_string(), fmt % args)

        def _json(self, status: int, body: Any) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> Any:
            n = int(self.headers.get("content-length") or 0)
            if n > MAX_BODY:
                raise ValueError("request too large")
            return json.loads(self.rfile.read(n) or b"null")

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/api/health":
                return self._json(200, app.health())
            if path.startswith("/api/"):
                return self._json(404, {"error": "not found"})
            self._static(path)

        def do_POST(self) -> None:
            path = self.path.split("?", 1)[0]
            try:
                body = self._body()
            except (ValueError, json.JSONDecodeError) as e:
                return self._json(400, {"error": f"bad request: {e}"})
            if path not in ("/api/leader", "/api/chart"):
                return self._json(404, {"error": "not found"})
            if app.llm is None:
                return self._json(503, {"error": "no LLM configured (start the server with --llm-url)"})
            try:
                if path == "/api/leader":
                    if not isinstance(body, dict):
                        return self._json(400, {"error": "summary must be an object"})
                    out = ask_leader(app.llm, body)
                    log.info("leader bar=%s %d ms moves=%s rejected=%d", body.get("bar"), out["latency_ms"], [m["move"] for m in out["moves"]], len(out["rejected"]))
                else:
                    prompt = body.get("prompt") if isinstance(body, dict) else None
                    if not isinstance(prompt, str) or not prompt.strip():
                        return self._json(400, {"error": "prompt is required"})
                    out = write_chart(app.llm, prompt[:2000])
                return self._json(200, out)
            except LLMError as e:
                log.warning("%s failed: %s", path, e)
                return self._json(502, {"error": str(e)})

        def _static(self, path: str) -> None:
            if app.static_dir is None:
                return self._json(404, {"error": "no static dir (build web/ and pass --static web/dist)"})
            rel = path.lstrip("/") or "index.html"
            target = (app.static_dir / rel).resolve()
            if app.static_dir not in target.parents and target != app.static_dir:
                return self._json(404, {"error": "not found"})
            if target.is_dir():
                target = target / "index.html"
            if not target.is_file():
                target = app.static_dir / "index.html"  # single-page app fallback
                if not target.is_file():
                    return self._json(404, {"error": "not found"})
            data = target.read_bytes()
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "no-cache" if target.name == "index.html" else "public, max-age=3600")
            self.end_headers()
            self.wfile.write(data)

    return Handler


def serve(app: App, host: str, port: int) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    httpd.daemon_threads = True
    return httpd
