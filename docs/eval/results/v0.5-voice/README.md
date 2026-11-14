# v0.5 voice cues: synthesised speech over the band and guitar

Run on 2026-11-14 with `npm run guitar-eval -- voice`. Every cue phrase (15) said by 4 Piper voices (en_US-lessac-low, en_US-ryan-low, en_GB-alan-low, en_US-amy-low) at 2 speeds, one phrase every 4 s, over what the voice mic hears besides. The level is the speech's over the rest's (RMS while speaking). Recognised by vosk-model-small-en-us-0.15 with the cue grammar in Vosk (Python: the engine, model and grammar the page runs in WASM), cues taken as the page takes them: from a partial result that holds 0.25 s when no other phrase starts with it, else from the final result. A phrase is heard when its cue comes out between its start and 2 s after its end; the time to cue is from the end of the speech.

## Waiting for the final result, or taking a held partial

| Way in | Heard | Wrong cue | Time to cue (median / 90th) | False cues (15 min with no cue) |
|---|---|---|---|---|
| final only | 97.6% | 0% | 0.88 s / 0.99 s | 0 |
| hold 0.15 s | 97.8% | 0.3% | 0.13 s / 0.47 s | 0 |
| hold 0.25 s | 98% | 0% | 0.23 s / 0.57 s | 0 |
| hold 0.4 s | 97.9% | 0% | 0.39 s / 0.74 s | 0 |

## Cues heard, by what else the mic hears

| Besides the voice | +18 dB | +12 dB | +6 dB | +0 dB |
|---|---|---|---|---|
| nothing else | 99.2% (0.23 s / 0.57 s) | | | |
| the band through the speakers | 99.2% | 100% | 98.3% | 99.2% |
| the band, gate on | 98.3% | 98.3% | 99.2% | 96.7% |
| a strummed guitar | 99.2% | 99.2% | 99.2% | 94.2% |
| a single-note line | 99.2% | 98.3% | 96.7% | 92.5% |

## By phrase and voice

| Phrase | Heard | Wrong | Time to cue |
|---|---|---|---|
| next section | 100% | 0% | 0.09 s / 0.43 s |
| next part | 100% | 0% | 0.18 s / 0.31 s |
| break | 86% | 0% | 0.44 s / 0.55 s |
| drums break | 100% | 0% | 0.28 s / 0.39 s |
| drums only | 99.3% | 0% | 0.18 s / 0.36 s |
| build | 99.3% | 0% | 0.83 s / 0.88 s |
| build it up | 96.3% | 0% | 0.51 s / 0.64 s |
| take it down | 100% | 0% | 0.22 s / 0.41 s |
| bring it down | 99.3% | 0% | 0.33 s / 0.39 s |
| one more chorus | 99.3% | 0% | 0.13 s / 0.3 s |
| one more time | 100% | 0% | 0.12 s / 0.25 s |
| end the song | 100% | 0% | 0.22 s / 0.29 s |
| let's end it | 91.9% | 0% | 0.49 s / 0.57 s |
| trade fours | 99.3% | 0% | 0.02 s / 0.28 s |
| stop trading | 100% | 0% | 0.11 s / 0.32 s |

| Voice | Heard | Time to cue |
|---|---|---|
| en_US-lessac-low | 98% | 0.22 s / 0.6 s |
| en_US-ryan-low | 95.1% | 0.32 s / 0.64 s |
| en_GB-alan-low | 99% | 0.19 s / 0.49 s |
| en_US-amy-low | 100% | 0.18 s / 0.52 s |

## False cues

Three minutes of each bed alone at its loudest (0 dB), and table talk over the band at +12 dB: twelve sentences that aren't cues, some close ("one more thing", "take it easy", "i need a break after this one", "build me a better groove"), in each voice.

| With no cue said | Minutes | Cues | Heard as |
|---|---|---|---|
| the band through the speakers | 3 | 0 | – |
| the band, gate on | 3 | 0 | – |
| a strummed guitar | 3 | 0 | – |
| a single-note line | 3 | 0 | – |
| table talk | 3.28 | 0 | – |

Misses at +12 dB and up, and wrong cues: 

- band +18 dB en_US-ryan-low: "break" heard as "break"
- band+gate +18 dB en_US-ryan-low: "break" heard as "one"
- band+gate +18 dB en_US-ryan-low: "let's end it" heard as "let's end it"
- band+gate +12 dB en_US-ryan-low: "break" heard as "one"
- band+gate +12 dB en_US-ryan-low: "let's end it" heard as "let's end"
- strums +18 dB en_US-ryan-low: "break" heard as "one"
- strums +12 dB en_US-ryan-low: "break" heard as "one"
- line +18 dB en_US-ryan-low: "break" heard as "one"
- line +12 dB en_US-lessac-low: "break" heard as "bring"
- line +12 dB en_US-ryan-low: "break" heard as "one"

The recogniser's CPU: 0.0094 seconds per second of audio (Python, one thread; the page runs the same in WASM in a worker).
