// MIDI out to a DAW or hardware, through the platform's MIDI ports
// (web/src/platform). Optional; the page works without it.

import type { MidiOutPort } from "../core/platform";
import type { Sink } from "../core/transport";
import type { NoteEvent, Voice } from "../core/types";

/**
 * One MIDI channel per part (1-based in a DAW: player 1, bass 2, keys 3,
 * guitar 4, pad 5, drums 10, percussion 11). Drums and percussion use the
 * General MIDI percussion map.
 */
export const CHANNELS: Record<Voice, number> = { player: 0, bass: 1, chords: 2, guitar: 3, pad: 4, drums: 9, percussion: 10 };

export { pickInputs } from "../platform/web";

/**
 * Sends the band to a MIDI output. Times are AudioContext seconds, mapped to
 * the performance.now() timeline that MIDI ports expect.
 */
export class MidiSink implements Sink {
  constructor(
    private out: MidiOutPort,
    private ctx: AudioContext,
    private includePlayer = false,
  ) {}

  private toPerf(time: number): number {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined)
      return ts.performanceTime + (time - ts.contextTime) * 1000;
    return performance.now() + (time - this.ctx.currentTime) * 1000;
  }

  play(ev: NoteEvent, time: number, duration: number): void {
    if (ev.part === "player" && !this.includePlayer) return;
    const ch = CHANNELS[ev.part];
    const on = this.toPerf(time);
    this.out.send([0x90 | ch, ev.note, ev.vel], on);
    this.out.send([0x80 | ch, ev.note, 0], on + Math.max(duration * 1000 - 2, 5));
  }

  panic(): void {
    this.out.clear?.();
    for (const ch of Object.values(CHANNELS)) this.out.send([0xb0 | ch, 123, 0]);
  }
}

/** Fan out to several sinks (built-in synth + MIDI out). */
export class MultiSink implements Sink {
  constructor(public sinks: Sink[]) {}
  play(ev: NoteEvent, time: number, duration: number): void {
    for (const s of this.sinks) s.play(ev, time, duration);
  }
  panic(): void {
    for (const s of this.sinks) s.panic();
  }
}
