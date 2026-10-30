# 0004. Defer Ableton Link to a local bridge

- Status: Proposed
- Date: 2026-10-30

## Context
The brief wants Ableton Link so the band locks to a DAW or other apps. Link
uses UDP multicast on the local network, which browsers cannot do. With the
browser-first decision ([ADR-0002](0002-browser-first.md)) the page has its own
clock.

## Decision
- v0 runs on the page's own audio clock. No Link.
- v1 adds Link through a small native bridge on the laptop that joins the Link
  session and exposes tempo, beat and phase to the page over a localhost
  WebSocket (Carabiner is an existing bridge of this kind; a small custom one
  using a Link binding is the other option). The page then treats Link as the
  tempo/phase reference and keeps scheduling on the audio clock, nudging its
  beat anchor to stay in phase.
- The bridge must run on the same machine as the browser, not the Spark: Link
  phase is only meaningful on the local network the DAW is on.

## Consequences
- v0 can't sync to Ableton. Recording the band into a DAW still works via Web
  MIDI out, with the DAW following MIDI timing rather than Link.
- Phase sync through a bridge adds some jitter; the bridge reports Link time
  and the page smooths corrections rather than jumping.

## Alternatives considered
- **Link in v0 via the bridge.** Adds an install step, which is exactly what
  browser-first is trying to avoid.
- **MIDI clock out from the page.** Easy, but DAWs follow MIDI clock poorly;
  fine as an extra later.
