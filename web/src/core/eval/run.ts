// One eval run: a scripted pretend player plays a song and a leader leads
// the band through the real conductor and governor, with no clock. Like the
// bake-off's closed loop, but the player is generated bar by bar from the
// band's state (so a player can drift against the band's tempo), and every
// leader turn is kept for the report. Docs: docs/eval/scenarios.md.

import { loadChart, type ChartJSON } from "../chart";
import { Conductor, type Leader, type LeaderReply } from "../conductor";
import { Engine, type BarPlan } from "../engine";
import { NoteTracker } from "../features";
import { getGenre } from "../genres";
import type { LeaderContext } from "../rules";
import { SimPlayer, type SimMode } from "../simplayer";

export interface RunSpec {
  chart: ChartJSON;
  /** Pretend player's mode per bar (bar 0 = first bar of the song; no count-in). Shorter than `bars`: the last mode carries on. */
  modes: SimMode[];
  bars: number;
  leader: Leader | null;
  /** Leader cadence in bars: the page asks the rule leader every 2 bars and a brain every phrase. */
  everyBars: number;
  seed: number;
}

export interface Turn {
  bar: number;
  ctx: LeaderContext;
  reply?: LeaderReply;
  error?: string;
  ms: number;
}

export interface RunResult {
  plans: BarPlan[];
  turns: Turn[];
}

/** Wraps a leader so every turn is kept, with its timing. */
function recording(leader: Leader, turns: Turn[]): Leader {
  return {
    decide: async (ctx) => {
      const snap = structuredClone(ctx);
      const t0 = performance.now();
      try {
        const reply = await leader.decide(snap);
        turns.push({ bar: ctx.bar, ctx: snap, reply, ms: Math.round(performance.now() - t0) });
        return reply;
      } catch (e) {
        turns.push({ bar: ctx.bar, ctx: snap, error: (e as Error).message, ms: Math.round(performance.now() - t0) });
        return { moves: [], source: "error" };
      }
    },
  };
}

export async function runScenario(spec: RunSpec): Promise<RunResult> {
  const chart = loadChart(spec.chart);
  const engine = new Engine(chart, { seed: spec.seed, genre: getGenre(chart.genre), config: { loop: true }, countIn: 0 });
  const turns: Turn[] = [];
  let pending: Promise<unknown> | null = null;
  const leader: Leader | null = spec.leader
    ? {
        decide: (ctx) => {
          const r = recording(spec.leader!, turns).decide(ctx) as Promise<LeaderReply>;
          pending = r;
          return r;
        },
      }
    : null;
  const conductor = new Conductor(engine, leader, spec.everyBars);
  const sim = new SimPlayer(spec.seed & 0xffff);
  const tracker = new NoteTracker();
  const bpb = chart.beatsPerBar;
  const plans: BarPlan[] = [];
  const modeAt = (bar: number) => spec.modes[Math.min(bar, spec.modes.length - 1)];

  const commit = () => {
    if (plans.length >= spec.bars) return;
    const p = engine.nextBar();
    if (!p) return;
    plans.push(p);
    const start = p.bar * bpb;
    for (const n of sim.play(p, modeAt(p.bar), bpb, { bpm: chart.bpm, chartBpm: chart.bpm, phraseBars: chart.phraseBars })) {
      tracker.noteOn(start + n.start, n.note, n.vel);
      tracker.noteOff(start + n.start + n.dur, n.note);
    }
  };

  // As live: bar k+1 is committed before bar k ends, and a leader's answer
  // lands on the next bar not yet committed.
  commit();
  commit();
  for (let k = 0; k < plans.length; k++) {
    conductor.barFinished(plans[k], tracker.bar(k * bpb, bpb));
    if (pending) {
      await pending;
      await Promise.resolve();
      pending = null;
    }
    commit();
  }
  return { plans, turns };
}
