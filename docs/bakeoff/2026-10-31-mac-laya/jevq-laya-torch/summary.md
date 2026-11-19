# Brain bake-off

2026-10-31T14:27Z · 9 sessions · measured from: an Apple M4 Max laptop, localhost

## Latency and validity (same questions)

| Brain | Model | Turns | Errors | p50 ms | p95 ms | max ms | Late (> 1 phrase) | Moves/turn | Rejected |
|---|---|---|---|---|---|---|---|---|---|
| Laya (Jev's questions) | laya@torch | 102 | 0 | 78 | 84 | 157 | 0 | 1.82 | 0 |

## Move mix (same questions)

| Brain | set_intensity | add_layer | drop_layer | change_feel | fire_stinger | extend_section | jump_to_section | keep going |
|---|---|---|---|---|---|---|---|---|
| Laya (Jev's questions) | 84 | 0 | 0 | 0 | 0 | 16 | 86 | 0 |

## Following the player (closed loop)

Each brain drives its own replay. **follow**: correlation of the player's energy in a phrase with the band's intensity target one phrase later (1 = follows perfectly). **silent→drop**: after 2+ silent bars, the band is at or below 0.3 by the next turn. **busy→lift**: after a busy phrase, the band is at or above 0.6 by the next turn.

| Brain | follow | silent→drop | busy→lift | moves | errors |
|---|---|---|---|---|---|
| Laya (Jev's questions) | 0.38 | 0.00 | 0.61 | 137 | 0 |

### Per session

| Session | Laya (Jev's questions) |
|---|---|
| sim-blues-in-a-arc | 0.66 / 0.00 / 0.80 |
| sim-blues-in-a-slowburn | 0.14 / – / 0.25 |
| sim-blues-in-a-stopstart | -0.35 / 0.00 / 0.50 |
| sim-late-set-arc | 0.68 / 0.00 / 0.60 |
| sim-late-set-slowburn | 0.52 / – / 0.75 |
| sim-late-set-stopstart | 0.82 / 0.00 / 1.00 |
| sim-night-shift-arc | 0.42 / 0.00 / 0.60 |
| sim-night-shift-slowburn | 0.50 / – / 0.75 |
| sim-night-shift-stopstart | 0.00 / 0.00 / 0.25 |

Cells: follow / silent→drop / busy→lift.

