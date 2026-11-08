// Follow my tempo (v0.3, opt-in). The band keeps the chart's tempo unless the
// player turns this on; then it follows how the player's beat drifts against
// the band's, smoothed, within ±5% of the chart tempo, at most 1% per bar,
// and only on bar lines (the engine applies a new tempo from the next bar).

import { driftOf } from "./listening";
import type { PlayedNote } from "./features";

/** The band never goes further than this from the chart tempo. */
export const FOLLOW_RANGE = 0.05;
/** Largest change from one bar to the next. */
export const FOLLOW_STEP = 0.01;
/** Smoothing of the heard tempo (share of the new estimate per bar). */
const SMOOTH = 0.35;
/** Differences smaller than this (share of the tempo) are left alone. */
const DEADBAND = 0.004;
/** Bars of drift to listen over. */
export const FOLLOW_BARS = 2;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export class TempoFollower {
  private heard: number | null = null;

  constructor(readonly chartBpm: number) {}

  /** After a bar: the band's tempo now and the player's last bars (band beats); returns the tempo for the next bar. */
  next(bandBpm: number, bars: PlayedNote[][], beatsPerBar: number): number {
    const drift = driftOf(bars.slice(-FOLLOW_BARS), beatsPerBar);
    if (drift === null) return bandBpm;
    // A player beat lasts (1 + drift) band beats.
    const player = bandBpm / (1 + drift);
    this.heard = this.heard === null ? player : this.heard + SMOOTH * (player - this.heard);
    const goal = clamp(this.heard, this.chartBpm * (1 - FOLLOW_RANGE), this.chartBpm * (1 + FOLLOW_RANGE));
    if (Math.abs(goal - bandBpm) < bandBpm * DEADBAND) return bandBpm;
    const step = clamp(goal - bandBpm, -bandBpm * FOLLOW_STEP, bandBpm * FOLLOW_STEP);
    // Rounded toward the band's tempo, so the step never goes past the limit.
    return Math.round(bandBpm * 100 + Math.trunc(step * 100)) / 100;
  }

  reset(): void {
    this.heard = null;
  }
}
