// npm run page-check   (after npm run build)
//
// Drives the built page in headless Chrome, served by the companion server
// like on the Spark: picks lineups, starts a jam with the pretend player,
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

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => document.querySelectorAll("#band-parts .band-part").length > 0);
  await page.waitForFunction(() => /Sounds ready/.test(document.querySelector("#sample-status")?.textContent ?? ""), null, { timeout: 20000 });
  check(true, `page loaded, ${await page.textContent("#sample-status")}`);

  // Night Shift (funk): its genre band.
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
  await page.selectOption("#sim", "medium");
  await page.selectOption("#leader-select", "rules");
  await page.click("#start");
  await page.waitForFunction(() => !/ready|count-in/.test(document.querySelector("#section")?.textContent ?? ""), null, { timeout: 15000 });
  const chips = await page.$$eval("#layers .chip", (c) => c.map((x) => x.textContent));
  check(chips.join(",") === "drums,bass,keys,guitar", `playing: ${chips.join(", ")}`);

  // Switch the keys to piano and drop the guitar, live.
  const keys = page.locator("#band-parts .band-part").nth(2).locator("select");
  await keys.selectOption("piano");
  await page.locator("#band-parts .band-part").nth(3).locator("input[type=checkbox]").uncheck();
  await page.waitForTimeout(6000);
  const chips2 = await page.$$eval("#layers .chip", (c) => c.map((x) => x.textContent));
  check(chips2.join(",") === "drums,bass,keys", `after dropping the guitar: ${chips2.join(", ")}`);
  check((await page.inputValue("#lineup-select")) === "custom", "the lineup shows as custom");
  check(/Sounds ready/.test((await page.textContent("#sample-status")) ?? ""), `piano loaded mid-song: ${await page.textContent("#sample-status")}`);

  await page.click("#stop");
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
  await page.selectOption("#genre-select", "jazz");
  const jazz = await page.$$eval("#band-parts .band-part:not(.out) select", (s) => s.map((x) => x.value));
  check(JSON.stringify(jazz) === JSON.stringify(["brushes", "upright", "piano"]), `picking jazz brings the jazz band: ${jazz.join(", ")}`);

  // v0.4: personality, the arc line, trading fours on key 8 (Night Shift, still in jazz: the drums answer).
  await page.selectOption("#chart-select", "night-shift.json");
  await page.selectOption("#personality", "adventurous");
  await page.selectOption("#sim", "busy");
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
  await page.selectOption("#sim", "silent");
  await watch(9000);
  await page.selectOption("#sim", "busy");
  await watch(9000);
  const solos = [...seen].filter((f) => / solo \d\/\d/.test(f ?? ""));
  check(solos.length > 0, `a band instrument took a turn: ${solos.slice(0, 2).join(" | ") || [...seen].slice(-3).join(" | ")}`);
  const arc = await page.textContent("#arc");
  check(/^plan \((build|dynamic|locked)\): .+ · next /.test(arc ?? ""), `the arc line shows the plan: ${arc}`);
  await page.click("#stop");
  const [download2] = await Promise.all([page.waitForEvent("download"), page.click("#session-download")]);
  const file2 = JSON.parse(readFileSync(await download2.path(), "utf8"));
  const kinds = file2.controls.map((c) => c.kind);
  check(file2.personality === "adventurous" && kinds.includes("trade") && kinds.includes("solo"), `the recording has the personality, the trade and the turns: ${file2.personality}, ${[...new Set(kinds)].join(", ")}`);
  await page.click("#session-check");
  await page.waitForFunction(() => /replay|differently|failed/.test(document.querySelector("#session-result")?.textContent ?? ""));
  const res2 = await page.textContent("#session-result");
  check(/replay exactly/.test(res2 ?? ""), `trading jam replay check: ${res2}`);
  await page.keyboard.press("8");
  await page.selectOption("#personality", "supportive");
} catch (e) {
  check(false, `page run: ${e.message}`);
}
const real = errors.filter((e) => !/api\/(health|relay)|status of 404/.test(e));
check(!real.length, `no page errors${real.length ? `: ${real.join(" | ")}` : ""}`);
await browser.close();
server.kill();
console.log(failed ? `${failed} check(s) failed` : "All page checks passed.");
process.exit(failed ? 1 : 0);
