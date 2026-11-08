import { describe, expect, it } from "vitest";
import { loadChart, type ChartJSON } from "../src/core/chart";
import { Engine } from "../src/core/engine";
import { chordView, followWindow, guitarCells, markOf, pianoCells, GUITAR_FRETS, GUITAR_STRINGS, PIANO_KEYS } from "../src/core/fretboard";
import { getGenre } from "../src/core/genres";
import { parseChord } from "../src/core/theory";

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
