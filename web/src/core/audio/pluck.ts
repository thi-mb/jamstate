// A plucked-string guitar for test material (v0.5): Karplus-Strong strings
// with a pick, a pickup position, string damping, bends and muted strums.
// Not for the band's sound; it gives the detectors and the eval audio with a
// known answer (what was played, when), seeded so a run is repeatable.

import { rng } from "../rand";
import { hzOf } from "./dsp";

export interface PluckNote {
  /** Seconds. */
  time: number;
  /** MIDI note. */
  note: number;
  /** 1–127. */
  vel: number;
  /** Seconds until the string is damped. */
  dur: number;
  /** A muted (palm-muted or fretting-hand-muted) hit: a thud with almost no pitch. */
  muted?: boolean;
  /** Semitones bent up, reached `bendTime` seconds after the pick. */
  bend?: number;
  bendTime?: number;
  /** Vibrato depth in semitones (5.5 Hz). */
  vibrato?: number;
}

export interface GuitarOptions {
  rate?: number;
  seed?: number;
  /** Background noise in dBFS (an amp's hiss). */
  noiseDb?: number;
  /** Mains hum level in dBFS, 0 for none. */
  humDb?: number;
  /** Peak level of a velocity-127 note, dBFS. */
  peakDb?: number;
}

/** Render notes to a mono buffer `seconds` long. */
export function renderGuitar(notes: PluckNote[], seconds: number, opts: GuitarOptions = {}): Float32Array {
  const rate = opts.rate ?? 16000;
  const out = new Float32Array(Math.ceil(seconds * rate));
  const rand = rng(opts.seed ?? 1);
  const peak = Math.pow(10, (opts.peakDb ?? -8) / 20);
  for (const n of notes) pluck(out, rate, n, rand, peak);
  const noise = opts.noiseDb === undefined ? 0 : Math.pow(10, opts.noiseDb / 20);
  const hum = opts.humDb ? Math.pow(10, opts.humDb / 20) : 0;
  if (noise || hum)
    for (let i = 0; i < out.length; i++) {
      out[i] += noise * (rand() * 2 - 1) * 1.7;
      if (hum) out[i] += hum * (Math.sin((2 * Math.PI * 60 * i) / rate) + 0.4 * Math.sin((2 * Math.PI * 180 * i) / rate));
    }
  return out;
}

/** Seconds for a string to fall 60 dB, longer for lower strings. */
const t60 = (note: number) => Math.max(0.8, 6 - (note - 40) * 0.09);

function pluck(out: Float32Array, rate: number, n: PluckNote, rand: () => number, peak: number): void {
  const start = Math.round(n.time * rate);
  if (start >= out.length) return;
  const f0 = hzOf(n.note);
  const maxDelay = Math.ceil(rate / hzOf(n.note - 1)) + 4;
  const buf = new Float32Array(maxDelay + 2);
  // The pick: noise, brighter when played harder, then a pickup-position comb.
  const len = Math.max(2, Math.round(rate / f0));
  const bright = 0.25 + 0.6 * (n.vel / 127);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    lp += bright * ((rand() * 2 - 1) - lp);
    buf[i] = lp;
  }
  const amp = peak * Math.pow(n.vel / 127, 1.6) * 0.9;
  const damped = Math.round((n.time + n.dur) * rate);
  const ringOut = (n.muted ? 0.05 : t60(n.note));
  const gLive = Math.pow(10, -3 / (ringOut * f0));
  const gDamp = Math.pow(10, -3 / (0.06 * f0));
  const pickupLag = Math.max(1, Math.round(len * 0.18));
  const hist = new Float32Array(pickupLag + 1);
  const L = buf.length;
  let w = len;
  let prev = 0;
  let dc = 0;
  let dcIn = 0;
  let muteLp = 0;
  // The loop runs one period early, so the pick sounds at the note's time.
  const first = start - len;
  const end = Math.min(out.length, damped + Math.round(rate * 0.5));
  for (let i = first; i < end; i++) {
    const t = Math.max(0, (i - start) / rate);
    let semis = 0;
    if (n.bend) semis += n.bend * Math.min(1, t / (n.bendTime ?? 0.15));
    if (n.vibrato) semis += n.vibrato * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.2);
    // Total loop delay; the two-point average adds half a sample.
    const d = Math.min(L - 2, rate / (f0 * Math.pow(2, semis / 12)) - 0.5);
    const p = w - d;
    const pi = Math.floor(p);
    const fr = p - pi;
    const delayed = buf[((pi % L) + L) % L] * (1 - fr) + buf[(((pi + 1) % L) + L) % L] * fr;
    const g = i < damped ? gLive : gDamp;
    const s = g * 0.5 * (delayed + prev);
    prev = delayed;
    buf[w % L] = s;
    w++;
    if (i < 0) continue;
    // Pickup: the string seen a short way from the bridge.
    hist.copyWithin(1, 0);
    hist[0] = s;
    let o = s - hist[pickupLag];
    if (n.muted) {
      muteLp += 0.25 * (o - muteLp);
      o = muteLp * 2.5;
    }
    // DC block.
    dc = o - dcIn + 0.995 * dc;
    dcIn = o;
    out[i] += dc * amp;
  }
}

export interface StrumOptions {
  /** "down" plays low to high. */
  dir?: "down" | "up";
  /** Seconds between strings. */
  spread?: number;
  vel?: number;
  dur?: number;
  muted?: boolean;
}

/** A strum of the given notes (low to high), as plucks. */
export function strum(time: number, notes: number[], o: StrumOptions = {}): PluckNote[] {
  const order = o.dir === "up" ? [...notes].reverse() : notes;
  const spread = o.spread ?? 0.012;
  return order.map((note, i) => ({
    time: time + i * spread,
    note,
    vel: Math.max(1, (o.vel ?? 90) - (o.dir === "up" ? 8 : 0) - i * 2),
    dur: o.dur ?? 0.5,
    muted: o.muted,
  }));
}
