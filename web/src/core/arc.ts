// The song so far, and a plan for the next sections (v0.4, ADR-0021). The
// page keeps it and sends it with every request, so no brain needs memory
// (the server stays stateless, ADR-0008): what each section visit did, where
// the peak was, and how this visit and the next should differ from the last
// time through, by the genre's arc style:
//
// - build: each time round bigger (about +0.1) and fuller, the last time
//   through the biggest.
// - dynamic: each time round different from the last: down and thinner
//   after a big one, up and fuller after a quiet one.
// - locked: the same level, a different texture (one part in or out).
//
// The plan is advice. The rule leader follows it while the player is
// playing; LLM leaders read it with the rest of the summary. Following the
// player still comes first: a player who drops out in chorus 2 gets space,
// not a bigger chorus.

import type { BarPlan } from "./engine";
import type { ArcStyle } from "./leading";
import type { Feel, Part } from "./types";

/** One time through a section, as the band played it. */
export interface Visit {
  section: string;
  /** 1 for the first time through this section, 2 for the second… */
  pass: number;
  /** Mean intensity over the visit. */
  level: number;
  peak: number;
  /** Who played at the end of the visit. */
  parts: Part[];
  feel: Feel;
  bars: number;
}

/** How a section visit should differ from the last time through it. */
export interface ArcPlan {
  section: string;
  pass: number;
  /** Change of level against the last time through (0 the first time). */
  change: number;
  /** A level to aim for, null the first time through (follow the player). */
  aim: number | null;
  /** A part to bring in or take out for this visit, if any. */
  add: Part | null;
  drop: Part | null;
  /** The plan in a few words, for the LLM and the overlay. */
  idea: string;
}

/** What goes into the summary as `arc`. */
export interface ArcSummary {
  style: ArcStyle;
  /** The last section visits, oldest first (the one playing now not included). */
  so_far: { section: string; pass: number; level: number; peak: number; parts: Part[]; feel: Feel }[];
  /** The biggest visit so far. */
  peak: { section: string; pass: number; level: number } | null;
  /** The visit playing now, and its plan. */
  now: ArcPlan & { bars_left: number };
  /** The next section's plan; null when the song ends after this one. */
  next: ArcPlan | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const KEEP = 6;
/** Parts a texture change may take out (drums and bass hold the groove). */
const TEXTURE: Part[] = ["chords", "guitar", "pad", "percussion"];

interface Open {
  section: string;
  formPos: number;
  pass: number;
  sum: number;
  peak: number;
  bars: number;
  parts: Part[];
  feel: Feel;
}

export class SongArc {
  private visits: Visit[] = [];
  private open: Open | null = null;
  private passes = new Map<string, number>();

  constructor(
    public style: ArcStyle,
    private form: string[],
  ) {}

  /** Call once per bar played (count-in bars are skipped). */
  observe(plan: BarPlan): void {
    if (plan.kind === "count_in") return;
    const o = this.open;
    if (!o || plan.barInSection === 0 || plan.formPos !== o.formPos) {
      if (o) this.close(o);
      const pass = (this.passes.get(plan.section) ?? 0) + 1;
      this.passes.set(plan.section, pass);
      this.open = { section: plan.section, formPos: plan.formPos, pass, sum: 0, peak: 0, bars: 0, parts: [], feel: plan.feel };
    }
    const v = this.open!;
    v.sum += plan.intensity;
    v.peak = Math.max(v.peak, plan.intensity);
    v.bars++;
    v.parts = plan.layers;
    v.feel = plan.feel;
  }

  private close(o: Open): void {
    this.visits.push({ section: o.section, pass: o.pass, level: r2(o.sum / Math.max(1, o.bars)), peak: r2(o.peak), parts: o.parts, feel: o.feel, bars: o.bars });
  }

  /** The last finished visit of a section. */
  lastTime(section: string): Visit | null {
    for (let i = this.visits.length - 1; i >= 0; i--) if (this.visits[i].section === section) return this.visits[i];
    return null;
  }

  get history(): readonly Visit[] {
    return this.visits;
  }

  /** How many times the form has this section from position `formPos` on (this one included). */
  private remaining(section: string, formPos: number): number {
    return this.form.slice(formPos).filter((s) => s === section).length;
  }

  /** The plan for a visit of `section` (its `pass`-th), at form position `formPos`. */
  planFor(section: string, pass: number, formPos: number, lineup: Part[], avoid: (m: { move: string; part?: string }) => boolean = () => false): ArcPlan {
    const last = this.lastTime(section);
    const first: ArcPlan = { section, pass, change: 0, aim: null, add: null, drop: null, idea: "first time through: follow the player" };
    if (!last) return first;
    const missing = lineup.filter((p) => !last.parts.includes(p) && !avoid({ move: "add_layer", part: p }));
    const droppable = TEXTURE.filter((p) => last.parts.includes(p) && !avoid({ move: "drop_layer", part: p }));
    const lastOfSong = this.remaining(section, formPos) === 1 && formPos >= this.form.length - 2;
    const plan = (change: number, add: Part | null, drop: Part | null, idea: string): ArcPlan => ({
      section, pass, change, aim: r2(Math.max(0.1, Math.min(1, last.level + change))), add, drop, idea,
    });
    switch (this.style) {
      case "build": {
        const change = lastOfSong ? 0.18 : 0.12;
        const add = missing[0] ?? null;
        return plan(change, add, null, `${lastOfSong ? "the last time: the peak of the song" : "bigger than last time"}${add ? `, bring in the ${add}` : ""}`);
      }
      case "dynamic": {
        if (last.level >= 0.5) {
          const drop = droppable.includes("chords") ? "chords" : droppable[0] ?? null;
          return plan(-0.12, null, drop, `different from last time: take it down${drop ? `, the ${drop} lay out` : ""}`);
        }
        const add = missing[0] ?? null;
        return plan(0.12, add, null, `different from last time: dig in${add ? `, the ${add} back in` : ""}`);
      }
      case "locked": {
        const add = missing[0] ?? null;
        const drop = add ? null : droppable[droppable.length - 1] ?? null;
        const what = add ? `the ${add} in` : drop ? `the ${drop} out` : "same parts";
        return plan(0, add, drop, `same groove and level as last time, new texture: ${what}`);
      }
    }
  }

  /** The summary for a leader request made after `plan` finished. */
  summary(plan: BarPlan, nextSection: string | null, nextFormPos: number, avoid?: (m: { move: string; part?: string }) => boolean): ArcSummary {
    const done = this.visits.slice(-KEEP).map(({ section, pass, level, peak, parts, feel }) => ({ section, pass, level, peak, parts, feel }));
    const all = [...this.visits, ...(this.open ? [{ section: this.open.section, pass: this.open.pass, level: r2(this.open.sum / Math.max(1, this.open.bars)), peak: r2(this.open.peak) }] : [])];
    const top = all.reduce<{ section: string; pass: number; level: number } | null>((b, v) => (!b || v.peak > b.level ? { section: v.section, pass: v.pass, level: v.peak } : b), null);
    const pass = this.passes.get(plan.section) ?? 1;
    const now = { ...this.planNow(plan, pass, avoid), bars_left: Math.max(0, plan.sectionBars - plan.barInSection - 1) };
    let next: ArcPlan | null = null;
    if (nextSection !== null) {
      // The next visit compares with the latest time through, the one playing now included.
      const nextPass = (this.passes.get(nextSection) ?? 0) + 1;
      next = this.withOpen(() => this.planFor(nextSection, nextPass, nextFormPos, plan.lineup, avoid));
    }
    return { style: this.style, so_far: done, peak: top, now, next };
  }

  /** The plan for the visit playing now (made against the visits before it). */
  private planNow(plan: BarPlan, pass: number, avoid?: (m: { move: string; part?: string }) => boolean): ArcPlan {
    return this.planFor(plan.section, pass, plan.formPos, plan.lineup, avoid);
  }

  /** Run with the open visit counted as finished (for planning what comes after it). */
  private withOpen<T>(f: () => T): T {
    if (!this.open) return f();
    const n = this.visits.length;
    this.close(this.open);
    try {
      return f();
    } finally {
      this.visits.length = n;
    }
  }
}
