# 0020. Player cues on keys 1–7, with a governor lockout

- Status: Accepted
- Date: 2026-11-08

## Context
Up to v0.2 the player steers the band only by playing, or with the manual
move buttons, which go through the governor like any leader move and can be
undone by the leader a bar later. A band takes cues: a nod for the bridge, a
hand down for "bring it down". v0.3 adds cues; voice cues wait for v0.5, so
for now they are keys. Three forces:

- A cue has to land where a band would put it: a level change or a break on
  the next bar, a form change on the next phrase.
- The leader keeps deciding every few bars from what it hears. Without a
  rule, a busy player and a "take it down" cue fight, and the leader wins.
- Jams are recorded and must replay exactly (ADR-0014).

## Decision
- Seven cues, keys 1–7 (and buttons under **Cues**):

  | Key | Cue | Lands | What |
  |---|---|---|---|
  | 1 | Next section | next phrase | the next section in the form starts (ends the song in the last section of a form that doesn't loop) |
  | 2 | Drums/perc break | next bar | drums and percussion out to the end of the phrase, back with a crash |
  | 3 | Drums/perc only | next bar | only drums and percussion to the end of the phrase |
  | 4 | Build | next bar | target +0.25 and a riser |
  | 5 | Take it down | next bar | target −0.25 (not below 0.1) |
  | 6 | One more | next phrase | the section goes round once more, then the form goes on |
  | 7 | End song | end of the phrase | as `end_song` |

- A cue is an engine control (`{kind: "cue"}`), not a move: it is resolved
  when the next bar is prepared, after the leader's moves for that bar, and
  isn't subject to the move rules (minimum section length, one stinger per
  phrase, jump expiry).
- **Lockout.** For a phrase after a cue lands (for a form cue, until it has
  landed), the governor rejects leader moves that would undo it: raises, new
  parts and risers after take it down; lowerings, drops and half time after
  build; layer moves during a break; jumps, extensions and endings around a
  form cue. The chart's nudge at a new section also waits. The player's own
  manual moves are never locked out.
- Cues are recorded with the session's controls and replayed at their bar.
  The applied cue shows in the move log with source `cue`.
- The eval's C1–C7 give each cue while the player pushes the other way.

## Consequences
- The player can always get the band where they want it in a bar.
- A leader that disagrees waits a phrase, then can move again: the cue is a
  direction, not a mode.
- Cue timing follows the commit deadline (the start of the last beat of a
  bar): a key pressed in the last beat lands a bar later.
- Cue sizes (±0.25, a phrase of lockout) are fixed for now; they can become
  settings if playing says so.

## Alternatives considered
- **Cues as manual moves through the governor.** No new concept, but the
  leader undoes them, and a jump has to wait the section minimum.
- **Cues as hints to the leader** ("the player asked to take it down").
  Depends on every brain following them; the rule leader and the eval can't
  rely on it.
- **A permanent mode** (stay down until released). More keys to manage while
  playing; a phrase is what a band does with a nod.
