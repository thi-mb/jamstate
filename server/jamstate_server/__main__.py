"""python -m jamstate_server --static ../web/dist --llm-url http://127.0.0.1:8080/v1 --model qwen3-30b-a3b"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

from .app import App, serve
from .llm import LLMClient
from .sessions import SessionStore, default_dir


def main() -> None:
    ap = argparse.ArgumentParser(prog="jamstate_server", description="jamstate app server: web app + bandleader proxy")
    ap.add_argument("--host", default=os.environ.get("JAMSTATE_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("JAMSTATE_PORT", "8765")))
    ap.add_argument("--static", type=Path, default=None, help="built web app to serve (web/dist)")
    ap.add_argument("--llm-url", default=os.environ.get("JAMSTATE_LLM_URL"), help="OpenAI-compatible base URL, e.g. http://127.0.0.1:8080/v1")
    ap.add_argument("--model", default=os.environ.get("JAMSTATE_LLM_MODEL", "default"))
    ap.add_argument("--api-key", default=os.environ.get("JAMSTATE_LLM_KEY"))
    ap.add_argument("--timeout", type=float, default=8.0, help="seconds to wait for the model")
    ap.add_argument("--sessions-dir", type=Path, default=Path(os.environ.get("JAMSTATE_SESSIONS", default_dir())),
                    help="where recorded jam sessions are saved (default ~/.local/share/jamstate/sessions)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    llm = LLMClient(args.llm_url, args.model, args.api_key, args.timeout) if args.llm_url else None
    httpd = serve(App(args.static, llm, SessionStore(args.sessions_dir)), args.host, args.port)
    logging.info("jamstate server on http://%s:%d (llm: %s)", args.host, args.port, args.llm_url or "none")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
