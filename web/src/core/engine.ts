// The arranger (where are we in the song, how hard is the band playing) and
// the move governor (which moves are allowed to change that, and when).
// Pure and clock-free: the transport calls nextBar() once per bar, ahead of
// time, and plays what comes back.

import { crashHit, LoopBank, riser, withFill } from "./bank";
import type { Chart } from "./chart";
import { describeMove, parseMove, type Move } from "./moves";
import type { Chord } from "./theory";
import { clamp, levelFor, PARTS, type Feel, type NoteEvent, type Part, type Stinger } from "./types";

/** Governor rules. Starting points, to be tuned by ear (see docs/decisions). */
export interface GovernorConfig {
  /** Bars a section must play before a jump can leave it. */
  minSectionBars: number;
  /** Bars before the same part can be added/dropped again. */
  layerDwellBars: number;
  /** Bars before the feel can change again. */
  feelDwellBars: number;
  /** Max intensity change per bar (smoothing). */
  maxIntensityStep: number;
  /** set_intensity targets closer than this to the current target are ignored. */
  intensityDeadband: number;
  /** Moves older than this many bars when they arrive are dropped. */
  ttlBars: number;
  /** Upper bound on extend_section per section visit (also capped at the section's length). */
  maxExtensionBars: number;
  /** At most one stinger per phrase. */
  oneStingerPerPhrase: boolean;
  /** Automatic fill into a new section and crash on its downbeat. */
  autoFills: boolean;
  /** Go back to the top of the form at the end instead of stopping. */
  loop: boolean;
}

export const DEFAULT_GOVERNOR: GovernorConfig = {
  minSectionBars: 4,
  layerDwellBars: 2,
  feelDwellBars: 4,
  maxIntensityStep: 0.2,
  intensityDeadband: 0.1,
  ttlBars: 8,
  maxExtensionBars: 16,
  oneStingerPerPhrase: true,
  autoFills: true,
  loop: false,
};

export type MoveStatus = "applied" | "pending" | "rejected";

export interface MoveRecord {
  move: Move;
  label: string;
  source: string;
  requestedBar: number;
  resolvedBar: number;
  status: MoveStatus;
  note?: string;
}

export interface BarContext {
  bar: number;
  section: string;
  barInSection: number;
  level: number;
  feel: Feel;
  parts: Part[];
  next: Chord | null;
}

/**
 * Mid layer. Returns the next bar for each requested part, or null for a part
 * that isn't ready (v1 models on the Spark may miss the deadline). A null
 * part repeats its previous bar.
 */
export interface PartGenerator {
  generate(ctx: BarContext): Partial<Record<Part, NoteEvent[] | null>>;
}

export class BankGenerator implements PartGenerator {
  constructor(private bank: LoopBank) {}
  generate(ctx: BarContext) {
    const out: Partial<Record<Part, NoteEvent[]>> = {};
    for (const p of ctx.parts) out[p] = this.bank.bar(p, ctx.section, ctx.barInSection, ctx.level, ctx.feel, ctx.next);
    return out;
  }
}

export interface BarPlan {
  bar: number;
  section: string;
  formPos: number;
  barInSection: number;
  sectionBars: number;
  chords: string[];
  intensity: number;
  target: number;
  level: number;
  layers: Part[];
  feel: Feel;
  events: NoteEvent[];
  stingers: Stinger[];
  /** Moves resolved while preparing this bar (applied, deferred or rejected). */
  moves: MoveRecord[];
  /** Parts whose generator missed the deadline and repeated the last bar. */
  repeated: Part[];
}

interface Queued {
  move: Move;
  source: string;
  requestedBar: number;
}

export class Engine {
  readonly config: GovernorConfig;
  private generator: PartGenerator;
  private queue: Queued[] = [];

  private bar = -1;
  private formPos = 0;
  private barInSection = -1;
  private extension = 0;
  private barsInVisit = 0;
  private done = false;

  intensity: number;
  /** Bandleader's intensity target; null until it sets one (section hints rule until then). */
  private target: number | null = null;
  private layers = new Set<Part>(PARTS);
  private feel: Feel = "normal";
  private lastLayerChange: Record<Part, number> = { drums: -Infinity, bass: -Infinity, chords: -Infinity };
  private lastFeelChange = -Infinity;
  private lastStingerPhrase = -1;
  private stingers: Stinger[] = [];
  private pendingJump: Queued | null = null;
  private lastBars: Partial<Record<Part, NoteEvent[]>> = {};
  readonly log: MoveRecord[] = [];

  constructor(
    readonly chart: Chart,
    opts: { config?: Partial<GovernorConfig>; generator?: PartGenerator; intensity?: number; layers?: Part[] } = {},
  ) {
    this.config = { ...DEFAULT_GOVERNOR, ...opts.config };
    this.generator = opts.generator ?? new BankGenerator(new LoopBank(chart));
    this.intensity = opts.intensity ?? this.sectionAt(0).intensity ?? 0.5;
    if (opts.layers) this.layers = new Set(opts.layers);
  }

  /** Queue moves from any source. They are resolved when the next bar is prepared. */
  submit(moves: unknown[], source: string, requestedBar = this.bar): MoveRecord[] {
    const rejected: MoveRecord[] = [];
    for (const raw of moves) {
      const parsed = parseMove(raw);
      if ("error" in parsed) {
        const m = { move: "set_intensity", value: 0, reason: "" } as Move;
        rejected.push(this.record(m, source, requestedBar, "rejected", `invalid: ${parsed.error}`, `${JSON.stringify(raw)}`));
      } else this.queue.push({ move: parsed.move, source, requestedBar });
    }
    return rejected;
  }

  get currentBar(): number {
    return this.bar;
  }

  get finished(): boolean {
    return this.done;
  }

  private sectionAt(formPos: number) {
    return this.chart.sections.get(this.chart.form[formPos])!;
  }

  private sectionLength(): number {
    return this.sectionAt(this.formPos).bars + this.extension;
  }

  private record(move: Move, source: string, requestedBar: number, status: MoveStatus, note?: string, label?: string): MoveRecord {
    const r: MoveRecord = { move, label: label ?? describeMove(move), source, requestedBar, resolvedBar: this.bar + 1, status, note };
    this.log.push(r);
    if (this.log.length > 200) this.log.shift();
    return r;
  }

  /** Apply one queued move to state for the upcoming bar. */
  private resolve(q: Queued, upcoming: number): MoveRecord {
    const { move: m, source, requestedBar } = q;
    const cfg = this.config;
    const reject = (note: string) => this.record(m, source, requestedBar, "rejected", note);
    const apply = (note?: string) => this.record(m, source, requestedBar, "applied", note);
    if (upcoming - requestedBar > cfg.ttlBars) return reject(`expired (${upcoming - requestedBar} bars old)`);

    switch (m.move) {
      case "set_intensity": {
        const current = this.target ?? this.intensity;
        if (Math.abs(m.value - current) < cfg.intensityDeadband) return reject("within deadband");
        this.target = m.value;
        return apply();
      }
      case "add_layer":
      case "drop_layer": {
        const has = this.layers.has(m.part);
        if (m.move === "add_layer" && has) return reject("already playing");
        if (m.move === "drop_layer" && !has) return reject("already out");
        if (upcoming - this.lastLayerChange[m.part] < cfg.layerDwellBars) return reject("changed too recently");
        if (m.move === "add_layer") this.layers.add(m.part);
        else this.layers.delete(m.part);
        this.lastLayerChange[m.part] = upcoming;
        return apply();
      }
      case "change_feel":
        if (m.feel === this.feel) return reject("already in that feel");
        if (upcoming - this.lastFeelChange < cfg.feelDwellBars) return reject("changed too recently");
        this.feel = m.feel;
        this.lastFeelChange = upcoming;
        return apply();
      case "fire_stinger":
        this.stingers.push(m.stinger);
        return apply();
      case "extend_section": {
        const cap = Math.min(cfg.maxExtensionBars, this.sectionAt(this.formPos).bars);
        const add = Math.min(m.bars, cap - this.extension);
        if (add <= 0) return reject("section already extended to the cap");
        this.extension += add;
        return apply(add < m.bars ? `capped to ${add} bars` : undefined);
      }
      case "jump_to_section":
        if (!this.chart.form.includes(m.section)) return reject(`no section "${m.section}" in the form`);
        if (this.pendingJump) this.record(this.pendingJump.move, this.pendingJump.source, this.pendingJump.requestedBar, "rejected", "replaced by a newer jump");
        this.pendingJump = q;
        return this.record(m, source, requestedBar, "pending", "waiting for the next phrase");
    }
  }

  /** Position the upcoming bar lands on, without jumps. Null at the end of a non-looping form. */
  private advance(): { formPos: number; barInSection: number } | null {
    if (this.bar < 0) return { formPos: 0, barInSection: 0 };
    if (this.barInSection + 1 < this.sectionLength()) return { formPos: this.formPos, barInSection: this.barInSection + 1 };
    if (this.formPos + 1 < this.chart.form.length) return { formPos: this.formPos + 1, barInSection: 0 };
    return this.config.loop ? { formPos: 0, barInSection: 0 } : null;
  }

  /** Next occurrence of a section in the form after the current position (wrapping). */
  private jumpTarget(name: string): number {
    const form = this.chart.form;
    for (let i = 1; i <= form.length; i++) {
      const p = (this.formPos + i) % form.length;
      if (form[p] === name) return p;
    }
    return -1;
  }

  private peekNextChord(): Chord | null {
    const s = this.sectionAt(this.formPos);
    if (this.barInSection + 1 < this.sectionLength()) return s.barChords(this.barInSection + 1)[0].chord;
    const nextPos = this.formPos + 1 < this.chart.form.length ? this.formPos + 1 : this.config.loop ? 0 : -1;
    if (nextPos < 0) return null;
    return this.sectionAt(nextPos).barChords(0)[0].chord;
  }

  /** Prepare the next bar. Returns null once the form has finished. */
  nextBar(): BarPlan | null {
    if (this.done) return null;
    const upcoming = this.bar + 1;
    const cfg = this.config;
    const resolved: MoveRecord[] = [];

    const queued = this.queue;
    this.queue = [];
    for (const q of queued) resolved.push(this.resolve(q, upcoming));

    // Horizontal resequencing: a pending jump lands on a phrase boundary once
    // the section has had its minimum length.
    let pos = this.advance();
    if (this.pendingJump && this.bar >= 0) {
      const pj = this.pendingJump;
      const target = (pj.move as Extract<Move, { move: "jump_to_section" }>).section;
      const atBoundary = pos === null || pos.barInSection === 0 || pos.barInSection % this.chart.phraseBars === 0;
      if (upcoming - pj.requestedBar > cfg.ttlBars) {
        resolved.push(this.record(pj.move, pj.source, pj.requestedBar, "rejected", "expired before a phrase boundary"));
        this.pendingJump = null;
      } else if (atBoundary && this.barsInVisit >= cfg.minSectionBars) {
        pos = { formPos: this.jumpTarget(target), barInSection: 0 };
        resolved.push(this.record(pj.move, pj.source, pj.requestedBar, "applied", "on phrase boundary"));
        this.pendingJump = null;
      }
    }
    if (pos === null) {
      this.done = true;
      return null;
    }

    const newSection = pos.barInSection === 0;
    this.bar = upcoming;
    this.formPos = pos.formPos;
    this.barInSection = pos.barInSection;
    if (newSection) {
      this.extension = 0;
      this.barsInVisit = 0;
    }
    this.barsInVisit++;

    const name = this.chart.form[this.formPos];
    const section = this.sectionAt(this.formPos);
    if (newSection && this.bar > 0 && section.intensity !== undefined && this.target !== null)
      this.target = (this.target + section.intensity) / 2; // the chart nudges, the leader still leads

    // Smooth intensity toward the goal.
    const goal = this.target ?? section.intensity ?? this.intensity;
    this.intensity = clamp(this.intensity + clamp(goal - this.intensity, -cfg.maxIntensityStep, cfg.maxIntensityStep), 0, 1);
    const level = levelFor(this.intensity);

    // Mid layer: one bar per active part, repeating the last bar on a miss.
    const parts = PARTS.filter((p) => this.layers.has(p));
    const next = this.peekNextChord();
    const ctx: BarContext = { bar: this.bar, section: name, barInSection: this.barInSection, level, feel: this.feel, parts, next };
    const generated = this.generator.generate(ctx);
    const repeated: Part[] = [];
    const byPart: Partial<Record<Part, NoteEvent[]>> = {};
    for (const p of parts) {
      const got = generated[p];
      if (got) byPart[p] = got;
      else {
        byPart[p] = this.lastBars[p] ?? [];
        repeated.push(p);
      }
      this.lastBars[p] = byPart[p];
    }

    // Stingers: requested ones plus automatic section transitions.
    const phraseId = this.bar - (this.barInSection % this.chart.phraseBars);
    let stingers = this.stingers;
    this.stingers = [];
    if (cfg.oneStingerPerPhrase && stingers.length) {
      if (this.lastStingerPhrase === phraseId) {
        for (const s of stingers) resolved.push(this.record({ move: "fire_stinger", stinger: s, reason: "" }, "governor", this.bar, "rejected", "one stinger per phrase"));
        stingers = [];
      } else {
        stingers = [stingers[stingers.length - 1]];
        this.lastStingerPhrase = phraseId;
      }
    }
    const lastBarOfSection = this.barInSection === this.sectionLength() - 1;
    if (cfg.autoFills && this.layers.has("drums") && level >= 1) {
      if (lastBarOfSection && this.peekNextChord() && !stingers.includes("fill")) stingers.push("fill");
      if (newSection && this.bar > 0 && !stingers.includes("crash")) stingers.push("crash");
    }
    const bpb = this.chart.beatsPerBar;
    let drums = byPart.drums ?? [];
    for (const s of stingers) {
      if (s === "fill") drums = withFill(drums, bpb, Math.max(level, 1));
      else if (s === "crash") drums = [...drums.filter((e) => e.start > 0), ...crashHit(level)];
      else drums = [...drums, ...riser(bpb)];
    }
    if (stingers.length || byPart.drums) byPart.drums = drums;

    const events = PARTS.flatMap((p) => byPart[p] ?? []);
    return {
      bar: this.bar,
      section: name,
      formPos: this.formPos,
      barInSection: this.barInSection,
      sectionBars: this.sectionLength(),
      chords: section.barChords(this.barInSection).map((s) => s.chord.symbol),
      intensity: this.intensity,
      target: goal,
      level,
      layers: parts,
      feel: this.feel,
      events,
      stingers,
      moves: resolved,
      repeated,
    };
  }
}
