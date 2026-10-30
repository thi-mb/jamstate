# 0007. A deterministic governor between leader and arranger

- Status: Proposed
- Date: 2026-10-30

## Context
The brief flags the risk that the band will feel twitchy: an LLM reading a
noisy feature summary will happily flip layers on and off every phrase.
Musicality needs memory and restraint, which are easier to guarantee in code
than in a prompt.

## Decision
All moves pass through a governor that applies fixed rules before anything
reaches the arranger:

- **Validation**: schema, known section/part names, values in range.
- **Expiry**: drop moves past their TTL ([ADR-0006](0006-bandleader-latency-contract.md)).
- **Intensity smoothing**: `set_intensity` sets a target; actual intensity
  moves toward it by at most 0.25 per bar. Changes smaller than 0.1 are
  ignored (deadband).
- **Dwell times**: a layer that was added or dropped can't flip back for
  2 phrases. A feel change holds for at least 2 phrases.
- **Structure**: at most one structural move (`jump_to_section`,
  `extend_section`, `change_feel`) per phrase. No jump before a section has
  played at least one phrase. Extensions capped at the section's own length.
- **Stingers**: at most one per phrase; crash only on a downbeat; fill only in
  the last bar of a phrase; riser only when a section change is coming.
- **Conflict**: within a phrase, the latest valid move of a kind wins.
- **Feature hysteresis** (for the rule-based leader): "busy" and "sparse"
  have separate enter/exit thresholds and must hold for a full phrase.

Every accepted, rewritten or rejected move is logged with the rule that
fired, and the overlay shows the accepted ones with their reasons.

## Consequences
- The prompt can stay short; the LLM doesn't need to be told about musical
  restraint because it can't violate it.
- The numbers above are starting points to tune by ear and should live in one
  config object, not scattered constants.
- Manual move buttons in the UI go through the same governor, which makes it
  easy to test.

## Alternatives considered
- **Put the rules in the prompt.** Unreliable and costs tokens on every call.
- **No governor, trust the model.** Twitchy, and hard to debug.
