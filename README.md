# jamstate

An open-source AI backing band that follows a song's structure and reacts to
what you play. It borrows adaptive-music tricks from games (vertical
layering, horizontal resequencing, bar-quantized transitions, stingers) and
puts a language model in the bandleader's chair.

It runs in the browser: open the page, plug in a MIDI keyboard (or use the
computer keyboard), press Start and play. The band counts you in and plays
in the song's genre (funk, blues rock or jazz in v0.1): swung or straight,
with ghost notes, fills, moving bass lines and voice-led comping. Go sparse
and the band lays back into half time; dig in and it builds; stop and the
drums drop out; press **End song** and it finishes the phrase and ends.
Every decision shows on screen with its reason, and every jam is recorded
so it can be replayed.

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

## Static build, no server

`npm run build` writes a static, relative build to `web/dist`. Copy it to any
web host or folder and it plays with the rule bandleader, keeps your sessions
in the browser, and needs nothing else
([ADR-0015](docs/decisions/0015-no-server-required.md)). Web MIDI needs HTTPS
or localhost.

## Picking the bandleader's brain

Under **Bandleader**, pick a brain
([ADR-0016](docs/decisions/0016-brain-providers.md)). Keys are stored in this
browser only and sent only to that provider. **Test** asks it once.

| Brain | Needs | Notes |
|-------|-------|-------|
| Rules | nothing | the default and the fallback |
| OpenAI-compatible | an endpoint | Qwen on the Spark through the server's relay (`api/relay/llm`, the default), Ollama (`http://localhost:11434/v1`, with `OLLAMA_ORIGINS` set to the page's origin), or OpenAI |
| Claude | an Anthropic API key | called from the page; model `claude-opus-5-5` by default, editable |
| Jev | a TypeSafe API key, or the server's | TypeSafe blocks calls from web pages, so it goes through the jamstate server's relay (`api/relay/jev`) |

Only the LLM brains can write charts from a description (**Write**).

## With the jamstate server (optional companion)

```bash
# on the Spark: model server (see spark/README.md for the build, download and flags)
llama-server -m ~/models/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf --alias qwen3-30b-a3b \
  --host 127.0.0.1 --port 8080 -ngl 99 -c 8192 --parallel 1 --jinja

# companion server: serves web/dist, relays the page's brain calls to the model and to Jev
cd web && npm ci && npm run build && cd ..
pip install -e server
python -m jamstate_server --static web/dist --llm-url http://127.0.0.1:8080/v1 --model qwen3-30b-a3b --port 8765
```

Then pick **OpenAI-compatible** under Bandleader (the default endpoint,
`api/relay/llm`, goes through this server to the model). For Jev, set
`TYPESAFE_API_KEY` in the server's environment, or paste your key in the page. Web MIDI needs a secure
context, so from the laptop open the app on localhost through an SSH tunnel
(`ssh -L 8765:127.0.0.1:8765 <spark>`, then http://localhost:8765) or over
HTTPS (`tailscale serve`). The bandleader model is Qwen3-30B-A3B-Instruct-2507
([ADR-0011](docs/decisions/0011-bandleader-model.md): p95 about 0.85 s, 0.4
bars at 112 bpm). For development, run `npm run dev` on the laptop and point Vite at
the Spark's server with `JAMSTATE_API=http://<spark>:8765 npm run dev`.

If a brain is slow or down, the page falls back to the in-page rule leader
after three failures and switches back as soon as the brain answers again.

## Playing the band through a DAW

Set **MIDI out** to a port your DAW listens to and untick **built-in sound**.
Each part has its own channel on that port:

| Part | Channel | Notes |
|------|---------|-------|
| bass | 2 | low register, about G0–G1 in Ableton's names |
| chords | 3 | voicings per genre: funk stabs about C4–G5, jazz shells about D3–A#4, rock triads about G3–D5 |
| drums | 10 | General MIDI: kick 36, side stick 37, snare 38, clap 39, closed hat 42, pedal hat 44, open hat 46, toms 45/47/50, crash 49, ride 51, ride bell 53 |

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
 MIDI in / keys ─► player features (per bar) ─► summary/N bars ─► brain provider
                                                    │   (rules · OpenAI-compatible · Claude · Jev;
                                                    │    prompt + move checks in the page)
 rule leader (fallback) ─────────────────┐          ▼ moves (JSON)
                                         ▼
                           move governor (validate, TTL, dwell, deadband, quantize)
                                         ▼
 SLOW  arranger: form position, section, intensity, layers, feel, stingers
 MID   groove generators: next bar per part from the genre pack, committed a beat early,
       then swing + humanize
 FAST  scheduler on AudioContext.currentTime, 100 ms lookahead, Worker timer
          ├─► built-in Web Audio synth
          └─► Web MIDI out (DAW / hardware)
 overlay: section, bar, chord, intensity, layers, last move + reason
```

- **Fast layer** (`web/src/core/transport.ts`): plays committed bars on the
  audio clock. It never computes music.
- **Mid layer** (`web/src/core/groove.ts`, `feel.ts`): one generator per part
  role, reading its vocabulary from the genre pack (`genres/*.json`): step
  patterns per intensity level with variations, ghost notes, fills, ride or
  hat by section, bass degrees with approaches or a walking line, comping
  rhythms with voice-led voicings. Swing and humanize are applied after, seeded
  so a session replays note for note. Bar N+1 is committed at the start of bar
  N's last beat; a generator that misses the deadline repeats its previous bar.
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
| `end_song` | – | the end of the current phrase: ritardando, final hit on the next downbeat. The player's move only (button); the LLM can't end a song |

Each move carries a `reason` for the overlay. Moves older than 8 bars when
they arrive are dropped. All numbers live in `DEFAULT_GOVERNOR` in
`web/src/core/engine.ts`. The JSON schema is
[schema/moves.schema.json](schema/moves.schema.json).

### Charts

A chart is a song skeleton, never audio
([schema](schema/chart.schema.json), examples in `web/public/charts/`):

```json
{
  "version": "0.1", "title": "Night Shift", "bpm": 112, "time_sig": "4/4", "key": "F minor",
  "genre": "funk", "swing": 0.15, "count_in": 1,
  "sections": [
    { "name": "intro", "bars": 4, "chords": ["Fm", "Db", "Ab", "Eb"], "intensity": 0.3 },
    { "name": "outro", "bars": 4, "chords": ["Fm Eb", "Db C7", "Fm", "Fm"] }
  ],
  "form": ["intro", "outro"]
}
```

Chords cycle one per bar; an entry with a space splits the bar. `intensity`
is an optional per-section hint. `genre`, `swing` and `count_in` are
optional, and a section can set its own `swing` and `cymbal` (`hat` or
`ride`); see [ADR-0013](docs/decisions/0013-chart-format-v0.1.md). In the
page you can pick a bundled chart, load a JSON file, edit the JSON, or ask
the LLM to write one from a description, and switch the genre and swing
live.

### Genres

A genre pack (`genres/*.json`, [schema](schema/genre.schema.json),
[ADR-0012](docs/decisions/0012-genre-pack-format.md)) holds how the band
plays a style: drum, bass and comping patterns per intensity level, swing,
humanize, fills and the ending. v0.1 ships funk, blues rock and jazz. Every
file in the folder is picked up at build time, so a new genre is a new file.
`npm run dump -- public/charts/late-set.json jazz 8 0.7` prints what the band
plays, bar by bar.

### Sessions

Every jam is recorded: the chart, genre, seed, your notes, every move and
genre or swing switch, and a hash of what the band played in each bar
([ADR-0014](docs/decisions/0014-session-recording.md)). After you stop,
**Download** it or **Save to Spark** (`~/.local/share/jamstate/sessions`).
Open one under **Replay**: **Check** replays it offline and confirms every
bar plays the same; **Play** plays it back with your recorded notes. From
the command line:

```bash
cd web
npm run replay -- ~/.local/share/jamstate/sessions/<file>.json                 # exact replay, exit 1 on a mismatch
npm run replay -- <file>.json --leader rules                                    # same playing, rule leader decides again
npm run replay -- <file>.json --leader openai --url http://127.0.0.1:8080/v1   # or any brain: openai, claude, jev (keys from env)
npm run bakeoff -- <sessions dir> --brains rules,jev,openai --label spark       # the brain bake-off (docs/bakeoff/)
```

## Repository layout

| Path | What |
|------|------|
| `web/` | the browser app (TypeScript + Vite). Engine in `web/src/core/` is DOM-free and unit tested |
| `server/` | `jamstate_server`: optional Python stdlib companion (static app, brain relays `/api/relay/llm` and `/api/relay/jev`, session sync `/api/sessions`) |
| `genres/` | genre packs (funk, blues rock, jazz), read by the page and the server |
| `schema/` | JSON schemas for charts, genre packs and bandleader moves, shared by both sides |
| `spark/` | Spark setup: model serving, latency benchmark, HTTPS via Tailscale |
| `docs/` | architecture and decision records |

## Development

```bash
cd web
npm test            # engine, governor, groove generators, feel, sessions, rule leader, transport
npm run typecheck
npm run simulate    # headless run of the demo script, one line per bar
npm run simulate -- public/charts/blues-in-a.json "busy:12,silent:6,sparse:6"

cd ../server
pip install -e '.[test]'
pytest
```

## Status and roadmap

v0 (hands-on tested 2026-10-30, see [docs/testing/v0.md](docs/testing/v0.md)):
browser app, typed or LLM-written chart, drums, bass and chords, rule and LLM
bandleaders reacting to energy, built-in sound and Web MIDI out, overlay.

v0.1 Groove (this; hands-on test plan in [docs/testing/v0.1.md](docs/testing/v0.1.md)):
genre packs for funk, blues rock and jazz, swing and humanize, moving bass
lines and walking bass, ghost notes, fills and ride/hat by section, comping
with voice leading, count-in and endings, session recording and replay. The
built-in sounds are still placeholders; better sounds are v0.2. The plan for
the releases after this is in [docs/roadmap.md](docs/roadmap.md).

Not yet: Ableton Link (needs a local bridge, browsers can't do UDP), FluidSynth
or SoundFont sounds, motif-aware reactions. Later: audio → chart on the Spark
(Demucs, allin1, chord recognition), a generative mid layer under the same
commit deadline, Magenta RealTime audio mode, remote jams.

## License

Apache License 2.0. See [LICENSE](LICENSE).
