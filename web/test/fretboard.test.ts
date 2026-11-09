import { describe, expect, it } from "vitest";
import { loadChart, type ChartJSON } from "../src/core/chart";
import { Engine } from "../src/core/engine";
import { chordView, followWindow, guitarCells, markOf, pianoCells, scaleMarkOf, songScale, GUITAR_FRETS, GUITAR_STRINGS, PIANO_KEYS } from "../src/core/fretboard";
import { getGenre } from "../src/core/genres";
import { parseChord } from "../src/core/theory";
import bluesInA from "../public/charts/blues-in-a.json";
import lateSet from "../public/charts/late-set.json";
import nightShift from "../public/charts/night-shift.json";

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/** Pitch-class names by mark, for one octave from C. */
function marks(symbol: string, genre: string) {
  const chord = parseChord(symbol);
  const out: Record<string, string[]> = { chord: [], scale: [], none: [] };
  for (let pc = 0; pc < 12; pc++) out[markOf(60 + pc, chord, getGenre(genre).listening) ?? "none"].push(NAMES[pc]);
  return out;
}

describe("fretboard marks", () => {
  it("blues-rock A7: chord tones strong, the blues scale faint", () => {
    expect(marks("A7", "blues-rock")).toEqual({ chord: ["C#", "E", "G", "A"], scale: ["C", "D", "Eb", "F#", "B"], none: ["F", "Ab", "Bb"] });
  });

  it("funk Fm: the minor colours, the rest outside", () => {
    expect(marks("Fm", "funk")).toEqual({ chord: ["C", "F", "Ab"], scale: ["D", "Eb", "G", "Bb", "B"], none: ["C#", "E", "F#", "A"] });
  });

  it("jazz: anything goes over a dominant, not over a major seventh", () => {
    expect(marks("G7", "jazz").none).toEqual([]);
    expect(marks("Cmaj7", "jazz")).toEqual({ chord: ["C", "E", "G", "B"], scale: ["D", "F", "F#", "Ab", "A"], none: ["C#", "Eb", "Bb"] });
  });

  it("guitar: six strings in standard tuning, frets 0 to 15, roots marked", () => {
    const rows = guitarCells(parseChord("A7"), getGenre("blues-rock").listening);
    expect(rows.map((r) => r.length)).toEqual(Array(6).fill(GUITAR_FRETS + 1));
    expect(rows.map((r) => r[0].note)).toEqual(GUITAR_STRINGS);
    // Low E string: open E is a chord tone, fret 5 is the root A.
    expect(rows[5][0]).toMatchObject({ note: 40, mark: "chord", root: false });
    expect(rows[5][5]).toMatchObject({ note: 45, mark: "chord", root: true });
    expect(rows[5][1].mark).toBeNull();
  });

  it("piano: two octaves from the window's C", () => {
    const keys = pianoCells(48, parseChord("Fm"), getGenre("funk").listening);
    expect(keys.length).toBe(PIANO_KEYS);
    expect(keys[0].note).toBe(48);
    expect(keys[24].note).toBe(72);
    expect(keys.filter((k) => k.root).map((k) => k.note)).toEqual([53, 65]);
  });

  it("no chord, no marks", () => {
    expect(guitarCells(null).flat().every((c) => c.mark === null && !c.root)).toBe(true);
  });
});

describe("piano window", () => {
  it("stays put while the player is inside it, moves by octaves when they leave", () => {
    expect(followWindow(48, [])).toBe(48);
    expect(followWindow(48, [60, 62, 64, 67])).toBe(48);
    expect(followWindow(48, [79, 81, 84, 86])).toBe(72);
    expect(followWindow(48, [36, 38, 40])).toBe(24);
    expect(followWindow(48, [100, 105, 108])).toBe(84);
  });
});

describe("chord view timing", () => {
  const json: ChartJSON = { title: "t", bpm: 120, time_sig: "4/4", genre: "funk", sections: [{ name: "a", bars: 2, chords: ["C", "F G"] }], form: ["a"] };
  const chart = loadChart(json);
  const e = new Engine(chart, { countIn: 0, config: { loop: true } });
  const [b0, b1, b2] = [e.nextBar()!, e.nextBar()!, e.nextBar()!];

  it("shows the chord sounding, and the next one only on the beat before it changes", () => {
    expect(chordView(chart, b0, 0.5, b1)).toMatchObject({ chord: { symbol: "C" }, next: null });
    expect(chordView(chart, b0, 2.99, b1).next).toBeNull();
    expect(chordView(chart, b0, 3.0, b1)).toMatchObject({ chord: { symbol: "C" }, next: { symbol: "F" } });
  });

  it("follows a split bar, and the next bar's first chord", () => {
    expect(chordView(chart, b1, 0.5, b2)).toMatchObject({ chord: { symbol: "F" }, next: null });
    expect(chordView(chart, b1, 1.5, b2)).toMatchObject({ chord: { symbol: "F" }, next: { symbol: "G" } });
    expect(chordView(chart, b1, 2.5, b2)).toMatchObject({ chord: { symbol: "G" }, next: null });
    expect(chordView(chart, b1, 3.5, b2)).toMatchObject({ chord: { symbol: "G" }, next: { symbol: "C" } });
  });

  it("no next chord before the next bar is known, or when it doesn't change", () => {
    expect(chordView(chart, b0, 3.5, undefined).next).toBeNull();
    const same = loadChart({ ...json, sections: [{ name: "a", bars: 2, chords: ["C"] }] });
    const e2 = new Engine(same, { countIn: 0, config: { loop: true } });
    const [p0, p1] = [e2.nextBar()!, e2.nextBar()!];
    expect(chordView(same, p0, 3.5, p1).next).toBeNull();
  });
});

describe("scale mode", () => {
  const charts = Object.fromEntries(
    Object.entries({ "blues-in-a": bluesInA, "night-shift": nightShift, "late-set": lateSet }).map(([f, raw]) => {
      const json = raw as ChartJSON;
      return [f, { chart: loadChart(json), genre: getGenre(json.genre!).listening }];
    }),
  );
  const scaleOf = (f: string) => songScale(charts[f].chart, charts[f].genre)!;
  const names = (pcs: number[]) => [...pcs].sort((a, b) => a - b).map((pc) => NAMES[pc]);

  it("each song gets its key's scale for its genre", () => {
    expect(scaleOf("blues-in-a").name).toBe("A blues");
    expect(names(scaleOf("blues-in-a").pcs)).toEqual(["C", "D", "Eb", "E", "G", "A"]);
    expect(scaleOf("late-set").name).toBe("Bb major");
  });

  it("picks the genre scale that fits the chords: Night Shift's Db and Eb make it natural minor, not dorian", () => {
    expect(scaleOf("night-shift").name).toBe("F minor");
    const vamp = loadChart({ title: "t", bpm: 100, time_sig: "4/4", key: "F minor", genre: "funk", sections: [{ name: "a", bars: 2, chords: ["Fm7", "Bb7"] }], form: ["a"] });
    expect(songScale(vamp, getGenre("funk").listening)!.name).toBe("F dorian");
  });

  it("no key, no song scale; a pack without key scales gets plain major or minor", () => {
    const { key: _, ...noKey } = lateSet as ChartJSON;
    expect(songScale(loadChart(noKey))).toBeNull();
    expect(songScale(charts["night-shift"].chart)!.name).toBe("F minor");
  });

  it("the scale holds across chords; only the chord tones move, and a tone outside the scale is passing", () => {
    const song = scaleOf("blues-in-a");
    const lit = (symbol: string) =>
      guitarCells(parseChord(symbol), undefined, song)[5].filter((c) => c.mark).map((c) => c.note % 12);
    // Every scale note stays lit under A7 and E7.
    for (const sym of ["A7", "E7"]) for (const pc of song.pcs) expect(lit(sym)).toContain(pc);
    // C# (the A7's third) is outside A blues: a passing chord tone.
    expect(scaleMarkOf(61, parseChord("A7"), song)).toEqual({ mark: "chord", passing: true });
    expect(scaleMarkOf(64, parseChord("A7"), song)).toEqual({ mark: "chord", passing: false });
    expect(scaleMarkOf(62, parseChord("A7"), song)).toEqual({ mark: "scale" });
    expect(scaleMarkOf(65, parseChord("A7"), song)).toEqual({ mark: null });
    // The ring is on the key's tonic, not the chord's root.
    const roots = pianoCells(48, parseChord("E7"), undefined, song).filter((k) => k.root).map((k) => k.note);
    expect(roots).toEqual([57, 69]);
  });
});
