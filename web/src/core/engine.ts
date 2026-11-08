// The arranger (where are we in the song, how hard is the band playing) and
// the move governor (which moves are allowed to change that, and when).
// Pure and clock-free: the transport calls nextBar() once per bar, ahead of
// time, and plays what comes back.

import { bandParts, cloneBand, type Band } from "./band";
import type { Chart, ChordSlot } from "./chart";
import { applyFeel, applyRit } from "./feel";
import type { GenrePack } from "./genre";
import { getGenre } from "./genres";
import { GrooveGenerator } from "./groove";
import { describeMove, parseMove, type Move } from "./moves";
import { rngFor } from "./rand";
import { noteName, parseChord, parseKey, type Chord } from "./theory";
import { clamp, levelFor, type Feel, type NoteEvent, type Part, type Stinger } from "./types";

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
  /**
   * The chart's section intensity nudges the target at a new section, except
   * when the leader set the target within the last phrase (v0.3). Off: always
   * nudge (v0.2 and older sessions).
   */
  holdFreshTarget: boolean;
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
  holdFreshTarget: true,
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

/** Bar kinds: the count-in before the song, ordinary bars, and the last bar with the final hit. */
export type BarKind = "count_in" | "play" | "ending";

/** Everything a part generator gets to write one bar. */
export interface BarContext {
  bar: number;
  kind: BarKind;
  section: string;
  barInSection: number;
  sectionBars: number;
  barInPhrase: number;
  phraseBars: number;
  lastBarOfSection: boolean;
  level: number;
  feel: Feel;
  parts: Part[];
  /** The lineup with its instruments (a generator may play to the instrument). */
  band: Band;
  /** This bar's chords. */
  slots: ChordSlot[];
  /** First chord of the next bar (the tonic on an ending bar), null at the end of the form. */
  next: Chord | null;
  bpb: number;
  genre: GenrePack;
  seed: number;
  /** Stingers to play on the drums this bar (fill, crash, riser). */
  stingers: Stinger[];
  cymbal: "hat" | "ride";
  /** The final hit on the next downbeat, on an ending bar. */
  ending: { tonic: Chord; ringBeats: number } | null;
  /** The song's first chord, for the count-in's pickup. */
  firstChord: Chord | null;
  /** Drums are out but a stinger still plays: drums generate the stinger alone. */
  stingersOnly?: boolean;
}

/**
 * Mid layer. Returns the next bar for each requested part, or null for a part
 * that isn't ready (v1 models on the Spark may miss the deadline). A null
 * part repeats its previous bar. Notes are on the straight grid; the engine
 * adds swing and humanize afterwards.
 */
export interface PartGenerator {
  generate(ctx: BarContext): Partial<Record<Part, NoteEvent[] | null>>;
}

export interface BarPlan {
  bar: number;
  kind: BarKind;
  section: string;
  formPos: number;
  barInSection: number;
  sectionBars: number;
  chords: string[];
  intensity: number;
  target: number;
  level: number;
  layers: Part[];
  /** Who is in the band (playing or sitting out), and on what. */
  lineup: Part[];
  band: Band;
  feel: Feel;
  genre: string;
  swing: number;
  events: NoteEvent[];
  stingers: Stinger[];
  /** Moves resolved while preparing this bar (applied, deferred or rejected). */
  moves: MoveRecord[];
  /** Parts whose generator missed the deadline and repeated the last bar. */
  repeated: Part[];
}

/**
 * Anything that changed the band from outside, stamped with the last bar
 * prepared when it happened (`at`, -1 before the first). Recorded with a
 * session; replaying them at the same points reproduces the band exactly.
 */
export type Control =
  | { at: number; kind: "moves"; source: string; requestedBar: number; moves: unknown[] }
  | { at: number; kind: "genre"; genre: string }
  | { at: number; kind: "swing"; swing: number | null }
  | { at: number; kind: "band"; band: Band };

export interface EngineOptions {
  config?: Partial<GovernorConfig>;
  generator?: PartGenerator;
  intensity?: number;
  layers?: Part[];
  /** Seeds every choice the band makes (patterns, ghosts, timing). */
  seed?: number;
  /** Genre pack; defaults to the chart's genre. */
  genre?: GenrePack;
  /** Swing override for the whole song; null uses the chart and genre. */
  swing?: number | null;
  /** Lineup; defaults to the chart's band, then the genre's. */
  band?: Band;
  /** Count-in bars before the form (the page uses the chart's count_in; tests default to none). */
  countIn?: number;
  /** Controls to replay (a recorded session), applied at their bar. */
  script?: Control[];
}

interface Queued {
  move: Move;
  source: string;
  requestedBar: number;
}

export class Engine {
  readonly config: GovernorConfig;
  readonly seed: number;
  private generator: PartGenerator;
  private queue: Queued[] = [];
  private script: Control[];
  private scriptPos = 0;

  private bar = -1;
  private formPos = 0;
  private barInSection = -1;
  private extension = 0;
  private barsInVisit = 0;
  private done = false;
  private countInLeft: number;
  private countInTotal: number;

  intensity: number;
  genre: GenrePack;
  swingOverride: number | null;
  /** Bandleader's intensity target; null until it sets one (section hints rule until then). */
  private target: number | null = null;
  /** Bar the leader last set the target on (the chart doesn't nudge a fresh decision). */
  private targetSetAt = -Infinity;
  private layers: Set<Part>;
  band: Band;
  private feel: Feel = "normal";
  private lastLayerChange = new Map<Part, number>();
  private lastFeelChange = -Infinity;
  private lastStingerPhrase = -1;
  private stingers: Stinger[] = [];
  private pendingJump: Queued | null = null;
  private pendingEnd: Queued | null = null;
  private lastBars: Partial<Record<Part, NoteEvent[]>> = {};
  readonly log: MoveRecord[] = [];
  /** Every outside change, for session recording. */
  readonly controls: Control[] = [];

  constructor(
    readonly chart: Chart,
    opts: EngineOptions = {},
  ) {
    this.config = { ...DEFAULT_GOVERNOR, ...opts.config };
    this.seed = opts.seed ?? 1;
    this.generator = opts.generator ?? new GrooveGenerator();
    this.genre = opts.genre ?? getGenre(chart.genre);
    this.swingOverride = opts.swing ?? null;
    this.intensity = opts.intensity ?? this.sectionAt(0).intensity ?? 0.5;
    this.band = cloneBand(opts.band ?? chart.band ?? this.genre.band);
    this.layers = new Set(opts.layers ?? this.lineup);
    this.countInLeft = this.countInTotal = opts.countIn ?? 0;
    this.script = [...(opts.script ?? [])].sort((a, b) => a.at - b.at);
  }

  /** Queue moves from any source. They are resolved when the next bar is prepared. */
  submit(moves: unknown[], source: string, requestedBar = this.bar): MoveRecord[] {
    this.controls.push({ at: this.bar, kind: "moves", source, requestedBar, moves });
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

  /** Switch genre from the next bar on. */
  setGenre(genre: GenrePack): void {
    this.controls.push({ at: this.bar, kind: "genre", genre: genre.id });
    this.genre = genre;
  }

  /** Who is in the band: the band's parts that the genre has grooves for. */
  get lineup(): Part[] {
    return bandParts(this.band).filter((p) => this.genre.parts.includes(p));
  }

  /**
   * Change the lineup from the next bar on: parts that join start playing,
   * parts that leave stop. Instrument, volume and pan changes are sound-only
   * but are recorded too, so a replay sounds like the jam.
   */
  setBand(band: Band): void {
    const next = cloneBand(band);
    this.controls.push({ at: this.bar, kind: "band", band: cloneBand(next) });
    const before = new Set(bandParts(this.band));
    this.band = next;
    for (const p of bandParts(next)) if (!before.has(p)) this.layers.add(p);
    for (const p of [...this.layers]) if (!next[p]) this.layers.delete(p);
  }

  /** Override the swing from the next bar on (null: back to the chart's and genre's). */
  setSwing(swing: number | null): void {
    this.controls.push({ at: this.bar, kind: "swing", swing });
    this.swingOverride = swing;
  }

  get currentBar(): number {
    return this.bar;
  }

  get finished(): boolean {
    return this.done;
  }

  /** The song's tonic chord in the genre's ending colour: from the key, else from the first chord. */
  tonic(): Chord {
    const key = parseKey(this.chart.key);
    const first = this.sectionAt(0).barChords(0)[0].chord;
    const tonic = key ?? { tonic: first.root, minor: first.intervals.includes(3) && !first.intervals.includes(4) };
    const q = tonic.minor ? this.genre.ending.chordMinor : this.genre.ending.chordMajor;
    try {
      return parseChord(noteName(tonic.tonic) + q);
    } catch {
      return parseChord(noteName(tonic.tonic) + (tonic.minor ? "m" : ""));
    }
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
    if (this.pendingEnd && (m.move === "jump_to_section" || m.move === "extend_section")) return reject("the song is ending");

    switch (m.move) {
      case "set_intensity": {
        const current = this.target ?? this.intensity;
        if (Math.abs(m.value - current) < cfg.intensityDeadband) return reject("within deadband");
        this.target = m.value;
        this.targetSetAt = upcoming;
        return apply();
      }
      case "add_layer":
      case "drop_layer": {
        if (!this.lineup.includes(m.part)) return reject(`no ${m.part} in the lineup`);
        const has = this.layers.has(m.part);
        if (m.move === "add_layer" && has) return reject("already playing");
        if (m.move === "drop_layer" && !has) return reject("already out");
        if (upcoming - (this.lastLayerChange.get(m.part) ?? -Infinity) < cfg.layerDwellBars) return reject("changed too recently");
        if (m.move === "add_layer") this.layers.add(m.part);
        else this.layers.delete(m.part);
        this.lastLayerChange.set(m.part, upcoming);
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
      case "end_song":
        if (this.pendingEnd) return reject("already ending");
        this.pendingEnd = q;
        if (this.pendingJump) {
          this.record(this.pendingJump.move, this.pendingJump.source, this.pendingJump.requestedBar, "rejected", "the song is ending");
          this.pendingJump = null;
        }
        return this.record(m, source, requestedBar, "pending", "ending at the end of this phrase");
    }
  }

  /** Position the upcoming bar lands on, without jumps. Null at the end of a non-looping form. */
  private advance(): { formPos: number; barInSection: number } | null {
    if (this.barInSection < 0) return { formPos: 0, barInSection: 0 };
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

  /** Apply recorded controls stamped with the bar just prepared (session replay). */
  private runScript(): void {
    while (this.scriptPos < this.script.length && this.script[this.scriptPos].at <= this.bar) {
      const c = this.script[this.scriptPos++];
      if (c.kind === "moves") this.submit(c.moves, c.source, c.requestedBar);
      else if (c.kind === "genre") this.setGenre(getGenre(c.genre));
      else if (c.kind === "band") this.setBand(c.band);
      else this.setSwing(c.swing);
    }
  }

  /** Swing for a section: the page's override, then the section, the chart, the genre. */
  swingFor(section: string): number {
    return this.swingOverride ?? this.chart.sections.get(section)?.swing ?? this.chart.swing ?? this.genre.swing;
  }

  /** Swing, humanize and (on an ending) the ritardando, per part, seeded by bar. */
  private feelBar(parts: Partial<Record<Part, NoteEvent[]>>, bar: number, swing: number, ending: boolean): NoteEvent[] {
    const out: NoteEvent[] = [];
    for (const [p, evs] of Object.entries(parts) as [Part, NoteEvent[]][]) {
      const felt = applyFeel(evs, p, {
        swing,
        unit: this.genre.swingUnit,
        bpm: this.chart.bpm,
        humanize: this.genre.humanize[p],
        rand: rngFor(this.seed, "feel", p, bar),
      });
      out.push(...(ending ? applyRit(felt, this.chart.beatsPerBar, this.genre.ending.rit) : felt));
    }
    return out;
  }

  private context(partial: Omit<BarContext, "bpb" | "genre" | "seed" | "phraseBars" | "firstChord" | "band">): BarContext {
    return {
      ...partial,
      band: this.band,
      bpb: this.chart.beatsPerBar,
      genre: this.genre,
      seed: this.seed,
      phraseBars: this.chart.phraseBars,
      firstChord: this.sectionAt(0).barChords(0)[0].chord,
    };
  }

  private countInBar(resolved: MoveRecord[]): BarPlan {
    this.bar++;
    const i = this.countInTotal - this.countInLeft;
    this.countInLeft--;
    const isLast = this.countInLeft === 0;
    // Sticks click on every count-in (even with the drums sitting out); the bass joins the pickup.
    const parts: Part[] = this.lineup.includes("bass") ? ["drums", "bass"] : ["drums"];
    const ctx = this.context({
      bar: this.bar, kind: "count_in", section: "count-in", barInSection: i, sectionBars: this.countInTotal, barInPhrase: 0,
      lastBarOfSection: isLast, level: 1, feel: "normal", parts: isLast ? parts : ["drums"], slots: this.sectionAt(0).barChords(0),
      next: this.sectionAt(0).barChords(0)[0].chord, stingers: [], cymbal: "hat", ending: null,
    });
    const gen = this.generator.generate(ctx);
    const byPart: Partial<Record<Part, NoteEvent[]>> = {};
    for (const p of ctx.parts) byPart[p] = gen[p] ?? [];
    return {
      bar: this.bar, kind: "count_in", section: "count-in", formPos: 0, barInSection: i, sectionBars: this.countInTotal, chords: [],
      intensity: this.intensity, target: this.target ?? this.intensity, level: 1, layers: [], lineup: this.lineup, band: this.band, feel: this.feel, genre: this.genre.id,
      swing: this.swingFor(this.chart.form[0]), events: this.feelBar(byPart, this.bar, this.swingFor(this.chart.form[0]), false),
      stingers: [], moves: resolved, repeated: [],
    };
  }

  /** Prepare the next bar. Returns null once the form (or its ending) has finished. */
  nextBar(): BarPlan | null {
    if (this.done) return null;
    this.runScript();
    const upcoming = this.bar + 1;
    const cfg = this.config;
    const resolved: MoveRecord[] = [];

    const queued = this.queue;
    this.queue = [];
    for (const q of queued) resolved.push(this.resolve(q, upcoming));

    if (this.countInLeft > 0) return this.countInBar(resolved);

    // Horizontal resequencing: a pending jump lands on a phrase boundary once
    // the section has had its minimum length.
    let pos = this.advance();
    const started = this.barInSection >= 0;
    if (this.pendingJump && started) {
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
    // The chart nudges, the leader still leads: a target the leader set within
    // the last phrase is a fresh decision and stands (v0.3).
    if (newSection && this.bar > this.countInTotal && section.intensity !== undefined && this.target !== null && !(cfg.holdFreshTarget && this.bar - this.targetSetAt <= this.chart.phraseBars))
      this.target = (this.target + section.intensity) / 2;

    // Smooth intensity toward the goal.
    const goal = this.target ?? section.intensity ?? this.intensity;
    this.intensity = clamp(this.intensity + clamp(goal - this.intensity, -cfg.maxIntensityStep, cfg.maxIntensityStep), 0, 1);
    const level = levelFor(this.intensity);

    // Endings: on cue at the end of the phrase, or at the end of a form that doesn't loop.
    const lastBarOfSection = this.barInSection === this.sectionLength() - 1;
    const barInPhrase = this.barInSection % this.chart.phraseBars;
    const phraseEnd = barInPhrase === this.chart.phraseBars - 1 || lastBarOfSection;
    const formEnd = !cfg.loop && lastBarOfSection && this.formPos === this.chart.form.length - 1 && !this.pendingJump;
    const ending = (this.pendingEnd !== null && phraseEnd) || formEnd;
    if (ending && this.pendingEnd) {
      resolved.push(this.record(this.pendingEnd.move, this.pendingEnd.source, this.pendingEnd.requestedBar, "applied", "final hit on the next downbeat"));
    }
    const tonic = ending ? this.tonic() : null;

    // Stingers: requested ones plus automatic section transitions.
    const phraseId = this.bar - barInPhrase;
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
    const next = ending ? tonic : this.peekNextChord();
    if (cfg.autoFills && this.layers.has("drums") && level >= 1) {
      if (lastBarOfSection && next && !stingers.includes("fill")) stingers.push("fill");
      if (newSection && this.bar > this.countInTotal && !stingers.includes("crash")) stingers.push("crash");
    }
    if (ending && this.layers.has("drums") && !stingers.includes("fill")) stingers.push("fill");

    // Mid layer: one bar per active part, repeating the last bar on a miss.
    const parts = this.lineup.filter((p) => this.layers.has(p));
    const ctx = this.context({
      bar: this.bar, kind: ending ? "ending" : "play", section: name, barInSection: this.barInSection, sectionBars: this.sectionLength(),
      barInPhrase, lastBarOfSection, level, feel: this.feel, parts, slots: section.barChords(this.barInSection), next, stingers,
      cymbal: section.cymbal ?? this.genre.drums.cymbalSections[name] ?? this.genre.drums.cymbal,
      ending: tonic ? { tonic, ringBeats: this.genre.ending.ringBeats } : null,
    });
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
    // Drums out but a stinger (or the final hit) asked for: drums play just that.
    if (!parts.includes("drums") && this.lineup.includes("drums") && (stingers.length || ending)) {
      const only = this.generator.generate({ ...ctx, parts: ["drums"], stingersOnly: true }).drums;
      if (only) byPart.drums = only;
    }

    const swing = this.swingFor(name);
    const events = this.feelBar(byPart, this.bar, swing, ending);
    if (ending) this.done = true;
    return {
      bar: this.bar,
      kind: ending ? "ending" : "play",
      section: name,
      formPos: this.formPos,
      barInSection: this.barInSection,
      sectionBars: this.sectionLength(),
      chords: section.barChords(this.barInSection).map((s) => s.chord.symbol),
      intensity: this.intensity,
      target: goal,
      level,
      layers: parts,
      lineup: this.lineup,
      band: this.band,
      feel: this.feel,
      genre: this.genre.id,
      swing,
      events,
      stingers,
      moves: resolved,
      repeated,
    };
  }
}
