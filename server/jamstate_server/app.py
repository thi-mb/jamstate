"""The optional jamstate companion server (ADR-0015).

The page plays without it. When it runs (on the Spark, or on a player's own
machine) it adds what a static host can't:
- serves the built page;
- relays brain calls to providers a web page can't reach directly: the local
  OpenAI-compatible model (Qwen on the Spark, only reachable from the box)
  and Jev (TypeSafe blocks browser calls);
- saves recorded sessions as files (optional sync for the eval set).

Prompts and move checking live in the page now; the relay forwards bytes and
never reads the music. Holds no jam state, so restarting it loses nothing.
"""

from __future__ import annotations

import json
import logging
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import urllib.error
import urllib.request
from dataclasses import dataclass, field
from urllib.parse import unquote, urlsplit

from .sessions import MAX_SESSION_BYTES, SessionError, SessionStore

log = logging.getLogger("jamstate")

MAX_BODY = 64 * 1024
JEV_API = "https://api.typesafe.ai/v1/systemone"
ANTHROPIC_API = "https://api.anthropic.com"
# The page sends this as its Claude key to mean "use the server's key".
RELAY_KEY = "relay"


@dataclass
class Relay:
    """Where a relay forwards to. `key` is the server's own key, used only for
    same-origin requests that bring none (so another site can't spend it)."""

    url: str
    key: str | None = None
    timeout: float = 15.0


@dataclass
class App:
    static_dir: Path | None = None
    relays: dict[str, Relay] = field(default_factory=dict)
    sessions: SessionStore | None = None
    #: Origins allowed to call the API from another site (CORS); same-origin always works.
    cors_origins: tuple[str, ...] = ()
    #: Model name to show in /api/health for the llm relay.
    llm_model: str | None = None

    def __post_init__(self) -> None:
        self.static_dir = self.static_dir.resolve() if self.static_dir else None

    def health(self) -> dict[str, Any]:
        llm = self.relays.get("llm")
        return {
            "ok": True,
            "relay": {name: True for name in self.relays},
            "llm_url": llm.url if llm else None,
            "model": self.llm_model if llm else None,
            "static": str(self.static_dir) if self.static_dir else None,
            "sessions": str(self.sessions.root) if self.sessions else None,
        }


def make_handler(app: App) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "jamstate"

        def log_message(self, fmt: str, *args: Any) -> None:  # route through logging
            log.debug("%s %s", self.address_string(), fmt % args)

        def _origin_allowed(self) -> str | None:
            origin = self.headers.get("origin")
            if origin and (origin in app.cors_origins or "*" in app.cors_origins):
                return origin
            return None

        def _same_origin(self) -> bool:
            origin = self.headers.get("origin")
            if not origin:
                return True  # curl, scripts, same-origin GETs
            return urlsplit(origin).netloc == self.headers.get("host")

        def _cors(self) -> None:
            origin = self._origin_allowed()
            if origin:
                self.send_header("access-control-allow-origin", origin)
                self.send_header("vary", "origin")

        def _json(self, status: int, body: Any) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self) -> None:
            if not self.path.startswith("/api/") or not self._origin_allowed():
                self.send_response(403)
                self.send_header("content-length", "0")
                self.end_headers()
                return
            self.send_response(204)
            self._cors()
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
            self.send_header("access-control-allow-headers", "authorization, content-type")
            self.send_header("access-control-max-age", "600")
            self.send_header("content-length", "0")
            self.end_headers()

        def _body(self, limit: int = MAX_BODY) -> Any:
            n = int(self.headers.get("content-length") or 0)
            if n > limit:
                raise ValueError("request too large")
            return json.loads(self.rfile.read(n) or b"null")

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/api/health":
                return self._json(200, app.health())
            if path == "/api/sessions" or path.startswith("/api/sessions/"):
                return self._get_session(unquote(path[len("/api/sessions/"):]) if path.startswith("/api/sessions/") else "")
            if path.startswith("/api/"):
                return self._json(404, {"error": "not found"})
            self._static(path)

        def _get_session(self, name: str) -> None:
            if app.sessions is None:
                return self._json(503, {"error": "session storage is off"})
            if not name:
                return self._json(200, {"sessions": app.sessions.list()})
            try:
                return self._json(200, app.sessions.load(name))
            except (SessionError, FileNotFoundError):
                return self._json(404, {"error": "no such session"})

        def do_POST(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/api/sessions":
                if not self._same_origin() and not self._origin_allowed():
                    return self._json(403, {"error": "origin not allowed"})
                if app.sessions is None:
                    return self._json(503, {"error": "session storage is off"})
                try:
                    name = app.sessions.save(self._body(MAX_SESSION_BYTES))
                except (ValueError, json.JSONDecodeError) as e:
                    return self._json(400, {"error": str(e)})
                log.info("saved session %s", name)
                return self._json(200, {"name": name})
            if path.startswith("/api/relay/"):
                return self._relay(path[len("/api/relay/"):])
            return self._json(404, {"error": "not found"})

        def _relay(self, rest: str) -> None:
            name, _, sub = rest.partition("/")
            relay = app.relays.get(name)
            if relay is None:
                return self._json(503, {"error": f"no {name} relay on this server"})
            if not self._same_origin() and not self._origin_allowed():
                return self._json(403, {"error": "origin not allowed"})
            if name == "jev":
                target = relay.url
            elif name == "anthropic":
                if sub != "v1/messages":
                    return self._json(404, {"error": "not found"})
                target = relay.url.rstrip("/") + "/" + sub
            else:
                # Only the one call the page makes; this is not a general proxy.
                if sub != "chat/completions":
                    return self._json(404, {"error": "not found"})
                target = relay.url.rstrip("/") + "/" + sub
            n = int(self.headers.get("content-length") or 0)
            if n > MAX_BODY:
                return self._json(413, {"error": "request too large"})
            data = self.rfile.read(n)
            headers = {"content-type": "application/json"}
            if name == "anthropic":
                key = self.headers.get("x-api-key")
                if (not key or key == RELAY_KEY) and relay.key and self._same_origin():
                    key = relay.key
                if key and key != RELAY_KEY:
                    headers["x-api-key"] = key
                for h in ("anthropic-version", "anthropic-beta"):
                    if self.headers.get(h):
                        headers[h] = self.headers[h]
            else:
                auth = self.headers.get("authorization")
                if not auth and relay.key and self._same_origin():
                    auth = f"Bearer {relay.key}"
                if auth:
                    headers["authorization"] = auth
            req = urllib.request.Request(target, data=data, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=relay.timeout) as resp:
                    status, out, ctype = resp.status, resp.read(), resp.headers.get("content-type", "application/json")
            except urllib.error.HTTPError as e:
                status, out, ctype = e.code, e.read(), e.headers.get("content-type", "application/json")
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                log.warning("relay %s unreachable: %s", name, e)
                return self._json(502, {"error": f"{name} unreachable: {e}"})
            log.info("relay %s -> %d (%d bytes)", name, status, len(out))
            self.send_response(status)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(out)))
            self.send_header("cache-control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(out)

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
