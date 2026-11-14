// Brain settings and the factory that turns them into a provider. Settings
// (keys included) are the player's and live on their machine, in whatever
// key-value store the shell provides (ADR-0016).

import { RuleLeader, type LeaderContext } from "../rules";
import { ClaudeBrain, DEFAULT_CLAUDE_MODEL, OLD_DEFAULT_CLAUDE_MODEL } from "./claude";
import { JevBrain, JEV_API } from "./jev";
import { LayaBrain, LAYA_URL } from "./laya";
import { OpenAIBrain } from "./openai";
import { now, type BrainAnswer, type BrainKind, type BrainProvider, type Fetch } from "./types";

export * from "./types";
export { BrainLeader, type BrainStatus } from "./leader";
export { splitMoves, checkMove, extractJson } from "./check";
export { BLIND_NAMES, blindCandidates, blindLeader, isBlind, pickBlind, summarizeBlind, type BlindRating, type BlindRow } from "./blind";

/** The rule leader as a provider, so the bake-off treats every brain alike. */
export class RulesBrain implements BrainProvider {
  readonly kind = "rules" as const;
  readonly label = "Rules";
  constructor(private rules = new RuleLeader()) {}
  async decide(ctx: LeaderContext): Promise<BrainAnswer> {
    const t0 = now();
    const moves = this.rules.decide(ctx);
    return { moves, rejected: [], model: "rules", latencyMs: Math.round(now() - t0) };
  }
}

export type LeaderChoice = BrainKind | "none" | "blind";

export interface BrainSettings {
  kind: LeaderChoice;
  openai: { url: string; model: string; apiKey: string };
  /** `modelChosen`: the player typed the model (so a default change leaves it alone). */
  claude: { model: string; apiKey: string; modelChosen?: boolean };
  /** `relay`: go through the companion server (needed in the browser). */
  jev: { model: string; apiKey: string; relay: boolean; url: string };
  /** Laya on the player's machine (localbrain/laya_server.py); no key. */
  laya: { url: string };
}

/**
 * Defaults. The OpenAI-compatible URL points at the companion's relay, which
 * on the Spark forwards to Qwen, so a page served by the Spark works as is.
 */
export const DEFAULT_SETTINGS: BrainSettings = {
  // Jev won the bake-off and Thiago picked it (2026-10-31); rules stay the fallback.
  kind: "jev",
  openai: { url: "api/relay/llm", model: "leader", apiKey: "" },
  claude: { model: DEFAULT_CLAUDE_MODEL, apiKey: "" },
  jev: { model: "jev-latest", apiKey: "", relay: true, url: "api/relay/jev" },
  laya: { url: LAYA_URL },
};

export const BRAIN_LABELS: Record<LeaderChoice, string> = {
  rules: "Rules (in the page)",
  openai: "Qwen on the Spark, or any OpenAI-compatible LLM (Ollama…)",
  claude: "Claude (your key, or the server's)",
  jev: "Jev decision model (default; your key or the server's)",
  laya: "Laya decision model (on this machine)",
  none: "None (you drive it)",
  blind: "Blind test (a hidden brain each jam)",
};

export function mergeSettings(raw: unknown): BrainSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<BrainSettings>;
  const kinds = Object.keys(BRAIN_LABELS);
  return {
    kind: kinds.includes(r.kind as string) ? (r.kind as LeaderChoice) : DEFAULT_SETTINGS.kind,
    openai: { ...DEFAULT_SETTINGS.openai, ...(r.openai ?? {}) },
    claude: claudeSettings(r.claude),
    jev: { ...DEFAULT_SETTINGS.jev, ...(r.jev ?? {}) },
    laya: { ...DEFAULT_SETTINGS.laya, ...(r.laya ?? {}) },
  };
}

/** The companion server's Claude relay, used when the page has no key of its own. */
export const CLAUDE_RELAY = "api/relay/anthropic";
const absolute = (u: string) => (typeof location !== "undefined" ? new URL(u, location.href).href.replace(/\/$/, "") : u);

function claudeSettings(raw: Partial<BrainSettings["claude"]> | undefined): BrainSettings["claude"] {
  const c = { ...DEFAULT_SETTINGS.claude, ...(raw ?? {}) };
  // The model field was prefilled with the old default, so a saved copy of it wasn't a choice.
  if (c.model === OLD_DEFAULT_CLAUDE_MODEL && !c.modelChosen) c.model = DEFAULT_CLAUDE_MODEL;
  return c;
}

/** A provider for these settings, or null for "none". */
export function makeBrain(s: BrainSettings, fetchFn?: Fetch): BrainProvider | null {
  switch (s.kind) {
    case "none":
    case "blind": // resolve to a real brain first (brain/blind.ts)
      return null;
    case "rules":
      return new RulesBrain();
    case "openai":
      return new OpenAIBrain({ url: s.openai.url, model: s.openai.model, apiKey: s.openai.apiKey || undefined }, fetchFn);
    case "claude":
      // No key in the page: go through the companion server's relay, which adds its own.
      return new ClaudeBrain(
        s.claude.apiKey
          ? { apiKey: s.claude.apiKey, model: s.claude.model || DEFAULT_CLAUDE_MODEL }
          : { apiKey: "relay", model: s.claude.model || DEFAULT_CLAUDE_MODEL, baseURL: absolute(CLAUDE_RELAY) },
        fetchFn,
      );
    case "jev":
      return new JevBrain({ apiKey: s.jev.apiKey || undefined, model: s.jev.model || undefined, url: s.jev.relay ? s.jev.url : JEV_API }, fetchFn);
    case "laya":
      return new LayaBrain({ url: s.laya.url || LAYA_URL }, fetchFn);
  }
}
