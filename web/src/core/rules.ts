// The rule-based bandleader. Same interface as the LLM one; used offline, in
// tests, and whenever the Spark is slow or down. v0 reacts to energy only,
// with separate enter/exit thresholds so it doesn't flap.

import type { PlayerSummary } from "./features";
import type { Harmony, Phrasing, Rhythm, SongPosition } from "./listening";
import type { Move } from "./moves";
import { V01_PARTS, type Feel, type Part } from "./types";

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
  constructor(private t: RuleThresholds = DEFAULT_THRESHOLDS) {}

  private classify(p: PlayerSummary): Mood {
    if (p.bars > 0 && p.silent_bars >= Math.min(p.bars, Math.max(2, p.bars - 1))) return "silent";
    const e = p.energy;
    const was = this.mood;
    if (e >= this.t.busyEnter || (was === "busy" && e >= this.t.busyExit)) return "busy";
    if (e < this.t.sparseEnter || ((was === "sparse" || was === "silent") && e < this.t.sparseExit)) return "sparse";
    return "groove";
  }

  decide(ctx: LeaderContext): Move[] {
    return this.withHarmony(ctx, this.withPosition(ctx, this.withPhrasing(ctx, this.byMood(ctx))));
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
    const intensity = (value: number, reason: string) => {
      if (Math.abs(value - ctx.target) >= 0.1) moves.push({ move: "set_intensity", value: Math.round(value * 100) / 100, reason });
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
      case "sparse":
        if (prev === "silent" && !has("drums")) moves.push({ move: "add_layer", part: "drums", reason: "You're back, drums ease in" });
        intensity(0.28, "Sparse playing, laying back");
        feel("half_time", "Half time to match the space");
        break;
      case "groove":
        intensity(0.5, "Settling into the groove");
        if (missing.length) moves.push({ move: "add_layer", part: missing[0], reason: `Bringing the ${missing[0]} back` });
        else feel("normal", "Back to the normal feel");
        break;
      case "busy":
        intensity(Math.min(1, 0.75 + (ctx.player.energy - this.t.busyEnter)), "You're digging in, raising the energy");
        if (missing.length) moves.push({ move: "add_layer", part: missing[0], reason: `Full band: ${missing[0]} in` });
        else if (ctx.feel === "half_time") feel("normal", "Out of half time to keep up");
        else moves.push({ move: "fire_stinger", stinger: prev === "silent" ? "crash" : "fill", reason: "Marking the lift" });
        break;
    }
    return moves.slice(0, 2);
  }
}
