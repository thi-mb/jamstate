# Samples

The built-in band plays sampled instruments
([ADR-0018](decisions/0018-lineups-and-sound.md)). This page records where the
samples come from, their license, and their size, as the roadmap asks before a
set is added.

## Source and license

| | |
|---|---|
| Source | MuseScore_General.sf2, version 0.2.0 (13 May 2020), by S. Christian Collins |
| From | http://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/ |
| License | MIT, as FluidR3 and FluidR3Mono before it. The notices are in [sounds/MuseScore_General-License.md](../sounds/MuseScore_General-License.md) and ship with the page as `samples/LICENSE.md` |
| Based on | FluidR3 by Frank Wen (MIT), FluidR3Mono by Michael Cowgill |

The MIT license asks that the copyright notices travel with derivative works,
which is why the license file sits next to the samples in every build.

## How they are made

```bash
pip install pyfluidsynth numpy        # plus libfluidsynth and ffmpeg with libopus
python sounds/render.py path/to/MuseScore_General.sf2           # all instruments
python sounds/render.py path/to/MuseScore_General.sf2 --only piano,kit
```

`sounds/instruments.json` is the catalog: each instrument's id, part, display
name, SoundFont preset, note range, velocity layers and loop points. The page
reads the same file for its instrument lists, and the renderer writes
`web/public/samples/manifest.json` (zones, loop points, sizes) plus one mono
Ogg Opus file (56 kbit/s, 48 kHz) per note and layer. One gain per instrument
keeps the dynamics between layers; the SoundFont's reverb and chorus are off,
since the page adds the room.

## Sizes

| Instrument | Part | Name | Samples | MB |
|---|---|---|---|---|
| kit | drums | Studio kit | 52 | 0.25 |
| rock | drums | Rock kit | 52 | 0.29 |
| jazz | drums | Jazz kit | 52 | 0.31 |
| brushes | drums | Brushes | 52 | 0.31 |
| electronic | drums | Electronic (808) | 39 | 0.18 |
| hand | percussion | Hand percussion | 30 | 0.05 |
| electric | bass | Electric bass | 22 | 0.40 |
| upright | bass | Upright bass | 22 | 0.36 |
| pick | bass | Picked bass | 22 | 0.42 |
| synth | bass | Synth bass | 22 | 0.34 |
| piano | keys | Piano | 57 | 1.00 |
| epiano | keys | Electric piano | 34 | 0.81 |
| organ | keys | Organ | 17 | 0.80 |
| rock-organ | keys | Rock organ | 17 | 0.80 |
| clav | keys | Clavinet | 34 | 0.64 |
| clean | guitar | Clean guitar | 30 | 0.75 |
| funk | guitar | Funk guitar | 30 | 0.44 |
| jazz-guitar | guitar | Jazz guitar | 30 | 0.75 |
| crunch | guitar | Crunch guitar | 30 | 1.01 |
| strings | pad | Strings | 30 | 1.34 |
| warm-pad | pad | Warm pad | 15 | 0.64 |
| **all** | | | | **11.90** |

Default lineups, plus the piano for the player's own notes (budget: under
10 MB):

| Genre | Lineup | MB |
|---|---|---|
| Funk | kit, electric bass, electric piano, funk guitar | 2.91 |
| Blues rock | rock kit, picked bass, rock organ, crunch guitar | 3.53 |
| Jazz | brushes, upright bass, piano | 2.67 |

Only the instruments in the lineup are fetched. The browser keeps them in
Cache Storage (one cache per sample set), so the second visit plays from disk.

## Replacing an instrument

Any SoundFont or SFZ that renders through FluidSynth works the same way: add
or change the entry in `sounds/instruments.json`, render with `--only <id>`,
and write the new source and license here. If an instrument comes from
another set, give it its own row under "Source and license".
