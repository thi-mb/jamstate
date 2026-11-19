# jamstate_server

The optional companion server ([ADR-0015](../docs/decisions/0015-no-server-required.md)).
The page plays without it; on your own machine or a host you run it adds what a
static host can't. Python standard library only.

- `GET /` and everything else: the built web app (`--static web/dist`).
- `GET /api/health`: `{ok, relay: {llm, jev, anthropic}, llm_url, model, sessions}`.
- `POST /api/relay/llm/chat/completions`: forwarded to `--llm-url` (a local
  model server usually listens on 127.0.0.1 only, so the page reaches it through here).
- `POST /api/relay/jev`: forwarded to TypeSafe's API, which blocks calls from
  web pages. On by default; `--no-jev` turns it off.
- `POST /api/relay/anthropic/v1/messages`: forwarded to the Anthropic API,
  only when the server has `ANTHROPIC_API_KEY` (or
  `JAMSTATE_ANTHROPIC_API_KEY`) in its environment; `--no-claude` turns it
  off. The page uses it when no Claude key is pasted in the page (it sends
  `x-api-key: relay`); a page key goes straight to Anthropic instead.

  The relays forward bytes: the prompt, the questions and the move checking
  live in the page (`web/src/core/brain`). A request's own `Authorization`
  header is passed through. Without one, the server adds its own key
  (`--api-key`/`JAMSTATE_LLM_KEY`, `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`), but only for
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
It binds to `127.0.0.1` by default; to reach it from another machine use an SSH
tunnel or an HTTPS reverse proxy (Web MIDI needs a secure context). See
[deploy/README.md](../deploy/README.md), which also covers Docker.

Tests: `pip install -e 'server[test]' && pytest server`.
