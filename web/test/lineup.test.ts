/// <reference types="vite/client" />
// v0.2: lineups, instruments, the new parts and the genre packs' sound layers.
import { describe, expect, it } from "vitest";
import { CHANNELS } from "../src/audio/midi";
import { ceilingCurve, saturationCurve } from "../src/audio/mixer";
import { bandParts, defaultBand, INSTRUMENTS, instrumentsFor, parseBand, type Band } from "../src/core/band";
import { changeOptions, jevState } from "../src/core/brain/jev";
import { loadChart, validateChart, type ChartJSON } from "../src/core/chart";
import { Conductor, ruleLeader } from "../src/core/conductor";
import { Engine, type BarContext } from "../src/core/engine";
import { GENRE_FORMAT, GUITAR_VOICINGS, loadGenre } from "../src/core/genre";
import { allGenres, getGenre } from "../src/core/genres";
import { GrooveGenerator, PERC } from "../src/core/groove";
import { RuleLeader, type LeaderContext } from "../src/core/rules";
import { checkSession, replaySession, SessionRecorder } from "../src/core/session";
import { SimPlayer } from "../src/core/simplayer";
import { chordTones, parseChord } from "../src/core/theory";
import { PARTS, V01_PARTS, type NoteEvent, type Part } from "../src/core/types";
import bluesJson from "../public/charts/blues-in-a.json";
import lateSetJson from "../public/charts/late-set.json";
import nightShiftJson from "../public/charts/night-shift.json";

import manifestJson from "../public/samples/manifest.json";

const manifest = manifestJson as { instruments: Record<string, { part: string; bytes: number; zones: unknown[] }> };
const genreFiles = import.meta.glob("../../genres/*.json", { eager: true, import: "default" }) as Record<string, Record<string, unknown>>;
const rawGenre = (id: string) => structuredClone(genreFiles[`../../genres/${id}.json`]) as Record<string, any>;
const bakeoffSessions = import.meta.glob("../../docs/bakeoff/sessions-sim/*.json", { eager: true, import: "default" }) as Record<string, unknown>;

describe("instruments and samples", () => {
  it("has samples for every instrument in the catalog, for the right part", () => {
    for (const i of INSTRUMENTS) {
      const m = manifest.instruments[i.id];
      expect(m, i.id).toBeTruthy();
      expect(m.part).toBe(i.part);
      expect(m.zones.length).toBeGreaterThan(0);
    }
  });

  it("offers several sounds per part, as the roadmap asks", () => {
    expect(instrumentsFor("bass").map((i) => i.id)).toEqual(expect.arrayContaining(["electric", "upright", "synth"]));
    expect(instrumentsFor("chords").map((i) => i.id)).toEqual(expect.arrayContaining(["piano", "epiano", "organ"]));
    expect(instrumentsFor("drums").map((i) => i.id)).toEqual(expect.arrayContaining(["kit", "brushes", "electronic"]));
    for (const p of PARTS) expect(instrumentsFor(p).length, p).toBeGreaterThan(0);
  });

  it("keeps each genre's default lineup under 10 MB of samples", () => {
    for (const g of allGenres()) {
      const bytes = bandParts(g.band).reduce((n, p) => n + manifest.instruments[g.band[p]!.instrument].bytes, manifest.instruments.piano.bytes);
      expect(bytes, g.id).toBeLessThan(10e6);
    }
  });

  it("gives every part its own MIDI channel", () => {
    const chans = Object.values(CHANNELS);
    expect(new Set(chans).size).toBe(chans.length);
    for (const p of PARTS) expect(CHANNELS[p]).toBeTypeOf("number");
    expect(CHANNELS.drums).toBe(9);
  });
});

describe("bands", () => {
  it("parses short and long slots and reports bad ones", () => {
    const errs: string[] = [];
    const b = parseBand({ bass: "upright", chords: { instrument: "organ", volume: 0.5, pan: -0.4 } }, "band", errs);
    expect(errs).toEqual([]);
    expect(b).toEqual({ bass: { instrument: "upright" }, chords: { instrument: "organ", volume: 0.5, pan: -0.4 } });
    const bad: string[] = [];
    parseBand({ bass: "piano", flute: "x", drums: { instrument: "kit", volume: 2 } }, "band", bad);
    expect(bad.join("\n")).toMatch(/bass.instrument must be one of/);
    expect(bad.join("\n")).toMatch(/unknown part "flute"/);
    expect(bad.join("\n")).toMatch(/volume must be from 0 to 1/);
  });

  it("validates a chart's band and keeps v0.1 charts valid", () => {
    expect(validateChart(bluesJson)).toEqual([]);
    expect(loadChart(bluesJson).band).toEqual({ drums: { instrument: "kit" }, bass: { instrument: "electric" }, chords: { instrument: "organ" }, guitar: { instrument: "crunch" } });
    const old = { ...(nightShiftJson as ChartJSON), version: "0.1" };
    expect(validateChart(old)).toEqual([]);
    expect(loadChart(old).band).toBeUndefined();
    expect(validateChart({ ...old, band: { bass: "organ" } }).join()).toMatch(/band.bass.instrument/);
  });
});

describe("genre packs, v0.2 layers", () => {
  it("load as format 0.2 with a band, lineups, a mix and grooves for every part", () => {
    for (const g of allGenres()) {
      expect(g.parts).toEqual([...PARTS]);
      expect(g.guitar && g.pad && g.percussion, g.id).toBeTruthy();
      expect(bandParts(g.band).length).toBeGreaterThanOrEqual(3);
      expect(g.lineups.length).toBeGreaterThanOrEqual(3);
      for (const l of g.lineups) expect(bandParts(l.band).every((p) => g.parts.includes(p))).toBe(true);
    }
    for (const raw of Object.values(genreFiles)) expect(raw.format).toBe(GENRE_FORMAT);
  });

  it("gives each genre its own default band and mix", () => {
    const [funk, blues, jazz] = ["funk", "blues-rock", "jazz"].map(getGenre);
    expect(jazz.band).toEqual({ drums: { instrument: "brushes" }, bass: { instrument: "upright" }, chords: { instrument: "piano" } });
    expect(blues.band.guitar?.instrument).toBe("crunch");
    expect(funk.band.chords?.instrument).toBe("epiano");
    expect(jazz.mix.reverb.seconds).toBeGreaterThan(funk.mix.reverb.seconds);
    expect(blues.mix.saturation).toBeGreaterThan(jazz.mix.saturation);
  });

  it("still loads a v0.1 pack: three parts, default sounds and mix", () => {
    const raw = rawGenre("funk");
    for (const k of ["band", "lineups", "mix", "guitar", "pad", "percussion"]) delete raw[k];
    for (const p of ["guitar", "pad", "percussion"]) delete raw.humanize[p];
    raw.format = "jamstate-genre/0.1";
    raw.parts = ["drums", "bass", "chords"];
    const g = loadGenre({ ...raw, id: "funk-old" });
    expect(g.parts).toEqual(V01_PARTS);
    expect(g.band).toEqual(defaultBand(V01_PARTS));
    expect(g.guitar).toBeNull();
  });

  it("rejects a pack whose band names a part it has no groove for", () => {
    const raw = rawGenre("jazz");
    raw.parts = ["drums", "bass", "chords", "guitar", "pad"];
    delete raw.percussion;
    raw.band = { ...raw.band, percussion: "hand" };
    expect(() => loadGenre(raw)).toThrow(/this genre has no percussion part/);
  });
});

describe("the new parts", () => {
  const chart = loadChart(lateSetJson);
  const ctxFor = (genre: string, level: number, extra: Partial<BarContext> = {}): BarContext => {
    const g = getGenre(genre);
    return {
      bar: 5, kind: "play", section: "A", barInSection: 1, sectionBars: 8, barInPhrase: 1, phraseBars: 4, lastBarOfSection: false, level,
      feel: "normal", parts: ["guitar", "pad", "percussion"], band: g.band, slots: chart.sections.get("A")!.barChords(0), next: parseChord("Cm7"),
      bpb: 4, genre: g, seed: 3, stingers: [], cymbal: "ride", ending: null, firstChord: parseChord("Bbmaj7"), ...extra,
    };
  };
  const inBar = (evs: NoteEvent[]) => evs.every((e) => e.start >= 0 && e.start < 4 && e.vel >= 1 && e.vel <= 127 && e.dur > 0);

  it("plays guitar, pad and percussion at every level in every genre, inside the bar", () => {
    for (const g of allGenres())
      for (let level = 1; level < 4; level++) {
        const out = new GrooveGenerator().generate(ctxFor(g.id, level));
        for (const p of ["guitar", "pad", "percussion"] as Part[]) {
          expect(out[p]!.length, `${g.id} ${p} level ${level}`).toBeGreaterThan(0);
          expect(inBar(out[p]!), `${g.id} ${p}`).toBe(true);
          expect(out[p]!.every((e) => e.part === p)).toBe(true);
        }
        expect(out.percussion!.every((e) => Object.values(PERC).includes(e.note))).toBe(true);
      }
  });

  it("never holds a pad chord over a chord change", () => {
    const ctx = ctxFor("jazz", 2);
    const pad = new GrooveGenerator().generate(ctx).pad!;
    for (const e of pad) {
      const slot = [...ctx.slots].reverse().find((s) => e.start >= s.start - 1e-6)!;
      expect(e.start + e.dur).toBeLessThanOrEqual(slot.start + slot.dur + 1e-6);
      expect(chordTones(slot.chord, 0, 127).map((n) => n % 12)).toContain(e.note % 12);
    }
  });

  it("voices blues-rock guitar as power chords on the chord's root", () => {
    const out = new GrooveGenerator().generate(ctxFor("blues-rock", 2, { slots: [{ start: 0, dur: 4, chord: parseChord("A7") }] })).guitar!;
    const first = out.filter((e) => e.start === out[0].start).map((e) => e.note).sort((a, b) => a - b);
    expect(first[0] % 12).toBe(9);
    expect(first.map((n) => n - first[0])).toEqual([0, 7, 12]);
    expect(GUITAR_VOICINGS).toContain("power");
  });

  it("strums guitar upstrokes off the beat (high strings first)", async () => {
    const { applyFeel } = await import("../src/core/feel");
    const evs: NoteEvent[] = [40, 47, 52].flatMap((n) => [{ start: 0, dur: 0.4, note: n, vel: 90, part: "guitar" as const }, { start: 0.5, dur: 0.4, note: n, vel: 90, part: "guitar" as const }]);
    const h = { offsetMs: 0, jitterMs: 0, velocity: 0, spreadMs: 12, lines: {} };
    const out = applyFeel(evs, "guitar", { swing: 0, unit: 8, bpm: 120, humanize: h, rand: () => 0.5 });
    const down = out.filter((_, i) => evs[i].start === 0);
    const up = out.filter((_, i) => evs[i].start === 0.5);
    expect(down.find((e) => e.note === 40)!.start).toBeLessThan(down.find((e) => e.note === 52)!.start);
    expect(up.find((e) => e.note === 52)!.start).toBeLessThan(up.find((e) => e.note === 40)!.start);
  });
});

describe("lineup in the engine", () => {
  it("plays the chart's band, else the genre's", () => {
    expect(new Engine(loadChart(bluesJson)).lineup).toEqual(["drums", "bass", "chords", "guitar"]);
    expect(new Engine(loadChart(lateSetJson)).lineup).toEqual(["drums", "bass", "chords"]);
    const nb = { ...(bluesJson as ChartJSON) };
    delete nb.band;
    expect(new Engine(loadChart(nb)).band).toEqual(getGenre("blues-rock").band);
  });

  it("rejects add/drop for parts outside the lineup and lets new parts join and leave", () => {
    const e = new Engine(loadChart(lateSetJson), { seed: 2 });
    e.nextBar();
    e.submit([{ move: "add_layer", part: "guitar", reason: "" }], "t");
    expect(e.nextBar()!.moves[0].note).toMatch(/no guitar in the lineup/);
    e.setBand({ ...e.band, guitar: { instrument: "jazz-guitar" } });
    let p = e.nextBar()!;
    expect(p.layers).toContain("guitar");
    expect(p.events.some((x) => x.part === "guitar")).toBe(true);
    e.setBand({ drums: { instrument: "brushes" }, bass: { instrument: "upright" } });
    p = e.nextBar()!;
    expect(p.layers).toEqual(["drums", "bass"]);
    expect(p.events.some((x) => x.part === "chords" || x.part === "guitar")).toBe(false);
    expect(e.controls.filter((c) => c.kind === "band")).toHaveLength(2);
  });

  it("tells the leaders who is in the band", () => {
    const e = new Engine(loadChart(bluesJson), { seed: 2 });
    const plan = e.nextBar()!;
    const ctx = new Conductor(e, null).context({ ...plan, layers: ["drums", "bass", "chords"] }, { bars: 4, energy: 0.6, density: 2, mean_velocity: 0.6, rest_ratio: 0.2, repetition: 0.2, register: "mid", trend: "steady", silent_bars: 0 });
    expect(ctx.lineup).toEqual(["drums", "bass", "chords", "guitar"]);
    expect([...changeOptions(ctx).keys()]).toContain("add_guitar");
    expect(jevState(ctx).band).toMatchObject({ not_playing: ["guitar"] });
    // Without a lineup (an older context), the v0.1 band.
    const old: LeaderContext = { ...ctx, lineup: undefined };
    expect([...changeOptions(old).keys()].some((k) => k === "add_guitar")).toBe(false);
    const moves = new RuleLeader().decide({ ...ctx, player: { ...ctx.player, energy: 0.95 } });
    expect(moves.some((m) => m.move === "add_layer" && m.part === "guitar")).toBe(true);
  });

  it("records lineup changes and replays them exactly", async () => {
    const chartJson = bluesJson as ChartJSON;
    const c = loadChart(chartJson);
    const band: Band = c.band!;
    const setup = { chart: chartJson, genre: "blues-rock", swing: null, band, seed: 21, countIn: 1, config: { loop: true }, leader: "rules", everyBars: 2 };
    const engine = new Engine(c, { seed: 21, countIn: 1, config: setup.config, band });
    const rec = new SessionRecorder(setup);
    const conductor = new Conductor(engine, ruleLeader(new RuleLeader()), 2);
    const sim = new SimPlayer(5);
    const plans = [engine.nextBar()!];
    for (let i = 0; i < 20; i++) {
      if (i === 5) engine.setBand({ ...engine.band, chords: { instrument: "piano" }, percussion: { instrument: "hand" } });
      if (i === 11) engine.setBand({ drums: { instrument: "kit" }, bass: { instrument: "electric" }, guitar: { instrument: "crunch" } });
      plans.push(engine.nextBar()!);
      const plan = plans[i];
      rec.bar(plan);
      const notes = plan.kind === "count_in" ? [] : sim.play(plan, "medium", 4);
      for (const n of notes) rec.note(i * 4 + n.start, n.note, n.vel), rec.note(i * 4 + n.start + n.dur, n.note, 0);
      conductor.barFinished(plan, notes.map((n) => ({ ...n, start: i * 4 + n.start })));
    }
    const f = checkSession(JSON.parse(JSON.stringify(rec.finish(engine))));
    expect(f.band).toEqual({ drums: "kit", bass: "electric", chords: "organ", guitar: "crunch" });
    expect(f.bars.some((b) => b.layers.includes("percussion"))).toBe(true);
    const r = await replaySession(f);
    expect(r.mismatches).toEqual([]);
  });

  it("replays every v0.1.1 session exactly (the bake-off set)", async () => {
    const files = Object.entries(bakeoffSessions);
    expect(files.length).toBeGreaterThan(0);
    for (const [name, raw] of files) {
      const f = checkSession(structuredClone(raw));
      expect(f.band).toBeUndefined();
      const r = await replaySession(f);
      expect(r.mismatches, name).toEqual([]);
    }
  });
});

describe("mix curves", () => {
  it("saturation is monotonic and keeps full scale; the ceiling never reaches 0 dBFS", () => {
    for (const amt of [0, 0.35, 1]) {
      const c = saturationCurve(amt);
      for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
      expect(c[c.length - 1]).toBeCloseTo(1, 5);
    }
    const ceil = ceilingCurve();
    expect(Math.max(...ceil)).toBeLessThan(0.97);
    expect(ceil[Math.floor(ceil.length * 0.75)]).toBeCloseTo(0.5, 2); // straight below the knee
  });
});
