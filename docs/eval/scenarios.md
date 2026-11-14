# Leader eval: scenarios

Draft for Thiago's review (v0.3, 2026-11-08). These are the situations the
leader eval plays and what a good bandleader must or must not do in each.
PR 2 turns this page into data (`web/eval/`) and runs it; this page stays the
spec, so change the rules here.

## How a scenario runs

- A scripted pretend player plays a song, and the brain under test leads the
  band through the real conductor and governor (the bake-off's closed loop).
  Each brain gets the same player notes.
- Songs: Night Shift (funk, 112 bpm), Blues in A (blues rock, 96 bpm), Late
  Set (jazz, 132 bpm). A scenario runs on all three unless it says
  otherwise, because what counts as busy or sparse depends on the genre.
- Bars are counted from the first bar after the count-in (bar 0). The
  player's change always starts on a phrase boundary (phrase = 4 bars), so
  the LLM first hears it in the summary at the end of that phrase.
- **Checks are on what the band does**, read from the session the run
  produces: the governor's intensity **target**, the **layers** playing,
  **feel**, **section**, **tempo**, and the moves that landed. A check
  passes or fails. Most checks are about the band's state, so two different
  moves that get the band to the same place score the same.
- **"By bar N"** means at bar N the state holds. **"Bars A–B"** means at
  every bar in that range. The windows allow one LLM turn plus the
  governor's dwell: the change at bar 8 is in the summary at bar 12, and
  the band should be there by bar 16.
- **Score:** a scenario's score is checks passed / checks. A brain's score
  is the mean over every scenario × song × seed (3 player seeds), also
  reported per genre and per signal-group setting. Cue and tempo scenarios
  are scored too but also reported in their own columns, since they mostly
  test the page, not the brain.

Player modes the pretend player needs (today it has `silent`, `sparse`,
`medium`, `busy`): `held` (one or two long soft notes a bar), `crescendo` /
`decrescendo` (velocity ramps across each phrase at a steady density),
`outside` (medium density, notes outside the chord and the genre's scale),
`riff` (one bar repeated exactly), `syncopated` (offbeat sixteenths),
`push` / `layback` (medium, every onset 40 ms early / late against the
band), `rush` / `drag` (medium, the player's own tempo 3% faster / slower
than the band and drifting further while the band doesn't follow). They are
built in PR 2, so the baseline covers every scenario.

## Follow the player

### E1 Goes sparse
Player: `medium:8, sparse:8`.
- Must: by bar 16, target ≤ 0.4.
- Must not: bars 8–16, target goes up, a layer is added, or a riser fires.

### E2 Stops
Player: `medium:8, silent:8`.
- Must: by bar 16, target ≤ 0.3 or drums out.
- Must not: bars 8–16, a layer is added or a stinger fires.

### E3 Comes back
Player: `silent:8, medium:8` (the band starts at the song's intensity and
drops in the silence first).
- Must: by bar 16, target ≥ 0.45 and drums and bass in.
- Must not: bars 8–16, target goes down.

### E4 Stays busy
Player: `medium:4, busy:12`.
- Must: by bar 12, target ≥ 0.6 (0.55 on jazz, whose sections sit lower;
  tuned from the baseline); by bar 16, every part in the lineup is
  playing.
- Must not: bars 4–16, change to half time, or target goes down.

### E5 Builds into the chorus
Player builds over the 8 bars before a section change: `sparse:4,
medium:2, busy:2`, timed so the busy bars end at the change (Night Shift:
verse into chorus at bar 12; Blues in A: head into the first solo at bar 12;
Late Set: A into B, bar 20), then `busy:8`.
- Must: target at the new section's first bar ≥ target 8 bars earlier +
  0.2.
- Must: a fill or crash lands on the last bar before the change or the new
  section's first bar.
- Must not: in the 4 bars before the change, a layer is dropped or target
  goes down.

### E6 Crescendo inside a phrase
Player: `medium:4, crescendo:8` (density steady, velocity from about 50 to
110 across each phrase).
- Must: by bar 12, target ≥ target at bar 4 + 0.1.
- Must not: bars 4–12, target goes down.

### E7 Decrescendo inside a phrase
Player: `busy:4, decrescendo:8` (density steady, velocity from about 110 to
50 across each phrase).
- Must: by bar 12, target ≤ target at bar 4 − 0.1.
- Must not: bars 4–12, a layer is added.

### E8 Held notes
Player: `medium:4, held:8`.
- Must: by bar 12, target ≤ 0.45.
- Must not: bars 4–12, a layer is added, double time, or a riser.

## Phrasing

### E9 Call and response
Player: `busy:2, silent:2` repeated for 16 bars, starting at bar 4.
- Must: bars 8–20, drums and bass stay in and target stays ≥ 0.3 (the gaps
  are answers, not the player leaving).
- Must not: bars 8–20, target changes by more than 0.2 between two turns
  (don't chase the gaps), or a change of feel.
- Stretch (a v0.3 target, likely fails at baseline): at least two fills
  land in the silent bars.

### E10 Taking a chorus (Blues in A, Late Set)
Player: `medium:N` until the first solo section, then `busy` for that whole
section, then `medium` again.
- Must: from the solo's second phrase to its end, target ≥ 0.5 (the leader
  first hears the solo at the end of its first phrase); during the whole
  solo section, drums and bass in.
- Must not: during the solo section, a jump to another section, or a
  dropped layer.

### E11 Keeps going at the end of a solo (Blues in A, Late Set)
Player: `busy` through the last solo section and its last 2 bars, then
`busy:4` more.
- Must not: in the solo section's last 4 bars, a jump back to the head.
- Must (v0.3 target): the solo section is extended or repeated rather than
  the head coming in under a busy player.

## Harmony and rhythm

### E12 Plays outside (funk, blues rock)
Player: `medium:4, outside:8`.
- Must not: bars 4–12, target goes up by more than 0.1, a layer is added,
  or a riser.

In jazz, outside playing is tension the band can support, so E12 has no
jazz run; the leader may do anything that doesn't drop the band out
(must: drums and bass stay in, bars 4–12).

### E13 Locks into a riff (Night Shift)
Player: `riff:16`.
- Must not: bars 0–16, more than one target change bigger than 0.1, a
  change of feel, or a section jump.

### E14 Syncopated
Player: `medium:4, syncopated:8`.
- Must not: bars 4–12, target goes down, or half time.

## Tempo

Each tempo scenario runs twice: strict (E15–E17, the default) and with
Follow my tempo on (E15f–E17f).

### E15 Pushing and laying back (feel, not tempo)
Player: `push:8, layback:8`, with Follow my tempo off (E15) and on (E15f).
- Must: tempo stays at the chart tempo at every bar, both settings.

### E16 Rushing
Player: `medium:4, rush:12`.
- Strict (default): tempo stays at the chart tempo at every bar.
- Follow on: by bar 16, tempo is above the chart tempo; at every bar, tempo
  is within +5% of the chart; tempo changes only on bar lines and by at most
  1% per bar.

### E17 Dragging
Player: `medium:4, drag:12`. Same checks as E16, slower.

The follower (`web/src/core/tempo.ts`) hears how the player's beat drifts
against the band's over the last 2 bars, smooths it, ignores differences
under 0.4%, and moves the band at most 1% per bar, never past ±5% of the
chart tempo. A new tempo applies from the next bar. Tempo changes are
recorded in the session (`tempo` controls) and replay exactly.

## Cues

Each cue is pressed in bar 9 (inside a phrase that started at bar 8), before
bar 10 is committed, while the player pushes the other way where there is
one. "Next bar" is bar 10, "next phrase" is bar 12. The lockout is the phrase
after a cue in which the governor rejects leader moves that undo it
([ADR-0020](../decisions/0020-cues-and-lockout.md)). Keys in brackets.

### C1 Take it down (5)
Player plays `busy`.
- Must: by bar 10, target ≤ the target at bar 9 − 0.2.
- Must not: bars 10–14, target goes up (lockout).

### C2 Build (4)
Player plays `sparse`.
- Must: by bar 10, target ≥ the target at bar 9 + 0.2; a riser or fill
  lands on bar 10 or 11.
- Must not: bars 10–14, target goes down.

### C3 Drums/perc break (2)
- Must: bars 10–11, drums and percussion out and the rest of the band in;
  drums back on bar 12.

### C4 Drums/perc only (3)
- Must: bars 10–11, only drums and percussion; the bass back on bar 12.

### C5 Next section (1)
Pressed in the second bar of the first section longer than a phrase from
bar 8 on, so the next phrase isn't a section change anyway.
- Must: the next phrase is the first bar of the next section in the form.

### C6 One more (6)
Pressed two bars before the end of that same section.
- Must: the section plays once more, then the form goes on.

### C7 End song (7)
- Must: bar 11 is the ending and the song stops there.

## Leading (v0.4)

Added with v0.4 ([ADR-0021](../decisions/0021-leading-layer.md),
[ADR-0022](../decisions/0022-trading-fours.md)) and reported in their own
columns. Every run has a personality (supportive unless the scenario says).

### A1 Second time through
The first section the form plays twice that is a chorus or a solo (Night
Shift: chorus at bars 12 and 28; Blues in A: solo at 12 and 24; Late Set:
solo at 36 and 44). Player: `medium` all the way, so the playing is the
same both times. Visits are judged from their third bar (the plan lands in
the first bars).
- Must, by the genre's arc: **build** (blues rock): the second visit's mean
  target at least 0.05 above the first's. **dynamic** (jazz): differs by
  0.08 or more, or in who plays. **locked** (funk): a different set of
  parts, within 0.15 of the first's level.
- Must: the second visit still follows the player: mean target 0.35–0.8;
  drums and bass in throughout.

### P1–P3 Personality
Player: `medium:4, busy:8, sparse:8, medium:8, held:4, busy:8` (40 bars),
as steady (P1), supportive (P2) and adventurous (P3).
- Must (all): target ≥ 0.5 by bar 12, ≤ 0.45 by bar 20, ≥ 0.5 by bar 40.
- Must: P1 at most 7 leader moves; P3 at least 10. The move count of every
  run is reported (a stretch check that always passes) to compare the three.

### G1 Same playing, three genres (Night Shift)
The P2 player on Night Shift's chart played as funk, blues rock and jazz.
- Must (all): the follow checks of P1–P3, and no move the genre avoids.
- Must, funk: at least one part in or out, and no more feel changes than
  part moves (texture over feel). Blues rock: a lift marked with a crash or
  riser. Jazz: at least two fills or part moves (it talks back).

### T1–T3 Trading
With trading on (T1, T2) from the start.
- T1 Trades fours: player `busy:4, silent:4` four times. Must: the band
  takes at least 3 of its 4 turns (bars 4, 12, 20, 28); no band solo in the
  player's turns; drums and bass in (or a drum solo); no leader layer drop;
  target ≥ 0.4 from bar 4.
- T2 Comes back in early: `busy:4, silent:1, busy:7`. Must: the band's turn
  starts at bar 4 and has handed back by bar 7.
- T3 Trading off: `busy:4, silent:4` twice with trading off. Must not: any
  band solo.

## Real jams

Thiago's own jams join the set once he can play guitar into the page
(v0.5): he isn't a keyboard player, so keyboard jams wouldn't be his real
playing (decided 2026-11-09, v0.3 test T9). Three downloaded sessions, one
per genre; Claude labels them with checks in the same style, Thiago reviews
the labels, and they count from then on.

## Decided in review

- Thresholds are provisional, tuned from the baseline
  ([results/baseline-v0.2](results/baseline-v0.2/summary.md)). So far one
  change: E4 asks ≥ 0.55 on jazz. E1, E7 and E8 fail for every brain on
  purpose: the v0.2 summary only carries energy, so held notes and a
  decrescendo inside a phrase are the gaps the listening groups should close.
- Stretch checks (the "v0.3 target" ones in E9, E11, E12 jazz) are reported
  separately and left out of the score.
- Jazz under outside playing: stay in, mostly; a lift is a stretch check.
- The break is two cues: drums/perc break (C3) and drums/perc only (C4).
  Cues are numbered C1–C7 by scenario and keyed 1–7 by how often they're
  reached for (next section on 1).
