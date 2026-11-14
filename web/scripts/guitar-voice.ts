// npm run guitar-eval -- voice [--out DIR]
//
// Voice cues (v0.5 layer 5, ADR-0026). Every cue phrase said by four
// synthesised voices (Piper, at two speeds) over what the voice mic hears
// besides: nothing, the band through the speakers (with the bleed gate off
// and on), a strummed guitar, a single-note line. At several levels (the
// speech's level over the rest's), one phrase every 4 s. Reports the share of
// phrases heard as their cue, wrong cues, and the time from the end of the
// phrase to the cue. Then false cues per minute: the band, the guitar and
// table talk (sentences that aren't cues, some close to them) with no cue
// in them. Cues are taken as the page takes them (VoiceCues); the same
// totals for waiting on the final result and for other holds compare the
// two ways in.
//
// Recognition runs in Vosk (Python), the same engine, model and grammar as
// the page (scripts/vosk-eval.py). Needs:
//   PIPER        the piper command (pip install piper-tts)
//   VOSK_PYTHON  a Python with vosk (pip install vosk)
// and the voices in ~/.local/share/jamstate/piper and the model in
// ~/.local/share/jamstate/vosk (npm run fetch-models fetches the model).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BleedGate } from "../src/core/audio/bleed";
import { resample, rms, SR } from "../src/core/audio/dsp";
import { bandTake, soloLine, strumTake, throughRoom } from "../src/core/audio/takes";
import { decodeWav, encodeWav, mono } from "../src/core/audio/wav";
import { VOICE_GRAMMAR, VOICE_HOLD, VOICE_PHRASES, VoiceCues, type VoiceCue, type VoiceResult } from "../src/core/voice";

const HOME = join(homedir(), ".local/share/jamstate");
const VOICES = ["en_US-lessac-low", "en_US-ryan-low", "en_GB-alan-low", "en_US-amy-low"];
const SPEEDS = [1, 0.8];
const LEVELS = [18, 12, 6, 0];
const SLOT = 4;
const TALK = [
  "that sounds great",
  "what key is this in",
  "i need a break after this one",
  "can you bring the bass up a bit",
  "one more thing",
  "take it easy",
  "let's go",
  "the drums sound good",
  "build me a better groove",
  "is this the next song",
  "okay from the top",
  "one two three four",
];
const BEDS = ["none", "band", "band+gate", "strums", "line"] as const;
type Bed = (typeof BEDS)[number];

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const slug = (s: string) => s.replace(/[^a-z]+/g, "-");

interface Said {
  x: Float32Array;
  /** Speech starts and ends inside x (seconds). */
  start: number;
  end: number;
}

/** A phrase in a voice at a speed, from Piper (cached), levelled to −20 dBFS RMS while speaking. */
export function say(text: string, voice: string, speed: number, cache = join(HOME, "voice-phrases")): Said {
  const file = join(cache, `${voice}-${speed}-${slug(text)}.wav`);
  if (!existsSync(file)) {
    mkdirSync(cache, { recursive: true });
    const piper = process.env.PIPER ?? "piper";
    execFileSync(piper, ["-m", join(HOME, "piper", `${voice}.onnx`), "-f", file, "--length_scale", String(1 / speed)], { input: text, stdio: ["pipe", "ignore", "ignore"] });
  }
  const w = decodeWav(readFileSync(file));
  let x = mono(w);
  if (w.rate !== SR) x = resample(x, w.rate);
  const frame = 160;
  const loud: number[] = [];
  for (let i = 0; i + frame <= x.length; i += frame) loud.push(rms(x, i, i + frame));
  const peak = Math.max(...loud);
  const on = loud.map((v) => v > peak * 0.05);
  const a = on.indexOf(true);
  const b = on.lastIndexOf(true) + 1;
  const speech = loud.filter((_, i) => on[i]);
  const level = Math.sqrt(speech.reduce((s, v) => s + v * v, 0) / speech.length);
  const g = 0.1 / level;
  return { x: x.map((v) => v * g), start: (a * frame) / SR, end: (b * frame) / SR };
}

/** What the voice mic hears besides the voice, `seconds` long, at 0.1 RMS (with the band's own mix for the gate). */
function bed(kind: Bed, seed: number, seconds: number): { x: Float32Array; ref?: Float32Array } {
  const n = Math.round(seconds * SR);
  const loop = (y: Float32Array) => Float32Array.from({ length: n }, (_, i) => y[i % y.length]);
  let x: Float32Array;
  let ref: Float32Array | undefined;
  if (kind === "none") return { x: new Float32Array(n) };
  if (kind === "band" || kind === "band+gate") {
    ref = bandTake(seed, seconds);
    x = throughRoom(ref, { seed });
  } else if (kind === "strums") {
    const parts: Float32Array[] = [];
    for (let s = 0, len = 0; len < n; s++) {
      const t = strumTake(seed * 10 + s).x;
      parts.push(t);
      len += t.length;
    }
    x = loop(concat(parts));
  } else {
    const parts: Float32Array[] = [];
    for (let s = 0, len = 0; len < n; s++) {
      const t = soloLine(seed * 10 + s).x;
      parts.push(t);
      len += t.length;
    }
    x = loop(concat(parts));
  }
  x = x.subarray(0, n);
  const g = 0.1 / rms(x);
  return { x: x.map((v) => v * g), ref: ref?.map((v) => v * g) };
}

function concat(xs: Float32Array[]): Float32Array {
  const out = new Float32Array(xs.reduce((s, x) => s + x.length, 0));
  let at = 0;
  for (const x of xs) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}

/** The mix through the gate when there's a reference: the cleaned audio, re-aligned. */
function gated(x: Float32Array, ref: Float32Array): Float32Array {
  const G = new BleedGate();
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 256) y.set(G.push(x.subarray(i, i + 256), ref.subarray(i, i + 256)), i);
  return Float32Array.from({ length: x.length }, (_, i) => y[i + G.latency] ?? 0);
}

interface Job {
  file: string;
  /** Phrases said: their cue and when they end (null for talk that isn't a cue). */
  truth: { cue: VoiceCue | null; start: number; end: number; text: string }[];
  seconds: number;
}

type Final = VoiceResult & { at: number };
interface Heard {
  results: Final[];
  partials: { partial: string; at: number }[];
}

function recognise(jobs: Job[], model: string): Map<string, Heard> {
  const py = process.env.VOSK_PYTHON ?? "python3";
  const out = execFileSync(py, [join(import.meta.dirname, "vosk-eval.py")], {
    input: JSON.stringify({ model, grammar: VOICE_GRAMMAR, files: jobs.map((j) => j.file) }),
    maxBuffer: 1 << 28,
  }).toString();
  const res = new Map<string, Heard>();
  for (const line of out.trim().split("\n")) {
    const r = JSON.parse(line);
    res.set(r.file, r);
  }
  return res;
}

/** The cues the page would give: the recogniser's results fed to VoiceCues chunk by chunk (0.1 s), as in the page. */
function cuesOf(h: Heard, seconds: number, hold: number): { at: number; text: string; cue: VoiceCue }[] {
  const vc = new VoiceCues(hold);
  const out: { at: number; text: string; cue: VoiceCue }[] = [];
  let f = 0;
  let p = 0;
  let text = "";
  for (let k = 1; k <= Math.ceil(seconds * 10); k++) {
    const at = k / 10 + 1e-6;
    while (f < h.results.length && h.results[f].at <= at) {
      const r = h.results[f++];
      const c = vc.final(r);
      if (c) out.push({ at: r.at, text: r.text, cue: c.cue });
    }
    while (p < h.partials.length && h.partials[p].at <= at) text = h.partials[p++].partial;
    const c = vc.partial(text, k / 10);
    if (c) out.push({ at: k / 10, text: `${text} (partial)`, cue: c.cue });
  }
  while (f < h.results.length) {
    const r = h.results[f++];
    const c = vc.final(r);
    if (c) out.push({ at: r.at, text: r.text, cue: c.cue });
  }
  return out;
}

export function runVoice(out: string): void {
  const model = join(HOME, "vosk", "vosk-model-small-en-us-0.15");
  const cache = join(HOME, "voice-phrases");
  const work = join(tmpdir(), "jamstate-voice");
  mkdirSync(cache, { recursive: true });
  mkdirSync(work, { recursive: true });
  const phrases = Object.keys(VOICE_PHRASES);

  // Cues over each bed at each level: one file per voice and speed.
  const jobs: (Job & { bed: Bed; level: number; voice: string })[] = [];
  let seed = 1;
  for (const b of BEDS) {
    for (const level of b === "none" ? [Infinity] : LEVELS) {
      for (const voice of VOICES) {
        for (const speed of SPEEDS) {
          const secs = phrases.length * SLOT + 1;
          const { x: bx, ref } = bed(b, seed++, secs);
          const g = Number.isFinite(level) ? Math.pow(10, -level / 20) : 0;
          const x = bx.map((v) => v * g);
          const truth: Job["truth"] = [];
          phrases.forEach((p, i) => {
            const s = say(p, voice, speed, cache);
            const at = Math.round((i * SLOT + 0.5) * SR);
            for (let k = 0; k < s.x.length && at + k < x.length; k++) x[at + k] += s.x[k];
            truth.push({ cue: VOICE_PHRASES[p], start: at / SR + s.start, end: at / SR + s.end, text: p });
          });
          const y = b === "band+gate" ? gated(x, ref!.map((v) => v * g)) : x;
          const file = join(work, `${b}-${level}-${voice}-${speed}.wav`);
          writeFileSync(file, encodeWav([y], SR));
          jobs.push({ file, truth, seconds: secs, bed: b, level, voice });
        }
      }
    }
  }
  // No cues: each bed alone (at the loudest level) and table talk over the band.
  const quiet: (Job & { what: string })[] = [];
  for (const b of ["band", "band+gate", "strums", "line"] as const) {
    const secs = 180;
    const { x: bx, ref } = bed(b, 900 + quiet.length, secs);
    const g = Math.pow(10, -LEVELS[LEVELS.length - 1] / 20);
    const x = bx.map((v) => v * g);
    const y = b === "band+gate" ? gated(x, ref!.map((v) => v * g)) : x;
    const file = join(work, `alone-${b}.wav`);
    writeFileSync(file, encodeWav([y], SR));
    quiet.push({ file, truth: [], seconds: secs, what: b });
  }
  for (const voice of VOICES) {
    const secs = TALK.length * SLOT + 1;
    const { x: bx } = bed("band", 950 + quiet.length, secs);
    const x = bx.map((v) => v * Math.pow(10, -12 / 20));
    const truth: Job["truth"] = [];
    TALK.forEach((t, i) => {
      const s = say(t, voice, 1, cache);
      const at = Math.round((i * SLOT + 0.5) * SR);
      for (let k = 0; k < s.x.length && at + k < x.length; k++) x[at + k] += s.x[k];
      truth.push({ cue: null, start: at / SR + s.start, end: at / SR + s.end, text: t });
    });
    const file = join(work, `talk-${voice}.wav`);
    writeFileSync(file, encodeWav([x], SR));
    quiet.push({ file, truth, seconds: secs, what: "talk" });
  }

  const t0 = performance.now();
  const heard = recognise([...jobs, ...quiet], model);
  const recSecs = (performance.now() - t0) / 1000;
  const audioSecs = [...jobs, ...quiet].reduce((s, j) => s + j.seconds, 0);

  // Scoring: a phrase is heard when a cue comes out between its start and 2 s after its end.
  const score = (hold: number) => {
    const cell = () => ({ said: 0, hit: 0, wrong: 0, lags: [] as number[] });
    const byBed: Record<string, Record<string, ReturnType<typeof cell>>> = {};
    const byPhrase: Record<string, ReturnType<typeof cell>> = {};
    const byVoice: Record<string, ReturnType<typeof cell>> = {};
    const all = cell();
    const misses: string[] = [];
    for (const j of jobs) {
      const cues = cuesOf(heard.get(j.file)!, j.seconds, hold);
      const c = ((byBed[j.bed] ??= {})[String(j.level)] ??= cell());
      const p = j.truth.map((u) => (byPhrase[u.text] ??= cell()));
      const v = (byVoice[j.voice] ??= cell());
      j.truth.forEach((u, i) => {
        const got = cues.filter((r) => r.at > u.start && r.at < u.end + 2);
        const right = got.find((r) => r.cue === u.cue);
        for (const cc of [c, p[i], v, all]) {
          cc.said++;
          if (right) {
            cc.hit++;
            cc.lags.push(right.at - u.end);
          }
          if (got.some((r) => r.cue !== u.cue)) cc.wrong++;
        }
        if (!right && j.bed !== "none" && j.level >= 12) {
          const near = heard.get(j.file)!.results.filter((r) => r.at > u.start && r.at < u.end + 2).map((r) => r.text);
          misses.push(`${j.bed} +${j.level} dB ${j.voice}: "${u.text}" heard as ${near.length ? near.map((t) => `"${t}"`).join(", ") : "nothing"}`);
        }
        for (const r of got.filter((r) => r.cue !== u.cue)) misses.push(`${j.bed} +${j.level} dB ${j.voice}: "${u.text}" gave ${r.cue} ("${r.text}")`);
      });
    }
    const falseCues: Record<string, { minutes: number; cues: number; per_min: number; heard: string[] }> = {};
    for (const q of quiet) {
      const got = cuesOf(heard.get(q.file)!, q.seconds, hold);
      const f = (falseCues[q.what] ??= { minutes: 0, cues: 0, per_min: 0, heard: [] });
      f.minutes = round(f.minutes + q.seconds / 60, 2);
      f.cues += got.length;
      f.heard.push(...got.map((r) => r.text));
      f.per_min = round(f.cues / f.minutes, 2);
    }
    return { byBed, byPhrase, byVoice, all, misses, falseCues };
  };
  const show = (c: { said: number; hit: number; wrong: number; lags: number[] }) => {
    const lags = [...c.lags].sort((a, b) => a - b);
    return {
      said: c.said,
      hit: round(c.hit / c.said),
      wrong: round(c.wrong / c.said),
      lag_median: lags.length ? round(lags[Math.floor(lags.length / 2)], 2) : null,
      lag_p90: lags.length ? round(lags[Math.floor(lags.length * 0.9)], 2) : null,
    };
  };
  // Waiting for the final result against taking a held partial at a few holds.
  const holds = Object.fromEntries(
    [Infinity, 0.15, 0.25, 0.4].map((h) => {
      const r = score(h);
      const talk = r.falseCues.talk;
      return [h === Infinity ? "final only" : `hold ${h} s`, { ...show(r.all), false_cues: Object.values(r.falseCues).reduce((s, f) => s + f.cues, 0), talk: talk.heard }];
    }),
  );
  const { byBed, byPhrase, byVoice, misses, falseCues } = score(VOICE_HOLD);
  const summary = {
    model: "vosk-model-small-en-us-0.15",
    voices: VOICES,
    speeds: SPEEDS,
    levels_db: LEVELS,
    hold_s: VOICE_HOLD,
    holds,
    cues: Object.fromEntries(Object.entries(byBed).map(([b, ls]) => [b, Object.fromEntries(Object.entries(ls).map(([l, c]) => [l, show(c)]))])),
    phrases: Object.fromEntries(Object.entries(byPhrase).map(([p, c]) => [p, show(c)])),
    voices_hit: Object.fromEntries(Object.entries(byVoice).map(([v, c]) => [v, show(c)])),
    false_cues: falseCues,
    misses_at_12db_and_up_and_wrong: misses,
    cpu: { recogniser_s_per_s: round(recSecs / audioSecs, 4) },
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeVoice(out);
  console.log(JSON.stringify({ holds, cues: summary.cues, false_cues: Object.fromEntries(Object.entries(falseCues).map(([k, f]) => [k, [f.per_min, f.heard]])), cpu: summary.cpu }, null, 1));
}

type Shown = { said: number; hit: number; wrong: number; lag_median: number | null; lag_p90: number | null };

/** The write-up (README.md) from summary.json. */
export function writeVoice(out: string): void {
  const d = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const lag = (c: Shown) => (c.lag_median === null ? "–" : `${c.lag_median} s / ${c.lag_p90} s`);
  const beds: Record<string, string> = { none: "nothing else", band: "the band through the speakers", "band+gate": "the band, gate on", strums: "a strummed guitar", line: "a single-note line" };
  const L: string[] = [
    "# v0.5 voice cues: synthesised speech over the band and guitar",
    "",
    `Run on ${new Date().toISOString().slice(0, 10)} with \`npm run guitar-eval -- voice\`. Every cue phrase (${Object.keys(d.phrases).length}) said by ${d.voices.length} Piper voices (${d.voices.join(", ")}) at ${d.speeds.length} speeds, one phrase every 4 s, over what the voice mic hears besides. The level is the speech's over the rest's (RMS while speaking). Recognised by ${d.model} with the cue grammar in Vosk (Python: the engine, model and grammar the page runs in WASM), cues taken as the page takes them: from a partial result that holds ${d.hold_s} s when no other phrase starts with it, else from the final result. A phrase is heard when its cue comes out between its start and 2 s after its end; the time to cue is from the end of the speech.`,
    "",
    "## Waiting for the final result, or taking a held partial",
    "",
    "| Way in | Heard | Wrong cue | Time to cue (median / 90th) | False cues (15 min with no cue) |",
    "|---|---|---|---|---|",
    ...Object.entries(d.holds as Record<string, Shown & { false_cues: number }>).map(([k, c]) => `| ${k} | ${pct(c.hit)} | ${pct(c.wrong)} | ${lag(c)} | ${c.false_cues} |`),
    "",
    "## Cues heard, by what else the mic hears",
    "",
    `| Besides the voice | ${d.levels_db.map((l: number) => `+${l} dB`).join(" | ")} |`,
    `|---|${d.levels_db.map(() => "---").join("|")}|`,
    ...Object.entries(d.cues as Record<string, Record<string, Shown>>).map(([b, ls]) =>
      b === "none"
        ? `| ${beds[b]} | ${pct(Object.values(ls)[0].hit)} (${lag(Object.values(ls)[0])}) |${d.levels_db.slice(1).map(() => "").join(" |")} |`
        : `| ${beds[b]} | ${d.levels_db.map((l: number) => `${pct(ls[String(l)].hit)}${ls[String(l)].wrong ? `, ${pct(ls[String(l)].wrong)} wrong` : ""}`).join(" | ")} |`,
    ),
    "",
    "## By phrase and voice",
    "",
    "| Phrase | Heard | Wrong | Time to cue |",
    "|---|---|---|---|",
    ...Object.entries(d.phrases as Record<string, Shown>).map(([p, c]) => `| ${p} | ${pct(c.hit)} | ${pct(c.wrong)} | ${lag(c)} |`),
    "",
    "| Voice | Heard | Time to cue |",
    "|---|---|---|",
    ...Object.entries(d.voices_hit as Record<string, Shown>).map(([v, c]) => `| ${v} | ${pct(c.hit)} | ${lag(c)} |`),
    "",
    "## False cues",
    "",
    "Three minutes of each bed alone at its loudest (0 dB), and table talk over the band at +12 dB: twelve sentences that aren't cues, some close (\"one more thing\", \"take it easy\", \"i need a break after this one\", \"build me a better groove\"), in each voice.",
    "",
    "| With no cue said | Minutes | Cues | Heard as |",
    "|---|---|---|---|",
    ...Object.entries(d.false_cues as Record<string, { minutes: number; cues: number; heard: string[] }>).map(([k, f]) => `| ${k === "talk" ? "table talk" : (beds[k] ?? k)} | ${f.minutes} | ${f.cues} | ${f.heard.map((t) => `"${t}"`).join(", ") || "–"} |`),
    "",
    `Misses at +12 dB and up, and wrong cues: ${d.misses_at_12db_and_up_and_wrong.length ? "" : "none."}`,
    "",
    ...d.misses_at_12db_and_up_and_wrong.map((m: string) => `- ${m}`),
    "",
    `The recogniser's CPU: ${d.cpu.recogniser_s_per_s} seconds per second of audio (Python, one thread; the page runs the same in WASM in a worker).`,
    "",
  ];
  writeFileSync(join(out, "README.md"), L.join("\n"));
}
