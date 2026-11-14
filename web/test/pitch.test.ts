// Monophonic pitch (v0.5 layer 2, ADR-0023): YIN on synthesised plucks,
// single-note lines with hammer-ons and vibrato, a new note over a ringing
// one, and what stays unpitched.

import { describe, expect, it } from "vitest";
import { midiOf, SR } from "../src/core/audio/dsp";
import { AudioListener, type ListenerOptions } from "../src/core/audio/listener";
import { Yin } from "../src/core/audio/pitch";
import { renderGuitar, strum } from "../src/core/audio/pluck";
import { soloLine } from "../src/core/audio/takes";
import { rng } from "../src/core/rand";

function ons(x: Float32Array, opts: ListenerOptions = {}) {
  const L = new AudioListener(opts);
  const ev = [];
  for (let i = 0; i < x.length; i += 256) ev.push(...L.push(x.subarray(i, i + 256), i / SR));
  return ev.filter((e) => e.kind === "on");
}

describe("YIN", () => {
  it("names every guitar note from E2 to C6 just after the pick", () => {
    const y = new Yin();
    for (let note = 40; note <= 84; note++) {
      const x = renderGuitar([{ time: 0.1, note, vel: 90, dur: 0.6 }], 0.5, { rate: SR, seed: note });
      const f = y.frame(x, Math.round(0.18 * SR));
      expect(Math.round(midiOf(f.hz)), `note ${note}`).toBe(note);
      expect(f.aperiodicity).toBeLessThan(0.25);
    }
  });

  it("finds nothing periodic in noise", () => {
    const r = rng(9);
    const x = Float32Array.from({ length: 4096 }, () => r() - 0.5);
    expect(new Yin().frame(x, 4096).aperiodicity).toBeGreaterThan(0.5);
  });
});

describe("single notes", () => {
  it("hears lines with hammer-ons and vibrato: note precision and recall at least 0.93, no octave errors", () => {
    let hit = 0;
    let found = 0;
    let all = 0;
    let octave = 0;
    for (const seed of [1, 2, 3]) {
      const { x, truth } = soloLine(seed);
      const o = ons(x, { mode: "single" });
      const used = new Set<number>();
      for (const u of truth) {
        const j = o.findIndex((e, k) => !used.has(k) && Math.abs(e.time - u.time) < 0.05 && e.note === u.note);
        if (j >= 0) used.add(j);
        else if (o.some((e) => Math.abs(e.time - u.time) < 0.05 && Math.abs(e.note - u.note) === 12)) octave++;
      }
      hit += used.size;
      found += o.length;
      all += truth.length;
    }
    expect(hit / found).toBeGreaterThanOrEqual(0.93);
    expect(hit / all).toBeGreaterThanOrEqual(0.93);
    expect(octave).toBe(0);
  });

  it("hears a new note over one still ringing on another string", () => {
    const x = renderGuitar([
      { time: 0.2, note: 50, vel: 100, dur: 1.5 },
      { time: 0.6, note: 79, vel: 70, dur: 0.5 },
      { time: 1.2, note: 47, vel: 60, dur: 0.5 },
    ], 2, { seed: 4 });
    expect(ons(x).map((e) => e.note)).toEqual([50, 79, 47]);
  });

  it("a note picked again is the same note", () => {
    const x = renderGuitar([0.2, 0.5, 0.8].map((time) => ({ time, note: 57, vel: 90, dur: 0.28 })), 1.3, { seed: 2 });
    expect(ons(x).map((e) => e.note)).toEqual([57, 57, 57]);
  });

  it("muted scratches stay unpitched, and chord mode hears chords, not notes", () => {
    const muted = renderGuitar([0.2, 0.5, 0.8].flatMap((t) => strum(t, [45, 52, 57, 60], { muted: true, dur: 0.06, vel: 90 })), 1.2, { seed: 3 });
    expect(ons(muted).map((e) => e.note)).toEqual([-1, -1, -1]);
    const line = renderGuitar([{ time: 0.2, note: 60, vel: 90, dur: 0.4 }], 0.8, { seed: 3 });
    expect(ons(line, { mode: "chords" }).every((e) => e.kind === "on" && e.chord)).toBe(true);
  });

  it("a bass's low notes with the bass range", () => {
    const x = renderGuitar([28, 33, 38, 43].map((note, i) => ({ time: 0.2 + i * 0.5, note, vel: 100, dur: 0.4 })), 2.4, { seed: 5 });
    expect(ons(x, { lowest: 28, highest: 67 }).map((e) => e.note)).toEqual([28, 33, 38, 43]);
  });
});
