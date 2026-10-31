// Step patterns, the shared notation of the genre packs.
//
// A pattern is a row of steps on a grid (`grid` steps per beat). Drum lines
// use one character per step ("x..gx..."); bass and comping use
// space-separated tokens ("R - 5 . A"), since a bass degree can be two
// characters. Spaces and "|" in drum lines are ignored, so bars can be
// grouped for reading. `-` holds the previous note one more step and `.` is
// a rest.

import type { Feel } from "./types";

/** One step of a pattern placed in the bar, after the feel stretch. */
export interface Step {
  /** Index in the pattern row. */
  index: number;
  token: string;
  /** Beats from the start of the bar. */
  start: number;
  /** Beats, including any `-` holds that follow. */
  dur: number;
}

/** Split a drum line into one character per step. */
export function drumSteps(line: string): string[] {
  return [...line.replace(/[\s|]/g, "")];
}

/** Split a bass or comping row into tokens. */
export function tokenSteps(row: string): string[] {
  return row.trim().split(/[\s|]+/).filter(Boolean);
}

/**
 * Place a row of tokens in a bar of `bpb` beats. A row shorter than the bar
 * repeats; a longer one is cut. The feel stretches time: half time plays the
 * first half of the row over the whole bar, double time plays the row twice
 * as fast and keeps only notes on the sixteenth grid.
 */
export function placeSteps(tokens: string[], grid: number, bpb: number, feel: Feel = "normal"): Step[] {
  if (!tokens.length) return [];
  const scale = feel === "half_time" ? 2 : feel === "double_time" ? 0.5 : 1;
  const stepBeats = (1 / grid) * scale;
  const total = Math.round(bpb / stepBeats);
  const out: Step[] = [];
  for (let i = 0; i < total; i++) {
    const index = i % tokens.length;
    const token = tokens[index];
    if (token === "." || token === "-") continue;
    let holds = 0;
    while (i + holds + 1 < total && tokens[(i + holds + 1) % tokens.length] === "-") holds++;
    const start = i * stepBeats;
    if (feel === "double_time" && Math.abs(start * 4 - Math.round(start * 4)) > 1e-6) continue;
    out.push({ index, token, start, dur: (holds + 1) * stepBeats });
  }
  return out;
}
