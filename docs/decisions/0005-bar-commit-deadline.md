# 0005. Mid layer commits bar N+1 by a fixed point in bar N

- Status: Proposed
- Date: 2026-10-30

## Context
The scheduler only plays committed bars. Something has to decide, every bar,
what each part plays next, and that decision has to be ready in time even when
v1 moves generation to a model on the Spark.

## Decision
- Each part has a **commit deadline** for bar N+1: the start of the last beat
  of bar N (beat 4 in 4/4), minus the scheduler lookahead.
- At the deadline the arranger state for bar N+1 is frozen (moves that arrive
  later wait for the next boundary), and each generator must have committed
  bar N+1.
- If a generator hasn't committed by the deadline, the scheduler repeats that
  part's bar N (v0) or a light variation of it (velocity/ghost-note changes,
  same rhythm), and logs a miss.
- Generators can work ahead (request bar N+2 early) but must regenerate if the
  arranger state changes.
- Phrase = 4 bars by default (configurable per chart). Phrase-level moves land
  on the first bar of the next phrase whose deadline they make.

## Consequences
- v1 generative models get roughly one beat of budget per bar if asked at the
  last moment, or a full bar if asked one bar ahead. That is the latency
  target for any Spark-side generator.
- Deadline misses are visible in logs and the overlay (dev mode), which gives
  us a real number for the v1 model latency question.

## Alternatives considered
- **Commit at the barline.** Leaves no margin for scheduling the downbeat.
- **Commit a full phrase at a time.** More margin, but reactions get a phrase
  slower and stingers become awkward.
