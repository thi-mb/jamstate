# houseband_server

The app server that runs on the DGX Spark. Python standard library only.

- `GET /` and everything else: the built web app (`--static web/dist`).
- `GET /api/health`: `{ok, llm_url, model}`.
- `POST /api/leader`: a bandleader summary in, `{moves, rejected, latency_ms, model}` out.
  Asks the model for JSON constrained by `schema/moves.schema.json`
  (`response_format: json_schema`, degrading to `json_object`, then plain text
  if the model server rejects it) and drops malformed moves.
- `POST /api/chart`: `{prompt}` in, `{chart, latency_ms, model}` out. The
  browser validates the chart before using it.

It keeps no session state, so restarting it never affects a jam in progress.
The page falls back to its rule-based leader whenever this server or the
model is unavailable.

```bash
pip install -e server            # from the repo root; reads ../schema at runtime
python -m houseband_server --static web/dist \
  --llm-url http://127.0.0.1:8080/v1 --model leader --port 8765
```

Options can also come from the environment: `HOUSEBAND_LLM_URL`,
`HOUSEBAND_LLM_MODEL`, `HOUSEBAND_LLM_KEY`, `HOUSEBAND_HOST`, `HOUSEBAND_PORT`.
It binds to `127.0.0.1` by default; expose it with `tailscale serve` (HTTPS,
which Web MIDI needs).

Tests: `pip install -e 'server[test]' && pytest server`.
