# 0018. Lineups and the built-in sound

- Status: Proposed (Accepted once Thiago re-runs test 10, [testing/v0.2.md](../testing/v0.2.md))
- Date: 2026-10-31

## Context

v0 test 10 failed: the built-in band "sounds like simple digital instruments"
(oscillators and filtered noise). v0.2 ([roadmap](../roadmap.md#v02-sound-and-lineup))
asks for sampled instruments with a light mix, more instruments and parts, and
a per-song choice of who plays, without breaking the v0 rules: the page runs
with no server ([ADR-0015](0015-no-server-required.md)), the music never
stutters, and recorded sessions replay exactly
([ADR-0014](0014-session-recording.md)).

Open question 2 in the roadmap was which sample set to use, with its license
and size written down first.

## Decision

**Samples.** Render our own small sample set from **MuseScore_General.sf2
0.2** (MIT license, derived from FluidR3 by Frank Wen, also MIT; see
[samples.md](../samples.md)). `sounds/render.py` plays each instrument through
FluidSynth with its reverb and chorus off and writes one mono Ogg Opus file
per note and velocity layer: pitched instruments every three semitones with
two or three velocity layers, kits and hand percussion per General MIDI note
with three or four layers, sustained instruments (organ, strings, pad) with a
baked crossfade loop. 21 instruments come to 11.9 MB; a genre's default lineup
is 2.7 to 3.5 MB, under the 10 MB budget. The files ship with the page in
`web/public/samples/` (static, so no server is needed), are loaded only when
an instrument is in the lineup, and are kept in Cache Storage.

**Fallback.** The old synth voices stay. A part whose samples haven't loaded,
or can't (an old browser without Opus, a failed fetch), plays on the synth.
Start waits up to 4 s for the lineup's samples, then plays anyway.

**Mix.** A channel strip per part (three-band EQ, compressor, fader, pan,
reverb send), one shared convolution reverb from a generated impulse
response, and a master with tape-style saturation, a glue compressor, a
limiter and a soft ceiling under 0 dBFS. All settings are data in the genre
pack's `mix`.

**Parts.** Three new parts with their own grooves, read from the genre pack
like the v0.1 ones: `guitar` (strummed comping; downstrokes on the beat,
upstrokes off it; voicings `power`, `grip`, `shell3` and the keys' `stab`),
`pad` (held chords, split at every chord change) and `percussion` (General MIDI
hand percussion lines). The keys part keeps the id `chords` so older sessions,
brains and charts keep working; the page calls it "keys".

**Lineup as data.** One shape, `band`, maps parts to an instrument (and
optionally volume and pan). It appears in a chart (optional, chart format
0.2), in a genre pack (its default `band` plus named `lineups`), and in a
session file (the band at the start). The engine plays the parts in the band
that the genre has grooves for; `add_layer` and `drop_layer` work on those. A
lineup change mid-song is an engine control (`kind: "band"`), recorded like a
genre or swing change, so a replay sounds like the jam. Instrument, volume and
pan never change the notes, so they never change a bar's hash.

**Precedence.** The page's picker starts from the song's band when the song
plays in its own genre, else the genre's default; picking another genre
brings that genre's band and mix. A sound switch mid-song keeps the old
instrument until the new one has loaded, and no playing note is cut, so there
is no click or gap.

**MIDI out.** One channel per part: player 1, bass 2, keys 3, guitar 4,
pad 5, drums 10, percussion 11 (General MIDI percussion notes).

**Compatibility.** Genre packs are format `jamstate-genre/0.2`; 0.1 packs
still load (three parts, default sounds and mix). Sessions without a `band`
replay with drums, bass and keys, as they were recorded; the nine bake-off
sessions from v0.1.1 replay exactly. Leaders get the band as `lineup` in their
context (missing means drums, bass, chords); the LLM prompt names the parts
through it. The chart schema that LLMs write against leaves `band` out.

## Consequences

- Test 10 can be re-run with the built-in sound alone.
- The repo carries 11.9 MB of binary samples. Re-rendering is one command and
  the samples are reproducible from the SoundFont.
- MuseScore General is a General MIDI set: better than oscillators, not a
  boutique library. Any instrument can be swapped for a better SoundFont (or
  SFZ rendered the same way) without touching the code; the manifest is the
  contract.
- Opus needs Chrome, Firefox, or Safari 18.4+. Older Safari falls back to the
  synth voices.
- Round robins for drums are simulated (a few cents and a fraction of a dB per
  hit) because the SoundFont has one sample per layer.

## Alternatives considered

- **Download a ready-made web set** (MIDI.js soundfonts, smplr's sets): one
  file per note but no velocity layers, MP3 encoder delay hurts drum timing,
  and mixed licenses.
- **Salamander piano, VCSL, etc. per instrument**: better single instruments,
  but several licenses (CC-BY, CC0) and sizes to track, and no shared sound.
  A good next step for the piano and the kits once Thiago says which part
  sounds weakest.
- **SoundFont player in the page (sf2 parsed in the browser)**: no render
  step, but the full SoundFont is 168 MB; rendering only what we play is 7%
  of that.
- **Server-side synthesis on the Spark**: breaks ADR-0015 and adds latency.
