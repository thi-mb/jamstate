# Brain bake-off

2026-10-31T14:33Z · 9 sessions · measured from: an Apple M4 Max laptop, localhost

## Latency and validity (same questions)

| Brain | Model | Turns | Errors | p50 ms | p95 ms | max ms | Late (> 1 phrase) | Moves/turn | Rejected |
|---|---|---|---|---|---|---|---|---|---|
| Qwen | mlx-community/Qwen3-4B-Instruct-2507-4bit | 102 | 0 | 657 | 854 | 1509 | 0 | 0.00 | 102 |

## Move mix (same questions)

| Brain | set_intensity | add_layer | drop_layer | change_feel | fire_stinger | extend_section | jump_to_section | keep going |
|---|---|---|---|---|---|---|---|---|
| Qwen | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 102 |

## Following the player (closed loop)

Each brain drives its own replay. **follow**: correlation of the player's energy in a phrase with the band's intensity target one phrase later (1 = follows perfectly). **silent→drop**: after 2+ silent bars, the band is at or below 0.3 by the next turn. **busy→lift**: after a busy phrase, the band is at or above 0.6 by the next turn.

| Brain | follow | silent→drop | busy→lift | moves | errors |
|---|---|---|---|---|---|
| Qwen | 0.08 | 0.00 | 0.58 | 0 | 0 |

### Per session

| Session | Qwen |
|---|---|
| sim-blues-in-a-arc | 0.11 / 0.00 / 1.00 |
| sim-blues-in-a-slowburn | 0.59 / – / 1.00 |
| sim-blues-in-a-stopstart | -0.54 / 0.00 / 0.50 |
| sim-late-set-arc | 0.47 / 0.00 / 0.40 |
| sim-late-set-slowburn | 0.39 / – / 0.50 |
| sim-late-set-stopstart | 0.02 / 0.00 / 0.20 |
| sim-night-shift-arc | -0.28 / 0.00 / 0.60 |
| sim-night-shift-slowburn | 0.41 / – / 0.75 |
| sim-night-shift-stopstart | -0.44 / 0.00 / 0.25 |

Cells: follow / silent→drop / busy→lift.

