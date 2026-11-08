// npm run sound-check -- [--clips out/dir] [--seconds 30]
//
// Machine ears for the built-in sound (v0.2). Renders songs through the real
// band (engine, samples, mix bus) in headless Chrome, faster than real time,
// and checks what can be checked without ears:
//   - every instrument in the lineup played from samples (none fell back);
//   - the master never clips and sits in a sane loudness window;
//   - switching an instrument mid-song doesn't click;
//   - each genre's default lineup stays under the 10 MB budget.
// With --clips it also writes MP3s to listen to (the taste lane).
// Exit code 1 when a check fails.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

/** Playwright from this project, else the machine's global install (not a dependency: it brings its own browser). */
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return createRequire(join(root, "noop.js"))("playwright");
  }
}
const { chromium } = await loadPlaywright();

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const clipsDir = opt("clips", null);
const seconds = Number(opt("seconds", "30"));

const chart = (f) => JSON.parse(readFileSync(join("public/charts", f), "utf8"));
const funk = chart("night-shift.json");
const blues = chart("blues-in-a.json");
const jazz = chart("late-set.json");
const PLAYER = "medium:4,busy:4,sparse:2,medium:4";

/** What to render. `clip` names the MP3; `switches` marks a click check. */
const JOBS = [
  { name: "funk-default", chart: funk, genre: "funk", player: PLAYER },
  { name: "blues-rock-default", chart: { ...blues, band: undefined }, genre: "blues-rock", player: PLAYER },
  { name: "jazz-default", chart: jazz, genre: "jazz", player: PLAYER },
  // The roadmap's two lineups: upright + brushes + piano, and electric + kit + organ + guitar.
  { name: "jazz-trio-upright-brushes-piano", chart: jazz, genre: "jazz", band: { drums: { instrument: "brushes" }, bass: { instrument: "upright" }, chords: { instrument: "piano" } } },
  { name: "blues-electric-kit-organ-guitar", chart: blues, genre: "blues-rock", player: PLAYER },
  // Same song, other genre: the lineup and mix change with it.
  { name: "night-shift-as-jazz", chart: { ...funk, genre: "jazz" }, genre: "jazz", player: PLAYER },
  {
    name: "funk-keys-switch",
    chart: funk,
    genre: "funk",
    player: PLAYER,
    switches: [
      { bar: 4, band: { drums: { instrument: "kit" }, bass: { instrument: "electric" }, chords: { instrument: "clav" }, guitar: { instrument: "funk" } } },
      { bar: 8, band: { drums: { instrument: "kit" }, bass: { instrument: "synth" }, chords: { instrument: "organ" }, guitar: { instrument: "funk" }, percussion: { instrument: "hand" } } },
    ],
  },
  { name: "funk-synth-only", chart: funk, genre: "funk", player: PLAYER, synthOnly: true },
];

const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/favicon|api\/health|404/.test(m.text()) && errors.push(m.text()));
// No companion server here: answer its API with 404s, as a static host would.
await page.route("**/api/**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
await page.goto("http://localhost:5199/");

let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(`  FAIL ${msg}`);
};

const manifest = JSON.parse(readFileSync("public/samples/manifest.json", "utf8"));
const genres = Object.fromEntries(["funk", "blues-rock", "jazz"].map((g) => [g, JSON.parse(readFileSync(`../genres/${g}.json`, "utf8"))]));
console.log("Sample budget (default lineups, must stay under 10 MB):");
for (const [id, g] of Object.entries(genres)) {
  const ids = Object.values(g.band).map((s) => (typeof s === "string" ? s : s.instrument));
  const mb = ids.reduce((n, i) => n + manifest.instruments[i].bytes, manifest.instruments.piano.bytes) / 1e6;
  console.log(`  ${id}: ${ids.join(", ")} + piano for you = ${mb.toFixed(2)} MB`);
  if (mb >= 10) fail(`${id} default lineup is ${mb.toFixed(1)} MB`);
}
console.log(`  whole set: ${(manifest.bytes / 1e6).toFixed(2)} MB, ${Object.keys(manifest.instruments).length} instruments`);

if (clipsDir) mkdirSync(clipsDir, { recursive: true });
const results = [];
for (const job of JOBS) {
  const r = await page.evaluate(
    async ({ job, seconds, wantWav }) => {
      const { renderSong, wav } = await import("/src/render.ts");
      const t = performance.now();
      const out = await renderSong({ chart: job.chart, genre: job.genre, band: job.band, seconds, seed: 11, player: job.player, bandChanges: job.switches, synthOnly: job.synthOnly });
      const renderMs = performance.now() - t;
      const { left, right, rate } = out;
      let peak = 0, sum = 0, clipped = 0, nan = 0;
      const diffs = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) {
        const l = left[i], r = right[i];
        if (!Number.isFinite(l) || !Number.isFinite(r)) nan++;
        const a = Math.max(Math.abs(l), Math.abs(r));
        if (a > peak) peak = a;
        if (a >= 0.999) clipped++;
        sum += (l * l + r * r) / 2;
        diffs[i] = i ? Math.max(Math.abs(l - left[i - 1]), Math.abs(r - right[i - 1])) : 0;
      }
      // Loudest 3-second window (a rough short-term loudness).
      const win = rate * 3;
      let best = 0;
      for (let s = 0; s + win <= left.length; s += rate / 2) {
        let e = 0;
        for (let i = s; i < s + win; i += 4) e += (left[i] * left[i] + right[i] * right[i]) / 2;
        best = Math.max(best, e / (win / 4));
      }
      const sorted = Float32Array.from(diffs).sort();
      const p999 = sorted[Math.floor(sorted.length * 0.999)];
      // Clicks: the sharpest step within 40 ms of each instrument switch, against the whole clip's 99.9th percentile.
      const clicks = (job.switches ?? []).map((sw) => {
        const at = out.bars.find((b) => b.bar === sw.bar + out.bars[0].bar)?.time ?? out.bars[sw.bar]?.time;
        let m = 0;
        for (let i = Math.floor((at - 0.04) * rate); i < (at + 0.04) * rate; i++) m = Math.max(m, diffs[i] ?? 0);
        return { bar: sw.bar, at, step: m, ratio: m / p999 };
      });
      const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
      const res = {
        renderMs: Math.round(renderMs), loadMs: Math.round(out.loadMs), sampled: out.sampled,
        peakDb: db(peak), rmsDb: 10 * Math.log10(sum / left.length + 1e-12), loudestDb: 10 * Math.log10(best + 1e-12), clipped, nan, clicks,
        bars: out.bars.length,
      };
      if (wantWav) {
        const bytes = wav(left, right, rate);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        res.wav = btoa(bin);
      }
      return res;
    },
    { job, seconds, wantWav: !!clipsDir },
  );
  const want = new Set([...Object.values(job.band ?? job.chart.band ?? genres[job.genre].band).map((s) => (typeof s === "string" ? s : s.instrument)), ...(job.switches ?? []).flatMap((s) => Object.values(s.band).map((x) => x.instrument))]);
  console.log(
    `${job.name}: ${r.bars} bars in ${r.renderMs} ms (samples loaded in ${r.loadMs} ms), peak ${r.peakDb.toFixed(1)} dBFS, ` +
      `average ${r.rmsDb.toFixed(1)} dBFS, loudest 3 s ${r.loudestDb.toFixed(1)} dBFS${job.synthOnly ? " [synth only]" : `, sampled: ${r.sampled.join(", ")}`}`,
  );
  if (!job.synthOnly) for (const id of want) if (!r.sampled.includes(id)) fail(`${job.name}: ${id} didn't play from samples`);
  if (r.nan) fail(`${job.name}: ${r.nan} samples are NaN`);
  if (r.clipped) fail(`${job.name}: ${r.clipped} samples clip`);
  if (r.peakDb > -0.1) fail(`${job.name}: peak ${r.peakDb.toFixed(2)} dBFS`);
  if (r.loudestDb < -24 || r.loudestDb > -9) fail(`${job.name}: loudest 3 s at ${r.loudestDb.toFixed(1)} dBFS (want -24 to -9)`);
  for (const c of r.clicks) {
    console.log(`  switch at bar ${c.bar} (${c.at.toFixed(2)} s): sharpest step ${(c.ratio * 100).toFixed(0)}% of the clip's 99.9th percentile`);
    if (c.ratio > 1.5) fail(`${job.name}: possible click at the switch on bar ${c.bar}`);
  }
  if (clipsDir && r.wav) {
    const wavPath = join(clipsDir, `${job.name}.wav`);
    writeFileSync(wavPath, Buffer.from(r.wav, "base64"));
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wavPath, "-codec:a", "libmp3lame", "-b:a", "192k", join(clipsDir, `${job.name}.mp3`)]);
    execFileSync("rm", [wavPath]);
  }
  results.push({ name: job.name, ...r, wav: undefined });
}
if (errors.length) {
  for (const e of errors) fail(`page error: ${e}`);
}
await browser.close();
await server.close();
if (clipsDir) writeFileSync(join(clipsDir, "sound-check.json"), JSON.stringify(results, null, 1));
console.log(failed ? `${failed} check(s) failed` : "All sound checks passed.");
process.exit(failed ? 1 : 0);
