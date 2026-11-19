# 0008. The DGX Spark hosts the server and models; it never owns time

- Status: Superseded by [0015](0015-no-server-required.md) (2026-10-31)
- Date: 2026-10-30

## Context
A DGX Spark is available as a host and should be used. The browser on the
laptop owns timing ([ADR-0003](0003-fast-layer-timing.md)). Laptop and Spark
are connected over Tailscale.

## Decision
The Spark runs everything that isn't real-time:

- **App server** (Python, `server/`, package `jamstate_server`): serves the built web app, chart files and the loop
  bank, and exposes a small API. The laptop browser opens
  `http://<spark>.<tailnet>.ts.net:<port>`.
- **Bandleader endpoint**: the API proxies `/api/leader` to an
  OpenAI-compatible server on the same box (llama.cpp `llama-server` or vLLM).
  The browser never talks to the model server directly, which avoids CORS and
  keeps the model address and settings server-side.
- **v1 workloads**: audio → chart (Demucs, allin1, chord recognition) as a
  job API; generative mid-layer models under the
  [commit-deadline contract](0005-bar-commit-deadline.md).

Setup steps are in [deploy/README.md](../../deploy/README.md).

The Spark holds no session timing state. Each leader request carries the full
summary it needs, so a restarted server loses nothing.

Current state of v0: the Vite dev server on the laptop proxies leader calls to
the Spark (`JAMSTATE_LLM_URL`). That is the dev mode. Moving the built app
and the proxy onto the Spark is the target, so testing only needs a browser.

For local development without the Spark, the same server runs on the laptop
and the leader falls back to the rule-based one (or to any OpenAI-compatible
endpoint set by env var).

## Consequences
- Once the page has loaded, a Spark outage only loses the LLM leader; the
  band keeps playing ([ADR-0006](0006-bandleader-latency-contract.md)).
- Web MIDI needs a secure context. `localhost` qualifies, but a plain
  `http://` Tailscale hostname does not. Serve the app over HTTPS with
  `tailscale serve` / `tailscale cert`, or Web MIDI will be unavailable.
- Network latency to the Spark only affects the slow layer.

## Alternatives considered
- **Laptop runs the server, Spark runs only the model.** Simpler for v0 dev,
  but leaves the Spark idle except for inference and makes the laptop the
  thing to install. Kept as the offline dev mode.
- **Browser calls the model server directly.** Needs CORS configuration on the
  model server and exposes it to the page.
