# 0014. Session recording and replay

- Status: Proposed (implemented in v0.1)
- Date: 2026-10-31

## Context
Every release from v0.1 on changes how the band plays or decides, and needs a
way to check that a change didn't break anything, and from v0.3 a way to
score bandleaders on real playing. Listening again by hand doesn't scale.

## Decision
Every jam in the page is recorded to a `houseband-session/0.1` JSON file
(`web/src/core/session.ts`):

- the chart as played, the starting genre and swing, the seed, count-in,
  governor overrides, the leader used;
- the player's notes as `[beat, note, velocity]`, velocity 0 for note off,
  beats from the start of bar 0;
- every outside change to the band: moves (with source and requested bar),
  genre switches and swing switches, each stamped with the last bar the
  engine had prepared when it arrived;
- per bar: section, chords, intensity, level, feel, genre, swing, layers,
  stingers, applied moves, and a hash of the notes the band played.

All randomness in the band is seeded (session seed + place in the song), so
an **exact replay** that feeds the recorded changes back in at the same bars
must give the same hashes. A **leader replay** keeps only the player's notes
and the player's own moves and lets a leader decide again, at the same points
as live (one bar committed ahead), awaiting async leaders.

Sessions can be downloaded from the page or saved on the Spark
(`POST /api/sessions`, files in `~/.local/share/houseband/sessions`). Replay
runs in the page (Check, Play) or headless: `npm run replay -- file.json
[--leader rules|llm]`.

## Consequences
- Groove changes show up as hash mismatches on old sessions: expected when
  the change is intended, a bug otherwise. Changing a genre pack changes the
  output too.
- The file is small (a few hundred KB for a long jam) and readable.
- Leader replay is offline, so an LLM's latency doesn't shift its moves the
  way it does live; the v0.3 eval set builds on this.
- Live audio (v0.5) will need the audio features, not the audio, in the file.

## Alternatives considered
- **Record the band's MIDI output.** Shows what happened but can't re-run a
  different leader or check determinism.
- **Record only the player and re-derive everything.** Loses manual moves and
  live genre switches, and can't tell a regression from a new leader choice.
