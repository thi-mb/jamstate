// Jev brain: TypeSafe's decision model. It answers typed questions instead of
// writing text, so a bandleader turn is two questions generated from the move
// set (ADR-0016):
//   - "level": a score for how hard the band should play next phrase;
//   - "change": one choice among the structural moves that make sense now
//     (or "keep"), built from the band's current state.
// Reasons come from templates, since Jev writes no text.
//
// TypeSafe blocks browser calls (CORS), so the page reaches it through the
// companion server's relay (/api/relay/jev); Node calls it directly.

import type { Move } from "../moves";
import type { LeaderContext } from "../rules";
import { FEELS, STINGERS, V01_PARTS } from "../types";
import { checkMove } from "./check";
import { BrainError, now, type BrainAnswer, type BrainProvider, type Fetch, type Rejected } from "./types";

export const JEV_API = "https://api.typesafe.ai/v1/systemone";

export interface JevConfig {
  /** Leave empty when the relay adds the key. */
  apiKey?: string;
  model?: string;
  /** Endpoint: the TypeSafe API, or the companion relay (e.g. api/relay/jev). */
  url?: string;
  /** Overlay label; "Jev" unless another model answers on the same wire. */
  label?: string;
}

/**
 * Intensity levels, low to high; the score is a probability-weighted index
 * into these. Each level names the playing it matches, so the question is
 * about the player rather than relative to the band's current level (asked
 * relative, Jev anchors on where the band already is).
 */
export const LEVELS = [
  { label: "barely there: the player stopped", value: 0.1 },
  { label: "soft and laid back: the player is sparse", value: 0.3 },
  { label: "medium groove: the player is steady", value: 0.5 },
  { label: "strong, digging in: the player is busy", value: 0.8 },
  { label: "full out: the player is playing all out", value: 1.0 },
];

/** Smallest change in intensity worth a move (the rule leader uses the same). */
const MIN_STEP = 0.1;

const label = (s: string) => s.replace(/_/g, " ");

/** The structural options for this turn, each mapped to the move it makes. */
export function changeOptions(ctx: LeaderContext): Map<string, { text: string; move: Move | null }> {
  const opts = new Map<string, { text: string; move: Move | null }>();
  opts.set("keep", { text: "keep the band as it is", move: null });
  const silent = ctx.player.silent_bars > 0;
  for (const p of ctx.lineup ?? V01_PARTS) {
    if (!ctx.layers.includes(p)) opts.set(`add_${p}`, { text: `bring the ${p} back in`, move: { move: "add_layer", part: p, reason: silent ? `${cap(p)} back in to pick things up` : `Bringing the ${p} back in with you` } });
  }
  if (ctx.layers.length > 1) {
    for (const p of ctx.layers) opts.set(`drop_${p}`, { text: `drop the ${p} out to make space`, move: { move: "drop_layer", part: p, reason: silent ? `You went quiet, ${p} out so it can breathe` : `${cap(p)} out to give you room` } });
  }
  for (const f of FEELS) {
    if (f === ctx.feel) continue;
    const reason = f === "half_time" ? "Half time to match the space" : f === "double_time" ? "Double time to ride your energy" : "Back to the normal feel";
    opts.set(`feel_${f}`, { text: `switch to ${label(f)} feel`, move: { move: "change_feel", feel: f, reason } });
  }
  const sting: Record<string, string> = { fill: "a drum fill to mark a lift", crash: "a crash cymbal accent", riser: "a build-up riser into what comes next" };
  const stingReason: Record<string, string> = { fill: "A fill to mark the lift", crash: "Crash to mark the moment", riser: "Building up into what's next" };
  for (const s of STINGERS) opts.set(`stinger_${s}`, { text: sting[s], move: { move: "fire_stinger", stinger: s, reason: stingReason[s] } });
  opts.set("extend", { text: `stay in the ${ctx.section} section ${ctx.phrase_bars} bars longer`, move: { move: "extend_section", bars: ctx.phrase_bars, reason: `Staying in the ${ctx.section} a bit longer` } });
  for (const s of ctx.sections) {
    if (s === ctx.section) continue;
    opts.set(`jump_${s}`, { text: `jump to the ${s} section now`, move: { move: "jump_to_section", section: s, reason: `Taking it to the ${s}` } });
  }
  return opts;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

const ROLE =
  "`player` is a live musician jamming with a backing band; `band` is what the band is doing now and `song` where we are in the song. A good band follows the player: when they stop (`silent_bars` > 0), it nearly stops too; when they play sparse and soft, it lays back; when they play busy and loud, it plays big. `player.sounds` says how they sound.";

/** The state Jev reads: the request, regrouped so the questions can point at it. */
export function jevState(ctx: LeaderContext): Record<string, unknown> {
  const p = ctx.player;
  // Words for the numbers, so the model doesn't have to read scales (the same idea as `trend`).
  const breathing = ctx.phrasing?.state === "breathing";
  const sounds = breathing && p.silent_bars > 0 ? "breathing between phrases, about to come back" : p.bars > 0 && p.silent_bars >= Math.min(p.bars, 2) ? "stopped" : p.energy >= 0.62 ? "busy and loud" : p.energy < 0.3 ? "sparse and soft" : "steady, medium";
  return {
    player: { ...p, sounds },
    band: { intensity: ctx.intensity, playing: ctx.layers, not_playing: (ctx.lineup ?? V01_PARTS).filter((p) => !ctx.layers.includes(p)), feel: ctx.feel, recent_moves: ctx.recent_moves },
    ...(ctx.rhythm ? { rhythm: ctx.rhythm } : {}),
    ...(ctx.harmony ? { harmony: ctx.harmony } : {}),
    ...(ctx.phrasing ? { phrasing: ctx.phrasing } : {}),
    song: { section: ctx.section, bar_in_section: ctx.bar_in_section + 1, section_bars: ctx.section_bars, form: ctx.form, form_position: ctx.form_pos, ...(ctx.position ?? {}) },
  };
}

export function jevQuestions(ctx: LeaderContext): Record<string, unknown> {
  const opts = changeOptions(ctx);
  return {
    level: {
      type: "score",
      instructions: `${ROLE} Ignoring how hard the band plays now, how hard should it play next to match the player?`,
      criteria: LEVELS.map((l) => l.label),
    },
    change: {
      type: "choice",
      instructions: `${ROLE} Pick the one change to who plays or how that best fits the player right now. If they stopped and drums are playing, drop the drums. If a part is in \`band.not_playing\` and the player is playing steady or busy, bring it back. Mark a big lift with a fill. If nothing needs to change, keep; don't repeat a recent move.`,
      criteria: Object.fromEntries([...opts].map(([id, o]) => [id, o.text])),
    },
  };
}

interface JevAnswers {
  level?: { score?: number; confidence?: number; probabilities?: Record<string, number> };
  change?: { choice?: string; confidence?: number; probabilities?: Record<string, number> };
}

/** Turn Jev's answers into moves. Exported for tests. */
export function jevMoves(ctx: LeaderContext, answers: JevAnswers): { moves: Move[]; rejected: Rejected[] } {
  const moves: Move[] = [];
  const rejected: Rejected[] = [];
  const score = answers.level?.score;
  if (typeof score === "number" && Number.isFinite(score)) {
    const i = Math.max(0, Math.min(LEVELS.length - 1, score));
    const lo = Math.floor(i);
    const hi = Math.min(LEVELS.length - 1, lo + 1);
    const value = Math.round((LEVELS[lo].value + (i - lo) * (LEVELS[hi].value - LEVELS[lo].value)) * 100) / 100;
    if (Math.abs(value - ctx.target) >= MIN_STEP) {
      const up = value > ctx.target;
      const reason = up
        ? ctx.player.trend === "rising" ? "You're building, the band lifts with you" : "Picking the energy up with you"
        : ctx.player.silent_bars > 0 ? "You went quiet, giving you space" : ctx.player.energy >= 0.62 ? "Leaving you some headroom" : "Easing back to give you room";
      moves.push({ move: "set_intensity", value, reason });
    }
  } else if (answers.level) rejected.push({ move: answers.level, error: "level has no score" });
  const choice = answers.change?.choice;
  if (choice && choice !== "keep") {
    const opt = changeOptions(ctx).get(choice);
    if (!opt?.move) rejected.push({ move: choice, error: "unknown option" });
    else {
      const err = checkMove(opt.move, ctx.sections);
      if (err) rejected.push({ move: opt.move, error: err });
      else moves.push(opt.move);
    }
  }
  return { moves, rejected };
}

export class JevBrain implements BrainProvider {
  readonly kind = "jev" as const;
  readonly label: string;

  constructor(
    private cfg: JevConfig,
    private fetchFn: Fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.label = cfg.label ?? "Jev";
  }

  async decide(ctx: LeaderContext, signal?: AbortSignal): Promise<BrainAnswer> {
    const t0 = now();
    const body = await postSystemOne(this.fetchFn, this.cfg.url ?? JEV_API, this.cfg.apiKey, { model: this.cfg.model ?? "jev-latest", state: jevState(ctx), questions: jevQuestions(ctx) }, this.label, signal);
    return {
      ...jevMoves(ctx, body.answers as JevAnswers),
      model: body.model,
      latencyMs: Math.round(now() - t0),
      meta: { answers: body.answers, usage: body.usage },
    };
  }
}

/** One call on TypeSafe's System One wire (Jev, or Laya on this machine). */
export async function postSystemOne(
  fetchFn: Fetch,
  url: string,
  apiKey: string | undefined,
  req: { model: string; state: unknown; questions: Record<string, unknown> },
  who: string,
  signal?: AbortSignal,
): Promise<{ model?: string; answers: Record<string, unknown>; usage?: unknown }> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(req),
    signal,
  });
  const text = await res.text();
  let body: { model?: string; answers?: Record<string, unknown>; usage?: unknown; error?: unknown; message?: unknown } = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* plain-text error */
  }
  if (!res.ok) throw new BrainError(`HTTP ${res.status} from ${who}: ${String(body.message ?? body.error ?? text).slice(0, 200)}`, res.status);
  if (!body.answers) throw new BrainError(`${who} returned no answers: ${text.slice(0, 200)}`);
  return { model: body.model, answers: body.answers, usage: body.usage };
}
