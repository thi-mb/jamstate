// Move checking, moved from the Python server (ADR-0015). Keeps malformed
// brain output away from the engine and reports why; the governor still
// checks every move against the song.

import { parseMove, PLAYER_ONLY_MOVES, type Move } from "../moves";
import type { Rejected } from "./types";

export const MAX_MOVES = 2;
export const MAX_REASON = 120;

/** An error string, or null if the move is well-formed for a brain to send. */
export function checkMove(raw: unknown, sections?: string[]): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "move must be an object";
  const m = raw as Record<string, unknown>;
  if (typeof m.reason !== "string" || !m.reason.trim()) return "reason is required";
  if (PLAYER_ONLY_MOVES.includes(m.move as Move["move"])) return `${String(m.move)} is the player's call`;
  const parsed = parseMove(raw);
  if ("error" in parsed) return parsed.error;
  if (parsed.move.move === "jump_to_section" && sections && !sections.includes(parsed.move.section))
    return `section must be one of ${sections.join(", ")}`;
  return null;
}

/** A long reason is cut at a word boundary rather than losing the move over wording. */
export function shortenReason(r: string): string {
  const t = r.trim();
  if (t.length <= MAX_REASON) return t;
  const cut = t.slice(0, MAX_REASON - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > MAX_REASON / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.—-]+$/, "")}…`;
}

function withShortReason(m: unknown): unknown {
  if (!m || typeof m !== "object" || Array.isArray(m)) return m;
  const r = (m as { reason?: unknown }).reason;
  return typeof r === "string" && r.length > MAX_REASON ? { ...m, reason: shortenReason(r) } : m;
}

/** Split a brain's reply into checked moves and rejected ones. */
export function splitMoves(payload: unknown, sections?: string[]): { moves: Move[]; rejected: Rejected[] } {
  const raw = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { moves?: unknown }).moves : payload;
  if (!Array.isArray(raw)) return { moves: [], rejected: [{ move: payload, error: "reply has no moves list" }] };
  const moves: Move[] = [];
  const rejected: Rejected[] = [];
  for (const m0 of raw) {
    const m = withShortReason(m0);
    const err = checkMove(m, sections);
    if (err) rejected.push({ move: m, error: err });
    else if (moves.length >= MAX_MOVES) rejected.push({ move: m, error: `more than ${MAX_MOVES} moves` });
    else moves.push((parseMove(m) as { move: Move }).move);
  }
  return { moves, rejected };
}

/** Parse JSON out of a model reply, tolerating code fences, <think> blocks and chatter. */
export function extractJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  t = t.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new Error(`model did not return JSON: ${JSON.stringify(t.slice(0, 200))}`);
}
