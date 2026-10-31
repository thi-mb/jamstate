// Laya brain: convaiinnovations' open decision model, run on the player's own
// machine (localbrain/laya_server.py) and spoken to over the same System One
// wire as Jev. Zero-shot, Laya can't read Jev's state (nested numbers) or its
// long option lists: asked Jev's questions, its level probabilities come out
// almost flat whether the player stopped or plays all out. It does read plain
// sentences and short choices, so this brain asks:
//   - "level": a choice of five named levels, read as its top pick;
//   - "change": a choice among a few changes to who plays, built from the
//     band's state and whether the player stopped. No section jumps or extends (the rule leader doesn't make
//     them either, and Laya picked them nearly every turn).
// Reasons come from templates, as for Jev.

import type { Move } from "../moves";
import type { LeaderContext } from "../rules";
import { PARTS } from "../types";
import { checkMove } from "./check";
import { postSystemOne } from "./jev";
import { now, type BrainAnswer, type BrainProvider, type Fetch, type Rejected } from "./types";

export const LAYA_URL = "http://127.0.0.1:8010/v1/systemone";

export interface LayaConfig {
  url?: string;
  /** Sent as `model`; the local server serves one checkpoint and ignores it. */
  model?: string;
  label?: string;
}

export const LAYA_LEVELS: Record<string, { text: string; value: number }> = {
  silent: { text: "almost silent, because the player stopped", value: 0.1 },
  soft: { text: "soft and quiet, because the player is sparse", value: 0.3 },
  medium: { text: "medium, because the player is steady", value: 0.5 },
  strong: { text: "strong and loud, because the player is busy", value: 0.8 },
  full: { text: "full out, because the player is playing all out", value: 1.0 },
};

const MIN_STEP = 0.1;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * The request as a few sentences: what the player is doing, then who in the
 * band plays. Not how hard the band plays: told that, Laya repeats it (a band
 * at "strong" stayed strong after the player stopped).
 */
export function layaState(ctx: LeaderContext): string {
  const p = ctx.player;
  const stopped = p.bars > 0 && p.silent_bars >= Math.min(p.bars, 2);
  const playing = stopped
    ? `The player has stopped playing: ${p.silent_bars} silent bars, no notes at all.`
    : p.energy >= 0.62
      ? `The player is playing busy and loud, lots of notes${p.trend === "rising" ? ", and getting louder" : ""}.`
      : p.energy < 0.3
        ? `The player is playing a few soft, sparse notes${p.trend === "falling" ? ", and getting quieter" : ""}.`
        : `The player is playing a steady, medium groove${p.trend === "rising" ? ", building up" : p.trend === "falling" ? ", easing off" : ""}.`;
  const out = PARTS.filter((x) => !ctx.layers.includes(x));
  const band = ctx.layers.length ? `The band is playing ${list(ctx.layers)}${out.length ? `; the ${list(out)} ${out.length > 1 ? "are" : "is"} out` : ""}.` : "The band is not playing.";
  return `${playing} ${band}`;
}

/**
 * The changes on offer this turn, each mapped to the move it makes. Which way
 * parts may go depends on the player: drops while they stop or play sparse,
 * comebacks (and a fill) while they play. Offered both ways, Laya drops a part
 * when a steady player has the drums out.
 */
export function layaChangeOptions(ctx: LeaderContext): Map<string, { text: string; move: Move | null }> {
  const opts = new Map<string, { text: string; move: Move | null }>();
  const p = ctx.player;
  const stopped = p.bars > 0 && p.silent_bars >= Math.min(p.bars, 2);
  const sparse = !stopped && p.energy < 0.3;
  opts.set("keep", { text: "keep the band as it is", move: null });
  if ((stopped || sparse) && ctx.layers.length > 1) {
    for (const x of ctx.layers) opts.set(`drop_${x}`, { text: `the ${x} stop playing`, move: { move: "drop_layer", part: x, reason: stopped ? `You went quiet, ${x} out so it can breathe` : `${cap(x)} out to give you room` } });
  }
  if (!stopped) {
    for (const x of PARTS) {
      if (!ctx.layers.includes(x)) opts.set(`add_${x}`, { text: `the ${x} come back in`, move: { move: "add_layer", part: x, reason: `Bringing the ${x} back in with you` } });
    }
  }
  if (!stopped && !sparse) opts.set("fill", { text: "a drum fill to mark a big lift", move: { move: "fire_stinger", stinger: "fill", reason: "A fill to mark the lift" } });
  return opts;
}

export function layaQuestions(ctx: LeaderContext): Record<string, unknown> {
  return {
    level: {
      type: "choice",
      instructions: "A backing band follows a live player. How loud and full should the band play next?",
      criteria: Object.fromEntries(Object.entries(LAYA_LEVELS).map(([id, l]) => [id, l.text])),
    },
    change: {
      type: "choice",
      instructions: "A backing band follows a live player. What should change in the band now?",
      criteria: Object.fromEntries([...layaChangeOptions(ctx)].map(([id, o]) => [id, o.text])),
    },
  };
}

interface LayaAnswers {
  level?: { choice?: string };
  change?: { choice?: string };
}

/** Turn Laya's answers into moves. Exported for tests. */
export function layaMoves(ctx: LeaderContext, answers: LayaAnswers): { moves: Move[]; rejected: Rejected[] } {
  const moves: Move[] = [];
  const rejected: Rejected[] = [];
  const level = answers.level?.choice;
  if (level && LAYA_LEVELS[level]) {
    const value = LAYA_LEVELS[level].value;
    if (Math.abs(value - ctx.target) >= MIN_STEP) {
      const reason = value > ctx.target ? "Picking the energy up with you" : ctx.player.silent_bars > 0 ? "You went quiet, giving you space" : "Easing back to give you room";
      moves.push({ move: "set_intensity", value, reason });
    }
  } else if (answers.level) rejected.push({ move: answers.level, error: "unknown level" });
  const choice = answers.change?.choice;
  if (choice && choice !== "keep") {
    const opt = layaChangeOptions(ctx).get(choice);
    if (!opt?.move) rejected.push({ move: choice, error: "unknown option" });
    else {
      const err = checkMove(opt.move, ctx.sections);
      if (err) rejected.push({ move: opt.move, error: err });
      else moves.push(opt.move);
    }
  }
  return { moves, rejected };
}

export class LayaBrain implements BrainProvider {
  readonly kind = "laya" as const;
  readonly label: string;

  constructor(
    private cfg: LayaConfig = {},
    private fetchFn: Fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.label = cfg.label ?? "Laya";
  }

  async decide(ctx: LeaderContext, signal?: AbortSignal): Promise<BrainAnswer> {
    const t0 = now();
    const body = await postSystemOne(this.fetchFn, this.cfg.url ?? LAYA_URL, undefined, { model: this.cfg.model ?? "laya", state: layaState(ctx), questions: layaQuestions(ctx) }, this.label, signal);
    return {
      ...layaMoves(ctx, body.answers as LayaAnswers),
      model: body.model,
      latencyMs: Math.round(now() - t0),
      meta: { answers: body.answers, usage: body.usage },
    };
  }
}
