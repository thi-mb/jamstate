# Bandleader contract

How the page and the bandleader talk. The bandleader is a brain the player
picks ([ADR-0016](decisions/0016-brain-providers.md)): the in-page rules, an
OpenAI-compatible LLM (a local model through Ollama or llama.cpp), Claude, or the Jev decision
model. All take the same request and return the same response; the prompt and
the move checks live in the page (`web/src/core/brain/`). Timing rules are in
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

The page builds one JSON object and hands it to the brain. It is the whole
context: no brain keeps state between calls. LLM brains get it verbatim as the
user message; Jev gets it regrouped as `state` (see below).

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
  "lineup": ["drums", "bass", "chords", "guitar"],
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

What a brain returns, after the page's checks (`web/src/core/brain/check.ts`):

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
- `reason` is shown on screen: required, plain words; longer than 120
  characters is shortened at a word boundary (not rejected)
  addressed to the player. Shorter is better on the overlay.
- `rejected`: moves the checks dropped as invalid, with the error, for the
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
the checks reject it, and the conductor drops it from any leader's reply.

The machine-readable schema is
[schema/moves.schema.json](../schema/moves.schema.json). The OpenAI-compatible
brain passes it as a constrained-decoding `response_format`; the Claude brain
passes a strict version of it (`anyOf`, no numeric limits) as
`output_config.format`. The checks then enforce the limits and the governor
checks values against the song.

## Prompt

The system prompt is fixed (so model servers can cache its prefix). It
describes the role and how the band's level should follow the player (v0.4:
the levels in numbers, since Qwen otherwise stays put); dwell times,
quantization and limits are enforced by the governor and need not be
explained to the model.

```
You are the bandleader of a live backing band (the parts in "lineup") jamming
with one human player. Every few bars you get a summary of how they played
and what the band is doing. Decide whether the band should change anything.

Follow the player: when they get busier or louder, build; when they thin out,
make space; when they stop, drop back. Keep the band's "target" level close to
the player's energy: player energy under 0.3 wants a target of 0.2-0.35; 0.3
to 0.55 wants 0.4-0.55; over 0.6 wants 0.7-0.9. When the player has stopped
(silent_bars of 2 or more, or phrasing.state "stopped"), set the target to
0.1-0.25 or drop the drums. If the target is more than 0.1 away from where
the player's energy puts it, set_intensity to close the gap, even when
nothing else changed: the chart raises the level at each new section unless
you set it yourself, so a quiet player before a big section still needs you
to keep the band down. When the band already matches the player, say nothing.
Never move more than two things at once, and don't add parts or fire
stingers while the player is getting quieter.

Answer only with JSON matching the schema. Each move needs a short, friendly
reason addressed to the player, under 100 characters.
```

The user message is the request JSON, verbatim.

### Listening groups (v0.3)

Under **Bandleader → Listening** the player picks which listening groups go
into the request; every brain gets the same request. Each group that is on adds
its own field, and the system prompt gets one paragraph per field present,
after the fixed prompt above (so its cached prefix doesn't change). The
paragraphs live in `LISTENING_NOTES` in `web/src/core/brain/prompt.ts`. Jev gets
the same fields in its state (`song` for position). The overlay always shows
everything heard, whichever groups are on. The setting and every change are
recorded in the session file (`listening`), and a replay with a leader hears
the same groups.

| Group | Field | What it holds |
|---|---|---|
| Song position | `position` | `bars_left` in the section, `next_section` (null: the song ends), `next_lift` (up/down/same, from the chart's section intensities), `section_level`, `phrase` (start/middle/end), `pass` ("2 of 3"), `last_section` |
| Rhythm | `rhythm` | `syncopation` (0 on the beat, 1 all off-beat sixteenths), `swing` (0 straight, 0.66 triplet; null without enough eighths), `timing` (ahead/on/behind) and `timing_ms`, `tempo` (rushing/dragging/steady inside the bar) |
| Harmony | `harmony` | `inside` / `colour` / `outside` shares of note time against the chord sounding (colour: the genre's scale for the chord class, from the pack's `listening` section), `fit` (inside/colourful/outside), `genre_outside` (hold/lift) |
| Phrasing | `phrasing` | `state` (playing, breathing: a gap of up to 2 bars, stopped, waiting), `gap_bars`, `call_response` (short phrases and short gaps, twice in 8 bars), `held` (share of note time in notes of a beat or more), `playing_bars` |
| Dynamics | `dynamics` | `level` (last bar's mean velocity, 0–1), `shape` (crescendo/decrescendo/steady: across bars, or inside bars when the bars agree), `change` (last bar against the first), `accents` |

All groups but phrasing listen over the last phrase; phrasing over the last
8 bars. Phrasing is on by default; the others are off (the eval per
group: [v0.3-groups](eval/results/v0.3-groups.md)). The rule leader uses:

- song position: lift in the last phrase before a bigger section when the
  player is building, keep a steady player at a big section's level, keep
  parts in during the two bars before a change;
- harmony: when the player goes outside, a "hold" genre doesn't lift, add
  parts or fire a riser; a "lift" genre keeps drums and bass and lifts 0.1;
- phrasing: a breath keeps the mood (no drop-out), a gap while trading
  phrases gets a fill, held notes count as sparse, and while trading there
  are no big level jumps, feel changes, or drums/bass drops;
- dynamics: a crescendo or decrescendo moves the level 0.1 per turn the same
  way (down to 0.15, up to 0.9), without fills or new parts on the way down.

Rhythm goes to the brains only: the rules have nothing to change for it (the
band keeps its tempo; tempo following is opt-in, below).

**The chart's nudge (v0.3).** At a new section with an intensity, the
governor moves the target halfway toward it, except when the leader set the
target within the last phrase: a fresh decision stands. Before v0.3 it always
nudged, which undid a lift or a let-down made in the bars before a section
change (E7, E8, E12j in the eval). Sessions from before v0.3 replay with the
old rule (`holdFreshTarget: false`).

### Cues and the lockout (v0.3)

The player's cues (keys 1–7, [ADR-0020](decisions/0020-cues-and-lockout.md))
change the band directly. For a phrase after one lands, the governor rejects
leader moves that would undo it, with the note "undoes the … cue"; the
summary's `recent_moves` shows the applied cue (source `cue`), so a brain can
see why. Nothing in the prompt changes.

### Leading (v0.4)

Every request also carries the leader's own side
([ADR-0021](decisions/0021-leading-layer.md),
[ADR-0022](decisions/0022-trading-fours.md)). The system prompt gets a fixed
paragraph for each (`LEADING_NOTES` in `web/src/core/brain/prompt.ts`), after
the listening paragraphs. `leading` and `arc` are in every request, so their
paragraphs are part of the cached prefix; `trading` only while trading.

| Field | What it holds |
|---|---|
| `leading` | `personality` (steady / supportive / adventurous), `activity` (0–1: the personality's place in the genre's range), `taste` (the genre's sentence), `favour` and `avoid` (moves as `kind` or `kind:arg`), `follow`: where following the player puts the band now (`level`, `gap` to the band's target in words, `why`: stopped, breathing, sparse, held notes, getting softer, getting louder, steady, busy) |
| `arc` | `style` (build / dynamic / locked, from the genre), `so_far` (the last 6 section visits: `section`, `pass`, `level`, `peak`, `parts`, `feel`), `peak` (the biggest visit so far), `now` (this visit's plan, with `bars_left`) and `next` (the next section's plan, null at the end). A plan has `change` (level against the last time through), `aim` (null the first time: follow the player), `add` / `drop` (a part) and `idea` in words |
| `trading` | `turn` (player / band: whose the bar just played was), `soloist` (who takes the band's turns now), `bars_left` in the turn |

The page keeps the arc (`web/src/core/arc.ts`) and sends it with every request,
so no brain keeps state (the server stays stateless). The personality also sets
the governor (dwell times, deadband), so even a brain that ignores the prompt
moves less when steady. While trading, the governor rejects leader moves that
drop parts, change the feel or take the level down more than 0.15.

**The follow guard.** Replies from text LLMs (the OpenAI-compatible brain and
Claude) pass through `guardFollow` (`web/src/core/leading.ts`) before the
governor: when the player stopped, the level comes down to `follow.level` and
the drums go out, and added parts and stingers are dropped; when the reply
leaves the level more than 0.1 from `follow.level`, a `set_intensity` to it is
added; a busy player keeps every part. Not while trading or breathing. The
rule leader and Jev don't need it.

## Jev (decision model)

Jev answers typed questions instead of writing text
(`web/src/core/brain/jev.ts`). Each turn is one request with two questions:

- `level` (score, 5 levels from "barely there: the player stopped" to "full
  out"): how hard the band should play next, asked *ignoring how hard it plays
  now* (asked relative to the current level, Jev anchors on it). The score maps
  onto intensity 0.1 / 0.3 / 0.5 / 0.8 / 1.0, interpolated, and becomes a
  `set_intensity` if it differs from the target by 0.1 or more.
- `change` (choice): one structural move or `keep`, with options generated
  from the band's state (add a missing part, drop a playing part but never the
  last, other feels, stingers, extend, jump to another section).

`state` is the request regrouped: `player` (plus `sounds`: "stopped", "sparse
and soft", "steady, medium" or "busy and loud", words for the numbers),
`band` (`intensity`, `playing`, `not_playing`, `feel`, `recent_moves`) and
`song`. Reasons come from a template per move. TypeSafe blocks browser calls,
so the page reaches Jev through the companion server's `/api/relay/jev`.

v0.4 adds the arc plan to `song` (`plan_now`, `plan_next`), the personality
and taste as `leader`, and the trade as `trading`; the `change` options leave
out moves the genre avoids, and while trading, drops and feel changes.

## Blind test

**Blind test** under Bandleader is a choice, not a brain: each jam secretly
uses one of the brains that answer from this page (the least-tried first;
`web/src/core/brain/blind.ts`), the overlay hides who made each move and the
reasons, and after Stop the player rates the jam 1 to 5. The session is
recorded with `leader: "blind:<brain>"` and a `rating`, kept in the browser,
and synced to the server when there is one. **Show results** unblinds the
per-brain means.

## Rule-based leader (reference behavior)

The in-page fallback (`web/src/core/rules.ts`) implements the same contract
with plain rules, so the LLM's output can be compared against it. It sorts the
player into a mood, with hysteresis on energy:

| Mood | Enter / exit | Band response |
|------|--------------|---------------|
| silent | no notes | intensity 0.1, drop drums |
| sparse | energy < 0.30 to enter, > 0.38 to leave | intensity 0.28, half time; drums back in if coming from silence |
| groove | between sparse and busy | intensity 0.5, add a missing layer or return to normal feel |
| busy | energy > 0.62 to enter, < 0.52 to leave | intensity 0.75+, add a missing layer, else leave half time, else the genre's mark (its first favoured stinger: a crash in funk and blues rock, a fill in jazz) |

Leading (v0.4) on top of the moods:

- **Genre taste.** Under a sparse player, a genre that favours a part laying
  out (funk, jazz) drops the keys (or guitar, pad) instead of going half
  time. Moves the genre avoids are never made.
- **Personality.** Steady needs a bigger change before it moves (0.1 + 0.4 ×
  (0.5 − activity), at least 0.1) and makes one move at a time, with no fills
  or feel changes of its own. Adventurous adds a colour move from the genre's
  favourites when nothing else is happening and the player is playing (every
  other turn; every turn above activity 0.8).
- **Arc.** In the last bar or two before a section, while the player grooves
  or digs in, it follows the next section's plan: the level to aim for (up
  plans never below where following the player puts it, down plans never
  above), and the part to bring in (or, for a grooving player, take out). The
  offset is kept through the visit.
- **Trading.** Silence and sparse playing don't move the band: the gaps are
  the band's turns.
