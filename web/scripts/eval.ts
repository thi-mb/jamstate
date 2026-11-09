// npm run eval -- [--brains rules,jev,claude,qwen,laya] [--seeds 3] [--only E1,E5] [--songs night-shift,...]
//                 [--out dir] [--label host] [--parallel 4] [--url U] [--model M] [--claude-model M] [--laya-url U]
//                 [--listening default|none|all|position,harmony,...] [--slots qwen=1,laya=1]
//
// The leader eval (docs/eval/scenarios.md). Every scenario runs on its songs,
// with each seed, for each brain: a pretend player plays and the brain leads
// the band through the real governor. Writes <out>/summary.md and
// <out>/results.json. Keys come from the environment (scripts/brains.ts).
//
// --slots caps the requests in flight per brain. Qwen and Laya run on a
// llama.cpp server with one slot, so they default to 1: the page never has
// more than one request in flight (ADR-0006), and with --parallel 4 the
// requests would queue at the server and the eval would time the queue.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrainProvider } from "../src/core/brain";
import type { ChartJSON } from "../src/core/chart";
import { ruleLeader, type Leader } from "../src/core/conductor";
import { runScenario, type RunResult } from "../src/core/eval/run";
import { judge, RunView, scenariosFor, scoreOf, SCENARIOS, type CheckResult, type ScenarioGroup, type Song } from "../src/core/eval/scenarios";
import { listeningKey, parseListening } from "../src/core/listening";
import { describeMove } from "../src/core/moves";
import { RuleLeader } from "../src/core/rules";
import { nodeBrain } from "./brains";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const brainNames = (opt("brains") ?? "rules").split(",").map((s) => s.trim()).filter(Boolean);
const seeds = Number(opt("seeds") ?? 3);
const only = opt("only")?.split(",");
const songFilter = opt("songs")?.split(",");
const out = opt("out") ?? "eval-out";
const host = opt("label") ?? "unlabelled host";
const parallel = Number(opt("parallel") ?? 4);
const TIMEOUT_MS = Number(opt("timeout") ?? 20_000);
const listening = parseListening(opt("listening") ?? "default");
const slots: Record<string, number> = { qwen: 1, laya: 1 };
for (const kv of (opt("slots") ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  slots[k.trim()] = Number(v);
}
const brainArgs = { url: opt("url"), model: opt("model"), claudeModel: opt("claude-model"), jevModel: opt("jev-model"), layaUrl: opt("laya-url") };

const SONGS: Song[] = ["night-shift", "blues-in-a", "late-set"]
  .filter((id) => !songFilter || songFilter.includes(id))
  .map((id) => {
    const chart = JSON.parse(readFileSync(new URL(`../public/charts/${id}.json`, import.meta.url), "utf8")) as ChartJSON;
    return { id, chart, genre: chart.genre ?? "funk" };
  });

interface Contender {
  name: string;
  leader(): Leader;
  everyBars(song: Song): number;
}

/** At most `n` callers inside at once; the rest wait their turn. */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(f: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((ok) => waiting.push(ok));
    active++;
    try {
      return await f();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Ask with a retry on rate limits and overload (429/529). */
async function askRetry(brain: BrainProvider, ctx: Parameters<BrainProvider["decide"]>[0]) {
  for (let i = 0, wait = 1000; ; i++, wait *= 2) {
    try {
      return await brain.decide(ctx, AbortSignal.timeout(TIMEOUT_MS));
    } catch (e) {
      if (i >= 3 || !/HTTP (429|529)/.test((e as Error).message)) throw e;
      await new Promise((ok) => setTimeout(ok, wait));
    }
  }
}

const contenders: Contender[] = [];
for (const name of brainNames) {
  if (name === "rules") {
    // As in the page: the rule leader every 2 bars, one per run (it keeps a mood).
    contenders.push({ name: "Rules", leader: () => ruleLeader(new RuleLeader()), everyBars: () => 2 });
    continue;
  }
  try {
    const brain = nodeBrain(name, brainArgs);
    // The brain times its own request, so waiting for a slot isn't counted.
    const inSlot = slots[name] > 0 ? limiter(slots[name]) : <T>(f: () => Promise<T>) => f();
    contenders.push({
      name: brain.label,
      leader: () => ({
        decide: async (ctx) => {
          const a = await inSlot(() => askRetry(brain, ctx));
          return { moves: a.moves, source: brain.kind, latencyMs: a.latencyMs };
        },
      }),
      everyBars: (s) => s.chart.phrase_bars ?? 4,
    });
  } catch (e) {
    console.warn(`skipping ${name}: ${(e as Error).message}`);
  }
}

interface RunRecord {
  brain: string;
  scenario: string;
  group: ScenarioGroup;
  song: string;
  genre: string;
  seed: number;
  score: number | null;
  checks: CheckResult[];
  targets: number[];
  moves: { bar: number; move: string; source: string; reason: string }[];
  turns: { bar: number; ms: number; error?: string; moves: string[] }[];
}

const jobs: (() => Promise<RunRecord>)[] = [];
for (const c of contenders)
  for (const song of SONGS)
    for (const { scenario, run } of scenariosFor(song, only))
      for (let seed = 1; seed <= seeds; seed++)
        jobs.push(async () => {
          const res: RunResult = await runScenario({ chart: song.chart, modes: run.modes, bars: run.bars, cues: run.cues, followTempo: run.followTempo, leader: c.leader(), everyBars: c.everyBars(song), seed, listening });
          const checks = judge(run, new RunView(res.plans, song.chart.bpm));
          return {
            brain: c.name,
            scenario: scenario.id,
            group: scenario.group,
            song: song.id,
            genre: song.genre,
            seed,
            score: scoreOf(checks),
            checks,
            targets: res.plans.map((p) => Math.round(p.target * 100) / 100),
            moves: res.plans.flatMap((p) => p.moves.filter((m) => m.status === "applied").map((m) => ({ bar: p.bar, move: m.label, source: m.source, reason: m.move.reason }))),
            turns: res.turns.map((t) => ({ bar: t.bar, ms: t.ms, error: t.error, moves: (t.reply?.moves ?? []).map((m) => describeMove(m as never)) })),
          };
        });

console.log(`${jobs.length} runs: ${contenders.map((c) => c.name).join(", ")} × ${SONGS.length} songs × ${seeds} seeds`);
const records: RunRecord[] = [];
let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: Math.max(1, parallel) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      records.push(await job());
      if (++done % 25 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length}`);
    }
  }),
);
records.sort((a, b) => `${a.brain}|${a.scenario}|${a.song}|${a.seed}`.localeCompare(`${b.brain}|${b.scenario}|${b.song}|${b.seed}`));

// ---------- report ----------

const mean = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const f2 = (x: number | null) => (x === null ? "–" : x.toFixed(2));
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const GROUPS: [ScenarioGroup, string][] = [["follow", "follow"], ["phrasing", "phrasing"], ["harmony_rhythm", "harmony & rhythm"], ["tempo", "tempo"], ["cues", "cues"]];
const groupsPresent = GROUPS.filter(([g]) => records.some((r) => r.group === g));
const genres = [...new Set(SONGS.map((s) => s.genre))];
const stretchOf = (rs: RunRecord[]) => {
  const st = rs.flatMap((r) => r.checks.filter((c) => c.kind === "stretch"));
  return st.length ? st.filter((c) => c.pass).length / st.length : null;
};

const L: string[] = [];
L.push(`# Leader eval`, ``, `${new Date().toISOString().slice(0, 16)}Z · ${records.length} runs · ${seeds} seeds · listening: ${listeningKey(listening)} · measured from: ${host}`, ``);
L.push(`Score: checks passed / checks over every run (stretch checks left out), mean over runs. Scenarios: [scenarios.md](../../scenarios.md).`, ``);
L.push(`| Brain | Score | ${groupsPresent.map(([, n]) => n).join(" | ")} | ${genres.join(" | ")} | Stretch | Turns | Errors | p50 ms | p95 ms |`);
L.push(`|---|---|${groupsPresent.map(() => "---").join("|")}|${genres.map(() => "---").join("|")}|---|---|---|---|---|`);
for (const c of contenders) {
  const rs = records.filter((r) => r.brain === c.name);
  const turns = rs.flatMap((r) => r.turns);
  const ms = turns.filter((t) => !t.error).map((t) => t.ms);
  L.push(
    `| ${c.name} | **${f2(mean(rs.map((r) => r.score)))}** | ${groupsPresent.map(([g]) => f2(mean(rs.filter((r) => r.group === g).map((r) => r.score)))).join(" | ")} | ${genres.map((g) => f2(mean(rs.filter((r) => r.genre === g).map((r) => r.score)))).join(" | ")} | ${f2(stretchOf(rs))} | ${turns.length} | ${turns.filter((t) => t.error).length} | ${pct(ms, 50) ?? "–"} | ${pct(ms, 95) ?? "–"} |`,
  );
}
L.push(``, `## Per scenario`, ``, `Mean score over seeds; stretch checks passed in brackets where a scenario has them.`, ``);
L.push(`| Scenario | Song | ${contenders.map((c) => c.name).join(" | ")} |`, `|---|---|${contenders.map(() => "---").join("|")}|`);
for (const s of SCENARIOS) {
  for (const song of SONGS) {
    const rs = records.filter((r) => r.scenario === s.id && r.song === song.id);
    if (!rs.length) continue;
    const cell = (b: string) => {
      const mine = rs.filter((r) => r.brain === b);
      const st = stretchOf(mine);
      return `${f2(mean(mine.map((r) => r.score)))}${st === null ? "" : ` (${f2(st)})`}`;
    };
    L.push(`| ${s.id} ${s.title} | ${song.id} | ${contenders.map((c) => cell(c.name)).join(" | ")} |`);
  }
}
L.push(``, `## Failed checks`, ``, `How often each check failed, per brain (runs failed / runs).`, ``);
for (const c of contenders) {
  const fails = new Map<string, { n: number; of: number }>();
  for (const r of records.filter((r) => r.brain === c.name))
    for (const ch of r.checks) {
      const k = `${r.scenario} ${r.song}: ${ch.kind === "must_not" ? "must not: " : ch.kind === "stretch" ? "stretch: " : ""}${ch.text}`;
      const e = fails.get(k) ?? { n: 0, of: 0 };
      e.of++;
      if (!ch.pass) e.n++;
      fails.set(k, e);
    }
  const rows = [...fails].filter(([, e]) => e.n).sort((a, b) => b[1].n / b[1].of - a[1].n / a[1].of);
  L.push(`**${c.name}**: ${rows.length ? "" : "nothing failed"}`, ``);
  for (const [k, e] of rows) L.push(`- ${k} (${e.n}/${e.of})`);
  L.push(``);
}
L.push(`## Where the band lands`, ``, `The value each check reads, mean over seeds, to tune thresholds by genre.`, ``);
L.push(`| Scenario | Check | Song | ${contenders.map((c) => c.name).join(" | ")} |`, `|---|---|---|${contenders.map(() => "---").join("|")}|`);
for (const s of SCENARIOS)
  for (const song of SONGS) {
    const rs = records.filter((r) => r.scenario === s.id && r.song === song.id);
    if (!rs.length) continue;
    rs[0].checks.forEach((ch, i) => {
      if (ch.observed === undefined) return;
      L.push(`| ${s.id} | ${ch.text} | ${song.id} | ${contenders.map((c) => f2(mean(rs.filter((r) => r.brain === c.name).map((r) => r.checks[i]?.observed)))).join(" | ")} |`);
    });
  }
const errs = records.flatMap((r) => r.turns.filter((t) => t.error).map((t) => `${r.brain} ${r.scenario} ${r.song} bar ${t.bar}: ${t.error}`));
if (errs.length) L.push(``, `## Errors`, ``, ...errs.slice(0, 20).map((e) => `- ${e}`));

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "summary.md"), L.join("\n") + "\n");
writeFileSync(join(out, "results.json"), JSON.stringify({ host, listening: listeningKey(listening), created: new Date().toISOString(), seeds, brains: contenders.map((c) => c.name), runs: records }));
console.log(`\n${L.slice(0, 12 + contenders.length).join("\n")}\n\nwrote ${out}/summary.md and results.json`);
