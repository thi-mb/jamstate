// The loop/layer bank (mid layer, v0). Each part has four layers keyed by
// intensity level (vertical layering) and three feels. Bars are memoized,
// so after the first pass through a section every lookup is a cache hit.

import type { Chart, ChordSlot } from "./chart";
import { bassNote, voiceChord, type Chord } from "./theory";
import { clamp, type Feel, type NoteEvent, type Part } from "./types";

/** General MIDI drum map, so MIDI out lands on the right pads in a DAW. */
export const DRUM = {
  kick: 36,
  stick: 37,
  snare: 38,
  hat: 42,
  openHat: 46,
  tomLo: 45,
  tomMid: 47,
  tomHi: 50,
  crash: 49,
} as const;

const vel = (v: number) => Math.round(clamp(v, 1, 127));

function drum(start: number, note: number, v: number, dur = 0.1): NoteEvent {
  return { start, dur, note, vel: vel(v), part: "drums" };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export function drumBar(level: number, feel: Feel, bpb: number, variant = 0): NoteEvent[] {
  const ev: NoteEvent[] = [];
  const base = 58 + 14 * level;
  const half = Math.floor(bpb / 2);

  // Kick
  let kicks: number[];
  if (feel === "half_time") kicks = level >= 2 ? [0, bpb - 1.5] : [0];
  else if (feel === "double_time") kicks = level >= 1 ? range(bpb) : [0, half];
  else {
    kicks = level === 0 ? [0] : bpb >= 4 ? [0, half] : [0];
    if (level >= 2 && half + 0.5 < bpb) kicks.push(half + 0.5);
    if (level >= 3 || (level === 2 && variant === 1)) kicks.push(1.5);
  }
  for (const k of kicks) ev.push(drum(k, DRUM.kick, base + 8));

  // Snare / backbeat
  let backbeats: number[];
  if (feel === "half_time") backbeats = [bpb >= 3 ? half : bpb - 1];
  else if (feel === "double_time") backbeats = range(bpb).map((b) => b + 0.5);
  else backbeats = range(bpb).filter((b) => b % 2 === 1);
  const snare = level === 0 ? DRUM.stick : DRUM.snare;
  for (const b of backbeats) ev.push(drum(b, snare, base + 4));
  if (level >= 2 && feel === "normal" && backbeats.length) ev.push(drum(backbeats[0] + 0.75, DRUM.snare, 34));

  // Hats: quarters → eighths → sixteenths as intensity rises; feel shifts density.
  const density = clamp(level + (feel === "half_time" ? -1 : feel === "double_time" ? 1 : 0), 0, 3);
  const step = density === 0 ? 1 : density === 3 ? 0.25 : 0.5;
  for (let t = 0; t < bpb - 1e-9; t += step) {
    const onBeat = Math.abs(t - Math.round(t)) < 1e-9;
    const isLast8th = Math.abs(t - (bpb - 0.5)) < 1e-9;
    if (level >= 3 && isLast8th) ev.push(drum(t, DRUM.openHat, base, 0.4));
    else ev.push(drum(t, DRUM.hat, onBeat ? base - 6 : base - 20, 0.05));
  }
  return ev;
}

/** Replace the tail of a drum bar with a tom/snare fill (one beat, two at level 3). */
export function withFill(events: NoteEvent[], bpb: number, level: number): NoteEvent[] {
  const beats = level >= 3 ? 2 : 1;
  const from = bpb - beats;
  const kept = events.filter((e) => e.start < from || e.note === DRUM.kick);
  const step = level >= 2 ? 0.25 : 0.5;
  const toms = [DRUM.snare, DRUM.tomHi, DRUM.tomMid, DRUM.tomLo];
  const n = Math.round(beats / step);
  const fill = range(n).map((i) => {
    const note = toms[Math.floor((i * toms.length) / n)]; // snare, then down the toms
    return drum(from + i * step, note, 70 + (45 * i) / n);
  });
  return [...kept, ...fill];
}

export function crashHit(level: number): NoteEvent[] {
  return [drum(0, DRUM.crash, 80 + 10 * level, 2), drum(0, DRUM.kick, 90 + 8 * level)];
}

/** A snare roll over the bar that builds into the next downbeat. */
export function riser(bpb: number): NoteEvent[] {
  const ev: NoteEvent[] = [];
  for (let t = 0; t < bpb - 1e-9; t += t < bpb / 2 ? 0.5 : 0.25) ev.push(drum(t, DRUM.snare, 35 + (85 * t) / bpb));
  return ev;
}

function bassEvent(start: number, dur: number, note: number, v: number): NoteEvent {
  return { start, dur, note, vel: vel(v), part: "bass" };
}

/** Feel changes rhythmic density for pitched parts: half time thins, double time fills. */
function rhythmLevel(level: number, feel: Feel): number {
  return clamp(level + (feel === "half_time" ? -1 : feel === "double_time" ? 1 : 0), 0, 3);
}

export function bassBar(slots: ChordSlot[], next: Chord | null, level: number, feel: Feel, bpb: number): NoteEvent[] {
  const ev: NoteEvent[] = [];
  const r = rhythmLevel(level, feel);
  for (const { start, dur, chord } of slots) {
    const root = bassNote(chord);
    if (r === 0) ev.push(bassEvent(start, dur * 0.95, root, 72));
    else if (r === 1) for (let t = 0; t < dur - 1e-9; t += 2) ev.push(bassEvent(start + t, Math.min(1.6, dur - t), root, 82));
    else
      for (let t = 0; t < dur - 1e-9; t += 0.5) {
        const onBeat = Math.abs(t - Math.round(t)) < 1e-9;
        let note = root;
        if (r === 3 && !onBeat) note = root + 12;
        if (onBeat && Math.round(t) === 2) note = root + 7;
        ev.push(bassEvent(start + t, 0.42, note, onBeat ? 92 : 68));
      }
  }
  // Approach the next chord from a semitone below on the last eighth.
  if (level >= 2 && next) {
    const target = bassNote(next);
    const lastRoot = bassNote(slots[slots.length - 1].chord);
    if (target !== lastRoot) {
      const at = bpb - 0.5;
      const kept = ev.filter((e) => e.start < at - 1e-9);
      return [...kept, bassEvent(at, 0.42, target - 1, 80)];
    }
  }
  return ev;
}

export function chordBar(slots: ChordSlot[], level: number, feel: Feel): NoteEvent[] {
  const ev: NoteEvent[] = [];
  const r = rhythmLevel(level, feel);
  for (const { start, dur, chord } of slots) {
    const notes = voiceChord(chord);
    let hits: [number, number, number][]; // [offset, duration, velocity]
    if (r === 0) hits = [[0, dur * 0.98, 54]];
    else if (r === 1) hits = range(Math.ceil(dur / 2)).map((k) => [k * 2, Math.min(1.9, dur - k * 2), 64]);
    else {
      const pattern = r === 2 ? [0, 1.5] : [0, 0.5, 1.5];
      hits = [];
      for (let k = 0; k < dur - 1e-9; k += 2)
        for (const p of pattern) if (k + p < dur - 1e-9) hits.push([k + p, r === 2 ? 0.45 : 0.3, r === 2 ? 72 : 84]);
    }
    // At the top level, double the root above the voicing for some sparkle.
    let top = notes[notes.length - 1] + 1;
    while (top % 12 !== chord.root) top++;
    const voiced = r === 3 ? [...notes, top] : notes;
    for (const [off, d, v] of hits)
      for (const note of voiced) ev.push({ start: start + off, dur: d, note, vel: vel(v), part: "chords" });
  }
  return ev;
}

export class LoopBank {
  private cache = new Map<string, NoteEvent[]>();
  constructor(readonly chart: Chart) {}

  /** The bar for one part. `barIndex` is the bar within the section (wraps for extensions). */
  bar(part: Part, section: string, barIndex: number, level: number, feel: Feel, next: Chord | null): NoteEvent[] {
    const s = this.chart.sections.get(section);
    if (!s) throw new Error(`No section "${section}"`);
    const idx = barIndex % s.bars;
    const variant = idx % 2;
    const key = `${part}|${section}|${idx}|${level}|${feel}|${part === "bass" ? next?.symbol ?? "-" : ""}|${part === "drums" ? variant : ""}`;
    let hit = this.cache.get(key);
    if (!hit) {
      const bpb = this.chart.beatsPerBar;
      const slots = s.barChords(idx);
      hit =
        part === "drums"
          ? drumBar(level, feel, bpb, variant)
          : part === "bass"
            ? bassBar(slots, next, level, feel, bpb)
            : chordBar(slots, level, feel);
      this.cache.set(key, hit);
    }
    return hit;
  }

  get size(): number {
    return this.cache.size;
  }
}
