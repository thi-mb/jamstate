# 0009. Magenta RealTime is a timeboxed spike, not v0

- Status: Proposed
- Date: 2026-10-30

## Context
The brief wants an audio mode (v2) using Magenta RealTime, and asks to spike
early because running it on the Spark (ARM CPU, Blackwell GPU, JAX backend) is
unverified. Real-time audio generation has a hard throughput requirement:
generating each chunk faster than it plays, with headroom.

## Decision
- No audio generation in v0 or v1.
- Run a spike of at most 2 days, independent of v0 work, that answers:
  1. Does JAX with CUDA install and run on the Spark (aarch64 + Blackwell)?
  2. What is the real-time factor for streaming generation (target ≤ 0.5,
     i.e. a 2 s chunk generated in under 1 s)?
  3. Can it be steered by our chart/style controls at chunk boundaries?
  4. What does it cost in GPU memory alongside the bandleader LLM?
- Stream generated audio to the browser and play it on the same audio clock,
  under a deadline/fallback rule like ADR-0005's.
- Write the result up as a new decision record (go / no-go / wait).

## Consequences
- v0 is not blocked on an unverified stack.
- If the spike fails, audio mode waits or uses a different model; the rest of
  the architecture doesn't change because audio would be just another part
  generator.

## Alternatives considered
- **Build audio mode into v0.** Too risky for the first demo.
- **Skip the spike until v2.** Risks designing v1 around something that can't
  run on the hardware.
