// The page side of npm run chords-browser: times the chroma on a strummed
// take and Basic Pitch on one 2 s window, on WebGL and on the CPU backend.

import * as tf from "@tensorflow/tfjs";
import { BasicPitch } from "@spotify/basic-pitch";
import { ChromaChords } from "../../src/core/audio/chords";
import { strumTake } from "../../src/core/audio/takes";
import { SR } from "../../src/core/audio/dsp";
(window as unknown as { run: () => Promise<Record<string, unknown>> }).run = async () => {
  const out: Record<string, unknown> = {};
  const { x, truth } = strumTake(1);
  const det = new ChromaChords();
  let t0 = performance.now();
  for (let r = 0; r < 5; r++) for (const u of truth) det.detect(x, Math.round(u.time * SR));
  out.chroma_ms = Math.round(((performance.now() - t0) / (5 * truth.length)) * 1000) / 1000;
  for (const backend of ["webgl", "cpu"]) {
    try {
      await tf.setBackend(backend); await tf.ready();
      const bp = new BasicPitch("/model/model.json");
      const y = new Float32Array(22050 * 2 - 256).map(() => (Math.random() - 0.5) * 0.1);
      await bp.evaluateModel(y, () => {}, () => {});
      t0 = performance.now();
      for (let k = 0; k < 3; k++) await bp.evaluateModel(y, () => {}, () => {});
      out[`model_${backend}_window_ms`] = Math.round((performance.now() - t0) / 3);
      out[`model_${backend}_renderer`] = backend === "webgl" ? (() => { const gl = document.createElement("canvas").getContext("webgl"); const d = gl?.getExtension("WEBGL_debug_renderer_info"); return d ? gl!.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?"; })() : "js";
    } catch (e) { out[`model_${backend}_error`] = String(e); }
  }
  return out;
};
