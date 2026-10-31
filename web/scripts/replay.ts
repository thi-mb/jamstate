// npm run replay -- <session.json> [--leader rules|openai|claude|jev] [--url http://127.0.0.1:8080/v1] [--model leader] [--bars N]
//
// Without --leader: replays the recorded session exactly and checks that every
// bar plays the same notes (exit code 1 if not). With --leader: keeps the
// player's notes and buttons, lets that brain decide again (through the same
// fallback wrapper as the page), and prints its moves next to the recorded
// ones. Keys come from the environment (see scripts/brains.ts).
import { readFileSync } from "node:fs";
import { BrainLeader } from "../src/core/brain";
import { ruleLeader, type Leader } from "../src/core/conductor";
import { RuleLeader } from "../src/core/rules";
import { checkSession, replaySession } from "../src/core/session";
import { nodeBrain } from "./brains";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const leaderKind = opt("leader");
const url = opt("url");
const model = opt("model");
const bars = opt("bars");
const [path] = args;
if (!path) {
  console.error("usage: npm run replay -- <session.json> [--leader rules|openai|claude|jev] [--url URL] [--model M] [--bars N]");
  process.exit(2);
}

const file = checkSession(JSON.parse(readFileSync(path, "utf8")));
console.log(`${file.title}: ${file.genre}, seed ${file.seed}, ${file.bars.length} bars, recorded ${file.created} with leader "${file.leader}"`);

let leader: Leader | undefined;
let every: number | undefined;
let errors = 0;
if (leaderKind === "rules") leader = ruleLeader(new RuleLeader());
else if (leaderKind) {
  const c = file.chart;
  const phraseBars = c.phrase_bars ?? 4;
  const phraseMs = (phraseBars * Number(c.time_sig.split("/")[0]) * 60_000) / c.bpm;
  every = phraseBars;
  leader = new BrainLeader(nodeBrain(leaderKind, { url, model }), new RuleLeader(), {
    timeoutMs: Math.max(phraseMs, 4000),
    onAnswer: (ctx, a, err, ms) => {
      if (err) {
        errors++;
        console.log(`  bar ${ctx.bar}: error after ${ms} ms: ${err}`);
      } else if (a?.rejected.length) console.log(`  bar ${ctx.bar}: rejected ${a.rejected.map((r) => r.error).join("; ")}`);
    },
  });
}

const r = await replaySession(file, { leader, everyBars: every, bars: bars ? Number(bars) : undefined });
if (!leader) {
  if (r.mismatches.length) {
    console.log(`${r.mismatches.length} of ${r.bars.length} bars differ from the recording:`);
    for (const m of r.mismatches.slice(0, 20)) console.log(`  bar ${m.bar}: recorded ${m.expected}, replayed ${m.got}`);
    process.exit(1);
  }
  console.log(`All ${r.bars.length} bars match the recording.`);
} else {
  console.log(`${leaderKind} leader took ${r.decisions} turns${errors ? `, ${errors} failed` : ""}. Moves per bar (recorded | replayed):`);
  for (const [i, b] of r.bars.entries()) {
    const rec = file.bars[i]?.moves ?? [];
    if (!rec.length && !b.moves.length) continue;
    console.log(`  ${String(b.bar).padStart(3)} ${b.section.padEnd(8)} ${rec.join(", ").padEnd(50)} | ${b.moves.join(", ")}`);
  }
  if (errors) process.exit(1);
}
