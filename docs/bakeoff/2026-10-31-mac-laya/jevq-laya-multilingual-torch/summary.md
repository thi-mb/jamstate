# Brain bake-off

2026-10-31T14:27Z · 9 sessions · measured from: Thiago's MacBook Pro (M4 Max), localhost

## Latency and validity (same questions)

| Brain | Model | Turns | Errors | p50 ms | p95 ms | max ms | Late (> 1 phrase) | Moves/turn | Rejected |
|---|---|---|---|---|---|---|---|---|---|
| Laya (Jev's questions) | laya-multilingual@torch | 102 | 0 | 41 | 104 | 169 | 0 | 1.86 | 0 |

## Move mix (same questions)

| Brain | set_intensity | add_layer | drop_layer | change_feel | fire_stinger | extend_section | jump_to_section | keep going |
|---|---|---|---|---|---|---|---|---|
| Laya (Jev's questions) | 88 | 0 | 0 | 0 | 0 | 95 | 7 | 0 |

## Following the player (closed loop)

Each brain drives its own replay. **follow**: correlation of the player's energy in a phrase with the band's intensity target one phrase later (1 = follows perfectly). **silent→drop**: after 2+ silent bars, the band is at or below 0.3 by the next turn. **busy→lift**: after a busy phrase, the band is at or above 0.6 by the next turn.

| Brain | follow | silent→drop | busy→lift | moves | errors |
|---|---|---|---|---|---|
| Laya (Jev's questions) | -0.02 | 0.00 | 0.55 | 112 | 0 |

### Per session

| Session | Laya (Jev's questions) |
|---|---|
| sim-blues-in-a-arc | 0.29 / 0.00 / 1.00 |
| sim-blues-in-a-slowburn | 0.40 / – / 0.75 |
| sim-blues-in-a-stopstart | -0.17 / 0.00 / 1.00 |
| sim-late-set-arc | -0.46 / 0.00 / 0.00 |
| sim-late-set-slowburn | -0.75 / – / 0.00 |
| sim-late-set-stopstart | 0.38 / 0.00 / 0.60 |
| sim-night-shift-arc | 0.19 / 0.00 / 0.60 |
| sim-night-shift-slowburn | -0.56 / – / 0.00 |
| sim-night-shift-stopstart | 0.44 / 0.00 / 1.00 |

Cells: follow / silent→drop / busy→lift.

