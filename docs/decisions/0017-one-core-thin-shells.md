# 0017. One core, thin shells: web now, desktop app when tests say so

- Status: Accepted (2026-10-31)
- Date: 2026-10-31
- Extends: [0002](0002-browser-first.md)

## Context
ADR-0002 put the engine in the browser so v0 was easy to test. Looking past
v1.0, three ways to ship are on the table, each good at something different:

- **Web page:** try it from a link, instant updates, a path to the phone.
  But [Web MIDI](https://caniuse.com/midi) is missing in Safari (the Mac
  default) and on every iPhone, the user has to set up a virtual MIDI port
  for Ableton, there is no Ableton Link, and large local models are hard.
- **Desktop app** (Tauri or Electron wrapping the same page): download and
  drag to Applications. It can ship a local decision model, create its own
  MIDI port into Ableton, speak Link, use native low-latency audio in, and
  run local generative audio such as
  [Magenta RealTime 2](https://mer.vin/2026/06/magenta-realtime-2-open-local-live-music-model-with-midi-and-200ms-latency/?amp=1),
  which streams in real time on Apple Silicon.
- **DAW plugin** (VST3/AU): lives inside Ableton with its tempo and tracks
  for free, but needs a native codebase.

We don't yet know how players will use jamstate (keys or guitar, DAW or
couch, practice or creative partner, install or not, pay or not). Our only
data point is the maintainer's own playing.

## Decision
- **One core, the same everywhere.** The engine, arranger, governor, part
  generators, genre packs, sessions and brain providers stay one TypeScript
  codebase with no DOM or platform calls in `web/src/core`.
- **Platform interfaces.** MIDI in and out, audio input, storage and model
  runtime sit behind small interfaces. The web page plugs in Web MIDI, Web
  Audio and browser storage; a desktop shell can plug in native versions.
- **Web is the first shell and the try-it door.** It stays fully usable on
  its own ([ADR-0015](0015-no-server-required.md)).
- **The desktop app is the likely home for regular players**, built when the
  tests below say it is worth it. Tauri vs. Electron is decided then.
- **A DAW plugin and a hosted subscription stay open.** The subscription is
  for generative audio only, and only if it turns out good enough to pay for.
- **Learn before committing:**
  1. a brain bake-off on the Spark ([ADR-0016](0016-brain-providers.md));
  2. Laya running in the browser;
  3. a public web demo after v0.2 sound, with a short survey, shown to 10 to
     20 players;
  4. a desktop shell spike (virtual MIDI port into Ableton);
  5. a generative band spike with Magenta RealTime 2.

## Consequences
- No platform choice is locked in, at the cost of a thin interface layer now.
- Features that need native powers (Link, bundled models) wait for the
  desktop shell, or ship web-first in a weaker form.
- The phone path stays the same: an installable web app first.

## Alternatives considered
- **Commit to web only.** Loses Safari users, easy Ableton setup, Link and
  bundled models.
- **Commit to a desktop app now.** Adds install friction before we know who
  the users are, and slows hands-on testing.
- **DAW plugin first.** Best Ableton fit, but a rewrite in another language
  before the core is proven.
