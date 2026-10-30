# 0002. v0 runs in the browser

- Status: Accepted (browser-first, Thiago 2026-10-30). Where the engine code
  lives is Proposed: all in the browser, pending Thiago's pick.
- Date: 2026-10-30

## Context
Thiago wants a browser version first because it is easier to test. The brief
assumed a Python app on the laptop with python-rtmidi, a Python Link binding
and FluidSynth, which needs local installs, virtual MIDI ports and a DAW or
SoundFont before anything makes a sound. The DGX Spark is available as a host
and should be used.

Sound and timing must live in the same place: whoever produces the audio has
to own the clock that schedules it.

## Decision
- The v0 app is a web page. Open a URL and play.
- **Proposed:** the whole real-time engine (scheduler, arranger, governor,
  part generators, player features, rule-based leader, overlay) is written in
  TypeScript and runs in the page.
- Sound comes from a built-in synth/sampler in the page (Web Audio). Web MIDI
  output to a DAW or hardware is optional.
- Input is Web MIDI from a keyboard, with a computer-keyboard fallback so it
  can be tested with no hardware.
- The page is served from the DGX Spark, which also runs the LLM and a small
  API that proxies to it ([ADR-0008](0008-spark-as-stateless-advisor.md)).
- Python stays for Spark-side work: the API server, and v1 audio → chart
  (Demucs, allin1, chord recognition) and model serving.

## Consequences
- Easiest possible test loop: reload the page. Easy demo: share a URL.
- Web Audio scheduling is sample-accurate and better than what we could get
  from Python on the laptop, which retires the brief's "Python timing jitter"
  risk for v0.
- Web MIDI works in Chromium-based browsers and Firefox; Safari does not
  support it. v0 targets Chrome. The computer-keyboard fallback covers the rest.
- Ableton Link cannot run in a page (no UDP multicast). It is deferred to a
  local bridge ([ADR-0004](0004-ableton-link-deferred.md)).
- FluidSynth is dropped from v0. A SoundFont player in Web Audio can bring the
  same sounds back later if wanted.
- Two languages in the repo (TypeScript client, Python server/tools), split
  along the laptop/Spark line, so they rarely need to change together.

## Alternatives considered
- **Python engine on the Spark or laptop, browser only plays sound.** Bars
  arrive over a WebSocket and the browser schedules them. Workable, and keeps
  engine logic in Python, but splits one real-time system across two
  languages and a network hop that sits under the mid-layer deadline.
- **Python app with a web overlay only.** Keeps the original plan, but sound
  still needs FluidSynth or a DAW, which is the testing friction Thiago wants
  to avoid.
