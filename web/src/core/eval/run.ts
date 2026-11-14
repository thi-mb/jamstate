// One eval run: a scripted pretend player plays a song and a leader leads
// the band through the real conductor and governor, with no clock. Like the
// bake-off's closed loop, but the player is generated bar by bar from the
// band's state (so a player can drift against the band's tempo), and every
// leader turn is kept for the report. Docs: docs/eval/scenarios.md.

import { loadChart, type ChartJSON } from "../chart";
import { Conductor, type Leader, type LeaderReply } from "../conductor";
import { Engine, type BarPlan, type Cue } from "../engine";
import { TempoFollower } from "../tempo";
import { NoteTracker } from "../features";
import { getGenre } from "../genres";
import { DEFAULT_PERSONALITY, type Personality } from "../leading";
import { DEFAULT_LISTENING, type Listening } from "../listening";
import { Trader } from "../trade";
import type { LeaderContext } from "../rules";
import { SimPlayer, type SimMode } from "../simplayer";
import { GuitarEar } from "../audio/ear";
import type { SessionFile } from "../session";
import { jamBars } from "./jams";

export interface RunSpec {
  chart: ChartJSON;
  /** Pretend player's mode per bar (bar 0 = first bar of the song; no count-in). Shorter than `bars`: the last mode carries on. */
  modes: SimMode[];
  bars: number;
  leader: Leader | null;
  /** Leader cadence in bars: the page asks the rule leader every 2 bars and a brain every phrase. */
  everyBars: number;
  seed: number;
  /** Listening groups in the summary; the page's defaults when left out. */
  listening?: Listening;
  /** Cues pressed during a bar, before the bar after it is committed (as live: the deadline is its last beat). */
  cues?: { bar: number; cue: Cue }[];
  /** Follow my tempo on (the band follows the player's tempo drift). */
  followTempo?: boolean;
  /** The bandleader's personality (v0.4); supportive when left out. */
  personality?: Personality;
  /** Trading fours on from the start (v0.4). */
  trade?: boolean;
  /** Play the chart in another genre (same chart, another band and leader). */
  genre?: string;
  /** The player's notes rendered as a guitar and heard through the audio listener (v0.5), not as MIDI. */
  audio?: boolean;
  /** A recorded jam plays instead of the pretend player (v0.5): its notes bar by bar, whatever the band does. */
  jam?: SessionFile;
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
        // The brain's own request time when it reports one (the eval may hold a
        // request back for a free slot, which the page never does).
        turns.push({ bar: ctx.bar, ctx: snap, reply, ms: Math.round(reply.latencyMs ?? performance.now() - t0) });
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
  const engine = new Engine(chart, { seed: spec.seed, genre: getGenre(spec.genre ?? chart.genre), config: { loop: true }, countIn: 0, personality: spec.personality ?? DEFAULT_PERSONALITY });
  if (spec.trade) engine.setTrading(true);
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
  conductor.listening = { ...(spec.listening ?? DEFAULT_LISTENING) };
  if (spec.followTempo) conductor.follower = new TempoFollower(chart.bpm);
  conductor.trader = new Trader(engine);
  const sim = new SimPlayer(spec.seed & 0xffff);
  const tracker = new NoteTracker();
  const ear = spec.audio ? new GuitarEar(chart, spec.seed) : null;
  const jam = spec.jam ? jamBars(spec.jam) : null;
  const bpb = chart.beatsPerBar;
  const plans: BarPlan[] = [];
  const modeAt = (bar: number) => spec.modes[Math.min(bar, spec.modes.length - 1)];

  const commit = () => {
    if (plans.length >= spec.bars) return;
    const p = engine.nextBar();
    if (!p) return;
    plans.push(p);
    const start = p.bar * bpb;
    const notes = jam ? (jam[p.bar] ?? []) : sim.play(p, modeAt(p.bar), bpb, { bpm: p.bpm, chartBpm: chart.bpm, phraseBars: chart.phraseBars });
    if (ear) return ear.play(p, notes);
    for (const n of notes) {
      tracker.noteOn(start + n.start, n.note, n.vel);
      tracker.noteOff(start + n.start + n.dur, n.note);
    }
  };

  // As live: bar k+1 is committed before bar k ends, and a leader's answer
  // lands on the next bar not yet committed.
  commit();
  commit();
  for (let k = 0; k < plans.length; k++) {
    for (const e of ear?.hearUntilEndOf(k) ?? []) {
      if (e.kind === "on") tracker.noteOn(e.beat, e.note, e.vel);
      else tracker.noteOff(e.beat, e.note);
    }
    conductor.barFinished(plans[k], tracker.bar(k * bpb, bpb));
    if (pending) {
      await pending;
      await Promise.resolve();
      pending = null;
    }
    // Bar k+2 is committed next: cues pressed during bar k+1 go in first.
    for (const c of spec.cues ?? []) if (c.bar === k + 1) engine.cue(c.cue);
    commit();
  }
  return { plans, turns };
}
