# 0026. Voice cues: a small grammar recogniser in the page

- Status: Accepted
- Date: 2026-11-14

## Context
v0.3 gave the player cues on keys 1–8 (ADR-0020); with a guitar in hand the
keys are out of reach. v0.5 adds saying them: "take it down", "one more
chorus". The voice can come from the Scarlett's mic input (input 1, while the
guitar is on input 2) or the computer's own mic.

- No server required (ADR-0015): recognition has to run in the page.
- The Web Speech API in Chrome sends the audio to Google, works only online,
  and gives no control over vocabulary.
- Only a handful of phrases matter, said over a band. A recogniser limited
  to those phrases is far more robust than open dictation.

## Decision
- **Vosk in the browser** (`vosk-browser`, Apache 2.0, Kaldi in WASM in its
  own Worker) with the small English model (about 40 MB), loaded only when
  **Voice cues** is switched on, and kept in the browser's cache.
  `npm run fetch-models` puts the model in `web/public/models/` (not
  committed); the server serves it like the samples.
- **A fixed grammar**, so the recogniser can only answer with a cue phrase or
  "unknown":

  | Say | Cue |
  |-----|-----|
  | "next section", "next part" | next section |
  | "break", "drums break" | drums/perc break |
  | "drums only" | drums/perc only |
  | "build", "build it up" | build |
  | "take it down", "bring it down" | take it down |
  | "one more chorus", "one more time" | one more chorus |
  | "end the song", "let's end it" | end song |
  | "trade fours", "stop trading" | trading on / off |

  A final result counts only when the whole utterance is one phrase and
  every word in it is heard with a confidence of at least 0.7. An unknown
  word at either end (a breath, a strum) is let go only when the recogniser
  was unsure of it; a confident one means the phrase was part of a
  sentence. Anything else does nothing (`web/src/core/voice.ts`).
- **Early from the partial result.** The final result waits for a pause
  after the phrase (about 0.9 s). A phrase no other phrase starts with
  ("take it down", but not "build") is taken from the partial result once
  it has stayed the same for 0.25 s, and the final result of that utterance
  is then ignored.
- **The same path as the keys.** A spoken cue calls the same `giveCue`, so
  it lands, locks the leader out and is recorded exactly like a key press;
  the log shows it came by voice.
- **Its own input:** device and channel picked separately from the guitar
  (on a Scarlett Solo: channel 1 for voice, channel 2 for guitar). The
  bleed gate (ADR-0025) applies to it when the voice mic hears speakers.
- **Measured** with synthesised speech (several voices) mixed with the band
  and guitar at several levels: detection rate per phrase, false cues per
  minute on band and guitar alone, and time from the end of the phrase to the
  cue. `npm run guitar-eval -- voice` runs it, with Vosk in Python (the
  same engine, model and grammar) and Piper voices; `npm run voice-check`
  says cues to the built page in headless Chrome.

## Results
From `docs/eval/results/v0.5-voice/` (2026-11-14): 15 phrases, 4 Piper
voices at 2 speeds, over nothing, the band through a simulated room (gate
off and on), a strummed guitar and a single-note line, with the speech
+18 to 0 dB over the rest.

- 98% of phrases heard as their cue; at least 92.5% in every bed and level
  (the lowest: a single-note line as loud as the voice). No phrase was
  heard as another cue.
- No false cues in 15 minutes of band, guitar and table talk ("one more
  thing", "take it easy", "i need a break after this one").
- Time to cue from the end of the phrase: 0.23 s median, 0.57 s at the
  90th percentile, against 0.88 s / 0.99 s waiting for the final result,
  with the same hits and no false cues. "Build" waits for the final
  result (0.83 s), as "build it up" starts with it.
- The weakest phrases: "break" alone (86%, heard as "one" in one voice;
  "drums break" 100%) and "let's end it" (92%; "end the song" 100%).
- CPU: 0.009 s per second of audio. The page check: "take it down", "trade
  fours" and "one more chorus" land as said, the two sentences of talk
  between them give nothing, the guitar on input 2 still plays the band,
  and the jam replays exactly. The model loads in about a second from the
  Spark.

Real voices and a real room come in Thiago's jams (T8).

## Consequences
- Works offline, nothing leaves the machine, no account.
- A 40 MB download the first time voice cues are switched on, and a 5.8 MB
  script (Kaldi in WASM) loaded only then.
- A cue arrives about a quarter of a second after the phrase (most
  phrases); cues land on the next bar or phrase anyway (ADR-0020), so this
  rarely changes where one lands.
- A cue said by voice is recorded with `by: "voice"` and replays like a key
  press.

## Alternatives considered
- **Web Speech API:** sends audio to Google, online only, open vocabulary.
- **Whisper in the browser** (transformers.js, tiny model): 40–75 MB too,
  slower to answer, open vocabulary means more false cues. Whisper on the
  Spark stays the lab option.
- **Keyword spotting model trained for these phrases:** smallest and
  fastest, but needs training data we don't have.
