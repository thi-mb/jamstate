// Audio input (v0.5, ADR-0023): the DSP pieces, onsets and levels on
// synthesised guitar, calibration, and unpitched hits through features,
// listening and sessions.

import { describe, expect, it } from "vitest";
import { calibrateLevels, latencyFromTaps } from "../src/core/audio/calibrate";
import { fft, Resampler, resample, SR } from "../src/core/audio/dsp";
import { AudioListener, DEFAULT_CALIBRATION, type ListenerEvent } from "../src/core/audio/listener";
import { renderGuitar, strum, type PluckNote } from "../src/core/audio/pluck";
import { decodeWav, encodeWav } from "../src/core/audio/wav";
import { barFeatures, isPitched, UNPITCHED, type PlayedNote } from "../src/core/features";
import { harmonyOf } from "../src/core/listening";
import { getGenre } from "../src/core/genres";
import { parseChord } from "../src/core/theory";
import { rng } from "../src/core/rand";
import type { BarPlan } from "../src/core/engine";
import { recordSimSession } from "../src/core/simsession";
import { replaySession } from "../src/core/session";
import nightShift from "../public/charts/night-shift.json";
import type { ChartJSON } from "../src/core/chart";

function listen(x: Float32Array, block = 256, opts = {}): ListenerEvent[] {
  const L = new AudioListener(opts);
  const ev: ListenerEvent[] = [];
  for (let i = 0; i < x.length; i += block) ev.push(...L.push(x.subarray(i, i + block), i / SR));
  return ev;
}

/** Onsets matched within ±50 ms: precision, recall and the median offset. */
function score(truth: number[], found: number[]) {
  const used = new Set<number>();
  const offs: number[] = [];
  for (const t of truth) {
    const j = found.findIndex((o, k) => !used.has(k) && Math.abs(o - t) < 0.05);
    if (j >= 0) {
      used.add(j);
      offs.push(found[j] - t);
    }
  }
  offs.sort((a, b) => a - b);
  return { precision: used.size / Math.max(1, found.length), recall: used.size / truth.length, median: offs[offs.length >> 1] ?? NaN };
}

/** A minute of mixed playing: single notes, strums, muted scratches. */
function mixedTake(seed: number) {
  const r = rng(seed);
  const notes: PluckNote[] = [];
  const truth: number[] = [];
  let t = 0.3;
  for (let i = 0; i < 80; i++) {
    const k = r();
    const vel = 40 + Math.floor(r() * 80);
    if (k < 0.4) notes.push({ time: t, note: 40 + Math.floor(r() * 40), vel, dur: 0.15 + r() * 0.4 });
    else if (k < 0.8) notes.push(...strum(t, [40, 47, 52, 55, 59, 64].map((x) => x + Math.floor(r() * 5)), { vel, dir: r() < 0.5 ? "down" : "up", dur: 0.2 + r() * 0.3 }));
    else notes.push(...strum(t, [45, 52, 57, 60], { vel, muted: true, dur: 0.08 }));
    truth.push(t);
    t += 0.13 + r() * 0.4;
  }
  return { x: renderGuitar(notes, t + 1, { noiseDb: -72, humDb: -62, seed }), truth };
}

describe("dsp", () => {
  it("fft matches a direct DFT", () => {
    const n = 64;
    const x = Array.from({ length: n }, (_, i) => Math.sin(i * 0.3) + 0.5 * Math.cos(i * 1.7) + (i % 5) * 0.1);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    fft(re, im);
    for (const k of [0, 1, 5, 17, 32]) {
      let dr = 0;
      let di = 0;
      for (let i = 0; i < n; i++) {
        dr += x[i] * Math.cos((-2 * Math.PI * k * i) / n);
        di += x[i] * Math.sin((-2 * Math.PI * k * i) / n);
      }
      expect(re[k]).toBeCloseTo(dr, 6);
      expect(im[k]).toBeCloseTo(di, 6);
    }
  });

  it("resamples 48 and 44.1 kHz to 16 kHz, the same in blocks as in one go", () => {
    for (const rate of [48000, 44100]) {
      const x = Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / rate));
      const y = resample(x, rate);
      expect(Math.abs(y.length - SR)).toBeLessThan(3);
      // 440 Hz: count rising zero crossings over the middle half second.
      let z = 0;
      for (let i = 4000; i < 12000; i++) if (y[i - 1] < 0 && y[i] >= 0) z++;
      expect(Math.abs(z - 220)).toBeLessThanOrEqual(1);
      const rs = new Resampler(rate);
      const parts: number[] = [];
      for (let i = 0; i < x.length; i += 128) parts.push(...rs.process(x.subarray(i, i + 128)));
      expect(parts.length).toBe(y.length);
      expect(Math.max(...parts.slice(0, 2000).map((v, i) => Math.abs(v - y[i])))).toBeLessThan(1e-6);
    }
  });

  it("WAV round trip at 16 bits", () => {
    const x = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.8);
    const w = decodeWav(encodeWav([x], SR));
    expect(w.rate).toBe(SR);
    expect(w.channels[0].length).toBe(1000);
    expect(Math.max(...w.channels[0].map((v, i) => Math.abs(v - x[i])))).toBeLessThan(1e-4);
  });
});

describe("onsets and levels", () => {
  it("finds plucks, strums and muted scratches on time", () => {
    for (const seed of [3, 7]) {
      const { x, truth } = mixedTake(seed);
      // A chord's notes share their strum's onset.
      const ons = [...new Set(listen(x).filter((e) => e.kind === "on").map((e) => e.time))];
      const s = score(truth, ons);
      expect(s.recall).toBeGreaterThanOrEqual(0.93);
      expect(s.precision).toBeGreaterThanOrEqual(0.93);
      expect(Math.abs(s.median)).toBeLessThan(0.01);
    }
  });

  it("the same in any block size", () => {
    const { x } = mixedTake(5);
    const a = listen(x, 256).map((e) => `${e.kind}${e.time.toFixed(4)}`);
    const b = listen(x, 100).map((e) => `${e.kind}${e.time.toFixed(4)}`);
    expect(b).toEqual(a);
  });

  it("stays quiet on hiss and mains hum", () => {
    const x = renderGuitar([], 5, { noiseDb: -60, humDb: -45 });
    expect(listen(x).length).toBe(0);
  });

  it("harder hits get higher velocities; notes end when they fade", () => {
    const notes: PluckNote[] = [40, 70, 110].map((vel, i) => ({ time: 0.5 + i, note: 52, vel, dur: 0.5 }));
    const ev = listen(renderGuitar(notes, 4));
    const ons = ev.filter((e) => e.kind === "on");
    expect(ons.length).toBe(3);
    const vels = ons.map((e) => (e.kind === "on" ? e.vel : 0));
    expect(vels[0]).toBeLessThan(vels[1]);
    expect(vels[1]).toBeLessThan(vels[2]);
    // Every note on has its off, and they come in order.
    expect(ev.filter((e) => e.kind === "off").length).toBe(3);
    for (let i = 1; i < ev.length; i++) expect(ev[i].time).toBeGreaterThanOrEqual(ev[i - 1].time - 1e-9);
  });

  it("onset times move earlier by the input latency", () => {
    const x = renderGuitar([{ time: 1, note: 52, vel: 90, dur: 0.5 }], 2);
    const on0 = listen(x).find((e) => e.kind === "on")!.time;
    const on1 = listen(x, 256, { calibration: { ...DEFAULT_CALIBRATION, latency: 0.03 } }).find((e) => e.kind === "on")!.time;
    expect(on0 - on1).toBeCloseTo(0.03, 6);
  });
});

describe("calibration", () => {
  it("sets the gate over the noise and the velocity range from soft and hard playing", () => {
    const cal = calibrateLevels(
      Array.from({ length: 100 }, (_, i) => -66 + (i % 7)),
      { levels: [], peaks: [-35, -33, -31, -34] },
      { levels: [], peaks: [-14, -12, -11] },
      DEFAULT_CALIBRATION,
    );
    expect(cal.gateDb).toBe(-52);
    expect(cal.softDb).toBe(-33);
    expect(cal.hardDb).toBe(-12);
    // Hard no louder than soft: kept 6 dB apart.
    const flat = calibrateLevels([-70], { levels: [], peaks: [-20] }, { levels: [], peaks: [-21] }, DEFAULT_CALIBRATION);
    expect(flat.hardDb - flat.softDb).toBeGreaterThanOrEqual(6);
  });

  it("input latency from taps, less what the output adds", () => {
    const clicks = Array.from({ length: 8 }, (_, i) => 1 + i * 0.6);
    const onsets = clicks.map((c, i) => c + 0.045 + (i % 2 ? 0.006 : -0.004));
    expect(latencyFromTaps(clicks, onsets, 0.02)).toBeCloseTo(0.026, 3);
    expect(latencyFromTaps(clicks, onsets.slice(0, 3), 0.02)).toBeNull();
  });
});

describe("unpitched hits", () => {
  const scratch = (n: number): PlayedNote[] => Array.from({ length: n }, (_, i) => ({ start: i * 0.25, dur: 0.1, note: UNPITCHED, vel: 90 }));

  it("count for density and energy, not register", () => {
    const f = barFeatures(scratch(16), 4);
    expect(f.noteCount).toBe(16);
    expect(f.energy).toBeGreaterThan(0.6);
    expect(f.register).toBeNull();
    const mixed = barFeatures([...scratch(8), { start: 2, dur: 1, note: 64, vel: 90 }], 4);
    expect(mixed.register).toBe(64);
    expect(isPitched({ note: UNPITCHED })).toBe(false);
  });

  it("leave harmony alone", () => {
    const genre = getGenre("funk").listening;
    const plan = {} as BarPlan;
    const chord = parseChord("Fm7");
    const h = harmonyOf([{ plan, notes: scratch(16) }], 4, () => chord, genre);
    expect(h.fit).toBeNull();
    const h2 = harmonyOf([{ plan, notes: [...scratch(16), { start: 0, dur: 2, note: 65, vel: 80 }] }], 4, () => chord, genre);
    expect(h2.inside).toBe(1);
  });
});

describe("audio sessions", () => {
  it("a jam heard from an instrument (unpitched and pitched notes) replays exactly and keeps its input", async () => {
    const input = { kind: "audio" as const, channel: "2", detector: "test", calibration: DEFAULT_CALIBRATION };
    let i = 0;
    const f = recordSimSession(nightShift as ChartJSON, "busy:8,sparse:4,silent:4,busy:4", { input, notes: (n) => (i++ % 3 ? { ...n, note: UNPITCHED } : n) });
    expect(f.input).toEqual(input);
    expect(f.player.some(([, note]) => note === UNPITCHED)).toBe(true);
    const r = await replaySession(f);
    expect(r.mismatches).toEqual([]);
  });
});
