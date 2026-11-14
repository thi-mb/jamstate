# 0024. Chord detection: chroma templates first, Basic Pitch measured beside it

- Status: Accepted
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
  One 2048-point FFT (128 ms at 16 kHz) from 30 ms after the strum's
  onset, past the pick's noise. Only spectral peaks from 80 Hz to 2 kHz
  count, on a log scale, each to the semitone it's nearest. The profile is
  matched by cosine against templates of each chord's tones with their
  first six partials (major, minor, 7, m7, maj7, m7♭5, dim, sus4, 5) on all
  twelve roots. Four-note chords and diminished triads give away a little
  (0.03) against plain triads. Bonuses go to the chart's chord (0.08), the
  next chord (0.04) and the chord just heard (0.05: an up strum misses the
  bass, and Am7 and C6 are the same notes). Below 0.72 it isn't called a
  chord.
- **When a strum is a chord.** In auto, an onset with a clean single pitch
  70 ms in (YIN aperiodicity at most 0.2) is a note. Anything else waits
  for the chord window (158 ms) and is matched; if no chord is clear, it's a
  note or an unpitched hit as before. "Chords" always matches; "single
  notes" never does. A muted scratch within 1.5 s of a chord repeats the
  chord (a chuck in a strumming pattern keeps its harmony).
- **Basic Pitch** (the model's frame posteriors over 30–158 ms, folded into
  pitch classes, matched against the same templates without partials) is
  behind the same profile-and-match path in the eval only
  (`web/scripts/basic-pitch.ts`). It is not in the page.
- **Measured, then picked.** `npm run guitar-eval -- chords` runs both on
  synthesised strums (voicings all over the neck, down and up) and per beat
  on GuitarSet's comping (CC BY 4.0; downloaded, never committed), against
  the lead sheet's chord and the chord as played, with and without the
  prior. Then it runs the listener itself on all the comping, as the page
  does. It reports CPU and time from strum to answer; `npm run
  chords-browser` measures both in headless Chrome. The results are in
  `docs/eval/results/v0.5-chords/`.
- **Voicings.** A detected chord comes out as the notes of a real guitar
  voicing near the player's hand (`voiceGuitar`). The voicing is searched
  in a four-fret box within three frets of the hand: open strings low on
  the neck, the root in the bass, the third and seventh present, at most
  one muted string between sounding ones, no muddy low intervals. Each note
  carries its string and fret, so the fretboard lights the shape and the
  session holds notes a guitarist could have played. The hand lives in the
  listener now, for single notes too, and follows the shapes.

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
