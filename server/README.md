# jamstate_server

The optional companion server ([ADR-0015](../docs/decisions/0015-no-server-required.md)).
The page plays without it; on the Spark (or your own machine) it adds what a
static host can't. Python standard library only.

- `GET /` and everything else: the built web app (`--static web/dist`).
- `GET /api/health`: `{ok, relay: {llm, jev}, llm_url, model, sessions}`.
- `POST /api/relay/llm/chat/completions`: forwarded to `--llm-url` (Qwen on
  the Spark listens on 127.0.0.1 only, so the page reaches it through here).
- `POST /api/relay/jev`: forwarded to TypeSafe's API, which blocks calls from
  web pages. On by default; `--no-jev` turns it off.

  The relays forward bytes: the prompt, the questions and the move checking
  live in the page (`web/src/core/brain`). A request's own `Authorization`
  header is passed through. Without one, the server adds its own key
  (`--api-key`/`JAMSTATE_LLM_KEY`, `TYPESAFE_API_KEY`), but only for
  same-origin requests, so another site can't spend it.
- CORS: only for origins listed with `--cors-origin` (or `JAMSTATE_CORS`,
  comma-separated), for a page hosted elsewhere that talks to a local server.
  Those origins must bring their own keys.
- `POST /api/sessions`: a recorded jam (`jamstate-session/0.1`) in, `{name}`
  out. `GET /api/sessions` lists them, `GET /api/sessions/<name>` returns one.
  Files go to `--sessions-dir` (default `~/.local/share/jamstate/sessions`,
  or `JAMSTATE_SESSIONS`). This is the only thing the server writes.

It keeps no jam state (saved sessions are just files), so restarting it
never affects a jam in progress.
The page falls back to its rule-based leader whenever a brain is unavailable.

```bash
pip install -e server            # from the repo root; reads ../schema at runtime
python -m jamstate_server --static web/dist \
  --llm-url http://127.0.0.1:8080/v1 --model leader --port 8765
```

Options can also come from the environment: `JAMSTATE_LLM_URL`,
`JAMSTATE_LLM_MODEL`, `JAMSTATE_LLM_KEY`, `TYPESAFE_API_KEY`, `JAMSTATE_CORS`,
`JAMSTATE_HOST`, `JAMSTATE_PORT`.
It binds to `127.0.0.1` by default; expose it with `tailscale serve` (HTTPS,
which Web MIDI needs).

Tests: `pip install -e 'server[test]' && pytest server`.
