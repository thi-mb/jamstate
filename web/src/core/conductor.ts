// Glue between player features, the bandleader and the engine. Every N bars
// it asks the leader for moves; the request is never awaited by the music,
// and at most one is in flight.

import { SongArc, type ArcSummary } from "./arc";
import type { BarPlan, Engine } from "./engine";
import { barFeatures, summarize, type BarFeatures, type PlayedNote, type PlayerSummary } from "./features";
import { getGenre } from "./genres";
import { avoids, followLevel } from "./leading";
import { TempoFollower } from "./tempo";
import type { Trader } from "./trade";
import { DEFAULT_LISTENING, dynamicsOf, harmonyOf, phrasingOf, rhythmOf, songPosition, type Heard, type HeardBar, type Listening } from "./listening";
import { PLAYER_ONLY_MOVES, type Move } from "./moves";
import type { LeaderContext } from "./rules";
import { parseChord } from "./theory";

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
  /** Everything the listening layer heard after a bar, whichever groups are on (for the overlay). */
  onHeard?(bar: number, heard: Heard): void;
}

export class Conductor {
  private window: BarFeatures[] = [];
  private history: BarFeatures[] = [];
  private inFlight = false;
  private bars = 0;
  /** The last bars with what the player played in them, for the listening layer. */
  private recent: HeardBar[] = [];
  /** Which listening groups go into the summary leaders read. */
  listening: Listening = { ...DEFAULT_LISTENING };
  /** Follow my tempo (v0.3, opt-in); null: the band keeps its tempo. */
  follower: TempoFollower | null = null;
  /** Trading fours (v0.4): starts and ends the band's turns; null when nobody is listening for it (a replay). */
  trader: Trader | null = null;
  /** The song so far, for the leader's plan (v0.4). */
  readonly arc: SongArc;

  constructor(
    private engine: Engine,
    public leader: Leader | null,
    public everyBars = 4,
    private events: ConductorEvents = {},
  ) {
    this.arc = new SongArc(engine.leading.arc, engine.chart.form);
  }

  get busy(): boolean {
    return this.inFlight;
  }

  /** Call once a bar has finished sounding, with what the player played in it. Count-in bars are skipped. */
  barFinished(plan: BarPlan, notes: PlayedNote[]): BarFeatures | null {
    if (plan.kind === "count_in") return null;
    const f = barFeatures(notes, this.engine.chart.beatsPerBar, this.history);
    this.history.push(f);
    if (this.history.length > 8) this.history.shift();
    this.window.push(f);
    this.recent.push({ plan, notes });
    if (this.recent.length > 8) this.recent.shift();
    if (this.window.length > this.everyBars) this.window.shift();
    // Follow my tempo: a new tempo lands on the next bar not yet committed.
    if (this.follower) this.engine.setTempo(this.follower.next(this.engine.bpm, this.recent.map((b) => b.notes), this.engine.chart.beatsPerBar));
    this.arc.observe(plan);
    this.trader?.barFinished(plan, notes);
    this.events.onFeatures?.(plan.bar, f);
    this.events.onHeard?.(plan.bar, this.heard(plan));
    this.bars++;
    if (this.leader && this.bars % this.everyBars === 0) this.ask(plan, summarize(this.window));
    return f;
  }

  /** The chord sounding at a beat of a played bar (live Follow Me chord or chart chord). */
  private chordAt = (plan: BarPlan, beat: number) => {
    if (plan.liveHarmony && plan.chords.length) {
      const bpb = this.engine.chart.beatsPerBar;
      const dur = bpb / plan.chords.length;
      const idx = Math.max(0, Math.min(plan.chords.length - 1, Math.floor(beat / dur)));
      try {
        return parseChord(plan.chords[idx]);
      } catch {
        return null;
      }
    }
    const slots = this.engine.chart.sections.get(plan.section)?.barChords(plan.barInSection) ?? [];
    return (slots.find((s) => beat >= s.start && beat < s.start + s.dur) ?? slots[0])?.chord ?? null;
  };

  /** All listening groups for the bar just played. */
  heard(plan: BarPlan): Heard {
    const chart = this.engine.chart;
    const bars = this.recent.slice(-chart.phraseBars);
    return {
      position: songPosition(chart, plan, this.engine.config.loop),
      rhythm: rhythmOf(bars.map((b) => b.notes), chart.beatsPerBar, plan.bpm),
      harmony: harmonyOf(bars, chart.beatsPerBar, this.chordAt, getGenre(plan.genre).listening),
      phrasing: phrasingOf(this.recent.map((b) => b.notes), chart.beatsPerBar),
      dynamics: dynamicsOf(bars.map((b) => b.notes), chart.beatsPerBar),
    };
  }

  context(plan: BarPlan, player: PlayerSummary): LeaderContext {
    const chart = this.engine.chart;
    const heard = this.heard(plan);
    const ctx: LeaderContext = {
      bar: plan.bar,
      section: plan.section,
      bar_in_section: plan.barInSection,
      section_bars: plan.sectionBars,
      phrase_bars: chart.phraseBars,
      intensity: Math.round(plan.intensity * 100) / 100,
      target: Math.round(plan.target * 100) / 100,
      layers: plan.layers,
      lineup: plan.lineup,
      feel: plan.feel,
      form: chart.form,
      form_pos: plan.formPos,
      sections: [...chart.sections.keys()],
      player,
      recent_moves: this.engine.log.filter((r) => r.status === "applied").slice(-4).map((r) => r.label),
    };
    if (this.listening.position) ctx.position = heard.position;
    if (this.listening.rhythm) ctx.rhythm = heard.rhythm;
    if (this.listening.harmony) ctx.harmony = heard.harmony;
    if (this.listening.phrasing) ctx.phrasing = heard.phrasing;
    if (this.listening.dynamics) ctx.dynamics = heard.dynamics;
    // Leading (v0.4): personality and genre taste, the song so far with a plan, the trade.
    const style = this.engine.leading;
    const follow = followLevel(player, { state: heard.phrasing.state, held: heard.phrasing.held, shape: heard.dynamics.shape }, ctx.target);
    ctx.leading = { personality: style.personality, activity: style.activity, taste: style.taste, favour: style.favour, avoid: style.avoid, follow };
    ctx.arc = this.arcNow(plan);
    const trade = this.trader?.state(plan) ?? (this.engine.trading ? { turn: plan.solo ? "band" : "player", soloist: plan.solo?.part ?? null, bars_left: 0 } : null);
    if (trade) ctx.trading = trade as LeaderContext["trading"];
    return ctx;
  }

  /** The song so far and the plan, after `plan` (for the summary and the overlay). */
  arcNow(plan: BarPlan): ArcSummary {
    const style = this.engine.leading;
    this.arc.style = style.arc;
    const form = this.engine.chart.form;
    const nextPos = plan.formPos + 1 < form.length ? plan.formPos + 1 : this.engine.config.loop ? 0 : -1;
    return this.arc.summary(plan, nextPos >= 0 ? form[nextPos] : null, nextPos, (m) => avoids(style, m));
  }

  private ask(plan: BarPlan, player: PlayerSummary): void {
    if (this.inFlight) return void this.events.onSkip?.(plan.bar);
    const ctx = this.context(plan, player);
    const done = (reply: LeaderReply) => {
      this.inFlight = false;
      // Ending the song is the player's call; a leader can't make it.
      const moves = reply.moves.filter((m) => !PLAYER_ONLY_MOVES.includes((m as { move?: string })?.move as Move["move"]));
      if (moves.length) this.engine.submit(moves, reply.source, plan.bar);
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
