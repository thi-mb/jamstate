# 0022. Trading fours: a mode, the player's phrase, a band soloist

- Status: Accepted
- Date: 2026-11-09

## Context
Trading fours is the player playing four bars, a band instrument answering
for four, and so on. The roadmap asks for it in v0.4: "when you lay out at a
phrase boundary, a band instrument takes a short solo or answers your last
phrase, then hands back when you come in." Three forces:

- Silence at a phrase boundary already means something: the player stopping
  (eval E2: the band comes down). If silence also starts a trade, a player
  who stops gets a solo instead of space.
- The band can't hear the player and play at once: a bar is committed a bar
  ahead (ADR-0005), so a turn has to be decided before the player's last bar
  ends.
- Jams replay exactly (ADR-0014), and a replay has no player listening.

## Decision
- **Trading is a mode the player turns on** (Thiago, 2026-11-09): key 8 or
  the **Trade fours** button under Cues. Off, silence means what it did in
  v0.3. The setting is kept in the browser; turning it on or off is an engine
  control (`trade`), recorded and replayed.
- **Turns** are the genre's trade length (4 bars in all three packs), counted
  from the top of each section. When the player played in at least two of
  the first bars of their turn, the band takes the next turn. The decision is
  made after the turn's second-to-last bar (the last bar the band can still
  change). A turn the player sits out gets no answer: the band comps and
  waits. When the player comes back in during the band's turn (two or more
  notes in a bar that isn't the turn's last), the soloist stops from the next
  bar not yet committed.
- **The trader listens in the page** (`web/src/core/trade.ts`) and starts and
  stops turns through the engine (`solo` controls carrying the player's
  phrase), so a replay plays the turns without a trader.
- **The soloist** (`web/src/core/solo.ts`) is the genre's next soloist in the
  lineup, in rotation (jazz: drums, then keys). Keys, guitar or bass answer
  with the player's own phrase, moved into the instrument's range: played
  back, answered with the same rhythm and the notes turned round, its first
  half repeated, then its opening landing on a held chord tone, ending early
  so the last beat is the player's. A note that clashes with the chord
  sounding moves to the nearest note the player used that fits (a chord tone,
  or off the beat a note of the song's scale, the one the fretboard's scale
  mode shows), else to a chord tone. A chord's textbook scale ignores the
  key (D natural over Fm in F minor), which was still too outside in funk. (First
  version: new notes from the genre's wide scale, which Thiago heard as too
  many outside notes on Night Shift.) A drum solo plays alone (as a jazz band lays out for the
  drummer) and answers the player's phrase too: the busiest bar of their
  rhythm, on the eighth grid, stated on the snare with kick under their
  accents, answered on the toms, filled in with ghost notes, then half of it
  and a tom run into the player's downbeat, louder through the turn, the
  hi-hat foot on 2 and 4; the band comes back with a crash. (First version:
  a random cell per beat, which Thiago heard as random notes in T5.) A melodic
  soloist plays over the rest of the band, in place of its comping.
- **The governor protects the trade:** while trading, leader moves that drop
  parts, change the feel or take the level down more than 0.15 are rejected.
  The summary carries `trading` (turn, soloist, bars left) and every brain is
  told the gaps are the band's turns.

## Consequences
- Trading never surprises a player who stops; it's one key to start and stop.
- The band answers about two bars after the player's turn is decided, and
  hands back a bar or two late when the player cuts in. Both come from the
  commit deadline, and both are inside one turn.
- The soloist is simple: no motif development beyond the player's rhythm, no
  outside notes, no dynamics shaping beyond a rise and fall. A better
  generator can replace it behind the same interface.
- Turns of 2 or 8 bars work by changing the pack; the page has no setting
  for it yet.

## Alternatives considered
- **Silence starts a trade, everywhere or in solo sections.** No key to
  press, but it fights "the player stopped" and makes E2 depend on the
  section. Rejected in favour of the mode.
- **The leader decides whether a silence is a trade.** Most flexible, least
  reliable, and it can't be checked the same way for every brain.
- **Strict alternation from the moment trading starts.** Simpler, but the
  band would solo over a player who keeps going, and fill turns the player
  never started.
