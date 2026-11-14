// The calibration screen's arithmetic (v0.5, ADR-0023): from a few seconds
// of silence, soft playing and hard playing, the noise gate and the levels
// that map to velocity; from playing along to clicks, the input latency.

import type { Calibration } from "./listener";

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = q * (s.length - 1);
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
};

export interface LevelTake {
  /** The listener's level (dBFS) every hop while the step ran. */
  levels: number[];
  /** Peaks of the onsets it heard. */
  peaks: number[];
}

/**
 * Gate 8 dB over the silence's loud end (never under -80 or over -30); soft
 * and hard from the median onset peaks of each step (the loud end of the
 * level when it heard no onsets), at least 6 dB apart.
 */
export function calibrateLevels(silence: number[], soft: LevelTake, hard: LevelTake, base: Calibration): Calibration {
  const noise = quantile(silence, 0.95);
  const gateDb = Math.round(Math.max(-80, Math.min(-30, (Number.isFinite(noise) ? noise : base.gateDb - 8) + 8)));
  const peak = (t: LevelTake) => (t.peaks.length ? quantile(t.peaks, 0.5) : quantile(t.levels, 0.9));
  let softDb = peak(soft);
  let hardDb = peak(hard);
  if (!Number.isFinite(softDb)) softDb = base.softDb;
  if (!Number.isFinite(hardDb)) hardDb = base.hardDb;
  softDb = Math.max(softDb, gateDb + 3);
  if (hardDb < softDb + 6) hardDb = softDb + 6;
  return { ...base, gateDb, softDb: Math.round(softDb), hardDb: Math.round(hardDb) };
}

/**
 * Input latency from playing along to clicks: each click's nearest onset
 * within 250 ms, the median offset, less the output latency (the player
 * heard each click that much late). Null with fewer than four answers.
 */
export function latencyFromTaps(clicks: number[], onsets: number[], outputLatency: number): number | null {
  const offsets: number[] = [];
  for (const c of clicks) {
    const near = onsets.filter((o) => Math.abs(o - c - 0.05) <= 0.2);
    if (near.length) offsets.push(near.reduce((b, o) => (Math.abs(o - c) < Math.abs(b - c) ? o : b)) - c);
  }
  if (offsets.length < 4) return null;
  return Math.max(0, Math.min(0.15, quantile(offsets, 0.5) - outputLatency));
}
