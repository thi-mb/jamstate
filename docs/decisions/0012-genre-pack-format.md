# 0012. Genre pack format

- Status: Proposed (implemented in v0.1; to accept after the v0.1 hands-on test)
- Date: 2026-10-31

## Context
The roadmap makes genres a thread through every release: a genre decides how
the band composes, who is in it, how it is produced and how the bandleader
behaves ([roadmap.md](../roadmap.md#genres)). v0.1 needs the composition
layer for funk, blues rock and jazz, and new genres should be data, not
code, once the engine supports a layer. The same files should be readable by
the server later (text-to-song in v0.6, leader taste in v0.4).

## Decision
One JSON file per genre in `genres/` at the repo root, format
`houseband-genre/0.1`, schema [schema/genre.schema.json](../../schema/genre.schema.json),
validated with readable errors by `web/src/core/genre.ts`. The page bundles
every file in the folder at build time, so adding a genre is adding a file.

The v0.1 (composition) layer:

- `parts`: the lineup, as roles (`drums`, `bass`, `chords`). The engine only
  walks the lineup; v0.2 adds roles and instruments.
- `feel`: `swing` (0 straight, 0.66 triplet, 1 dotted) and `swing_unit`
  (8 or 16). Swing is applied after generation, so generators always write
  on a straight grid.
- `humanize` per part: `offset_ms` (push or lay back), `jitter_ms`,
  `velocity`, `spread_ms` (chord roll) and per-drum-line offsets. Offsets are
  capped at 30 ms so bars still meet the commit deadline (ADR-0005).
- `drums`: step patterns on a `grid` (steps per beat), four intensity
  levels, each a list of variants (weighted, some only at the end of a
  phrase). Lines are `kick`, `snare`, `stick`, `cymbal` (played on hat or
  ride by section via `cymbal` and `cymbal_sections`), `pedal`, toms,
  `crash`, `clap`; one character per step (`. x X h g o`). Plus `ghosts`
  and `phrase_fills` chances per level, a `fills` vocabulary by length and
  level, and the count-in `pickup`.
- `bass`: token patterns per level, read against the chord at each step:
  degrees (`R 2 b3 3 4 b5 5 6 b7 7 8`, octave marks `'` and `,`), `A`
  approach to the next chord, `N` anticipation, `x` dead note, `g` ghost, `!`
  accent. `approach` style and `approach_chance` per level. `walk.levels`
  switches to a generated walking line (jazz).
- `chords`: a `voicing` style (`close`, `shell`, `triad`, `stab`), a `range`,
  and comping patterns per level (`x X g p`, where `p` pushes the next chord
  early). Voicings are voice-led from the previous chord.
- `ending`: ritardando, ring length, the final chord's quality, and a hit or
  a roll.
- `forms` and `progressions`: typical song shapes, informational until v0.6.

Pattern choice is seeded by the session seed and the bar's place in its
section (so a section keeps its character); ghost notes, approaches and
timing are seeded by the absolute bar (so they vary). Same seed, same notes.

Later layers add top-level keys (`instruments`, `production`, `listening`,
`leading`, `songs`) and bump the format to `houseband-genre/0.2` and so on;
a pack without a layer gets the engine's defaults.

## Consequences
- A genre is about 150 lines of JSON. The three v0.1 packs differ in grid,
  swing, cymbal, bass vocabulary (syncopated sixteenths, boogie, walking),
  voicings and endings, which is the test that the engine doesn't assume one
  style.
- Step strings are easy to read and for an LLM to write, but they are
  bar-sized: phrase-length patterns (a 2-bar clave, a 4-bar riff) need a
  later extension.
- Walking bass is code, picked by the pack, not data. Other generated styles
  would follow the same pattern.

## Alternatives considered
- **MIDI loop files per genre.** Real grooves, but opaque to the engine (no
  degrees, no voice leading) and to the LLM, and they need transposing.
- **Genres as TypeScript modules.** Most flexible, but adding a genre would
  need code, and the server couldn't read them.
