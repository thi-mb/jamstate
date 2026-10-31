# Roadmap

What comes after v0, as a sequence of small releases. Each one has a goal you
can hear or see, a scope, and a "done when" list written like the v0 test
plan ([testing/v0.md](testing/v0.md)), so a release is finished when Thiago's
hands-on test passes, not when the code merges.

Status: **draft**, for discussion with Thiago (2026-10-30). The order is the
main open question; see [Open questions](#open-questions).

## Where v0 left us

v0 is done and tested (11 of 12 pass). The open items it handed over:

- The instruments sound like simple digital synths (test 10, parked).
- The band plays straight and on the grid. Bass is quarter or eighth notes on
  the root, with one approach note into the next chord.
- Qwen follows the player only loosely; sparse playing gets mixed moves.
- Ableton Link ([ADR-0004](decisions/0004-ableton-link-deferred.md)) was
  never tested.
- The leader only sees energy, density, trend and silence. It can't hear
  harmony, phrasing, or a request from the player.
- Input is MIDI or the computer keyboard only.
- Charts are typed as JSON.

## Releases at a glance

| Release | Theme | You'll notice | Mostly in |
|---------|-------|---------------|-----------|
| **v0.1** | Groove | The band swings and breathes instead of playing on the grid | browser (`web/src/core`) |
| **v0.2** | Sound and lineup | Better built-in instruments, more of them, and you pick who plays on each song | browser (`web/src/audio`, `web/src/core`) |
| **v0.3** | Listening | The band reacts to *how* you play, and to cues you give it | browser features + Qwen on the Spark |
| **v0.4** | Guitar | Plug in a guitar (or any instrument with a mic) instead of MIDI | browser (AudioWorklet), Spark optional |
| **v0.5** | Song creator | Make a song from a sentence, a form editor, or a recording | Spark (LLM, audio analysis) + browser editor |
| **v0.6** | Stage | A UI you'd play from and record a demo with | browser |
| **v1.0** | Public | Repo goes public with a demo video | docs, packaging |

"Better UI" is spread across the releases (each one ships the screens it
needs) and gets its own pass in v0.6. Link and the generative mid layer are
under [Later](#later).

## v0.1: Groove

**Goal:** the band plays like people, not a sequencer. It's all engine
work, which is where the attention is. How the instruments *sound* is v0.2.

Scope:
- **Feel parameters in the chart and arranger:** `swing` (0 = straight,
  0.66 = triplet swing) and a groove style per section (e.g. `rock`,
  `funk`, `shuffle`, `ballad`). Chart format v0.1, superseding
  [ADR-0010](decisions/0010-chart-format-v0.md) additively.
- **Humanize in the fast layer:** per-part micro-timing (bass slightly
  behind, hats ahead or behind by style), velocity variation, accent
  patterns. Deterministic from a seed so tests and replays stay stable.
- **Bass lines that move:** a bass generator with a vocabulary per style and
  intensity: root-fifth, octaves, chromatic and scale approaches, walking
  lines over long chords, rests and anticipations (pushes into the next bar),
  ghost notes and dead notes at higher intensity. Picks from it per bar with
  a little variation so a 16-bar verse doesn't loop the same bar.
- **Drums:** ghost notes, open-hat lifts, fills that vary by section and
  intensity, ride vs hat by section.
- **Chords:** comping rhythms per style instead of block chords on the beat,
  voice leading between chords.
Done when:
- Through MIDI out to Ableton (so the synth isn't judged), the band sounds
  like players.
- Swing at 0 and 0.66 are clearly different; the bass doesn't sound like all
  quarter or all eighth notes over a 16-bar section.
- Unit tests pin the generators (seeded) and the timing offsets stay inside
  the commit deadline ([ADR-0005](decisions/0005-bar-commit-deadline.md)).
- v0 tests 1–9 still pass.

## v0.2: Sound and lineup

**Goal:** the built-in band sounds good with nothing installed, has more
instruments, and each song says which instruments play.

Scope:
- **Better built-in instruments (test 10):** move from the simple synths to
  sampled instruments (SoundFont/SFZ or a small CC0/CC-BY sample set) with
  velocity layers, round robins for drums, release tails, and a light mix
  bus (per-part EQ, compression, a shared reverb). Loaded lazily, with the
  current synth as the fallback while samples load or if they fail.
- **More instruments:** several patches per existing part (bass: electric,
  upright, synth; keys: piano, electric piano, organ; drums: kit, brushes,
  electronic) and new parts with their own generators: rhythm guitar
  comping, pad/strings, and percussion (shaker, congas). Each new part gets
  the same intensity layers and feels as the v0 parts, and the v0.1 groove
  work.
- **Choose who plays on the track:** a `band` (lineup) field in the chart:
  which parts play and with which instrument, plus per-part volume and pan.
  A lineup picker in the page to change it live. Chart format change,
  additive like v0.1's. The leader's `add_layer`/`drop_layer` work on
  whatever parts the lineup has, and MIDI out gets one channel per part.
- Sample sizes and licenses are written down in `docs/` before any sample
  set is added; samples are served from the Spark and cached by the browser.

Done when:
- Thiago's 30-second recording through the built-in sound is something he'd
  post (re-run test 10).
- He can pick, say, upright bass + brushes + piano for one song and electric
  bass + kit + organ + guitar for another, and switch a part's instrument
  while the band plays without a click or a dropped bar.
- First load stays reasonable (target under ~10 MB of samples for the
  default lineup) and the page plays on the synth until they arrive.

## v0.3: Listening

**Goal:** the leader responds to more than loud/soft and busy/sparse, and its
choices are measured, not eyeballed. This is where the Qwen tuning lands.

Scope:
- **Session recording and replay:** record the player's input (MIDI events
  with beat stamps) plus the band's state per bar to a file; replay a
  recording through the engine and any leader offline. This is the base for
  everything else in this release and for testing guitar input in v0.4.
- **Leader eval harness on the Spark:** a set of recorded or scripted
  situations ("goes sparse for 8 bars", "builds to the chorus", "stops"),
  each with the moves a good bandleader would or wouldn't make. Score Qwen
  and the rule leader on them; track the score in CI-style runs on the Spark
  next to `spark/bench_leader.py`.
- **Prompt and policy tuning for Qwen** against that score, so sparse
  playing gets consistent moves.
- **More signals to the conductor** (added to the summary in
  [bandleader.md](bandleader.md)):
  - Rhythm: on-beat vs syncopated, swing ratio the player is using, note
    onsets vs the band's grid (pushing / laying back).
  - Harmony: how well the player's notes fit the current chord and key
    (inside / colour / outside), so "playing outside" can mean "build" or
    "leave room".
  - Phrasing: phrase start/end detection, call-and-response gaps, held
    notes, a soloist "taking a chorus".
  - Dynamics: crescendo/decrescendo inside the phrase, not just per-phrase
    trend.
  - Song position: bars to the next section and what it is, so the leader
    can set up a chorus.
- **Explicit cues from the player:** sustain pedal, a footswitch or a mapped
  MIDI CC / pad (e.g. "next section", "break", "build", "end the song"),
  and keyboard shortcuts. Cues go through the governor like any move, with
  priority over the LLM.

Done when:
- A replayed session gives the same band output twice (determinism).
- Qwen beats the rule leader on the eval set and its sparse-playing score is
  above a bar Thiago agrees on; p95 latency still inside
  [ADR-0006](decisions/0006-bandleader-latency-contract.md) with the bigger
  summary.
- A footswitch or pad cue lands on the next phrase.
- Hands-on: Thiago plays a call-and-response and a build into a chorus and
  the band follows.

## v0.4: Guitar

**Goal:** play a guitar (or voice, sax, anything with a mic or audio
interface) and the band follows, with no MIDI pickup.

Approach: the leader works on per-bar features, not on single notes, so audio
input doesn't need low-latency pitch tracking to be useful. Build it in
layers, each usable on its own:

1. **Audio in + energy/density:** `getUserMedia` (echo cancellation, noise
   suppression and AGC off), an AudioWorklet doing onset detection and RMS.
   That already drives the v0 features (energy, density, rest ratio,
   silence). Input-gain calibration screen.
2. **Pitch:** monophonic pitch (YIN or similar) in the worklet for register,
   lines and harmony fit. Good for single-note guitar, bass, voice, horns.
3. **Chords:** polyphonic transcription for strummed guitar. Try a small
   model in the browser first (e.g. Basic Pitch on WebGPU/WASM); if it's too
   heavy, stream features to the Spark per bar. It's per-bar and advisory, so
   the Spark's round trip is fine here.
4. **Bleed:** with speakers, the mic hears the band. Headphones are the
   default; subtract or gate the band's own output as a stretch goal (the
   audio version of the IAC loopback fix).

Done when:
- Guitar through an audio interface into Chrome drives the band like the MIDI
  keyboard does in v0 tests 2, 4 and 5.
- A recorded audio session can be replayed (v0.3's replay, audio flavour).
- Measured input latency is shown and doesn't matter for the moves (they land
  on phrases anyway).

## v0.5: Song creator

**Goal:** make a new song to jam over in a minute, without writing JSON.

Scope, in order of value:
- **Form and chord editor in the page:** sections, bars, chords per bar,
  form order, tempo, key, feel and swing (from v0.1), the lineup (from v0.2),
  with live validation
  against `schema/chart.schema.json`. Save charts on the Spark and list them.
- **Text to chart on the Spark:** "slow 12/8 blues in G, two verses and a
  solo" → a valid chart via Qwen with schema-constrained output, then opened
  in the editor to tweak. Generation is offline (not in the music path), so
  a few seconds is fine.
- **Play-in chart:** play a chord progression on the keyboard or guitar once
  and the page turns it into a section.
- **Audio to chart on the Spark** (from the original v1 plan): upload a
  recording, get tempo, key, sections and chords (Demucs, allin1 and a chord
  recogniser). Structure only; the recording is never played back
  (design principle 5). This is the heaviest piece and can slip to v0.6 or
  later without blocking the rest.

Done when:
- Thiago makes a new song from a sentence, edits it and jams on it in under
  two minutes.
- Bad generated charts are caught by the schema and fixed or rejected with a
  clear message.

## v0.6: Stage

**Goal:** a UI good enough to play from and to film for the demo.

Scope:
- Stage view: big section / chord / next-chord display, bar and beat
  counter, count-in, the form as a timeline with the current position.
- Band panel: per-part mute/solo, volume, intensity meters, the move log
  with reasons as the "bandleader's thoughts".
- Setup flow: inputs (MIDI / audio / keys), outputs, leader, all remembered
  between sessions.
- Recording: export the band's MIDI and a mixdown of the built-in sound for
  the video.
- Works on a tablet on a music stand (layout only; the engine stays in the
  browser that has the audio).

Done when:
- Thiago records the demo video from the stage view without touching JSON or
  DevTools.

## v1.0: Public

- Repo goes public (license is Apache 2.0); README, getting-started for
  laptop-only and laptop + Spark, a short architecture tour.
- Demo video.
- Decision records brought up to date (the Proposed ones accepted or
  superseded).

## More ideas

Ideas beyond Thiago's list, with the release each one would fit. Not
committed yet; pull them in or drop them.

| Idea | What it is | Fits |
|------|------------|------|
| Intros, endings, count-in | The band counts you in, plays a pickup or intro, and ends the song properly on cue (ritardando, final hit, ring-out) instead of just stopping | v0.1 |
| Band follows your tempo | Detect the player rushing or dragging and let the band drift with them inside limits, or hold steady as a "strict" option | v0.3 |
| Voice cues | Say "take it down" or "one more chorus" to the band; speech-to-text (Whisper) on the Spark turns it into a cue through the governor | v0.3 |
| Song-level arc | The leader remembers the shape of the song so far (it already built up in chorus 1) and plans the next sections, instead of only reacting phrase by phrase | v0.3 |
| Bandleader personality | A knob or a few presets (steady, supportive, adventurous) that change how often and how boldly the leader moves | v0.3 |
| Trading fours | When you lay out, a band instrument takes a short solo or answers your phrase, then hands it back | after v0.3 (needs phrasing signals) |
| Free jam, no chart | Start playing and the band works out the key, tempo and a progression from you, then locks into it | after v0.4 (needs pitch/chords from input) |
| Practice mode | Loop a section, slow it down, count bars, and keep the band on just that part | v0.6 |
| Phone as remote | Open a page on the phone and use it as a footswitch / cue pad over the same server | v0.6 |
| Session recap | After a jam: the move log as a timeline, a short written summary from Qwen, and MIDI/audio export | v0.6 |

## Later

Kept from the original plan in [architecture.md](architecture.md), not
scheduled yet:

- **Ableton Link** through a small local bridge
  ([ADR-0004](decisions/0004-ableton-link-deferred.md)). Untested. It needs
  a helper app on the Mac, which may not be allowed on Thiago's work laptop,
  so it needs a check before it gets a slot. Could go in any release as a
  side task once that's answered.
- **Generative mid layer on the Spark:** a symbolic model writing the next
  1–2 bars under the same commit-deadline contract. Natural follow-up to
  v0.1's rule-based groove once the eval harness from v0.3 can tell whether
  it's better.
- **Audio mode with Magenta RealTime**, after the spike in
  [ADR-0009](decisions/0009-magenta-realtime-spike.md). The spike can run on
  the Spark at any time; it doesn't block anything above.
- Max for Live device; remote mode where only the human parts cross the
  network.

## Open questions

1. **Order.** Groove first is the recommendation: it fixes the weakest part
   of the demo (test 10), it's all in the engine, and every later release
   sounds better because of it. The alternative is Listening first, since
   its recording/replay and eval harness make the other releases easier to
   test.
2. **Sound source for v0.2:** which sample set (license and size), or rely on
   MIDI out to Ableton for "good sound" and keep the built-in sound modest.
3. **Styles:** which two or three groove styles matter most to Thiago (this
   decides what the bass and drum vocabularies cover first).
4. **Link:** can a local helper app run on the work Mac at all? If not, Link
   only makes sense from the Spark or a personal machine.
