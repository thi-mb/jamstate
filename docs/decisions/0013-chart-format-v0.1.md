# 0013. Chart format v0.1

- Status: Accepted (as implemented by the v0.1 build); supersedes [0010](0010-chart-format-v0.md) additively
- Date: 2026-10-31

## Context
v0.1 gives songs a genre and a feel, and the band counts in and ends songs.
Charts need to say which genre and feel they want, and a section sometimes
needs a different feel (a ride-cymbal chorus, a straight bridge). Every v0
chart must still load.

## Decision
Add optional fields to the v0 format ([ADR-0010](0010-chart-format-v0.md)):

- `version`: `"0.1"` (optional; a chart without it is read the same way).
- `genre`: a genre pack id ([ADR-0012](0012-genre-pack-format.md)): `funk`,
  `blues-rock`, `jazz`. Default `blues-rock`.
- `swing`: 0–1, overrides the genre's swing.
- `count_in`: 0–2 bars counted in before bar 1 (default 1).
- Per section: `swing` (overrides the song's) and `cymbal` (`hat` or `ride`,
  overrides the genre's choice for that section).

Swing resolves as page override → section → chart → genre. The page can
also switch genre live, which is how "the same chart in two genres" is
tested.

The end of the form is now an ending (ritardando and a final hit on the
next downbeat) when the form doesn't loop, and the new `end_song` move ends
it on cue at the end of the current phrase. `end_song` is a player move (a
button now, a pedal or voice cue in v0.3); the LLM's move schema leaves it
out and the conductor drops it from any leader's reply.

## Consequences
- v0 charts load unchanged. LLM-written charts get a `genre` constrained to
  the installed packs.
- Still no odd meters, pickups into bar 1 or key changes; those need a
  further version.

## Alternatives considered
- **Genre only in the page, not the chart.** Simpler, but a song has a style;
  text-to-song (v0.6) needs to write it into the chart.
