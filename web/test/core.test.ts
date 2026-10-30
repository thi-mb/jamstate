import { describe, expect, it } from "vitest";
import { bassBar, chordBar, drumBar, DRUM, LoopBank, withFill } from "../src/core/bank";
import { ChartError, loadChart, validateChart, type ChartJSON } from "../src/core/chart";
import { Conductor } from "../src/core/conductor";
import { Engine, type BarContext, type PartGenerator } from "../src/core/engine";
import { barFeatures, NoteTracker, summarize } from "../src/core/features";
import { parseMove } from "../src/core/moves";
import { RuleLeader, type LeaderContext } from "../src/core/rules";
import { parseScript } from "../src/core/simplayer";
import { simulate } from "../src/core/simulate";
import { parseChord, voiceChord } from "../src/core/theory";
import { Transport, type Sink } from "../src/core/transport";
import { FEELS, type NoteEvent } from "../src/core/types";
import { pickInputs } from "../src/audio/midi";

import bluesJson from "../public/charts/blues-in-a.json";
import nightShiftJson from "../public/charts/night-shift.json";

const nightShift = nightShiftJson as ChartJSON;
const chart = loadChart(nightShift);

const small: ChartJSON = {
  title: "t",
  bpm: 120,
  time_sig: "4/4",
  sections: [
    { name: "a", bars: 8, chords: ["C", "F", "G", "C"] },
    { name: "b", bars: 8, chords: ["Am", "F"] },
    { name: "c", bars: 4, chords: ["G7"] },
  ],
  form: ["a", "b", "c"],
};

describe("theory", () => {
  it("parses chords, slashes and qualities", () => {
    expect(parseChord("Fm")).toMatchObject({ root: 5, bass: 5, intervals: [0, 3, 7] });
    expect(parseChord("Db")).toMatchObject({ root: 1 });
    expect(parseChord("F#m7b5")).toMatchObject({ root: 6, intervals: [0, 3, 6, 10] });
    expect(parseChord("C/E")).toMatchObject({ root: 0, bass: 4 });
    expect(() => parseChord("Hm")).toThrow();
    expect(() => parseChord("Cfoo")).toThrow(/quality/);
  });
  it("voices chords close to the center with the right pitch classes", () => {
    const v = voiceChord(parseChord("Ab"));
    expect(new Set(v.map((n) => n % 12))).toEqual(new Set([8, 0, 3]));
    expect(Math.abs(v.reduce((a, b) => a + b) / v.length - 62)).toBeLessThan(6);
    expect(voiceChord(parseChord("Cmaj9")).length).toBe(4);
  });
});

describe("chart", () => {
  it("loads the bundled charts", () => {
    expect(chart.beatsPerBar).toBe(4);
    expect(chart.phraseBars).toBe(4);
    expect(validateChart(bluesJson)).toEqual([]);
  });
  it("splits bars with several chords and cycles progressions", () => {
    const outro = chart.sections.get("outro")!;
    expect(outro.barChords(0).map((s) => [s.chord.symbol, s.start, s.dur])).toEqual([["Fm", 0, 2], ["Eb", 2, 2]]);
    expect(chart.sections.get("verse")!.barChords(5)[0].chord.symbol).toBe("Fm");
  });
  it("reports every problem in a bad chart", () => {
    const bad = { ...small, bpm: 500, time_sig: "6/8", form: ["a", "zzz"], sections: [{ name: "a", bars: 0, chords: ["Q"] }], extra: 1 };
    const errs = validateChart(bad);
    expect(errs.join("\n")).toMatch(/unknown field "extra"/);
    expect(errs.join("\n")).toMatch(/bpm/);
    expect(errs.join("\n")).toMatch(/time_sig/);
    expect(errs.join("\n")).toMatch(/bars must be/);
    expect(errs.join("\n")).toMatch(/Can't read chord "Q"/);
    expect(errs.join("\n")).toMatch(/"zzz" is not a section/);
    expect(() => loadChart(bad)).toThrow(ChartError);
  });
});

describe("bank", () => {
  const inBar = (evs: NoteEvent[], bpb = 4) => evs.every((e) => e.start >= 0 && e.start < bpb && e.vel >= 1 && e.vel <= 127);
  it("keeps every layer inside the bar for all levels and feels", () => {
    const slots = chart.sections.get("outro")!.barChords(0);
    for (const feel of FEELS)
      for (let level = 0; level < 4; level++) {
        expect(inBar(drumBar(level, feel, 4))).toBe(true);
        expect(inBar(bassBar(slots, parseChord("Db"), level, feel, 4))).toBe(true);
        expect(inBar(chordBar(slots, level, feel))).toBe(true);
      }
  });
  it("gets denser with intensity (vertical layering)", () => {
    const count = (l: number) => drumBar(l, "normal", 4).length;
    expect(count(0)).toBeLessThan(count(1));
    expect(count(1)).toBeLessThan(count(3));
    const backbeat = (f: (typeof FEELS)[number]) => drumBar(2, f, 4).filter((e) => e.note === DRUM.snare && e.vel > 40).map((e) => e.start);
    expect(backbeat("normal")).toEqual([1, 3]);
    expect(backbeat("half_time")).toEqual([2]);
    expect(backbeat("double_time")).toEqual([0.5, 1.5, 2.5, 3.5]);
  });
  it("fills replace the end of the bar", () => {
    const filled = withFill(drumBar(2, "normal", 4), 4, 2);
    expect(filled.filter((e) => e.start >= 3 && e.note === DRUM.hat)).toEqual([]);
    expect(filled.some((e) => e.note === DRUM.tomLo)).toBe(true);
  });
  it("memoizes bars", () => {
    const bank = new LoopBank(chart);
    const a = bank.bar("drums", "verse", 0, 1, "normal", null);
    expect(bank.bar("drums", "verse", 0, 1, "normal", null)).toBe(a);
  });
});

describe("engine + governor", () => {
  it("walks the form and stops at the end", () => {
    const e = new Engine(loadChart(small));
    const sections: string[] = [];
    for (let p = e.nextBar(); p; p = e.nextBar()) sections.push(p.section);
    expect(sections.length).toBe(20);
    expect(sections[0]).toBe("a");
    expect(sections[8]).toBe("b");
    expect(sections[19]).toBe("c");
    expect(e.finished).toBe(true);
  });

  it("loops when asked", () => {
    const e = new Engine(loadChart(small), { config: { loop: true } });
    for (let i = 0; i < 20; i++) e.nextBar();
    expect(e.nextBar()!.section).toBe("a");
  });

  it("smooths intensity and respects the deadband", () => {
    const e = new Engine(loadChart(small), { intensity: 0.2 });
    e.nextBar();
    e.submit([{ move: "set_intensity", value: 1, reason: "go" }], "test");
    const values = [1, 2, 3, 4].map(() => e.nextBar()!.intensity);
    expect(values.map((v) => Math.round(v * 100) / 100)).toEqual([0.4, 0.6, 0.8, 1]);
    const [rec] = (e.submit([{ move: "set_intensity", value: 0.95, reason: "tiny" }], "test"), e.nextBar()!.moves);
    expect(rec.status).toBe("rejected");
    expect(rec.note).toMatch(/deadband/);
  });

  it("enforces layer and feel dwell times", () => {
    const e = new Engine(loadChart(small));
    e.nextBar();
    e.submit([{ move: "drop_layer", part: "drums", reason: "" }], "t");
    let p = e.nextBar()!;
    expect(p.layers).toEqual(["bass", "chords"]);
    expect(p.events.some((ev) => ev.part === "drums")).toBe(false);
    e.submit([{ move: "add_layer", part: "drums", reason: "" }], "t");
    p = e.nextBar()!;
    expect(p.moves[0].status).toBe("rejected");
    e.submit([{ move: "add_layer", part: "drums", reason: "" }], "t");
    expect(e.nextBar()!.layers).toContain("drums");
    e.submit([{ move: "change_feel", feel: "half_time", reason: "" }], "t");
    expect(e.nextBar()!.feel).toBe("half_time");
    e.submit([{ move: "change_feel", feel: "normal", reason: "" }], "t");
    expect(e.nextBar()!.moves[0].note).toMatch(/too recently/);
  });

  it("jumps only on a phrase boundary after the minimum section length", () => {
    const e = new Engine(loadChart(small));
    e.nextBar(); // a:0
    e.submit([{ move: "jump_to_section", section: "c", reason: "skip" }], "t");
    const seen: [string, number][] = [];
    for (let i = 0; i < 5; i++) {
      const p = e.nextBar()!;
      seen.push([p.section, p.barInSection]);
    }
    // a:1, a:2, a:3 pending; bar 4 of "a" is a phrase boundary → jump lands.
    expect(seen).toEqual([["a", 1], ["a", 2], ["a", 3], ["c", 0], ["c", 1]]);
  });

  it("drops expired moves and invalid ones", () => {
    const e = new Engine(loadChart(small));
    for (let i = 0; i < 12; i++) e.nextBar();
    e.submit([{ move: "fire_stinger", stinger: "riser", reason: "" }], "t", 1);
    const rejected = e.submit([{ move: "dance" }], "t");
    expect(rejected[0].note).toMatch(/unknown move/);
    expect(e.nextBar()!.moves[0].note).toMatch(/expired/);
  });

  it("caps extensions at the section length", () => {
    const e = new Engine(loadChart(small));
    e.nextBar();
    e.submit([{ move: "extend_section", bars: 16, reason: "" }], "t");
    const p = e.nextBar()!;
    expect(p.sectionBars).toBe(16);
    expect(p.moves[0].note).toMatch(/capped to 8/);
  });

  it("repeats the previous bar when the generator misses its deadline", () => {
    let calls = 0;
    const flaky: PartGenerator = {
      generate(ctx: BarContext) {
        calls++;
        const bar = Object.fromEntries(ctx.parts.map((p) => [p, [{ start: 0, dur: 1, note: 40 + ctx.bar, vel: 90, part: p }]]));
        return calls === 2 ? {} : bar;
      },
    };
    const e = new Engine(loadChart(small), { generator: flaky, config: { autoFills: false } });
    const first = e.nextBar()!;
    const second = e.nextBar()!;
    expect(second.repeated).toEqual(["drums", "bass", "chords"]);
    expect(second.events.map((x) => x.note)).toEqual(first.events.map((x) => x.note));
  });

  it("adds a fill before a new section and a crash on its downbeat", () => {
    const e = new Engine(loadChart(small), { intensity: 0.5 });
    const plans = Array.from({ length: 9 }, () => e.nextBar()!);
    expect(plans[7].stingers).toContain("fill");
    expect(plans[8].stingers).toContain("crash");
    expect(plans[8].events.some((x) => x.note === DRUM.crash && x.start === 0)).toBe(true);
  });
});

describe("features", () => {
  it("measures density, velocity, rests and repetition", () => {
    const notes = [0, 1, 2, 3].map((b) => ({ start: b, dur: 0.5, note: 60 + b, vel: 127 }));
    const f = barFeatures(notes, 4);
    expect(f.density).toBe(1);
    expect(f.meanVelocity).toBe(1);
    expect(f.restRatio).toBe(0.5);
    expect(barFeatures(notes, 4, [f]).repetition).toBe(1);
    expect(barFeatures([], 4)).toMatchObject({ energy: 0, restRatio: 1, register: null });
  });
  it("summarizes a window with trend, register and trailing silence", () => {
    const loud = barFeatures([{ start: 0, dur: 4, note: 72, vel: 120 }, ...[1, 2, 3].map((b) => ({ start: b, dur: 0.2, note: 72, vel: 120 }))], 4);
    const quiet = barFeatures([], 4);
    const s = summarize([quiet, quiet, loud, loud]);
    expect(s.trend).toBe("rising");
    expect(s.register).toBe("mid");
    expect(s.silent_bars).toBe(0);
    expect(summarize([loud, quiet, quiet]).silent_bars).toBe(2);
  });
  it("cuts live notes into bars", () => {
    const t = new NoteTracker();
    t.noteOn(3.5, 60, 100);
    t.noteOff(4.5, 60);
    t.noteOn(6, 64, 80);
    const bar1 = t.bar(4, 4);
    expect(bar1.map((n) => [n.start, n.note])).toEqual([[-0.5, 60], [2, 64]]);
    expect(barFeatures(bar1, 4).noteCount).toBe(1); // the held-over note isn't a new onset
  });
});

describe("moves", () => {
  it("parses only well-formed moves", () => {
    expect(parseMove({ move: "set_intensity", value: 0.3, reason: "r" })).toEqual({ move: { move: "set_intensity", value: 0.3, reason: "r" } });
    expect(parseMove({ move: "set_intensity", value: 3 })).toHaveProperty("error");
    expect(parseMove({ move: "add_layer", part: "keys" })).toHaveProperty("error");
    expect(parseMove({ move: "change_feel", feel: "half_time", reason: "x".repeat(300) })).toMatchObject({ move: { reason: "x".repeat(120) } });
    expect(parseMove(null)).toHaveProperty("error");
  });
});

describe("rule leader", () => {
  const ctx = (energy: number, silent = 0, extra: Partial<LeaderContext> = {}): LeaderContext => ({
    bar: 7, section: "verse", bar_in_section: 3, section_bars: 8, phrase_bars: 4, intensity: 0.5, target: 0.5,
    layers: ["drums", "bass", "chords"], feel: "normal", form: ["verse"], form_pos: 0, sections: ["verse"], recent_moves: [],
    player: { bars: 2, energy, density: energy * 3, mean_velocity: energy, rest_ratio: 1 - energy, repetition: 0, register: "mid", trend: "steady", silent_bars: silent },
    ...extra,
  });
  it("builds when busy, lays back when sparse, drops out when silent", () => {
    const r = new RuleLeader();
    expect(r.decide(ctx(0.9)).map((m) => m.move)).toEqual(["set_intensity", "fire_stinger"]);
    expect(r.decide(ctx(0.2, 0, { target: 0.9 })).map((m) => m.move)).toEqual(["set_intensity", "change_feel"]);
    expect(r.decide(ctx(0, 2, { target: 0.3 }))).toEqual([
      expect.objectContaining({ move: "set_intensity", value: 0.1 }),
      expect.objectContaining({ move: "drop_layer", part: "drums" }),
    ]);
  });
  it("uses hysteresis between moods", () => {
    const r = new RuleLeader();
    r.decide(ctx(0.7));
    expect(r.mood).toBe("busy");
    r.decide(ctx(0.55));
    expect(r.mood).toBe("busy"); // above the exit threshold
    r.decide(ctx(0.45));
    expect(r.mood).toBe("groove");
  });
});

describe("conductor", () => {
  it("never has two leader requests in flight", async () => {
    const e = new Engine(chart);
    let resolve!: (v: { moves: unknown[]; source: string }) => void;
    let asked = 0;
    let skipped = 0;
    const c = new Conductor(e, { decide: () => (asked++, new Promise((r) => (resolve = r))) }, 2, { onSkip: () => skipped++ });
    for (let i = 0; i < 6; i++) c.barFinished(e.nextBar()!, []);
    expect(asked).toBe(1);
    expect(skipped).toBe(2);
    resolve({ moves: [{ move: "fire_stinger", stinger: "crash", reason: "late" }], source: "llm" });
    await Promise.resolve();
    await Promise.resolve();
    expect(c.busy).toBe(false);
    expect(e.nextBar()!.moves[0]).toMatchObject({ status: "applied", source: "llm", requestedBar: 1 });
  });
});

describe("simulation (the X demo script)", () => {
  it("follows sparse → busy → silent → busy", () => {
    const bars = simulate(chart, parseScript("medium:4,sparse:8,busy:8,silent:6,busy:6"), { config: { loop: true } });
    const at = (i: number) => bars[i].plan;
    expect(at(11).feel).toBe("half_time"); // sparse → half time
    expect(at(19).intensity).toBeGreaterThan(0.8); // busy → build
    expect(at(19).feel).toBe("normal");
    expect(at(25).layers).not.toContain("drums"); // silent → drums out
    expect(at(25).intensity).toBeLessThan(0.5);
    expect(at(31).layers).toContain("drums"); // back → drums in
    const reasons = bars.flatMap((b) => b.plan.moves.filter((m) => m.status === "applied").map((m) => m.move.reason));
    expect(reasons.every((r) => r.length > 0)).toBe(true);
  });
  it("is deterministic", () => {
    const run = () => simulate(chart, parseScript("busy:4,sparse:4"), { seed: 3 }).map((b) => b.plan.events.length);
    expect(run()).toEqual(run());
  });
});

describe("transport", () => {
  it("commits ahead, plays inside the lookahead window, and reports bar boundaries", () => {
    let now = 0;
    const played: { time: number; ev: NoteEvent }[] = [];
    const sink: Sink = { play: (ev, time) => played.push({ time, ev }), panic: () => {} };
    const starts: number[] = [];
    const ends: number[] = [];
    const commits: number[] = [];
    const e = new Engine(loadChart({ ...small, bpm: 120 }));
    const t = new Transport(e, { now: () => now }, sink, {
      onCommit: (p) => commits.push(p.bar),
      onBarStart: (p) => starts.push(p.bar),
      onBarEnd: (p) => ends.push(p.bar),
    }, { lookahead: 0.1, startDelay: 0 });
    t.start();
    // 120 bpm, 4/4: a bar is 2 s. Tick every 25 ms for 5 s.
    for (; now < 5; now += 0.025) t.tick();
    expect(starts).toEqual([0, 1, 2]);
    expect(ends).toEqual([0, 1]);
    // Bar 3 is committed at the start of bar 2's last beat (5.5 s − lookahead), not yet.
    expect(commits).toEqual([0, 1, 2]);
    // Nothing is ever handed to the sink later than the lookahead, or late.
    for (const p of played) expect(p.time).toBeGreaterThanOrEqual(0);
    expect(Math.max(...played.map((p) => p.time))).toBeLessThan(5 + 0.1 + 1e-9);
    expect(t.beatAt(t.timeAt(6))).toBeCloseTo(6);
  });
});

describe("midi inputs", () => {
  const ins = [
    { id: "in-kk", name: "KOMPLETE KONTROL M32" },
    { id: "in-iac", name: "IAC Driver Bus 1" },
  ];

  it("leaves out the band's loopback port when listening to all inputs", () => {
    expect(pickInputs(ins, "all", "IAC Driver Bus 1").map((i) => i.id)).toEqual(["in-kk"]);
    expect(pickInputs(ins, "all", undefined).map((i) => i.id)).toEqual(["in-kk", "in-iac"]);
  });

  it("keeps an input the player picked by hand", () => {
    expect(pickInputs(ins, "in-iac", "IAC Driver Bus 1").map((i) => i.id)).toEqual(["in-iac"]);
  });
});
