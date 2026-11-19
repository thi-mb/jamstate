# jamstate architecture

jamstate is an AI backing band that follows a song's structure and reacts to
what you play. It borrows adaptive-music techniques from games (vertical
layering, horizontal resequencing, bar-quantized transitions, stingers) and
puts a language model in the role of bandleader.

This document describes the system as intended. Individual choices, and the
reasoning behind them, live in [decisions/](decisions/README.md). When the two
disagree, the decision record wins and this document should be fixed.

v0 runs in the browser ([ADR-0002](decisions/0002-browser-first.md)): open a
URL, plug in a MIDI keyboard (or use the computer keyboard), and play.

## Design principles

1. **The music never stutters.** Nothing slow (network, model inference, UI
   rendering) is allowed on the path that emits notes. AI output is advisory,
   and late output is dropped, not waited for.
2. **The player's machine owns time.** All scheduling happens locally against
   one clock. The bandleader brain (rules in the page, a local model, or a
   cloud API) is an advisor that can disappear without the band stopping.
   No server is required to play ([ADR-0015](decisions/0015-no-server-required.md)).
3. **Small, quantized moves.** Every change lands on a bar or phrase boundary
   and is drawn from a fixed move set, so the band sounds like a band making
   decisions rather than a model twitching.
4. **Explainable.** Every move carries a short human reason that the overlay
   shows. This is also the demo.
5. **Structure only.** A chart is a skeleton (tempo, key, sections, chords).
   The original recording is never played back.

## The three timescales

```
            browser (laptop)                                   brain (optional)
 ┌───────────────────────────────────────────────┐      ┌──────────────────────┐
 │                                               │      │                      │
 │ Web MIDI / keys ─► Player features ───┐       │      │                      │
 │                    (per bar)          │summary│      │                      │
 │                                       ▼ /N bars      │                      │
 │                              Bandleader client ─────►│ brain provider       │
 │   Rule-based leader ──┐               │ moves │ HTTP │  rules (in page),    │
 │                       │               │       │      │  Laya, Jev, Claude,  │
 │                       ▼               ▼       │      │  OpenAI, Qwen/Ollama │
 │                    Move governor              │      │ user picks; rules by │
 │              (validate, TTL, dwell, quantize) │      │ default, no server   │
 │                          │                    │      └──────────────────────┘
 │  SLOW  Arranger: form position, section,      │
 │        intensity, layers, feel, stingers      │
 │                          │                    │
 │  MID   Part generators: next bar per part     │
 │        from the genre pack, by commit deadline│
 │                          │ committed bars     │
 │  FAST  Scheduler (Web Audio clock, lookahead) │
 │           ├──► built-in synth / sampler       │
 │           └──► Web MIDI out (DAW, hardware)   │
 │                                               │
 │  Overlay: section, bar, intensity, last move + reason
 └───────────────────────────────────────────────┘
```

| Layer | Cadence | Runs where | Job | If it is late |
|-------|---------|------------|-----|---------------|
| Fast  | per event (ms) | browser, audio clock | Turn beat-stamped events into sound/MIDI at exact times | Must not be late. See [ADR-0003](decisions/0003-fast-layer-timing.md) |
| Mid   | per bar | browser | Produce the next bar per active part from chart + arranger state (+ player, v1) | Repeat or lightly vary the previous bar. See [ADR-0005](decisions/0005-bar-commit-deadline.md) |
| Slow  | every few bars | brain provider: rules in the page, a local model, or a cloud API | Read the player summary and propose moves | Arranger keeps its state; rule-based leader stands in. See [ADR-0006](decisions/0006-bandleader-latency-contract.md) |

## Components

### Chart
A JSON document: `bpm`, `time_sig`, `key`, named `sections` (bars + chord
list) and a `form` (sequence of section names). Loaded once and validated
against a schema. The arranger walks the form; `jump_to_section` and
`extend_section` change the walk, never the chart itself.

### Clock and scheduler (fast layer)
The Web Audio `AudioContext.currentTime` is the master clock. Musical time is
expressed in beats; the scheduler converts beats to audio-clock seconds with
the current tempo. A timer (ideally in a Worker, so a busy main thread cannot
starve it) wakes every ~25 ms and schedules everything due in the next
~100 ms. Sound is scheduled sample-accurately on the audio clock; Web MIDI
output is sent with timestamps mapped from the same clock. The scheduler never
computes music; it only plays what has been committed to it.
See [ADR-0003](decisions/0003-fast-layer-timing.md).

Ableton Link is not available in a browser. It returns later through a small
local bridge. See [ADR-0004](decisions/0004-ableton-link-deferred.md).

### Part generators (mid layer)
One generator per part role (drums, bass, chords), walking the genre's
lineup. Since v0.1 each reads its vocabulary from the song's genre pack
([ADR-0012](decisions/0012-genre-pack-format.md)): step patterns per
intensity level with seeded variations, ghost notes and fills for the drums,
bass degrees and approaches (or a walking line), comping rhythms with
voice-led voicings. Generators write on a straight grid; the engine then
applies the genre's swing and humanize (`feel.ts`), and a ritardando on an
ending bar. Each generator hands the scheduler bar N+1 before the commit
deadline of bar N. Missing it means the previous bar repeats.

### Arranger (slow-layer state)
Holds the state the generators read: position in the form, current section,
intensity (0–1), active layers, feel (normal / half time / double time) and
pending stingers. It changes only through moves, and only at boundaries.

### Move governor
Sits between every move source (the LLM, the rule-based leader, UI buttons)
and the arranger. It validates moves, drops expired ones, enforces dwell times
and hysteresis, and picks the boundary each move lands on. The LLM proposes;
the governor disposes. See [ADR-0007](decisions/0007-move-governor.md).

### Bandleader
A pluggable brain the player picks
([ADR-0016](decisions/0016-brain-providers.md)): the in-page rules, an
OpenAI-compatible model (Qwen or another local model through Ollama or llama.cpp), Claude, or a decision
model such as Jev or Laya. Every N bars it gets a compact summary (player features, arranger state, position in form,
recent moves) and returns zero or more moves as schema-constrained JSON. It is
called asynchronously and never awaited by the music. A deterministic
rule-based leader implements the same interface, runs in the page, and is
used offline, in tests, and as the fallback.

### Player features
From the keyboard, per bar: note density, mean velocity, pitch register, rest
ratio, and motif repetition. Rolled up into a summary every N bars. v0 uses
density and energy only.

### Output
A built-in synth/sampler in the page so it works with nothing installed, plus
optional Web MIDI out to a DAW or hardware. Both are fed by the scheduler.

### Overlay
Part of the page: section, bar, intensity, active layers, and the last move
with its reason. It reads arranger state and never writes it, except through
the governor (manual move buttons for testing).

## Moves (v0)

| Move | Args | Lands on |
|------|------|----------|
| `set_intensity` | 0–1 | next bar (smoothed) |
| `add_layer` / `drop_layer` | part | next phrase |
| `jump_to_section` | name | next phrase |
| `extend_section` | bars (1–16) | before current section ends |
| `change_feel` | normal \| half_time \| double_time | next phrase |
| `fire_stinger` | fill \| crash \| riser | fill: last bar of phrase; crash: next downbeat; riser: ends on next phrase |

Every move carries `reason` (short string for the overlay). The governor
stamps it with `issued_at_beat` and a TTL.

## Where things run

One TypeScript core runs inside thin shells
([ADR-0017](decisions/0017-one-core-thin-shells.md)). The web page is the
first shell; a desktop app may follow. MIDI, audio input, storage and the
model runtime sit behind small platform interfaces that each shell fills in.

The page runs alone as a static build
([ADR-0015](decisions/0015-no-server-required.md)). Prompt building, move
checking and session storage live in the page. API keys stay on the
player's machine. The page treats every brain as unreliable: short timeouts,
automatic switch to the rule-based leader, automatic recovery.

A GPU machine is optional. Whoever has one can use it as a lab: an eval
bench that replays recorded sessions through each brain, offline jobs (stems,
audio to chart), generative audio R&D, and one more brain host (a local LLM).
The Python server in `server/` stays as an optional companion (static
hosting, session sync, a proxy for providers that block browser calls).

Where the code is (v0.1.1): brains in `web/src/core/brain/` (one file per
provider, the shared prompt and checks, and `BrainLeader`, the timeout and
fallback wrapper); platform interfaces in `web/src/core/platform.ts` with the
web versions in `web/src/platform/web.ts`; the companion's relays in
`server/jamstate_server/app.py`. The brain bake-off is `npm run bakeoff`
(results in [bakeoff/](bakeoff/)).

## Roadmap view

The release plan after v0 is in [roadmap.md](roadmap.md); the list below is
the original long-range view, kept for history. Where it puts work on a
GPU host (the DGX Spark at the time), ADR-0015 now makes that host optional.

- **v0**: browser app; typed chart; loop bank; drums, bass, chords; LLM leader
  on energy/density; built-in sound + Web MIDI out; overlay in the page.
- **v1**: Ableton Link via a local bridge; audio → chart on a GPU host
  (Demucs, allin1, chord recognition); generative mid layer on a GPU host under
  the same commit-deadline contract.
- **v2**: audio mode with Magenta RealTime, gated on a spike
  ([ADR-0009](decisions/0009-magenta-realtime-spike.md)).
- **Later**: Max for Live device, audio input, remote mode where only human
  parts cross the network and each player runs the band locally.

## Further reading

- [bandleader.md](bandleader.md): request/response contract for the bandleader.
- [../deploy/README.md](../deploy/README.md): self-hosting the server and a local model (Docker, Ollama, llama.cpp), HTTPS, and the latency benchmark.
