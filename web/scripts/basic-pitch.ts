// Basic Pitch (Spotify, Apache 2.0) as a chord front end, for the v0.5 eval
// only: the model transcribes notes, their pitch classes make the profile
// matched against chord templates. It runs on TensorFlow.js; here on its
// CPU backend in Node (the page would use WebGL).

import { readFileSync } from "node:fs";
import * as tf from "@tensorflow/tfjs";
import { BasicPitch } from "@spotify/basic-pitch";

export const BP_RATE = 22050;
/** Frames per second of the model's output (a hop of 256 at 22.05 kHz). */
export const BP_FPS = BP_RATE / 256;
/** The model's window: 2 s less a hop. */
export const BP_WINDOW = BP_RATE * 2 - 256;

let model: BasicPitch | null = null;

export async function basicPitch(): Promise<BasicPitch> {
  if (model) return model;
  const dir = new URL("../node_modules/@spotify/basic-pitch/model/", import.meta.url);
  const json = JSON.parse(readFileSync(new URL("model.json", dir), "utf8"));
  const bin = readFileSync(new URL("group1-shard1of1.bin", dir));
  const weightData = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  await tf.setBackend("cpu");
  const handler = { load: async () => ({ modelTopology: json.modelTopology, format: json.format, weightSpecs: json.weightsManifest[0].weights, weightData }) };
  model = new BasicPitch(tf.loadGraphModel(handler));
  return model;
}

/** Note posteriors (88 per frame, A0 up) for a whole take at 22.05 kHz. */
export async function transcribe(x: Float32Array): Promise<number[][]> {
  const bp = await basicPitch();
  const frames: number[][] = [];
  await bp.evaluateModel(x, (f) => frames.push(...f), () => {});
  return frames;
}

/** The pitch-class profile of the notes sounding from `t0` to `t1` seconds. */
export function notesProfile(frames: number[][], t0: number, t1: number): Float64Array {
  const out = new Float64Array(12);
  for (let i = Math.max(0, Math.floor(t0 * BP_FPS)); i < Math.min(frames.length, Math.ceil(t1 * BP_FPS)); i++) {
    frames[i].forEach((p, k) => {
      if (p > 0.3) out[(21 + k) % 12] += p;
    });
  }
  return out;
}

/** Any rate to 22.05 kHz, linear (the takes have nothing above 8 kHz that matters here). */
export function toBpRate(x: Float32Array, rate: number): Float32Array {
  const n = Math.floor((x.length * BP_RATE) / rate);
  const out = new Float32Array(n);
  const step = rate / BP_RATE;
  // A short box filter first when going down in rate.
  const k = Math.max(1, Math.round(step));
  for (let i = 0; i < n; i++) {
    const at = i * step;
    const j = Math.floor(at);
    const f = at - j;
    let a = 0;
    let b = 0;
    for (let m = 0; m < k; m++) {
      a += x[j + m] ?? 0;
      b += x[j + 1 + m] ?? 0;
    }
    out[i] = ((1 - f) * a + f * b) / k;
  }
  return out;
}
