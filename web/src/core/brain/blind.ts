// Blind test: each jam secretly uses one of the brains that work here; the
// player rates the jam after stopping, and the results are unblinded later.

import type { SessionFile } from "../session";
import type { BrainKind } from "./types";
import type { BrainSettings } from "./index";

export const BLIND_NAMES: Record<BrainKind, string> = { rules: "Rules", openai: "Qwen / LLM", claude: "Claude", jev: "Jev" };

/** What a recording says played in a blind jam: "blind:jev". */
export const blindLeader = (k: BrainKind) => `blind:${k}`;
export const isBlind = (leader: string | undefined) => !!leader?.startsWith("blind:");

/**
 * Brains that can run from this page: rules always; the OpenAI-compatible one
 * when its endpoint is reachable (the relay needs a server); Claude with a key;
 * Jev only through a server relay (TypeSafe refuses browser origins).
 */
export function blindCandidates(s: BrainSettings, env: { llmRelay: boolean; jevRelay: boolean }): BrainKind[] {
  const out: BrainKind[] = ["rules"];
  const relayUrl = (u: string) => u.startsWith("api/") || u.startsWith("./api/");
  if (s.openai.url && (!relayUrl(s.openai.url) || env.llmRelay)) out.push("openai");
  if (s.claude.apiKey) out.push("claude");
  if (s.jev.relay && env.jevRelay) out.push("jev");
  return out;
}

/** The least-tried brain so far (ties broken at random), so each gets its turns. */
export function pickBlind(cands: BrainKind[], tried: Partial<Record<BrainKind, number>>, rand: () => number = Math.random): BrainKind {
  if (!cands.length) throw new Error("no brain to pick from");
  const least = Math.min(...cands.map((k) => tried[k] ?? 0));
  const pool = cands.filter((k) => (tried[k] ?? 0) === least);
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

export interface BlindRating {
  /** 1 (bad) to 5 (great). */
  stars: number;
  note?: string;
  /** The brain fell back to rules at some point in the jam. */
  fallback?: boolean;
}

export interface BlindRow {
  brain: BrainKind;
  jams: number;
  rated: number;
  mean: number | null;
  notes: string[];
}

/** Per-brain results from kept sessions (only blind ones count). */
export function summarizeBlind(files: Pick<SessionFile, "leader" | "rating">[]): BlindRow[] {
  const rows = new Map<BrainKind, BlindRow>();
  for (const f of files) {
    if (!isBlind(f.leader)) continue;
    const k = f.leader.slice(6) as BrainKind;
    const r = rows.get(k) ?? { brain: k, jams: 0, rated: 0, mean: null, notes: [] };
    r.jams++;
    if (f.rating?.stars) {
      r.mean = ((r.mean ?? 0) * r.rated + f.rating.stars) / (r.rated + 1);
      r.rated++;
      if (f.rating.note) r.notes.push(f.rating.note);
    }
    rows.set(k, r);
  }
  return [...rows.values()].sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0));
}
