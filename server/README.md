# jamstate_server

The app server that runs on the DGX Spark. Python standard library only.

- `GET /` and everything else: the built web app (`--static web/dist`).
- `GET /api/health`: `{ok, llm_url, model}`.
- `POST /api/leader`: a bandleader summary in, `{moves, rejected, latency_ms, model}` out.
  Asks the model for JSON constrained by `schema/moves.schema.json`
  (`response_format: json_schema`, degrading to `json_object`, then plain text
  if the model server rejects it) and drops malformed moves.
- `POST /api/chart`: `{prompt}` in, `{chart, latency_ms, model}` out. The
  browser validates the chart before using it. The prompt and schema offer
  the installed genre packs (`../genres`).
- `POST /api/sessions`: a recorded jam (`jamstate-session/0.1`) in, `{name}`
  out. `GET /api/sessions` lists them, `GET /api/sessions/<name>` returns one.
  Files go to `--sessions-dir` (default `~/.local/share/jamstate/sessions`,
  or `JAMSTATE_SESSIONS`). This is the only thing the server writes.

It keeps no jam state (saved sessions are just files), so restarting it
never affects a jam in progress.
The page falls back to its rule-based leader whenever this server or the
model is unavailable.

```bash
pip install -e server            # from the repo root; reads ../schema at runtime
python -m jamstate_server --static web/dist \
  --llm-url http://127.0.0.1:8080/v1 --model leader --port 8765
```

Options can also come from the environment: `JAMSTATE_LLM_URL`,
`JAMSTATE_LLM_MODEL`, `JAMSTATE_LLM_KEY`, `JAMSTATE_HOST`, `JAMSTATE_PORT`.
It binds to `127.0.0.1` by default; expose it with `tailscale serve` (HTTPS,
which Web MIDI needs).

Tests: `pip install -e 'server[test]' && pytest server`.
