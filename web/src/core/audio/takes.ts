// Guitar takes from recorded playing (v0.5): a session's player notes
// rendered as plucked strings, so the same playing can be judged as MIDI and
// as audio through the listener. Used by the guitar eval, the tests and the
// page's audio check.

import type { SessionFile } from "../session";
import { UNPITCHED } from "../features";
import { renderGuitar, type GuitarOptions, type PluckNote } from "./pluck";

/** Seconds per beat of a session's chart (the strict tempo). */
export const secondsPerBeat = (f: SessionFile) => 60 / f.chart.bpm;

/** The player's notes as plucks; notes above the guitar's range drop an octave, under it go up. */
export function sessionPlucks(f: SessionFile, opts: { muted?: (note: number, i: number) => boolean } = {}): PluckNote[] {
  const spb = secondsPerBeat(f);
  const open = new Map<number, { beat: number; vel: number }>();
  const out: PluckNote[] = [];
  let i = 0;
  for (const [beat, note, vel] of [...f.player].sort((a, b) => a[0] - b[0])) {
    if (vel > 0) {
      open.set(note, { beat, vel });
      continue;
    }
    const o = open.get(note);
    if (!o) continue;
    open.delete(note);
    let n = note;
    while (n > 88) n -= 12;
    while (n >= 0 && n < 40) n += 12;
    const muted = note === UNPITCHED || !!opts.muted?.(note, i++);
    out.push({ time: o.beat * spb, note: muted ? (n >= 0 ? n : 52) : n, vel: o.vel, dur: Math.max(0.05, (beat - o.beat) * spb), muted });
  }
  return out;
}

/** Render a session's playing as a guitar take (mono). */
export function renderSessionTake(f: SessionFile, opts: GuitarOptions = {}): Float32Array {
  const plucks = sessionPlucks(f);
  const end = plucks.reduce((m, p) => Math.max(m, p.time + p.dur), 0) + 1;
  return renderGuitar(plucks, Math.max(end, f.bars.length * Number(f.chart.time_sig.split("/")[0]) * secondsPerBeat(f)), { noiseDb: -72, ...opts });
}
