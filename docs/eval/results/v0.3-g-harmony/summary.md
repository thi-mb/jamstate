# Leader eval

2026-11-08T20:51Z · 423 runs · 3 seeds · listening: harmony · measured from: unlabelled host

Score: checks passed / checks over every run (stretch checks left out), mean over runs. Scenarios: [scenarios.md](../../scenarios.md).

| Brain | Score | follow | phrasing | harmony & rhythm | tempo | funk | blues-rock | jazz | Stretch | Turns | Errors | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Jev | **0.88** | 0.85 | 0.68 | 1.00 | 1.00 | 0.85 | 0.89 | 0.89 | 0.00 | 627 | 0 | 183 | 225 |
| Claude claude-haiku-5-5 | **0.91** | 0.82 | 0.99 | 1.00 | 1.00 | 0.91 | 0.90 | 0.92 | 0.39 | 627 | 0 | 923 | 1169 |
| Qwen | **0.85** | 0.72 | 0.99 | 0.94 | 1.00 | 0.89 | 0.89 | 0.77 | 0.33 | 627 | 0 | 2797 | 2946 |

## Per scenario

Mean score over seeds; stretch checks passed in brackets where a scenario has them.

| Scenario | Song | Jev | Claude claude-haiku-5-5 | Qwen |
|---|---|---|---|---|
| E1 Goes sparse | night-shift | 1.00 | 0.75 | 0.67 |
| E1 Goes sparse | blues-in-a | 1.00 | 0.75 | 0.75 |
| E1 Goes sparse | late-set | 1.00 | 0.75 | 0.58 |
| E2 Stops | night-shift | 1.00 | 0.67 | 0.67 |
| E2 Stops | blues-in-a | 1.00 | 0.67 | 0.67 |
| E2 Stops | late-set | 1.00 | 0.67 | 0.33 |
| E3 Comes back | night-shift | 0.50 | 1.00 | 1.00 |
| E3 Comes back | blues-in-a | 1.00 | 1.00 | 1.00 |
| E3 Comes back | late-set | 1.00 | 1.00 | 1.00 |
| E4 Stays busy | night-shift | 1.00 | 1.00 | 1.00 |
| E4 Stays busy | blues-in-a | 1.00 | 1.00 | 1.00 |
| E4 Stays busy | late-set | 1.00 | 1.00 | 0.67 |
| E5 Builds into the next section | night-shift | 0.50 | 1.00 | 1.00 |
| E5 Builds into the next section | blues-in-a | 0.50 | 0.75 | 0.75 |
| E5 Builds into the next section | late-set | 0.50 | 0.75 | 0.67 |
| E6 Crescendo inside a phrase | night-shift | 1.00 | 1.00 | 1.00 |
| E6 Crescendo inside a phrase | blues-in-a | 1.00 | 1.00 | 1.00 |
| E6 Crescendo inside a phrase | late-set | 1.00 | 1.00 | 0.50 |
| E7 Decrescendo inside a phrase | night-shift | 0.50 | 0.50 | 0.33 |
| E7 Decrescendo inside a phrase | blues-in-a | 0.50 | 0.50 | 0.33 |
| E7 Decrescendo inside a phrase | late-set | 0.50 | 0.50 | 0.17 |
| E8 Held notes | night-shift | 1.00 | 0.75 | 0.75 |
| E8 Held notes | blues-in-a | 1.00 | 0.75 | 0.75 |
| E8 Held notes | late-set | 1.00 | 1.00 | 0.75 |
| E9 Call and response | night-shift | 0.25 (0.00) | 1.00 (1.00) | 1.00 (1.00) |
| E9 Call and response | blues-in-a | 0.25 (0.00) | 0.92 (0.00) | 0.92 (0.00) |
| E9 Call and response | late-set | 0.25 (0.00) | 1.00 (1.00) | 1.00 (1.00) |
| E10 Taking a chorus | blues-in-a | 1.00 | 1.00 | 1.00 |
| E10 Taking a chorus | late-set | 1.00 | 1.00 | 1.00 |
| E11 Keeps going at the end of a solo | blues-in-a | 1.00 (0.00) | 1.00 (0.00) | 1.00 (0.00) |
| E11 Keeps going at the end of a solo | late-set | 1.00 (0.00) | 1.00 (0.00) | 1.00 (0.00) |
| E12 Plays outside | night-shift | 1.00 | 1.00 | 0.89 |
| E12 Plays outside | blues-in-a | 1.00 | 1.00 | 1.00 |
| E12j Plays outside (jazz) | late-set | 1.00 (0.00) | 1.00 (0.33) | 1.00 (0.00) |
| E13 Locks into a riff | night-shift | 1.00 | 1.00 | 1.00 |
| E14 Syncopated | night-shift | 1.00 | 1.00 | 1.00 |
| E14 Syncopated | blues-in-a | 1.00 | 1.00 | 1.00 |
| E14 Syncopated | late-set | 1.00 | 1.00 | 0.67 |
| E15 Pushing and laying back | night-shift | 1.00 | 1.00 | 1.00 |
| E15 Pushing and laying back | blues-in-a | 1.00 | 1.00 | 1.00 |
| E15 Pushing and laying back | late-set | 1.00 | 1.00 | 1.00 |
| E16 Rushing (strict tempo) | night-shift | 1.00 | 1.00 | 1.00 |
| E16 Rushing (strict tempo) | blues-in-a | 1.00 | 1.00 | 1.00 |
| E16 Rushing (strict tempo) | late-set | 1.00 | 1.00 | 1.00 |
| E17 Dragging (strict tempo) | night-shift | 1.00 | 1.00 | 1.00 |
| E17 Dragging (strict tempo) | blues-in-a | 1.00 | 1.00 | 1.00 |
| E17 Dragging (strict tempo) | late-set | 1.00 | 1.00 | 1.00 |

## Failed checks

How often each check failed, per brain (runs failed / runs).

**Jev**: 

- E11 blues-in-a: stretch: bar 48 is still the solo (extended or repeated) (3/3)
- E11 late-set: stretch: bar 52 is still the solo (extended or repeated) (3/3)
- E12j late-set: stretch: by bar 12, target ≥ target at bar 4 + 0.1 (3/3)
- E3 night-shift: by bar 16, target ≥ 0.45 and drums and bass in (3/3)
- E5 blues-in-a: by bar 12, target ≥ target at bar 4 + 0.2 (3/3)
- E5 blues-in-a: must not: bars 8–11, the leader lowers the target (3/3)
- E5 late-set: by bar 20, target ≥ target at bar 12 + 0.2 (3/3)
- E5 late-set: must not: bars 16–19, the leader lowers the target (3/3)
- E5 night-shift: by bar 12, target ≥ target at bar 4 + 0.2 (3/3)
- E5 night-shift: must not: bars 8–11, the leader lowers the target (3/3)
- E7 blues-in-a: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E7 late-set: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E7 night-shift: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E9 blues-in-a: bars 8–20, drums and bass stay in (3/3)
- E9 blues-in-a: bars 8–20, target stays ≥ 0.3 (3/3)
- E9 blues-in-a: must not: bars 8–20, the leader moves the target by more than 0.2 at once (3/3)
- E9 blues-in-a: stretch: at least two fills land in the silent bars (3/3)
- E9 late-set: bars 8–20, drums and bass stay in (3/3)
- E9 late-set: bars 8–20, target stays ≥ 0.3 (3/3)
- E9 late-set: must not: bars 8–20, the leader moves the target by more than 0.2 at once (3/3)
- E9 late-set: stretch: at least two fills land in the silent bars (3/3)
- E9 night-shift: bars 8–20, drums and bass stay in (3/3)
- E9 night-shift: bars 8–20, target stays ≥ 0.3 (3/3)
- E9 night-shift: must not: bars 8–20, the leader moves the target by more than 0.2 at once (3/3)
- E9 night-shift: stretch: at least two fills land in the silent bars (3/3)

**Claude claude-haiku-5-5**: 

- E1 blues-in-a: by bar 16, target ≤ 0.4 (3/3)
- E1 late-set: by bar 16, target ≤ 0.4 (3/3)
- E1 night-shift: by bar 16, target ≤ 0.4 (3/3)
- E11 blues-in-a: stretch: bar 48 is still the solo (extended or repeated) (3/3)
- E11 late-set: stretch: bar 52 is still the solo (extended or repeated) (3/3)
- E2 blues-in-a: by bar 16, target ≤ 0.3 or drums out (3/3)
- E2 late-set: by bar 16, target ≤ 0.3 or drums out (3/3)
- E2 night-shift: by bar 16, target ≤ 0.3 or drums out (3/3)
- E5 blues-in-a: by bar 12, target ≥ target at bar 4 + 0.2 (3/3)
- E5 late-set: by bar 20, target ≥ target at bar 12 + 0.2 (3/3)
- E7 blues-in-a: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E7 late-set: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E7 night-shift: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E8 blues-in-a: by bar 12, target ≤ 0.45 (3/3)
- E8 night-shift: by bar 12, target ≤ 0.45 (3/3)
- E9 blues-in-a: stretch: at least two fills land in the silent bars (3/3)
- E12j late-set: stretch: by bar 12, target ≥ target at bar 4 + 0.1 (2/3)
- E9 blues-in-a: must not: bars 8–20, the leader moves the target by more than 0.2 at once (1/3)

**Qwen**: 

- E1 blues-in-a: by bar 16, target ≤ 0.4 (3/3)
- E1 late-set: by bar 16, target ≤ 0.4 (3/3)
- E1 night-shift: by bar 16, target ≤ 0.4 (3/3)
- E11 blues-in-a: stretch: bar 48 is still the solo (extended or repeated) (3/3)
- E11 late-set: stretch: bar 52 is still the solo (extended or repeated) (3/3)
- E12j late-set: stretch: by bar 12, target ≥ target at bar 4 + 0.1 (3/3)
- E2 blues-in-a: by bar 16, target ≤ 0.3 or drums out (3/3)
- E2 late-set: by bar 16, target ≤ 0.3 or drums out (3/3)
- E2 late-set: must not: bars 8–16, the leader adds a layer (3/3)
- E2 night-shift: by bar 16, target ≤ 0.3 or drums out (3/3)
- E4 late-set: by bar 12, target ≥ 0.55 (3/3)
- E5 blues-in-a: by bar 12, target ≥ target at bar 4 + 0.2 (3/3)
- E5 late-set: by bar 20, target ≥ target at bar 12 + 0.2 (3/3)
- E6 late-set: by bar 12, target ≥ target at bar 4 + 0.1 (3/3)
- E7 blues-in-a: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E7 late-set: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E7 night-shift: by bar 12, target ≤ target at bar 4 − 0.1 (3/3)
- E8 blues-in-a: by bar 12, target ≤ 0.45 (3/3)
- E8 late-set: must not: bars 4–12, the leader adds a layer (3/3)
- E8 night-shift: by bar 12, target ≤ 0.45 (3/3)
- E9 blues-in-a: stretch: at least two fills land in the silent bars (3/3)
- E1 late-set: must not: bars 8–16, the leader adds a layer (2/3)
- E14 late-set: must not: bars 4–12, the leader goes to half time (2/3)
- E7 late-set: must not: bars 4–12, the leader adds a layer (2/3)
- E1 night-shift: must not: bars 8–16, the leader adds a layer (1/3)
- E12 night-shift: must not: bars 4–12, the leader adds a layer (1/3)
- E4 late-set: must not: bars 4–16, the leader goes to half time (1/3)
- E5 late-set: must not: bars 16–19, the leader drops a layer (1/3)
- E7 blues-in-a: must not: bars 4–12, the leader adds a layer (1/3)
- E7 night-shift: must not: bars 4–12, the leader adds a layer (1/3)
- E9 blues-in-a: must not: bars 8–20, the leader changes the feel (1/3)

## Where the band lands

The value each check reads, mean over seeds, to tune thresholds by genre.

| Scenario | Check | Song | Jev | Claude claude-haiku-5-5 | Qwen |
|---|---|---|---|---|---|
| E1 | by bar 16, target ≤ 0.4 | night-shift | 0.31 | 0.75 | 0.75 |
| E1 | by bar 16, target ≤ 0.4 | blues-in-a | 0.31 | 0.65 | 0.65 |
| E1 | by bar 16, target ≤ 0.4 | late-set | 0.31 | 0.45 | 0.45 |
| E2 | by bar 16, target ≤ 0.3 or drums out | night-shift | 0.11 | 0.75 | 0.75 |
| E2 | by bar 16, target ≤ 0.3 or drums out | blues-in-a | 0.11 | 0.65 | 0.65 |
| E2 | by bar 16, target ≤ 0.3 or drums out | late-set | 0.11 | 0.45 | 0.45 |
| E3 | by bar 16, target ≥ 0.45 and drums and bass in | night-shift | 0.43 | 0.75 | 0.75 |
| E3 | by bar 16, target ≥ 0.45 and drums and bass in | blues-in-a | 0.50 | 0.65 | 0.65 |
| E3 | by bar 16, target ≥ 0.45 and drums and bass in | late-set | 0.50 | 0.45 | 0.45 |
| E4 | by bar 12, target ≥ 0.6 | night-shift | 0.80 | 0.60 | 0.75 |
| E4 | by bar 12, target ≥ 0.6 | blues-in-a | 0.80 | 0.68 | 0.65 |
| E4 | by bar 12, target ≥ 0.55 | late-set | 0.80 | 0.60 | 0.45 |
| E5 | by bar 12, target ≥ target at bar 4 + 0.2 | night-shift | -0.14 | 0.30 | 0.30 |
| E5 | by bar 12, target ≥ target at bar 4 + 0.2 | blues-in-a | -0.19 | 0.15 | 0.15 |
| E5 | by bar 20, target ≥ target at bar 12 + 0.2 | late-set | -0.14 | 0.10 | 0.10 |
| E6 | by bar 12, target ≥ target at bar 4 + 0.1 | night-shift | 0.34 | 0.23 | 0.30 |
| E6 | by bar 12, target ≥ target at bar 4 + 0.1 | blues-in-a | 0.30 | 0.15 | 0.15 |
| E6 | by bar 12, target ≥ target at bar 4 + 0.1 | late-set | 0.35 | 0.10 | 0.00 |
| E7 | by bar 12, target ≤ target at bar 4 − 0.1 | night-shift | 0.32 | 0.23 | 0.30 |
| E7 | by bar 12, target ≤ target at bar 4 − 0.1 | blues-in-a | 0.23 | 0.18 | 0.15 |
| E7 | by bar 12, target ≤ target at bar 4 − 0.1 | late-set | 0.17 | 0.10 | 0.00 |
| E8 | by bar 12, target ≤ 0.45 | night-shift | 0.31 | 0.75 | 0.75 |
| E8 | by bar 12, target ≤ 0.45 | blues-in-a | 0.31 | 0.65 | 0.65 |
| E8 | by bar 12, target ≤ 0.45 | late-set | 0.31 | 0.45 | 0.45 |
| E9 | bars 8–20, target stays ≥ 0.3 | night-shift | 0.15 | 0.45 | 0.45 |
| E9 | at least two fills land in the silent bars | night-shift | 0.00 | 2.00 | 2.00 |
| E9 | bars 8–20, target stays ≥ 0.3 | blues-in-a | 0.14 | 0.47 | 0.50 |
| E9 | at least two fills land in the silent bars | blues-in-a | 0.00 | 1.00 | 1.00 |
| E9 | bars 8–20, target stays ≥ 0.3 | late-set | 0.15 | 0.45 | 0.45 |
| E9 | at least two fills land in the silent bars | late-set | 0.00 | 2.00 | 2.00 |
| E10 | bars 16–23, target stays ≥ 0.5 | blues-in-a | 0.65 | 0.65 | 0.65 |
| E10 | bars 40–43, target stays ≥ 0.5 | late-set | 0.65 | 0.62 | 0.65 |
| E12j | by bar 12, target ≥ target at bar 4 + 0.1 | late-set | 0.00 | 0.03 | 0.00 |
| E13 | bars 0–16, more than one leader target change bigger than 0.1 | night-shift | 1.00 | 0.00 | 0.00 |
| E15 | bars 0–16, tempo stays at the chart tempo | night-shift | 0.00 | 0.00 | 0.00 |
| E15 | bars 0–16, tempo stays at the chart tempo | blues-in-a | 0.00 | 0.00 | 0.00 |
| E15 | bars 0–16, tempo stays at the chart tempo | late-set | 0.00 | 0.00 | 0.00 |
| E16 | bars 0–16, tempo stays at the chart tempo | night-shift | 0.00 | 0.00 | 0.00 |
| E16 | bars 0–16, tempo stays at the chart tempo | blues-in-a | 0.00 | 0.00 | 0.00 |
| E16 | bars 0–16, tempo stays at the chart tempo | late-set | 0.00 | 0.00 | 0.00 |
| E17 | bars 0–16, tempo stays at the chart tempo | night-shift | 0.00 | 0.00 | 0.00 |
| E17 | bars 0–16, tempo stays at the chart tempo | blues-in-a | 0.00 | 0.00 | 0.00 |
| E17 | bars 0–16, tempo stays at the chart tempo | late-set | 0.00 | 0.00 | 0.00 |
