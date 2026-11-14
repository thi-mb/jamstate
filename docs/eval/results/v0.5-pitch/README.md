# v0.5 pitch: how well the listener hears a guitar

Run on 2026-11-14 with `npm run guitar-eval -- pitch` (jamstate-listener/0.5, 360 GuitarSet excerpts, pickup and mic). Precision / recall / F1. Onsets match within ±50 ms; a note also needs the right pitch. "Alone" counts only notes with no other note starting within 60 ms (solos have double stops a single-note detector can't name). Solos are heard on "single notes", comping on "auto" (onsets only until the chord layer). Each take is levelled like a calibrated input.

| Take | Onsets | Notes | Notes alone | Octave errors |
|---|---|---|---|---|
| Synthesised lines (8) | 0.998 / 0.978 / **0.988** | 0.998 / 0.978 / **0.988** | 0.998 / 0.978 / **0.988** | 0 / 632 |
| GuitarSet mic/comp | 0.849 / 0.54 / **0.66** | – | – | – |
| GuitarSet mic/comp/BN | 0.829 / 0.643 / **0.724** | – | – | – |
| GuitarSet mic/comp/Funk | 0.768 / 0.636 / **0.696** | – | – | – |
| GuitarSet mic/comp/Jazz | 0.853 / 0.604 / **0.707** | – | – | – |
| GuitarSet mic/comp/Rock | 0.931 / 0.433 / **0.591** | – | – | – |
| GuitarSet mic/comp/SS | 0.89 / 0.483 / **0.626** | – | – | – |
| GuitarSet mic/solo | 0.813 / 0.892 / **0.851** | 0.634 / 0.661 / **0.647** | 0.645 / 0.723 / **0.682** | 443 / 16861 |
| GuitarSet mic/solo/BN | 0.791 / 0.885 / **0.835** | 0.629 / 0.69 / **0.658** | 0.629 / 0.712 / **0.668** | 63 / 2583 |
| GuitarSet mic/solo/Funk | 0.814 / 0.878 / **0.845** | 0.631 / 0.651 / **0.641** | 0.63 / 0.694 / **0.66** | 149 / 3857 |
| GuitarSet mic/solo/Jazz | 0.838 / 0.895 / **0.866** | 0.685 / 0.711 / **0.698** | 0.69 / 0.75 / **0.719** | 66 / 2810 |
| GuitarSet mic/solo/Rock | 0.806 / 0.903 / **0.852** | 0.599 / 0.614 / **0.606** | 0.624 / 0.719 / **0.668** | 74 / 3593 |
| GuitarSet mic/solo/SS | 0.815 / 0.899 / **0.855** | 0.637 / 0.658 / **0.647** | 0.659 / 0.742 / **0.698** | 91 / 4018 |
| GuitarSet pickup/comp | 0.867 / 0.572 / **0.689** | – | – | – |
| GuitarSet pickup/comp/BN | 0.871 / 0.672 / **0.759** | – | – | – |
| GuitarSet pickup/comp/Funk | 0.774 / 0.664 / **0.715** | – | – | – |
| GuitarSet pickup/comp/Jazz | 0.88 / 0.633 / **0.736** | – | – | – |
| GuitarSet pickup/comp/Rock | 0.937 / 0.481 / **0.636** | – | – | – |
| GuitarSet pickup/comp/SS | 0.901 / 0.507 / **0.649** | – | – | – |
| GuitarSet pickup/solo | 0.882 / 0.913 / **0.897** | 0.795 / 0.781 / **0.788** | 0.81 / 0.854 / **0.831** | 239 / 16861 |
| GuitarSet pickup/solo/BN | 0.887 / 0.917 / **0.901** | 0.823 / 0.834 / **0.829** | 0.826 / 0.863 / **0.844** | 18 / 2583 |
| GuitarSet pickup/solo/Funk | 0.878 / 0.903 / **0.891** | 0.805 / 0.792 / **0.798** | 0.805 / 0.843 / **0.824** | 91 / 3857 |
| GuitarSet pickup/solo/Jazz | 0.91 / 0.918 / **0.914** | 0.834 / 0.818 / **0.826** | 0.841 / 0.861 / **0.851** | 38 / 2810 |
| GuitarSet pickup/solo/Rock | 0.864 / 0.915 / **0.889** | 0.748 / 0.725 / **0.736** | 0.783 / 0.848 / **0.814** | 35 / 3593 |
| GuitarSet pickup/solo/SS | 0.877 / 0.915 / **0.896** | 0.781 / 0.763 / **0.772** | 0.806 / 0.856 / **0.831** | 57 / 4018 |

CPU: 0.006 seconds per second of audio on one thread (22138 s of audio).

GuitarSet: Q. Xi, R. Bittner, J. Pauwels, X. Ye, J. P. Bello, "GuitarSet: A Dataset for Guitar Transcription", ISMIR 2018. CC BY 4.0. Not kept in the repo.
