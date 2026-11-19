# Decision records

Short records of architectural decisions: what we chose, why, and what we gave
up. One file per decision, numbered in order. A decision is never edited to
say something else; it is superseded by a new record that links back.

Status values: **Proposed** (recommended, not yet decided), **Accepted**,
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
| [0008](0008-spark-as-stateless-advisor.md) | The Spark hosts the server and models; it never owns time | Superseded by 0015 |
| [0009](0009-magenta-realtime-spike.md) | Magenta RealTime is a timeboxed spike, not v0 | Proposed |
| [0010](0010-chart-format-v0.md) | Chart format v0 | Superseded by 0013 (additively) |
| [0011](0011-bandleader-model.md) | Bandleader model: small-active MoE on llama.cpp | Accepted |
| [0012](0012-genre-pack-format.md) | Genre pack format (composition layer) | Proposed |
| [0013](0013-chart-format-v0.1.md) | Chart format v0.1: genre, swing, count-in | Accepted |
| [0014](0014-session-recording.md) | Session recording and replay | Proposed |
| [0015](0015-no-server-required.md) | jamstate runs without a server; the Spark is optional | Accepted |
| [0016](0016-brain-providers.md) | The bandleader is a pluggable brain the player picks | Accepted |
| [0017](0017-one-core-thin-shells.md) | One core, thin shells: web now, desktop app when tests say so | Accepted |
| [0018](0018-lineups-and-sound.md) | Lineups and the built-in sound: rendered samples, mix bus, band as data | Accepted |
| [0019](0019-listening-layer.md) | The listening layer: five switchable groups, one summary for every brain | Accepted |
| [0020](0020-cues-and-lockout.md) | Player cues on keys 1–7, with a governor lockout | Accepted |
| [0021](0021-leading-layer.md) | The leading layer: genre taste, personality and the song arc | Accepted |
| [0022](0022-trading-fours.md) | Trading fours: a mode, the player's phrase, a band soloist | Accepted |
| [0023](0023-audio-input.md) | Audio input: the guitar becomes notes | Proposed |
| [0024](0024-chord-detection.md) | Chord detection: chroma templates first, Basic Pitch measured beside it | Proposed |
| [0025](0025-bleed-gating.md) | Bleed gating: the band's own output as the reference | Proposed |
| [0026](0026-voice-cues.md) | Voice cues: a small grammar recogniser in the page | Proposed |

New record: copy [template.md](template.md).
