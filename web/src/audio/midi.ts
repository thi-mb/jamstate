// Web MIDI: keyboard in, band out (to a DAW or hardware). Optional; the page
// works without it. Needs a secure context (localhost or HTTPS).

import type { Sink } from "../core/transport";
import type { NoteEvent, Voice } from "../core/types";

export const CHANNELS: Record<Voice, number> = { player: 0, bass: 1, chords: 2, drums: 9 };

/**
 * Inputs to listen to. "all" skips any input named like the band's MIDI out:
 * a loopback port (IAC bus, loopMIDI) echoes the band back in, and its notes
 * would count as the player's.
 */
export function pickInputs<T extends { id: string; name?: string | null }>(inputs: T[], id: string, outName?: string | null): T[] {
  if (id !== "all") return inputs.filter((i) => i.id === id);
  return inputs.filter((i) => !outName || i.name !== outName);
}

export type NoteHandler = (on: boolean, note: number, vel: number, timeStamp: number) => void;

export class Midi {
  access: MIDIAccess | null = null;
  error: string | null = null;

  async init(): Promise<boolean> {
    if (!("requestMIDIAccess" in navigator)) {
      this.error = window.isSecureContext ? "Web MIDI isn't supported in this browser (try Chrome)" : "Web MIDI needs HTTPS or localhost";
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess();
      return true;
    } catch (e) {
      this.error = `MIDI access denied: ${(e as Error).message}`;
      return false;
    }
  }

  inputs(): MIDIInput[] {
    return this.access ? [...this.access.inputs.values()] : [];
  }

  outputs(): MIDIOutput[] {
    return this.access ? [...this.access.outputs.values()] : [];
  }

  /** Listen to one input (or all but the band's loopback, with id "all"). Returns an unsubscribe function. */
  listen(id: string, handler: NoteHandler, outName?: string | null): () => void {
    const ins = pickInputs(this.inputs(), id, outName);
    const cb = (e: MIDIMessageEvent) => {
      const d = e.data;
      if (!d || d.length < 3) return;
      const kind = d[0] & 0xf0;
      if (kind === 0x90 && d[2] > 0) handler(true, d[1], d[2], e.timeStamp);
      else if (kind === 0x80 || (kind === 0x90 && d[2] === 0)) handler(false, d[1], 0, e.timeStamp);
    };
    for (const i of ins) i.addEventListener("midimessage", cb as EventListener);
    return () => ins.forEach((i) => i.removeEventListener("midimessage", cb as EventListener));
  }
}

/**
 * Sends the band to a MIDI output. Times are AudioContext seconds, mapped to
 * the performance.now() timeline that MIDIOutput.send() expects.
 */
export class MidiSink implements Sink {
  constructor(
    private out: MIDIOutput,
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
    (this.out as MIDIOutput & { clear?: () => void }).clear?.();
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
