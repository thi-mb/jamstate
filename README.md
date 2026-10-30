# houseband

An open-source AI backing band that follows a song's structure and reacts to
what you play. It borrows adaptive-music tricks from games (vertical
layering, horizontal resequencing, bar-quantized transitions, stingers) and
puts a language model in the bandleader's chair.

v0 runs in the browser: open the page, plug in a MIDI keyboard (or use the
computer keyboard), press Start and play. Go sparse and the band lays back
into half time; dig in and it builds; stop and the drums drop out. Every
decision shows on screen with its reason.

The DGX Spark is the host: it serves the app and runs the LLM bandleader.
All timing stays in the browser, so a slow or missing model never makes the
music stutter.

## Quick start (laptop only, no LLM)

```bash
cd web
npm install
npm run dev
```

Open http://localhost:5173 in Chrome, press **Start**. No keyboard handy? Set
**Pretend player** to *demo script* and watch the band react to a scripted
player going sparse → busy → silent.

Computer keys: `A`–`'` are white keys, `W E T Y U O P` black keys, `Z`/`X`
change octave, hold `Shift` to play loud (energy is velocity plus density).

## With the LLM bandleader on the Spark

```bash
# on the Spark: model server (see spark/README.md for the build, download and flags)
llama-server -m ~/models/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf --alias qwen3-30b-a3b \
  --host 127.0.0.1 --port 8080 -ngl 99 -c 8192 --parallel 1 --jinja

# app server: serves web/dist and proxies /api/leader to the model
cd web && npm ci && npm run build && cd ..
pip install -e server
python -m houseband_server --static web/dist --llm-url http://127.0.0.1:8080/v1 --model qwen3-30b-a3b --port 8765
```

Then pick **LLM on the Spark** under Bandleader. Web MIDI needs a secure
context, so from the laptop open the app on localhost through an SSH tunnel
(`ssh -L 8765:127.0.0.1:8765 <spark>`, then http://localhost:8765) or over
HTTPS (`tailscale serve`). The bandleader model is Qwen3-30B-A3B-Instruct-2507
([ADR-0011](docs/decisions/0011-bandleader-model.md): p95 about 0.85 s, 0.4
bars at 112 bpm). For development, run `npm run dev` on the laptop and point Vite at
the Spark's server with `HOUSEBAND_API=http://<spark>:8765 npm run dev`.

If the model is slow or down, the page falls back to the in-page rule leader
after three failures and switches back as soon as the LLM answers again.

## Playing the band through a DAW

Set **MIDI out** to a port your DAW listens to and untick **built-in sound**.
Each part has its own channel on that port:

| Part | Channel | Notes |
|------|---------|-------|
| bass | 2 | low register, about G0–G1 in Ableton's names |
| chords | 3 | block chords, about E2–G4 |
| drums | 10 | General MIDI: kick 36, side stick 37, snare 38, closed hat 42, open hat 46, toms 45/47/50, crash 49 |

Ableton's Drum Rack kits use the General MIDI layout, with the kick on C1.
Your own playing isn't sent to MIDI out.

On macOS, the IAC bus is the easiest port. Open **Audio MIDI Setup**, then
**Window → Show MIDI Studio**, double-click **IAC Driver** and tick **Device
is online**. Quit and reopen Chrome so it sees the new port. In Ableton, turn
on **Track** for the IAC input under Settings → Link, Tempo & MIDI. Then make
three MIDI tracks with MIDI From set to the IAC bus, on channels 2, 3 and 10,
with Monitor set to In. A loopback port echoes the band back in, so with MIDI
in on "all inputs" the page skips any input named like the selected MIDI out.

## How it works

```
 browser                                                         DGX Spark
 ──────────────────────────────────────────────────────────      ─────────────────────
 MIDI in / keys ─► player features (per bar) ─► summary/N bars ─► /api/leader ─► LLM
                                                    │                 (houseband_server)
 rule leader (fallback) ─────────────────┐          ▼ moves (JSON)
                                         ▼
                           move governor (validate, TTL, dwell, deadband, quantize)
                                         ▼
 SLOW  arranger: form position, section, intensity, layers, feel, stingers
 MID   loop bank: next bar per part (drums, bass, chords), committed a beat early
 FAST  scheduler on AudioContext.currentTime, 100 ms lookahead, Worker timer
          ├─► built-in Web Audio synth
          └─► Web MIDI out (DAW / hardware)
 overlay: section, bar, chord, intensity, layers, last move + reason
```

- **Fast layer** (`web/src/core/transport.ts`): plays committed bars on the
  audio clock. It never computes music.
- **Mid layer** (`web/src/core/bank.ts`): four intensity layers per part and
  three feels (normal, half time, double time), voiced to the chart's chords.
  Bar N+1 is committed at the start of bar N's last beat; a generator that
  misses the deadline repeats its previous bar.
- **Slow layer** (`web/src/core/engine.ts`, `rules.ts`, `web/src/leader/`):
  the bandleader proposes moves every few bars; the governor decides if and
  when they land.

Design notes and decision records: [docs/architecture.md](docs/architecture.md)
and [docs/decisions/](docs/decisions/README.md).

### Moves

| Move | Argument | Lands on |
|------|----------|----------|
| `set_intensity` | 0–1 | eased over the next bars, max 0.2 per bar |
| `add_layer` / `drop_layer` | drums, bass, chords | next bar (2-bar dwell per part) |
| `jump_to_section` | section name | next phrase boundary, after 4 bars in the section |
| `extend_section` | 1–16 bars | current section (capped at its length) |
| `change_feel` | normal, half_time, double_time | next bar (4-bar dwell) |
| `fire_stinger` | fill, crash, riser | next bar (one per phrase) |

Each move carries a `reason` for the overlay. Moves older than 8 bars when
they arrive are dropped. All numbers live in `DEFAULT_GOVERNOR` in
`web/src/core/engine.ts`. The JSON schema is
[schema/moves.schema.json](schema/moves.schema.json).

### Charts

A chart is a song skeleton, never audio
([schema](schema/chart.schema.json), examples in `web/public/charts/`):

```json
{
  "title": "Night Shift", "bpm": 112, "time_sig": "4/4", "key": "F minor",
  "sections": [
    { "name": "intro", "bars": 4, "chords": ["Fm", "Db", "Ab", "Eb"], "intensity": 0.3 },
    { "name": "outro", "bars": 4, "chords": ["Fm Eb", "Db C7", "Fm", "Fm"] }
  ],
  "form": ["intro", "outro"]
}
```

Chords cycle one per bar; an entry with a space splits the bar. `intensity`
is an optional per-section hint. In the page you can pick a bundled chart,
load a JSON file, edit the JSON, or ask the LLM to write one from a
description.

## Repository layout

| Path | What |
|------|------|
| `web/` | the browser app (TypeScript + Vite). Engine in `web/src/core/` is DOM-free and unit tested |
| `server/` | `houseband_server`: Python stdlib server for the Spark (static app + `/api/leader`, `/api/chart`) |
| `schema/` | JSON schemas for charts and bandleader moves, shared by both sides |
| `spark/` | Spark setup: model serving, latency benchmark, HTTPS via Tailscale |
| `docs/` | architecture and decision records |

## Development

```bash
cd web
npm test            # engine, governor, features, rule leader, transport
npm run typecheck
npm run simulate    # headless run of the demo script, one line per bar
npm run simulate -- public/charts/blues-in-a.json "busy:12,silent:6,sparse:6"

cd ../server
pip install -e '.[test]'
pytest
```

## Status and roadmap

v0 (this, hands-on tested 2026-10-30, see [docs/testing/v0.md](docs/testing/v0.md)):
browser app, typed or LLM-written chart, loop bank for drums, bass and chords,
rule and LLM bandleaders reacting to energy, built-in sound and Web MIDI out,
overlay. The built-in sounds are placeholders: they work but don't sound like
real instruments yet.

Not yet: Ableton Link (needs a local bridge, browsers can't do UDP), FluidSynth
or SoundFont sounds, motif-aware reactions. Later: audio → chart on the Spark
(Demucs, allin1, chord recognition), a generative mid layer under the same
commit deadline, Magenta RealTime audio mode, remote jams.

## License

Apache License 2.0. See [LICENSE](LICENSE).
