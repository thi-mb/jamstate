// Player features, per bar, and the rolled-up summary the bandleader reads.

import { clamp } from "./types";

/** Pitch of a hit with no pitch to hear (audio input: a muted strum, a slap; ADR-0023). */
export const UNPITCHED = -1;
export const isPitched = (n: { note: number }) => n.note >= 0;

/** A note the player played, in beats relative to its bar. `note` is UNPITCHED for a hit with no pitch. */
export interface PlayedNote {
  start: number;
  dur: number;
  note: number;
  vel: number;
}

export interface BarFeatures {
  noteCount: number;
  /** Notes per beat. */
  density: number;
  /** 0–1 */
  meanVelocity: number;
  /** Mean MIDI pitch of the pitched notes, null when there are none. */
  register: number | null;
  /** Share of 16th steps with nothing sounding. */
  restRatio: number;
  /** 0–1, how closely this bar repeats one of the previous four. */
  repetition: number;
  /** 0–1, density and velocity combined. The v0 bandleader reacts to this. */
  energy: number;
  /** Onset/pitch-class fingerprint used for repetition. */
  signature: string[];
}

/** Sixteenth notes per beat at which density counts as "full". */
const FULL_DENSITY = 4;

export function energyOf(density: number, meanVelocity: number, noteCount: number): number {
  if (noteCount === 0) return 0;
  return clamp(0.55 * Math.min(1, density / (FULL_DENSITY * 0.6)) + 0.45 * meanVelocity, 0, 1);
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function barFeatures(notes: PlayedNote[], beatsPerBar: number, previous: BarFeatures[] = []): BarFeatures {
  const steps = beatsPerBar * 4;
  const onsets = notes.filter((n) => n.start >= 0 && n.start < beatsPerBar);
  const sounding = new Array<boolean>(steps).fill(false);
  for (const n of notes) {
    const a = Math.max(0, Math.floor(n.start * 4 + 1e-9));
    const b = Math.min(steps, Math.ceil((n.start + Math.max(n.dur, 0.25)) * 4 - 1e-9));
    for (let i = a; i < b; i++) sounding[i] = true;
  }
  const noteCount = onsets.length;
  const density = noteCount / beatsPerBar;
  const meanVelocity = noteCount ? onsets.reduce((s, n) => s + n.vel, 0) / noteCount / 127 : 0;
  const pitched = onsets.filter(isPitched);
  const register = pitched.length ? pitched.reduce((s, n) => s + n.note, 0) / pitched.length : null;
  const restRatio = sounding.filter((x) => !x).length / steps;
  const signature = onsets.map((n) => `${Math.round(n.start * 4)}:${isPitched(n) ? n.note % 12 : "x"}`);
  const repetition = previous.slice(-4).reduce((m, p) => Math.max(m, jaccard(signature, p.signature)), 0);
  return {
    noteCount,
    density,
    meanVelocity,
    register,
    restRatio,
    repetition,
    energy: energyOf(density, meanVelocity, noteCount),
    signature,
  };
}

export interface PlayerSummary {
  bars: number;
  energy: number;
  density: number;
  mean_velocity: number;
  rest_ratio: number;
  repetition: number;
  /** Where they're playing: low (< C4), mid, high (> C6). Null when silent. */
  register: "low" | "mid" | "high" | null;
  /** Energy of the second half of the window vs the first, precomputed so the LLM doesn't do arithmetic. */
  trend: "rising" | "falling" | "steady";
  /** Consecutive silent bars at the end of the window. */
  silent_bars: number;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

export function summarize(window: BarFeatures[]): PlayerSummary {
  const half = Math.floor(window.length / 2);
  const regs = window.map((f) => f.register).filter((r): r is number => r !== null);
  const reg = regs.length ? avg(regs) : null;
  const delta = avg(window.slice(half).map((f) => f.energy)) - avg(window.slice(0, half).map((f) => f.energy));
  let silent = 0;
  for (let i = window.length - 1; i >= 0 && window[i].noteCount === 0; i--) silent++;
  return {
    bars: window.length,
    energy: r2(avg(window.map((f) => f.energy))),
    density: r2(avg(window.map((f) => f.density))),
    mean_velocity: r2(avg(window.filter((f) => f.noteCount).map((f) => f.meanVelocity))),
    rest_ratio: r2(avg(window.map((f) => f.restRatio))),
    repetition: r2(avg(window.map((f) => f.repetition))),
    register: reg === null ? null : reg < 60 ? "low" : reg > 84 ? "high" : "mid",
    trend: delta > 0.12 ? "rising" : delta < -0.12 ? "falling" : "steady",
    silent_bars: silent,
  };
}

/** Collects live note on/off in absolute beats and cuts them into bars. */
export class NoteTracker {
  private open = new Map<number, { beat: number; vel: number }>();
  private closed: { start: number; end: number; note: number; vel: number }[] = [];

  noteOn(beat: number, note: number, vel: number): void {
    if (this.open.has(note)) this.noteOff(beat, note);
    this.open.set(note, { beat, vel });
  }

  noteOff(beat: number, note: number): void {
    const o = this.open.get(note);
    if (!o) return;
    this.open.delete(note);
    this.closed.push({ start: o.beat, end: Math.max(beat, o.beat), note, vel: o.vel });
  }

  /** Notes overlapping [barStart, barStart + beatsPerBar), relative to barStart. Held notes run to the bar end. */
  bar(barStart: number, beatsPerBar: number): PlayedNote[] {
    const end = barStart + beatsPerBar;
    const out: PlayedNote[] = [];
    for (const n of this.closed) if (n.end > barStart && n.start < end) out.push({ start: n.start - barStart, dur: n.end - n.start, note: n.note, vel: n.vel });
    for (const [note, o] of this.open) if (o.beat < end) out.push({ start: o.beat - barStart, dur: end - o.beat, note, vel: o.vel });
    // Drop what can no longer matter.
    this.closed = this.closed.filter((n) => n.end > barStart);
    return out;
  }
}
