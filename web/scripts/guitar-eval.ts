// npm run guitar-eval -- pitch [--set DIR] [--out DIR] [--limit N]
// npm run guitar-eval -- chords [...] [--rewrite] (scripts/guitar-chords.ts)
// npm run guitar-eval -- bleed (scripts/guitar-bleed.ts)
//
// How well the audio listener hears a guitar (v0.5). Synthesised solo lines
// (with hammer-ons and vibrato) and GuitarSet (CC BY 4.0; six players, five
// styles, each excerpt played as comping and as a solo, through a hexaphonic
// pickup and a mic). Not in the repo: download it to
// ~/.local/share/jamstate/guitarset (annotation/, audio_mono-pickup_mix/,
// audio_mono-mic/).
//
// pitch: onsets (precision, recall, F1 within ±50 ms) on everything; notes
// (onset and pitch) on solos with the listener on single notes, all of them
// and those played alone (no other note within 60 ms: solos have double stops
// and chord stabs a single-note detector can't name); octave errors; and the
// CPU the listener takes (seconds per second of audio, one thread). Each take
// is levelled like a calibrated input (its loudest moment at −6 dBFS).
// Writes summary.json and README.md to --out.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resample, SR } from "../src/core/audio/dsp";
import { AudioListener, type DetectionMode, type ListenerEvent } from "../src/core/audio/listener";
import { soloLine } from "../src/core/audio/takes";
import { decodeWav, mono } from "../src/core/audio/wav";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const set = opt("set") ?? join(homedir(), ".local/share/jamstate/guitarset");
const limit = Number(opt("limit") ?? Infinity);
const [cmd] = args;
const out = opt("out") ?? `../docs/eval/results/v0.5-${cmd}`;
if (cmd === "bleed") {
  const { runBleed } = await import("./guitar-bleed");
  runBleed(out);
  process.exit(0);
}
if (cmd === "chords") {
  const { runChords, write } = await import("./guitar-chords");
  // --rewrite: only the write-up again, from summary.json (after npm run chords-browser).
  if (args.includes("--rewrite")) {
    write(out, JSON.parse(readFileSync(join(out, "summary.json"), "utf8")));
    process.exit(0);
  }
  const noModel = args.includes("--no-model");
  await runChords({ set, out, limit, every: Number(opt("every") ?? 3), model: !noModel });
  process.exit(0);
}
if (cmd !== "pitch") {
  console.error("usage: npm run guitar-eval -- pitch|chords|bleed [--set DIR] [--out DIR] [--limit N] [--every N] [--no-model]");
  process.exit(2);
}

interface Truth {
  time: number;
  note: number;
}

/** Counts for precision and recall. */
class Tally {
  hit = 0;
  found = 0;
  all = 0;
  octave = 0;
  add(o: Tally): void {
    this.hit += o.hit;
    this.found += o.found;
    this.all += o.all;
    this.octave += o.octave;
  }
  get report() {
    const p = this.hit / Math.max(1, this.found);
    const r = this.hit / Math.max(1, this.all);
    return { precision: round(p), recall: round(r), f1: round((2 * p * r) / Math.max(1e-9, p + r)), notes: this.all, octave_errors: this.octave };
  }
}
const round = (x: number) => Math.round(x * 1000) / 1000;

/** Greedy matching within ±50 ms; with `pitch`, the note must match too. */
function score(truth: Truth[], ons: { time: number; note: number }[], pitch: boolean): Tally {
  const t = new Tally();
  t.found = ons.length;
  t.all = truth.length;
  const used = new Set<number>();
  for (const u of truth) {
    const j = ons.findIndex((o, k) => !used.has(k) && Math.abs(o.time - u.time) < 0.05 && (!pitch || o.note === u.note));
    if (j >= 0) used.add(j);
    else if (pitch && ons.some((o) => Math.abs(o.time - u.time) < 0.05 && Math.abs(o.note - u.note) === 12)) t.octave++;
  }
  t.hit = used.size;
  return t;
}

/** Notes with no other note starting within 60 ms. */
function alone(truth: Truth[]): Truth[] {
  return truth.filter((u, i) => !truth.some((v, k) => k !== i && Math.abs(v.time - u.time) < 0.06));
}

/** Notes alone: recall over them, precision over detections not near another truth note. */
function scoreAlone(truth: Truth[], ons: { time: number; note: number }[]): Tally {
  const single = alone(truth);
  const crowded = truth.filter((u) => !single.includes(u));
  const mine = ons.filter((o) => !crowded.some((u) => Math.abs(o.time - u.time) < 0.05));
  return score(single, mine, true);
}

/** The loudest moment at −6 dBFS. */
function level(x: Float32Array): Float32Array {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.5 / peak : 1;
  return x.map((v) => v * g);
}

/** Onsets closer than 30 ms count once (a strum's strings, or a note annotated on two strings). */
function onsetTruth(truth: Truth[]): Truth[] {
  const out: Truth[] = [];
  for (const u of [...truth].sort((a, b) => a.time - b.time)) if (!out.length || u.time - out[out.length - 1].time > 0.03) out.push(u);
  return out;
}

let cpu = 0;
let audioSeconds = 0;
function listen(x: Float32Array, mode: DetectionMode): ListenerEvent[] {
  const L = new AudioListener({ mode });
  const ev: ListenerEvent[] = [];
  const t0 = performance.now();
  for (let i = 0; i < x.length; i += 256) ev.push(...L.push(x.subarray(i, i + 256), i / SR));
  cpu += (performance.now() - t0) / 1000;
  audioSeconds += x.length / SR;
  // A chord's notes share their strum's onset: count it once.
  const seen = new Set<number>();
  return ev.filter((e) => e.kind === "on" && !seen.has(e.time) && !!seen.add(e.time));
}

const summary: Record<string, unknown> = { detector: "jamstate-listener/0.5", date: new Date().toISOString().slice(0, 10) };

// ---------- synthesised lines ----------
{
  const notes = new Tally();
  const onsets = new Tally();
  for (let seed = 1; seed <= 8; seed++) {
    const { x, truth } = soloLine(seed);
    const ons = listen(x, "single");
    notes.add(score(truth, ons, true));
    onsets.add(score(truth, ons, false));
  }
  summary.synth = { onsets: onsets.report, notes: notes.report };
  console.log("synth lines", summary.synth);
}

// ---------- GuitarSet ----------
interface Jams {
  annotations: { namespace: string; data: { time: number; value: number }[] }[];
}

if (!existsSync(join(set, "annotation"))) {
  console.log(`GuitarSet not found at ${set}: synthesised lines only.`);
} else {
  const files = readdirSync(join(set, "annotation")).filter((f) => f.endsWith(".jams")).sort();
  const groups: Record<string, { onsets: Tally; notes: Tally; alone: Tally }> = {};
  const group = (k: string) => (groups[k] ??= { onsets: new Tally(), notes: new Tally(), alone: new Tally() });
  let n = 0;
  for (const f of files) {
    if (n >= limit) break;
    const stem = f.replace(/\.jams$/, "");
    const [, style] = /^\d+_([A-Za-z]+)\d/.exec(stem) ?? [];
    const solo = stem.endsWith("_solo");
    const jams = JSON.parse(readFileSync(join(set, "annotation", f), "utf8")) as Jams;
    const truth = jams.annotations
      .filter((a) => a.namespace === "note_midi")
      .flatMap((a) => a.data.map((d) => ({ time: d.time, note: Math.round(d.value) })))
      .sort((a, b) => a.time - b.time);
    for (const [source, dir, suffix] of [["pickup", "audio_mono-pickup_mix", "_mix"], ["mic", "audio_mono-mic", "_mic"]] as const) {
      const path = join(set, dir, `${stem}${suffix}.wav`);
      if (!existsSync(path)) continue;
      const w = decodeWav(readFileSync(path));
      const x = level(resample(mono(w), w.rate));
      const ons = listen(x, solo ? "single" : "auto");
      const kind = solo ? "solo" : "comp";
      for (const k of [`${source}/${kind}`, `${source}/${kind}/${style}`]) {
        group(k).onsets.add(score(onsetTruth(truth), ons, false));
        if (solo) {
          group(k).notes.add(score(truth, ons, true));
          group(k).alone.add(scoreAlone(truth, ons));
        }
      }
    }
    n++;
    if (n % 20 === 0) console.log(`${n} excerpts`);
  }
  summary.guitarset = Object.fromEntries(
    Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, g]) => [k, k.includes("/solo") ? { onsets: g.onsets.report, notes: g.notes.report, alone: g.alone.report } : { onsets: g.onsets.report }]),
  );
  summary.excerpts = n;
}
summary.cpu = { audio_seconds: Math.round(audioSeconds), seconds_per_second: round(cpu / audioSeconds) };
console.log(JSON.stringify(summary, null, 2));

// ---------- the write-up ----------
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
type Report = Tally["report"];
const gs = (summary.guitarset ?? {}) as Record<string, { onsets: Report; notes?: Report; alone?: Report }>;
const pr = (r?: Report) => (r ? `${r.precision} / ${r.recall} / **${r.f1}**` : "–");
const row = (name: string, r: { onsets: Report; notes?: Report; alone?: Report }) =>
  `| ${name} | ${pr(r.onsets)} | ${pr(r.notes)} | ${pr(r.alone)} | ${r.notes ? `${r.notes.octave_errors} / ${r.notes.notes}` : "–"} |`;
const lines = [
  "# v0.5 pitch: how well the listener hears a guitar",
  "",
  `Run on ${summary.date} with \`npm run guitar-eval -- pitch\` (${summary.detector}, ${summary.excerpts ?? 0} GuitarSet excerpts, pickup and mic). Precision / recall / F1. Onsets match within ±50 ms; a note also needs the right pitch. "Alone" counts only notes with no other note starting within 60 ms (solos have double stops a single-note detector can't name). Solos are heard on "single notes", comping on "auto" (onsets only until the chord layer). Each take is levelled like a calibrated input.`,
  "",
  "| Take | Onsets | Notes | Notes alone | Octave errors |",
  "|---|---|---|---|---|",
  row("Synthesised lines (8)", { ...(summary.synth as { onsets: Report; notes: Report }), alone: (summary.synth as { notes: Report }).notes }),
  ...Object.entries(gs).map(([k, r]) => row(`GuitarSet ${k}`, r)),
  "",
  `CPU: ${(summary.cpu as { seconds_per_second: number }).seconds_per_second} seconds per second of audio on one thread (${(summary.cpu as { audio_seconds: number }).audio_seconds} s of audio).`,
  "",
  "GuitarSet: Q. Xi, R. Bittner, J. Pauwels, X. Ye, J. P. Bello, \"GuitarSet: A Dataset for Guitar Transcription\", ISMIR 2018. CC BY 4.0. Not kept in the repo.",
  "",
];
writeFileSync(join(out, "README.md"), lines.join("\n"));
console.log(`Wrote ${out}/README.md`);
