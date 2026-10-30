# 0006. Bandleader moves are async, expire, and land on phrases

- Status: Proposed
- Date: 2026-10-30

## Context
The bandleader is an LLM on the Spark. Its latency varies with load and output
length. A move that arrives late refers to a musical moment that has passed:
"bring the drums back in, the player just got busy" is wrong if the player has
since stopped.

## Decision
- The leader is called every N bars (default 4, one phrase) with a compact
  summary: player features for the last N bars, arranger state, position in
  form, bars left in section, last few moves. Input stays small (a few hundred
  tokens) and the system prompt is stable so prefix caching works.
- At most one request in flight. If a request is still pending when the next
  one is due, skip that one.
- Output is constrained to the move JSON schema (llama.cpp JSON schema/grammar
  or vLLM guided decoding), with zero to two moves per response and a short
  `reason` per move. No free-form chat.
- Each response is stamped with the beat it was requested at. Moves expire
  after one phrase (TTL); expired moves are dropped by the governor and shown
  as "too late" in the dev overlay.
- Timeout: a response not back within one phrase is abandoned.
- After 3 consecutive failures/timeouts the page switches to the rule-based
  leader and retries the LLM in the background; it switches back on success.
  The overlay shows which leader is active.
- The rule-based leader implements the same interface and is the reference for
  tests and for "does the band feel right" tuning before the LLM is involved.

Latency target to measure on the Spark: p95 under 1.5 s end to end at 112 bpm
(one 4/4 bar ≈ 2.1 s), so a move requested at a phrase boundary usually lands
on the next one.

## Consequences
- The LLM is a source of taste, not of timing. Removing it degrades the
  experience but never breaks it.
- Model choice is about latency first: a small, fast model with constrained
  output beats a large one that misses phrases.

## Alternatives considered
- **Call the LLM every bar.** More reactive, but more twitchy and more load,
  and most responses would be "no move".
- **Let the LLM schedule moves for future bars.** Harder to keep valid as the
  player changes; revisit for section-level planning later.
