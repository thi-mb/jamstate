// The leading layer (v0.4): how a bandleader in this genre behaves (the
// genre pack's `leading`), and the player's pick of personality, which sets
// how much it moves within the genre's range. ADR-0021.
//
// Both reach every brain the same way: the governor's dwell times and
// deadband come from here (so even a brain that ignores the prompt moves
// less when steady), and the summary carries a `leading` block the rule
// leader and the LLMs read.

import type { GovernorConfig } from "./engine";
import { MOVE_KINDS } from "./moves";
import { PARTS, STINGERS, clamp, type Part } from "./types";

export const PERSONALITIES = ["steady", "supportive", "adventurous"] as const;
export type Personality = (typeof PERSONALITIES)[number];
export const DEFAULT_PERSONALITY: Personality = "supportive";

export const PERSONALITY_LABELS: Record<Personality, string> = {
  steady: "Steady",
  supportive: "Supportive",
  adventurous: "Adventurous",
};

/** Where in the genre's activity range each personality sits. */
const PERSONALITY_POS: Record<Personality, number> = { steady: 0, supportive: 0.5, adventurous: 1 };

/** How a song is shaped across its sections. */
export const ARC_STYLES = ["build", "dynamic", "locked"] as const;
export type ArcStyle = (typeof ARC_STYLES)[number];

export interface GenreLeading {
  /** How much the leader moves, 0 (hardly) to 1 (every phrase): steady takes the low end, adventurous the high end. */
  activity: [number, number];
  /** build: each time round bigger, peak late. dynamic: vary each time round, up or down. locked: same level, change only texture. */
  arc: ArcStyle;
  /** Moves the leader reaches for, as "kind" or "kind:arg" ("fire_stinger:fill", "change_feel:double_time", "drop_layer:chords"). */
  favour: string[];
  /** Moves it stays away from, same form. */
  avoid: string[];
  /** Trading fours: bars per turn and who takes the band's turns, in order (they rotate). */
  trade: { bars: number; soloists: Part[] };
  /** One sentence for LLM leaders. */
  taste: string;
}

export const DEFAULT_LEADING: GenreLeading = {
  activity: [0.3, 0.7],
  arc: "build",
  favour: [],
  avoid: [],
  trade: { bars: 4, soloists: ["chords", "guitar"] },
  taste: "",
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** "kind" or "kind:arg" with a known move kind (and a known stinger, part or feel). */
function moveTag(x: unknown): boolean {
  if (typeof x !== "string") return false;
  const [kind, arg] = x.split(":");
  if (!(MOVE_KINDS as string[]).includes(kind) || kind === "end_song") return false;
  if (arg === undefined) return true;
  if (kind === "fire_stinger") return (STINGERS as readonly string[]).includes(arg);
  if (kind === "add_layer" || kind === "drop_layer") return (PARTS as readonly string[]).includes(arg);
  if (kind === "change_feel") return ["normal", "half_time", "double_time"].includes(arg);
  return false;
}

/** Parse a pack's `leading` (missing: the defaults). */
export function leadingPack(raw: unknown, errs: string[]): GenreLeading {
  if (raw === undefined) return structuredClone(DEFAULT_LEADING);
  if (!isObj(raw)) return errs.push("leading must be an object"), structuredClone(DEFAULT_LEADING);
  for (const k of Object.keys(raw)) if (!["activity", "arc", "favour", "avoid", "trade", "taste"].includes(k)) errs.push(`leading: unknown field "${k}"`);
  const out = structuredClone(DEFAULT_LEADING);
  if (raw.activity !== undefined) {
    const a = raw.activity;
    if (!Array.isArray(a) || a.length !== 2 || !a.every((x) => typeof x === "number" && x >= 0 && x <= 1) || a[0] > a[1])
      errs.push("leading.activity must be [low, high], 0–1, low ≤ high");
    else out.activity = [a[0], a[1]];
  }
  if (raw.arc !== undefined) {
    if (!(ARC_STYLES as readonly unknown[]).includes(raw.arc)) errs.push(`leading.arc must be one of ${ARC_STYLES.join(", ")}`);
    else out.arc = raw.arc as ArcStyle;
  }
  for (const k of ["favour", "avoid"] as const) {
    const v = raw[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every(moveTag)) errs.push(`leading.${k} must be a list of moves ("set_intensity", "fire_stinger:fill", "drop_layer:chords", …)`);
    else out[k] = v as string[];
  }
  if (raw.trade !== undefined) {
    const t = raw.trade;
    if (!isObj(t)) errs.push("leading.trade must be an object");
    else {
      if (t.bars !== undefined) {
        if (![2, 4, 8].includes(t.bars as number)) errs.push("leading.trade.bars must be 2, 4 or 8");
        else out.trade.bars = t.bars as number;
      }
      if (t.soloists !== undefined) {
        if (!Array.isArray(t.soloists) || !t.soloists.length || !t.soloists.every((p) => (PARTS as readonly unknown[]).includes(p) && p !== "pad" && p !== "percussion"))
          errs.push("leading.trade.soloists must be a non-empty list of drums, bass, chords, guitar");
        else out.trade.soloists = t.soloists as Part[];
      }
    }
  }
  if (raw.taste !== undefined) {
    if (typeof raw.taste !== "string" || raw.taste.length > 300) errs.push("leading.taste must be a string up to 300 characters");
    else out.taste = raw.taste;
  }
  return out;
}

/** A genre's leading taste with a personality applied: what the governor and the leaders use. */
export interface LeadingStyle {
  personality: Personality;
  /** 0–1: how much this leader moves. */
  activity: number;
  arc: ArcStyle;
  favour: string[];
  avoid: string[];
  taste: string;
  /** Governor settings this leader plays under. */
  governor: Pick<GovernorConfig, "layerDwellBars" | "feelDwellBars" | "intensityDeadband">;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Personality inside the genre's range. At activity 0.5 the governor is the
 * v0.3 one (layer dwell 2, feel dwell 4, deadband 0.1); lower waits longer
 * between changes and ignores smaller ones, higher the opposite.
 */
export function leadingStyle(genre: GenreLeading, personality: Personality): LeadingStyle {
  const [lo, hi] = genre.activity;
  const activity = r2(lo + (hi - lo) * PERSONALITY_POS[personality]);
  const d = 0.5 - activity;
  return {
    personality,
    activity,
    arc: genre.arc,
    favour: genre.favour,
    avoid: genre.avoid,
    taste: genre.taste,
    governor: {
      layerDwellBars: Math.round(clamp(2 + 8 * d, 1, 8)),
      feelDwellBars: Math.round(clamp(4 + 16 * d, 2, 16)),
      intensityDeadband: r2(clamp(0.1 + 0.16 * d, 0.05, 0.2)),
    },
  };
}

/** Where following the player puts the band, precomputed so a brain doesn't do arithmetic (v0.4). */
export interface Follow {
  /** The target level that matches the player right now, 0–1. */
  level: number;
  /** The band's target against it, in words: "band 0.3 louder", "matched", "band 0.2 softer". */
  gap: string;
  /** Why, in a word or two: stopped, breathing, sparse, held notes, getting softer, getting louder, steady, busy. */
  why: string;
}

/**
 * The follow level from everything the page hears: energy, stopping and
 * breathing (phrasing), held notes and a swell inside the phrase (dynamics).
 * The same bands as the rule leader's moods.
 */
export function followLevel(
  p: { energy: number; silent_bars: number; bars: number },
  heard: { state?: string; held?: number | null; shape?: string | null },
  target: number,
): Follow {
  const r = (x: number) => Math.round(clamp(x, 0, 1) * 100) / 100;
  let level: number;
  let why: string;
  if (heard.state === "breathing") [level, why] = [target, "breathing"];
  else if (heard.state === "stopped" || (p.bars > 0 && p.silent_bars >= Math.min(p.bars, 2))) [level, why] = [0.15, "stopped"];
  else {
    const e = p.energy;
    [level, why] = e < 0.3 ? [0.28, "sparse"] : e >= 0.62 ? [0.7 + 0.3 * e, "busy"] : [0.35 + 0.4 * e, "steady"];
    if ((heard.held ?? 0) >= 0.6 && level > 0.35) [level, why] = [0.35, "held notes"];
    if (heard.shape === "decrescendo" && level > target - 0.12) [level, why] = [target - 0.12, "getting softer"];
    if (heard.shape === "crescendo" && level < target + 0.12) [level, why] = [target + 0.12, "getting louder"];
  }
  level = r(level);
  const d = Math.round((target - level) * 100) / 100;
  return { level, gap: Math.abs(d) < 0.1 ? "matched" : `band ${Math.abs(d).toFixed(2)} ${d > 0 ? "louder" : "softer"}`, why };
}

/** Whether a move matches a "kind" or "kind:arg" tag. */
export function moveMatches(m: { move: string; part?: string; stinger?: string; feel?: string }, tag: string): boolean {
  const [kind, arg] = tag.split(":");
  if (m.move !== kind) return false;
  return arg === undefined || m.part === arg || m.stinger === arg || m.feel === arg;
}

/** True when the style avoids this move. */
export const avoids = (s: Pick<LeadingStyle, "avoid">, m: { move: string; part?: string; stinger?: string; feel?: string }) => s.avoid.some((t) => moveMatches(m, t));
/** True when the style favours this move. */
export const favours = (s: Pick<LeadingStyle, "favour">, m: { move: string; part?: string; stinger?: string; feel?: string }) => s.favour.some((t) => moveMatches(m, t));

/**
 * The follow guard (v0.4 policy for text LLMs, ADR-0021): an LLM picks the
 * band's colour, structure and arc moves, and this makes sure the band still
 * follows the player. When they stopped, the level comes down and the drums
 * go out, with nothing added; when they play again, the drums come back.
 * When the level is more than 0.1 off where
 * following puts it and the reply didn't set one, it is set. A busy player
 * keeps the whole band and isn't taken far below the follow level. While
 * trading or breathing the reply stands as it is.
 */
export function guardFollow(
  ctx: { target: number; layers: string[]; lineup?: string[]; leading?: { follow?: Follow }; trading?: unknown },
  moves: { move: string; value?: number; part?: string; reason: string }[],
): { move: string; value?: number; part?: string; reason: string }[] {
  const f = ctx.leading?.follow;
  if (!f || ctx.trading || f.why === "breathing") return moves;
  let out = [...moves];
  const set = (reason: string) => ({ move: "set_intensity", value: f.level, reason });
  if (f.why === "stopped") {
    out = out.filter((m) => m.move !== "add_layer" && m.move !== "fire_stinger" && !(m.move === "set_intensity" && (m.value ?? 0) > f.level + 0.1));
    if (!out.some((m) => m.move === "set_intensity") && f.gap !== "matched") out.unshift(set("You stopped, so the band drops back"));
    if (ctx.layers.includes("drums") && !out.some((m) => m.move === "drop_layer" && m.part === "drums")) out.splice(1, 0, { move: "drop_layer", part: "drums", reason: "Drums out while you rest" });
    return out.slice(0, 2);
  }
  if (f.why === "busy") out = out.filter((m) => m.move !== "drop_layer" && !(m.move === "set_intensity" && (m.value ?? 1) < f.level - 0.2));
  if (f.gap !== "matched" && !out.some((m) => m.move === "set_intensity"))
    out.unshift(set(f.level > ctx.target ? "Coming up with you" : "Easing back with you"));
  // Back from a stop: the drums come back in with the player.
  if ((ctx.lineup ?? ["drums"]).includes("drums") && !ctx.layers.includes("drums") && !out.some((m) => m.move === "add_layer" && m.part === "drums"))
    out.splice(1, 0, { move: "add_layer", part: "drums", reason: "You're back, drums in" });
  return out.slice(0, 2);
}
