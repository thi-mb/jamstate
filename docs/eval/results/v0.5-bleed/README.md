# v0.5 bleed: the band through speakers into the input

Run on 2026-11-14 with `npm run guitar-eval -- bleed` (jamstate-bleed/0.5). 4 synthesised guitar lines that play for 4 s and rest for 4 s, with a synthesised band (strummed chords, bass, kick and hat) through a simulated room: 35 ms late, darker, a reverb tail of about a second. The bleed level is the band's level at the input against the guitar's (0 dB: as loud). Single notes; false onsets are onsets while the guitar rests; note F1 is onset (±50 ms) and pitch while it plays.

| Bleed | False onsets a minute, gate off | gate on | Note F1, gate off | gate on | Delay the gate found |
|---|---|---|---|---|---|
| none | 0 | 0 | 0.947 | 0.928 | – |
| -24 dB | 8.327 | 0 | 0.921 | 0.921 | 36 ms |
| -18 dB | 40.446 | 3.569 | 0.845 | 0.922 | 36 ms |
| -12 dB | 99.925 | 16.654 | 0.653 | 0.875 | 36 ms |
| -6 dB | 141.561 | 9.517 | 0.413 | 0.828 | 32 ms |
| 0 dB | 184.386 | 17.844 | 0.13 | 0.726 | 32 ms |

The gate's CPU: 0.01 seconds per second of audio on one thread (and it delays what the listener hears by 32 ms, taken off the onset times).
