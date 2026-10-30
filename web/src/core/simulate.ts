// Headless run of a whole jam, bar by bar, with no clock. Used by tests and
// `npm run simulate` to check how the band reacts to a scripted player.

import type { Chart } from "./chart";
import { Conductor, ruleLeader, type Leader } from "./conductor";
import { Engine, type BarPlan, type GovernorConfig } from "./engine";
import type { BarFeatures } from "./features";
import { RuleLeader } from "./rules";
import { SimPlayer, type SimMode } from "./simplayer";

export interface SimBar {
  plan: BarPlan;
  mode: SimMode;
  features: BarFeatures;
}

export function simulate(
  chart: Chart,
  script: SimMode[],
  opts: { leader?: Leader; everyBars?: number; config?: Partial<GovernorConfig>; seed?: number; maxBars?: number } = {},
): SimBar[] {
  const engine = new Engine(chart, { config: opts.config });
  const conductor = new Conductor(engine, opts.leader ?? ruleLeader(new RuleLeader()), opts.everyBars ?? 2);
  const player = new SimPlayer(opts.seed ?? 7);
  const out: SimBar[] = [];
  const maxBars = opts.maxBars ?? script.length;
  for (let i = 0; i < maxBars; i++) {
    const plan = engine.nextBar();
    if (!plan) break;
    const mode = script[Math.min(i, script.length - 1)] ?? "silent";
    const features = conductor.barFinished(plan, player.play(plan, mode, chart.beatsPerBar));
    out.push({ plan, mode, features });
  }
  return out;
}

/** One line per bar, plus a line per resolved move. */
export function formatSim(bars: SimBar[]): string {
  const lines: string[] = [];
  for (const { plan, mode, features } of bars) {
    const meter = "#".repeat(Math.round(plan.intensity * 10)).padEnd(10, ".");
    lines.push(
      `${String(plan.bar).padStart(3)} ${plan.section.padEnd(8)} ${String(plan.barInSection + 1).padStart(2)}/${String(plan.sectionBars).padEnd(2)} ` +
        `${plan.chords.join(" ").padEnd(8)} [${meter}] ${plan.layers.map((l) => l[0].toUpperCase()).join("").padEnd(3)} ${plan.feel.padEnd(11)} ` +
        `player=${mode.padEnd(6)} e=${features.energy.toFixed(2)}${plan.stingers.length ? "  !" + plan.stingers.join(",") : ""}`,
    );
    for (const m of plan.moves) lines.push(`      ${m.status.padEnd(8)} ${m.label} [${m.source}] ${m.move.reason ? `"${m.move.reason}"` : ""}${m.note ? ` (${m.note})` : ""}`);
  }
  return lines.join("\n");
}
