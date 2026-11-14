// Guitar takes from recorded playing (v0.5): a session's player notes
// rendered as plucked strings, so the same playing can be judged as MIDI and
// as audio through the listener. Used by the guitar eval, the tests and the
// page's audio check.

import type { SessionFile } from "../session";
import { UNPITCHED } from "../features";
import { rng } from "../rand";
import { SR } from "./dsp";
import { GUITAR_STRINGS } from "../fretboard";
import { voiceGuitar, type Quality } from "./chords";
import { renderGuitar, strum, type GuitarOptions, type PluckNote } from "./pluck";

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

/** A pentatonic line over two and a half octaves, some notes slurred up a step, some with vibrato. */
export function soloLine(seed: number): { x: Float32Array; truth: { time: number; note: number }[] } {
  const r = rng(seed);
  const scale = [0, 3, 5, 7, 10];
  const at = (d: number) => 45 + 12 * Math.floor(d / 5) + scale[d % 5];
  const notes: PluckNote[] = [];
  const truth: { time: number; note: number }[] = [];
  let t = 0.3;
  let deg = 8;
  for (let i = 0; i < 70; i++) {
    deg = Math.max(0, Math.min(15, deg + Math.floor(r() * 5) - 2));
    const note = at(deg);
    const dur = 0.12 + r() * 0.35;
    const k = r();
    const n: PluckNote = { time: t, note, vel: 50 + Math.floor(r() * 70), dur };
    truth.push({ time: t, note });
    if (k < 0.15 && dur > 0.25) {
      const up = at(deg + 1) - note;
      n.slurs = [{ at: dur * 0.5, semis: up }];
      truth.push({ time: t + dur * 0.5, note: note + up });
    } else if (k < 0.22) n.vibrato = 0.25;
    notes.push(n);
    t += dur + r() * 0.08;
  }
  return { x: renderGuitar(notes, t + 1, { noiseDb: -72, humDb: -62, seed }), truth };
}

/** Chords the strummed takes play. */
const STRUM_CHORDS: Quality[] = ["", "m", "7", "m7", "maj7", "m7b5", "sus4", "5"];

/**
 * A strummed take (v0.5 chords): `count` chords on random roots, each a real
 * voicing somewhere on the neck, strummed down and then up, 1.2 s apart.
 */
export function strumTake(seed: number, count = 16): { x: Float32Array; truth: { time: number; root: number; quality: Quality }[] } {
  const r = rng(seed);
  const plucks: PluckNote[] = [];
  const truth: { time: number; root: number; quality: Quality }[] = [];
  let t = 0.3;
  for (let i = 0; i < count; i++) {
    const root = Math.floor(r() * 12);
    // Mostly triads and sevenths, as in songs.
    const quality = STRUM_CHORDS[r() < 0.6 ? Math.floor(r() * 4) : Math.floor(r() * STRUM_CHORDS.length)];
    const v = voiceGuitar(root, quality, GUITAR_STRINGS, 1 + Math.floor(r() * 9));
    if (!v) continue;
    plucks.push(...strum(t, v.notes, { vel: 70 + Math.floor(r() * 40), dur: 0.55, spread: 0.008 + r() * 0.01 }));
    plucks.push(...strum(t + 0.6, v.notes.slice(-4), { dir: "up", vel: 60 + Math.floor(r() * 30), dur: 0.5, spread: 0.008 }));
    truth.push({ time: t, root, quality }, { time: t + 0.6, root, quality });
    t += 1.2;
  }
  return { x: renderGuitar(plucks, t + 0.5, { seed, noiseDb: -72 }), truth };
}

/**
 * A band for the bleed gate (v0.5 layer 4): chords strummed twice a bar on
 * a keys-like pluck, a bass line on roots and fifths, and a kick and hat,
 * 120 bpm, for `seconds`.
 */
export function bandTake(seed: number, seconds: number): Float32Array {
  const r = rng(seed + 100);
  const plucks: PluckNote[] = [];
  const beat = 0.5;
  for (let bar = 0; bar * 4 * beat < seconds; bar++) {
    const root = Math.floor(r() * 12);
    const v = voiceGuitar(root, r() < 0.5 ? "" : "m7", GUITAR_STRINGS, 3 + Math.floor(r() * 5));
    const t = bar * 4 * beat;
    if (v) for (const at of [0, 2]) plucks.push(...strum(t + at * beat, v.notes.slice(-4), { vel: 70, dur: 0.9, spread: 0.004 }));
    const bass = 28 + root;
    for (let b = 0; b < 4; b++) plucks.push({ time: t + b * beat, note: b === 2 ? bass + 7 : bass, vel: 90, dur: 0.4 });
  }
  const x = renderGuitar(plucks, seconds, { seed: seed + 100, peakDb: -12 });
  // Drums: a kick on 1 and 3, a hat on every eighth.
  for (let k = 0; k * beat / 2 < seconds; k++) {
    const at = Math.round(((k * beat) / 2) * SR);
    for (let i = 0; i < 2400 && at + i < x.length; i++) {
      const t = i / SR;
      if (k % 4 === 0) x[at + i] += 0.35 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 18);
      if (i < 800) x[at + i] += 0.06 * (r() * 2 - 1) * Math.exp(-t * 120);
    }
  }
  return x;
}

/**
 * The band through speakers and a room into the input: `delay` seconds
 * late, a little darker, with a short reverb tail, at `gainDb`.
 */
export function throughRoom(x: Float32Array, opts: { delay?: number; gainDb?: number; seed?: number } = {}): Float32Array {
  const d = Math.round((opts.delay ?? 0.035) * SR);
  const g = Math.pow(10, (opts.gainDb ?? -6) / 20);
  const y = new Float32Array(x.length);
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    lp += 0.45 * ((x[i - d] ?? 0) - lp);
    y[i] = lp;
  }
  // Schroeder reverb: four combs, two all-passes.
  const wet = new Float32Array(x.length);
  for (const [len, fb] of [[557, 0.77], [593, 0.75], [641, 0.73], [683, 0.71]]) {
    const buf = new Float32Array(len);
    for (let i = 0, j = 0; i < x.length; i++, j = (j + 1) % len) {
      const o = buf[j];
      buf[j] = y[i] + o * fb;
      wet[i] += o / 4;
    }
  }
  for (const len of [179, 61]) {
    const buf = new Float32Array(len);
    for (let i = 0, j = 0; i < x.length; i++, j = (j + 1) % len) {
      const o = buf[j];
      const v = wet[i] + 0.6 * o;
      buf[j] = v;
      wet[i] = o - 0.6 * v;
    }
  }
  for (let i = 0; i < x.length; i++) y[i] = g * (y[i] + 0.35 * wet[i]);
  return y;
}
