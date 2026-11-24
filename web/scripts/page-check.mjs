// npm run page-check   (after npm run build)
//
// Drives the built page in headless Chrome, served by the companion server: picks lineups, starts a jam with the pretend player,
// switches an instrument and drops a part while it plays, stops, and checks
// the recording (the lineup changes are in it and it replays exactly).
// Exit code 1 when a check fails.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

const PORT = 8798;
const server = spawn("python3", ["-m", "jamstate_server", "--port", String(PORT), "--static", resolve("dist"), "--no-jev", "--no-claude"], {
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
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const openTab = async (tab) => {
  if ((await page.getAttribute("#studio-toggle", "aria-expanded")) !== "true") await page.click("#studio-toggle");
  await page.click(`#studio-drawer [data-tab="${tab}"]`);
};
const closeDrawer = async () => {
  if ((await page.getAttribute("#studio-toggle", "aria-expanded")) === "true") await page.click("#studio-close");
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => document.querySelectorAll("#band-parts .band-part").length > 0);
  await page.waitForFunction(() => /Sounds ready/.test(document.querySelector("#sample-status")?.textContent ?? ""), null, { timeout: 20000 });
  check(true, `page loaded, ${await page.textContent("#sample-status")}`);

  // Stage-first: Studio drawer starts collapsed.
  check((await page.getAttribute("#studio-toggle", "aria-expanded")) === "false", "Studio drawer starts collapsed on Stage");

  // Night Shift (funk): its genre band.
  await openTab("song");
  const lineups = await page.$$eval("#lineup-select option", (o) => o.map((x) => x.textContent));
  check(lineups.includes("Funk band") && lineups.includes("Synth funk"), `funk lineups offered: ${lineups.join(" | ")}`);
  const rows = await page.$$eval("#band-parts .band-part", (r) => r.map((x) => `${x.querySelector("label")?.textContent}${x.classList.contains("out") ? " (out)" : ""}: ${x.querySelector("select")?.value}`));
  check(rows.length === 6, `six parts in the picker: ${rows.join(", ")}`);

  // Blues in A: the song's own band (electric bass, kit, organ, crunch guitar).
  await page.selectOption("#chart-select", "blues-in-a.json");
  await page.waitForFunction(() => document.querySelector("#lineup-select")?.value === "song");
  const blues = await page.$$eval("#band-parts .band-part:not(.out) select", (s) => s.map((x) => x.value));
  check(JSON.stringify(blues) === JSON.stringify(["kit", "electric", "organ", "crunch"]), `Blues in A uses the song's band: ${blues.join(", ")}`);

  // Jam with the pretend player.
  await openTab("setup");
  await page.selectOption("#sim", "medium");
  await openTab("leader");
  await page.selectOption("#leader-select", "rules");
  await closeDrawer();
  await page.click("#start");
  await page.waitForFunction(() => !/ready|count-in/.test(document.querySelector("#section")?.textContent ?? ""), null, { timeout: 15000 });
  const chips = await page.$$eval("#layers .chip", (c) => c.map((x) => x.textContent));
  check(chips.join(",") === "drums,bass,keys,guitar", `playing: ${chips.join(", ")}`);

  // v0.6 Stage: next-chord preview, beat dots, musician card mute/solo, cue toast.
  await page.waitForFunction(() => (document.querySelector("#next-chord")?.textContent ?? "–") !== "–", null, { timeout: 5000 });
  check((await page.textContent("#next-chord")) !== "–", `next chord preview shows: ${await page.textContent("#next-chord")}`);
  check((await page.$$eval("#beats .beat-dot", (b) => b.length)) === 4, "4 beat dots on Stage");
  const muteBtn = page.locator('#layers .musician-card[data-part="guitar"] .mc-mute');
  await muteBtn.click();
  check((await muteBtn.getAttribute("aria-pressed")) === "true", "musician card mute toggles on Stage");
  await muteBtn.click();
  await page.keyboard.press("4"); // Build cue
  await page.waitForFunction(() => !document.querySelector("#cue-toast")?.hidden, null, { timeout: 3000 });
  check(/Build/i.test((await page.textContent("#cue-toast")) ?? ""), `cue toast shown: ${await page.textContent("#cue-toast")}`);

  // Switch the keys to piano and drop the guitar, live.
  await openTab("song");
  const keys = page.locator("#band-parts .band-part").nth(2).locator("select");
  await keys.selectOption("piano");
  await page.locator("#band-parts .band-part").nth(3).locator("input[type=checkbox]").uncheck();
  await closeDrawer();
  await page.waitForTimeout(6000);
  const chips2 = await page.$$eval("#layers .chip", (c) => c.map((x) => x.textContent));
  check(chips2.join(",") === "drums,bass,keys", `after dropping the guitar: ${chips2.join(", ")}`);
  await openTab("song");
  check((await page.inputValue("#lineup-select")) === "custom", "the lineup shows as custom");
  check(/Sounds ready/.test((await page.textContent("#sample-status")) ?? ""), `piano loaded mid-song: ${await page.textContent("#sample-status")}`);

  await closeDrawer();
  await page.click("#stop");

  // v0.6 Post-jam Recap banner -> Recap view -> SVG timeline, MIDI & WAV exports.
  await page.waitForFunction(() => !document.querySelector("#recap-banner")?.hidden, null, { timeout: 5000 });
  await page.click("#recap-open-btn");
  await page.waitForFunction(() => !document.querySelector("#recap-view")?.hidden, null, { timeout: 5000 });
  const barHits = await page.$$eval("#recap-timeline .recap-bar-hit", (r) => r.length);
  check(barHits > 0, `Recap SVG timeline rendered ${barHits} clickable bars`);
  const [midDl] = await Promise.all([page.waitForEvent("download"), page.click("#recap-midi")]);
  check(midDl.suggestedFilename().endsWith(".mid") && readFileSync(await midDl.path()).subarray(0, 4).toString("ascii") === "MThd", `MIDI exported: ${midDl.suggestedFilename()}`);
  const [wavDl] = await Promise.all([page.waitForEvent("download"), page.click("#recap-wav")]);
  check(wavDl.suggestedFilename().endsWith(".wav") && readFileSync(await wavDl.path()).subarray(0, 4).toString("ascii") === "RIFF", `WAV mixdown exported: ${wavDl.suggestedFilename()}`);
  await page.click("#recap-back");

  await openTab("sessions");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#session-download")]);
  const file = JSON.parse(readFileSync(await download.path(), "utf8"));
  const bands = file.controls.filter((c) => c.kind === "band");
  check(file.band?.guitar === "crunch" && file.band?.chords === "organ", `the recording starts with the song's band: ${JSON.stringify(file.band)}`);
  check(bands.length === 2 && bands[0].band.chords.instrument === "piano" && !bands[1].band.guitar, `both lineup changes are recorded at bars ${bands.map((b) => b.at).join(", ")}`);
  const guitarAfter = file.bars.filter((b) => b.bar > bands[1].at + 1).every((b) => !b.layers.includes("guitar"));
  check(guitarAfter, "no guitar after it left the band");

  await page.click("#session-check");
  await page.waitForFunction(() => /replay|differently|failed/.test(document.querySelector("#session-result")?.textContent ?? ""));
  const res = await page.textContent("#session-result");
  check(/replay exactly/.test(res ?? ""), `replay check: ${res}`);

  // Genre switch brings its band.
  await openTab("song");
  await page.selectOption("#genre-select", "jazz");
  const jazz = await page.$$eval("#band-parts .band-part:not(.out) select", (s) => s.map((x) => x.value));
  check(JSON.stringify(jazz) === JSON.stringify(["brushes", "upright", "piano"]), `picking jazz brings the jazz band: ${jazz.join(", ")}`);

  // v0.4: personality, the arc line, trading fours on key 8 (Night Shift, still in jazz: the drums answer).
  await page.selectOption("#chart-select", "night-shift.json");
  await openTab("leader");
  await page.selectOption("#personality", "adventurous");
  await openTab("setup");
  await page.selectOption("#sim", "busy");
  await closeDrawer();
  await page.click("#start");
  await page.waitForFunction(() => !/ready|count-in/.test(document.querySelector("#section")?.textContent ?? ""), null, { timeout: 15000 });
  await page.keyboard.press("8");
  check((await page.getAttribute("#trade", "aria-pressed")) === "true", "key 8 turns trading on");
  // Play a turn, then lay out for one: the band should answer. The page reads the pretend player per bar.
  const seen = new Set();
  const watch = async (ms) => {
    for (let t = 0; t < ms; t += 250) {
      seen.add(await page.textContent("#feel"));
      await page.waitForTimeout(250);
    }
  };
  await watch(9000);
  await openTab("setup");
  await page.selectOption("#sim", "silent");
  await closeDrawer();
  await watch(9000);
  await openTab("setup");
  await page.selectOption("#sim", "busy");
  await closeDrawer();
  await watch(9000);
  const solos = [...seen].filter((f) => / solo \d\/\d/.test(f ?? ""));
  check(solos.length > 0, `a band instrument took a turn: ${solos.slice(0, 2).join(" | ") || [...seen].slice(-3).join(" | ")}`);
  const arc = await page.textContent("#arc");
  check(/^plan \((build|dynamic|locked)\): .+ · next /.test(arc ?? ""), `the arc line shows the plan: ${arc}`);
  await page.click("#stop");
  await openTab("sessions");
  const [download2] = await Promise.all([page.waitForEvent("download"), page.click("#session-download")]);
  const file2 = JSON.parse(readFileSync(await download2.path(), "utf8"));
  const kinds = file2.controls.map((c) => c.kind);
  check(file2.personality === "adventurous" && kinds.includes("trade") && kinds.includes("solo"), `the recording has the personality, the trade and the turns: ${file2.personality}, ${[...new Set(kinds)].join(", ")}`);
  await page.click("#session-check");
  await page.waitForFunction(() => /replay|differently|failed/.test(document.querySelector("#session-result")?.textContent ?? ""));
  const res2 = await page.textContent("#session-result");
  check(/replay exactly/.test(res2 ?? ""), `trading jam replay check: ${res2}`);
  await closeDrawer();
  await page.keyboard.press("8");
  await openTab("leader");
  await page.selectOption("#personality", "supportive");

  // v0.7: Song Creator (create custom song, edit chord, save & load on Stage, delete).
  await openTab("song");
  await page.click("#new-song-btn");
  await page.waitForFunction(() => !document.querySelector("#editor-view")?.hidden, null, { timeout: 5000 });
  await page.fill("#ed-title", "Custom Jam v0.7");
  await page.locator("#ed-sections .ed-chord-in").first().fill("Dm7");
  check((await page.locator("#ed-validation.ok").count()) === 1, `Song Creator live validation ok: ${await page.textContent("#ed-validation")}`);
  await page.click("#ed-use");
  await page.waitForFunction(() => document.querySelector("#editor-view")?.hidden && !document.querySelector("#stage")?.hidden, null, { timeout: 5000 });
  check(/Custom Jam v0\.7/.test((await page.textContent("#pill-song")) ?? ""), `custom song loaded on Stage: ${await page.textContent("#pill-song")}`);
  await openTab("song");
  const savedVal = await page.inputValue("#chart-select");
  check(savedVal.startsWith("saved:"), `custom song saved in #chart-select (${savedVal})`);
  await page.click("#delete-saved-song");
  await closeDrawer();

  // v0.7: Follow Me mode (start with pretend player, detect chord/key, lock loop, save as song).
  await openTab("setup");
  await page.selectOption("#sim", "medium");
  await closeDrawer();
  await page.click("#follow-me-btn");
  check((await page.getAttribute("#follow-me-btn", "aria-pressed")) === "true" && !(await page.isHidden("#follow-strip")), "Follow Me toggle reveals live strip");
  await page.click("#start");
  await page.waitForFunction(() => document.querySelector("#follow-phase")?.textContent === "FOLLOWING", null, { timeout: 15000 });
  check(true, `Follow Me latched & following: ${await page.textContent("#follow-status")}`);
  await page.waitForFunction(() => !(document.querySelector("#follow-lock-btn")?.disabled ?? true), null, { timeout: 15000 });
  await page.click("#follow-lock-btn");
  check((await page.textContent("#follow-phase")) === "LOCKED", "Follow Me Lock loop locks the progression");
  await page.click("#follow-save-btn");
  await page.waitForFunction(() => !document.querySelector("#editor-view")?.hidden, null, { timeout: 5000 });
  check((await page.locator("#ed-validation.ok").count()) === 1, `Follow Me Save as song opened valid chart: ${await page.inputValue("#ed-title")}`);
  await page.click("#ed-back");
} catch (e) {
  check(false, `page run: ${e.message}`);
}
const real = errors.filter((e) => !/api\/(health|relay)|status of 404/.test(e));
check(!real.length, `no page errors${real.length ? `: ${real.join(" | ")}` : ""}`);
await browser.close();
server.kill();
console.log(failed ? `${failed} check(s) failed` : "All page checks passed.");
process.exit(failed ? 1 : 0);
