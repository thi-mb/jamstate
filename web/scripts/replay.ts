// npm run replay -- <session.json> [--leader rules|llm] [--server http://127.0.0.1:8765] [--bars N]
//
// Without --leader: replays the recorded session exactly and checks that every
// bar plays the same notes (exit code 1 if not). With --leader: keeps the
// player's notes and buttons, lets that leader decide again, and prints its
// moves next to the recorded ones.
import { readFileSync } from "node:fs";
import { ruleLeader, type Leader } from "../src/core/conductor";
import { RuleLeader } from "../src/core/rules";
import { checkSession, replaySession } from "../src/core/session";
import { RemoteLeader } from "../src/leader/remote";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const leaderKind = opt("leader");
const server = opt("server") ?? "http://127.0.0.1:8765";
const bars = opt("bars");
const [path] = args;
if (!path) {
  console.error("usage: npm run replay -- <session.json> [--leader rules|llm] [--server URL] [--bars N]");
  process.exit(2);
}

const file = checkSession(JSON.parse(readFileSync(path, "utf8")));
console.log(`${file.title}: ${file.genre}, seed ${file.seed}, ${file.bars.length} bars, recorded ${file.created} with leader "${file.leader}"`);

let leader: Leader | undefined;
if (leaderKind === "rules") leader = ruleLeader(new RuleLeader());
else if (leaderKind === "llm") {
  const c = file.chart;
  const phraseMs = ((c.phrase_bars ?? 4) * Number(c.time_sig.split("/")[0]) * 60_000) / c.bpm;
  leader = new RemoteLeader(new RuleLeader(), { endpoint: `${server.replace(/\/$/, "")}/api/leader`, timeoutMs: Math.max(phraseMs, 4000) });
} else if (leaderKind) {
  console.error(`unknown leader "${leaderKind}" (rules or llm)`);
  process.exit(2);
}

const r = await replaySession(file, { leader, bars: bars ? Number(bars) : undefined });
if (!leader) {
  if (r.mismatches.length) {
    console.log(`${r.mismatches.length} of ${r.bars.length} bars differ from the recording:`);
    for (const m of r.mismatches.slice(0, 20)) console.log(`  bar ${m.bar}: recorded ${m.expected}, replayed ${m.got}`);
    process.exit(1);
  }
  console.log(`All ${r.bars.length} bars match the recording.`);
} else {
  console.log(`${leaderKind} leader took ${r.decisions} turns. Moves per bar (recorded | replayed):`);
  for (const [i, b] of r.bars.entries()) {
    const rec = file.bars[i]?.moves ?? [];
    if (!rec.length && !b.moves.length) continue;
    console.log(`  ${String(b.bar).padStart(3)} ${b.section.padEnd(8)} ${rec.join(", ").padEnd(50)} | ${b.moves.join(", ")}`);
  }
}
