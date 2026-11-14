// npm run chords-browser
//
// The two chord front ends' cost in headless Chrome (v0.5, ADR-0024): the
// chroma per strum, and Basic Pitch per 2 s window on WebGL and on the CPU.
// Writes docs/eval/results/v0.5-chords/browser.json, which the chord eval's
// write-up includes.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return createRequire(join(root, "noop.js"))("playwright");
  }
}
const { chromium } = await loadPlaywright();

const here = new URL("./", import.meta.url);
const bundle = join(mkdtempSync(join(tmpdir(), "jamstate-chords-")), "bundle.js");
await build({ entryPoints: [new URL("chords-browser/entry.ts", here).pathname], bundle: true, format: "esm", outfile: bundle, logLevel: "warning" });
const model = new URL("../node_modules/@spotify/basic-pitch/model/", here);

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const page = await browser.newPage();
await page.route("http://chords.test/**", (r) => {
  const path = new URL(r.request().url()).pathname;
  if (path === "/") return r.fulfill({ contentType: "text/html", body: '<script type="module" src="/bundle.js"></script>' });
  if (path === "/bundle.js") return r.fulfill({ contentType: "text/javascript", body: readFileSync(bundle) });
  if (path.startsWith("/model/")) return r.fulfill({ body: readFileSync(new URL(path.slice(7), model)) });
  return r.fulfill({ status: 404 });
});
await page.goto("http://chords.test/");
await page.waitForFunction(() => window.run);
const result = { date: new Date().toISOString().slice(0, 10), chrome: browser.version(), ...(await page.evaluate(() => window.run())) };
await browser.close();
const out = new URL("../../docs/eval/results/v0.5-chords/", here);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("browser.json", out), JSON.stringify(result, null, 2) + "\n");
console.log(result);
