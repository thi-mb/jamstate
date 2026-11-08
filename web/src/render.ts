// Offline rendering: play a song through the real band (engine, samples, mix
// bus) into an OfflineAudioContext, faster than real time. Used by the
// machine-ears checks (scripts/sound-check.mjs runs it in headless Chrome)
// and to make listening clips. Browser-only (Web Audio), but no DOM.

import { SampleLibrary } from "./audio/sampler";
import { Synth } from "./audio/synth";
import { bandParts, type Band } from "./core/band";
import { loadChart, type ChartJSON } from "./core/chart";
import { Engine } from "./core/engine";
import { getGenre } from "./core/genres";
import { parseScript, SimPlayer } from "./core/simplayer";
import type { Move } from "./core/moves";

export interface RenderJob {
  chart: ChartJSON;
  genre?: string;
  band?: Band;
  seconds: number;
  seed?: number;
  /** Pretend player script ("medium:4,busy:4"); empty: nobody plays along. */
  player?: string;
  /** Lineup changes at bars (instrument switches mid-song). */
  bandChanges?: { bar: number; band: Band }[];
  /** Moves at bars, as if the bandleader made them. */
  moves?: { bar: number; moves: Move[] }[];
  /** Use only the synth voices (no samples), for comparison. */
  synthOnly?: boolean;
  rate?: number;
}

export interface RenderResult {
  left: Float32Array;
  right: Float32Array;
  rate: number;
  /** Seconds where each bar starts, and the lineup it played with. */
  bars: { bar: number; time: number; kind: string; layers: string[] }[];
  /** Instruments that played from samples (the rest fell back to the synth). */
  sampled: string[];
  loadMs: number;
}

/** One library per sample rate, decoding into its own context that never renders, so it outlives every job. */
const libs = new Map<number, SampleLibrary>();
function libraryFor(rate: number): SampleLibrary {
  let lib = libs.get(rate);
  if (!lib) libs.set(rate, (lib = new SampleLibrary(new OfflineAudioContext(1, 1, rate))));
  return lib;
}

export async function renderSong(job: RenderJob): Promise<RenderResult> {
  const rate = job.rate ?? 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(job.seconds * rate), rate);
  const chart = loadChart(job.chart);
  const genre = getGenre(job.genre ?? chart.genre);
  const engine = new Engine(chart, { seed: job.seed ?? 7, genre, countIn: chart.countIn, band: job.band, config: { loop: true } });
  const t0 = performance.now();
  const lib = job.synthOnly ? null : libraryFor(rate);
  const allBands = [engine.band, ...(job.bandChanges ?? []).map((c) => c.band)];
  if (lib) await Promise.all(allBands.flatMap((b) => bandParts(b).map((p) => lib.load(b[p]!.instrument))).concat([lib.load("piano")]));
  const loadMs = performance.now() - t0;
  const synth = new Synth(ctx, lib);
  synth.setMix(genre.mix);
  synth.setBand(engine.band);
  const sim = new SimPlayer(3);
  const script = job.player ? parseScript(job.player) : null;
  const bars: RenderResult["bars"] = [];
  let time = 0.05;
  for (let i = 0; time < job.seconds; i++) {
    for (const c of job.bandChanges ?? []) if (c.bar === i) {
      engine.setBand(c.band);
      synth.setBand(engine.band);
    }
    for (const m of job.moves ?? []) if (m.bar === i) engine.submit(m.moves, "render");
    const plan = engine.nextBar();
    if (!plan) break;
    const secPerBeat = 60 / plan.bpm;
    bars.push({ bar: plan.bar, time, kind: plan.kind, layers: plan.layers });
    for (const ev of plan.events) synth.play(ev, time + Math.max(0, ev.start) * secPerBeat, ev.dur * secPerBeat);
    if (script && plan.kind !== "count_in") {
      const mode = script[i % script.length];
      for (const n of sim.play(plan, mode, chart.beatsPerBar)) synth.play({ ...n, part: "player" }, time + n.start * secPerBeat, n.dur * secPerBeat);
    }
    time += chart.beatsPerBar * secPerBeat;
  }
  const buf = await ctx.startRendering();
  const sampled = lib ? [...new Set(allBands.flatMap((b) => bandParts(b).map((p) => b[p]!.instrument)))].filter((id) => lib.get(id)) : [];
  return { left: buf.getChannelData(0), right: buf.getChannelData(1), rate, bars, sampled, loadMs };
}

/** 16-bit stereo WAV. */
export function wav(left: Float32Array, right: Float32Array, rate: number): Uint8Array {
  const n = left.length;
  const out = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + n * 4, true);
  str(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 2, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 4, true);
  out.setUint16(32, 4, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, left[i])) * 32767, true);
    out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, right[i])) * 32767, true);
  }
  return new Uint8Array(out.buffer);
}
