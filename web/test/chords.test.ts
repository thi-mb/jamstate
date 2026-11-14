// Chords from a strum (v0.5 layer 3, ADR-0024): templates, voicings on the
// neck, the listener hearing strums as chords, the chart prior, and
// GuitarSet's chord labels.

import { describe, expect, it } from "vitest";
import { SR } from "../src/core/audio/dsp";
import { ChromaChords, matchChord, reduceQuality, voiceGuitar, type Quality } from "../src/core/audio/chords";
import { harte } from "../src/core/audio/jams";
import { AudioListener, type ListenerEvent, type ListenerOptions } from "../src/core/audio/listener";
import { renderGuitar, strum } from "../src/core/audio/pluck";
import { soloLine, strumTake } from "../src/core/audio/takes";
import { GUITAR_STRINGS, TUNINGS } from "../src/core/fretboard";
import { parseChord } from "../src/core/theory";

function listen(x: Float32Array, opts: ListenerOptions = {}, prior?: AudioListener["chordPrior"]): ListenerEvent[] {
  const L = new AudioListener(opts);
  if (prior) L.chordPrior = prior;
  const ev: ListenerEvent[] = [];
  for (let i = 0; i < x.length; i += 256) ev.push(...L.push(x.subarray(i, i + 256), i / SR));
  return [...ev, ...L.flush(x.length / SR)];
}
const shape = (root: number, q: Quality, hand = 1, strings: readonly number[] = GUITAR_STRINGS) =>
  voiceGuitar(root, q, strings, hand)!
    .frets.map((f) => f ?? "x")
    .reverse()
    .join("");

describe("chord templates", () => {
  it("chart chords come down to the qualities heard", () => {
    expect(reduceQuality([0, 4, 7, 10, 14])).toBe("7");
    expect(reduceQuality([0, 4, 7, 9])).toBe("");
    expect(reduceQuality([0, 3, 6, 10])).toBe("m7b5");
    expect(reduceQuality([0, 4, 8])).toBeNull();
  });

  it("a pitch-class profile of chord tones is that chord", () => {
    const p = new Float64Array(12);
    for (const pc of [2, 5, 9, 0]) p[pc] = 1;
    expect(matchChord(p, null, "notes")?.symbol).toBe("Dm7");
  });

  it("the chart's chord wins a close call", () => {
    // A and C♯ and E with a quiet G: A or A7.
    const p = new Float64Array(12);
    for (const [pc, v] of [[9, 1], [1, 1], [4, 1], [7, 0.45]]) p[pc] = v;
    expect(matchChord(p, null, "notes")?.symbol).toBe("A");
    expect(matchChord(p, { chord: parseChord("A7"), next: null }, "notes")?.symbol).toBe("A7");
  });
});

describe("voicings", () => {
  it("open shapes low on the neck", () => {
    expect(shape(0, "")).toBe("x32010");
    expect(shape(7, "")).toBe("320003");
    expect(shape(2, "")).toBe("xx0232");
    expect(shape(9, "7")).toBe("x02020");
  });

  it("every voicing has the root in the bass and its tones on the strings", () => {
    for (const q of ["", "m", "7", "m7", "maj7", "m7b5", "sus4", "5"] as Quality[]) {
      for (let root = 0; root < 12; root++) {
        for (const hand of [1, 5, 9]) {
          const v = voiceGuitar(root, q, GUITAR_STRINGS, hand);
          expect(v, `${root}${q} at ${hand}`).not.toBeNull();
          expect(v!.notes[0] % 12).toBe(root);
          expect(new Set(v!.notes.map((n) => (((n - root) % 12) + 12) % 12)).size).toBeGreaterThanOrEqual(Math.min(3, q === "5" ? 2 : 3));
        }
      }
    }
  });

  it("in drop D the low string takes a D", () => {
    expect(shape(2, "5", 1, TUNINGS["drop-d"].strings).startsWith("0")).toBe(true);
  });
});

describe("the listener hears chords", () => {
  it("down strums of voicings all over the neck", () => {
    // (Up strums miss the bass: Am7 and C6 are the same notes.)
    const det = new ChromaChords();
    let right = 0;
    let n = 0;
    for (const seed of [1, 2]) {
      const { x, truth } = strumTake(seed);
      for (const u of truth.filter((_, i) => i % 2 === 0)) {
        const g = det.detect(x, Math.round(u.time * SR));
        n++;
        if (g?.root === u.root && g.quality === u.quality) right++;
      }
    }
    expect(right / n).toBeGreaterThanOrEqual(0.85);
  });

  it("a chord's notes come out on the strings of a voicing, and all of them end", () => {
    const v = voiceGuitar(9, "m", GUITAR_STRINGS, 1)!;
    const x = renderGuitar([...strum(0.3, v.notes, { dur: 0.8 }), ...strum(1.5, voiceGuitar(5, "", GUITAR_STRINGS, 1)!.notes, { dur: 0.8 })], 2.8, { seed: 5 });
    const ev = listen(x, { mode: "chords" });
    const ons = ev.filter((e) => e.kind === "on");
    expect([...new Set(ons.map((e) => e.chord))]).toEqual(["Am", "F"]);
    for (const e of ons) {
      expect(e.place).toBeDefined();
      expect(GUITAR_STRINGS[e.place!.string] + e.place!.fret).toBe(e.note);
    }
    // One note per string.
    const first = ons.filter((e) => e.chord === "Am");
    expect(new Set(first.map((e) => e.place!.string)).size).toBe(first.length);
    expect(ev.filter((e) => e.kind === "off").length).toBe(ons.length);
  });

  it("auto hears strums as chords and a line as notes", () => {
    const { x } = strumTake(3, 6);
    const chords = listen(x).filter((e) => e.kind === "on");
    expect(chords.filter((e) => e.chord).length / chords.length).toBeGreaterThan(0.9);
    const line = listen(soloLine(2).x).filter((e) => e.kind === "on");
    expect(line.filter((e) => e.chord).length / line.length).toBeLessThan(0.05);
  });

  it("single notes mode never hears chords", () => {
    const { x } = strumTake(3, 4);
    expect(listen(x, { mode: "single" }).some((e) => e.kind === "on" && e.chord)).toBe(false);
  });
});

describe("GuitarSet labels", () => {
  it("Harte chords come down to the qualities heard", () => {
    expect(harte("D#:maj")).toEqual({ root: 3, quality: "" });
    expect(harte("A:min7")).toEqual({ root: 9, quality: "m7" });
    expect(harte("D#:sus2(7)/1")).toEqual({ root: 3, quality: "sus4" });
    expect(harte("Bb:hdim7")).toEqual({ root: 10, quality: "m7b5" });
    expect(harte("G:7(*5)")).toEqual({ root: 7, quality: "7" });
    expect(harte("N")).toBeNull();
  });
});

describe("scratches", () => {
  it("a scratch soon after a chord repeats it; on its own it stays unpitched", () => {
    const g = voiceGuitar(7, "", GUITAR_STRINGS, 1)!;
    const mute = (t: number) => strum(t, [45, 52, 57, 60], { muted: true, dur: 0.06, vel: 90 });
    const x = renderGuitar([...strum(0.3, g.notes, { dur: 0.35 }), ...mute(0.9), ...mute(3.5)], 4, { seed: 6 });
    const ons = listen(x).filter((e) => e.kind === "on");
    const at = (t: number) => ons.filter((e) => Math.abs(e.time - t) < 0.05);
    expect(at(0.3).every((e) => e.chord === "G")).toBe(true);
    expect(at(0.9).map((e) => e.note)).toEqual(g.notes);
    expect(at(3.5).map((e) => e.note)).toEqual([-1]);
  });
});
