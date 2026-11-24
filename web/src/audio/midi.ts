// MIDI out to a DAW or hardware, through the platform's MIDI ports
// (web/src/platform). Optional; the page works without it.

import type { MidiOutPort } from "../core/platform";
import type { Sink } from "../core/transport";
import { PARTS, type NoteEvent, type Part, type Voice } from "../core/types";

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
  readonly muted = new Set<Voice>();

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
    if (this.muted.has(ev.part) || ev.note < 0) return;
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

/**
 * Zero-DOM hit recorder for the Stage musician cards (v0.6). Records scheduled
 * audio-clock timestamps per part; the rAF render loop reads level(part, now)
 * without ever touching the audio thread.
 */
export class HitMonitor implements Sink {
  private events: Record<Part, { time: number; vel: number }[]> = {
    drums: [],
    bass: [],
    chords: [],
    guitar: [],
    pad: [],
    percussion: [],
  };

  play(ev: NoteEvent, time: number): void {
    if (ev.part === "player" || ev.note < 0) return;
    const q = this.events[ev.part];
    q.push({ time, vel: ev.vel / 127 });
    if (q.length > 32) q.shift();
  }

  panic(): void {
    for (const p of PARTS) this.events[p].length = 0;
  }

  /** Instantaneous pulse level 0..1 at audio-clock time `now` (decays over ~220 ms). */
  level(part: Part, now: number): number {
    const q = this.events[part];
    let peak = 0;
    let drop = 0;
    for (let i = 0; i < q.length; i++) {
      const dt = now - q[i].time;
      if (dt < 0) continue;
      if (dt > 0.28) {
        drop = i + 1;
        continue;
      }
      const v = q[i].vel * (1 - dt / 0.28);
      if (v > peak) peak = v;
    }
    if (drop > 0) q.splice(0, drop);
    return peak;
  }
}

/** Fan out to several sinks (built-in synth + MIDI out + hit monitor). */
export class MultiSink implements Sink {
  constructor(public sinks: Sink[]) {}
  play(ev: NoteEvent, time: number, duration: number): void {
    for (const s of this.sinks) s.play(ev, time, duration);
  }
  panic(): void {
    for (const s of this.sinks) s.panic();
  }
}
