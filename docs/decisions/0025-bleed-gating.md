# 0025. Bleed gating: the band's own output as the reference

- Status: Proposed
- Date: 2026-11-14

## Context
With headphones, the input hears only the player. With speakers and a mic
(an acoustic guitar, a voice, a horn) it also hears the band, and the
detector would follow the band's notes and energy: the band hears itself,
gets louder, hears itself louder. A guitar on a DI input has almost no
bleed, but a mic for voice cues does. Thiago put gating in scope for v0.5
(2026-11-14).

The page knows exactly what the band is playing: it renders it. Browser
echo cancellation is tuned for speech, smears transients and pitch, and is
switched off for this input (ADR-0023).

## Decision
- **Reference tap.** The band's mix bus (before the master limiter's output
  to the speakers) feeds a second worklet channel, resampled to 16 kHz like
  the input, so the listener gets the band's signal with the same clock.
- **Bleed calibration** (part of the calibration screen, only needed with
  speakers): the band plays two bars while the player stays silent. The page
  finds the delay from the speaker to the input by cross-correlation, and
  the coupling per frequency band (24 bands) as the ratio of input to
  reference level.
- **Spectral gate.** Each FFT frame of the input is compared with the
  delayed, scaled reference frame: bins where the input is not more than
  6 dB above the expected bleed are zeroed before onset, pitch and chroma.
  An onset needs its flux to come from the residual; a pitch needs its
  fundamental's bins to survive. The coupling keeps adapting slowly while
  the player is silent (the gate isn't open).
- **Default off, on its own switch** (**speakers: gate the band**), with
  headphones the recommended setup. Without a bleed calibration the switch
  runs a default coupling and measures the delay from the first silent bars.

## Consequences
- Playing along to speakers works for the energy and density signals, and
  for pitch when the player is louder than the band in the mic.
- The gate can't separate the player from the band when both play the same
  note at once at similar levels; that note is lost, not doubled.
- A second worklet input and a few FFTs a frame; measured with the rest.

## Alternatives considered
- **Browser echo cancellation:** built for voice calls; it ducks the
  player's sustained notes and changes their pitch and dynamics.
- **Time-domain adaptive filter (NLMS):** cancels well for a fixed room but
  converges slowly, struggles with the room's long tail and needs the exact
  sample alignment the reference doesn't guarantee across browsers.
- **Ignore detections that match band notes:** simple, but misses the
  energy the band adds, which is exactly the feedback loop.
