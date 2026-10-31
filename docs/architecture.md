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
   one clock. The DGX Spark is a stateless advisor that can disappear without
   the band stopping.
3. **Small, quantized moves.** Every change lands on a bar or phrase boundary
   and is drawn from a fixed move set, so the band sounds like a band making
   decisions rather than a model twitching.
4. **Explainable.** Every move carries a short human reason that the overlay
   shows. This is also the demo.
5. **Structure only.** A chart is a skeleton (tempo, key, sections, chords).
   The original recording is never played back.

## The three timescales

```
            browser (laptop)                                   DGX Spark
 ┌───────────────────────────────────────────────┐      ┌──────────────────────┐
 │                                               │      │                      │
 │ Web MIDI / keys ─► Player features ───┐       │      │                      │
 │                    (per bar)          │summary│      │                      │
 │                                       ▼ /N bars      │                      │
 │                              Bandleader client ─────►│ app server + proxy   │
 │   Rule-based leader ──┐               │ moves │ HTTP │  ──► LLM (llama.cpp, │
 │                       │               │       │      │       vLLM)          │
 │                       ▼               ▼       │      │                      │
 │                    Move governor              │      │ v1: symbolic model   │
 │              (validate, TTL, dwell, quantize) │      │ (next 1–2 bars)      │
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
| Mid   | per bar | browser (v0), Spark (v1) | Produce the next bar per active part from chart + arranger state (+ player, v1) | Repeat or lightly vary the previous bar. See [ADR-0005](decisions/0005-bar-commit-deadline.md) |
| Slow  | every few bars | Spark | Read the player summary and propose moves | Arranger keeps its state; rule-based leader stands in. See [ADR-0006](decisions/0006-bandleader-latency-contract.md) |

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
An LLM served by an OpenAI-compatible server on the Spark. Every N bars it
gets a compact summary (player features, arranger state, position in form,
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

## Laptop ↔ Spark

The DGX Spark is the host. It serves the web app (over HTTPS on the tailnet,
since Web MIDI needs a secure context), runs a small Python API, and runs the
LLM behind an OpenAI-compatible server. The API proxies leader requests to the
model so the browser never talks to the model server directly. v1 workloads
(audio → chart, generative mid layer) also run there.

Once the page has loaded, all timing lives in the browser. The page treats the
Spark as unreliable: short timeouts, automatic switch to the rule-based
leader, automatic recovery. For offline development the same server runs on
the laptop. See [ADR-0008](decisions/0008-spark-as-stateless-advisor.md).

## Roadmap view

The release plan after v0 is in [roadmap.md](roadmap.md); the list below is
the original long-range view.

- **v0**: browser app; typed chart; loop bank; drums, bass, chords; LLM leader
  on energy/density; built-in sound + Web MIDI out; overlay in the page.
- **v1**: Ableton Link via a local bridge; audio → chart on the Spark
  (Demucs, allin1, chord recognition); generative mid layer on the Spark under
  the same commit-deadline contract.
- **v2**: audio mode with Magenta RealTime, gated on a spike
  ([ADR-0009](decisions/0009-magenta-realtime-spike.md)).
- **Later**: Max for Live device, audio input, remote mode where only human
  parts cross the network and each player runs the band locally.

## Further reading

- [bandleader.md](bandleader.md): request/response contract for the bandleader.
- [../spark/README.md](../spark/README.md): running the server and model on the Spark, HTTPS, and the latency benchmark.
