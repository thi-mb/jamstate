import { describe, expect, it } from "vitest";
import { defaultBand } from "../src/core/band";
import { loadChart, type ChartJSON } from "../src/core/chart";
import { Engine } from "../src/core/engine";
import type { PlayedNote } from "../src/core/features";
import { getGenre } from "../src/core/genres";
import { replaySession, SessionRecorder } from "../src/core/session";
import { FOLLOW_RANGE, FOLLOW_STEP, TempoFollower } from "../src/core/tempo";
import { Transport, type Sink } from "../src/core/transport";
import { V01_PARTS } from "../src/core/types";
import nightShift from "../public/charts/night-shift.json";

/** One bar of quarter notes from a player whose beat lasts `ratio` band beats. */
const bar = (ratio: number): PlayedNote[] => [0, 1, 2, 3].map((k) => ({ start: k * ratio, dur: 0.5, note: 60, vel: 90 }));

/** Run the follower for `n` bars against a player at `playerBpm`; the band's tempo after each bar. */
function follow(chartBpm: number, playerBpm: number, n: number): number[] {
  const f = new TempoFollower(chartBpm);
  let band = chartBpm;
  const bars: PlayedNote[][] = [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    bars.push(bar(band / playerBpm));
    band = f.next(band, bars, 4);
    out.push(band);
  }
  return out;
}

describe("tempo follower", () => {
  it("keeps the tempo for a steady player", () => {
    expect(follow(100, 100, 12).every((b) => b === 100)).toBe(true);
  });

  it("moves toward a dragging player, at most 1% a bar", () => {
    const t = follow(100, 98, 16);
    let prev = 100;
    for (const b of t) {
      expect(Math.abs(b - prev)).toBeLessThanOrEqual(prev * FOLLOW_STEP + 1e-9);
      prev = b;
    }
    expect(t[t.length - 1]).toBeLessThan(99);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(97.5);
  });

  it("never goes more than 5% from the chart tempo", () => {
    const t = follow(100, 120, 40);
    expect(Math.max(...t)).toBeLessThanOrEqual(100 * (1 + FOLLOW_RANGE) + 1e-9);
    expect(t[t.length - 1]).toBeGreaterThan(104);
  });

  it("does nothing without enough notes", () => {
    const f = new TempoFollower(100);
    expect(f.next(100, [[{ start: 0, dur: 1, note: 60, vel: 90 }]], 4)).toBe(100);
    expect(f.next(100, [[], []], 4)).toBe(100);
  });
});

describe("band tempo", () => {
  const json = nightShift as ChartJSON;
  const chart = loadChart(json);

  it("changes from the next bar and is recorded for replay", async () => {
    const setup = { chart: json, genre: "funk", swing: null, band: defaultBand(V01_PARTS), seed: 1, countIn: 0, config: {}, leader: "none", everyBars: 1, listening: "none" };
    const rec = new SessionRecorder(setup);
    const e = new Engine(chart, { seed: 1, genre: getGenre("funk"), countIn: 0, band: setup.band });
    const bpms: number[] = [];
    for (let b = 0; b < 8; b++) {
      const p = e.nextBar()!;
      rec.bar(p);
      bpms.push(p.bpm);
      if (b === 3) e.setTempo(chart.bpm + 2);
    }
    expect(bpms.slice(0, 4)).toEqual(Array(4).fill(chart.bpm));
    expect(bpms.slice(4)).toEqual(Array(4).fill(chart.bpm + 2));
    const f = rec.finish(e);
    expect(f.controls.filter((c) => c.kind === "tempo")).toEqual([{ at: 3, kind: "tempo", bpm: chart.bpm + 2 }]);
    expect((await replaySession(f)).mismatches).toEqual([]);
  });

  it("the transport times each bar at its own tempo", () => {
    const short: ChartJSON = { title: "t", bpm: 120, time_sig: "4/4", genre: "funk", sections: [{ name: "a", bars: 8, chords: ["C"] }], form: ["a"] };
    const e = new Engine(loadChart(short), { countIn: 0 });
    let now = 0;
    const sink: Sink = { play: () => {}, panic: () => {} };
    const t = new Transport(e, { now: () => now }, sink, {}, { lookahead: 0.1, startDelay: 0 });
    t.start();
    // Bar 0 is committed at 120 bpm; from bar 1 on the band plays at 60.
    e.setTempo(60);
    for (; now < 8; now += 0.025) t.tick();
    expect(t.timeAt(4)).toBeCloseTo(2);
    expect(t.timeAt(8)).toBeCloseTo(6);
    expect(t.beatAt(5)).toBeCloseTo(7);
    expect(t.secondsPerBeat).toBeCloseTo(1);
  });
});
