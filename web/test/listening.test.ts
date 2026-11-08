import { describe, expect, it } from "vitest";
import { loadChart, type ChartJSON } from "../src/core/chart";
import { Conductor, type Leader } from "../src/core/conductor";
import { Engine } from "../src/core/engine";
import { getGenre } from "../src/core/genres";
import { leaderSystem, LEADER_SYSTEM } from "../src/core/brain/prompt";
import { jevState } from "../src/core/brain/jev";
import { dynamicsOf, harmonyOf, listeningKey, noteFit, NO_LISTENING, parseListening, phrasingOf, rhythmOf, songPosition } from "../src/core/listening";
import { loadGenre } from "../src/core/genre";
import { parseChord } from "../src/core/theory";
import { SimPlayer, type SimMode } from "../src/core/simplayer";
import type { LeaderContext } from "../src/core/rules";
import { RuleLeader } from "../src/core/rules";
import { replaySession, SessionRecorder } from "../src/core/session";
import { defaultBand } from "../src/core/band";
import { V01_PARTS } from "../src/core/types";

import nightShift from "../public/charts/night-shift.json";
import funkPack from "../../genres/funk.json";

const getGenreRaw = () => funkPack as unknown as Record<string, unknown>;

const chartJson = nightShift as ChartJSON;
const chart = loadChart(chartJson);

/** Every bar of the song, once through. */
function plans() {
  const e = new Engine(chart, { seed: 1, genre: getGenre("funk"), config: { loop: false }, countIn: 0 });
  const out = [];
  for (let p = e.nextBar(); p; p = e.nextBar()) out.push(p);
  return out;
}

describe("listening groups", () => {
  it("parses and prints the groups", () => {
    expect(listeningKey(parseListening("none"))).toBe("none");
    expect(listeningKey(parseListening("harmony,position"))).toBe("position,harmony");
    expect(listeningKey(parseListening("all"))).toBe("position,rhythm,harmony,phrasing,dynamics");
    expect(() => parseListening("vibes")).toThrow(/vibes/);
  });
});

describe("song position", () => {
  const ps = plans();

  it("counts down to the next section and knows what it is", () => {
    // Night Shift: intro 4, verse 8 (bars 4–11), chorus 8 (12–19), …
    const at = (bar: number) => songPosition(chart, ps[bar], false);
    expect(at(4)).toMatchObject({ bars_left: 7, next_section: "chorus", next_lift: "up", phrase: "start", pass: "1 of 2", section_level: 0.45 });
    expect(at(7)).toMatchObject({ bars_left: 4, phrase: "end" });
    expect(at(11)).toMatchObject({ bars_left: 0, next_section: "chorus" });
    expect(at(12)).toMatchObject({ next_section: "verse", next_lift: "down", pass: "1 of 3" });
  });

  it("knows the last section, and wraps when the form loops", () => {
    const last = ps[ps.length - 1];
    expect(songPosition(chart, last, false)).toMatchObject({ last_section: true, next_section: null, next_lift: null });
    expect(songPosition(chart, last, true)).toMatchObject({ last_section: true, next_section: "intro" });
  });

  it("goes into the summary only when its group is on", () => {
    const seen: LeaderContext[] = [];
    const leader: Leader = { decide: (ctx) => (seen.push(ctx), { moves: [], source: "test" }) };
    const e = new Engine(chart, { seed: 1, genre: getGenre("funk"), countIn: 0 });
    const c = new Conductor(e, leader, 1);
    c.listening = { ...NO_LISTENING };
    c.barFinished(e.nextBar()!, []);
    c.listening = parseListening("position");
    c.barFinished(e.nextBar()!, []);
    expect(seen[0].position).toBeUndefined();
    expect(seen[1].position?.next_section).toBe("verse");
    // The prompt notes follow the fields; the fixed prompt stays the prefix.
    expect(leaderSystem(seen[0])).toBe(LEADER_SYSTEM);
    expect(leaderSystem(seen[1]).startsWith(LEADER_SYSTEM)).toBe(true);
    expect(leaderSystem(seen[1])).toContain('"position"');
    expect((jevState(seen[1]).song as Record<string, unknown>).next_section).toBe("verse");
  });
});

describe("rule leader with song position", () => {
  const base = (over: Partial<LeaderContext>): LeaderContext => ({
    bar: 10, section: "verse", bar_in_section: 6, section_bars: 8, phrase_bars: 4, intensity: 0.5, target: 0.5,
    layers: ["drums", "bass", "chords"], lineup: ["drums", "bass", "chords"], feel: "normal", form: chart.form, form_pos: 1, sections: [...chart.sections.keys()],
    player: { bars: 2, energy: 0.5, density: 1, mean_velocity: 0.6, rest_ratio: 0.2, repetition: 0.2, register: "mid", trend: "steady", silent_bars: 0 },
    recent_moves: [],
    ...over,
  });
  const pos = { bars_left: 1, next_section: "chorus", next_lift: "up" as const, phrase: "end" as const, pass: "1 of 2", last_section: false, section_level: 0.45 };

  it("lifts into a bigger section when the player builds", () => {
    const r = new RuleLeader();
    const moves = r.decide(base({ position: pos, player: { ...base({}).player, energy: 0.5, trend: "rising" } }));
    expect(moves[0]).toMatchObject({ move: "set_intensity", reason: "Lifting into the chorus" });
    expect((moves[0] as { value: number }).value).toBeGreaterThanOrEqual(0.7);
  });

  it("doesn't lift for a steady player, and doesn't drop parts right before a change", () => {
    expect(new RuleLeader().decide(base({ position: pos })).some((m) => m.reason.startsWith("Lifting"))).toBe(false);
    const quiet = { ...base({}).player, energy: 0, silent_bars: 2, bars: 2, density: 0 };
    const without = new RuleLeader().decide(base({ player: quiet }));
    const withPos = new RuleLeader().decide(base({ player: quiet, position: { ...pos, bars_left: 0 } }));
    expect(without.some((m) => m.move === "drop_layer")).toBe(true);
    expect(withPos.some((m) => m.move === "drop_layer")).toBe(false);
  });
});

describe("listening in sessions", () => {
  it("records the setting and its changes, and a leader replay hears the same", async () => {
    const setup = { chart: chartJson, genre: "funk", swing: null, band: defaultBand(V01_PARTS), seed: 1, countIn: 0, config: {}, leader: "rules", everyBars: 1, listening: "none" };
    const rec = new SessionRecorder(setup);
    const e = new Engine(chart, { seed: 1, genre: getGenre("funk"), countIn: 0 });
    for (let i = 0; i < 4; i++) rec.bar(e.nextBar()!);
    rec.listening(1, "position");
    const file = rec.finish(e);
    expect(file.listening).toEqual([{ at: -1, groups: "none" }, { at: 1, groups: "position" }]);
    const seen: LeaderContext[] = [];
    await replaySession(file, { leader: { decide: (ctx) => (seen.push(ctx), { moves: [], source: "t" }) }, everyBars: 1 });
    expect(seen.map((c) => c.position !== undefined)).toEqual([false, false, true, true]);
  });
});

describe("rhythm", () => {
  /** A phrase of one pretend-player mode on Night Shift. */
  const phrase = (mode: SimMode) => {
    const e = new Engine(chart, { seed: 3 });
    const sim = new SimPlayer(5);
    return [0, 1, 2, 3].map(() => sim.play(e.nextBar()!, mode, 4, { bpm: 112, chartBpm: 112, phraseBars: 4 }));
  };
  const of = (mode: SimMode) => rhythmOf(phrase(mode), 4, 112);

  it("hears syncopation: none on the beat, all on off-beat sixteenths", () => {
    expect(of("medium").syncopation).toBe(0);
    expect(of("syncopated").syncopation).toBe(1);
    expect(of("busy").syncopation).toBeGreaterThan(0.4);
    expect(of("silent")).toMatchObject({ syncopation: null, timing: null });
  });

  it("hears pushing and laying back, and rushing and dragging", () => {
    expect(of("push")).toMatchObject({ timing: "ahead", tempo: "steady" });
    expect(of("push").timing_ms).toBeCloseTo(-40, -1);
    expect(of("layback")).toMatchObject({ timing: "behind", tempo: "steady" });
    expect(of("medium")).toMatchObject({ timing: "on", tempo: "steady" });
    expect(of("rush")).toMatchObject({ timing: "ahead", tempo: "rushing", syncopation: 0 });
    expect(of("drag")).toMatchObject({ timing: "behind", tempo: "dragging", syncopation: 0 });
  });

  it("hears swing in eighths, and none in straight eighths or sixteenths", () => {
    const eighths = (p: number) => [[0, 1, 2, 3].flatMap((b) => [{ start: b, dur: 0.3, note: 60, vel: 80 }, { start: b + p, dur: 0.3, note: 62, vel: 80 }])];
    expect(rhythmOf(eighths(2 / 3), 4, 120).swing).toBeCloseTo(0.67, 1);
    expect(rhythmOf(eighths(0.5), 4, 120).swing).toBe(0);
    expect(rhythmOf(eighths(0.5), 4, 120).syncopation).toBe(0.25);
    expect(of("busy").swing).toBeNull();
  });
});

describe("harmony", () => {
  const funk = getGenre("funk").listening;
  const blues = getGenre("blues-rock").listening;
  const jazz = getGenre("jazz").listening;
  const pc = (name: string) => ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].indexOf(name);

  it("sorts notes into inside, colour and outside by the genre's scale", () => {
    const fm = parseChord("Fm");
    expect(noteFit(pc("G#"), fm, funk)).toBe("inside"); // the minor third
    expect(noteFit(pc("D"), fm, funk)).toBe("colour"); // dorian sixth
    expect(noteFit(pc("B"), fm, funk)).toBe("colour"); // the flat five
    expect(noteFit(pc("F#"), fm, funk)).toBe("outside"); // flat two
    const a7 = parseChord("A7");
    expect(noteFit(pc("C"), a7, blues)).toBe("colour"); // the blue third
    expect(noteFit(pc("D#"), a7, blues)).toBe("colour"); // the blue fifth
    expect(noteFit(pc("F"), a7, blues)).toBe("outside"); // flat six
    const g7 = parseChord("G7");
    expect(noteFit(pc("G#"), g7, jazz)).toBe("colour"); // b9 on a dominant: everything is colour
    expect(noteFit(pc("D#"), parseChord("Cm7"), jazz)).toBe("inside");
    expect(noteFit(pc("C#"), parseChord("Cm7"), jazz)).toBe("outside");
  });

  it("falls back to the chord's own scale without a genre", () => {
    expect(noteFit(pc("D"), parseChord("C"))).toBe("colour");
    expect(noteFit(pc("C#"), parseChord("C"))).toBe("outside");
  });

  it("weights by duration and names the fit", () => {
    const plan = plans()[4];
    const at = () => parseChord("Fm");
    const long = { start: 0, dur: 3, note: 60, vel: 80 }; // C: inside
    const short = { start: 3, dur: 0.5, note: 66, vel: 80 }; // F#: outside
    const h = harmonyOf([{ plan, notes: [long, short] }], 4, at, funk);
    expect(h.inside).toBeCloseTo(3 / 3.5, 2);
    expect(h.fit).toBe("inside");
    const out = harmonyOf([{ plan, notes: [{ ...short, dur: 2 }, { ...long, dur: 1 }] }], 4, at, funk);
    expect(out.fit).toBe("outside");
    expect(harmonyOf([{ plan, notes: [] }], 4, at, funk)).toMatchObject({ fit: null, genre_outside: "hold" });
    expect(harmonyOf([], 4, at, jazz).genre_outside).toBe("lift");
  });

  it("checks the genre pack's listening section", () => {
    const raw = structuredClone(getGenreRaw());
    raw.listening = { scales: { minor: [0, 13] }, outside: "maybe" };
    expect(() => loadGenre(raw)).toThrow(/listening.scales.minor[\s\S]*listening.outside/);
  });
});

describe("phrasing", () => {
  const plan = plans()[4];
  const note = (start: number, dur = 0.5) => ({ start, dur, note: 60, vel: 80 });
  const bar = (on: boolean, dur = 0.5) => (on ? [note(0, dur), note(1, dur), note(2, dur)] : []);
  const of = (pattern: string, dur = 0.5) => phrasingOf([...pattern].map((c) => bar(c === "x", dur)), 4);

  it("tells a breath from a stop, and waits before the first note", () => {
    expect(of("xxxx")).toMatchObject({ state: "playing", gap_bars: 0, playing_bars: 4 });
    expect(of("xxx.")).toMatchObject({ state: "breathing", gap_bars: 1 });
    expect(of("xx..")).toMatchObject({ state: "breathing", gap_bars: 2 });
    expect(of("x...")).toMatchObject({ state: "stopped", gap_bars: 3 });
    expect(of("....")).toMatchObject({ state: "waiting" });
  });

  it("hears call and response, and long notes", () => {
    expect(of("xx..xx..").call_response).toBe(true);
    expect(of("xxxxxx..").call_response).toBe(false);
    expect(of("xxxx", 2).held).toBeGreaterThan(0.9);
    expect(of("xxxx", 0.25).held).toBe(0);
    void plan;
  });

  it("rules hold through a breath, answer a trade, and still drop on a stop", () => {
    const ctx = (silent: number, phrasing: ReturnType<typeof of>): LeaderContext => ({
      bar: 10, section: "verse", bar_in_section: 6, section_bars: 8, phrase_bars: 4, intensity: 0.5, target: 0.5,
      layers: ["drums", "bass", "chords"], lineup: ["drums", "bass", "chords"], feel: "normal", form: chart.form, form_pos: 1, sections: [...chart.sections.keys()],
      player: { bars: 2, energy: silent ? 0 : 0.5, density: silent ? 0 : 1, mean_velocity: 0.6, rest_ratio: 0.2, repetition: 0.2, register: "mid", trend: "steady", silent_bars: silent },
      recent_moves: [], phrasing,
    });
    expect(new RuleLeader().decide(ctx(2, of("xx..")))).toEqual([]);
    expect(new RuleLeader().decide(ctx(2, of("xx..xx..")))[0]).toMatchObject({ move: "fire_stinger", stinger: "fill" });
    expect(new RuleLeader().decide(ctx(2, of("x...")))).toContainEqual(expect.objectContaining({ move: "drop_layer", part: "drums" }));
  });
});

describe("dynamics", () => {
  const phrase = (mode: SimMode, seed = 5) => {
    const e = new Engine(chart, { seed: 3 });
    const sim = new SimPlayer(seed);
    return [0, 1, 2, 3].map(() => sim.play(e.nextBar()!, mode, 4, { bpm: 112, chartBpm: 112, phraseBars: 4 }));
  };

  it("hears a crescendo or decrescendo, and steady playing as steady", () => {
    expect(dynamicsOf(phrase("crescendo"), 4).shape).toBe("crescendo");
    expect(dynamicsOf(phrase("decrescendo"), 4).shape).toBe("decrescendo");
    for (const mode of ["medium", "busy", "riff", "held", "syncopated"] as SimMode[])
      for (const seed of [1, 2, 3, 4, 5]) expect(dynamicsOf(phrase(mode, seed), 4).shape, `${mode} ${seed}`).toBe("steady");
    expect(dynamicsOf(phrase("silent"), 4)).toEqual({ level: null, shape: null, change: null, accents: null });
  });

  it("hears a build from bar to bar, and accents", () => {
    const bar = (vel: number) => [0, 1, 2, 3].map((b) => ({ start: b, dur: 0.5, note: 60, vel }));
    const d = dynamicsOf([bar(50), bar(65), bar(80), bar(100)], 4);
    expect(d).toMatchObject({ shape: "crescendo", level: 0.79 });
    expect(d.change).toBeCloseTo(0.39, 2);
    const accented = [0, 1, 2, 3].map((b) => ({ start: b, dur: 0.5, note: 60, vel: b === 0 ? 120 : 70 }));
    expect(dynamicsOf([accented, accented], 4).accents).toBe(0.25);
  });

  it("rules follow it a step at a time", () => {
    const ctx = { ...plainCtx(), dynamics: { level: 0.5, shape: "decrescendo" as const, change: -0.2, accents: 0 } };
    expect(new RuleLeader().decide(ctx)[0]).toMatchObject({ move: "set_intensity", value: 0.4, reason: "Coming down with you" });
    const up = new RuleLeader().decide({ ...ctx, dynamics: { ...ctx.dynamics, shape: "crescendo" } });
    expect(up[0]).toMatchObject({ move: "set_intensity", value: 0.6 });
  });
});

describe("the chart's nudge at a new section", () => {
  /** Night Shift's chorus (intensity 0.75) starts at bar 12. */
  const targetAt12 = (setAt: number, hold = true) => {
    const e = new Engine(chart, { seed: 1, genre: getGenre("funk"), countIn: 0, config: { holdFreshTarget: hold } });
    let t = 0;
    for (let b = 0; b <= 12; b++) {
      if (b === setAt) e.submit([{ move: "set_intensity", value: 0.1, reason: "t" }], "test");
      t = e.nextBar()!.target;
    }
    return t;
  };
  it("leaves a target the leader set in the last phrase, and nudges an older one", () => {
    expect(targetAt12(10)).toBeCloseTo(0.1);
    expect(targetAt12(4)).toBeCloseTo((0.1 + 0.75) / 2);
    expect(targetAt12(10, false)).toBeCloseTo((0.1 + 0.75) / 2);
  });
});

function plainCtx(): LeaderContext {
  return {
    bar: 10, section: "verse", bar_in_section: 2, section_bars: 8, phrase_bars: 4, intensity: 0.5, target: 0.5,
    layers: ["drums", "bass", "chords"], lineup: ["drums", "bass", "chords"], feel: "normal", form: chart.form, form_pos: 1, sections: [...chart.sections.keys()],
    player: { bars: 2, energy: 0.5, density: 1, mean_velocity: 0.6, rest_ratio: 0.2, repetition: 0.2, register: "mid", trend: "steady", silent_bars: 0 },
    recent_moves: [],
  };
}
