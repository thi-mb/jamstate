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
import { DEFAULT_PERSONALITY, leadingStyle, type LeadingStyle, type Personality } from "./leading";
import { describeMove, parseMove, type Move } from "./moves";
import { rngFor } from "./rand";
import { Soloist, type Solo } from "./solo";
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
 * that isn't ready (a model-based generator may miss the deadline). A null
 * part repeats its previous bar. Notes are on the straight grid; the engine
 * adds swing and humanize afterwards.
 */
export interface PartGenerator {
  generate(ctx: BarContext): Partial<Record<Part, NoteEvent[] | null>>;
}

export interface BarPlan {
  bar: number;
  /** The band's tempo for this bar (the chart's, unless Follow my tempo moved it). */
  bpm: number;
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
  /** Trading fours is on (v0.4). */
  trading?: boolean;
  /** A band turn while trading: who solos, and which bar of the turn this is. */
  solo?: { part: Part; bar: number; of: number } | null;
}

/**
 * Anything that changed the band from outside, stamped with the last bar
 * prepared when it happened (`at`, -1 before the first). Recorded with a
 * session; replaying them at the same points reproduces the band exactly.
 */
export type Control =
  | { at: number; kind: "moves"; source: string; requestedBar: number; moves: unknown[] }
  | { at: number; kind: "cue"; cue: Cue; by?: "voice" }
  | { at: number; kind: "tempo"; bpm: number }
  | { at: number; kind: "genre"; genre: string }
  | { at: number; kind: "swing"; swing: number | null }
  | { at: number; kind: "band"; band: Band }
  | { at: number; kind: "personality"; personality: Personality }
  | { at: number; kind: "trade"; on: boolean }
  | { at: number; kind: "solo"; solo: Solo | null };

/**
 * The player's cues (v0.3), on keys 1–7. Breaks, build and take it down land
 * on the next bar; next section, one more and end song on the next phrase.
 * After a cue lands the leader can't undo it for a phrase (the lockout).
 */
export const CUES = ["next_section", "drums_break", "drums_only", "build", "take_down", "one_more", "end_song"] as const;
export type Cue = (typeof CUES)[number];
export const CUE_LABELS: Record<Cue, string> = {
  next_section: "Next section",
  drums_break: "Drums/perc break",
  drums_only: "Drums/perc only",
  build: "Build",
  take_down: "Take it down",
  one_more: "One more",
  end_song: "End song",
};
/** The cue on key 1, 2, … 7. */
export const cueForKey = (key: string): Cue | undefined => CUES[Number(key) - 1];
/** How far build and take it down move the target. */
export const CUE_STEP = 0.25;
const PERC: Part[] = ["drums", "percussion"];

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
  /**
   * The bandleader's personality (v0.4): sets the governor's dwell times and
   * deadband within the genre's range. Left out (sessions from before v0.4),
   * the governor keeps its own settings.
   */
  personality?: Personality;
}

interface Queued {
  move: Move;
  source: string;
  requestedBar: number;
  /** A cue's jump: the form position to land on, with no minimum section length. */
  formPos?: number;
}

/** After a cue: which leader moves the governor rejects, up to and including bar `until`. */
interface Lockout {
  cue: Cue;
  until: number;
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
  /** The band's tempo; changes land on the next bar. */
  bpm: number;
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
  private cues: Cue[] = [];
  private lockout: Lockout | null = null;
  /** A drums/perc break or drums/perc only, through bar `until`. */
  private breakCue: { cue: "drums_break" | "drums_only"; until: number } | null = null;
  /** A stinger a cue asked for: not subject to one stinger per phrase. */
  private cueStinger: Stinger | null = null;
  private lastBars: Partial<Record<Part, NoteEvent[]>> = {};
  /** The bandleader's personality; null: the governor as configured (pre-v0.4). */
  personality: Personality | null;
  /** Trading fours (v0.4): the player's gaps are the band's turns. */
  trading = false;
  /** The band's turn while trading, from its first bar to its last. */
  private solo: Solo | null = null;
  private soloist: Soloist;
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
    this.bpm = chart.bpm;
    this.script = [...(opts.script ?? [])].sort((a, b) => a.at - b.at);
    this.personality = opts.personality ?? null;
    this.soloist = new Soloist(this.seed, chart);
    this.applyLeading();
  }

  /** The genre's leading taste with the personality applied (supportive when none is set). */
  get leading(): LeadingStyle {
    return leadingStyle(this.genre.leading, this.personality ?? DEFAULT_PERSONALITY);
  }

  /** Set the governor's dwell times and deadband from the personality, if there is one. */
  private applyLeading(): void {
    if (this.personality) Object.assign(this.config, this.leading.governor);
  }

  /** The bandleader's personality from the next bar on. */
  setPersonality(p: Personality): void {
    this.controls.push({ at: this.bar, kind: "personality", personality: p });
    this.personality = p;
    this.applyLeading();
  }

  /** Trading fours on or off. Off ends a band turn from the next bar. */
  setTrading(on: boolean): void {
    this.controls.push({ at: this.bar, kind: "trade", on });
    this.trading = on;
    if (!on) this.solo = null;
  }

  /**
   * Start a band turn (from `solo.from`, a bar not yet prepared) or end the
   * one playing from the next bar (null). The page's trader decides (trade.ts).
   */
  setSolo(solo: Solo | null): void {
    this.controls.push({ at: this.bar, kind: "solo", solo });
    if (solo && !this.trading) return;
    if (!solo && this.solo && this.solo.from <= this.bar + 1) this.solo = { ...this.solo, bars: Math.max(0, this.bar + 1 - this.solo.from) };
    else this.solo = solo;
  }

  /** The band turn covering a bar, if any. */
  soloAt(bar: number): Solo | null {
    const s = this.solo;
    return s && bar >= s.from && bar < s.from + s.bars ? s : null;
  }

  /** Where the next bar to be prepared lands (no jumps applied); null at the end of a form that doesn't loop. */
  upcoming(): { formPos: number; barInSection: number; sectionBars: number } | null {
    const pos = this.advance();
    if (!pos) return null;
    const bars = pos.formPos === this.formPos && this.barInSection >= 0 ? this.sectionLength() : this.sectionAt(pos.formPos).bars;
    return { ...pos, sectionBars: bars };
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

  /** A cue from the player, resolved when the next bar is prepared. `by`: said, not keyed (v0.5). */
  cue(c: Cue, by?: "voice"): void {
    this.controls.push({ at: this.bar, kind: "cue", cue: c, ...(by && { by }) });
    this.cues.push(c);
  }

  /** The band's tempo from the next bar on (Follow my tempo). */
  setTempo(bpm: number): void {
    if (bpm === this.bpm) return;
    this.controls.push({ at: this.bar, kind: "tempo", bpm });
    this.bpm = bpm;
  }

  /** Switch genre from the next bar on. */
  setGenre(genre: GenrePack): void {
    this.controls.push({ at: this.bar, kind: "genre", genre: genre.id });
    this.genre = genre;
    this.applyLeading();
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
    const locked = source !== "you" && source !== "cue" ? this.lockedOut(m, upcoming) ?? this.tradeHolds(m) : null;
    if (locked) return reject(locked);

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
        // Back to the normal feel never waits longer than v0.3's dwell, whatever the personality.
        if (upcoming - this.lastFeelChange < (m.feel === "normal" ? Math.min(cfg.feelDwellBars, DEFAULT_GOVERNOR.feelDwellBars) : cfg.feelDwellBars)) return reject("changed too recently");
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

  /** Why a leader move would undo the cue that's locking, or null. */
  private lockedOut(m: Move, upcoming: number): string | null {
    const lock = this.lockout;
    if (!lock || upcoming > lock.until) return null;
    const why = `undoes the ${CUE_LABELS[lock.cue].toLowerCase()} cue`;
    const target = this.target ?? this.intensity;
    switch (lock.cue) {
      case "take_down":
        if ((m.move === "set_intensity" && m.value > target) || m.move === "add_layer" || (m.move === "fire_stinger" && m.stinger === "riser")) return why;
        return null;
      case "build":
        if ((m.move === "set_intensity" && m.value < target) || m.move === "drop_layer" || (m.move === "change_feel" && m.feel === "half_time")) return why;
        return null;
      case "drums_break":
      case "drums_only":
        return m.move === "add_layer" || m.move === "drop_layer" ? why : null;
      case "next_section":
      case "one_more":
      case "end_song":
        return m.move === "jump_to_section" || m.move === "extend_section" || m.move === "end_song" ? why : null;
    }
  }

  /**
   * While trading, the player's gaps are the band's turns, not the player
   * leaving: a leader can't drop parts, change the feel or take the level
   * down far (ADR-0022).
   */
  private tradeHolds(m: Move): string | null {
    if (!this.trading) return null;
    const why = "trading fours: the band keeps going";
    if (m.move === "drop_layer" || m.move === "change_feel") return why;
    if (m.move === "set_intensity" && m.value < (this.target ?? this.intensity) - 0.15) return why;
    return null;
  }

  /** Apply a cue for the upcoming bar. Returns its record. */
  private resolveCue(c: Cue, upcoming: number): MoveRecord {
    const phrase = this.chart.phraseBars;
    const label = `cue: ${CUE_LABELS[c].toLowerCase()}`;
    const rec = (move: Move, status: MoveStatus, note?: string) => this.record(move, "cue", upcoming - 1, status, note, label);
    const reason = CUE_LABELS[c];
    // The bar after the end of the phrase the upcoming bar is in (by bars in the section).
    const pos = this.advance();
    const barInSection = pos?.barInSection ?? 0;
    const phraseLeft = phrase - (barInSection % phrase);
    switch (c) {
      case "take_down":
      case "build": {
        const current = this.target ?? this.intensity;
        const value = Math.round(clamp(current + (c === "build" ? CUE_STEP : -CUE_STEP), 0.1, 1) * 100) / 100;
        this.target = value;
        this.targetSetAt = upcoming;
        if (c === "build") this.cueStinger = "riser";
        this.lockout = { cue: c, until: upcoming + phrase };
        return rec({ move: "set_intensity", value, reason }, "applied");
      }
      case "drums_break":
      case "drums_only": {
        const has = this.lineup.filter((p) => PERC.includes(p));
        if (!has.length) return rec({ move: "drop_layer", part: "drums", reason }, "rejected", "no drums or percussion in the lineup");
        if (c === "drums_only" && !this.lineup.some((p) => !PERC.includes(p))) return rec({ move: "drop_layer", part: "drums", reason }, "rejected", "the band is only drums");
        this.breakCue = { cue: c, until: upcoming + phraseLeft - 1 };
        this.lockout = { cue: c, until: this.breakCue.until };
        return rec({ move: "drop_layer", part: "drums", reason }, "applied", `through bar ${this.breakCue.until}`);
      }
      case "next_section": {
        const next = this.formPos + 1 < this.chart.form.length ? this.formPos + 1 : this.config.loop ? 0 : -1;
        const move: Move = { move: "jump_to_section", section: next >= 0 ? this.chart.form[next] : "", reason };
        if (this.pendingEnd) return rec(move, "rejected", "the song is ending");
        if (next < 0) {
          // Last section of a song that doesn't loop: the next section is the end.
          this.pendingEnd = { move: { move: "end_song", reason }, source: "cue", requestedBar: upcoming - 1 };
          this.lockout = { cue: "end_song", until: upcoming + phrase };
          return rec(move, "pending", "last section: ending at the end of this phrase");
        }
        if (this.pendingJump) this.record(this.pendingJump.move, this.pendingJump.source, this.pendingJump.requestedBar, "rejected", "replaced by a cue");
        this.pendingJump = { move, source: "cue", requestedBar: upcoming - 1, formPos: next };
        this.lockout = { cue: c, until: upcoming + phraseLeft };
        return rec(move, "pending", "waiting for the next phrase");
      }
      case "one_more": {
        const bars = this.sectionAt(this.formPos).bars;
        const move: Move = { move: "extend_section", bars, reason };
        if (this.pendingEnd) return rec(move, "rejected", "the song is ending");
        if (this.extension > 0) return rec(move, "rejected", "already going round again");
        this.extension += bars;
        if (this.pendingJump) {
          this.record(this.pendingJump.move, this.pendingJump.source, this.pendingJump.requestedBar, "rejected", "one more time round first");
          this.pendingJump = null;
        }
        this.lockout = { cue: c, until: upcoming + this.sectionLength() - barInSection };
        return rec(move, "applied", `${bars} more bars`);
      }
      case "end_song": {
        const move: Move = { move: "end_song", reason };
        if (this.pendingEnd) return rec(move, "rejected", "already ending");
        this.pendingEnd = { move, source: "cue", requestedBar: upcoming - 1 };
        if (this.pendingJump) {
          this.record(this.pendingJump.move, this.pendingJump.source, this.pendingJump.requestedBar, "rejected", "the song is ending");
          this.pendingJump = null;
        }
        this.lockout = { cue: c, until: upcoming + phrase };
        return rec(move, "pending", "ending at the end of this phrase");
      }
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
      else if (c.kind === "cue") this.cue(c.cue, c.by);
      else if (c.kind === "tempo") this.setTempo(c.bpm);
      else if (c.kind === "genre") this.setGenre(getGenre(c.genre));
      else if (c.kind === "band") this.setBand(c.band);
      else if (c.kind === "personality") this.setPersonality(c.personality);
      else if (c.kind === "trade") this.setTrading(c.on);
      else if (c.kind === "solo") this.setSolo(c.solo);
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
        bpm: this.bpm,
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
      bar: this.bar, bpm: this.bpm, kind: "count_in", section: "count-in", formPos: 0, barInSection: i, sectionBars: this.countInTotal, chords: [],
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
    const cues = this.cues;
    this.cues = [];
    for (const c of cues) resolved.push(this.resolveCue(c, upcoming));

    // Horizontal resequencing: a pending jump lands on a phrase boundary once
    // the section has had its minimum length.
    let pos = this.advance();
    const started = this.barInSection >= 0;
    if (this.pendingJump && started) {
      const pj = this.pendingJump;
      const target = (pj.move as Extract<Move, { move: "jump_to_section" }>).section;
      const atBoundary = pos === null || pos.barInSection === 0 || pos.barInSection % this.chart.phraseBars === 0;
      if (pj.formPos === undefined && upcoming - pj.requestedBar > cfg.ttlBars) {
        resolved.push(this.record(pj.move, pj.source, pj.requestedBar, "rejected", "expired before a phrase boundary"));
        this.pendingJump = null;
      } else if (atBoundary && (pj.formPos !== undefined || this.barsInVisit >= cfg.minSectionBars)) {
        pos = { formPos: pj.formPos ?? this.jumpTarget(target), barInSection: 0 };
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
    if (newSection && this.bar > this.countInTotal && section.intensity !== undefined && this.target !== null && !(cfg.holdFreshTarget && this.bar - this.targetSetAt <= this.chart.phraseBars) && !(this.lockout && this.bar <= this.lockout.until))
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
    if (this.cueStinger) {
      stingers = [this.cueStinger];
      this.lastStingerPhrase = phraseId;
      this.cueStinger = null;
    }
    const next = ending ? tonic : this.peekNextChord();
    if (cfg.autoFills && this.layers.has("drums") && level >= 1) {
      if (lastBarOfSection && next && !stingers.includes("fill")) stingers.push("fill");
      if (newSection && this.bar > this.countInTotal && !stingers.includes("crash")) stingers.push("crash");
    }
    if (ending && this.layers.has("drums") && !stingers.includes("fill")) stingers.push("fill");

    // Mid layer: one bar per active part, repeating the last bar on a miss.
    // A break cue sets the parts for its bars; the layers come back after.
    const brk = this.breakCue && this.bar <= this.breakCue.until ? this.breakCue.cue : null;
    if (this.breakCue && this.bar > this.breakCue.until) {
      if (this.breakCue.cue === "drums_break" && this.layers.has("drums") && !stingers.includes("crash")) stingers.push("crash");
      this.breakCue = null;
    }
    let parts = this.lineup.filter((p) =>
      brk === "drums_break" ? this.layers.has(p) && !PERC.includes(p) : brk === "drums_only" ? PERC.includes(p) : this.layers.has(p),
    );
    if (brk === "drums_break") stingers = [];
    // Trading: the band's turn. A drum solo plays alone; a melodic soloist plays over the rest of the band.
    const solo = !brk && !ending ? this.soloAt(this.bar) : null;
    if (this.solo && this.bar >= this.solo.from + this.solo.bars) {
      // The player's turn starts: a drum solo hands back with a crash.
      if (this.solo.part === "drums" && this.solo.bars > 0 && this.bar === this.solo.from + this.solo.bars && this.layers.has("drums") && !stingers.includes("crash")) stingers.push("crash");
      this.solo = null;
    }
    if (solo && this.lineup.includes(solo.part)) {
      if (solo.part === "drums") {
        parts = ["drums"];
        stingers = [];
      } else if (!parts.includes(solo.part)) parts = [...parts, solo.part];
    }
    const ctx = this.context({
      bar: this.bar, kind: ending ? "ending" : "play", section: name, barInSection: this.barInSection, sectionBars: this.sectionLength(),
      barInPhrase, lastBarOfSection, level, feel: this.feel, parts, slots: section.barChords(this.barInSection), next, stingers,
      cymbal: section.cymbal ?? this.genre.drums.cymbalSections[name] ?? this.genre.drums.cymbal,
      ending: tonic ? { tonic, ringBeats: this.genre.ending.ringBeats } : null,
    });
    const soloing = solo && this.lineup.includes(solo.part) ? solo : null;
    const generated = this.generator.generate(soloing ? { ...ctx, parts: parts.filter((p) => p !== soloing.part) } : ctx);
    if (soloing) generated[soloing.part] = this.soloist.bar(ctx, soloing, this.bar - soloing.from);
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
    if (!parts.includes("drums") && this.lineup.includes("drums") && (stingers.length || ending) && brk !== "drums_break") {
      const only = this.generator.generate({ ...ctx, parts: ["drums"], stingersOnly: true }).drums;
      if (only) byPart.drums = only;
    }

    const swing = this.swingFor(name);
    const events = this.feelBar(byPart, this.bar, swing, ending);
    if (ending) this.done = true;
    return {
      bar: this.bar,
      bpm: this.bpm,
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
      trading: this.trading,
      solo: soloing ? { part: soloing.part, bar: this.bar - soloing.from, of: soloing.bars } : null,
    };
  }
}
