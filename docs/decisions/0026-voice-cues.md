# 0026. Voice cues: a small grammar recogniser in the page

- Status: Proposed
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

  A result counts only when it's final, the whole utterance is one phrase,
  and the confidence is above a floor; otherwise nothing happens.
- **The same path as the keys.** A spoken cue calls the same `giveCue`, so
  it lands, locks the leader out and is recorded exactly like a key press;
  the log shows it came by voice.
- **Its own input:** device and channel picked separately from the guitar
  (on a Scarlett Solo: channel 1 for voice, channel 2 for guitar). The
  bleed gate (ADR-0025) applies to it when the voice mic hears speakers.
- **Measured** with synthesised speech (several voices) mixed with the band
  and guitar at several levels: detection rate per phrase, false cues per
  minute on band and guitar alone, and time from the end of the phrase to the
  cue.

## Consequences
- Works offline, nothing leaves the machine, no account.
- A 40 MB download the first time voice cues are switched on.
- Recognition takes a short pause after the phrase (about 0.3–0.6 s); cues
  land on the next bar or phrase anyway (ADR-0020), so this rarely changes
  where one lands.

## Alternatives considered
- **Web Speech API:** sends audio to Google, online only, open vocabulary.
- **Whisper in the browser** (transformers.js, tiny model): 40–75 MB too,
  slower to answer, open vocabulary means more false cues. Whisper on the
  Spark stays the lab option.
- **Keyword spotting model trained for these phrases:** smallest and
  fastest, but needs training data we don't have.
