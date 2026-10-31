# Brain bake-off

2026-10-31T13:49Z · 9 sessions · measured from: claude.ai cloud container (US East), direct to providers

## Latency and validity (same questions)

| Brain | Model | Turns | Errors | p50 ms | p95 ms | max ms | Late (> 1 phrase) | Moves/turn | Rejected |
|---|---|---|---|---|---|---|---|---|---|
| Rules | rules | 102 | 0 | 0 | 0 | 1 | 0 | 0.94 | 0 |
| Jev | jev-1.14.0 | 102 | 0 | 89 | 134 | 190 | 0 | 0.88 | 0 |
| Claude claude-opus-5-5 | claude-opus-5-5 | 102 | 0 | 1969 | 3274 | 3916 | 0 | 0.87 | 1 |

## Move mix (same questions)

| Brain | set_intensity | add_layer | drop_layer | change_feel | fire_stinger | extend_section | jump_to_section | keep going |
|---|---|---|---|---|---|---|---|---|
| Rules | 54 | 9 | 9 | 12 | 12 | 0 | 0 | 44 |
| Jev | 74 | 6 | 9 | 0 | 1 | 0 | 0 | 28 |
| Claude claude-opus-5-5 | 48 | 6 | 9 | 5 | 21 | 0 | 0 | 46 |

## Following the player (closed loop)

Each brain drives its own replay. **follow**: correlation of the player's energy in a phrase with the band's intensity target one phrase later (1 = follows perfectly). **silent→drop**: after 2+ silent bars, the band is at or below 0.3 by the next turn. **busy→lift**: after a busy phrase, the band is at or above 0.6 by the next turn.

| Brain | follow | silent→drop | busy→lift | moves | errors |
|---|---|---|---|---|---|
| Rules | 0.94 | 1.00 | 1.00 | 96 | 0 |
| Jev | 0.96 | 1.00 | 1.00 | 71 | 0 |
| Claude claude-opus-5-5 | 0.81 | 0.00 | 0.95 | 109 | 0 |

### Per session

| Session | Rules | Jev | Claude claude-opus-5-5 |
|---|---|---|---|
| sim-blues-in-a-arc | 0.96 / 1.00 / 1.00 | 0.96 / 1.00 / 1.00 | 0.87 / 0.00 / 1.00 |
| sim-blues-in-a-slowburn | 0.91 / – / 1.00 | 0.96 / – / 1.00 | 0.82 / – / 1.00 |
| sim-blues-in-a-stopstart | 0.98 / 1.00 / 1.00 | 0.99 / 1.00 / 1.00 | 0.93 / 0.00 / 1.00 |
| sim-late-set-arc | 0.97 / 1.00 / 1.00 | 0.96 / 1.00 / 1.00 | 0.85 / 0.00 / 1.00 |
| sim-late-set-slowburn | 0.91 / – / 1.00 | 0.97 / – / 1.00 | 0.83 / – / 1.00 |
| sim-late-set-stopstart | 0.98 / 1.00 / 1.00 | 0.95 / 1.00 / 1.00 | 0.70 / 0.00 / 0.80 |
| sim-night-shift-arc | 0.97 / 1.00 / 1.00 | 0.98 / 1.00 / 1.00 | 0.80 / 0.00 / 1.00 |
| sim-night-shift-slowburn | 0.87 / – / 1.00 | 0.90 / – / 1.00 | 0.74 / – / 0.75 |
| sim-night-shift-stopstart | 0.96 / 1.00 / 1.00 | 0.97 / 1.00 / 1.00 | 0.79 / 0.00 / 1.00 |

Cells: follow / silent→drop / busy→lift.

