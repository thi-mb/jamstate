// A pretend keyboard player, for testing the band without hardware, for the
// demo script (sparse → busy → silent) and for the leader eval's scenarios
// (docs/eval/scenarios.md). Seeded, so runs are repeatable.

import type { BarPlan } from "./engine";
import type { PlayedNote } from "./features";
import { rng } from "./rand";
import { chordTones, parseChord } from "./theory";

export { rng };

export type SimMode =
  | "silent"
  | "sparse"
  | "medium"
  | "busy"
  // Eval modes (v0.3).
  | "held"
  | "crescendo"
  | "decrescendo"
  | "outside"
  | "riff"
  | "syncopated"
  | "push"
  | "layback"
  | "rush"
  | "drag";
export const SIM_MODES: SimMode[] = ["silent", "sparse", "medium", "busy", "held", "crescendo", "decrescendo", "outside", "riff", "syncopated", "push", "layback", "rush", "drag"];
/** The modes the page's Pretend player menu offers. */
export const PAGE_SIM_MODES: SimMode[] = ["silent", "sparse", "medium", "busy"];

export interface SimContext {
  /** The band's tempo for this bar. */
  bpm: number;
  /** The chart's tempo: what a rushing or dragging player rushes or drags from. */
  chartBpm: number;
  phraseBars: number;
}

/** Push and lay back: this far ahead of / behind the band, in seconds. */
export const FEEL_OFFSET_S = 0.04;
/** Rush and drag: the player's own tempo against the band's. */
export const RUSH_RATIO = 1.03;
/** A rushing or dragging player who drifts this far (beats) from the band hears it and jumps back. */
const RESYNC_BEATS = 0.25;

export class SimPlayer {
  private rand: () => number;
  private riff: PlayedNote[] | null = null;
  /** Rush/drag: how far the player has drifted from the band, in beats (negative = ahead). */
  private drift = 0;

  constructor(seed = 7) {
    this.rand = rng(seed);
  }

  play(plan: BarPlan, mode: SimMode, beatsPerBar: number, sim: SimContext = { bpm: 120, chartBpm: 120, phraseBars: 4 }): PlayedNote[] {
    if (mode !== "rush" && mode !== "drag") this.drift = 0;
    if (mode === "silent") return [];
    const chord = parseChord(plan.chords[0]);
    const tones = chordTones(chord, 64, 84);
    const pick = () => tones[Math.floor(this.rand() * tones.length)];
    const vel = (base: number, spread: number) => Math.min(127, base + Math.floor(this.rand() * spread));
    const notes: PlayedNote[] = [];
    const grid = (step: number, base: number, spread: number, skip = 0) => {
      for (let t = 0; t < beatsPerBar - 1e-9; t += step) {
        if (skip && this.rand() < skip) continue;
        notes.push({ start: t, dur: step * 0.9, note: pick(), vel: vel(base, spread) });
      }
    };
    switch (mode) {
      case "sparse": {
        const n = 1 + Math.floor(this.rand() * 2);
        for (let i = 0; i < n; i++) notes.push({ start: i * (beatsPerBar / n), dur: 1.5, note: pick(), vel: vel(45, 15) });
        return notes;
      }
      case "medium":
        grid(1, 72, 20);
        return notes;
      case "busy":
        grid(0.25, 100, 20, 0.15);
        return notes;
      case "held": {
        // One or two long, soft notes: a lyrical, sustained line.
        const n = 1 + Math.floor(this.rand() * 2);
        for (let i = 0; i < n; i++) notes.push({ start: i * (beatsPerBar / n), dur: (beatsPerBar / n) * 0.95, note: pick(), vel: vel(48, 10) });
        return notes;
      }
      case "crescendo":
      case "decrescendo": {
        // Steady eighths; velocity ramps across the phrase (about 50 → 110).
        const inPhrase = plan.barInSection % sim.phraseBars;
        const span = sim.phraseBars * beatsPerBar;
        for (let t = 0; t < beatsPerBar - 1e-9; t += 0.5) {
          const x = (inPhrase * beatsPerBar + t) / span;
          const v = 50 + 60 * (mode === "crescendo" ? x : 1 - x);
          notes.push({ start: t, dur: 0.45, note: pick(), vel: Math.round(v + this.rand() * 6) });
        }
        return notes;
      }
      case "outside": {
        // Medium density on the flat 2nd and flat 6th of the chord: outside the chord and every genre's usual scale.
        const outside = [1, 8].map((i) => (chord.root + i) % 12);
        for (let t = 0; t < beatsPerBar - 1e-9; t += 1) {
          const pc = outside[Math.floor(this.rand() * outside.length)];
          notes.push({ start: t, dur: 0.9, note: 64 + ((pc - 64 + 1200) % 12) + (this.rand() < 0.5 ? 0 : 12), vel: vel(72, 20) });
        }
        return notes;
      }
      case "riff": {
        // One bar, worked out once and repeated exactly.
        if (!this.riff) {
          const r: PlayedNote[] = [];
          for (const t of [0, 0.75, 1.5, 2, 2.75, 3.5].filter((t) => t < beatsPerBar)) r.push({ start: t, dur: 0.4, note: pick(), vel: vel(85, 15) });
          this.riff = r;
        }
        return this.riff.map((n) => ({ ...n }));
      }
      case "syncopated":
        // Off-beat sixteenths, nothing on the beat.
        for (let b = 0; b < beatsPerBar; b++)
          for (const off of [0.25, 0.75]) if (this.rand() < 0.85) notes.push({ start: b + off, dur: 0.2, note: pick(), vel: vel(82, 18) });
        return notes;
      case "push":
      case "layback": {
        // Medium, every onset the same small time ahead of or behind the band.
        const shift = ((mode === "push" ? -1 : 1) * FEEL_OFFSET_S * sim.bpm) / 60;
        grid(1, 72, 20);
        return notes.map((n) => ({ ...n, start: n.start + shift }));
      }
      case "rush":
      case "drag": {
        // The player keeps their own, slightly faster or slower, tempo and
        // drifts against the band's; once off by a quarter beat they hear it
        // and jump back with the band.
        const playerBpm = (mode === "rush" ? RUSH_RATIO : 1 / RUSH_RATIO) * sim.chartBpm;
        const k = sim.bpm / playerBpm - 1; // band beats per player beat, minus one
        grid(1, 72, 20);
        const out = notes.map((n) => ({ ...n, start: n.start + this.drift + n.start * k }));
        this.drift += beatsPerBar * k;
        if (Math.abs(this.drift) > RESYNC_BEATS) this.drift = 0;
        return out;
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
