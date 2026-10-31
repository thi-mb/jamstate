// Feel: the time and velocity changes applied to a generated bar after the
// notes are chosen. Swing moves off-beats later, humanize nudges each part
// ahead of or behind the beat, and a ritardando slows the last bar of a song.
// Generators always write on the straight grid; this is the only place that
// bends time, so a future generator on the Spark gets the same feel for free.

import type { DrumLine, HumanizePart } from "./genre";
import { clamp, type NoteEvent, type Part } from "./types";

/**
 * Largest timing offset humanize may add, in ms. Bars are committed a beat
 * minus the lookahead (100 ms) before they start (ADR-0005), so an event can
 * be pulled at most this far ahead of its bar and still be scheduled on time.
 */
export const MAX_OFFSET_MS = 30;

/**
 * Where an off-beat lands. `swing` 0 is straight (the off-beat halfway), 0.66
 * is triplet swing (two thirds of the way), 1 is dotted (three quarters).
 * `unit` 8 swings eighth notes, 16 swings sixteenths.
 */
export function swingTime(t: number, swing: number, unit: 8 | 16): number {
  if (swing <= 0) return t;
  const pair = unit === 8 ? 1 : 0.5;
  const k = Math.floor(t / pair + 1e-9);
  const ph = t / pair - k;
  const p = 0.5 + swing / 4;
  const warped = ph <= 0.5 ? ph * (p / 0.5) : p + (ph - 0.5) * ((1 - p) / 0.5);
  return (k + warped) * pair;
}

/**
 * Ritardando over one bar: the tempo falls linearly from 100% to (1 − r) by
 * the bar line, then holds. Maps straight beats to slowed beats.
 */
export function ritTime(t: number, bpb: number, r: number): number {
  if (r <= 0) return t;
  const end = (-bpb / r) * Math.log(1 - r);
  if (t <= bpb) return (-bpb / r) * Math.log(1 - (r * t) / bpb);
  return end + (t - bpb) / (1 - r);
}

const DRUM_LINE_OF: Record<number, DrumLine> = {
  36: "kick", 38: "snare", 37: "stick", 39: "clap", 42: "cymbal", 46: "cymbal", 51: "cymbal", 53: "cymbal",
  44: "pedal", 50: "tom_hi", 47: "tom_mid", 45: "tom_lo", 49: "crash",
};

export interface FeelOptions {
  swing: number;
  unit: 8 | 16;
  bpm: number;
  humanize?: HumanizePart;
  rand: () => number;
}

/** Swing and humanize one part's bar. Returns new events; the input is not changed. */
export function applyFeel(events: NoteEvent[], part: Part, o: FeelOptions): NoteEvent[] {
  const msToBeats = (ms: number) => (ms / 1000) * (o.bpm / 60);
  const h = o.humanize;
  // Chord rolls: notes struck together, spread low to high.
  const rollIndex = new Map<NoteEvent, number>();
  const rollSize = new Map<number, number>();
  if (h && h.spreadMs > 0) {
    const groups = new Map<number, NoteEvent[]>();
    for (const e of events) groups.set(e.start, [...(groups.get(e.start) ?? []), e]);
    for (const [start, g] of groups) {
      g.sort((a, b) => a.note - b.note).forEach((e, i) => rollIndex.set(e, i));
      rollSize.set(start, g.length);
    }
  }
  // One random draw per onset, so a chord's notes move together.
  const onsetJitter = new Map<number, number>();
  return events.map((e) => {
    let start = swingTime(e.start, o.swing, o.unit);
    const end = swingTime(e.start + e.dur, o.swing, o.unit);
    let dur = Math.max(0.02, end - start);
    let vel = e.vel;
    if (h) {
      let ms = h.offsetMs;
      if (part === "drums") ms += h.lines[DRUM_LINE_OF[e.note]] ?? 0;
      if (!onsetJitter.has(e.start)) onsetJitter.set(e.start, (o.rand() * 2 - 1) * h.jitterMs);
      ms += part === "drums" ? (o.rand() * 2 - 1) * h.jitterMs : onsetJitter.get(e.start)!;
      const n = rollSize.get(e.start) ?? 1;
      if (n > 1) ms += (rollIndex.get(e)! / (n - 1)) * h.spreadMs;
      ms = clamp(ms, -MAX_OFFSET_MS, MAX_OFFSET_MS);
      start += msToBeats(ms);
      dur = Math.max(0.02, dur - (n > 1 ? msToBeats(Math.max(0, ms - h.offsetMs)) : 0));
      vel = Math.round(clamp(vel + (o.rand() * 2 - 1) * h.velocity, 1, 127));
    }
    return { ...e, start, dur, vel };
  });
}

/** Slow the bar down with a ritardando (ending bars). */
export function applyRit(events: NoteEvent[], bpb: number, r: number): NoteEvent[] {
  if (r <= 0) return events;
  return events.map((e) => {
    const start = ritTime(e.start, bpb, r);
    return { ...e, start, dur: Math.max(0.02, ritTime(e.start + e.dur, bpb, r) - start) };
  });
}
