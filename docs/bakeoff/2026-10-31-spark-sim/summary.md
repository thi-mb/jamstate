# Brain bake-off

2026-10-31T13:48Z · 9 sessions · measured from: DGX Spark (Qwen local; Jev not run, no key in this shell)

## Latency and validity (same questions)

| Brain | Model | Turns | Errors | p50 ms | p95 ms | max ms | Late (> 1 phrase) | Moves/turn | Rejected |
|---|---|---|---|---|---|---|---|---|---|
| Rules | rules | 102 | 0 | 0 | 0 | 0 | 0 | 0.94 | 0 |
| Qwen | qwen3-30b-a3b | 102 | 0 | 787 | 1111 | 1360 | 0 | 1.04 | 2 |

## Move mix (same questions)

| Brain | set_intensity | add_layer | drop_layer | change_feel | fire_stinger | extend_section | jump_to_section | keep going |
|---|---|---|---|---|---|---|---|---|
| Rules | 54 | 9 | 9 | 12 | 12 | 0 | 0 | 44 |
| Qwen | 79 | 16 | 6 | 5 | 0 | 0 | 0 | 1 |

## Following the player (closed loop)

Each brain drives its own replay. **follow**: correlation of the player's energy in a phrase with the band's intensity target one phrase later (1 = follows perfectly). **silent→drop**: after 2+ silent bars, the band is at or below 0.3 by the next turn. **busy→lift**: after a busy phrase, the band is at or above 0.6 by the next turn.

| Brain | follow | silent→drop | busy→lift | moves | errors |
|---|---|---|---|---|---|
| Rules | 0.94 | 1.00 | 1.00 | 96 | 0 |
| Qwen | 0.14 | 0.00 | 0.51 | 100 | 0 |

### Per session

| Session | Rules | Qwen |
|---|---|---|
| sim-blues-in-a-arc | 0.96 / 1.00 / 1.00 | 0.11 / 0.00 / 1.00 |
| sim-blues-in-a-slowburn | 0.91 / – / 1.00 | 0.59 / – / 1.00 |
| sim-blues-in-a-stopstart | 0.98 / 1.00 / 1.00 | -0.54 / 0.00 / 0.50 |
| sim-late-set-arc | 0.97 / 1.00 / 1.00 | 0.47 / 0.00 / 0.40 |
| sim-late-set-slowburn | 0.91 / – / 1.00 | 0.39 / – / 0.50 |
| sim-late-set-stopstart | 0.98 / 1.00 / 1.00 | 0.02 / 0.00 / 0.20 |
| sim-night-shift-arc | 0.97 / 1.00 / 1.00 | 0.24 / 0.00 / 0.00 |
| sim-night-shift-slowburn | 0.87 / – / 1.00 | 0.41 / – / 0.75 |
| sim-night-shift-stopstart | 0.96 / 1.00 / 1.00 | -0.44 / 0.00 / 0.25 |

Cells: follow / silent→drop / busy→lift.

