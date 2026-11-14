# 0024. Chord detection: chroma templates first, Basic Pitch measured beside it

- Status: Proposed
- Date: 2026-11-14

## Context
A strummed guitar has to become notes the listening layer can judge
(inside / colour / outside), and a chord the fretboard can show in a
plausible place on the neck, within about a beat. The roadmap suggested a
small transcription model in the browser (Spotify's Basic Pitch).

- Basic Pitch (Apache 2.0, about 17k parameters) transcribes polyphonic
  notes, but runs on 2 s windows at 22.05 kHz through TensorFlow.js, which
  adds several MB to the page and a model run per window.
- What the band needs is coarser than transcription: which chord, and
  whether it's the chart's. The chart says what chord should be sounding,
  which is a strong prior.
- Thiago asked for both options to be measured for accuracy and cost before
  one is picked (2026-11-14).

## Decision
- **Default: chroma template matching** (`web/src/core/audio/chords.ts`).
  A 4096-point FFT (256 ms at 16 kHz) every 64 ms, folded into a 12-bin
  chroma (55 Hz–2 kHz, log magnitude, harmonics of strong low partials
  damped), averaged from 30 ms after a strum onset. Matched by cosine
  against templates (major, minor, 7, m7, maj7, m7♭5, dim, sus4, 5) on all
  12 roots, with a bonus for the chart's current and next chord. Below a
  confidence floor it reports the chroma's strongest pitch classes as notes
  rather than guess a chord.
- **Basic Pitch** sits behind the same `ChordDetector` interface, loaded
  lazily (TF.js with the WebGL or WASM backend) only when picked under You.
- **Measured, then picked.** `npm run guitar-eval` runs both on synthesised
  guitar and on GuitarSet (CC BY 4.0, the comping excerpts in funk, jazz
  and rock; downloaded, never committed) and reports chord accuracy per
  beat (root and quality, and "agrees with what was played"), note F1, time
  from strum to answer, and CPU time per second of audio, in Node and in
  headless Chrome. The results are in `docs/eval/results/v0.5-chords/`; the
  default stays chroma unless Basic Pitch is clearly more accurate at a cost
  the page can carry.
- **Voicings.** A detected chord is emitted as the tones of a real guitar
  voicing (open, E-shape or A-shape barre, and a few jazz shells), picked
  nearest the player's hand position, so the fretboard shows a playable
  shape and the session holds plausible notes.

## Consequences
- No model download for the default; chord detection works offline and on
  any machine.
- Chroma can't tell inversions or voicings apart, and leans on the chart
  for borderline chords; a player playing a different chord from the chart
  must play it clearly to be heard as such.
- The comparison is repeatable, so the fine-tuning pass after Thiago's jams
  can re-run it on his recordings.

## Alternatives considered
- **Basic Pitch as the default** (the roadmap's first idea): the measurement
  decides; see the results.
- **Chords on the Spark** (per-bar features sent to a server model): breaks
  "no server required" for a core input and adds a network hop.
- **A chord-recognition CNN** (e.g. from madmom): bigger, Python-first, and
  built for recordings, not a live strum.
