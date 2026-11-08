// The listening layer (v0.3): what the band hears beyond energy, in five
// groups the player can switch on and off under Bandleader. Each group adds
// its own fields to the summary every brain reads; a group that is off adds
// nothing, so the summary stays what v0.2 sent. Docs: docs/eval/scenarios.md
// and the listening-layer ADR.
//
//   position  where we are in the song: bars left, what comes next, phrase
//   rhythm    (PR 3b)
//   harmony   (PR 3c)
//   phrasing  (PR 3d)
//   dynamics  (PR 3e)

import type { Chart } from "./chart";
import type { BarPlan } from "./engine";

export const LISTENING_GROUPS = ["position", "rhythm", "harmony", "phrasing", "dynamics"] as const;
export type ListeningGroup = (typeof LISTENING_GROUPS)[number];
export type Listening = Record<ListeningGroup, boolean>;

export const LISTENING_LABELS: Record<ListeningGroup, string> = {
  position: "Song position",
  rhythm: "Rhythm",
  harmony: "Harmony",
  phrasing: "Phrasing",
  dynamics: "Dynamics",
};

/** Groups on by default, picked from the eval (docs/eval/results). */
export const DEFAULT_LISTENING: Listening = { position: true, rhythm: false, harmony: false, phrasing: false, dynamics: false };

export const NO_LISTENING: Listening = { position: false, rhythm: false, harmony: false, phrasing: false, dynamics: false };

/** "position,harmony", "all", "none" or "default" → groups. */
export function parseListening(s: string): Listening {
  const t = s.trim();
  if (t === "default") return { ...DEFAULT_LISTENING };
  if (t === "all") return Object.fromEntries(LISTENING_GROUPS.map((g) => [g, true])) as Listening;
  const out = { ...NO_LISTENING };
  if (t === "none" || t === "") return out;
  for (const g of t.split(",").map((x) => x.trim())) {
    if (!(LISTENING_GROUPS as readonly string[]).includes(g)) throw new Error(`Unknown listening group "${g}" (${LISTENING_GROUPS.join(", ")})`);
    out[g as ListeningGroup] = true;
  }
  return out;
}

/** The groups that are on, comma-separated ("none" when none). */
export function listeningKey(l: Listening): string {
  const on = LISTENING_GROUPS.filter((g) => l[g]);
  return on.length ? on.join(",") : "none";
}

/** What the listening layer heard after a bar: every group, on or off. */
export interface Heard {
  position: SongPosition;
}

// ---------- song position ----------

export interface SongPosition {
  /** Bars still to come in this section after the one just played. 0: the section changes on the next bar. */
  bars_left: number;
  /** The section that comes next in the form; null when the song ends after this one. */
  next_section: string | null;
  /** How hard the chart says this section plays (0–1); null when it doesn't say. */
  section_level: number | null;
  /** Whether the chart marks the next section bigger or smaller than this one; null when it doesn't say. */
  next_lift: "up" | "down" | "same" | null;
  /** Where the bar just played sits in its phrase. */
  phrase: "start" | "middle" | "end";
  /** Which time through this section this is, of how many in the form ("2 of 3"). */
  pass: string;
  /** This is the last section of the form. */
  last_section: boolean;
}

export function songPosition(chart: Chart, plan: BarPlan, loop: boolean): SongPosition {
  const form = chart.form;
  const atEnd = plan.formPos >= form.length - 1;
  const next = atEnd ? (loop ? form[0] : null) : form[plan.formPos + 1];
  const here = chart.sections.get(plan.section)?.intensity;
  const there = next ? chart.sections.get(next)?.intensity : undefined;
  const lift = here === undefined || there === undefined ? null : there > here + 0.05 ? "up" : there < here - 0.05 ? "down" : "same";
  const inPhrase = plan.barInSection % chart.phraseBars;
  const passes = form.filter((s) => s === plan.section).length;
  const pass = form.slice(0, plan.formPos + 1).filter((s) => s === plan.section).length;
  return {
    bars_left: Math.max(0, plan.sectionBars - plan.barInSection - 1),
    section_level: here ?? null,
    next_section: next,
    next_lift: next ? lift : null,
    phrase: inPhrase === 0 ? "start" : inPhrase === chart.phraseBars - 1 ? "end" : "middle",
    pass: `${Math.max(1, pass)} of ${passes}`,
    last_section: atEnd,
  };
}
