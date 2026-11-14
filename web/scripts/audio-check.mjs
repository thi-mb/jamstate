// npm run audio-check   (after npm run build)
//
// Drives the built page in headless Chrome with a rendered guitar take as
// the microphone (Chrome's fake capture device; v0.5): the take is on input 2
// of a two-channel device, like a guitar in a Scarlett Solo's instrument
// input. Jams with audio input and "keep the audio" on, then checks the
// recording (audio input, detected notes, the WAV and where each bar starts
// in it) and that it replays exactly; then that input 1 (silent) hears
// nothing. Exit code 1 when a check fails.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return createRequire(join(root, "noop.js"))("playwright");
  }
}
const { chromium } = await loadPlaywright();

const dir = mkdtempSync(join(tmpdir(), "jamstate-audio-"));
const wav = join(dir, "take.wav");
execFileSync("npx", ["vite-node", "scripts/guitar.ts", "sim", "public/charts/night-shift.json", "busy:8,silent:4,medium:8,silent:4", wav, "--channels", "2", "--on", "2", "--rate", "48000"], { stdio: "inherit" });

const PORT = 8797;
const server = spawn("python3", ["-m", "jamstate_server", "--port", String(PORT), "--static", resolve("dist"), "--no-jev", "--no-claude", "--sessions-dir", join(dir, "sessions")], {
  cwd: resolve("../server"),
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 1200));

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`],
});
const context = await browser.newContext({ acceptDownloads: true });
await context.grantPermissions(["microphone"]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const jam = async (seconds) => {
  await page.click("#start");
  await page.waitForFunction(() => !/ready|count-in/.test(document.querySelector("#section")?.textContent ?? ""), null, { timeout: 15000 });
  let energy = 0;
  for (let t = 0; t < seconds * 1000; t += 500) {
    energy = Math.max(energy, Number(((await page.textContent("#energy-num")) ?? "").replace(/[^0-9.]/g, "")) || 0);
    await page.waitForTimeout(500);
  }
  await page.click("#stop");
  return energy;
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => /Sounds ready/.test(document.querySelector("#sample-status")?.textContent ?? ""), null, { timeout: 20000 });
  await page.selectOption("#sim", "off");
  await page.selectOption("#leader-select", "rules");

  const devices = await page.$$eval("#audio-in option", (o) => o.map((x) => x.value).filter(Boolean));
  check(devices.length > 0, `audio inputs offered: ${devices.length}`);
  await page.selectOption("#audio-in", devices[0]);
  await page.waitForFunction(() => /channel/.test(document.querySelector("#audio-status")?.textContent ?? ""), null, { timeout: 10000 });
  check(true, `input open: ${await page.textContent("#audio-status")}`);
  await page.selectOption("#audio-channel", "2");
  await page.check("#keep-audio");
  check(!(await page.isHidden("#audio-meter")), "the level meter shows");

  const energy = await jam(24);
  check(energy > 0.2, `the band heard the guitar: peak energy ${energy}`);

  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  await page.click("#session-download");
  await page.waitForTimeout(1500);
  const json = downloads.find((d) => d.suggestedFilename().endsWith(".json"));
  const wavDl = downloads.find((d) => d.suggestedFilename().endsWith(".wav"));
  check(!!json && !!wavDl, `downloaded ${downloads.map((d) => d.suggestedFilename()).join(" and ")}`);
  const file = JSON.parse(readFileSync(await json.path(), "utf8"));
  const ons = file.player.filter((e) => e[2] > 0);
  check(file.input?.kind === "audio" && file.input.channel === "2" && !!file.input.calibration, `recorded as audio input: ${JSON.stringify({ ...file.input, calibration: undefined, audio: undefined })}`);
  check(ons.length > 40, `detected notes recorded: ${ons.length} (${ons.filter((e) => e[1] < 0).length} unpitched)`);
  const a = file.input?.audio;
  check(!!a && a.rate === 16000 && a.bar_starts.length === file.bars.length && a.file === wavDl?.suggestedFilename(), `the audio is referenced with ${a?.bar_starts.length} bar starts`);
  const wavBytes = wavDl ? statSync(await wavDl.path()).size : 0;
  const lastBar = a?.bar_starts.at(-1) ?? 0;
  check(wavBytes > 44 + (lastBar - 1) * 16000 * 2, `the WAV covers the jam: ${(wavBytes / 32000).toFixed(1)} s, last bar starts at ${lastBar.toFixed(1)} s`);

  await page.click("#session-check");
  await page.waitForFunction(() => /replay|differently|failed/.test(document.querySelector("#session-result")?.textContent ?? ""));
  const res = await page.textContent("#session-result");
  check(/replay exactly/.test(res ?? ""), `replay check: ${res}`);

  // Synced to the Spark with its audio.
  await page.click("#session-save");
  await page.waitForFunction(() => /Synced|Couldn't sync/.test(document.querySelector("#session-result")?.textContent ?? ""));
  const synced = await page.textContent("#session-result");
  check(/with its audio/.test(synced ?? ""), `sync: ${synced}`);

  // Input 1 is silent: no notes.
  await page.selectOption("#audio-channel", "1");
  await page.uncheck("#keep-audio");
  await jam(5);
  await page.click("#session-download");
  await page.waitForTimeout(1000);
  const quiet = JSON.parse(readFileSync(await downloads.filter((d) => d.suggestedFilename().endsWith(".json")).at(-1).path(), "utf8"));
  check(quiet.player.length === 0 && !quiet.input.audio, `input 1 (silent) heard nothing: ${quiet.player.length} events`);
} catch (e) {
  check(false, `page run: ${e.message}`);
}
const real = errors.filter((e) => !/api\/(health|relay)|status of 404/.test(e));
check(!real.length, `no page errors${real.length ? `: ${real.join(" | ")}` : ""}`);
await browser.close();
server.kill();
console.log(failed ? `${failed} check(s) failed` : "All audio checks passed.");
process.exit(failed ? 1 : 0);
