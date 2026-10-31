// npm run bakeoff -- <session files or dirs...> [--brains rules,jev,claude,openai] [--out dir]
//                    [--url http://127.0.0.1:8080/v1] [--model leader] [--claude-model M] [--label host] [--rate 24]
//
// The brain bake-off (ADR-0016). For every session:
//   1. Same question: replay with the rule leader asked once per phrase and
//      keep each request; then every brain answers exactly those requests.
//      Gives latency per brain and side-by-side answers to blind-rate.
//   2. Closed loop: each brain drives its own replay of the session (the
//      player's notes are fixed, the band follows the brain). Scores how well
//      the band follows the player.
// Writes <out>/results.json, <out>/summary.md and <out>/rating.json (blind
// items: answers shuffled and labelled A, B, C...; the key is in results.json).
// Keys come from the environment (scripts/brains.ts). Latency is measured
// from wherever this runs: note the host with --label.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrainAnswer, type BrainProvider } from "../src/core/brain";
import type { Leader } from "../src/core/conductor";
import { describeMove, type Move } from "../src/core/moves";
import { rng } from "../src/core/rand";
import type { LeaderContext } from "../src/core/rules";
import { checkSession, replaySession, type SessionFile } from "../src/core/session";
import { nodeBrain } from "./brains";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const brainNames = (opt("brains") ?? "rules,jev").split(",").map((s) => s.trim()).filter(Boolean);
const out = opt("out") ?? "bakeoff";
const host = opt("label") ?? "unlabelled host";
const brainArgs = { url: opt("url"), model: opt("model"), claudeModel: opt("claude-model"), jevModel: opt("jev-model") };
const TIMEOUT_MS = Number(opt("timeout") ?? 20_000);
const RATE_N = Number(opt("rate") ?? 24);

const files: string[] = [];
for (const p of args) {
  if (statSync(p).isDirectory()) files.push(...readdirSync(p).filter((f) => f.endsWith(".json")).sort().map((f) => join(p, f)));
  else files.push(p);
}
if (!files.length) {
  console.error("usage: npm run bakeoff -- <sessions...> [--brains rules,jev,claude,openai] [--out dir] [--label host]");
  process.exit(2);
}

const brains: BrainProvider[] = [];
for (const name of brainNames) {
  try {
    brains.push(nodeBrain(name, brainArgs));
  } catch (e) {
    console.warn(`skipping ${name}: ${(e as Error).message}`);
  }
}

interface Turn {
  session: string;
  index: number;
  bar: number;
  brain: string;
  model?: string;
  latencyMs: number;
  error?: string;
  moves: Move[];
  rejected: number;
  late: boolean;
}

const phraseMs = (f: SessionFile) => ((f.chart.phrase_bars ?? 4) * Number(f.chart.time_sig.split("/")[0]) * 60_000) / f.chart.bpm;

async function ask(brain: BrainProvider, ctx: LeaderContext): Promise<{ answer?: BrainAnswer; error?: string; ms: number }> {
  const t0 = performance.now();
  try {
    const answer = await brain.decide(ctx, AbortSignal.timeout(TIMEOUT_MS));
    return { answer, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { error: (e as Error).message, ms: Math.round(performance.now() - t0) };
  }
}

/** Ask with a retry on rate limits and overload (429/529), as TypeSafe recommends. */
async function askRetry(brain: BrainProvider, ctx: LeaderContext) {
  let r = await ask(brain, ctx);
  for (let i = 0, wait = 1000; i < 3 && r.error && /HTTP (429|529)/.test(r.error); i++, wait *= 2) {
    await new Promise((ok) => setTimeout(ok, wait));
    r = await ask(brain, ctx);
  }
  return r;
}

/** A leader that records what it was asked and answers with a brain, no fallback. */
function recordingLeader(brain: BrainProvider, seen: { ctx: LeaderContext; answer?: BrainAnswer; error?: string; ms: number }[]): Leader {
  return {
    decide: async (ctx) => {
      const snap = structuredClone(ctx);
      const r = await askRetry(brain, snap);
      seen.push({ ctx: snap, ...r });
      return { moves: r.answer?.moves ?? [], source: brain.kind, latencyMs: r.ms };
    },
  };
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

interface LoopScore {
  session: string;
  brain: string;
  turns: number;
  errors: number;
  moves: number;
  /** Correlation between the player's energy in a phrase and the band's intensity one phrase later. */
  follow: number | null;
  /** Share of turns after 2+ silent bars where the band ends up at or below 0.3 by the next turn. */
  silentDrop: number | null;
  /** Share of busy phrases (energy >= 0.62) where the band ends up at or above 0.6 by the next turn. */
  busyLift: number | null;
}

const turns: Turn[] = [];
const loops: LoopScore[] = [];
const rating: { id: string; session: string; bar: number; situation: string; answers: Record<string, string[]> }[] = [];
const key: Record<string, Record<string, string>> = {};
const shuffle = rng(20261031);

const describeSituation = (c: LeaderContext) => {
  const p = c.player;
  const playing = p.silent_bars >= p.bars ? "stopped playing" : p.energy >= 0.62 ? "playing busy and loud" : p.energy < 0.3 ? "playing sparse and soft" : "playing a medium groove";
  return `Bar ${c.bar}, ${c.section} (bar ${c.bar_in_section + 1} of ${c.section_bars}). The player is ${playing} (energy ${p.energy.toFixed(2)}, ${p.trend}${p.silent_bars ? `, ${p.silent_bars} silent bars` : ""}). Band: intensity ${c.intensity.toFixed(2)}, ${c.layers.join("+") || "nobody"}, ${c.feel.replace("_", " ")} feel.`;
};

for (const path of files) {
  const f = checkSession(JSON.parse(readFileSync(path, "utf8")));
  const name = path.split("/").pop()!.replace(/\.json$/, "");
  const every = f.chart.phrase_bars ?? 4;
  const budget = phraseMs(f);
  console.log(`\n${name}: ${f.title}, ${f.bars.length} bars, phrase ${Math.round(budget)} ms`);

  // 1. Same question.
  const ref: { ctx: LeaderContext; ms: number }[] = [];
  const rules = nodeBrain("rules");
  await replaySession(f, { leader: recordingLeader(rules, ref), everyBars: every });
  const contexts = ref.map((r) => r.ctx);
  for (const brain of brains) {
    let errs = 0;
    for (const [i, ctx] of contexts.entries()) {
      // A fresh rules brain per turn would lose its mood; rules answers come from the reference run instead.
      const r = brain.kind === "rules" ? { answer: (await recordedRules(ref, i)), ms: ref[i].ms } : await askRetry(brain, ctx);
      if (r.error) errs++;
      turns.push({
        session: name, index: i, bar: ctx.bar, brain: brain.label, model: r.answer?.model, latencyMs: r.ms, error: r.error,
        moves: r.answer?.moves ?? [], rejected: r.answer?.rejected.length ?? 0, late: r.ms > budget,
      });
    }
    console.log(`  same-question ${brain.label}: ${contexts.length} turns, ${errs} errors`);
  }
  for (const [i, ctx] of contexts.entries()) {
    const id = `${name}#${i}`;
    const labels = brains.map((b) => b.label);
    for (let j = labels.length - 1; j > 0; j--) {
      const k = Math.floor(shuffle() * (j + 1));
      [labels[j], labels[k]] = [labels[k], labels[j]];
    }
    const answers: Record<string, string[]> = {};
    key[id] = {};
    labels.forEach((label, j) => {
      const letter = String.fromCharCode(65 + j);
      const t = turns.find((t) => t.session === name && t.index === i && t.brain === label)!;
      answers[letter] = t.error ? ["(no answer)"] : t.moves.length ? t.moves.map((m) => `${describeMove(m)}: "${m.reason}"`) : ["keep going"];
      key[id][letter] = label;
    });
    rating.push({ id, session: name, bar: ctx.bar, situation: describeSituation(ctx), answers });
  }

  // 2. Closed loop.
  for (const brain of brains) {
    const seen: { ctx: LeaderContext; answer?: BrainAnswer; error?: string; ms: number }[] = [];
    const leader = brain.kind === "rules" ? recordingLeader(nodeBrain("rules"), seen) : recordingLeader(brain, seen);
    await replaySession(f, { leader, everyBars: every });
    const energy = seen.slice(0, -1).map((s) => s.ctx.player.energy);
    const next = seen.slice(1).map((s) => s.ctx.target);
    const silentIdx = seen.slice(0, -1).flatMap((s, i) => (s.ctx.player.silent_bars >= 2 ? [i] : []));
    const busyIdx = seen.slice(0, -1).flatMap((s, i) => (s.ctx.player.energy >= 0.62 ? [i] : []));
    const share = (idx: number[], ok: (i: number) => boolean) => (idx.length ? idx.filter(ok).length / idx.length : null);
    loops.push({
      session: name,
      brain: brain.label,
      turns: seen.length,
      errors: seen.filter((s) => s.error).length,
      moves: seen.reduce((n, s) => n + (s.answer?.moves.length ?? 0), 0),
      follow: pearson(energy, next),
      silentDrop: share(silentIdx, (i) => seen[i + 1].ctx.target <= 0.3),
      busyLift: share(busyIdx, (i) => seen[i + 1].ctx.target >= 0.6),
    });
  }
}

/** The rule leader's answer for reference turn i (it kept its mood across the run). */
async function recordedRules(ref: { ctx: LeaderContext; answer?: BrainAnswer }[], i: number): Promise<BrainAnswer> {
  return ref[i].answer ?? { moves: [], rejected: [], latencyMs: 0 };
}

// ---------- report ----------

mkdirSync(out, { recursive: true });
const fmt = (x: number | null, d = 2) => (x === null || Number.isNaN(x) ? "–" : x.toFixed(d));
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const lines: string[] = [];
lines.push(`# Brain bake-off`, ``, `${new Date().toISOString().slice(0, 16)}Z · ${files.length} sessions · measured from: ${host}`, ``);
lines.push(`## Latency and validity (same questions)`, ``);
lines.push(`| Brain | Model | Turns | Errors | p50 ms | p95 ms | max ms | Late (> 1 phrase) | Moves/turn | Rejected |`, `|---|---|---|---|---|---|---|---|---|---|`);
for (const b of brains) {
  const ts = turns.filter((t) => t.brain === b.label);
  const ok = ts.filter((t) => !t.error);
  const ms = ok.map((t) => t.latencyMs);
  const models = [...new Set(ok.map((t) => t.model).filter(Boolean))].join(", ");
  lines.push(`| ${b.label} | ${models || "–"} | ${ts.length} | ${ts.length - ok.length} | ${fmt(pct(ms, 50), 0)} | ${fmt(pct(ms, 95), 0)} | ${fmt(ms.length ? Math.max(...ms) : NaN, 0)} | ${ok.filter((t) => t.late).length} | ${fmt(ok.reduce((n, t) => n + t.moves.length, 0) / Math.max(1, ok.length))} | ${ts.reduce((n, t) => n + t.rejected, 0)} |`);
}
lines.push(``, `## Move mix (same questions)`, ``, `| Brain | ${["set_intensity", "add_layer", "drop_layer", "change_feel", "fire_stinger", "extend_section", "jump_to_section", "keep going"].join(" | ")} |`, `|---|---|---|---|---|---|---|---|---|`);
for (const b of brains) {
  const ts = turns.filter((t) => t.brain === b.label && !t.error);
  const count = (k: string) => ts.reduce((n, t) => n + t.moves.filter((m) => m.move === k).length, 0);
  lines.push(`| ${b.label} | ${["set_intensity", "add_layer", "drop_layer", "change_feel", "fire_stinger", "extend_section", "jump_to_section"].map(count).join(" | ")} | ${ts.filter((t) => !t.moves.length).length} |`);
}
lines.push(``, `## Following the player (closed loop)`, ``);
lines.push(`Each brain drives its own replay. **follow**: correlation of the player's energy in a phrase with the band's intensity target one phrase later (1 = follows perfectly). **silent→drop**: after 2+ silent bars, the band is at or below 0.3 by the next turn. **busy→lift**: after a busy phrase, the band is at or above 0.6 by the next turn.`, ``);
lines.push(`| Brain | follow | silent→drop | busy→lift | moves | errors |`, `|---|---|---|---|---|---|`);
for (const b of brains) {
  const ls = loops.filter((l) => l.brain === b.label);
  lines.push(`| ${b.label} | ${fmt(mean(ls.map((l) => l.follow)))} | ${fmt(mean(ls.map((l) => l.silentDrop)))} | ${fmt(mean(ls.map((l) => l.busyLift)))} | ${ls.reduce((n, l) => n + l.moves, 0)} | ${ls.reduce((n, l) => n + l.errors, 0)} |`);
}
lines.push(``, `### Per session`, ``, `| Session | ${brains.map((b) => b.label).join(" | ")} |`, `|---|${brains.map(() => "---").join("|")}|`);
for (const s of [...new Set(loops.map((l) => l.session))]) {
  lines.push(`| ${s} | ${brains.map((b) => { const l = loops.find((x) => x.session === s && x.brain === b.label); return l ? `${fmt(l.follow)} / ${fmt(l.silentDrop)} / ${fmt(l.busyLift)}` : "–"; }).join(" | ")} |`);
}
lines.push(``, `Cells: follow / silent→drop / busy→lift.`, ``);
const errs = turns.filter((t) => t.error);
if (errs.length) {
  lines.push(`## Errors`, ``);
  for (const e of errs.slice(0, 20)) lines.push(`- ${e.brain} ${e.session} bar ${e.bar}: ${e.error}`);
}
writeFileSync(join(out, "summary.md"), lines.join("\n") + "\n");
writeFileSync(join(out, "results.json"), JSON.stringify({ host, created: new Date().toISOString(), brains: brains.map((b) => b.label), turns, loops, key }, null, 1));
// Blind items: only turns where the brains disagree, shuffled, at most --rate (default 24).
const differ = rating.filter((r) => new Set(Object.values(r.answers).map((a) => a.join("|"))).size > 1);
for (let j = differ.length - 1; j > 0; j--) {
  const k = Math.floor(shuffle() * (j + 1));
  [differ[j], differ[k]] = [differ[k], differ[j]];
}
const toRate = differ.slice(0, RATE_N);
writeFileSync(join(out, "rating.json"), JSON.stringify(toRate, null, 1));
console.log(`\n${lines.join("\n")}\nwrote ${out}/summary.md, results.json, rating.json (${toRate.length} blind items of ${differ.length} where brains disagree)`);
