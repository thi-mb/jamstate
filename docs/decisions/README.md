# Decision records

Short records of architectural decisions: what we chose, why, and what we gave
up. One file per decision, numbered in order. A decision is never edited to
say something else; it is superseded by a new record that links back.

Status values: **Proposed** (recommended, waiting on Thiago), **Accepted**,
**Superseded by NNNN**, **Rejected**.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-three-timescales.md) | Three timescales; the fast layer never waits on AI | Accepted |
| [0002](0002-browser-first.md) | v0 runs in the browser, engine in TypeScript | Accepted |
| [0003](0003-fast-layer-timing.md) | Web Audio lookahead scheduler | Proposed |
| [0004](0004-ableton-link-deferred.md) | Defer Ableton Link to a local bridge | Proposed |
| [0005](0005-bar-commit-deadline.md) | Mid layer commits bar N+1 by a fixed point in bar N | Proposed |
| [0006](0006-bandleader-latency-contract.md) | Bandleader moves are async, expire, and land on phrases | Proposed |
| [0007](0007-move-governor.md) | A deterministic governor between leader and arranger | Proposed |
| [0008](0008-spark-as-stateless-advisor.md) | The Spark hosts the server and models; it never owns time | Proposed |
| [0009](0009-magenta-realtime-spike.md) | Magenta RealTime is a timeboxed spike, not v0 | Proposed |
| [0010](0010-chart-format-v0.md) | Chart format v0 | Accepted |
| [0011](0011-bandleader-model.md) | Bandleader model: small-active MoE on llama.cpp | Accepted |

New record: copy [template.md](template.md).
