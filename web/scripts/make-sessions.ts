// npm run make-sessions -- <out dir>
// Records sessions from the pretend player (sparse, busy, silent stretches)
// over every bundled chart, for the bake-off when real recordings aren't at
// hand. Real jams from the page are better: they have a human in them.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChartJSON } from "../src/core/chart";
import { recordSimSession } from "../src/core/simsession";

const out = process.argv[2] ?? "sessions";
mkdirSync(out, { recursive: true });
const charts: { file: string; title: string }[] = JSON.parse(readFileSync("public/charts/index.json", "utf8"));
const SCRIPTS: Record<string, string> = {
  arc: "medium:8,sparse:8,busy:12,silent:6,busy:8,medium:6",
  slowburn: "sparse:12,medium:12,busy:16,medium:8",
  stopstart: "busy:8,silent:4,busy:8,silent:6,sparse:8,busy:6",
};
let n = 0;
for (const [ci, c] of charts.entries()) {
  const chart = JSON.parse(readFileSync(join("public/charts", c.file), "utf8")) as ChartJSON;
  for (const [si, [name, script]] of Object.entries(SCRIPTS).entries()) {
    const f = recordSimSession(chart, script, { seed: 101 + ci * 10 + si, title: `${chart.title} (${name})` });
    f.created = new Date(Date.UTC(2026, 9, 31, 12, ci, si)).toISOString();
    const path = join(out, `sim-${c.file.replace(/\.json$/, "")}-${name}.json`);
    writeFileSync(path, JSON.stringify(f));
    n++;
  }
}
console.log(`wrote ${n} sessions to ${out}`);
