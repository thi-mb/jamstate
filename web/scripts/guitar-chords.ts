// npm run guitar-eval -- chords [--set DIR] [--out DIR] [--limit N] [--every N] [--no-model]
//
// How well chords are heard from a guitar (v0.5 layer 3, ADR-0024), with
// the two front ends side by side: the chroma (the default, in the page)
// and Basic Pitch (a transcription model, eval only). Both feed the same
// templates and chart prior.
//
// Per strum on synthesised strummed takes; per beat on GuitarSet's comping
// (every Nth excerpt, as the model is slow), against the lead sheet's chord
// and the chord as played, with and without the chart prior. Then the
// listener itself on all comping in auto (what the page does): each chord it
// hears against the chord as played. CPU and the time from strum to answer.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resample, SR } from "../src/core/audio/dsp";
import { ChromaChords, CHORD_FLOOR, matchChord, type ChordGuess, type ChordPrior, type Quality } from "../src/core/audio/chords";
import { chordAt, readJams, type JamsChord } from "../src/core/audio/jams";
import { AudioListener } from "../src/core/audio/listener";
import { strumTake } from "../src/core/audio/takes";
import { decodeWav, mono } from "../src/core/audio/wav";
import { noteName, parseChord, type Chord } from "../src/core/theory";
import { BP_WINDOW, notesProfile, toBpRate, transcribe } from "./basic-pitch";

export interface ChordEvalOptions {
  set: string;
  out: string;
  limit: number;
  every: number;
  model: boolean;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const MINOR = new Set<Quality>(["m", "m7", "m7b5", "dim"]);
const third = (q: Quality) => (MINOR.has(q) ? "min" : q === "sus4" || q === "5" ? q : "maj");

/** Right root; right root and third; right root and quality (sevenths and all). */
class Score {
  n = 0;
  root = 0;
  majmin = 0;
  quality = 0;
  add(g: ChordGuess | null, truth: { root: number; quality: Quality | null }): void {
    if (truth.quality === null) return;
    this.n++;
    if (!g || g.root !== truth.root) return;
    this.root++;
    if (third(g.quality) === third(truth.quality)) this.majmin++;
    if (g.quality === truth.quality) this.quality++;
  }
  get report() {
    const r = (x: number) => round(x / Math.max(1, this.n));
    return { n: this.n, root: r(this.root), majmin: r(this.majmin), quality: r(this.quality) };
  }
}

const chordOf = (c: { root: number; quality: Quality | null } | null): Chord | null => (c && c.quality !== null ? parseChord(`${noteName(c.root)}${c.quality}`) : null);
/** The chart's chord at `t` and the next one. */
const priorAt = (list: JamsChord[], t: number): ChordPrior => ({ chord: chordOf(chordAt(list, t)), next: chordOf(list.find((c) => c.time > t) ?? null) });

/** The window both front ends hear: from the pick's noise to the chroma's 2048 samples. */
const chroma = new ChromaChords();
const FROM = 0.03;
const TO = chroma.needs;

export async function runChords(o: ChordEvalOptions): Promise<void> {
  const summary: Record<string, unknown> = { detector: "jamstate-chords/0.5", date: new Date().toISOString().slice(0, 10), window: [FROM, round(TO)] };
  const cpu = { chroma: 0, chromaN: 0, model: 0, modelAudio: 0 };
  const detectChroma = (x: Float32Array, t: number, prior: ChordPrior | null) => {
    const t0 = performance.now();
    const g = matchChord(chroma.profile(x, Math.round(t * SR)), prior);
    cpu.chroma += performance.now() - t0;
    cpu.chromaN++;
    return g && g.score >= CHORD_FLOOR ? g : null;
  };
  const model = async (x: Float32Array, rate: number) => {
    const y = toBpRate(x, rate);
    const t0 = performance.now();
    const frames = await transcribe(y);
    cpu.model += (performance.now() - t0) / 1000;
    cpu.modelAudio += y.length / 22050;
    return frames;
  };
  const detectModel = (frames: number[][], t: number, prior: ChordPrior | null) => {
    const g = matchChord(notesProfile(frames, t + FROM, t + TO), prior, "notes");
    return g && g.score >= CHORD_FLOOR ? g : null;
  };

  // ---------- synthesised strums ----------
  {
    const s = { chroma: new Score(), model: new Score() };
    for (let seed = 1; seed <= 6; seed++) {
      const { x, truth } = strumTake(seed);
      const frames = o.model ? await model(x, SR) : [];
      // Each strum with the chord heard before it, as the listener does.
      let heard: Record<"chroma" | "model", ChordGuess | null> = { chroma: null, model: null };
      for (const u of truth) {
        const c = detectChroma(x, u.time, { chord: null, next: null, heard: heard.chroma });
        s.chroma.add(c, u);
        heard.chroma = c ?? heard.chroma;
        if (!o.model) continue;
        const m = detectModel(frames, u.time, { chord: null, next: null, heard: heard.model });
        s.model.add(m, u);
        heard.model = m ?? heard.model;
      }
    }
    summary.synth = { chroma: s.chroma.report, ...(o.model ? { model: s.model.report } : {}) };
    console.log("synth strums", JSON.stringify(summary.synth));
  }

  // ---------- GuitarSet comping ----------
  if (!existsSync(join(o.set, "annotation"))) {
    console.log(`GuitarSet not found at ${o.set}: synthesised strums only.`);
  } else {
    const files = readdirSync(join(o.set, "annotation")).filter((f) => f.endsWith("_comp.jams")).sort().slice(0, o.limit);
    const keys = ["sheet", "sheet+prior", "played", "played+prior"] as const;
    const beat = Object.fromEntries((["chroma", "model"] as const).map((d) => [d, Object.fromEntries(keys.map((k) => [k, new Score()]))])) as Record<"chroma" | "model", Record<(typeof keys)[number], Score>>;
    const heard = { strums: 0, chords: 0, unpitched: 0, played: new Score(), sheet: new Score() };
    for (const [i, f] of files.entries()) {
      const j = readJams(readFileSync(join(o.set, "annotation", f), "utf8"));
      const w = decodeWav(readFileSync(join(o.set, "audio_mono-pickup_mix", f.replace(".jams", "_mix.wav"))));
      const x = resample(mono(w), w.rate);
      // The listener, as the page runs it: auto, with the lead sheet as the chart.
      const L = new AudioListener({ mode: "auto" });
      L.chordPrior = (t) => priorAt(j.instructed, t);
      const seen = new Set<number>();
      for (let k = 0; k < x.length; k += 256) {
        for (const e of L.push(x.subarray(k, k + 256), k / SR)) {
          if (e.kind !== "on" || seen.has(e.time)) continue;
          seen.add(e.time);
          heard.strums++;
          if (e.note < 0) heard.unpitched++;
          if (!e.chord) continue;
          heard.chords++;
          const p = parseChord(e.chord)!;
          const g = { root: p.root, quality: (e.chord.slice(noteName(p.root).length) as Quality), symbol: e.chord, score: 1 };
          const at = e.time + 0.05;
          const played = chordAt(j.performed, at);
          const sheet = chordAt(j.instructed, at);
          if (played) heard.played.add(g, played);
          if (sheet) heard.sheet.add(g, sheet);
        }
      }
      if (i % o.every !== 0) continue;
      // Per beat, both front ends.
      const frames = o.model ? await model(mono(w), w.rate) : [];
      for (const b of j.beats) {
        const sheet = chordAt(j.instructed, b + 0.05);
        const played = chordAt(j.performed, b + 0.05);
        if (!sheet || !played) continue;
        const prior = priorAt(j.instructed, b + 0.05);
        for (const d of o.model ? (["chroma", "model"] as const) : (["chroma"] as const)) {
          const det = (pr: ChordPrior | null) => (d === "chroma" ? detectChroma(x, b, pr) : detectModel(frames, b, pr));
          const bare = det(null);
          const lean = det(prior);
          beat[d].sheet.add(bare, sheet);
          beat[d]["sheet+prior"].add(lean, sheet);
          beat[d].played.add(bare, played);
          beat[d]["played+prior"].add(lean, played);
        }
      }
      console.log(`${i + 1}/${files.length} ${f}`);
    }
    summary.guitarset = {
      excerpts: files.length,
      per_beat_excerpts: Math.ceil(files.length / o.every),
      per_beat: Object.fromEntries(Object.entries(beat).filter(([d]) => o.model || d === "chroma").map(([d, s]) => [d, Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.report]))])),
      listener: { strums: heard.strums, chords: round(heard.chords / Math.max(1, heard.strums)), unpitched: round(heard.unpitched / Math.max(1, heard.strums)), played: heard.played.report, sheet: heard.sheet.report },
    };
  }

  // ---------- CPU and latency ----------
  const strumToAnswer = async () => {
    // The model on one window of its own length (what a live strum would cost).
    if (!o.model) return null;
    const y = new Float32Array(BP_WINDOW).map(() => (Math.random() - 0.5) * 0.1);
    await transcribe(y);
    const t0 = performance.now();
    for (let k = 0; k < 3; k++) await transcribe(y);
    return (performance.now() - t0) / 3 / 1000;
  };
  const window = await strumToAnswer();
  const chromaMs = cpu.chroma / Math.max(1, cpu.chromaN);
  summary.cost = {
    chroma: { ms_per_strum: round(chromaMs), strum_to_answer_s: round(TO + chromaMs / 1000) },
    ...(o.model ? { model: { seconds_per_second: round(cpu.model / Math.max(1e-9, cpu.modelAudio)), window_s: round(window!), strum_to_answer_s: round(TO + window!) } } : {}),
  };
  console.log(JSON.stringify(summary, null, 2));
  write(o.out, summary);
}

type Report = Score["report"];

/** What npm run chords-browser measured in headless Chrome, when it has been run. */
function browserLines(out: string): string[] {
  const path = join(out, "browser.json");
  if (!existsSync(path)) return [];
  const b = JSON.parse(readFileSync(path, "utf8")) as Record<string, string | number>;
  return [
    `In headless Chrome ${b.chrome} (\`npm run chords-browser\`, ${b.date}): the chroma ${b.chroma_ms} ms per strum; Basic Pitch ${b.model_webgl_window_ms} ms per 2 s window on WebGL (${b.model_webgl_renderer}: a software GPU, so slower than a real one) and ${b.model_cpu_window_ms} ms on the CPU backend.`,
    "",
  ];
}
function write(out: string, summary: Record<string, unknown>): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const cells = (r?: Report) => (r ? `${pct(r.root)} | ${pct(r.majmin)} | ${pct(r.quality)}` : "– | – | –");
  const synth = summary.synth as { chroma: Report; model?: Report };
  const gs = summary.guitarset as
    | { excerpts: number; per_beat_excerpts: number; per_beat: Record<string, Record<string, Report>>; listener: { strums: number; chords: number; unpitched: number; played: Report; sheet: Report } }
    | undefined;
  const cost = summary.cost as { chroma: { ms_per_strum: number; strum_to_answer_s: number }; model?: { seconds_per_second: number; window_s: number; strum_to_answer_s: number } };
  const lines = [
    "# v0.5 chords: how well chords are heard from a guitar",
    "",
    `Run on ${summary.date} with \`npm run guitar-eval -- chords\` (${summary.detector}). Two front ends feed the same chord templates and chart prior: the **chroma** of the strum (the page's) and **Basic Pitch**, a transcription model (eval only). Both hear the strum from 30 ms to ${Math.round(TO * 1000)} ms after it. Scores: the right root; the right root and third (major or minor); the right root and quality as heard here (triads, sevenths, m7b5, sus4, power chords).`,
    "",
    "## Synthesised strums",
    "",
    `${synth.chroma.n} strums (down and up) of voicings all over the neck.`,
    "",
    "| Front end | Root | Major/minor | Quality |",
    "|---|---|---|---|",
    `| Chroma | ${cells(synth.chroma)} |`,
    ...(synth.model ? [`| Basic Pitch | ${cells(synth.model)} |`] : []),
    "",
  ];
  if (gs) {
    lines.push(
      "## GuitarSet comping, per beat",
      "",
      `${gs.per_beat_excerpts} of ${gs.excerpts} comping excerpts (every one in ${Math.round(gs.excerpts / gs.per_beat_excerpts)}), pickup. Each beat against the lead sheet's chord and the chord as played (GuitarSet annotates both; players add sevenths, suspensions and inversions), with and without the chart prior. Beats are not always strums, so these are lower bounds.`,
      "",
      "| Front end | Against | Root | Major/minor | Quality |",
      "|---|---|---|---|---|",
      ...Object.entries(gs.per_beat).flatMap(([d, s]) => Object.entries(s).map(([k, r]) => `| ${d === "chroma" ? "Chroma" : "Basic Pitch"} | ${k.replace("+prior", ", with the prior")} | ${cells(r)} |`)),
      "",
      "## The listener on GuitarSet comping",
      "",
      `What the page does: auto, the lead sheet as the chart. ${gs.listener.strums} strums and hits heard on all ${gs.excerpts} excerpts: ${pct(gs.listener.chords)} heard as chords, ${pct(gs.listener.unpitched)} as unpitched hits, the rest as single notes.`,
      "",
      "| Chords heard, against | Root | Major/minor | Quality |",
      "|---|---|---|---|",
      `| The chord as played | ${cells(gs.listener.played)} |`,
      `| The lead sheet | ${cells(gs.listener.sheet)} |`,
      "",
    );
  }
  lines.push(
    "## Cost",
    "",
    "| Front end | CPU | Strum to answer |",
    "|---|---|---|",
    `| Chroma | ${cost.chroma.ms_per_strum} ms per strum | ${Math.round(cost.chroma.strum_to_answer_s * 1000)} ms |`,
    ...(cost.model ? [`| Basic Pitch (TF.js CPU backend, Node) | ${cost.model.seconds_per_second} s per second of audio; ${Math.round(cost.model.window_s * 1000)} ms per 2 s window | ${Math.round(cost.model.strum_to_answer_s * 1000)} ms |`] : []),
    "",
    ...browserLines(out),
    "GuitarSet: Q. Xi, R. Bittner, J. Pauwels, X. Ye, J. P. Bello, \"GuitarSet: A Dataset for Guitar Transcription\", ISMIR 2018. CC BY 4.0. Basic Pitch: R. Bittner et al., \"A Lightweight Instrument-Agnostic Model for Polyphonic Note Transcription and Multipitch Estimation\", ICASSP 2022. Apache 2.0.",
    "",
  );
  writeFileSync(join(out, "README.md"), lines.join("\n"));
  console.log(`Wrote ${out}/README.md`);
}
