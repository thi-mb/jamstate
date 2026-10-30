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
  eases toward it by at most 0.2 per bar. Small changes (under ~0.1) are
  worth ignoring as a deadband.
- **Dwell times**: layer changes at least 2 bars apart; a feel change holds
  for at least 4 bars.
- **Structure**: jumps apply at the next 4-bar phrase boundary and only after
  the current section has played at least 4 bars. At most one structural move
  (`jump_to_section`, `extend_section`, `change_feel`) per phrase. Extensions
  capped at the section's own length.
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
- The numbers above match the v0 engine (`src/engine`) and are starting
  points to tune by ear. They should live in one config object, not scattered
  constants. Dwell times counted in bars may prove too twitchy; if so, move to
  phrases.
- Manual move buttons in the UI go through the same governor, which makes it
  easy to test.

## Alternatives considered
- **Put the rules in the prompt.** Unreliable and costs tokens on every call.
- **No governor, trust the model.** Twitchy, and hard to debug.
