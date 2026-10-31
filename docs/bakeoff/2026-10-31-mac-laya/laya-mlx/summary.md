# Brain bake-off

2026-10-31T14:26Z · 9 sessions · measured from: Thiago's MacBook Pro (M4 Max), localhost

## Latency and validity (same questions)

| Brain | Model | Turns | Errors | p50 ms | p95 ms | max ms | Late (> 1 phrase) | Moves/turn | Rejected |
|---|---|---|---|---|---|---|---|---|---|
| Laya | laya@mlx | 102 | 0 | 21 | 22 | 44 | 0 | 1.07 | 0 |

## Move mix (same questions)

| Brain | set_intensity | add_layer | drop_layer | change_feel | fire_stinger | extend_section | jump_to_section | keep going |
|---|---|---|---|---|---|---|---|---|
| Laya | 74 | 9 | 26 | 0 | 0 | 0 | 0 | 18 |

## Following the player (closed loop)

Each brain drives its own replay. **follow**: correlation of the player's energy in a phrase with the band's intensity target one phrase later (1 = follows perfectly). **silent→drop**: after 2+ silent bars, the band is at or below 0.3 by the next turn. **busy→lift**: after a busy phrase, the band is at or above 0.6 by the next turn.

| Brain | follow | silent→drop | busy→lift | moves | errors |
|---|---|---|---|---|---|
| Laya | 0.96 | 1.00 | 1.00 | 92 | 0 |

### Per session

| Session | Laya |
|---|---|
| sim-blues-in-a-arc | 0.97 / 1.00 / 1.00 |
| sim-blues-in-a-slowburn | 0.96 / – / 1.00 |
| sim-blues-in-a-stopstart | 0.99 / 1.00 / 1.00 |
| sim-late-set-arc | 0.97 / 1.00 / 1.00 |
| sim-late-set-slowburn | 0.98 / – / 1.00 |
| sim-late-set-stopstart | 0.95 / 1.00 / 1.00 |
| sim-night-shift-arc | 0.98 / 1.00 / 1.00 |
| sim-night-shift-slowburn | 0.90 / – / 1.00 |
| sim-night-shift-stopstart | 0.97 / 1.00 / 1.00 |

Cells: follow / silent→drop / busy→lift.

