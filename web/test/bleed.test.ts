// The bleed gate (v0.5 layer 4, ADR-0025): the band through a simulated
// room into a guitar take, taken out again against the band's own mix.

import { describe, expect, it } from "vitest";
import { BleedGate } from "../src/core/audio/bleed";
import { SR } from "../src/core/audio/dsp";
import { AudioListener } from "../src/core/audio/listener";
import { renderGuitar } from "../src/core/audio/pluck";
import { bandTake, soloLine, throughRoom } from "../src/core/audio/takes";

const playing = (t: number) => Math.floor(t / 4) % 2 === 0;

function hear(x: Float32Array, band: Float32Array | null) {
  const L = new AudioListener({ mode: "single" });
  const G = band ? new BleedGate() : null;
  const ons: { time: number; note: number }[] = [];
  for (let i = 0; i < x.length; i += 256) {
    let s = x.subarray(i, i + 256);
    let t = i / SR;
    if (G && band) {
      s = G.push(s, band.subarray(i, i + 256));
      t -= G.latency / SR;
    }
    for (const e of L.push(s, t)) if (e.kind === "on") ons.push(e);
  }
  return { ons, gate: G };
}

describe("the bleed gate", () => {
  it("passes the input through untouched when the band is silent", () => {
    const x = renderGuitar([{ time: 0.1, note: 52, vel: 90, dur: 0.5 }], 1, { seed: 1 });
    const G = new BleedGate();
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 256) y.set(G.push(x.subarray(i, i + 256), new Float32Array(256)), i);
    let err = 0;
    for (let i = 2000; i < x.length - G.latency; i++) err = Math.max(err, Math.abs(y[i + G.latency] - x[i]));
    expect(err).toBeLessThan(1e-4);
  });

  it("takes the band out: few false onsets while the guitar rests, its notes still heard", () => {
    const { x: line, truth: all } = soloLine(2);
    const guitar = line.map((v, i) => (playing(i / SR) ? v : 0));
    const truth = all.filter((u) => playing(u.time) && playing(u.time + 0.3));
    const band = bandTake(2, line.length / SR);
    const bleed = throughRoom(band, { gainDb: -6, delay: 0.04 });
    const x = guitar.map((v, i) => v + bleed[i]);
    const resting = (o: { time: number }[]) => o.filter((e) => !playing(e.time) && !playing(e.time - 0.3)).length;
    const heard = (o: { time: number; note: number }[]) => truth.filter((u) => o.some((e) => Math.abs(e.time - u.time) < 0.05 && e.note === u.note)).length / truth.length;
    const off = hear(x, null);
    const on = hear(x, band);
    expect(resting(off.ons)).toBeGreaterThan(20);
    expect(resting(on.ons)).toBeLessThan(resting(off.ons) / 5);
    expect(heard(on.ons)).toBeGreaterThan(0.8);
    expect(heard(on.ons)).toBeGreaterThan(heard(off.ons));
    // It found the room's delay (to a hop).
    expect(Math.abs(on.gate!.state.delay - 0.04)).toBeLessThan(0.01);
  });
});
