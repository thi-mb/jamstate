# v0.5 chords: how well chords are heard from a guitar

Run on 2026-11-14 with `npm run guitar-eval -- chords` (jamstate-chords/0.5). Two front ends feed the same chord templates and chart prior: the **chroma** of the strum (the page's) and **Basic Pitch**, a transcription model (eval only). Both hear the strum from 30 ms to 158 ms after it. Scores: the right root; the right root and third (major or minor); the right root and quality as heard here (triads, sevenths, m7b5, sus4, power chords).

## Synthesised strums

192 strums (down and up) of voicings all over the neck.

| Front end | Root | Major/minor | Quality |
|---|---|---|---|
| Chroma | 90% | 87% | 80% |
| Basic Pitch | 90% | 85% | 80% |

## GuitarSet comping, per beat

60 of 180 comping excerpts (every one in 3), pickup. Each beat against the lead sheet's chord and the chord as played (GuitarSet annotates both; players add sevenths, suspensions and inversions), with and without the chart prior. Beats are not always strums, so these are lower bounds.

| Front end | Against | Root | Major/minor | Quality |
|---|---|---|---|---|
| Chroma | sheet | 65% | 50% | 29% |
| Chroma | sheet, with the prior | 70% | 61% | 56% |
| Chroma | played | 65% | 47% | 34% |
| Chroma | played, with the prior | 70% | 55% | 46% |
| Basic Pitch | sheet | 68% | 37% | 28% |
| Basic Pitch | sheet, with the prior | 70% | 43% | 37% |
| Basic Pitch | played | 69% | 45% | 40% |
| Basic Pitch | played, with the prior | 70% | 50% | 44% |

## The listener on GuitarSet comping

What the page does: auto, the lead sheet as the chart. 14617 strums and hits heard on all 180 excerpts: 70% heard as chords, 0% as unpitched hits, the rest as single notes.

| Chords heard, against | Root | Major/minor | Quality |
|---|---|---|---|
| The chord as played | 72% | 60% | 51% |
| The lead sheet | 72% | 66% | 61% |

## Cost

| Front end | CPU | Strum to answer |
|---|---|---|
| Chroma | 0.082 ms per strum | 158 ms |
| Basic Pitch (TF.js CPU backend, Node) | 0.741 s per second of audio; 2340 ms per 2 s window | 2498 ms |

In headless Chrome 141.0.7390.37 (`npm run chords-browser`, 2026-11-14): the chroma 0.072 ms per strum; Basic Pitch 455 ms per 2 s window on WebGL (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver): a software GPU, so slower than a real one) and 1983 ms on the CPU backend.

GuitarSet: Q. Xi, R. Bittner, J. Pauwels, X. Ye, J. P. Bello, "GuitarSet: A Dataset for Guitar Transcription", ISMIR 2018. CC BY 4.0. Basic Pitch: R. Bittner et al., "A Lightweight Instrument-Agnostic Model for Polyphonic Note Transcription and Multipitch Estimation", ICASSP 2022. Apache 2.0.
