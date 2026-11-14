# 0023. Audio input: the guitar becomes notes

- Status: Proposed
- Date: 2026-11-14

## Context
v0.5 lets Thiago play a guitar (or anything with a mic) instead of a MIDI
keyboard. Everything after the input already works on note events: the
per-bar features, the five listening groups, trading, the fretboard, session
recording and exact replay (ADR-0014). The leader reads per-bar features,
not single notes, so audio input doesn't need MIDI-grade latency to be
useful; the fretboard wants "within about a beat".

Forces:
- **The music never stutters.** Detection runs beside the band, never in
  its path; a slow detector can make the leader hear less, not make a bar
  late.
- **Replay stays exact.** A session must replay bar for bar without the
  audio, and a recorded jam must also be re-runnable through a better
  detector later (the real-jams eval set).
- **The Scarlett Solo** (Thiago's interface) has the mic on input 1 and the
  instrument on input 2 of one stereo device. Chrome downmixes to mono
  unless asked for two channels.
- Some guitar playing has no pitch to hear: a funk player's muted
  sixteenths carry most of the energy and none of the harmony.
- The player hears their own guitar through the interface's direct
  monitoring. The page mustn't sound the notes it detects on top.

## Decision
- **Signal path.** `getUserMedia` with echo cancellation, noise
  suppression and gain control off, two channels requested. An
  AudioWorklet (`web/src/audio/input-worklet.ts`) picks the channel (1, 2
  or both mixed), low-passes and resamples to 16 kHz, and posts 512-sample
  blocks with the audio-clock time of their first sample. Everything else
  is DOM-free TypeScript in `web/src/core/audio/`, run on the main thread
  and unit tested in Node on synthesised and recorded audio.
- **One detector, notes out.** `AudioListener` turns blocks into the same
  note on/off events MIDI gives (`playerNote`), stamped with the audio-clock
  time of the onset, not of the detection. Inside it, in layers, each
  usable alone:
  1. **Level and onsets:** RMS and spectral flux on a 512-point FFT every
     8 ms, an adaptive threshold above a calibrated noise gate, 70 ms
     minimum between onsets, and no onset while the level is falling (a
     damped string clicks too).
  2. **Pitch:** YIN on a 1024-sample window (FFT difference function), 70 ms
     after the onset so the window starts after the pick; two frames a hop
     apart must agree, and with no clear pitch the listener waits up to
     80 ms more before calling the onset unpitched (a hit that has died
     25 dB by then was a scratch). When the pitch heard is the note still
     ringing on another string, or an octave of it, a comb at that note's
     period takes it out and YIN looks again. Between onsets a held note is
     followed: a new steady pitch for three frames (48 ms), once the note
     has settled and with the level holding, is a slur (hammer-on, pull-off,
     slide), never back to the note ringing beside it. A note ends when the
     level falls under the gate or 30 dB under its peak. The pitch range
     follows the tuning picked for the fretboard (a bass goes down to E1).
  3. **Chords** (ADR-0024): a strum becomes the chord's tones in a guitar
     voicing.
  The mode is **auto** (single notes when the sound is periodic, chords
  when it isn't and the chroma says chord), or fixed to single notes or
  chords in the page.
- **Unpitched hits are notes with no pitch.** A muted strum or a slap is a
  note with pitch `-1`: it counts for energy, density, rhythm and phrasing,
  and is skipped by harmony, register, the fretboard and the soloist's
  pitches. In the session file it is `[beat, -1, vel]`. A muted strum right
  after a detected chord repeats that chord instead (a funk scratch is the
  chord, damped).
- **On the neck.** A note from an audio input lights one place on the
  fretboard, not every place the pitch exists: in the four-fret box where
  the hand has been, on a string not already sounding, open strings only
  low on the neck. A note outside the box moves the hand halfway toward it.
  The neck takes the tuning (standard, half step down, drop D, DADGAD,
  open G, open D, bass) and can be mirrored for a left-handed player. MIDI
  notes still light every place.
- **Velocity** is the onset's peak level mapped from the calibrated soft and
  hard levels (in dB) to 40–115.
- **Timing.** Onset times are moved earlier by the input latency: what the
  browser reports for the track, plus an optional tap calibration (play
  along to eight clicks; the median offset minus the output latency).
- **Calibration screen** under You, per device and channel, kept in the
  browser: a meter with a clip light, then 2 s of silence (noise gate), 4 s
  soft, 4 s hard, and the optional timing taps. Without calibration,
  defaults that suit a Scarlett at about 12 o'clock gain.
- **The page doesn't sound detected notes.** The player hears their
  instrument through the interface. An optional **hear input** switch routes
  the input to the page's output for interfaces without direct monitoring,
  with a latency warning.
- **Sessions.** Detected notes are recorded as player events, so audio jams
  record and replay exactly like MIDI ones. The file gains
  `input: { kind: "audio", channel, mode, detector, calibration }`. On
  replay, unpitched and pitched player notes from an audio session are not
  sounded by the synth (the band plays as recorded).
- **Raw audio is opt-in** (**keep the audio** under Session): the 16 kHz
  mono stream as a 16-bit WAV beside the session (about 1.9 MB a minute),
  downloaded with it and synced to the Spark next to the JSON. The eval
  re-runs the detector over the WAV, so detector changes can be scored on
  real jams.

## Consequences
- Every v0.3 and v0.4 listening signal works on guitar with no change to
  the leader, the governor or the brains.
- The main thread does the DSP: about 0.5% of a core for onsets and pitch
  (measured by `npm run guitar-eval -- pitch`). If chords or bleed gating push it
  higher, the core moves into a Worker behind the same interface.
- Guitar notes reach the leader roughly 80–160 ms after MIDI ones would
  (the window after the pick, plus waiting on an unclear pitch), though
  stamped with the onset's time; the leader works per bar, the fretboard per
  beat, so neither notices.
- Pitch `-1` is a new value every note consumer must skip; the listening
  tests pin it.

## Alternatives considered
- **A new "audio features" path into the conductor** (energy and density
  straight from RMS and onsets, no notes): the leader would need a second
  set of features, and harmony, phrasing, trading and the fretboard would
  each need audio versions. Notes keep one path.
- **DSP inside the worklet:** fewer copies, but the core code would have to
  be bundled into the worklet scope and couldn't share the Node tests as
  easily. A Worker is the next step if the main thread gets busy.
- **Recording the full-rate audio:** 44.1 kHz is about 5 MB a minute and the
  detector only ever sees 16 kHz.
