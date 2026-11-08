import { describe, expect, it } from "vitest";
import { DRUM, GrooveGenerator } from "../src/core/groove";
import { ChartError, loadChart, validateChart, type ChartJSON } from "../src/core/chart";
import { Conductor, ruleLeader, type Leader } from "../src/core/conductor";
import { replaySession, SessionRecorder, type SessionFile } from "../src/core/session";
import { SimPlayer } from "../src/core/simplayer";
import { Engine, type BarContext, type BarPlan, type PartGenerator } from "../src/core/engine";
import { barFeatures, NoteTracker, summarize } from "../src/core/features";
import { parseMove } from "../src/core/moves";
import { RuleLeader, type LeaderContext } from "../src/core/rules";
import { parseScript } from "../src/core/simplayer";
import { simulate } from "../src/core/simulate";
import { parseChord, voiceChord } from "../src/core/theory";
import { Transport, type Sink } from "../src/core/transport";
import { FEELS, PARTS, type Feel, type NoteEvent } from "../src/core/types";
import { MAX_OFFSET_MS, ritTime, swingTime } from "../src/core/feel";
import { GenreError, loadGenre, type GenrePack } from "../src/core/genre";
import { allGenres, genreIds, getGenre } from "../src/core/genres";
import funkJson from "../../genres/funk.json";

const getGenreRaw = (id: string) => ({ funk: funkJson })[id as "funk"];
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

describe("groove generators", () => {
  const genres = allGenres();
  const ctxFor = (genre: GenrePack, level: number, feel: Feel, extra: Partial<BarContext> = {}): BarContext => ({
    bar: 3, kind: "play", section: "verse", barInSection: 1, sectionBars: 8, barInPhrase: 1, phraseBars: 4, lastBarOfSection: false,
    level, feel, parts: [...PARTS], slots: chart.sections.get("outro")!.barChords(0), next: parseChord("Db"), bpb: 4, genre, seed: 1,
    stingers: [], cymbal: genre.drums.cymbal, ending: null, firstChord: parseChord("Fm"), band: genre.band, ...extra,
  });
  const inBar = (evs: NoteEvent[], bpb = 4) => evs.every((e) => e.start >= 0 && e.start < bpb && e.vel >= 1 && e.vel <= 127 && e.dur > 0);

  it("keeps every part inside the bar for every genre, level and feel", () => {
    for (const g of genres)
      for (const feel of FEELS)
        for (let level = 0; level < 4; level++) {
          const out = new GrooveGenerator().generate(ctxFor(g, level, feel));
          for (const p of PARTS) expect(inBar(out[p]!), `${g.id} ${feel} ${level} ${p}`).toBe(true);
        }
  });

  it("gets busier with intensity", () => {
    for (const g of genres) {
      const count = (level: number) => new GrooveGenerator().generate(ctxFor(g, level, "normal")).drums!.length;
      expect(count(0), g.id).toBeLessThan(count(3));
    }
  });

  it("keeps the backbeat where the feel says", () => {
    const funk = getGenre("funk");
    const backbeat = (f: Feel) =>
      new GrooveGenerator().generate(ctxFor(funk, 1, f)).drums!.filter((e) => e.note === DRUM.snare && e.vel > 60).map((e) => e.start);
    expect(backbeat("normal")).toEqual([1, 3]);
    expect(backbeat("half_time")).toEqual([2]);
    expect(backbeat("double_time")).toEqual([0.5, 1.5, 2.5, 3.5]);
  });

  it("plays fills, crashes and the ride by section", () => {
    const g = getGenre("blues-rock");
    const filled = new GrooveGenerator().generate(ctxFor(g, 2, "normal", { stingers: ["fill"], lastBarOfSection: true })).drums!;
    expect(filled.some((e) => [DRUM.tomHi, DRUM.tomLo, DRUM.tomMid].includes(e.note as 45) || e.start >= 2)).toBe(true);
    const crash = new GrooveGenerator().generate(ctxFor(g, 2, "normal", { stingers: ["crash"] })).drums!;
    expect(crash.some((e) => e.note === DRUM.crash && e.start === 0)).toBe(true);
    const ride = new GrooveGenerator().generate(ctxFor(g, 2, "normal", { cymbal: "ride" })).drums!;
    expect(ride.some((e) => e.note === DRUM.ride)).toBe(true);
    expect(ride.some((e) => e.note === DRUM.hat)).toBe(false);
  });

  it("walks the bass in jazz: one note a beat, approaching each change", () => {
    const jazz = getGenre("jazz");
    const slots = [{ start: 0, dur: 2, chord: parseChord("Dm7") }, { start: 2, dur: 2, chord: parseChord("G7") }];
    const gen = new GrooveGenerator();
    for (let bar = 0; bar < 16; bar++) {
      const bass = gen.generate(ctxFor(jazz, 2, "normal", { bar, slots, next: parseChord("Cmaj7") })).bass!.filter((e) => e.vel > 60);
      const onBeats = bass.filter((e) => Number.isInteger(e.start));
      expect(onBeats.map((e) => e.start)).toEqual([0, 1, 2, 3]);
      expect(onBeats[0].note % 12).toBe(2); // D on the downbeat
      expect(onBeats[2].note % 12).toBe(7); // G when the chord changes
      expect(onBeats.every((e) => e.note >= 28 && e.note <= 52)).toBe(true);
    }
  });

  it("varies the bass over a 16-bar section", () => {
    for (const g of genres) {
      const gen = new GrooveGenerator();
      const bars = new Set<string>();
      for (let i = 0; i < 16; i++) {
        const bass = gen.generate(ctxFor(g, 2, "normal", { bar: i, barInSection: i, barInPhrase: i % 4, slots: [{ start: 0, dur: 4, chord: parseChord("A7") }], next: parseChord(i % 2 ? "D7" : "A7") })).bass!;
        bars.add(bass.map((e) => `${e.start}:${e.note}`).join(" "));
      }
      expect(bars.size, g.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("voice-leads the comping: small moves between chords", () => {
    const g = getGenre("jazz");
    const gen = new GrooveGenerator();
    const changes = ["Dm7", "G7", "Cmaj7", "A7", "Dm7", "G7"];
    let prev: number[] | null = null;
    for (const [i, sym] of changes.entries()) {
      const evs = gen.generate(ctxFor(g, 1, "normal", { bar: i, slots: [{ start: 0, dur: 4, chord: parseChord(sym) }], next: null })).chords!;
      const first = evs.filter((e) => e.start === evs[0].start).map((e) => e.note).sort((a, b) => a - b);
      expect(first.every((n) => n >= 50 && n <= 70)).toBe(true);
      if (prev) expect(first.reduce((s, n, k) => s + Math.abs(n - (prev![k] ?? n)), 0)).toBeLessThanOrEqual(8);
      prev = first;
    }
  });

  it("is deterministic for a seed and differs across seeds", () => {
    const g = getGenre("funk");
    const run = (seed: number) => JSON.stringify(Array.from({ length: 8 }, (_, bar) => new GrooveGenerator().generate(ctxFor(g, 3, "normal", { bar, seed }))));
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
  });
});

describe("genre packs", () => {
  it("loads the three packs", () => {
    expect(genreIds().sort()).toEqual(["blues-rock", "funk", "jazz"]);
  });
  it("reports problems in a bad pack", () => {
    const good = JSON.parse(JSON.stringify(getGenreRaw("funk")));
    good.drums.levels[0][0].cowbell = "x...";
    good.bass.levels[1][0] = "R - Q";
    good.feel.swing = 3;
    good.chords.levels = [];
    try {
      loadGenre(good);
      expect.fail("should throw");
    } catch (e) {
      const msg = (e as GenreError).errors.join("\n");
      expect(msg).toMatch(/unknown drum line "cowbell"/);
      expect(msg).toMatch(/unknown bass step "Q"/);
      expect(msg).toMatch(/swing/);
      expect(msg).toMatch(/chords.levels must have 4 entries/);
    }
  });
});

describe("feel", () => {
  it("swings off-beats: 0 straight, 0.66 triplet", () => {
    expect(swingTime(0.5, 0, 8)).toBe(0.5);
    expect(swingTime(0.5, 0.66, 8)).toBeCloseTo(0.665, 3);
    expect(swingTime(1, 0.66, 8)).toBe(1);
    expect(swingTime(0.25, 0.5, 16)).toBeCloseTo(0.3125);
    expect(swingTime(2.75, 1, 16)).toBeCloseTo(2.875);
  });
  it("slows the last bar with a ritardando", () => {
    expect(ritTime(0, 4, 0.3)).toBeCloseTo(0);
    expect(ritTime(4, 4, 0.3)).toBeGreaterThan(4.5);
    expect(ritTime(2, 4, 0)).toBe(2);
  });
  it("keeps humanize inside the commit deadline for every genre", () => {
    // ADR-0005: bar N+1 is committed one beat minus the lookahead (0.1 s) before it starts.
    for (const g of allGenres())
      for (const bpm of [60, 120, 220]) {
        const c = loadChart({ ...small, bpm, genre: g.id });
        const e = new Engine(c, { seed: 3, countIn: 1 });
        const spb = 60 / bpm;
        for (let p = e.nextBar(); p; p = e.nextBar()) {
          const earliest = Math.min(...p.events.map((x) => x.start)) * spb;
          expect(earliest).toBeGreaterThanOrEqual(-MAX_OFFSET_MS / 1000 - 1e-9);
          expect(-earliest).toBeLessThan(spb - 0.1);
        }
      }
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
    expect(p.layers).toEqual(e.lineup.filter((x) => x !== "drums"));
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
    expect(second.repeated).toEqual(e.lineup);
    expect(second.events.map((x) => x.note)).toEqual(first.events.map((x) => x.note));
  });

  it("adds a fill before a new section and a crash on its downbeat", () => {
    const e = new Engine(loadChart(small), { intensity: 0.5 });
    const plans = Array.from({ length: 9 }, () => e.nextBar()!);
    expect(plans[7].stingers).toContain("fill");
    expect(plans[8].stingers).toContain("crash");
    expect(plans[8].events.some((x) => x.note === DRUM.crash && Math.abs(x.start) < 0.05)).toBe(true);
  });
});

describe("v0.1 arranger: count-in, endings, genres, swing", () => {
  it("counts in, then plays the form", () => {
    const e = new Engine(loadChart({ ...small, genre: "funk" }), { countIn: 1 });
    const first = e.nextBar()!;
    expect(first.kind).toBe("count_in");
    expect(first.events.filter((x) => x.part === "drums" && x.note === DRUM.stick).length).toBeGreaterThanOrEqual(3);
    expect(first.events.some((x) => x.part === "chords")).toBe(false);
    const second = e.nextBar()!;
    expect([second.kind, second.section, second.barInSection]).toEqual(["play", "a", 0]);
    expect(second.stingers).not.toContain("crash");
  });

  it("ends the form with a final hit and a ritardando", () => {
    const e = new Engine(loadChart({ ...small, genre: "blues-rock", key: "C major" }));
    let last: BarPlan | null = null;
    for (let p = e.nextBar(); p; p = e.nextBar()) last = p;
    expect(last!.kind).toBe("ending");
    expect(e.finished).toBe(true);
    // The final hit lands after the bar line (slowed down) and rings.
    const hit = last!.events.filter((x) => x.note === DRUM.crash && x.start > 4);
    expect(hit.length).toBeGreaterThan(0);
    const bass = last!.events.filter((x) => x.part === "bass" && x.start > 4);
    expect(bass.some((x) => x.note % 12 === 0 && x.dur > 2)).toBe(true);
  });

  it("end_song lands at the end of the phrase", () => {
    const e = new Engine(loadChart(small), { config: { loop: true } });
    e.nextBar();
    e.nextBar(); // a:1
    e.submit([{ move: "end_song", reason: "that's it" }], "you");
    const p2 = e.nextBar()!; // a:2
    expect(p2.moves[0]).toMatchObject({ status: "pending" });
    const p3 = e.nextBar()!; // a:3, last bar of the phrase
    expect(p3.kind).toBe("ending");
    expect(p3.moves.some((m) => m.status === "applied" && m.label === "end_song")).toBe(true);
    expect(e.nextBar()).toBeNull();
  });

  it("doesn't let a leader end the song", () => {
    const e = new Engine(loadChart(small), { config: { loop: true } });
    const c = new Conductor(e, { decide: () => ({ moves: [{ move: "end_song", reason: "bye" }], source: "llm" }) }, 1);
    for (let i = 0; i < 8; i++) c.barFinished(e.nextBar()!, []);
    expect(e.log.some((m) => m.label === "end_song")).toBe(false);
  });

  it("plays the same chart as different bands in different genres", () => {
    const run = (genre: string) => {
      const e = new Engine(loadChart({ ...small, genre }), { seed: 1, intensity: 0.6 });
      return Array.from({ length: 8 }, () => e.nextBar()!);
    };
    const funk = run("funk");
    const jazz = run("jazz");
    const rock = run("blues-rock");
    const cymbals = (plans: BarPlan[]) => new Set(plans.flatMap((p) => p.events.filter((x) => [DRUM.hat, DRUM.ride].includes(x.note as 42)).map((x) => x.note)));
    expect(cymbals(jazz)).toContain(DRUM.ride);
    expect(cymbals(funk)).toContain(DRUM.hat);
    // Funk's hats run in sixteenths; the others don't.
    const sixteenths = (plans: BarPlan[]) => plans[3].events.filter((x) => x.note === DRUM.hat || x.note === DRUM.ride).length;
    expect(sixteenths(funk)).toBeGreaterThan(sixteenths(rock));
    expect(funk[3].swing).toBeLessThan(0.3);
    expect(rock[3].swing).toBeGreaterThan(0.6);
  });

  it("swing 0 and 0.66 move the off-beats", () => {
    const offbeats = (swing: number) => {
      const e = new Engine(loadChart({ ...small, genre: "blues-rock", swing }), { seed: 2, intensity: 0.6 });
      e.nextBar();
      const p = e.nextBar()!;
      return p.events.filter((x) => x.note === DRUM.hat && x.start % 1 > 0.3 && x.start % 1 < 0.9).map((x) => x.start % 1);
    };
    const straight = offbeats(0);
    const swung = offbeats(0.66);
    expect(straight.every((t) => Math.abs(t - 0.5) < 0.03)).toBe(true);
    expect(swung.every((t) => Math.abs(t - 0.665) < 0.03)).toBe(true);
  });

  it("switches genre and swing live from the next bar", () => {
    const e = new Engine(loadChart({ ...small, genre: "funk" }), { config: { loop: true } });
    e.nextBar();
    e.setGenre(getGenre("jazz"));
    e.setSwing(0);
    const p = e.nextBar()!;
    expect([p.genre, p.swing]).toEqual(["jazz", 0]);
    e.setSwing(null);
    expect(e.nextBar()!.swing).toBe(getGenre("jazz").swing);
  });
});

describe("session record and replay", () => {
  /** A live-like run: transport order (commit one bar ahead), rule leader, pretend player, a manual move. */
  function record(chartJson: ChartJSON, genre: string, script: string, seed = 11): SessionFile {
    const c = loadChart(chartJson);
    const setup = { chart: chartJson, genre, swing: null, band: getGenre(genre).band, seed, countIn: 1, config: { loop: true }, leader: "rules", everyBars: 2 };
    const engine = new Engine(c, { seed, genre: getGenre(genre), countIn: 1, config: setup.config, band: setup.band });
    const rec = new SessionRecorder(setup);
    const conductor = new Conductor(engine, ruleLeader(new RuleLeader()), 2);
    const sim = new SimPlayer(4);
    const modes = parseScript(script);
    const tracker = new NoteTracker();
    const plans: BarPlan[] = [];
    const commit = () => {
      const p = engine.nextBar()!;
      plans.push(p);
      rec.bar(p);
      if (p.kind === "count_in") return;
      const start = p.bar * c.beatsPerBar;
      for (const n of sim.play(p, modes[Math.min(p.bar, modes.length - 1)], c.beatsPerBar)) {
        rec.note(start + n.start, n.note, n.vel);
        rec.note(start + n.start + n.dur, n.note, 0);
        tracker.noteOn(start + n.start, n.note, n.vel);
        tracker.noteOff(start + n.start + n.dur, n.note);
      }
    };
    commit();
    commit();
    for (let k = 0; k < modes.length; k++) {
      if (k === 10) engine.submit([{ move: "fire_stinger", stinger: "riser", reason: "Manual" }], "you");
      if (k === 14) engine.setSwing(0.3);
      conductor.barFinished(plans[k], tracker.bar(k * c.beatsPerBar, c.beatsPerBar));
      commit();
    }
    return JSON.parse(JSON.stringify(rec.finish(engine)));
  }

  it("replays a recorded session to the same band output, twice", async () => {
    for (const genre of genreIds()) {
      const file = record(nightShift, genre, "medium:4,sparse:8,busy:8,silent:6");
      expect(file.controls.some((x) => x.kind === "moves" && x.source === "rules")).toBe(true);
      const a = await replaySession(file);
      const b = await replaySession(file);
      expect(a.mismatches, genre).toEqual([]);
      expect(a.bars.length).toBe(file.bars.length);
      expect(a.bars.map((x) => x.hash)).toEqual(b.bars.map((x) => x.hash));
    }
  });

  it("flags bars that changed", async () => {
    const file = record(nightShift, "funk", "busy:12");
    file.seed += 1;
    const r = await replaySession(file);
    expect(r.mismatches.length).toBeGreaterThan(0);
  });

  it("re-runs a leader over the recorded playing", async () => {
    const file = record(nightShift, "funk", "medium:4,sparse:8,busy:8,silent:6");
    const r = await replaySession(file, { leader: ruleLeader(new RuleLeader()) });
    expect(r.decisions).toBeGreaterThan(5);
    const applied = r.plans.flatMap((p) => p.moves.filter((m) => m.status === "applied"));
    expect(applied.some((m) => m.source === "rules")).toBe(true);
    expect(applied.some((m) => m.source === "you")).toBe(true); // the player's own button survives
    // An async leader (like the LLM) is awaited.
    const slow: Leader = { decide: async () => ({ moves: [{ move: "set_intensity", value: 0.9, reason: "up" }], source: "llm" }) };
    const r2 = await replaySession(file, { leader: slow });
    expect(r2.plans.some((p) => p.moves.some((m) => m.source === "llm" && m.status === "applied"))).toBe(true);
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

describe("transport endings", () => {
  it("lets the final hit ring out before reporting the end", () => {
    let now = 0;
    let endedAt = -1;
    const played: number[] = [];
    const sink: Sink = { play: (_ev, time) => played.push(time), panic: () => {} };
    const short: ChartJSON = { title: "t", bpm: 120, time_sig: "4/4", genre: "blues-rock", sections: [{ name: "a", bars: 2, chords: ["C"] }], form: ["a"] };
    const t = new Transport(new Engine(loadChart(short)), { now: () => now }, sink, { onEnd: () => (endedAt = now) }, { lookahead: 0.1, startDelay: 0 });
    t.start();
    for (; now < 12 && endedAt < 0; now += 0.025) t.tick();
    // Two bars of 2 s; the ritardando and a 4-beat ring push the last note well past 4 s.
    const lastNote = Math.max(...played);
    expect(lastNote).toBeGreaterThan(4.5);
    expect(endedAt).toBeGreaterThan(lastNote + 1);
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
