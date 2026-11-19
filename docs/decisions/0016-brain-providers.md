# 0016. The bandleader is a pluggable brain the player picks

- Status: Accepted (2026-10-31)
- Date: 2026-10-31
- Amends: [0006](0006-bandleader-latency-contract.md),
  [0011](0011-bandleader-model.md)

## Context
The bandleader answers about once per phrase, and late answers are dropped
([ADR-0006](0006-bandleader-latency-contract.md)), so it tolerates a wide
range of latency. Today it is wired to one model on the Spark
([ADR-0011](0011-bandleader-model.md)). Players will have different things
available: nothing, an API key, a decent Mac, or a GPU box.

A new kind of model fits our job well. **Decision models** answer typed
questions (pick one of these options, score this from 1 to 5, yes or no)
instead of writing text. A bandleader move is exactly that: one move from a
fixed set, plus its arguments. Two examples:
- [Jev](https://flaviocopes.com/jev/) (TypeSafe): hosted only, usually about
  100 ms (70 to 500 ms quoted from the US West Coast), $0.042 per million
  input tokens, output free. It cannot write text.
- [Laya](https://shop.zimaspace.com/blogs/tech-ai-hub/laya-open-source-decision-model-local-ai)
  (Convai): open weights, Apache 2.0, about 421M parameters, reported at
  about 13 ms on an M3 Max, with community ONNX (Node/TypeScript) and MLX
  ports.

## Decision
- The page talks to the bandleader through a **brain provider** interface:
  same request (the summary from [bandleader.md](../bandleader.md)), same
  answer (zero or more moves), and every answer still goes through the
  governor.
- Providers, in the order we build them:
  1. **Rules**: the existing in-page leader. Always available, and the
     fallback.
  2. **OpenAI-compatible**: any endpoint and model (Qwen on the Spark via
     llama.cpp, Ollama on a Mac, OpenAI itself).
  3. **Claude**: the Anthropic API with the player's key.
  4. **Jev**: the decision-model API with the player's key.
  5. **Laya** (or the best open decision model at the time): local, in the
     page through ONNX if fast enough, otherwise in the desktop app
     ([ADR-0017](0017-one-core-thin-shells.md)).
- **Keys are the player's.** They are stored on their machine and sent only
  to that provider. A provider that blocks browser calls (CORS) goes through
  the optional local companion server.
- **Decision-model answers are mapped to moves.** The question set is
  generated from the move schema (which move, which section, which level). A
  move's `reason` comes from a template per move and answer, since these
  models write no text.
- **The default is picked by measurement**, not taste: a bake-off on the
  Spark replays recorded sessions through each provider, measures latency,
  and a blind test compares the brains by playing.
- **Result (2026-10-31): Jev is the default.** It followed the
  player as well as rules on the bake-off (follow 0.96, silent→drop 1.00,
  busy→lift 1.00) at about 0.1 s per answer. Rules, OpenAI-compatible (Qwen),
  Claude (Haiku 5.5 by default) and Laya stay selectable and supported, and
  the blind test keeps rotating through them. A page with no server relay
  can't reach Jev and plays with rules.

## Consequences
- jamstate works with no key, gets better with a key or a local model, and
  never depends on one vendor.
- More code paths to test. The eval set and session replay cover them all
  with the same recordings.
- Templated reasons are less vivid than LLM reasons. Acceptable: the reason
  is for the overlay, and the move is what matters.
- Latency varies by provider; the ADR-0006 contract (TTL, phrase landing,
  fallback after failures) already absorbs it.

## Alternatives considered
- **One blessed model.** Simpler to tune, but forces every player into the
  same setup or cost.
- **LLMs only.** They write good reasons, but are slower and costlier than
  decision models for a choose-one-move task.
