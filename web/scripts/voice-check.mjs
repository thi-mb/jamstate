// npm run voice-check   (after npm run fetch-models and npm run build; needs PIPER)
//
// Voice cues in the built page (v0.5, ADR-0026), in headless Chrome with a
// two-channel fake input like a Scarlett Solo: a guitar on input 2 and a
// synthesised voice on input 1 saying cues and table talk. The guitar is
// the audio input, the voice the voice-cue input. Checks that the speech
// model loads, that each cue said is recorded once and marked as said, that
// "trade fours" turns trading on, and that the talk gives no cue. Then
// everything on at once (chords, the bleed gate on both inputs, voice cues):
// the main thread's time on the inputs per second of audio, and no note of
// the band's played late (v0.5 row 11). Exit code 1 when a check fails.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

if (!existsSync("dist/models/vosk-model-small-en-us-0.15.tar.gz")) {
  console.error("No speech model in dist/: npm run fetch-models, then npm run build.");
  process.exit(2);
}
const SAID = "8:take it down,16:that sounds great,24:trade fours,32:one more chorus,40:what key is this in";
const dir = mkdtempSync(join(tmpdir(), "jamstate-voice-"));
const wav = join(dir, "take.wav");
execFileSync("npx", ["vite-node", "scripts/guitar.ts", "sim", "public/charts/night-shift.json", "medium:24", wav, "--channels", "2", "--on", "2", "--rate", "48000", "--voice", SAID], { stdio: "inherit" });

const PORT = 8798;
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
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`],
});
const context = await browser.newContext({ acceptDownloads: true });
await context.grantPermissions(["microphone"]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const notes = [];
await page.exposeFunction("voiceNote", (t) => notes.push(t));

const openTab = async (tab) => {
  if ((await page.getAttribute("#studio-toggle", "aria-expanded")) !== "true") await page.click("#studio-toggle");
  await page.click(`#studio-drawer [data-tab="${tab}"]`);
};
const closeDrawer = async () => {
  if ((await page.getAttribute("#studio-toggle", "aria-expanded")) === "true") await page.click("#studio-close");
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => /Sounds ready/.test(document.querySelector("#sample-status")?.textContent ?? ""), null, { timeout: 20000 });
  await openTab("setup");
  await page.selectOption("#sim", "off");
  await openTab("leader");
  await page.selectOption("#leader-select", "rules");
  await closeDrawer();
  if ((await page.getAttribute("#trade", "aria-pressed")) === "true") await page.click("#trade");
  // Everything the page notes (cues, voice status) is collected.
  await page.evaluate(() => {
    for (const id of ["voice-status"]) new MutationObserver(() => window.voiceNote(document.getElementById(id).textContent)).observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
  });

  await openTab("setup");
  const devices = await page.$$eval("#voice-in option", (o) => o.map((x) => x.value).filter(Boolean));
  check(devices.length > 0, `voice inputs offered: ${devices.length}`);
  await page.selectOption("#audio-in", devices[0]);
  await page.waitForFunction(() => /channel/.test(document.querySelector("#audio-status")?.textContent ?? ""), null, { timeout: 10000 });
  await page.selectOption("#audio-channel", "2");
  const t0 = Date.now();
  await page.selectOption("#voice-in", devices[0]);
  await page.waitForFunction(() => /Listening|Couldn't/.test(document.querySelector("#voice-status")?.textContent ?? ""), null, { timeout: 60000 });
  const status = await page.textContent("#voice-status");
  check(/Listening/.test(status ?? ""), `speech model loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${status}`);
  await page.selectOption("#voice-channel", "1");
  await closeDrawer();

  // The fake input loops its file from when it was opened; a jam long enough to hear every phrase once.
  await page.click("#start");
  await page.waitForTimeout(46000);
  await page.click("#stop");

  await openTab("sessions");
  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  await page.click("#session-download");
  await page.waitForTimeout(1500);
  const json = downloads.find((d) => d.suggestedFilename().endsWith(".json"));
  const file = JSON.parse(readFileSync(await json.path(), "utf8"));
  const cues = file.controls.filter((c) => c.kind === "cue");
  const said = cues.filter((c) => c.by === "voice").map((c) => c.cue);
  const count = (c) => said.filter((x) => x === c).length;
  check(count("take_down") >= 1 && count("one_more") >= 1, `cues said were recorded as said: ${JSON.stringify(said)}`);
  check(said.length <= 3 && cues.length === said.length, `no other cues (the talk gave none): ${cues.length} in all`);
  const trade = file.controls.filter((c) => c.kind === "trade");
  check(trade.some((c) => c.on), `"trade fours" turned trading on: ${JSON.stringify(trade)}`);
  check(file.player.filter((e) => e[2] > 0).length > 10, "the guitar on input 2 still played the band");
  console.log(`voice status lines: ${[...new Set(notes)].filter((t) => /Heard/.test(t)).join(" | ") || "none"}`);

  await page.click("#session-check");
  await page.waitForFunction(() => /replay|differently|failed/.test(document.querySelector("#session-result")?.textContent ?? ""));
  const res = await page.textContent("#session-result");
  check(/replay exactly/.test(res ?? ""), `replay check: ${res}`);

  // Everything on: chords in auto, the gate on both inputs, voice cues.
  await openTab("setup");
  await page.check("#audio-gate");
  await page.check("#voice-gate");
  await closeDrawer();
  const before = await page.evaluate(() => structuredClone(window.jamstateStats()));
  await page.click("#start");
  await page.waitForTimeout(30000);
  const after = await page.evaluate(() => structuredClone(window.jamstateStats()));
  await page.click("#stop");
  const per = (k) => (after[k].dsp - before[k].dsp) / Math.max(1e-9, after[k].audio - before[k].audio);
  check(per("input") < 0.1, `guitar input (gate, listener) on the main thread: ${per("input").toFixed(4)} s per second of audio`);
  check(per("voice") < 0.05, `voice input (gate, hand-off to the recogniser's worker): ${per("voice").toFixed(4)} s per second of audio`);
  check(after.late && after.late.notes === 0, `band notes played late with everything on: ${after.late?.notes} (worst ${Math.round((after.late?.worst ?? 0) * 1000)} ms)`);
} catch (e) {
  check(false, `page run: ${e.message}`);
}
const real = errors.filter((e) => !/api\/(health|relay)|status of 404/.test(e));
check(!real.length, `no page errors${real.length ? `: ${real.join(" | ")}` : ""}`);
await browser.close();
server.kill();
console.log(failed ? `${failed} check(s) failed` : "All voice checks passed.");
process.exit(failed ? 1 : 0);
