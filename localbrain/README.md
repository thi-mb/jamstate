# Local brains

Brains that run on the player's own machine, with no key and no network.
Measured in the bake-off ([docs/bakeoff](../docs/bakeoff/README.md)).

## Laya

[Laya](https://huggingface.co/convaiinnovations/laya) is convaiinnovations'
open decision model: a ModernBERT encoder (`laya`, 0.4B, English;
`laya-multilingual`, 0.3B, on mmBERT) with a head that picks among options.
Like Jev it answers typed questions instead of writing text, and the `laya`
package speaks Jev's `/v1/systemone` wire. The jamstate brain is
[`web/src/core/brain/laya.ts`](../web/src/core/brain/laya.ts); it asks its own
questions (plain sentences, short choices) because Laya can't follow Jev's.

`laya_server.py` serves one checkpoint from the local Hugging Face cache on
`127.0.0.1` (the page calls it straight from the browser, so it allows any
origin). Two backends:

- `torch`: laya's own runtime (MPS on a Mac, CUDA on the Spark).
- `mlx`: [`laya_mlx.py`](laya_mlx.py), the same network in MLX for Apple
  silicon. Tokenizing and decoding stay laya's; only the forward pass moves.
  `python laya_mlx.py --check` compares it with laya's PyTorch forward
  (largest probability difference 0.0011, fp16 vs fp32).

On a Mac:

```bash
cd localbrain
uv venv -p 3.13 .venv
uv pip install -p .venv/bin/python "laya==0.3.27" mlx truststore
.venv/bin/python laya_server.py --backend mlx --port 8010 \
  --checkpoint convaiinnovations/laya-multilingual --revision e4e9ddf21a7b1903b7acffd8814ad4307bf63a67
```

The first run downloads the checkpoint (about 0.65 GB for multilingual, 0.8 GB
for English). Behind a TLS-inspecting proxy, add `--native-tls` to `uv` and
download once with `truststore` injected; after that, `HF_HUB_OFFLINE=1`
keeps it off the network. Revisions are the ones `laya.revisions` pins:

| Checkpoint | Revision |
|---|---|
| `convaiinnovations/laya` | `55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851` |
| `convaiinnovations/laya-multilingual` | `e4e9ddf21a7b1903b7acffd8814ad4307bf63a67` |
| `convaiinnovations/laya-typed-decisions` | `1a793eb568e6718f15941d08f85432581df534e3` |

Then in the page pick **Laya decision model (on this machine)**, or run the
bake-off with `--brains laya` (`--laya-url` or `JAMSTATE_LAYA_URL` for another
port). `--brains laya-jevq` sends Jev's questions to Laya instead, for
comparison.

## Small LLMs on MLX

Any OpenAI-compatible server works with the `openai` brain. On a Mac,
`mlx_lm.server` is one, but it ignores `response_format`, so a small model
isn't held to the move schema: Qwen3-4B had every answer rejected in the
bake-off. Prefer a server with constrained decoding (llama.cpp, Ollama).

```bash
uv pip install -p .venv/bin/python mlx-lm
.venv/bin/mlx_lm.server --model mlx-community/Qwen3-4B-Instruct-2507-4bit --port 8030
# in web/: npm run bakeoff -- ../docs/bakeoff/sessions-sim --brains openai --url http://127.0.0.1:8030/v1 --model mlx-community/Qwen3-4B-Instruct-2507-4bit
```
