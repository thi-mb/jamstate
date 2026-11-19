"""python -m jamstate_server --static ../web/dist --llm-url http://127.0.0.1:8080/v1 --model leader"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

from .app import ANTHROPIC_API, JEV_API, App, Relay, serve
from .sessions import SessionStore, default_dir


def main() -> None:
    ap = argparse.ArgumentParser(prog="jamstate_server", description="optional jamstate companion: static page, brain relays, session sync")
    ap.add_argument("--host", default=os.environ.get("JAMSTATE_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("JAMSTATE_PORT", "8765")))
    ap.add_argument("--static", type=Path, default=None, help="built web app to serve (web/dist)")
    ap.add_argument("--llm-url", default=os.environ.get("JAMSTATE_LLM_URL"), help="OpenAI-compatible base URL to relay, e.g. http://127.0.0.1:8080/v1")
    ap.add_argument("--model", default=os.environ.get("JAMSTATE_LLM_MODEL", "default"), help="model name shown to the page")
    ap.add_argument("--api-key", default=os.environ.get("JAMSTATE_LLM_KEY"), help="key for the LLM relay (same-origin requests only)")
    ap.add_argument("--timeout", type=float, default=15.0, help="seconds to wait for a relayed provider")
    ap.add_argument("--no-jev", action="store_true", help="turn off the Jev relay")
    ap.add_argument("--no-claude", action="store_true", help="turn off the Claude relay (key from ANTHROPIC_API_KEY)")
    ap.add_argument("--cors-origin", action="append", default=[o for o in os.environ.get("JAMSTATE_CORS", "").split(",") if o],
                    help="also accept API calls from this origin (repeatable), e.g. a page on another host")
    ap.add_argument("--sessions-dir", type=Path, default=Path(os.environ.get("JAMSTATE_SESSIONS", default_dir())),
                    help="where recorded jam sessions are saved (default ~/.local/share/jamstate/sessions)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    relays: dict[str, Relay] = {}
    if args.llm_url:
        relays["llm"] = Relay(args.llm_url, args.api_key, args.timeout)
    if not args.no_jev:
        # The server's own key (if any) is used only for same-origin requests that bring none.
        relays["jev"] = Relay(JEV_API, os.environ.get("TYPESAFE_API_KEY"), args.timeout)
    claude_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("JAMSTATE_ANTHROPIC_API_KEY")
    if claude_key and not args.no_claude:
        # Only with a server key (used for same-origin requests); a page with its own key calls Anthropic directly.
        relays["anthropic"] = Relay(ANTHROPIC_API, claude_key, max(args.timeout, 30.0))
    app = App(args.static, relays, SessionStore(args.sessions_dir), tuple(args.cors_origin), args.model if args.llm_url else None)
    httpd = serve(app, args.host, args.port)
    logging.info("jamstate server on http://%s:%d (relays: %s)", args.host, args.port, ", ".join(relays) or "none")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
