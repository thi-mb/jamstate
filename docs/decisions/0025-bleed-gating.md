# 0025. Bleed gating: the band's own output as the reference

- Status: Accepted
- Date: 2026-11-14

## Context
With headphones, the input hears only the player. With speakers and a mic
(an acoustic guitar, a voice, a horn) it also hears the band, and the
detector would follow the band's notes and energy: the band hears itself,
gets louder, hears itself louder. A guitar on a DI input has almost no
bleed, but a mic for voice cues does. Gating went in scope for v0.5
(2026-11-14).

The page knows exactly what the band is playing: it renders it. Browser
echo cancellation is tuned for speech, smears transients and pitch, and is
switched off for this input (ADR-0023).

## Decision
- **Reference tap.** The band's output (what goes to the speakers, after
  the master chain) feeds the input worklet's second input, resampled to
  16 kHz like the input, so the gate gets the band's signal on the same
  clock (`web/src/core/audio/bleed.ts`).
- **Spectral gate.** A 512-point STFT (32 ms) every 8 ms, with square-root
  Hann windows, over the input and the reference delayed by the trip
  through the speakers and room. A bin passes only when the input is more
  than 6 dB above the expected bleed: the reference's magnitude times the
  coupling of its band (24 bands, log-spaced from 60 Hz to 8 kHz), held
  over the room's tail (falling at most 0.85 a hop). The rest is zeroed and
  the frames are put back together, so the listener runs unchanged on
  cleaned audio, 32 ms late (taken off the onset times).
- **It learns as the jam goes, no extra calibration step.** The delay comes
  from where the input's level rises line up best with the band's (3 s of
  history, up to 0.4 s, every second), starting from the output and input
  latencies the browser reports. The coupling in each band follows the
  lowest input-to-band ratio: it falls fast and rises slowly. Frames with
  the player in them only raise the ratio, so it settles on the moments
  that are nothing but bleed. A new gate starts with each jam.
- **Default off, on its own switch** (**speakers: gate the band**), with
  headphones the recommended setup. The session records that it was on.
  The kept audio is what the input really heard (before the gate).

## Results
From `docs/eval/results/v0.5-bleed/` (2026-11-14). The band through a
simulated room (35 ms, darker, a reverb tail of about a second) into
guitar lines that play 4 s and rest 4 s:

| Bleed | False onsets a minute, off → on | Note F1, off → on |
|---|---|---|
| −18 dB | 40 → 4 | 0.85 → 0.92 |
| −12 dB | 100 → 17 | 0.65 → 0.88 |
| −6 dB | 142 → 10 | 0.41 → 0.83 |
| 0 dB | 184 → 18 | 0.13 → 0.73 |

It found the delay within 4 ms. Without a band it costs 0.02 in note F1
(0.95 → 0.93), so it stays off with headphones. A real room will differ;
the fine-tuning pass measures it with real speakers.

## Consequences
- Playing along to speakers works for the energy and density signals, and
  for pitch when the player is louder than the band in the mic.
- The gate can't separate the player from the band when both play the same
  note at once at similar levels; that note is lost, not doubled.
- A second worklet input and three FFTs a hop; 32 ms more before a note is
  decided, only with the switch on.

## Alternatives considered
- **Browser echo cancellation:** built for voice calls; it ducks the
  player's sustained notes and changes their pitch and dynamics.
- **Time-domain adaptive filter (NLMS):** cancels well for a fixed room but
  converges slowly, struggles with the room's long tail and needs the exact
  sample alignment the reference doesn't guarantee across browsers.
- **Ignore detections that match band notes:** simple, but misses the
  energy the band adds, which is exactly the feedback loop.
