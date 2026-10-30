# Running houseband on the DGX Spark

The Spark hosts everything except the music itself: the built web app, the
app server with the `/api/leader` proxy, and the bandleader model. The
browser on your laptop owns all timing
([ADR-0008](../docs/decisions/0008-spark-as-stateless-advisor.md)).

```
laptop browser ──HTTPS (tailnet)──► tailscale serve :443
                                        │
                                        ▼
                         houseband_server :8765  (static web/dist + /api/leader)
                                        │
                                        ▼
                         llama-server :8080  (OpenAI-compatible, bandleader model)
```

Both servers listen on `127.0.0.1` only; Tailscale is the only way in.

## 1. Bandleader model (llama.cpp)

Build llama.cpp with CUDA on the Spark (it is aarch64 + Blackwell; use a
recent CUDA toolkit and a recent llama.cpp):

```bash
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release -j
```

`-hf` downloads need llama.cpp built with OpenSSL (`sudo apt install
libssl-dev` before `cmake`). Without it, the server exits with "HTTPS is not
supported"; download the GGUF yourself (for example with `hf download`) and
pass `-m <file>.gguf` instead of `-hf`.

Run the default model from
[ADR-0011](../docs/decisions/0011-bandleader-model.md). `-hf` downloads the
GGUF from Hugging Face on first run; check the repo name and quant tag before
you start, since uploads move around:

```bash
./build/bin/llama-server \
  -hf unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:Q4_K_M \
  --alias qwen3-30b-a3b \
  --host 127.0.0.1 --port 8080 \
  -ngl 99 -c 8192 --parallel 1 --jinja
```

To compare with gpt-oss-20b, run it the same way on another port (for
example `-hf ggml-org/gpt-oss-20b-GGUF --alias gpt-oss-20b --port 8081`).

Check it answers:

```bash
curl -s http://127.0.0.1:8080/v1/models
```

## 2. Measure it

From the repo root on the Spark:

```bash
python3 spark/bench_leader.py --url http://127.0.0.1:8080/v1 --model qwen3-30b-a3b -n 40
```

It sends realistic leader requests (sparse, busy, silent, steady players)
with the moves JSON schema as `response_format`, then prints p50/p95 latency
in milliseconds and in bars, tokens per second, invalid answers, and which
moves each scenario produced. `PASS` means p95 under 1.5 s with no invalid
answers or errors. Record the numbers in ADR-0011.

Signs of trouble:
- Invalid answers: the server isn't honoring `response_format` (update
  llama.cpp, or try vLLM).
- Busy and sparse scenarios get the same moves: the prompt or model isn't
  following the player; compare against the other model.
- Latency high but tok/s fine: answers are too long. Shorten reasons first.

## 3. App server

Build the web app (on the Spark or anywhere, then copy `web/dist` over):

```bash
cd web && npm ci && npm run build && cd ..
```

Run the server (from `server/`, see its README for install):

```bash
cd server
python -m houseband_server --static ../web/dist \
  --llm-url http://127.0.0.1:8080/v1 --model qwen3-30b-a3b --port 8765
```

To check the whole path, including the server's own validation:

```bash
python3 spark/bench_leader.py --via-server http://127.0.0.1:8765 -n 20
```

## 4. HTTPS on the tailnet

Web MIDI only works in a secure context. `http://localhost` counts, but a
plain `http://spark:8765` from the laptop does not, so serve it over HTTPS
with Tailscale. One-time setup in the Tailscale admin console: enable
MagicDNS and HTTPS certificates for the tailnet. Then on the Spark:

```bash
sudo tailscale serve --bg 8765
tailscale serve status
```

Open `https://<spark-hostname>.<tailnet>.ts.net/` in Chrome on the laptop,
press Start, and play. Use Chrome or Edge: Safari has no Web MIDI.

To stop serving: `sudo tailscale serve --https=443 off`.

## 5. Keep it running (optional)

Two systemd user services, one per server. Example for the model:

```ini
# ~/.config/systemd/user/houseband-llm.service
[Unit]
Description=houseband bandleader model (llama-server)

[Service]
ExecStart=%h/llama.cpp/build/bin/llama-server -hf unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:Q4_K_M --alias qwen3-30b-a3b --host 127.0.0.1 --port 8080 -ngl 99 -c 8192 --parallel 1 --jinja
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now houseband-llm
loginctl enable-linger "$USER"   # keep it running when you're logged out
```

The app server gets the same treatment with its own `ExecStart`.

## Laptop-only development

No Spark needed: run `npm run dev` in `web/` and the in-page rule-based
leader plays bandleader. Point the Vite proxy at the Spark with
`HOUSEBAND_LLM_URL` to use the real model from a dev build.
