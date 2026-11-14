# 0021. The leading layer: genre taste, personality and the song arc

- Status: Proposed
- Date: 2026-11-09

## Context
Up to v0.3 every brain decides phrase by phrase from what the player just
did. Three things are missing, and v0.4 is where they land
([roadmap](../roadmap.md#v04-leading)):

- **A sense of the whole song.** The second chorus is the first one again;
  nothing remembers where the peak was.
- **Taste per genre.** A funk band locks in and changes texture, a rock band
  builds to the last chorus, a jazz band talks back and varies chorus by
  chorus. The v0.3 leader is the same in all three.
- **A personality the player picks:** how much the leader moves, from
  hardly at all to adding its own colour.

The forces are the usual ones: every brain gets the same input (or the eval
compares prompts), the Spark stays stateless (ADR-0008), genres are data
(ADR-0012), and an old session must replay exactly (ADR-0014).

## Decision
- **Genre taste is data.** Each genre pack gets a `leading` section
  (`schema/genre.schema.json`, `web/src/core/leading.ts`):
  `activity` [low, high] (how much the leader moves, 0–1), `arc`
  (`build`, `dynamic` or `locked`), `favour` and `avoid` (moves as `kind` or
  `kind:arg`), `trade` (bars per turn and soloists, ADR-0022) and `taste` (a
  sentence for LLMs). The first three:

  | | funk | blues rock | jazz |
  |---|---|---|---|
  | activity | 0.2–0.6 | 0.3–0.75 | 0.35–0.9 |
  | arc | locked | build | dynamic |
  | favours | parts in and out, crash | level, crash, riser, parts in | level, fills, the piano laying out and back, double time |
  | avoids | double time, riser | double time | riser |
  | trades with | keys, guitar | guitar, keys | drums, keys |

- **Personality picks a point in the genre's range**: steady the low end,
  supportive the middle (the default), adventurous the high end. The point
  (`activity`) sets the governor's layer dwell, feel dwell and deadband (at
  0.5 they are the v0.3 values; going back to the normal feel never waits
  longer than v0.3's 4 bars), and goes to every brain in the summary
  (`leading`). The rule leader reads it: steady needs a bigger change before
  it moves and makes one move at a time without flourishes; adventurous adds a
  favoured colour move when nothing else is happening. The player picks it
  under **Bandleader → Personality**; it is kept in the browser, recorded in
  the session (`personality`, and a `personality` control for each change)
  and applies from the next bar. Sessions without it keep their governor.
- **The page keeps the song arc** (`web/src/core/arc.ts`): each section visit
  (level, peak, who played, feel) and a plan for this visit and the next,
  made against the last time through the same section, by the genre's arc:
  build (+0.12, +0.18 the last time, a missing part in), dynamic (−0.12 and
  the keys out after a big one, +0.12 and a part back after a quiet one),
  locked (the same level, one part in or out). It goes into every request
  (`arc`), so no brain needs memory. The rule leader follows the next
  section's plan in the bar or two before it, while the player grooves or
  digs in, never against the player's direction, and keeps the offset for the
  visit. The overlay shows the plan.
- **Following comes first, for every brain.** The page works out where
  following the player puts the band (`leading.follow`: the level, the gap
  to the band's target in words, and why: stopped, breathing, sparse, held
  notes, getting softer or louder, steady, busy), from energy, phrasing and
  dynamics, whichever listening groups are on, precomputed like `trend` so
  the model doesn't do arithmetic. For text LLMs (Qwen and other
  OpenAI-compatible models, Claude) a deterministic **follow guard**
  (`guardFollow`) checks each reply: a stopped player gets the level down and
  the drums out with nothing added; a reply that leaves the level more than
  0.1 off gets the follow level added; a busy player keeps the whole band.
  The LLM still makes the colour, structure and arc calls. Tuning the prompt
  alone traded one failure for another (Qwen 30B-A3B with a long prompt keeps
  some rules and drops others); the guard is the "policy" half of "prompt and
  policy tuning".
- LLMs get one fixed paragraph each for `leading` and `arc` after the
  listening paragraphs ([bandleader.md](../bandleader.md#leading-v04)); Jev
  gets the plan, personality and taste in its state, and its options leave
  out what the genre avoids.

## Consequences
- The same playing gets recognisably different calls per genre (eval G1),
  the second time through a section differs in the genre's way (A1), and the
  personalities differ in how much the band moves (P1–P3): steady about half
  as much as supportive, adventurous about half again more, for the rules.
- The summary grows by the arc (about 150 tokens). `so_far` is capped at six
  visits. For Qwen it stays inside the ADR-0006 budget (see the v0.4 eval).
- The genre's range means "adventurous funk" moves less than "adventurous
  jazz", which is the point, but the personality names mean slightly
  different amounts per genre.
- The arc's level steps are fixed numbers; they may want to become pack data
  once a ballad genre wants smaller ones.

## Alternatives considered
- **Personality as a prompt line only.** The rules and Jev wouldn't change,
  and a brain that ignores it would move as much as ever. Through the
  governor, every brain is held to it.
- **The leader keeps its own memory** (a conversation with the LLM). Breaks
  the stateless Spark, makes requests grow without bound, and the rules and
  Jev couldn't share it.
- **Prompt only for Qwen's following.** Tried first: the sparse scenarios
  went from 0.66 to about 0.85 and back with each rewording, and the
  "follow the plan" paragraph pulled it away from a player who stopped.
- **Arc as a chart feature** (the chart says chorus 2 is bigger). Charts
  already have section intensities; the arc is about what the band did, which
  only the page knows.
