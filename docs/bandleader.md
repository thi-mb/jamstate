# Bandleader contract

How the page and the bandleader talk. The bandleader is either the LLM on the
DGX Spark or the in-page rule-based leader; both take the same request and
return the same response. Timing rules are in
[ADR-0006](decisions/0006-bandleader-latency-contract.md); what happens to a
move after it arrives is in [ADR-0007](decisions/0007-move-governor.md).

> If the engine code (`web/src/core/`: `engine.ts`, `rules.ts`, `features.ts`) and this page disagree on a field name,
> the code wins and this page should be fixed.

## When it is called

- The LLM leader is called every phrase (default 4 bars), at the phrase
  boundary, with a summary of the phrase that just ended. The in-page rule
  leader runs every 2 bars.
- At most one request in flight; if one is pending, skip this phrase.
- Timeout one phrase. Moves expire 8 bars after the request bar.

## Request: the summary

The page POSTs one JSON object to `/api/leader` on the app server
(`server/`, package `jamstate_server`). It is the whole context: the server
and model keep no state between calls.

```json
{
  "bar": 128,
  "section": "verse",
  "bar_in_section": 12,
  "section_bars": 16,
  "phrase_bars": 4,
  "intensity": 0.45,
  "target": 0.5,
  "layers": ["bass", "chords"],
  "feel": "normal",
  "form": ["intro", "verse", "chorus", "verse", "chorus", "outro"],
  "form_pos": 1,
  "sections": ["intro", "verse", "chorus", "outro"],
  "player": {
    "bars": 4,
    "energy": 0.62,
    "density": 1.4,
    "mean_velocity": 0.62,
    "rest_ratio": 0.3,
    "repetition": 0.2,
    "register": "mid",
    "trend": "rising",
    "silent_bars": 0
  },
  "recent_moves": ["drop_layer(drums)", "set_intensity(0.45)"]
}
```

| Field | Meaning |
|-------|---------|
| `intensity` / `target` | where the band is now / where the governor is easing it to |
| `player.energy` | `0.55 * min(1, density / 2.4) + 0.45 * mean_velocity`, 0 when silent |
| `player.mean_velocity` | mean velocity / 127 (0–1) |
| `player.density` | notes per beat |
| `player.rest_ratio` | fraction of time with no note sounding |
| `player.repetition` | how much recent motifs repeat (0–1) |
| `player.register` | `low` (mean pitch < 60) \| `mid` \| `high` (> 84), `null` when silent |
| `player.trend` | `rising` \| `falling` \| `steady`, precomputed so the model doesn't do arithmetic |
| `player.silent_bars` | consecutive bars with no notes |

v0 bandleader decisions rely on `energy`, `density`, `trend` and
`silent_bars`.

## Response: moves

What the server returns to the page:

```json
{
  "moves": [
    { "move": "add_layer", "part": "drums", "reason": "you're picking up, drums back in" },
    { "move": "set_intensity", "value": 0.7, "reason": "matching your energy" }
  ],
  "rejected": [],
  "latency_ms": 840,
  "model": "qwen3-30b-a3b-instruct"
}
```

- `moves`: 0 to 2. An empty list is a valid, common answer ("keep going").
- `reason` is shown on screen: required, at most 120 characters, plain words
  addressed to the player. Shorter is better on the overlay.
- `rejected`: moves the server dropped as invalid, with the error, for the
  dev overlay.

| `move` | Argument | Values |
|--------|----------|--------|
| `set_intensity` | `value` | number 0–1 |
| `add_layer`, `drop_layer` | `part` | `drums` \| `bass` \| `chords` |
| `jump_to_section` | `section` | one of `sections` |
| `extend_section` | `bars` | 1–16 |
| `change_feel` | `feel` | `normal` \| `half_time` \| `double_time` |
| `fire_stinger` | `stinger` | `fill` \| `crash` \| `riser` |

The band also knows `end_song` (v0.1): it ends the song at the end of the
phrase. That one is the player's call, so it is not in the model's schema,
the server rejects it, and the page drops it from any leader's reply.

The machine-readable schema is
[schema/moves.schema.json](../schema/moves.schema.json). The server passes it
to the model as a constrained-decoding `response_format`, so the model can
only return valid shapes; the governor still checks values against the song.

## Prompt

The system prompt is fixed (so the server can cache its prefix) and short. It
describes the role, not the rules: dwell times, quantization and limits are
enforced by the governor and need not be explained to the model.

```
You are the bandleader of a live backing band (drums, bass, chords) jamming
with one human player. Every few bars you get a summary of how they played
and what the band is doing. Decide whether the band should change anything.

Follow the player: when they get busier or louder, build; when they thin out,
make space; when they stop, drop back. Prefer small changes. Saying nothing is
often right. Never move more than two things at once.

Answer only with JSON matching the schema. Each move needs a short, friendly
reason addressed to the player.
```

The user message is the request JSON, verbatim.

## Rule-based leader (reference behavior)

The in-page fallback (`web/src/core/rules.ts`) implements the same contract
with plain rules, so the LLM's output can be compared against it. It sorts the
player into a mood, with hysteresis on energy:

| Mood | Enter / exit | Band response |
|------|--------------|---------------|
| silent | no notes | intensity 0.1, drop drums |
| sparse | energy < 0.30 to enter, > 0.38 to leave | intensity 0.28, half time; drums back in if coming from silence |
| groove | between sparse and busy | intensity 0.5, add a missing layer or return to normal feel |
| busy | energy > 0.62 to enter, < 0.52 to leave | intensity 0.75+, add a missing layer, else leave half time, else a fill (crash if coming back from silence) |
