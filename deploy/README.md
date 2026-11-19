# Self-hosting jamstate

The page plays with no server at all
([ADR-0015](../docs/decisions/0015-no-server-required.md)): build it once and
any static host (or a local file server) can serve it. The rule leader plays
bandleader, and a Claude key pasted in the page works directly.

Run the companion server too when you want:
- a **local model** as bandleader (the page can't reach most model servers
  directly, so the server relays `api/relay/llm` to it);
- **Jev** (TypeSafe blocks calls from web pages, so it goes through the relay);
- **session sync**: recorded jams saved as files on the host, for the eval set.

```
browser ──(localhost, SSH tunnel or HTTPS)──► jamstate_server :8765  (web/dist + /api/relay/{llm,jev,anthropic} + /api/sessions)
                                                    │
                                                    ▼
                                    model server  (any OpenAI-compatible: Ollama, llama.cpp, vLLM)
```

Any OS and any hardware work. A GPU makes the model fast enough to land
moves on the next phrase; without one the page still plays, and falls back to
the rule leader whenever the model misses its deadline.

## Quick start with Docker

From the repo root:

```bash
docker compose up --build                       # the page and the server, rule leader + Jev/Claude relays
docker compose --profile local-llm up --build   # also an Ollama model server as bandleader
```

Open http://localhost:8765 in Chrome or Edge (Safari has no Web MIDI). Keys
for the relays go in `.env` (copy [`.env.example`](../.env.example)). The
first `local-llm` start downloads the model (about 19 GB for the default;
set `JAMSTATE_OLLAMA_MODEL` for a smaller one). For an NVIDIA GPU, uncomment
the `deploy` block of the `ollama` service in [`compose.yaml`](../compose.yaml).

## 1. Bandleader model

The page asks for moves with a JSON schema in `response_format`, so pick a
server with constrained decoding. The page sends the model name `leader`
unless you change it under Bandleader.

The default model is Qwen3-30B-A3B-Instruct-2507
([ADR-0011](../docs/decisions/0011-bandleader-model.md): p95 about 0.85 s on a
desktop-class GPU). It is a mixture of experts with 3B active parameters, so it
also runs on CPU with about 20 GB of RAM, though slower than the 1.5 s
contract. On smaller machines, Qwen3-4B-Instruct-2507 is the next step down.

**Ollama** (Linux, macOS, Windows; CPU or GPU):

```bash
ollama pull qwen3:30b-a3b-instruct-2507-q4_K_M
ollama cp qwen3:30b-a3b-instruct-2507-q4_K_M leader   # the name the page asks for
OLLAMA_CONTEXT_LENGTH=8192 ollama serve               # OpenAI-compatible on http://127.0.0.1:11434/v1
```

**llama.cpp** (build with `-DGGML_CUDA=ON`, Metal or Vulkan for a GPU; plain
CPU builds work too). `-hf` downloads need llama.cpp built with OpenSSL;
otherwise download the GGUF yourself and pass `-m <file>.gguf`:

```bash
llama-server -hf unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:Q4_K_M --alias leader \
  --host 127.0.0.1 --port 8080 -ngl 99 -c 8192 --parallel 1 --jinja   # drop -ngl 99 without a GPU
```

**vLLM** works too (`vllm serve <model> --served-model-name leader`), with
`guided_json` support for the schema.

## 2. Measure it

```bash
python3 deploy/bench_leader.py --url http://127.0.0.1:8080/v1 --model leader -n 40
```

It sends realistic leader requests (sparse, busy, silent, steady players)
with the moves JSON schema as `response_format`, then prints p50/p95 latency
in milliseconds and in bars, tokens per second, invalid answers, and which
moves each scenario produced. `PASS` means p95 under 1.5 s with no invalid
answers or errors.

Signs of trouble:
- Invalid answers: the server isn't honoring `response_format` (update it, or
  switch to one that does).
- Busy and sparse scenarios get the same moves: the prompt or model isn't
  following the player; try a larger model.
- Latency high but tok/s fine: answers are too long. Shorten reasons first.

## 3. App server

```bash
cd web && npm ci && npm run build && cd ..
pip install -e server
python -m jamstate_server --static web/dist --llm-url http://127.0.0.1:8080/v1 --model leader --port 8765
```

Every flag has an environment variable (`JAMSTATE_HOST`, `JAMSTATE_PORT`,
`JAMSTATE_LLM_URL`, `JAMSTATE_LLM_MODEL`, `JAMSTATE_SESSIONS`, …; see
[server/README.md](../server/README.md)). Relay keys come from
`TYPESAFE_API_KEY` (Jev) and `ANTHROPIC_API_KEY` (Claude).

To check the whole path through the server's relay:

```bash
python3 deploy/bench_leader.py --url http://127.0.0.1:8765/api/relay/llm --model leader -n 20
```

To run the brain bake-off on the sessions saved here:

```bash
cd web && npm run bakeoff -- ~/.local/share/jamstate/sessions --brains rules,openai,jev \
  --url http://127.0.0.1:8080/v1 --model leader --label local
```

## 4. Reaching it from another machine

Web MIDI only works in a secure context. `http://localhost` counts; a plain
`http://<host>:8765` from another machine does not. The server binds to
`127.0.0.1` by default, so pick one:

- **SSH tunnel:** `ssh -L 8765:127.0.0.1:8765 <host>`, then open
  http://localhost:8765.
- **An HTTPS reverse proxy** in front of `127.0.0.1:8765`: Caddy, nginx with
  a certificate, `tailscale serve --bg 8765`, or a Cloudflare tunnel.

The relays only add the server's own keys to same-origin requests, but anyone
who can reach the page can use them: don't expose a server holding keys to
the open internet without authentication in front of it.

## 5. Keep it running (systemd)

Two user services on Linux. The model:

```ini
# ~/.config/systemd/user/jamstate-llm.service
[Unit]
Description=jamstate bandleader model (llama-server) on 127.0.0.1:8080

[Service]
ExecStart=%h/llama.cpp/build/bin/llama-server -m %h/models/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf --alias leader --host 127.0.0.1 --port 8080 -ngl 99 -c 8192 --parallel 1 --jinja
Restart=on-failure

[Install]
WantedBy=default.target
```

The app server, which starts after the model:

```ini
# ~/.config/systemd/user/jamstate-app.service
[Unit]
Description=jamstate app server (web/dist + /api) on 127.0.0.1:8765
After=network-online.target jamstate-llm.service
Wants=jamstate-llm.service

[Service]
WorkingDirectory=%h/jamstate/server
ExecStart=/usr/bin/python3 -m jamstate_server --static ../web/dist --port 8765 --llm-url http://127.0.0.1:8080/v1 --model leader
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now jamstate-llm jamstate-app
loginctl enable-linger "$USER"   # keep them running when you're logged out
```

To deploy new code: `git pull`, `cd web && npm ci && npm run build`, then
`systemctl --user restart jamstate-app`. The model takes a few seconds to load
after a restart; until then the page uses the rule leader.

## Development

Run `npm run dev` in `web/`; the in-page rule leader plays bandleader. To use
a companion server's relays from the dev build, point the Vite proxy at it:
`JAMSTATE_API=http://<host>:8765 npm run dev`.
