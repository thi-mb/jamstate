import { describe, expect, it } from "vitest";
import { SongArc } from "../src/core/arc";
import { defaultBand } from "../src/core/band";
import { loadChart, type ChartJSON } from "../src/core/chart";
import { Conductor, ruleLeader } from "../src/core/conductor";
import { DEFAULT_GOVERNOR, Engine, type BarPlan } from "../src/core/engine";
import { runScenario } from "../src/core/eval/run";
import { NoteTracker } from "../src/core/features";
import { loadGenre } from "../src/core/genre";
import { allGenres, getGenre } from "../src/core/genres";
import { DEFAULT_LEADING, followLevel, guardFollow, leadingPack, leadingStyle } from "../src/core/leading";
import { RuleLeader, type LeaderContext } from "../src/core/rules";
import { replaySession, SessionRecorder } from "../src/core/session";
import { parseScript, SimPlayer } from "../src/core/simplayer";
import { Trader } from "../src/core/trade";
import { songScale } from "../src/core/fretboard";
import { parseChord } from "../src/core/theory";
import funkJson from "../../genres/funk.json";
import nightShift from "../public/charts/night-shift.json";
import lateSet from "../public/charts/late-set.json";

const json = nightShift as ChartJSON;
const chart = loadChart(json);

describe("the leading layer in genre packs", () => {
  it("every pack has one, and they differ", () => {
    const [funk, rock, jazz] = ["funk", "blues-rock", "jazz"].map((g) => getGenre(g).leading);
    expect(new Set([funk.arc, rock.arc, jazz.arc])).toEqual(new Set(["locked", "build", "dynamic"]));
    expect(jazz.trade.soloists[0]).toBe("drums");
    for (const g of allGenres()) expect(g.leading.taste.length).toBeGreaterThan(0);
  });

  it("missing gives the defaults; bad fields are errors", () => {
    expect(leadingPack(undefined, [])).toEqual(DEFAULT_LEADING);
    const errs: string[] = [];
    leadingPack({ activity: [0.8, 0.2], arc: "wild", favour: ["end_song"], trade: { bars: 3, soloists: ["pad"] }, mood: 1 }, errs);
    expect(errs.join(" ")).toMatch(/activity.*arc.*favour.*bars.*soloists.*mood|unknown field "mood"/s);
    const { leading: _drop, ...noLeading } = funkJson as Record<string, unknown>;
    expect(loadGenre(noLeading).leading).toEqual(DEFAULT_LEADING);
  });
});

describe("personality", () => {
  it("at activity 0.5 is the v0.3 governor; steadier waits longer, adventurous less", () => {
    const mid = leadingStyle({ ...DEFAULT_LEADING, activity: [0.5, 0.5] }, "supportive");
    expect(mid.governor).toEqual({ layerDwellBars: DEFAULT_GOVERNOR.layerDwellBars, feelDwellBars: DEFAULT_GOVERNOR.feelDwellBars, intensityDeadband: DEFAULT_GOVERNOR.intensityDeadband });
    const g = getGenre("blues-rock").leading;
    const [steady, adv] = [leadingStyle(g, "steady"), leadingStyle(g, "adventurous")];
    expect(steady.activity).toBe(g.activity[0]);
    expect(adv.activity).toBe(g.activity[1]);
    expect(steady.governor.layerDwellBars).toBeGreaterThan(adv.governor.layerDwellBars);
    expect(steady.governor.intensityDeadband).toBeGreaterThan(adv.governor.intensityDeadband);
  });

  it("sets the engine's governor only when given (older sessions keep theirs)", () => {
    expect(new Engine(chart, { genre: getGenre("funk") }).config.layerDwellBars).toBe(DEFAULT_GOVERNOR.layerDwellBars);
    const e = new Engine(chart, { genre: getGenre("funk"), personality: "steady" });
    expect(e.config.layerDwellBars).toBe(leadingStyle(getGenre("funk").leading, "steady").governor.layerDwellBars);
    e.setPersonality("adventurous");
    expect(e.config.layerDwellBars).toBe(leadingStyle(getGenre("funk").leading, "adventurous").governor.layerDwellBars);
    expect(e.controls.at(-1)).toMatchObject({ kind: "personality", personality: "adventurous" });
  });

  it("changes how much the rule leader moves over the same playing", async () => {
    const moves = async (personality: "steady" | "adventurous") => {
      const r = await runScenario({ chart: lateSet as ChartJSON, modes: parseScript("medium:4,busy:8,sparse:8,medium:8,held:4,busy:8"), bars: 40, leader: ruleLeader(new RuleLeader()), everyBars: 2, seed: 1, personality });
      return r.plans.flatMap((p) => p.moves).filter((m) => m.status === "applied" && m.source === "rules").length;
    };
    expect(await moves("adventurous")).toBeGreaterThanOrEqual(2 * (await moves("steady")));
  });
});

describe("song arc", () => {
  const plan = (section: string, formPos: number, barInSection: number, intensity: number, layers = ["drums", "bass", "chords", "guitar"]): BarPlan =>
    ({ kind: "play", section, formPos, barInSection, sectionBars: 8, intensity, layers, lineup: ["drums", "bass", "chords", "guitar", "percussion"], feel: "normal" }) as unknown as BarPlan;
  /** Play a whole visit, and the first bar of whatever comes next so the visit counts as finished. */
  const visit = (arc: SongArc, section: string, formPos: number, level: number, layers?: string[]) => {
    for (let b = 0; b < 8; b++) arc.observe(plan(section, formPos, b, level, layers));
    arc.observe(plan("next", 99, 0, level, layers));
  };
  const form = ["verse", "chorus", "verse", "chorus", "chorus"];

  it("builds: the second time bigger, with a part brought in; the last time the peak", () => {
    const arc = new SongArc("build", form);
    visit(arc, "verse", 0, 0.4);
    visit(arc, "chorus", 1, 0.6);
    const p = arc.planFor("chorus", 2, 3, ["drums", "bass", "chords", "guitar", "percussion"]);
    expect(p.change).toBeGreaterThan(0);
    expect(p.aim).toBeCloseTo(0.72);
    expect(p.add).toBe("percussion");
    expect(arc.planFor("chorus", 3, 4, ["drums"]).change).toBeGreaterThan(p.change);
    expect(arc.planFor("bridge", 1, 2, ["drums"]).aim).toBeNull();
  });

  it("dynamic: down and thinner after a big one, up after a quiet one", () => {
    const arc = new SongArc("dynamic", form);
    visit(arc, "chorus", 1, 0.7);
    const down = arc.planFor("chorus", 2, 3, ["drums", "bass", "chords"]);
    expect(down.change).toBeLessThan(0);
    expect(down.drop).toBe("chords");
    visit(arc, "verse", 2, 0.3, ["drums", "bass"]);
    const up = arc.planFor("verse", 2, 4, ["drums", "bass", "chords"]);
    expect(up.change).toBeGreaterThan(0);
    expect(up.add).toBe("chords");
  });

  it("locked: same level, another texture", () => {
    const arc = new SongArc("locked", form);
    visit(arc, "chorus", 1, 0.7, ["drums", "bass", "chords", "guitar", "percussion"]);
    const p = arc.planFor("chorus", 2, 3, ["drums", "bass", "chords", "guitar", "percussion"]);
    expect(p.change).toBe(0);
    expect(p.drop).toBe("percussion");
  });

  it("goes into every summary, with the next section's plan", () => {
    const seen: LeaderContext[] = [];
    const e = new Engine(chart, { seed: 1, genre: getGenre("funk"), countIn: 0, personality: "supportive" });
    const c = new Conductor(e, { decide: (ctx) => (seen.push(ctx), { moves: [], source: "t" }) }, 4);
    for (let b = 0; b < 8; b++) c.barFinished(e.nextBar()!, []);
    expect(seen[1].arc?.now.section).toBe("verse");
    expect(seen[1].arc?.next?.section).toBe("chorus");
    expect(seen[1].arc?.so_far.map((v) => v.section)).toEqual(["intro"]);
    expect(seen[1].leading).toMatchObject({ personality: "supportive", taste: getGenre("funk").leading.taste });
    expect(seen[1].trading).toBeUndefined();
  });
});

/** A live-like jam: player notes from a script, a trader listening, a recorder. */
function jam(script: string, bars: number, trade: boolean, chartJson: ChartJSON = json) {
  const c = loadChart(chartJson);
  const setup = { chart: chartJson, genre: c.genre ?? "funk", swing: null, band: c.band ?? getGenre(c.genre ?? "funk").band, seed: 3, countIn: 0, config: {}, leader: "none", everyBars: 4, listening: "none", personality: "supportive" as const };
  const rec = new SessionRecorder(setup);
  const e = new Engine(c, { seed: 3, genre: getGenre(setup.genre), countIn: 0, band: setup.band, personality: "supportive" });
  if (trade) e.setTrading(true);
  const cond = new Conductor(e, null, 4);
  cond.trader = new Trader(e);
  const sim = new SimPlayer(3);
  const tracker = new NoteTracker();
  const modes = parseScript(script);
  const plans: BarPlan[] = [];
  const bpb = c.beatsPerBar;
  const commit = () => {
    const p = e.nextBar();
    if (!p) return;
    plans.push(p);
    rec.bar(p);
    for (const n of sim.play(p, modes[Math.min(p.bar, modes.length - 1)], bpb)) {
      tracker.noteOn(p.bar * bpb + n.start, n.note, n.vel);
      tracker.noteOff(p.bar * bpb + n.start + n.dur, n.note);
      rec.note(p.bar * bpb + n.start, n.note, n.vel);
      rec.note(p.bar * bpb + n.start + n.dur, n.note, 0);
    }
  };
  commit();
  commit();
  for (let k = 0; k < bars && k < plans.length; k++) {
    cond.barFinished(plans[k], tracker.bar(k * bpb, bpb));
    if (plans.length < bars) commit();
  }
  return { plans, file: rec.finish(e), engine: e };
}

describe("trading fours", () => {
  it("the band answers after each phrase the player plays, and not in theirs", () => {
    const { plans } = jam("busy:4,silent:4,busy:4,silent:4,busy:4", 20, true);
    for (const b of [4, 5, 6, 7, 12, 13, 14, 15]) expect(plans[b].solo, `bar ${b}`).toBeTruthy();
    for (const b of [0, 3, 8, 11, 16]) expect(plans[b].solo, `bar ${b}`).toBeFalsy();
    // Night Shift is funk: keys first, then guitar, over the rest of the band.
    expect(plans[4].solo?.part).toBe("chords");
    expect(plans[12].solo?.part).toBe("guitar");
    expect(plans[4].layers).toEqual(expect.arrayContaining(["drums", "bass", "chords"]));
    const solo = plans[5].events.filter((n) => n.part === "chords");
    expect(solo.length).toBeGreaterThan(0);
    expect(solo.every((n) => n.note >= 55 && n.note <= 84)).toBe(true);
  });

  it("melodic answers stay in the song's key or on the chord, even after an outside phrase", () => {
    // Night Shift is in F minor: off the beat the answer may use the key's notes, on the beat only chord tones.
    const key = songScale(chart, getGenre("funk").listening)!.pcs;
    for (const mode of ["busy", "outside", "syncopated"]) {
      const { plans } = jam(`${mode}:4,silent:4,${mode}:4,silent:4`, 16, true);
      for (const p of plans.filter((x) => x.solo)) {
        const tones = (c: string) => { const ch = parseChord(c); return ch.intervals.map((i) => (ch.root + i) % 12); };
        for (const n of p.events.filter((e) => e.part === p.solo!.part)) {
          const pc = n.note % 12;
          expect(tones(p.chords[0]).includes(pc) || key.includes(pc), `${mode} bar ${p.bar} ${p.chords[0]}: ${n.note}`).toBe(true);
        }
      }
    }
  });

  it("keeps the player's off-beat notes only when they're in the key: no D natural over Fm in F minor", () => {
    const e = new Engine(chart, { seed: 1, genre: getGenre("funk"), countIn: 0 });
    for (let b = 0; b < 4; b++) e.nextBar();
    e.setTrading(true);
    // F, D natural, A flat, G flat: D and G flat are each a chord's textbook scale note but outside F minor.
    const motif = [0, 1, 2, 3].flatMap((bar) => [{ start: bar * 4, dur: 0.5, note: 77, vel: 100 }, { start: bar * 4 + 0.5, dur: 0.5, note: 74, vel: 90 }, { start: bar * 4 + 2, dur: 0.5, note: 80, vel: 100 }, { start: bar * 4 + 2.5, dur: 0.5, note: 78, vel: 90 }]);
    e.setSolo({ part: "chords", from: 4, bars: 4, motif });
    const notes = [4, 5, 6, 7].flatMap(() => e.nextBar()!.events.filter((n) => n.part === "chords").map((n) => n.note % 12));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.filter((pc) => pc === 2 || pc === 6)).toEqual([]);
  });

  it("hands back when the player comes in early", () => {
    const { plans } = jam("busy:4,silent:1,busy:7", 10, true);
    expect(plans[4].solo).toBeTruthy();
    expect(plans[7].solo).toBeFalsy();
  });

  it("a sat-out turn gets no answer, and trading off gets none at all", () => {
    expect(jam("busy:4,silent:12", 16, true).plans.slice(8).some((p) => p.solo)).toBe(false);
    expect(jam("busy:4,silent:4,busy:4,silent:4", 16, false).plans.some((p) => p.solo)).toBe(false);
  });

  it("in jazz the drums take the first turn, alone, and hand back with a crash", () => {
    const { plans } = jam("busy:4,silent:4,busy:4", 12, true, lateSet as ChartJSON);
    expect(plans[4].solo?.part).toBe("drums");
    expect(plans[4].layers).toEqual(["drums"]);
    expect(plans[8].stingers).toContain("crash");
  });

  it("the governor keeps the band in while trading", () => {
    const e = new Engine(chart, { seed: 1, genre: getGenre("funk"), countIn: 0 });
    e.setTrading(true);
    e.nextBar();
    e.submit([{ move: "drop_layer", part: "drums", reason: "x" }, { move: "change_feel", feel: "half_time", reason: "x" }, { move: "set_intensity", value: 0.05, reason: "x" }], "llm");
    const p = e.nextBar()!;
    expect(p.moves.every((m) => m.status === "rejected" && m.note?.startsWith("trading"))).toBe(true);
    e.submit([{ move: "drop_layer", part: "drums", reason: "x" }], "you");
    expect(e.nextBar()!.moves[0].status).toBe("applied");
  });

  it("is recorded with the session and replays exactly without a trader", async () => {
    const { file } = jam("busy:4,silent:4,busy:4,silent:1,busy:6", 20, true);
    expect(file.personality).toBe("supportive");
    expect(file.controls.filter((c) => c.kind === "solo").length).toBeGreaterThanOrEqual(2);
    expect((await replaySession(file)).mismatches).toEqual([]);
  });
});

describe("genre taste in the rule leader", () => {
  it("never makes a move the genre avoids, over varied playing in each genre", async () => {
    for (const genre of ["funk", "blues-rock", "jazz"]) {
      const r = await runScenario({ chart: json, genre, modes: parseScript("medium:4,busy:8,sparse:8,medium:8,held:4,busy:8"), bars: 40, leader: ruleLeader(new RuleLeader()), everyBars: 2, seed: 2, personality: "adventurous" });
      const avoid = getGenre(genre).leading.avoid;
      const made = r.plans.flatMap((p) => p.moves).filter((m) => m.status === "applied" && m.source === "rules").map((m) => m.label);
      for (const tag of avoid) expect(made.some((l) => l.startsWith(tag.split(":")[0]) && (!tag.includes(":") || l.includes(tag.split(":")[1]))), `${genre}: ${tag}`).toBe(false);
    }
  });

  it("an empty band is never asked to solo", () => {
    const e = new Engine(chart, { seed: 1, genre: getGenre("funk"), countIn: 0, band: defaultBand(["drums", "bass"]) });
    expect(new Trader(e).soloist()).toBeNull();
  });
});

describe("following comes first (v0.4 policy)", () => {
  const p = (energy: number, silent_bars = 0) => ({ energy, silent_bars, bars: 4 });
  it("the follow level reads stopping, breathing, held notes and swells", () => {
    expect(followLevel(p(0, 4), {}, 0.6)).toMatchObject({ level: 0.15, why: "stopped", gap: "band 0.45 louder" });
    expect(followLevel(p(0.2, 1), { state: "breathing" }, 0.6)).toMatchObject({ level: 0.6, gap: "matched" });
    expect(followLevel(p(0.5), { held: 0.8 }, 0.5).level).toBe(0.35);
    expect(followLevel(p(0.8), { shape: "decrescendo" }, 0.9)).toMatchObject({ level: 0.78, why: "getting softer" });
    expect(followLevel(p(0.9), {}, 0.5)).toMatchObject({ why: "busy", gap: "band 0.47 softer" });
  });

  const ctx = (follow: ReturnType<typeof followLevel>, extra: object = {}) => ({ target: 0.6, layers: ["drums", "bass", "chords"], leading: { follow }, ...extra });
  it("a stopped player gets the level down and the drums out, nothing added", () => {
    const out = guardFollow(ctx(followLevel(p(0, 4), {}, 0.6)), [{ move: "add_layer", part: "guitar", reason: "x" }]);
    expect(out.map((m) => `${m.move}:${m.value ?? m.part}`)).toEqual(["set_intensity:0.15", "drop_layer:drums"]);
  });
  it("adds the level when the reply left it off, keeps the LLM's other move", () => {
    const out = guardFollow(ctx(followLevel(p(0.2), {}, 0.6)), [{ move: "fire_stinger", stinger: "fill", reason: "x" } as never]);
    expect(out.map((m) => m.move)).toEqual(["set_intensity", "fire_stinger"]);
    expect(out[0].value).toBe(0.28);
  });
  it("a busy player keeps the whole band; trading and matched replies stand", () => {
    expect(guardFollow(ctx(followLevel(p(0.9), {}, 0.95)), [{ move: "drop_layer", part: "chords", reason: "x" }])).toEqual([]);
    const reply = [{ move: "drop_layer", part: "chords", reason: "x" }];
    expect(guardFollow(ctx(followLevel(p(0, 4), {}, 0.6), { trading: {} }), reply)).toEqual(reply);
    expect(guardFollow(ctx(followLevel(p(0.5), {}, 0.55)), reply)).toEqual(reply);
  });
});

describe("the follow guard after a stop", () => {
  it("brings the drums back when the player plays again", () => {
    const follow = followLevel({ energy: 0.5, silent_bars: 0, bars: 4 }, { state: "playing" }, 0.15);
    const out = guardFollow({ target: 0.15, layers: ["bass", "chords"], lineup: ["drums", "bass", "chords"], leading: { follow } }, []);
    expect(out.map((m) => `${m.move}:${m.value ?? m.part}`)).toEqual(["set_intensity:0.55", "add_layer:drums"]);
  });
});
