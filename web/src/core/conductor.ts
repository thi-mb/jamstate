// Glue between player features, the bandleader and the engine. Every N bars
// it asks the leader for moves; the request is never awaited by the music,
// and at most one is in flight.

import type { BarPlan, Engine } from "./engine";
import { barFeatures, summarize, type BarFeatures, type PlayedNote, type PlayerSummary } from "./features";
import type { Move } from "./moves";
import type { LeaderContext } from "./rules";

export interface LeaderReply {
  moves: Move[] | unknown[];
  /** Who actually decided ("rules", "llm", "rules (llm down)") for the overlay. */
  source: string;
  latencyMs?: number;
}

export interface Leader {
  decide(ctx: LeaderContext): Promise<LeaderReply> | LeaderReply;
}

export interface ConductorEvents {
  onFeatures?(bar: number, f: BarFeatures): void;
  onDecision?(reply: LeaderReply, requestedBar: number): void;
  onSkip?(bar: number): void;
}

export class Conductor {
  private window: BarFeatures[] = [];
  private history: BarFeatures[] = [];
  private inFlight = false;
  private bars = 0;

  constructor(
    private engine: Engine,
    public leader: Leader | null,
    public everyBars = 4,
    private events: ConductorEvents = {},
  ) {}

  get busy(): boolean {
    return this.inFlight;
  }

  /** Call once a bar has finished sounding, with what the player played in it. */
  barFinished(plan: BarPlan, notes: PlayedNote[]): BarFeatures {
    const f = barFeatures(notes, this.engine.chart.beatsPerBar, this.history);
    this.history.push(f);
    if (this.history.length > 8) this.history.shift();
    this.window.push(f);
    if (this.window.length > this.everyBars) this.window.shift();
    this.events.onFeatures?.(plan.bar, f);
    this.bars++;
    if (this.leader && this.bars % this.everyBars === 0) this.ask(plan, summarize(this.window));
    return f;
  }

  context(plan: BarPlan, player: PlayerSummary): LeaderContext {
    const chart = this.engine.chart;
    return {
      bar: plan.bar,
      section: plan.section,
      bar_in_section: plan.barInSection,
      section_bars: plan.sectionBars,
      phrase_bars: chart.phraseBars,
      intensity: Math.round(plan.intensity * 100) / 100,
      target: Math.round(plan.target * 100) / 100,
      layers: plan.layers,
      feel: plan.feel,
      form: chart.form,
      form_pos: plan.formPos,
      sections: [...chart.sections.keys()],
      player,
      recent_moves: this.engine.log.filter((r) => r.status === "applied").slice(-4).map((r) => r.label),
    };
  }

  private ask(plan: BarPlan, player: PlayerSummary): void {
    if (this.inFlight) return void this.events.onSkip?.(plan.bar);
    const ctx = this.context(plan, player);
    const done = (reply: LeaderReply) => {
      this.inFlight = false;
      this.engine.submit(reply.moves, reply.source, plan.bar);
      this.events.onDecision?.(reply, plan.bar);
    };
    let result: Promise<LeaderReply> | LeaderReply;
    try {
      result = this.leader!.decide(ctx);
    } catch {
      return;
    }
    if (result instanceof Promise) {
      this.inFlight = true;
      result.then(done, () => (this.inFlight = false));
    } else done(result);
  }
}

/** Wrap the rule leader as a Leader. */
export function ruleLeader(rules: { decide(ctx: LeaderContext): Move[] }): Leader {
  return { decide: (ctx) => ({ moves: rules.decide(ctx), source: "rules" }) };
}
