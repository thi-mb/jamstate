import { describe, expect, it } from "vitest";
import { loadChart, type ChartJSON } from "../src/core/chart";
import { ruleLeader } from "../src/core/conductor";
import { CUES, cueForKey, Engine, type BarPlan, type Cue } from "../src/core/engine";
import { runScenario } from "../src/core/eval/run";
import { getGenre } from "../src/core/genres";
import { RuleLeader } from "../src/core/rules";
import { replaySession, SessionRecorder } from "../src/core/session";
import { defaultBand } from "../src/core/band";
import { V01_PARTS } from "../src/core/types";
import { parseScript } from "../src/core/simplayer";
import nightShift from "../public/charts/night-shift.json";

const json = nightShift as ChartJSON;
const chart = loadChart(json);

/** Bars 0..n, with a cue given while bar `at` plays (before bar at+1 is prepared). */
function play(n: number, cue: Cue | null, at = 9, during?: (e: Engine, bar: number) => void): BarPlan[] {
  const e = new Engine(chart, { seed: 1, genre: getGenre("funk"), countIn: 0, config: { loop: true } });
  const out: BarPlan[] = [];
  for (let b = 0; b < n; b++) {
    during?.(e, b);
    const p = e.nextBar();
    if (!p) break;
    out.push(p);
    if (cue && b === at) e.cue(cue);
  }
  return out;
}

describe("cues", () => {
  it("are on keys 1–7", () => {
    expect(CUES.map((_, i) => cueForKey(String(i + 1)))).toEqual(["next_section", "drums_break", "drums_only", "build", "take_down", "one_more", "end_song"]);
    expect(cueForKey("8")).toBeUndefined();
  });

  it("take it down lands on the next bar and locks the leader out for a phrase", () => {
    const ps = play(16, "take_down", 9, (e, b) => {
      if (b >= 11) e.submit([{ move: "set_intensity", value: 0.9, reason: "up" }], "rules");
    });
    expect(ps[10].target).toBeCloseTo(ps[9].target - 0.25);
    const undo = ps.slice(11, 15).flatMap((p) => p.moves).filter((m) => m.source === "rules");
    expect(undo.every((m) => m.status === "rejected" && m.note === "undoes the take it down cue")).toBe(true);
    expect(ps[15].moves.find((m) => m.source === "rules")?.status).toBe("applied");
  });

  it("build lifts on the next bar with a riser, even after a stinger in the phrase", () => {
    const ps = play(12, "build", 9, (e, b) => {
      if (b === 8) e.submit([{ move: "fire_stinger", stinger: "fill", reason: "f" }], "rules");
    });
    expect(ps[10].target).toBeCloseTo(ps[9].target + 0.25);
    expect(ps[10].stingers).toEqual(["riser"]);
  });

  it("breaks run to the end of the phrase and the band comes back", () => {
    const br = play(13, "drums_break");
    expect(br[10].layers).not.toContain("drums");
    expect(br[11].layers).toEqual(br[9].layers.filter((p) => p !== "drums"));
    expect(br[12].layers).toContain("drums");
    expect(br[12].stingers).toContain("crash");
    const only = play(13, "drums_only");
    expect(only[10].layers).toEqual(["drums"]);
    expect(only[12].layers).toEqual(only[9].layers);
  });

  it("next section lands on the next phrase, even mid-section", () => {
    // Chorus 12–19, pressed in bar 13: the next section in the form (verse) at bar 16.
    const ps = play(18, "next_section", 13);
    expect(ps[15].section).toBe("chorus");
    expect(ps[16]).toMatchObject({ section: "verse", barInSection: 0 });
  });

  it("one more plays the section again, then the form goes on", () => {
    const ps = play(30, "one_more", 18);
    expect(ps.slice(12, 28).every((p) => p.section === "chorus")).toBe(true);
    expect(ps[28]).toMatchObject({ section: "verse", barInSection: 0 });
  });

  it("end song ends at the end of the phrase", () => {
    const ps = play(20, "end_song");
    expect(ps.length).toBe(12);
    expect(ps[11].kind).toBe("ending");
  });

  it("the rule leader doesn't undo a cue in the eval run", async () => {
    const res = await runScenario({ chart: json, modes: parseScript("busy:16"), bars: 16, leader: ruleLeader(new RuleLeader()), everyBars: 2, seed: 1, cues: [{ bar: 9, cue: "take_down" }] });
    const fought = res.plans.flatMap((p) => p.moves).filter((m) => m.note?.startsWith("undoes"));
    expect(fought.length).toBeGreaterThan(0);
    expect(res.plans[14].target).toBeLessThanOrEqual(res.plans[9].target - 0.2);
  });

  it("are recorded and replay exactly", async () => {
    const setup = { chart: json, genre: "funk", swing: null, band: defaultBand(V01_PARTS), seed: 1, countIn: 0, config: {}, leader: "none", everyBars: 1, listening: "none" };
    const rec = new SessionRecorder(setup);
    const e = new Engine(chart, { seed: 1, genre: getGenre("funk"), countIn: 0, band: setup.band });
    for (let b = 0; b < 16; b++) {
      rec.bar(e.nextBar()!);
      if (b === 5) e.cue("build");
      if (b === 9) e.cue("drums_break");
    }
    const f = rec.finish(e);
    expect(f.controls.filter((c) => c.kind === "cue")).toEqual([{ at: 5, kind: "cue", cue: "build" }, { at: 9, kind: "cue", cue: "drums_break" }]);
    expect((await replaySession(f)).mismatches).toEqual([]);
  });
});
