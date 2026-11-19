// The rule-based bandleader. Same interface as the LLM one; used offline, in
// tests, and whenever the LLM brain is slow or down. v0 reacts to energy only,
// with separate enter/exit thresholds so it doesn't flap.

import type { PlayerSummary } from "./features";
import type { ArcSummary } from "./arc";
import type { Dynamics, Harmony, Phrasing, Rhythm, SongPosition } from "./listening";
import type { Personality } from "./leading";
import type { TradeState } from "./trade";
import type { Move } from "./moves";
import { moveMatches, type Follow } from "./leading";
import { PART_LABELS as PART_NAMES, V01_PARTS, clamp, type Feel, type Part } from "./types";

/** What any bandleader sees every N bars. Field names match the server API. */
export interface LeaderContext {
  bar: number;
  section: string;
  bar_in_section: number;
  section_bars: number;
  phrase_bars: number;
  intensity: number;
  target: number;
  layers: Part[];
  /** Who is in the band, playing or sitting out (v0.2). Missing: drums, bass, chords. */
  lineup?: Part[];
  feel: Feel;
  form: string[];
  form_pos: number;
  sections: string[];
  player: PlayerSummary;
  recent_moves: string[];
  /** Listening layer (v0.3), present when its group is on. */
  position?: SongPosition;
  rhythm?: Rhythm;
  harmony?: Harmony;
  phrasing?: Phrasing;
  dynamics?: Dynamics;
  /** Leading (v0.4): the leader's personality and the genre's taste. */
  leading?: LeadingInfo;
  /** The song so far and the plan for this section and the next (v0.4). */
  arc?: ArcSummary;
  /** Trading fours, when it's on (v0.4). */
  trading?: TradeState;
}

export interface LeadingInfo {
  personality: Personality;
  /** 0–1: how much this leader moves. */
  activity: number;
  /** The genre's taste in a sentence. */
  taste: string;
  favour: string[];
  avoid: string[];
  /** Where following the player puts the band now (precomputed). */
  follow?: Follow;
}

export type Mood = "silent" | "sparse" | "groove" | "busy";

export interface RuleThresholds {
  busyEnter: number;
  busyExit: number;
  sparseEnter: number;
  sparseExit: number;
}

export const DEFAULT_THRESHOLDS: RuleThresholds = { busyEnter: 0.62, busyExit: 0.52, sparseEnter: 0.3, sparseExit: 0.38 };

export class RuleLeader {
  mood: Mood = "groove";
  /** Bar where the section we last lifted into the next one started (song position). */
  private liftedAt = -1;
  /** Song arc (v0.4): the first bar of the section visit whose plan we applied, and its level bias. */
  private arcAt = -1;
  private bias = 0;
  /** Adventurous leaders add a colour move every other quiet turn; this counts turns. */
  private extraTick = 0;
  constructor(private t: RuleThresholds = DEFAULT_THRESHOLDS) {}

  /** How much this leader moves (0–1); 0.5 without a personality (v0.3). */
  private activity(ctx: LeaderContext): number {
    return ctx.leading?.activity ?? 0.5;
  }

  /** The smallest target change worth a move: 0.1 (v0.3) at activity 0.5 and up, bigger for a steadier leader. */
  private threshold(ctx: LeaderContext): number {
    return clamp(0.1 + 0.4 * (0.5 - this.activity(ctx)), 0.1, 0.25);
  }

  private classify(p: PlayerSummary): Mood {
    if (p.bars > 0 && p.silent_bars >= Math.min(p.bars, Math.max(2, p.bars - 1))) return "silent";
    const e = p.energy;
    const was = this.mood;
    if (e >= this.t.busyEnter || (was === "busy" && e >= this.t.busyExit)) return "busy";
    if (e < this.t.sparseEnter || ((was === "sparse" || was === "silent") && e < this.t.sparseExit)) return "sparse";
    return "groove";
  }

  decide(ctx: LeaderContext): Move[] {
    const moves = this.withHarmony(ctx, this.withPosition(ctx, this.withDynamics(ctx, this.withPhrasing(ctx, this.withArc(ctx, this.byMood(ctx))))));
    return this.withTaste(ctx, moves);
  }

  /**
   * Song arc (v0.4): at a new section visit, follow the plan for it (bigger
   * than last time, or different, or the same level with a new texture) as a
   * bias on top of following the player, kept for the whole visit. Applied
   * in the last bars before the section, so it lands on its first bar. Only
   * while the player is playing: a quiet player gets space, not a plan.
   */
  private withArc(ctx: LeaderContext, moves: Move[]): Move[] {
    const arc = ctx.arc;
    if (!arc || ctx.trading) return moves;
    const sectionStart = ctx.bar - ctx.bar_in_section;
    // The plan for the section about to start (the decision lands on its first bars), else for this one.
    const ahead = arc.now.bars_left <= 1 && arc.next;
    const plan = ahead ? arc.next! : ctx.bar_in_section <= 1 ? arc.now : null;
    const visit = ahead ? ctx.bar + arc.now.bars_left + 1 : sectionStart;
    if (!plan || this.arcAt === visit) return moves;
    this.arcAt = visit;
    this.bias = 0;
    const engaged = this.mood === "groove" || this.mood === "busy";
    if (!engaged || (plan.change === 0 && !plan.add && !plan.drop)) return moves;
    const out: Move[] = [];
    if (plan.change !== 0) {
      // The plan's level (last time's, changed), kept within reach of where the player is.
      const follow = this.followLevel(ctx);
      // Up means at least where the player is; down means at most (last time may have been a quiet one).
      const aim = plan.aim === null ? follow + plan.change : plan.change > 0 ? Math.max(plan.aim, follow) : Math.min(plan.aim, follow);
      const value = Math.round(clamp(aim, Math.max(0.1, follow - 0.2), Math.min(1, follow + 0.3)) * 100) / 100;
      // Following the player through the visit keeps this offset.
      this.bias = value - follow;
      if (Math.abs(value - ctx.target) >= 0.05) out.push({ move: "set_intensity", value, reason: `${plan.section} ${plan.pass}: ${plan.idea}`.slice(0, 100) });
    }
    if (plan.add && !ctx.layers.includes(plan.add)) out.push({ move: "add_layer", part: plan.add, reason: `${plan.section} ${plan.pass}: the ${plan.add} in this time` });
    // A busy player gets the whole band: parts lay out only while they groove.
    else if (plan.drop && ctx.layers.includes(plan.drop) && this.mood === "groove") out.push({ move: "drop_layer", part: plan.drop, reason: `${plan.section} ${plan.pass}: the ${plan.drop} lay out this time` });
    // The plan's moves first; anything else the mood asked for after.
    const rest = moves.filter((m) => !out.some((o) => o.move === m.move || (o.move === "set_intensity" && m.move === "set_intensity")));
    return [...out, ...rest].slice(0, 2);
  }

  /** Where following the player puts the level, without the arc. */
  private followLevel(ctx: LeaderContext): number {
    const e = ctx.player.energy;
    return this.mood === "busy" ? Math.min(1, 0.7 + e * 0.3) : this.mood === "groove" ? 0.35 + e * 0.4 : this.mood === "sparse" ? 0.28 : 0.1;
  }

  /**
   * Genre taste and personality (v0.4): leave out what the genre avoids; a
   * steady leader makes one move at a time and no flourishes; an
   * adventurous one adds a colour move the genre favours when the player is
   * playing and nothing else is happening.
   */
  private withTaste(ctx: LeaderContext, moves: Move[]): Move[] {
    const lead = ctx.leading;
    if (!lead) return moves;
    const a = lead.activity;
    let out = moves.filter((m) => !lead.avoid.some((t) => moveMatches(m as never, t)) || (m.move === "change_feel" && m.feel === "normal"));
    if (lead.personality === "steady") {
      out = out.filter((m) => !(m.move === "fire_stinger" && m.stinger !== "crash") && !(m.move === "change_feel" && m.feel !== "normal")).slice(0, 1);
    }
    const engaged = this.mood === "groove" || this.mood === "busy";
    // Adventurous: a colour move every other quiet turn, every turn in a genre that moves a lot.
    if (lead.personality === "adventurous" && !out.length && engaged && !ctx.trading && (a >= 0.8 || this.extraTick % 2 === 0) && this.extraTick++ >= 0) {
      const extra = this.colour(ctx, lead.favour);
      if (extra && !lead.avoid.some((t) => moveMatches(extra as never, t))) out.push(extra);
    }
    return out;
  }

  /** A colour move from the genre's favourites that fits now, taken in turn. */
  private colour(ctx: LeaderContext, favour: string[]): Move | null {
    const has = (p: Part) => ctx.layers.includes(p);
    const missing = (ctx.lineup ?? V01_PARTS).filter((p) => !has(p));
    const busy = this.mood === "busy";
    const options: Move[] = [];
    for (const tag of favour) {
      const [kind, arg] = tag.split(":");
      if (kind === "fire_stinger" && has("drums")) options.push({ move: "fire_stinger", stinger: (arg ?? "fill") as "fill", reason: arg === "crash" ? "A hit to mark it" : "A fill to answer you" });
      else if (kind === "change_feel" && arg === "double_time" && busy && ctx.feel === "normal") options.push({ move: "change_feel", feel: "double_time", reason: "Double time while you're flying" });
      else if (kind === "change_feel" && ctx.feel !== "normal" && !busy) options.push({ move: "change_feel", feel: "normal", reason: "Back to the normal feel" });
      else if (kind === "drop_layer" && !busy) {
        const p = (arg as Part | undefined) ?? (["chords", "guitar", "pad", "percussion"] as Part[]).find(has);
        if (p && has(p) && p !== "drums" && p !== "bass") options.push({ move: "drop_layer", part: p, reason: `The ${p} lays out for a bit` });
      } else if (kind === "add_layer") {
        const p = (arg as Part | undefined) ?? missing[0];
        if (p && !has(p) && (ctx.lineup ?? V01_PARTS).includes(p)) options.push({ move: "add_layer", part: p, reason: `The ${p} back in` });
      } else if (kind === "set_intensity") {
        const up = busy || ctx.player.trend === "rising";
        const value = Math.round(clamp(ctx.target + (up ? 0.12 : -0.12), 0.15, 1) * 100) / 100;
        if (Math.abs(value - ctx.target) >= 0.1) options.push({ move: "set_intensity", value, reason: up ? "Pushing it a little" : "Pulling back a little" });
      }
    }
    return options.length ? options[(this.extraTick >> 1) % options.length] : null;
  }

  /**
   * Dynamics (v0.3): follow a crescendo or decrescendo while it happens,
   * a step at a time, instead of waiting for the energy band to change.
   */
  private withDynamics(ctx: LeaderContext, moves: Move[]): Move[] {
    const d = ctx.dynamics;
    if (!d?.shape || d.shape === "steady" || this.mood === "silent") return moves;
    const set = moves.find((m) => m.move === "set_intensity") as Extract<Move, { move: "set_intensity" }> | undefined;
    const r = (x: number) => Math.round(x * 100) / 100;
    if (d.shape === "decrescendo") {
      const value = r(Math.max(0.15, Math.min(set?.value ?? 1, ctx.target - 0.1)));
      const rest = moves.filter((m) => m.move !== "set_intensity" && m.move !== "add_layer" && m.move !== "fire_stinger");
      return value < ctx.target ? [{ move: "set_intensity", value, reason: "Coming down with you" } as Move, ...rest].slice(0, 2) : rest;
    }
    const value = r(Math.max(set?.value ?? 0, Math.min(0.9, ctx.target + 0.1)));
    const rest = moves.filter((m) => m.move !== "set_intensity" && m.move !== "drop_layer" && !(m.move === "change_feel" && m.feel === "half_time"));
    return value > ctx.target ? [{ move: "set_intensity", value, reason: set && set.value >= value ? set.reason : "Building with you" } as Move, ...rest].slice(0, 2) : rest;
  }

  /** Phrasing (v0.3): trading phrases with the band, keep the level steady and the feel as it is. */
  private withPhrasing(ctx: LeaderContext, moves: Move[]): Move[] {
    if (!ctx.phrasing?.call_response) return moves;
    return moves.filter((m) => m.move !== "change_feel" && !(m.move === "set_intensity" && Math.abs(m.value - ctx.target) > 0.2) && !(m.move === "drop_layer" && (m.part === "drums" || m.part === "bass")));
  }

  /**
   * Harmony (v0.3): when the player goes outside, a genre that holds keeps the
   * band where it is (no lifts, no new parts, no riser); a genre that lifts
   * (jazz) keeps drums and bass in and nudges up with them.
   */
  private withHarmony(ctx: LeaderContext, moves: Move[]): Move[] {
    const h = ctx.harmony;
    if (!h || h.fit !== "outside") return moves;
    if (h.genre_outside === "hold") {
      const held = moves.filter(
        (m) => !(m.move === "set_intensity" && m.value > ctx.target + 0.1) && m.move !== "add_layer" && !(m.move === "fire_stinger" && m.stinger === "riser"),
      );
      return held;
    }
    const kept = moves.filter((m) => !(m.move === "drop_layer" && (m.part === "drums" || m.part === "bass")) && !(m.move === "set_intensity" && m.value < ctx.target));
    if (!kept.some((m) => m.move === "set_intensity") && ctx.target < 0.9)
      kept.unshift({ move: "set_intensity", value: Math.round(Math.min(1, ctx.target + 0.1) * 100) / 100, reason: "Going out with you" });
    return kept.slice(0, 2);
  }

  /**
   * Song position (v0.3): lift in the last phrase before a bigger section,
   * and hold the band together in the two bars before any change.
   */
  private withPosition(ctx: LeaderContext, moves: Move[]): Move[] {
    const pos = ctx.position;
    if (!pos || pos.next_section === null) return moves;
    if (pos.bars_left < 2) moves = moves.filter((m) => m.move !== "drop_layer" && m.move !== "change_feel");
    const sectionStart = ctx.bar - ctx.bar_in_section;
    // Only when the player is building or already digging in: a steady player keeps the band where it is.
    const building = this.mood === "busy" || (this.mood === "groove" && ctx.player.trend === "rising");
    if (pos.next_lift === "up" && pos.bars_left < ctx.phrase_bars && building && this.liftedAt !== sectionStart) {
      this.liftedAt = sectionStart;
      const set = moves.find((m) => m.move === "set_intensity") as Extract<Move, { move: "set_intensity" }> | undefined;
      const lift = Math.min(1, Math.max(ctx.target, set?.value ?? 0) + (ctx.player.trend === "rising" ? 0.25 : 0.15));
      const move: Move = { move: "set_intensity", value: Math.round(lift * 100) / 100, reason: `Lifting into the ${pos.next_section}` };
      moves = [move, ...moves.filter((m) => m.move !== "set_intensity")];
    }
    return moves.slice(0, 2);
  }

  private byMood(ctx: LeaderContext): Move[] {
    const prev = this.mood;
    let mood = this.classify(ctx.player);
    // Trading fours (v0.4): the player's gaps are the band's turns. Hold the mood.
    if (ctx.trading && (mood === "silent" || mood === "sparse")) return [];
    const ph = ctx.phrasing;
    const has = (p: Part) => ctx.layers.includes(p);
    // Phrasing (v0.3): a short gap after playing is a breath, or room left for
    // the band to answer. Keep the mood and fill the gap instead of dropping out.
    if (ph && mood === "silent" && ph.state === "breathing" && prev !== "silent") {
      this.mood = prev;
      // Trading phrases: answer in the gap. A plain breath: hold and wait.
      return ph.call_response && has("drums") ? [{ move: "fire_stinger", stinger: "fill", reason: "Answering in your gap" }] : [];
    }
    // Long held notes are a lyrical line: lay back under it.
    if (ph && mood === "groove" && (ph.held ?? 0) >= 0.6) mood = "sparse";
    this.mood = mood;
    const missing = (ctx.lineup ?? V01_PARTS).filter((p) => !has(p));
    const moves: Move[] = [];
    const thr = this.threshold(ctx);
    const lead = ctx.leading;
    const fav = (tag: string) => !!lead?.favour.some((t) => t === tag || tag.startsWith(`${t}:`));
    // The arc's bias for this section visit applies while the player is in it.
    const bias = mood === "groove" || mood === "busy" ? this.bias : 0;
    const intensity = (value: number, reason: string) => {
      const v = clamp(value + bias, 0, 1);
      if (Math.abs(v - ctx.target) >= thr - 1e-9) moves.push({ move: "set_intensity", value: Math.round(v * 100) / 100, reason });
    };
    const feel = (f: Feel, reason: string) => {
      if (ctx.feel !== f) moves.push({ move: "change_feel", feel: f, reason });
    };

    if (mood === prev) {
      // Same mood: just track energy within the mood's band.
      if (mood === "busy") intensity(Math.min(1, 0.7 + ctx.player.energy * 0.3), "Still pushing, staying with you");
      else if (mood === "groove") {
        // Song position: a steady player in a big section (a chorus) keeps the section's level.
        const floor = ctx.position && ctx.player.trend !== "falling" ? (ctx.position.section_level ?? 0) : 0;
        const v = 0.35 + ctx.player.energy * 0.4;
        if (v >= floor || ctx.target < floor) intensity(Math.max(v, Math.min(floor, ctx.target)), "Following your dynamics");
      }
      return moves.slice(0, 2);
    }

    switch (mood) {
      case "silent":
        intensity(0.1, "You went quiet, giving you space");
        if (has("drums")) moves.push({ move: "drop_layer", part: "drums", reason: "Drums out so it can breathe" });
        break;
      case "sparse": {
        if (prev === "silent" && !has("drums")) moves.push({ move: "add_layer", part: "drums", reason: "You're back, drums ease in" });
        intensity(0.28, "Sparse playing, laying back");
        // Genre taste: a part lays out (funk, jazz) where the genre favours it, else half time.
        const texture = (["chords", "guitar", "pad"] as Part[]).find((p) => has(p) && fav(`drop_layer:${p}`));
        if (texture && prev !== "silent") moves.push({ move: "drop_layer", part: texture, reason: `The ${PART_NAMES[texture]} lays out, leaving you room` });
        else feel("half_time", "Half time to match the space");
        break;
      }
      case "groove":
        intensity(0.5, "Settling into the groove");
        if (missing.length) moves.push({ move: "add_layer", part: missing[0], reason: `Bringing the ${missing[0]} back` });
        else feel("normal", "Back to the normal feel");
        break;
      case "busy":
        intensity(Math.min(1, 0.75 + (ctx.player.energy - this.t.busyEnter)), "You're digging in, raising the energy");
        if (missing.length) moves.push({ move: "add_layer", part: missing[0], reason: `Full band: ${missing[0]} in` });
        else if (ctx.feel === "half_time") feel("normal", "Out of half time to keep up");
        else {
          // Genre taste: the genre's favourite way to mark a lift.
          const mark = lead?.favour.find((t) => t.startsWith("fire_stinger:"))?.split(":")[1] as "fill" | "crash" | "riser" | undefined;
          const stinger = mark && mark !== "riser" ? mark : prev === "silent" ? "crash" : "fill";
          moves.push({ move: "fire_stinger", stinger, reason: "Marking the lift" });
        }
        break;
    }
    return moves.slice(0, 2);
  }
}
