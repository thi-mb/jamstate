// npm run simulate -- [chart.json] [script]
// e.g. npm run simulate -- public/charts/night-shift.json "sparse:8,busy:8,silent:8"
import { readFileSync } from "node:fs";
import { loadChart } from "../src/core/chart";
import { DEMO_SCRIPT, parseScript } from "../src/core/simplayer";
import { formatSim, simulate } from "../src/core/simulate";

const [chartPath = "public/charts/night-shift.json", script = DEMO_SCRIPT] = process.argv.slice(2);
const chart = loadChart(JSON.parse(readFileSync(chartPath, "utf8")));
const modes = parseScript(script);
console.log(`${chart.title}: ${chart.bpm} bpm, ${chart.beatsPerBar}/4, player script "${script}"\n`);
console.log(formatSim(simulate(chart, modes, { config: { loop: true } })));
