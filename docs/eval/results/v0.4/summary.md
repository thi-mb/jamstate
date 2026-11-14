# Leader eval

2026-11-10T01:32Z · 606 runs · 3 seeds · listening: phrasing · measured from: Mac, Qwen on the Spark through an ssh tunnel

Score: checks passed / checks over every run (stretch checks left out), mean over runs. Scenarios: [scenarios.md](../../scenarios.md).

| Brain | v0.3 set | v0.4 set | sparse |
|---|---|---|---|
| Rules | 0.98 | 1.00 | 0.99 |
| Qwen | 0.95 | 0.95 | 0.85 |

| Brain | Score | follow | phrasing | harmony & rhythm | tempo | cues | arc | personality | genre | trading | funk | blues-rock | jazz | Stretch | Turns | Errors | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Rules | **0.99** | 0.95 | 0.96 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.99 | 0.99 | 0.98 | 0.73 | 3225 | 0 | 0 | 0 |
| Qwen | **0.95** | 0.85 | 1.00 | 1.00 | 1.00 | 1.00 | 0.93 | 0.94 | 0.87 | 1.00 | 0.95 | 0.96 | 0.95 | 0.73 | 1608 | 0 | 813 | 1021 |

## Per scenario

Mean score over seeds; stretch checks passed in brackets where a scenario has them.

| Scenario | Song | Rules | Qwen |
|---|---|---|---|
| E1 Goes sparse | night-shift | 1.00 | 1.00 |
| E1 Goes sparse | blues-in-a | 1.00 | 1.00 |
| E1 Goes sparse | late-set | 1.00 | 0.75 |
| E2 Stops | night-shift | 1.00 | 1.00 |
| E2 Stops | blues-in-a | 1.00 | 1.00 |
| E2 Stops | late-set | 1.00 | 1.00 |
| E3 Comes back | night-shift | 1.00 | 0.83 |
| E3 Comes back | blues-in-a | 1.00 | 1.00 |
| E3 Comes back | late-set | 1.00 | 0.83 |
| E4 Stays busy | night-shift | 1.00 | 1.00 |
| E4 Stays busy | blues-in-a | 1.00 | 1.00 |
| E4 Stays busy | late-set | 1.00 | 1.00 |
| E5 Builds into the next section | night-shift | 0.58 | 0.50 |
| E5 Builds into the next section | blues-in-a | 0.67 | 0.50 |
| E5 Builds into the next section | late-set | 0.75 | 0.50 |
| E6 Crescendo inside a phrase | night-shift | 1.00 | 1.00 |
| E6 Crescendo inside a phrase | blues-in-a | 1.00 | 1.00 |
| E6 Crescendo inside a phrase | late-set | 1.00 | 1.00 |
| E7 Decrescendo inside a phrase | night-shift | 1.00 | 0.50 |
| E7 Decrescendo inside a phrase | blues-in-a | 1.00 | 0.50 |
| E7 Decrescendo inside a phrase | late-set | 1.00 | 0.50 |
| E8 Held notes | night-shift | 0.92 | 1.00 |
| E8 Held notes | blues-in-a | 0.92 | 1.00 |
| E8 Held notes | late-set | 1.00 | 1.00 |
| E9 Call and response | night-shift | 1.00 (1.00) | 1.00 (1.00) |
| E9 Call and response | blues-in-a | 1.00 (0.00) | 1.00 (0.00) |
| E9 Call and response | late-set | 0.75 (1.00) | 1.00 (1.00) |
| E10 Taking a chorus | blues-in-a | 1.00 | 1.00 |
| E10 Taking a chorus | late-set | 1.00 | 1.00 |
| E11 Keeps going at the end of a solo | blues-in-a | 1.00 (0.00) | 1.00 (0.00) |
| E11 Keeps going at the end of a solo | late-set | 1.00 (0.00) | 1.00 (0.00) |
| E12 Plays outside | night-shift | 1.00 | 1.00 |
| E12 Plays outside | blues-in-a | 1.00 | 1.00 |
| E12j Plays outside (jazz) | late-set | 1.00 (0.00) | 1.00 (0.00) |
| E13 Locks into a riff | night-shift | 1.00 | 1.00 |
| E14 Syncopated | night-shift | 1.00 | 1.00 |
| E14 Syncopated | blues-in-a | 1.00 | 1.00 |
| E14 Syncopated | late-set | 1.00 | 1.00 |
| E15 Pushing and laying back | night-shift | 1.00 | 1.00 |
| E15 Pushing and laying back | blues-in-a | 1.00 | 1.00 |
| E15 Pushing and laying back | late-set | 1.00 | 1.00 |
| E16 Rushing (strict tempo) | night-shift | 1.00 | 1.00 |
| E16 Rushing (strict tempo) | blues-in-a | 1.00 | 1.00 |
| E16 Rushing (strict tempo) | late-set | 1.00 | 1.00 |
| E17 Dragging (strict tempo) | night-shift | 1.00 | 1.00 |
| E17 Dragging (strict tempo) | blues-in-a | 1.00 | 1.00 |
| E17 Dragging (strict tempo) | late-set | 1.00 | 1.00 |
| E15f Pushing and laying back (follow my tempo) | night-shift | 1.00 | 1.00 |
| E15f Pushing and laying back (follow my tempo) | blues-in-a | 1.00 | 1.00 |
| E15f Pushing and laying back (follow my tempo) | late-set | 1.00 | 1.00 |
| E16f Rushing (follow my tempo) | night-shift | 1.00 | 1.00 |
| E16f Rushing (follow my tempo) | blues-in-a | 1.00 | 1.00 |
| E16f Rushing (follow my tempo) | late-set | 1.00 | 1.00 |
| E17f Dragging (follow my tempo) | night-shift | 1.00 | 1.00 |
| E17f Dragging (follow my tempo) | blues-in-a | 1.00 | 1.00 |
| E17f Dragging (follow my tempo) | late-set | 1.00 | 1.00 |
| C1 Take it down | night-shift | 1.00 | 1.00 |
| C1 Take it down | blues-in-a | 1.00 | 1.00 |
| C1 Take it down | late-set | 1.00 | 1.00 |
| C2 Build | night-shift | 1.00 | 1.00 |
| C2 Build | blues-in-a | 1.00 | 1.00 |
| C2 Build | late-set | 1.00 | 1.00 |
| C3 Drums/perc break | night-shift | 1.00 | 1.00 |
| C3 Drums/perc break | blues-in-a | 1.00 | 1.00 |
| C3 Drums/perc break | late-set | 1.00 | 1.00 |
| C4 Drums/perc only | night-shift | 1.00 | 1.00 |
| C4 Drums/perc only | blues-in-a | 1.00 | 1.00 |
| C4 Drums/perc only | late-set | 1.00 | 1.00 |
| C5 Next section | night-shift | 1.00 | 1.00 |
| C5 Next section | blues-in-a | 1.00 | 1.00 |
| C5 Next section | late-set | 1.00 | 1.00 |
| C6 One more | night-shift | 1.00 | 1.00 |
| C6 One more | blues-in-a | 1.00 | 1.00 |
| C6 One more | late-set | 1.00 | 1.00 |
| C7 End song | night-shift | 1.00 | 1.00 |
| C7 End song | blues-in-a | 1.00 | 1.00 |
| C7 End song | late-set | 1.00 | 1.00 |
| A1 Second time through | night-shift | 1.00 | 0.78 |
| A1 Second time through | blues-in-a | 1.00 | 1.00 |
| A1 Second time through | late-set | 1.00 | 1.00 |
| P1 Steady | night-shift | 1.00 (1.00) | 1.00 (1.00) |
| P1 Steady | blues-in-a | 1.00 (1.00) | 1.00 (1.00) |
| P1 Steady | late-set | 1.00 (1.00) | 1.00 (1.00) |
| P2 Supportive | night-shift | 1.00 (1.00) | 1.00 (1.00) |
| P2 Supportive | blues-in-a | 1.00 (1.00) | 1.00 (1.00) |
| P2 Supportive | late-set | 1.00 (1.00) | 1.00 (1.00) |
| P3 Adventurous | night-shift | 1.00 (1.00) | 0.92 (1.00) |
| P3 Adventurous | blues-in-a | 1.00 (1.00) | 0.75 (1.00) |
| P3 Adventurous | late-set | 1.00 (1.00) | 0.75 (1.00) |
| G1-funk Same playing, funk | night-shift | 1.00 | 1.00 |
| G1-blues-rock Same playing, blues-rock | night-shift | 1.00 | 0.80 |
| G1-jazz Same playing, jazz | night-shift | 1.00 | 0.80 |
| T1 Trades fours | night-shift | 1.00 | 1.00 |
| T1 Trades fours | blues-in-a | 1.00 | 1.00 |
| T1 Trades fours | late-set | 1.00 | 1.00 |
| T2 Comes back in early | night-shift | 1.00 | 1.00 |
| T2 Comes back in early | blues-in-a | 1.00 | 1.00 |
| T2 Comes back in early | late-set | 1.00 | 1.00 |
| T3 Trading off | night-shift | 1.00 | 1.00 |
| T3 Trading off | blues-in-a | 1.00 | 1.00 |
| T3 Trading off | late-set | 1.00 | 1.00 |

## Failed checks

How often each check failed, per brain (runs failed / runs).

**Rules**: 

- E11 blues-in-a: stretch: bar 48 is still the solo (extended or repeated) (3/3)
- E11 late-set: stretch: bar 52 is still the solo (extended or repeated) (3/3)
- E12j late-set: stretch: by bar 12, target ≥ target at bar 4 + 0.1 (3/3)
- E5 blues-in-a: by bar 12, target ≥ target at bar 4 + 0.2 (3/3)
- E5 late-set: by bar 20, target ≥ target at bar 12 + 0.2 (3/3)
- E5 night-shift: by bar 12, target ≥ target at bar 4 + 0.2 (3/3)
- E9 blues-in-a: stretch: at least two fills land in the silent bars (3/3)
- E9 late-set: must not: bars 8–20, the leader moves the target by more than 0.2 at once (3/3)
- E5 blues-in-a: must not: bars 8–11, the leader lowers the target (1/3)
- E5 night-shift: must not: bars 8–11, the leader drops a layer (1/3)
- E5 night-shift: must not: bars 8–11, the leader lowers the target (1/3)
- E8 blues-in-a: by bar 12, target ≤ 0.45 (1/3)
- E8 night-shift: by bar 12, target ≤ 0.45 (1/3)

**Qwen**: 

- E1 late-set: by bar 16, target ≤ 0.4 (3/3)
- E11 blues-in-a: stretch: bar 48 is still the solo (extended or repeated) (3/3)
- E11 late-set: stretch: bar 52 is still the solo (extended or repeated) (3/3)
- E12j late-set: stretch: by bar 12, target ≥ target at bar 4 + 0.1 (3/3)
- E5 blues-in-a: by bar 12, target ≥ target at bar 4 + 0.2 (3/3)
- E5 blues-in-a: must not: bars 8–11, the leader lowers the target (3/3)
- E5 late-set: by bar 20, target ≥ target at bar 12 + 0.2 (3/3)
- E5 late-set: must not: bars 16–19, the leader lowers the target (3/3)
- E5 night-shift: by bar 12, target ≥ target at bar 4 + 0.2 (3/3)
- E5 night-shift: must not: bars 8–11, the leader lowers the target (3/3)
- E7 blues-in-a: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E7 late-set: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E7 night-shift: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E9 blues-in-a: stretch: at least two fills land in the silent bars (3/3)
- G1-blues-rock night-shift: the leader marks a lift with a crash or a riser (rock) (3/3)
- G1-jazz night-shift: the leader answers with a fill or moves a part at least twice (jazz talks back) (3/3)
- P3 blues-in-a: at least 10 leader moves over 40 bars (3/3)
- P3 late-set: at least 10 leader moves over 40 bars (3/3)
- A1 night-shift: chorus 2 has another texture than chorus 1 at about the same level (locked) (2/3)
- E3 late-set: by bar 16, target ≥ 0.45 and drums and bass in (1/3)
- E3 night-shift: must not: bars 8–16, the leader lowers the target (1/3)
- P3 night-shift: at least 10 leader moves over 40 bars (1/3)

## Where the band lands

The value each check reads, mean over seeds, to tune thresholds by genre.

| Scenario | Check | Song | Rules | Qwen |
|---|---|---|---|---|
| E1 | by bar 16, target ≤ 0.4 | night-shift | 0.28 | 0.29 |
| E1 | by bar 16, target ≤ 0.4 | blues-in-a | 0.28 | 0.29 |
| E1 | by bar 16, target ≤ 0.4 | late-set | 0.28 | 0.42 |
| E2 | by bar 16, target ≤ 0.3 or drums out | night-shift | 0.10 | 0.15 |
| E2 | by bar 16, target ≤ 0.3 or drums out | blues-in-a | 0.10 | 0.15 |
| E2 | by bar 16, target ≤ 0.3 or drums out | late-set | 0.10 | 0.15 |
| E3 | by bar 16, target ≥ 0.45 and drums and bass in | night-shift | 0.50 | 0.48 |
| E3 | by bar 16, target ≥ 0.45 and drums and bass in | blues-in-a | 0.50 | 0.55 |
| E3 | by bar 16, target ≥ 0.45 and drums and bass in | late-set | 0.50 | 0.47 |
| E4 | by bar 12, target ≥ 0.6 | night-shift | 0.88 | 0.98 |
| E4 | by bar 12, target ≥ 0.6 | blues-in-a | 0.82 | 0.90 |
| E4 | by bar 12, target ≥ 0.55 | late-set | 0.72 | 0.98 |
| E5 | by bar 12, target ≥ target at bar 4 + 0.2 | night-shift | -0.05 | -0.17 |
| E5 | by bar 12, target ≥ target at bar 4 + 0.2 | blues-in-a | 0.00 | -0.21 |
| E5 | by bar 20, target ≥ target at bar 12 + 0.2 | late-set | -0.09 | -0.22 |
| E6 | by bar 12, target ≥ target at bar 4 + 0.1 | night-shift | 0.24 | 0.45 |
| E6 | by bar 12, target ≥ target at bar 4 + 0.1 | blues-in-a | 0.44 | 0.40 |
| E6 | by bar 12, target ≥ target at bar 4 + 0.1 | late-set | 0.39 | 0.48 |
| E7 | by bar 12, target ≤ target at bar 4 − 0.1 | night-shift | -0.13 | 0.33 |
| E7 | by bar 12, target ≤ target at bar 4 − 0.1 | blues-in-a | -0.18 | 0.28 |
| E7 | by bar 12, target ≤ target at bar 4 − 0.1 | late-set | -0.28 | 0.33 |
| E8 | by bar 12, target ≤ 0.45 | night-shift | 0.36 | 0.28 |
| E8 | by bar 12, target ≤ 0.45 | blues-in-a | 0.34 | 0.29 |
| E8 | by bar 12, target ≤ 0.45 | late-set | 0.31 | 0.33 |
| E9 | bars 8–20, target stays ≥ 0.3 | night-shift | 0.66 | 0.45 |
| E9 | at least two fills land in the silent bars | night-shift | 2.00 | 2.00 |
| E9 | bars 8–20, target stays ≥ 0.3 | blues-in-a | 0.82 | 0.50 |
| E9 | at least two fills land in the silent bars | blues-in-a | 1.00 | 1.00 |
| E9 | bars 8–20, target stays ≥ 0.3 | late-set | 0.72 | 0.42 |
| E9 | at least two fills land in the silent bars | late-set | 2.00 | 2.00 |
| E10 | bars 16–23, target stays ≥ 0.5 | blues-in-a | 1.00 | 0.65 |
| E10 | bars 40–43, target stays ≥ 0.5 | late-set | 1.00 | 0.58 |
| E12j | by bar 12, target ≥ target at bar 4 + 0.1 | late-set | -0.05 | 0.05 |
| E13 | bars 0–16, more than one leader target change bigger than 0.1 | night-shift | 1.00 | 1.00 |
| E15 | bars 0–16, tempo stays at the chart tempo | night-shift | 0.00 | 0.00 |
| E15 | bars 0–16, tempo stays at the chart tempo | blues-in-a | 0.00 | 0.00 |
| E15 | bars 0–16, tempo stays at the chart tempo | late-set | 0.00 | 0.00 |
| E16 | bars 0–16, tempo stays at the chart tempo | night-shift | 0.00 | 0.00 |
| E16 | bars 0–16, tempo stays at the chart tempo | blues-in-a | 0.00 | 0.00 |
| E16 | bars 0–16, tempo stays at the chart tempo | late-set | 0.00 | 0.00 |
| E17 | bars 0–16, tempo stays at the chart tempo | night-shift | 0.00 | 0.00 |
| E17 | bars 0–16, tempo stays at the chart tempo | blues-in-a | 0.00 | 0.00 |
| E17 | bars 0–16, tempo stays at the chart tempo | late-set | 0.00 | 0.00 |
| E15f | bars 0–16, tempo stays at the chart tempo | night-shift | 0.00 | 0.00 |
| E15f | bars 0–16, tempo stays at the chart tempo | blues-in-a | 0.00 | 0.00 |
| E15f | bars 0–16, tempo stays at the chart tempo | late-set | 0.00 | 0.00 |
| E16f | by bar 16, tempo above the chart tempo | night-shift | 0.03 | 0.03 |
| E16f | by bar 16, tempo above the chart tempo | blues-in-a | 0.03 | 0.03 |
| E16f | by bar 16, tempo above the chart tempo | late-set | 0.03 | 0.03 |
| E17f | by bar 16, tempo below the chart tempo | night-shift | -0.03 | -0.03 |
| E17f | by bar 16, tempo below the chart tempo | blues-in-a | -0.03 | -0.03 |
| E17f | by bar 16, tempo below the chart tempo | late-set | -0.03 | -0.03 |
| C1 | by bar 10, target ≤ target at bar 9 − 0.2 | night-shift | -0.25 | -0.25 |
| C1 | by bar 10, target ≤ target at bar 9 − 0.2 | blues-in-a | -0.25 | -0.25 |
| C1 | by bar 10, target ≤ target at bar 9 − 0.2 | late-set | -0.25 | -0.25 |
| C2 | by bar 10, target ≥ target at bar 9 + 0.2 | night-shift | 0.25 | 0.25 |
| C2 | by bar 10, target ≥ target at bar 9 + 0.2 | blues-in-a | 0.25 | 0.25 |
| C2 | by bar 10, target ≥ target at bar 9 + 0.2 | late-set | 0.25 | 0.25 |
| A1 | chorus 2 has another texture than chorus 1 at about the same level (locked) | night-shift | -0.00 | 0.00 |
| A1 | chorus 2 still follows the player: target 0.35–0.8 | night-shift | 0.65 | 0.66 |
| A1 | solo 2 sits at least 0.05 above solo 1 (build) | blues-in-a | 0.12 | 0.12 |
| A1 | solo 2 still follows the player: target 0.35–0.8 | blues-in-a | 0.77 | 0.77 |
| A1 | solo 2 differs from solo 1 by 0.08 or in who plays (dynamic) | late-set | -0.12 | -0.12 |
| A1 | solo 2 still follows the player: target 0.35–0.8 | late-set | 0.40 | 0.46 |
| P1 | by bar 12, target ≥ 0.5 | night-shift | 0.88 | 0.98 |
| P1 | by bar 20, target ≤ 0.45 | night-shift | 0.36 | 0.32 |
| P1 | by bar 40, target ≥ 0.5 | night-shift | 0.88 | 0.98 |
| P1 | at most 7 leader moves over 40 bars | night-shift | 5.67 | 6.67 |
| P1 | leader moves (count) | night-shift | 5.67 | 6.67 |
| P1 | by bar 12, target ≥ 0.5 | blues-in-a | 0.82 | 0.90 |
| P1 | by bar 20, target ≤ 0.45 | blues-in-a | 0.28 | 0.35 |
| P1 | by bar 40, target ≥ 0.5 | blues-in-a | 1.00 | 0.87 |
| P1 | at most 7 leader moves over 40 bars | blues-in-a | 3.67 | 4.67 |
| P1 | leader moves (count) | blues-in-a | 3.67 | 4.67 |
| P1 | by bar 12, target ≥ 0.5 | late-set | 0.72 | 0.95 |
| P1 | by bar 20, target ≤ 0.45 | late-set | 0.42 | 0.29 |
| P1 | by bar 40, target ≥ 0.5 | late-set | 1.00 | 0.98 |
| P1 | at most 7 leader moves over 40 bars | late-set | 5.67 | 6.00 |
| P1 | leader moves (count) | late-set | 5.67 | 6.00 |
| P2 | by bar 12, target ≥ 0.5 | night-shift | 0.88 | 0.98 |
| P2 | by bar 20, target ≤ 0.45 | night-shift | 0.36 | 0.32 |
| P2 | by bar 40, target ≥ 0.5 | night-shift | 0.88 | 0.98 |
| P2 | leader moves (count) | night-shift | 10.33 | 6.67 |
| P2 | by bar 12, target ≥ 0.5 | blues-in-a | 0.82 | 0.90 |
| P2 | by bar 20, target ≤ 0.45 | blues-in-a | 0.28 | 0.35 |
| P2 | by bar 40, target ≥ 0.5 | blues-in-a | 1.00 | 0.87 |
| P2 | leader moves (count) | blues-in-a | 9.33 | 5.00 |
| P2 | by bar 12, target ≥ 0.5 | late-set | 0.72 | 0.98 |
| P2 | by bar 20, target ≤ 0.45 | late-set | 0.42 | 0.33 |
| P2 | by bar 40, target ≥ 0.5 | late-set | 1.00 | 0.98 |
| P2 | leader moves (count) | late-set | 10.33 | 6.67 |
| P3 | by bar 12, target ≥ 0.5 | night-shift | 0.88 | 0.98 |
| P3 | by bar 20, target ≤ 0.45 | night-shift | 0.36 | 0.33 |
| P3 | by bar 40, target ≥ 0.5 | night-shift | 0.88 | 0.98 |
| P3 | at least 10 leader moves over 40 bars | night-shift | 11.33 | 9.67 |
| P3 | leader moves (count) | night-shift | 11.33 | 9.67 |
| P3 | by bar 12, target ≥ 0.5 | blues-in-a | 0.82 | 0.90 |
| P3 | by bar 20, target ≤ 0.45 | blues-in-a | 0.28 | 0.35 |
| P3 | by bar 40, target ≥ 0.5 | blues-in-a | 1.00 | 0.87 |
| P3 | at least 10 leader moves over 40 bars | blues-in-a | 11.33 | 5.33 |
| P3 | leader moves (count) | blues-in-a | 11.33 | 5.33 |
| P3 | by bar 12, target ≥ 0.5 | late-set | 0.72 | 0.98 |
| P3 | by bar 20, target ≤ 0.45 | late-set | 0.42 | 0.28 |
| P3 | by bar 40, target ≥ 0.5 | late-set | 0.98 | 0.98 |
| P3 | at least 10 leader moves over 40 bars | late-set | 17.67 | 8.33 |
| P3 | leader moves (count) | late-set | 17.67 | 8.33 |
| G1-funk | by bar 12, target ≥ 0.5 | night-shift | 0.88 | 0.95 |
| G1-funk | by bar 20, target ≤ 0.45 | night-shift | 0.36 | 0.33 |
| G1-funk | by bar 40, target ≥ 0.5 | night-shift | 0.88 | 0.93 |
| G1-funk | the leader makes a move funk avoids | night-shift | 0.00 | 0.00 |
| G1-funk | texture over feel: the leader moves parts in or out at least as often as it changes the feel (funk locks in) | night-shift | 3.33 | 1.67 |
| G1-blues-rock | by bar 12, target ≥ 0.5 | night-shift | 0.88 | 0.93 |
| G1-blues-rock | by bar 20, target ≤ 0.45 | night-shift | 0.36 | 0.35 |
| G1-blues-rock | by bar 40, target ≥ 0.5 | night-shift | 0.88 | 0.88 |
| G1-blues-rock | the leader makes a move blues-rock avoids | night-shift | 0.00 | 0.00 |
| G1-blues-rock | the leader marks a lift with a crash or a riser (rock) | night-shift | 1.33 | 0.00 |
| G1-jazz | by bar 12, target ≥ 0.5 | night-shift | 0.88 | 0.90 |
| G1-jazz | by bar 20, target ≤ 0.45 | night-shift | 0.36 | 0.35 |
| G1-jazz | by bar 40, target ≥ 0.5 | night-shift | 0.83 | 0.98 |
| G1-jazz | the leader makes a move jazz avoids | night-shift | 0.00 | 0.00 |
| G1-jazz | the leader answers with a fill or moves a part at least twice (jazz talks back) | night-shift | 4.67 | 1.00 |
| T1 | the band takes at least 3 of its 4 turns (bars 4, 12, 20, 28) | night-shift | 4.00 | 4.00 |
| T1 | bars 4–31, target stays ≥ 0.4 | night-shift | 0.66 | 0.45 |
| T1 | the band takes at least 3 of its 4 turns (bars 4, 12, 20, 28) | blues-in-a | 4.00 | 4.00 |
| T1 | bars 4–31, target stays ≥ 0.4 | blues-in-a | 0.81 | 0.50 |
| T1 | the band takes at least 3 of its 4 turns (bars 4, 12, 20, 28) | late-set | 4.00 | 4.00 |
| T1 | bars 4–31, target stays ≥ 0.4 | late-set | 0.71 | 0.45 |
