// The listening layer (v0.3): what the band hears beyond energy, in five
// groups the player can switch on and off under Bandleader. Each group adds
// its own fields to the summary every brain reads; a group that is off adds
// nothing, so the summary stays what v0.2 sent. Docs: docs/eval/scenarios.md
// and the listening-layer ADR.
//
//   position  where we are in the song: bars left, what comes next, phrase
//   rhythm    syncopation, swing, ahead of / behind the beat, rushing or dragging
//   harmony   (PR 3c)
//   phrasing  (PR 3d)
//   dynamics  (PR 3e)

import type { Chart } from "./chart";
import type { BarPlan } from "./engine";
import type { PlayedNote } from "./features";

export const LISTENING_GROUPS = ["position", "rhythm", "harmony", "phrasing", "dynamics"] as const;
export type ListeningGroup = (typeof LISTENING_GROUPS)[number];
export type Listening = Record<ListeningGroup, boolean>;
/** The groups built so far (the page offers these). */
export const LISTENING_READY: ListeningGroup[] = ["position", "rhythm"];

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
  rhythm: Rhythm;
}

/** The bars the note-based groups listen over: the last phrase, oldest first. */
export interface HeardBar {
  plan: BarPlan;
  notes: PlayedNote[];
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

// ---------- rhythm ----------

export interface Rhythm {
  /** How far off the beat their notes start: 0 all on the beat, 0.5 off-beat eighths, 1 all off-beat sixteenths. Null when silent. */
  syncopation: number | null;
  /** How much their off-beat eighths swing: 0 straight, 0.66 triplet, 1 dotted. Null when there aren't enough eighths to tell. */
  swing: number | null;
  /** Where their on-beat notes sit against the band's beat. Null when there are too few to tell. */
  timing: "ahead" | "on" | "behind" | null;
  /** Mean offset of their on-beat notes, in ms (negative: ahead). */
  timing_ms: number | null;
  /** Whether they drift against the band's tempo inside the bar. Null when there are too few notes to tell. */
  tempo: "rushing" | "dragging" | "steady" | null;
}

/** An onset this close to a beat (in beats) counts as on that beat for timing. */
const ON_BEAT = 0.18;
/** Ahead or behind by more than this many ms. */
export const TIMING_MS = 20;
/** Rushing or dragging: drift of more than this many beats per beat (1.5%). */
const DRIFT = 0.015;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function rhythmOf(bars: PlayedNote[][], beatsPerBar: number, bpm: number): Rhythm {
  const onsets = bars.map((ns) => ns.filter((n) => n.start > -0.5 && n.start < beatsPerBar).map((n) => n.start));
  const all = onsets.flat();
  if (!all.length) return { syncopation: null, swing: null, timing: null, timing_ms: null, tempo: null };

  // Timing: on-beat notes' offset from their beat; drift: how that offset grows across the bar.
  const pts: { x: number; y: number }[] = [];
  for (const os of onsets) {
    const bar = os.flatMap((t) => {
      const beat = Math.round(t);
      return Math.abs(t - beat) <= ON_BEAT && beat < beatsPerBar ? [{ x: beat, y: t - beat }] : [];
    });
    pts.push(...bar);
  }
  let timing: Rhythm["timing"] = null;
  let timingMs: number | null = null;
  let tempo: Rhythm["tempo"] = null;
  if (pts.length >= 4) {
    const shift = mean(pts.map((p) => p.y));
    timingMs = Math.round((shift * 60000) / bpm);
    timing = timingMs < -TIMING_MS ? "ahead" : timingMs > TIMING_MS ? "behind" : "on";
    // Slope of offset against beat position, bar by bar (each bar centred on its own mean).
    let num = 0;
    let den = 0;
    for (const os of onsets) {
      const b = os.flatMap((t) => (Math.abs(t - Math.round(t)) <= ON_BEAT && Math.round(t) < beatsPerBar ? [{ x: Math.round(t), y: t - Math.round(t) }] : []));
      if (b.length < 2) continue;
      const mx = mean(b.map((p) => p.x));
      const my = mean(b.map((p) => p.y));
      for (const p of b) {
        num += (p.x - mx) * (p.y - my);
        den += (p.x - mx) ** 2;
      }
    }
    if (den > 0) {
      const slope = num / den;
      tempo = slope < -DRIFT ? "rushing" : slope > DRIFT ? "dragging" : "steady";
    }
  }

  // Syncopation and swing. A note within ON_BEAT of a beat, once the bar's
  // own push or drift is taken out, is on it. Off the beat: an eighth (0.4–0.82
  // of the beat, straight or swung) counts 0.5 in a bar with no sixteenths;
  // anything else counts 1, except the straight off-beat eighth in a bar of
  // sixteenths (0.5).
  let sync = 0;
  const eighths: number[] = [];
  for (const os of onsets) {
    // Take out the bar's own push or drift first: the median offset from the
    // nearest beat, when most notes agree on it (sixteenths either side of a
    // beat don't).
    const near = os.map((t) => t - Math.round(t)).filter((d) => Math.abs(d) <= 0.35).sort((a, b) => a - b);
    const agree = near.length >= 2 && near.length >= os.length / 2 && near[near.length - 1] - near[0] <= 0.15;
    const barShift = agree ? near[Math.floor(near.length / 2)] : 0;
    const fr = os.map((t) => t - barShift - Math.floor(t - barShift)).filter((f) => f > ON_BEAT && f < 1 - ON_BEAT);
    const sixteenths = fr.some((f) => f < 0.4);
    for (const f of fr) {
      if (!sixteenths && f >= 0.4) {
        sync += 0.5;
        eighths.push(f);
      } else sync += sixteenths && f >= 0.4 && f <= 0.6 ? 0.5 : 1;
    }
  }
  // Swing only when their eighths agree on where the off-beat sits.
  const sd = eighths.length ? Math.sqrt(mean(eighths.map((f) => (f - mean(eighths)) ** 2))) : 1;
  const swing = eighths.length >= 3 && sd < 0.06 ? r2(Math.min(1, Math.max(0, (mean(eighths) - 0.5) * 4))) : null;
  return { syncopation: r2(sync / all.length), swing, timing, timing_ms: timingMs, tempo };
}
