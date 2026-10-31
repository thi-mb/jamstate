// The rule-based bandleader. Same interface as the LLM one; used offline, in
// tests, and whenever the Spark is slow or down. v0 reacts to energy only,
// with separate enter/exit thresholds so it doesn't flap.

import type { PlayerSummary } from "./features";
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
    const prev = this.mood;
    const mood = this.classify(ctx.player);
    this.mood = mood;
    const has = (p: Part) => ctx.layers.includes(p);
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
      else if (mood === "groove") intensity(0.35 + ctx.player.energy * 0.4, "Following your dynamics");
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
