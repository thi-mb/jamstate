# v0.5 guitar: the leader eval on MIDI and on guitar audio

Run on 2026-11-14 with the rule leader, 3 seeds, every scenario on its
songs (104 scenario-song pairs, 312 runs):

```bash
npm run eval -- --brains rules                 # midi.md, midi.json
npm run eval -- --brains rules --input audio   # audio.md, audio.json
```

With `--input audio` the pretend player's notes aren't handed to the band.
Each bar is rendered as a plucked guitar (notes out of the guitar's range
folded in, unpitched hits as muted strums), and the audio listener hears it
as the page hears a guitar, with the chart's chord as its prior. A note
heard after its bar has been summed counts in the next bar, as it does
live. The turn times in audio.md include rendering the guitar, so they
aren't the leader's.

## Scores

| | MIDI | Guitar audio |
|---|---|---|
| Every run | 0.99 | 0.98 |
| v0.3 set | 0.98 | 0.98 |
| v0.4 set | 1.00 | 0.99 |
| Guitar jams (J1–J3) | 1.00 | 1.00 |

Within 0.05 overall and in every group but one, arc (1.00 against 0.93:
A1 on Blues in A, below). 97 of the 104 pairs score the same.

## Where they differ

| Scenario | Song | MIDI | Audio | What the audio run missed |
|---|---|---|---|---|
| A1 Second time through | blues-in-a | 1.00 | 0.78 | solo 2 sits 0.048 above solo 1, not 0.05 |
| E13 Locks into a riff | night-shift | 1.00 | 0.89 | one seed: two target changes over 0.1 |
| E14 Syncopated | late-set | 1.00 | 0.83 | one seed: the leader lowers the target |
| E8 Held notes | blues-in-a | 0.92 | 0.75 | target 0.465 at bar 12, not ≤ 0.45 |
| E8 Held notes | night-shift | 0.92 | 0.75 | target 0.515 at bar 12, not ≤ 0.45 |
| E5 Builds into the chorus | night-shift | 0.58 | 0.75 | (better on audio) |
| E9 Call and response | late-set | 0.75 | 1.00 | (better on audio) |

The misses are near the thresholds. Held notes (E8) are the clearest: a
plucked string decays, so the listener ends the note before the MIDI note
off would, and the band hears a little more space and activity than the
script meant. The fine-tuning pass on Thiago's guitar looks at this
again.

One bug the comparison found, fixed before this run: notes pushed ahead of
the beat (E15's "push") started before their bar and weren't rendered, so
the tempo follower missed every downbeat and the band drifted 5%.

## Guitar jams

J1–J3 (docs/eval/scenarios.md) are one jam per song. Until Thiago's own
are in `docs/eval/jams/`, each is synthesised: the pretend player on a
script, recorded as a session (`web/src/core/eval/jams.ts`). The band
follows the recorded notes, which don't answer it. The rule leader passes
all their checks on both inputs. J2's stretch check (no raise during the
decrescendo) fails on both, as E7 does: the decrescendo inside a phrase
is the gap the v0.3 groups left open.
