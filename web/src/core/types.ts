/**
 * Part roles the engine has a generator for. A genre's lineup is a subset of
 * these, and the engine only ever walks the lineup, so a new role (v0.2) is a
 * new entry here plus a generator in groove.ts.
 */
export const PARTS = ["drums", "bass", "chords"] as const;
export const ROLES = PARTS;
export type Part = (typeof PARTS)[number];

export const FEELS = ["normal", "half_time", "double_time"] as const;
export type Feel = (typeof FEELS)[number];

export const STINGERS = ["fill", "crash", "riser"] as const;
export type Stinger = (typeof STINGERS)[number];

/** Anything the scheduler can play. `part: "player"` is the human. */
export type Voice = Part | "player";

/**
 * A note in musical time. `start` and `dur` are in beats from the start of its
 * bar. After swing and humanize, `start` can sit a few milliseconds before 0
 * (a pushed hat) or past the bar's end (a laid-back bass note or an ending's
 * ring-out).
 */
export interface NoteEvent {
  start: number;
  dur: number;
  note: number;
  vel: number;
  part: Voice;
}

/** Intensity 0–1 maps onto four layer levels. */
export const LEVELS = 4;

export function levelFor(intensity: number): number {
  return Math.max(0, Math.min(LEVELS - 1, Math.floor(intensity * LEVELS)));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
