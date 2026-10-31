# 0011. Bandleader model: a small-active MoE, no reasoning, served by llama.cpp

- Status: Accepted (2026-10-30, after the benchmark below)
- Date: 2026-10-30

## Context
The bandleader runs on the DGX Spark (GB10, 128 GB unified memory, roughly
270 GB/s memory bandwidth). [ADR-0006](0006-bandleader-latency-contract.md)
asks for p95 under ~1.5 s end to end at 112 bpm. A typical call is a short
fixed system prompt, a ~400-token summary, and a 20–80 token JSON answer.

On this hardware, token generation speed is bound by memory bandwidth, so
what matters is **active** parameters per token, not total size. The brief
already suggests a local MoE model.

## Decision
- **Default model: Qwen3-30B-A3B-Instruct-2507** (about 3B active of 30B
  total), 4-bit GGUF (Q4_K_M or similar, ~18 GB). The Instruct-2507 release
  does not emit thinking tokens, so all output tokens are the answer.
- **Alternative to benchmark: gpt-oss-20b** (about 3.6B active, MXFP4).
  Comparable speed; it is a reasoning model, so run it with low reasoning
  effort and count its reasoning tokens in the latency.
- **Server: llama.cpp `llama-server`**, OpenAI-compatible, with
  `response_format` JSON schema (from `schema/moves.schema.json`) for
  constrained output, and prompt caching so the fixed system prompt is only
  processed once. One slot is enough (one request in flight).
- Sampling: temperature ~0.4, `max_tokens` 200 as a safety cap.
- vLLM is the fallback server if llama.cpp's JSON-schema support or ARM/CUDA
  build gives trouble; the app only depends on the OpenAI API.
- Pick between the two models with `spark/bench_leader.py` and record the
  numbers here before marking this Accepted.

Rough expectation, to be confirmed by the benchmark: a few-billion-active MoE
at 4 bits decodes at tens of tokens per second on the Spark and processes the
prompt in well under a second, so a 60-token answer should land around
1–1.5 s.

## Benchmark results (2026-10-30)
Measured on the Spark with `spark/bench_leader.py` at 112 bpm, llama.cpp
792fcf4 (CUDA 13.0), `-ngl 99 -c 8192 --parallel 1 --jinja`, repo at 4f25483.

| | Qwen3-30B-A3B-Instruct-2507 Q4_K_M | gpt-oss-20b MXFP4, reasoning low |
|---|---|---|
| p50 / p95 / max | 804 / 879 / 914 ms | 1856 / 2582 / 2651 ms (rerun: 1449 / 2098 ms) |
| p95 in bars | 0.41 | 1.20 |
| output tokens (avg) | 55 | 134 |
| decode speed (median) | 69 tok/s | 73 tok/s |
| invalid / errors (of 40) | 0 / 0 | 0 / 1 (rerun 0 / 3, cut off at 200 tokens) |
| GPU memory | 18.6 GB | 11.5 GB |
| result | PASS | MISS |

Through `jamstate_server` (`--via-server`, Qwen, n=20): p50 793 ms,
p95 860 ms, 0 invalid. PASS.

Notes:
- gpt-oss-20b at default reasoning effort failed all 40 requests: its
  reasoning tokens used the whole 200-token cap before any JSON came out.
  Even at low effort it needs ~400 tokens of budget and misses the 1.5 s p95.
  Some of its reasons were cut off, spoke about the player in the third
  person, or described things the band can't do.
- Qwen's reasons were short and fit the situation. Its move choice follows
  the player only loosely: busy leans to `add_layer`, silent to
  `drop_layer`/lower intensity, but sparse is mixed and busy sometimes drops
  a layer. gpt-oss separated busy from sparse more clearly. Prompt work, not
  a model change, is the first lever for this.

Decision: Qwen3-30B-A3B-Instruct-2507 is the default bandleader model. Thiago accepted it on 2026-10-30.

## Consequences
- Plenty of memory left on the Spark for v1 models (generative mid layer,
  Demucs) running alongside.
- If p95 misses the target, the first levers are shorter reasons, fewer
  moves, and a smaller summary, before a smaller model.
- Large dense models (70B class) are ruled out for the live loop: their
  per-token cost on this bandwidth is roughly an order of magnitude higher.
  They remain fine for offline jobs like writing a chart from a text prompt.

## Alternatives considered
- **gpt-oss-120b** (about 5B active). Smarter, still MoE, ~60+ GB; slower per
  token and probably unnecessary for picking from six moves. Worth a run in
  the benchmark if quality is a problem.
- **Small dense models (3–8B).** Similar speed, usually weaker at following
  the brief's "musical" intent; keep as a fallback.
- **Hosted API.** Off-goal: the project is about running locally on the Spark.
