import { describe, expect, it } from "vitest";
import type { ChartJSON } from "../src/core/chart";
import { ruleLeader } from "../src/core/conductor";
import { Engine } from "../src/core/engine";
import { runScenario } from "../src/core/eval/run";
import { judge, RunView, SCENARIOS, scenariosFor, scoreOf, songShape, type Song } from "../src/core/eval/scenarios";
import { loadChart } from "../src/core/chart";
import { RuleLeader } from "../src/core/rules";
import { SimPlayer, type SimMode } from "../src/core/simplayer";
import { chordTones, parseChord } from "../src/core/theory";

import bluesInA from "../public/charts/blues-in-a.json";
import lateSet from "../public/charts/late-set.json";
import nightShift from "../public/charts/night-shift.json";

const CHARTS: Record<string, ChartJSON> = { "night-shift": nightShift as ChartJSON, "blues-in-a": bluesInA as ChartJSON, "late-set": lateSet as ChartJSON };
const song = (id: string): Song => ({ id, chart: CHARTS[id], genre: CHARTS[id].genre! });
const SONGS = ["night-shift", "blues-in-a", "late-set"].map(song);

/** A few bars of one mode on Night Shift. */
function playMode(mode: SimMode, bars = 4) {
  const c = loadChart(song("night-shift").chart);
  const engine = new Engine(c, { seed: 3 });
  const sim = new SimPlayer(9);
  const out = [];
  for (let i = 0; i < bars; i++) {
    const p = engine.nextBar()!;
    out.push({ plan: p, notes: sim.play(p, mode, 4, { bpm: 112, chartBpm: 112, phraseBars: 4 }) });
  }
  return out;
}

describe("eval player modes", () => {
  it("old modes are unchanged by the new ones (same seed, same notes)", () => {
    const a = playMode("busy").map((b) => b.notes);
    const b = playMode("busy").map((b) => b.notes);
    expect(a).toEqual(b);
    expect(a[0].length).toBeGreaterThan(8);
  });

  it("crescendo ramps velocity across the phrase, decrescendo the other way", () => {
    const up = playMode("crescendo").flatMap((b) => b.notes.map((n) => n.vel));
    const down = playMode("decrescendo").flatMap((b) => b.notes.map((n) => n.vel));
    expect(up[up.length - 1] - up[0]).toBeGreaterThan(40);
    expect(down[0] - down[down.length - 1]).toBeGreaterThan(40);
  });

  it("outside notes are never chord tones", () => {
    for (const { plan, notes } of playMode("outside")) {
      const pcs = new Set(chordTones(parseChord(plan.chords[0]), 0, 127).map((n) => n % 12));
      for (const n of notes) expect(pcs.has(n.note % 12)).toBe(false);
    }
  });

  it("riff repeats one bar exactly", () => {
    const bars = playMode("riff").map((b) => b.notes);
    expect(bars[1]).toEqual(bars[0]);
    expect(bars[3]).toEqual(bars[0]);
  });

  it("syncopated plays nothing on the beat", () => {
    for (const { notes } of playMode("syncopated")) for (const n of notes) expect(n.start % 1).not.toBe(0);
  });

  it("push and lay back sit 40 ms off the beat", () => {
    const push = playMode("push")[0].notes;
    const back = playMode("layback")[0].notes;
    expect(push[0].start).toBeCloseTo((-0.04 * 112) / 60, 5);
    expect(back[0].start).toBeCloseTo((0.04 * 112) / 60, 5);
  });

  it("rush drifts ahead, bar by bar, and jumps back once a quarter beat off", () => {
    const bars = playMode("rush", 8).map((b) => b.notes);
    const firstOnsets = bars.map((ns) => ns[0].start);
    expect(firstOnsets[0]).toBe(0);
    expect(firstOnsets[1]).toBeLessThan(0);
    expect(firstOnsets[2]).toBeLessThan(firstOnsets[1]);
    expect(Math.min(...firstOnsets)).toBeGreaterThan(-0.26);
    // Inside a bar the gaps are shorter than a beat.
    expect(bars[0][1].start - bars[0][0].start).toBeLessThan(1);
    const drag = playMode("drag", 2).map((b) => b.notes);
    expect(drag[1][0].start).toBeGreaterThan(0);
  });
});

describe("eval scenarios", () => {
  it("every scenario builds on its songs, plays its script and its checks read bars that exist", async () => {
    for (const s of SONGS)
      for (const { scenario, run } of scenariosFor(s)) {
        expect(run.modes.length, scenario.id).toBeGreaterThan(0);
        expect(run.modes.length, scenario.id).toBeLessThanOrEqual(run.bars);
        expect(run.checks.length, scenario.id).toBeGreaterThan(0);
        const r = await runScenario({ chart: s.chart, modes: run.modes, bars: run.bars, leader: ruleLeader(new RuleLeader()), everyBars: 2, seed: 1 });
        expect(r.plans, scenario.id).toHaveLength(run.bars);
        expect(() => judge(run, new RunView(r.plans, s.chart.bpm)), `${scenario.id} ${s.id}`).not.toThrow();
      }
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it("finds where each song changes section and where its solos are", () => {
    const blues = songShape(SONGS[1]);
    expect(blues.spans.map((s) => s.start)).toEqual([0, 12, 24, 36, 48]);
    const late = songShape(SONGS[2]);
    expect(late.spans.find((s) => s.name === "solo")!.start).toBe(36);
  });

  it("a run with the rule leader is repeatable and scores", async () => {
    const s = SONGS[0];
    const { run } = scenariosFor(s, ["E2"])[0];
    const go = () => runScenario({ chart: s.chart, modes: run.modes, bars: run.bars, leader: ruleLeader(new RuleLeader()), everyBars: 2, seed: 1 });
    const a = await go();
    const b = await go();
    expect(a.plans.map((p) => p.target)).toEqual(b.plans.map((p) => p.target));
    expect(a.plans).toHaveLength(17);
    expect(a.turns.length).toBeGreaterThan(5);
    const res = judge(run, new RunView(a.plans, s.chart.bpm));
    expect(scoreOf(res)).toBe(1);
  });

  it("checks fail when the band does the wrong thing", async () => {
    // No leader: the band never drops when the player stops.
    const s = SONGS[0];
    const { run } = scenariosFor(s, ["E2"])[0];
    const r = await runScenario({ chart: s.chart, modes: run.modes, bars: run.bars, leader: null, everyBars: 2, seed: 1 });
    const res = judge(run, new RunView(r.plans, s.chart.bpm));
    expect(res[0].pass).toBe(false);
    expect(scoreOf(res)).toBeLessThan(1);
  });

  it("stretch checks don't count in the score", () => {
    expect(scoreOf([{ kind: "must", text: "", pass: true }, { kind: "stretch", text: "", pass: false }])).toBe(1);
    expect(scoreOf([{ kind: "stretch", text: "", pass: true }])).toBeNull();
  });
});
