import { describe, expect, it } from "vitest";
import { loadChart, validateChart } from "../src/core/chart";
import { Engine } from "../src/core/engine";
import type { PlayedNote } from "../src/core/features";
import {
  classifyPlayStyle,
  ColdTempo,
  detectLoop,
  FollowMeController,
  freeJamChart,
  inferBarChord,
  inferKey,
  nextChordCandidates,
  predictNextChord,
} from "../src/core/follow";
import { chordView } from "../src/core/fretboard";
import { getGenre } from "../src/core/genres";
import type { KeyValueStore } from "../src/core/platform";
import { replaySession, SessionRecorder } from "../src/core/session";
import {
  createBlankChart,
  isValidBarChord,
  normalizeDraft,
  PlayInCapture,
  resizeSectionChords,
  SavedChartStore,
} from "../src/core/song-editor";
import { parseChord } from "../src/core/theory";

/** Build a polyphonic comping bar from MIDI pitches strummed on beats 0 and 2. */
function compBar(notes: number[]): PlayedNote[] {
  const out: PlayedNote[] = [];
  for (const beat of [0, 2]) {
    for (let i = 0; i < notes.length; i++) {
      out.push({ start: beat + i * 0.01, dur: 1.5, note: notes[i], vel: 95 });
    }
  }
  return out;
}

/** Build a monophonic single-note melody bar (quarter notes). */
function melodyBar(notes: number[]): PlayedNote[] {
  return notes.map((note, i) => ({ start: i, dur: 0.85, note, vel: 92 }));
}

function memKV(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(k: string) => (map.has(k) ? (structuredClone(map.get(k)) as T) : null),
    set: (k: string, v: unknown) => void map.set(k, structuredClone(v)),
    remove: (k: string) => void map.delete(k),
  };
}

describe("ColdTempo", () => {
  it("latches onto 120 bpm from quarter-note onsets", () => {
    const ct = new ColdTempo(100);
    let est = ct.onset(1.0);
    expect(est.ready).toBe(false);
    est = ct.onset(1.5);
    est = ct.onset(2.0);
    est = ct.onset(2.5);
    est = ct.onset(3.0);
    expect(est.ready).toBe(true);
    expect(Math.abs(est.bpm - 120)).toBeLessThanOrEqual(2);
    expect(est.confidence).toBeGreaterThan(0.75);
  });

  it("collapses simultaneous chord notes (<65ms) into one onset and latches 96 bpm", () => {
    const ct = new ColdTempo(110);
    const beat = 60 / 96; // 0.625 s
    for (let b = 0; b < 5; b++) {
      const t = 2.0 + b * beat;
      ct.onset(t);
      ct.onset(t + 0.012);
      ct.onset(t + 0.025);
    }
    const est = ct.estimate();
    expect(est.onsets).toBe(5);
    expect(est.ready).toBe(true);
    expect(Math.abs(est.bpm - 96)).toBeLessThanOrEqual(2);
  });

  it("resets cleanly after a long pause (>3s)", () => {
    const ct = new ColdTempo(108);
    ct.onset(0.5);
    ct.onset(1.0);
    ct.onset(1.5);
    const afterGap = ct.onset(6.0);
    expect(afterGap.onsets).toBe(1);
    expect(afterGap.ready).toBe(false);
  });
});

describe("inferKey", () => {
  it("identifies A minor and Bb major from pitch-class weights", () => {
    const am = new Float64Array(12);
    // A(9), C(0), E(4) heavy + D(2), G(7), B(11), F(5)
    am[9] = 10; am[0] = 7; am[4] = 8; am[2] = 4; am[7] = 4; am[11] = 3; am[5] = 3;
    const kAm = inferKey(am);
    expect(kAm?.name).toBe("A minor");
    expect(kAm?.minor).toBe(true);

    const bb = new Float64Array(12);
    // Bb(10), D(2), F(5) heavy + C(0), Eb(3), G(7), A(9)
    bb[10] = 10; bb[2] = 7; bb[5] = 8; bb[0] = 4; bb[3] = 4; bb[7] = 4; bb[9] = 3;
    const kBb = inferKey(bb);
    expect(kBb?.name).toBe("Bb major");
    expect(kBb?.minor).toBe(false);
  });
});

describe("inferBarChord & Markov transitions", () => {
  it("classifies comping vs single-note melody", () => {
    expect(classifyPlayStyle(compBar([45, 52, 55, 60]))).toBe("comping");
    expect(classifyPlayStyle(melodyBar([69, 72, 76, 72]))).toBe("melody");
  });

  it("identifies polyphonic comping chords accurately", () => {
    const keyAm = { tonic: 9, minor: true, name: "A minor", confidence: 0.9 };
    expect(inferBarChord(compBar([45, 52, 55, 60]), 4, { key: keyAm, genre: "funk" })?.symbol).toBe("Am7");
    expect(inferBarChord(compBar([41, 48, 53, 57]), 4, { key: keyAm, genre: "funk" })?.symbol).toBe("F");
    expect(inferBarChord(compBar([48, 55, 60, 64]), 4, { key: keyAm, genre: "funk" })?.symbol).toBe("C");
    expect(inferBarChord(compBar([43, 50, 55, 59]), 4, { key: keyAm, genre: "funk" })?.symbol).toBe("G");
    expect(inferBarChord(compBar([50, 57, 60, 66]), 4, { genre: "blues-rock" })?.symbol).toBe("D7");
  });

  it("harmonizes a monophonic single-note melody using strong beats and key context", () => {
    const keyAm = { tonic: 9, minor: true, name: "A minor", confidence: 0.9 };
    // A - C - E - G arpeggio on beats 0..3 -> Am7 or Am
    const g = inferBarChord(melodyBar([69, 72, 76, 79]), 4, { key: keyAm, genre: "funk" });
    expect(g).not.toBeNull();
    expect(g?.style).toBe("melody");
    expect(["Am7", "Am"]).toContain(g?.symbol);
  });

  it("predicts genre-appropriate Markov next chords (jazz ii7 -> V7 -> Imaj7)", () => {
    const keyC = { tonic: 0, minor: false, name: "C major", confidence: 0.9 };
    expect(predictNextChord(parseChord("Dm7"), keyC, "jazz")).toBe("G7");
    expect(predictNextChord(parseChord("G7"), keyC, "jazz")).toBe("Cmaj7");
    const bluesCands = nextChordCandidates(parseChord("D7"), { tonic: 9, minor: false, name: "A major", confidence: 0.9 }, "blues-rock");
    expect(bluesCands[0]?.symbol).toBe("A7");
  });
});

describe("detectLoop & FollowMeController", () => {
  it("detects 2-bar and 4-bar repeating progressions", () => {
    expect(detectLoop(["Am7", "D7", "Am7", "D7"])).toEqual(["Am7", "D7"]);
    expect(detectLoop(["Am7", "F", "C", "G", "Am7", "F", "C", "G"])).toEqual(["Am7", "F", "C", "G"]);
    // Allows 1 turnaround variation in a 4-bar loop.
    expect(detectLoop(["Am7", "F", "C", "G", "Am7", "F", "C", "E7"])).toEqual(["Am7", "F", "C", "E7"]);
  });

  it("latches, detects a 4-bar loop, locks for soloing, pivots when unlocked, and exports a valid chart", () => {
    const ctrl = new FollowMeController("funk", 112);
    const am = compBar([45, 52, 55, 60]); // Am7
    const f = compBar([41, 48, 53, 57]);  // F
    const c = compBar([48, 55, 60, 64]);  // C
    const g = compBar([43, 50, 55, 59]);  // G
    const dm7 = compBar([50, 57, 60, 65]); // Dm7 (pivot chord)

    // Play 2 cycles of Am7 -> F -> C -> G
    const bars = [am, f, c, g, am, f, c, g];
    let st = ctrl.status;
    for (const notes of bars) st = ctrl.observeBar(notes, 4);

    expect(st.phase).toBe("following");
    expect(st.loop).toEqual(["Am7", "F", "C", "G"]);
    expect(st.chord).toBe("G");
    expect(st.nextChord).toBe("Am7");
    expect(ctrl.chordPrior()?.chord?.symbol).toBe("G");
    expect(ctrl.chordPrior()?.next?.symbol).toBe("Am7");

    // Lock the loop: playing silent or solo bars keeps cycling Am7 -> F -> C -> G
    st = ctrl.setLocked(true);
    expect(st.phase).toBe("locked");
    expect(ctrl.observeBar([], 4).chord).toBe("Am7");
    expect(ctrl.observeBar(melodyBar([74, 76, 79, 81]), 4).chord).toBe("F");

    // Unlock and pivot to Dm7 instead of C
    ctrl.setLocked(false);
    const pivotSt = ctrl.observeBar(dm7, 4);
    expect(pivotSt.chord).toBe("Dm7");
    expect(pivotSt.pivoted).toBe(true);

    // Export as ChartJSON — must pass JSON schema validation & loadChart()
    const exported = ctrl.exportChart({ title: "Studio Jam" });
    expect(validateChart(exported)).toEqual([]);
    const loaded = loadChart(exported);
    expect(loaded.bpm).toBe(112);
    expect(loaded.title).toBe("Studio Jam");
  });
});

describe("Engine live harmony & deterministic replay", () => {
  it("records live chord changes in controls and replays with 0 hash mismatches", async () => {
    const raw = freeJamChart("funk", 112, "Am7");
    const chart = loadChart(raw);
    const genre = getGenre("funk");
    const engine = new Engine(chart, { config: { loop: true }, seed: 42, genre, countIn: 0 });
    const recorder = new SessionRecorder({
      chart: raw,
      genre: "funk",
      swing: null,
      band: genre.band,
      seed: 42,
      countIn: 0,
      config: { loop: true },
      leader: "none",
      everyBars: 4,
    });

    const prog = ["Am7", "F", "C", "G", "Am7", "D7"];
    const plans = [];
    for (let i = 0; i < prog.length; i++) {
      engine.setLiveChord(prog[i], prog[(i + 1) % prog.length], "A minor");
      const plan = engine.nextBar()!;
      plans.push(plan);
      recorder.bar(plan);
    }

    expect(plans[0].liveHarmony).toBe(true);
    expect(plans[0].chords).toEqual(["Am7"]);
    expect(plans[0].key).toBe("A minor");
    expect(plans[5].chords).toEqual(["D7"]);
    expect(chordView(chart, plans[1], 0.5, plans[2]).chord?.symbol).toBe("F");

    const file = recorder.finish(engine);
    expect(file.controls.filter((c) => c.kind === "chord").length).toBe(prog.length);
    const rep = await replaySession(file);
    expect(rep.mismatches).toEqual([]);
    expect(rep.bars.length).toBe(prog.length);
  });
});

describe("Song Creator store, validation & Play-In capture", () => {
  it("saves, lists, updates and removes custom charts in KeyValueStore", () => {
    const store = new SavedChartStore(memKV());
    expect(store.list()).toEqual([]);

    const draft = createBlankChart("jazz");
    draft.title = "Midnight Sketch";
    const saved = store.save(draft);
    expect(store.list().length).toBe(1);
    expect(store.get(saved.id)?.chart.title).toBe("Midnight Sketch");

    draft.bpm = 132;
    store.save(draft, saved.id);
    expect(store.list().length).toBe(1);
    expect(store.get(saved.id)?.chart.bpm).toBe(132);

    store.remove(saved.id);
    expect(store.list()).toEqual([]);
  });

  it("validates bar chord strings, resizes chord grids, and normalizes drafts", () => {
    expect(isValidBarChord("Am7")).toBe(true);
    expect(isValidBarChord("Fm7 Bb7")).toBe(true);
    expect(isValidBarChord("notachord")).toBe(false);
    expect(resizeSectionChords(["Am7", "D7"], 4)).toEqual(["Am7", "D7", "Am7", "D7"]);

    const draft = createBlankChart("blues-rock");
    draft.title = "  ";
    draft.sections[0].chords = ["A7", "  ", "D7"];
    const { chart, errors } = normalizeDraft(draft);
    expect(errors).toEqual([]);
    expect(chart.title).toBe("Untitled");
    expect(chart.sections[0].chords).toEqual(["A7", "D7"]);
  });

  it("captures a 4-bar Play-In progression into chords and key", () => {
    const cap = new PlayInCapture(4, 4, "funk");
    const r0 = cap.pushBar(compBar([45, 52, 55, 60])); // Am7
    const r1 = cap.pushBar(compBar([41, 48, 53, 57])); // F
    const r2 = cap.pushBar(compBar([48, 55, 60, 64])); // C
    const r3 = cap.pushBar(compBar([43, 50, 55, 59])); // G
    expect(r0.done).toBe(false);
    expect(r1.chord).toBe("F");
    expect(r2.chord).toBe("C");
    expect(r3.done).toBe(true);
    const out = cap.finish();
    expect(out.chords).toEqual(["Am7", "F", "C", "G"]);
    expect(out.key).toMatch(/minor|major/);
  });
});
