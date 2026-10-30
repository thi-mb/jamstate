// A pretend keyboard player, for testing the band without hardware and for
// the demo script (sparse → busy → silent). Seeded, so runs are repeatable.

import type { BarPlan } from "./engine";
import type { PlayedNote } from "./features";
import { chordTones, parseChord } from "./theory";

export type SimMode = "silent" | "sparse" | "medium" | "busy";
export const SIM_MODES: SimMode[] = ["silent", "sparse", "medium", "busy"];

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimPlayer {
  private rand: () => number;
  constructor(seed = 7) {
    this.rand = rng(seed);
  }

  play(plan: BarPlan, mode: SimMode, beatsPerBar: number): PlayedNote[] {
    if (mode === "silent") return [];
    const chord = parseChord(plan.chords[0]);
    const tones = chordTones(chord, 64, 84);
    const pick = () => tones[Math.floor(this.rand() * tones.length)];
    const notes: PlayedNote[] = [];
    if (mode === "sparse") {
      const n = 1 + Math.floor(this.rand() * 2);
      for (let i = 0; i < n; i++) notes.push({ start: i * (beatsPerBar / n), dur: 1.5, note: pick(), vel: 45 + Math.floor(this.rand() * 15) });
    } else {
      const step = mode === "busy" ? 0.25 : 1;
      const base = mode === "busy" ? 100 : 72;
      for (let t = 0; t < beatsPerBar - 1e-9; t += step) {
        if (mode === "busy" && this.rand() < 0.15) continue;
        notes.push({ start: t, dur: step * 0.9, note: pick(), vel: Math.min(127, base + Math.floor(this.rand() * 20)) });
      }
    }
    return notes;
  }
}

/** "sparse:8,busy:8,silent:8" → per-bar modes. */
export function parseScript(script: string): SimMode[] {
  const out: SimMode[] = [];
  for (const part of script.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [mode, bars] = part.split(":");
    if (!SIM_MODES.includes(mode as SimMode)) throw new Error(`Unknown player mode "${mode}"`);
    const n = Number(bars ?? 1);
    if (!Number.isInteger(n) || n < 1) throw new Error(`Bad bar count in "${part}"`);
    for (let i = 0; i < n; i++) out.push(mode as SimMode);
  }
  return out;
}

export const DEMO_SCRIPT = "medium:4,sparse:8,busy:12,silent:8,busy:8";
