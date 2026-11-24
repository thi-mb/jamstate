// npm run latency-check
//
// How long the player's own notes take to get through the mix bus: an impulse
// into the player's strip, offline, timed at the output. Web Audio's
// compressors each look 6 ms ahead, so every one on the live path is felt.
// Fails if the player's path adds more than 2 ms.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return createRequire(join(root, "noop.js"))("playwright");
  }
}
const { chromium } = await loadPlaywright();
const server = await createServer({ server: { port: 5198, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage();
await page.route("**/api/**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
await page.goto("http://localhost:5198/");
const res = await page.evaluate(async () => {
  const { Mixer } = await import("/src/audio/mixer.ts");
  const { DEFAULT_MIX } = await import("/src/core/genre.ts");
  const out = {};
  for (const voice of ["player", "chords", "drums"]) {
    const rate = 48000;
    const ctx = new OfflineAudioContext(2, rate / 2, rate);
    const mixer = new Mixer(ctx);
    mixer.apply({ ...DEFAULT_MIX, reverb: { ...DEFAULT_MIX.reverb } }, {}, true);
    const buf = ctx.createBuffer(1, 64, rate);
    buf.getChannelData(0)[0] = 0.5;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(mixer.input(voice));
    src.start(0.1);
    const r = await ctx.startRendering();
    const d = r.getChannelData(0);
    let peak = 0;
    for (const x of d) peak = Math.max(peak, Math.abs(x));
    let first = -1;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak * 0.1) { first = i; break; }
    out[voice] = (first / rate - 0.1) * 1000;
  }
  return out;
});
await browser.close();
await server.close();
let failed = false;
for (const [v, ms] of Object.entries(res)) console.log(`${v}: ${ms.toFixed(1)} ms through the mix`);
if (res.player > 2) {
  console.log(`FAIL the player's notes take ${res.player.toFixed(1)} ms to get through the mix (want ≤ 2 ms)`);
  failed = true;
} else console.log("Latency check passed.");
process.exit(failed ? 1 : 0);
