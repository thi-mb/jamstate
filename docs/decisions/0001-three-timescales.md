# 0001. Three timescales; the fast layer never waits on AI

- Status: Accepted (from the project brief)
- Date: 2026-10-30

## Context
The band has to sound tight while taking advice from models that take
hundreds of milliseconds to seconds to answer, over a network, on another
machine. A backing band that drops a beat because a model was slow is worse
than one that never adapts.

## Decision
Split the system by timescale:

- **Fast** (per note, ms): a deterministic scheduler that plays whatever has
  been committed to it. No model calls, no network, no awaiting anything.
- **Mid** (per bar): produces the next bar per part. v0 selects and varies
  loops from a bank; v1 may ask a symbolic model on the Spark. Has a hard
  deadline and a fallback (repeat/vary the last bar).
- **Slow** (every few bars / per section): the LLM bandleader proposes moves
  that land on the next bar or phrase.

Information flows down only as committed data (bars, arranger state). Nothing
in a faster layer ever waits on a slower one.

## Consequences
- The band keeps playing if the Spark is off, slow, or unreachable.
- Every AI feature needs a defined deadline and a defined fallback before it
  is built.
- Reactions are at least one bar late by design. That is musically normal for
  a band and is how the demo should be framed.

## Alternatives considered
- **Model in the loop per note** (true generative accompaniment). Too fragile
  for v0 and contradicts the "never stutters" goal.
- **Static backing track with stems muted/unmuted.** Robust but doesn't feel
  like jamming; no structure changes.
