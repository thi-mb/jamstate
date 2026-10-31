// npm run dump -- [chart.json] [genre] [bars] [intensity]: print what the band plays, bar by bar.
import { readFileSync } from "node:fs";
import { loadChart } from "../src/core/chart";
import { Engine } from "../src/core/engine";
import { getGenre } from "../src/core/genres";

const [chartPath = "public/charts/night-shift.json", genre, bars = "8", intensity] = process.argv.slice(2);
const chart = loadChart(JSON.parse(readFileSync(chartPath, "utf8")));
const engine = new Engine(chart, { genre: genre ? getGenre(genre) : undefined, intensity: intensity ? Number(intensity) : undefined, countIn: chart.countIn, seed: 7 });
const name = (p: string, n: number) => p === "drums" ? `d${n}` : String(n);
for (let i = 0; i < Number(bars); i++) {
  const plan = engine.nextBar();
  if (!plan) break;
  console.log(`bar ${plan.bar} ${plan.kind} ${plan.section} ${plan.barInSection + 1}/${plan.sectionBars} ${plan.chords.join(" ")} level ${plan.level} swing ${plan.swing} ${plan.stingers.join(",")}`);
  for (const part of ["drums", "bass", "chords"]) {
    const evs = plan.events.filter((e) => e.part === part).sort((a, b) => a.start - b.start || a.note - b.note);
    console.log(`  ${part.padEnd(6)} ${evs.map((e) => `${e.start.toFixed(2)}:${name(part, e.note)}/${e.vel}`).join(" ")}`);
  }
}
