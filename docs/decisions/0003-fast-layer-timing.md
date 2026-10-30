# 0003. Web Audio lookahead scheduler

- Status: Proposed
- Date: 2026-10-30

## Context
The fast layer must place notes within a few milliseconds of their musical
time. In a browser, `setTimeout`/`setInterval` are jittery (tens of ms, worse
in background tabs or during layout), but `AudioContext.currentTime` is a
sample-accurate clock and audio nodes can be scheduled to start at exact times
on it.

## Decision
Use the standard two-clock lookahead pattern:

- The audio clock (`AudioContext.currentTime`) is the single source of time.
  Musical positions are beats; beat → seconds uses the tempo map anchored at
  transport start.
- A timer wakes every ~25 ms and schedules every committed event whose time
  falls in the next ~100 ms window. The timer runs in a Worker so main-thread
  work (UI, JSON parsing, fetches) can't delay it.
- Sound: start audio nodes at the exact computed audio-clock time.
- Web MIDI out: `output.send(data, timestamp)` where the timestamp is the same
  instant mapped to `performance.now()` space (via
  `AudioContext.getOutputTimestamp()`, adjusted for output latency).
- Player input timestamps (`MIDIMessageEvent.timeStamp`) are mapped into the
  same beat space so features line up with bars.
- Tempo and feel changes apply on boundaries only, so already-scheduled events
  inside the lookahead window are never wrong.

Targets to verify in a spike: scheduled events land within 1 ms of target on
the audio path; MIDI out within ~3 ms; no audible gaps with the tab
foregrounded while the overlay animates and a bandleader request is in flight.

## Consequences
- Moves can only take effect after the lookahead window (~100 ms), which is
  far below the bar-level quantization we use anyway.
- The page must be started by a user gesture (browser autoplay rules); the UI
  needs a "Start" button.
- Background tabs throttle timers; the jam is expected to run in a visible tab.

## Alternatives considered
- **Python scheduler process with spin-sleep** (the brief's plan). Workable
  but needs tuning and gives worse guarantees than the audio clock.
- **Tone.js Transport.** Implements this pattern already and is a reasonable
  shortcut; acceptable if the build thread prefers it, as long as the clock and
  commit rules above hold.
- **AudioWorklet-based sequencer.** Tightest timing, more complexity; revisit
  only if the spike misses its targets.
