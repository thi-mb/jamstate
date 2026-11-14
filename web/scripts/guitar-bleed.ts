// npm run guitar-eval -- bleed [--out DIR]
//
// The bleed gate (v0.5 layer 4, ADR-0025): a synthesised band (strummed
// chords, bass, kick and hat) through a simulated room (35 ms late, darker,
// a reverb tail of about a second) into a guitar take that plays for 4 s and
// rests for 4 s. At several bleed levels (the band's peak against the
// guitar's), with the gate off and on: false onsets per minute while the
// guitar rests, and note F1 (onset ±50 ms and pitch) while it plays. Also
// the delay the gate measured and its CPU.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BleedGate } from "../src/core/audio/bleed";
import { SR } from "../src/core/audio/dsp";
import { AudioListener } from "../src/core/audio/listener";
import { bandTake, soloLine, throughRoom } from "../src/core/audio/takes";

const round = (x: number) => Math.round(x * 1000) / 1000;
const LEVELS = [-24, -18, -12, -6, 0];
const SEEDS = [1, 2, 3, 4];
const DELAY = 0.035;
const playing = (t: number) => Math.floor(t / 4) % 2 === 0;

interface Row {
  false_per_min: number;
  note_f1: number;
}

export function runBleed(out: string): void {
  const rows: Record<string, { off: Row; gate: Row; delay: number }> = {};
  let cpu = 0;
  let audio = 0;
  const clean = { hit: 0, found: 0, all: 0 };
  for (const level of [-Infinity, ...LEVELS]) {
    const r = { off: { f: 0, hit: 0, found: 0 }, gate: { f: 0, hit: 0, found: 0 }, all: 0, rest: 0, delay: 0 };
    for (const seed of SEEDS) {
      const { x: line, truth: all } = soloLine(seed);
      const secs = line.length / SR;
      const guitar = line.map((v, i) => (playing(i / SR) ? v : 0));
      const truth = all.filter((u) => playing(u.time) && playing(u.time + 0.3));
      const band = bandTake(seed, secs);
      const bleed = level === -Infinity ? new Float32Array(band.length) : throughRoom(band, { gainDb: level, delay: DELAY });
      const x = guitar.map((v, i) => v + bleed[i]);
      r.all += truth.length;
      r.rest += secs / 2 / 60;
      for (const kind of ["off", "gate"] as const) {
        const L = new AudioListener({ mode: "single" });
        const G = kind === "gate" ? new BleedGate() : null;
        const ons: { time: number; note: number }[] = [];
        const t0 = performance.now();
        for (let i = 0; i < x.length; i += 256) {
          let s = x.subarray(i, i + 256);
          let t = i / SR;
          if (G) {
            s = G.push(s, band.subarray(i, i + 256));
            t -= G.latency / SR;
          }
          for (const e of L.push(s, t)) if (e.kind === "on") ons.push(e);
        }
        if (G) {
          cpu += (performance.now() - t0) / 1000;
          audio += secs;
          r.delay += G.state.delay / SEEDS.length;
        }
        const k = r[kind];
        k.f += ons.filter((e) => !playing(e.time) && !playing(e.time - 0.3)).length;
        k.found += ons.filter((e) => playing(e.time)).length;
        k.hit += truth.filter((u) => ons.some((e) => Math.abs(e.time - u.time) < 0.05 && e.note === u.note)).length;
      }
    }
    const row = (k: { f: number; hit: number; found: number }): Row => {
      const p = k.hit / Math.max(1, k.found);
      const q = k.hit / Math.max(1, r.all);
      return { false_per_min: round(k.f / r.rest), note_f1: round((2 * p * q) / Math.max(1e-9, p + q)) };
    };
    if (level === -Infinity) Object.assign(clean, { hit: r.off.hit, found: r.off.found, all: r.all });
    rows[level === -Infinity ? "none" : `${level} dB`] = { off: row(r.off), gate: row(r.gate), delay: round(r.delay) };
    console.log(level, JSON.stringify(rows[level === -Infinity ? "none" : `${level} dB`]));
  }
  const summary = { detector: "jamstate-bleed/0.5", date: new Date().toISOString().slice(0, 10), room_delay: DELAY, takes: SEEDS.length, levels: rows, cpu: { seconds_per_second: round(cpu / audio) } };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const lines = [
    "# v0.5 bleed: the band through speakers into the input",
    "",
    `Run on ${summary.date} with \`npm run guitar-eval -- bleed\` (${summary.detector}). ${SEEDS.length} synthesised guitar lines that play for 4 s and rest for 4 s, with a synthesised band (strummed chords, bass, kick and hat) through a simulated room: ${DELAY * 1000} ms late, darker, a reverb tail of about a second. The bleed level is the band's level at the input against the guitar's (0 dB: as loud). Single notes; false onsets are onsets while the guitar rests; note F1 is onset (±50 ms) and pitch while it plays.`,
    "",
    "| Bleed | False onsets a minute, gate off | gate on | Note F1, gate off | gate on | Delay the gate found |",
    "|---|---|---|---|---|---|",
    ...Object.entries(rows).map(([k, v]) => `| ${k} | ${v.off.false_per_min} | ${v.gate.false_per_min} | ${v.off.note_f1} | ${v.gate.note_f1} | ${k === "none" ? "–" : `${Math.round(v.delay * 1000)} ms`} |`),
    "",
    `The gate's CPU: ${summary.cpu.seconds_per_second} seconds per second of audio on one thread (and it delays what the listener hears by 32 ms, taken off the onset times).`,
    "",
  ];
  writeFileSync(join(out, "README.md"), lines.join("\n"));
  console.log(`Wrote ${out}/README.md`);
}
