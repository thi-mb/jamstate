// Genre packs: one data file per genre that every layer of the band reads.
// v0.1 fills in the composition layer (grooves per part and intensity level,
// swing, humanize, fills, endings). Later releases add instrumentation,
// production, listening and leading to the same file. Format: ADR-0012 and
// schema/genre.schema.json; the packs live in genres/ at the repo root.

import { drumSteps, tokenSteps } from "./pattern";
import { parseChord, VOICING_STYLES, type VoicingStyle } from "./theory";
import { LEVELS, ROLES, type Part } from "./types";

export const GENRE_FORMAT = "jamstate-genre/0.1";

export const DRUM_LINES = ["kick", "snare", "stick", "cymbal", "pedal", "tom_hi", "tom_mid", "tom_lo", "crash", "clap"] as const;
export type DrumLine = (typeof DRUM_LINES)[number];
export type DrumLines = Partial<Record<DrumLine, string>>;

export interface Variant<T> {
  value: T;
  weight: number;
  /** Only used on the last bar of a phrase (a turnaround or pickup). */
  phraseEnd: boolean;
}

export interface Fill {
  beats: number;
  minLevel: number;
  maxLevel: number;
  lines: DrumLines;
}

export interface HumanizePart {
  /** Constant push (negative) or lay-back (positive), ms. */
  offsetMs: number;
  /** Random timing spread, ms (uniform ±). */
  jitterMs: number;
  /** Random velocity spread (uniform ±). */
  velocity: number;
  /** Chords only: roll the notes of a chord across this many ms, low to high. */
  spreadMs: number;
  /** Drums only: extra offset per line, ms. */
  lines: Partial<Record<DrumLine, number>>;
}

export interface GenrePack {
  id: string;
  name: string;
  description: string;
  parts: Part[];
  swing: number;
  /** 8 = swing eighth notes, 16 = swing sixteenths. */
  swingUnit: 8 | 16;
  humanize: Record<Part, HumanizePart>;
  drums: {
    grid: number;
    cymbal: "hat" | "ride";
    cymbalSections: Record<string, "hat" | "ride">;
    levels: Variant<DrumLines>[][];
    ghosts: number[];
    phraseFills: number[];
    fills: Fill[];
    pickup: DrumLines | null;
  };
  bass: {
    grid: number;
    levels: Variant<string[]>[][];
    approach: "chromatic" | "scale" | "fifth" | "mixed";
    approachChance: number[];
    walkLevels: number[];
    skipChance: number;
  };
  chords: {
    grid: number;
    voicing: VoicingStyle;
    range: [number, number];
    levels: Variant<string[]>[][];
  };
  ending: {
    /** How much the tempo slows across the last bar (0 = none, 0.3 = to 70%). */
    rit: number;
    ringBeats: number;
    chordMajor: string;
    chordMinor: string;
    drums: "hit" | "roll";
  };
  /** Typical forms and progressions, for writing songs in this genre (text-to-song, v0.6). */
  forms: string[];
  progressions: string[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && x >= lo && x <= hi;

const TOP_KEYS = new Set(["format", "id", "name", "description", "parts", "feel", "humanize", "drums", "bass", "chords", "ending", "forms", "progressions"]);
const BASS_TOKEN = /^([.\-xgAN]|(R|1|2|9|b3|3|4|11|b5|5|6|13|b7|7|8)[,']?)!?$/;
const CHORD_TOKEN = /^[.\-xXgp]$/;
const DRUM_CHAR = /^[.xXgoh]$/;

function perLevel(v: unknown, where: string, errs: string[], lo = 0, hi = 1): number[] {
  if (!Array.isArray(v) || v.length !== LEVELS || !v.every((x) => isNum(x, lo, hi))) {
    errs.push(`${where} must be a list of ${LEVELS} numbers from ${lo} to ${hi}, one per intensity level`);
    return new Array(LEVELS).fill(0);
  }
  return v as number[];
}

function drumLines(raw: unknown, where: string, errs: string[]): DrumLines {
  if (!isObj(raw)) return errs.push(`${where} must be an object of drum lines`), {};
  const out: DrumLines = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(DRUM_LINES as readonly string[]).includes(k)) errs.push(`${where}: unknown drum line "${k}" (use ${DRUM_LINES.join(", ")})`);
    else if (typeof v !== "string" || !drumSteps(v).length) errs.push(`${where}.${k} must be a non-empty step string`);
    else {
      const bad = drumSteps(v).find((c) => !DRUM_CHAR.test(c));
      if (bad) errs.push(`${where}.${k}: unknown step "${bad}" (use . x X g o h)`);
      else out[k as DrumLine] = v;
    }
  }
  return out;
}

function variants<T>(raw: unknown, where: string, errs: string[], read: (x: unknown, where: string) => T | null, valueKey: string): Variant<T>[][] {
  if (!Array.isArray(raw) || raw.length !== LEVELS) {
    errs.push(`${where} must have ${LEVELS} entries, one per intensity level`);
    return [];
  }
  return raw.map((level, li) => {
    const w = `${where}[${li}]`;
    if (!Array.isArray(level) || !level.length) return errs.push(`${w} must be a non-empty list of patterns`), [];
    return level.flatMap((p, pi) => {
      const pw = `${w}[${pi}]`;
      const meta = isObj(p) && valueKey in p ? p : null;
      const value = read(meta ? meta[valueKey] : p, pw);
      if (value === null) return [];
      const weight = meta?.weight ?? 1;
      if (!isNum(weight, 0, 100)) errs.push(`${pw}.weight must be a number from 0 to 100`);
      return [{ value, weight: weight as number, phraseEnd: meta?.phrase_end === true }];
    });
  });
}

function tokens(re: RegExp, kind: string, errs: string[]) {
  return (raw: unknown, where: string): string[] | null => {
    if (typeof raw !== "string" || !tokenSteps(raw).length) return errs.push(`${where} must be a non-empty ${kind} pattern string`), null;
    const steps = tokenSteps(raw);
    const bad = steps.find((t) => !re.test(t));
    if (bad) return errs.push(`${where}: unknown ${kind} step "${bad}"`), null;
    return steps;
  };
}

function humanize(raw: unknown, errs: string[]): Record<Part, HumanizePart> {
  const out = {} as Record<Part, HumanizePart>;
  const src = isObj(raw) ? raw : {};
  if (raw !== undefined && !isObj(raw)) errs.push("humanize must be an object keyed by part");
  for (const part of ROLES) {
    const h = isObj(src[part]) ? src[part] : {};
    const num = (k: string, lo: number, hi: number) => {
      const v = h[k] ?? 0;
      if (!isNum(v, lo, hi)) errs.push(`humanize.${part}.${k} must be a number from ${lo} to ${hi}`);
      return isNum(v, lo, hi) ? v : 0;
    };
    const lines: Partial<Record<DrumLine, number>> = {};
    if (h.lines !== undefined) {
      if (!isObj(h.lines)) errs.push(`humanize.${part}.lines must be an object`);
      else
        for (const [k, v] of Object.entries(h.lines)) {
          if (!(DRUM_LINES as readonly string[]).includes(k) || !isNum(v, -30, 30)) errs.push(`humanize.${part}.lines.${k} must be a drum line with ms from -30 to 30`);
          else lines[k as DrumLine] = v;
        }
    }
    out[part] = { offsetMs: num("offset_ms", -30, 30), jitterMs: num("jitter_ms", 0, 20), velocity: num("velocity", 0, 30), spreadMs: num("spread_ms", 0, 40), lines };
  }
  return out;
}

/** Validate and normalize a genre pack. Throws GenreError listing every problem. */
export function loadGenre(raw: unknown): GenrePack {
  const errs: string[] = [];
  if (!isObj(raw)) throw new GenreError(["genre pack must be a JSON object"]);
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) errs.push(`unknown field "${k}"`);
  if (raw.format !== GENRE_FORMAT) errs.push(`format must be "${GENRE_FORMAT}"`);
  if (typeof raw.id !== "string" || !/^[a-z0-9-]+$/.test(raw.id)) errs.push("id must be lowercase letters, digits or -");
  if (typeof raw.name !== "string" || !raw.name) errs.push("name must be a non-empty string");

  const parts = Array.isArray(raw.parts) ? raw.parts : [...ROLES];
  if (!parts.length || !parts.every((p) => (ROLES as readonly string[]).includes(p as string))) errs.push(`parts must list roles from ${ROLES.join(", ")}`);

  const feel = isObj(raw.feel) ? raw.feel : {};
  const swing = feel.swing ?? 0;
  if (!isNum(swing, 0, 1)) errs.push("feel.swing must be a number from 0 (straight) to 1");
  const swingUnit = feel.swing_unit ?? 8;
  if (swingUnit !== 8 && swingUnit !== 16) errs.push("feel.swing_unit must be 8 or 16");

  const grid = (x: unknown, where: string) => {
    const g = x ?? 4;
    if (g !== 2 && g !== 3 && g !== 4) errs.push(`${where}.grid must be 2, 3 or 4 steps per beat`);
    return g as number;
  };

  const d = isObj(raw.drums) ? raw.drums : (errs.push("drums must be an object"), {} as Record<string, unknown>);
  const cymbal = d.cymbal ?? "hat";
  if (cymbal !== "hat" && cymbal !== "ride") errs.push('drums.cymbal must be "hat" or "ride"');
  const cymbalSections: Record<string, "hat" | "ride"> = {};
  if (d.cymbal_sections !== undefined) {
    if (!isObj(d.cymbal_sections)) errs.push("drums.cymbal_sections must map section names to hat or ride");
    else
      for (const [k, v] of Object.entries(d.cymbal_sections)) {
        if (v !== "hat" && v !== "ride") errs.push(`drums.cymbal_sections.${k} must be "hat" or "ride"`);
        else cymbalSections[k] = v;
      }
  }
  const fills: Fill[] = [];
  if (!Array.isArray(d.fills) || !d.fills.length) errs.push("drums.fills must be a non-empty list");
  else
    d.fills.forEach((f, i) => {
      const w = `drums.fills[${i}]`;
      if (!isObj(f)) return void errs.push(`${w} must be an object`);
      if (!isNum(f.beats, 0.5, 4)) errs.push(`${w}.beats must be from 0.5 to 4`);
      const lv = Array.isArray(f.levels) && f.levels.length === 2 && f.levels.every((x) => isNum(x, 0, LEVELS - 1)) ? (f.levels as number[]) : null;
      if (f.levels !== undefined && !lv) errs.push(`${w}.levels must be [min, max] levels from 0 to ${LEVELS - 1}`);
      fills.push({ beats: f.beats as number, minLevel: lv?.[0] ?? 0, maxLevel: lv?.[1] ?? LEVELS - 1, lines: drumLines(f.lines, `${w}.lines`, errs) });
    });

  const b = isObj(raw.bass) ? raw.bass : (errs.push("bass must be an object"), {} as Record<string, unknown>);
  const approach = b.approach ?? "chromatic";
  if (!["chromatic", "scale", "fifth", "mixed"].includes(approach as string)) errs.push("bass.approach must be chromatic, scale, fifth or mixed");
  const walk = isObj(b.walk) ? b.walk : {};
  const walkLevels = Array.isArray(walk.levels) ? walk.levels : [];
  if (!walkLevels.every((x) => isNum(x, 0, LEVELS - 1))) errs.push("bass.walk.levels must list intensity levels");
  const skip = walk.skip_chance ?? 0;
  if (!isNum(skip, 0, 1)) errs.push("bass.walk.skip_chance must be from 0 to 1");

  const c = isObj(raw.chords) ? raw.chords : (errs.push("chords must be an object"), {} as Record<string, unknown>);
  const voicing = c.voicing ?? "close";
  if (!VOICING_STYLES.includes(voicing as VoicingStyle)) errs.push(`chords.voicing must be one of ${VOICING_STYLES.join(", ")}`);
  const range = c.range ?? [52, 72];
  if (!Array.isArray(range) || range.length !== 2 || !isNum(range[0], 24, 96) || !isNum(range[1], 24, 108) || range[1] - range[0] < 12)
    errs.push("chords.range must be [low, high] MIDI notes at least an octave apart");

  const e = isObj(raw.ending) ? raw.ending : {};
  const rit = e.rit ?? 0;
  if (!isNum(rit, 0, 0.5)) errs.push("ending.rit must be from 0 to 0.5");
  const ring = e.ring_beats ?? 2;
  if (!isNum(ring, 0.5, 8)) errs.push("ending.ring_beats must be from 0.5 to 8");
  const chord = isObj(e.chord) ? e.chord : {};
  for (const k of ["major", "minor"]) {
    if (chord[k] === undefined) continue;
    try {
      if (typeof chord[k] !== "string") throw new Error();
      parseChord(`C${chord[k]}`);
    } catch {
      errs.push(`ending.chord.${k} must be a chord quality like "9", "m6" or "" (got ${JSON.stringify(chord[k])})`);
    }
  }
  const endDrums = e.drums ?? "hit";
  if (endDrums !== "hit" && endDrums !== "roll") errs.push('ending.drums must be "hit" or "roll"');

  const strings = (x: unknown, where: string) => {
    if (x === undefined) return [];
    if (!Array.isArray(x) || !x.every((s) => typeof s === "string")) return errs.push(`${where} must be a list of strings`), [];
    return x as string[];
  };

  const pack: GenrePack = {
    id: raw.id as string,
    name: raw.name as string,
    description: typeof raw.description === "string" ? raw.description : "",
    parts: parts as Part[],
    swing: swing as number,
    swingUnit: swingUnit as 8 | 16,
    humanize: humanize(raw.humanize, errs),
    drums: {
      grid: grid(d.grid, "drums"),
      cymbal: cymbal as "hat" | "ride",
      cymbalSections,
      levels: variants(d.levels, "drums.levels", errs, (x, w) => drumLines(x, w, errs), "lines"),
      ghosts: d.ghosts === undefined ? [0, 0, 0, 0] : perLevel(d.ghosts, "drums.ghosts", errs),
      phraseFills: d.phrase_fills === undefined ? [0, 0, 0, 0] : perLevel(d.phrase_fills, "drums.phrase_fills", errs),
      fills,
      pickup: d.pickup === undefined ? null : drumLines(d.pickup, "drums.pickup", errs),
    },
    bass: {
      grid: grid(b.grid, "bass"),
      levels: variants(b.levels, "bass.levels", errs, tokens(BASS_TOKEN, "bass", errs), "steps"),
      approach: approach as GenrePack["bass"]["approach"],
      approachChance: b.approach_chance === undefined ? [0, 0, 0, 0] : perLevel(b.approach_chance, "bass.approach_chance", errs),
      walkLevels: walkLevels as number[],
      skipChance: skip as number,
    },
    chords: {
      grid: grid(c.grid, "chords"),
      voicing: voicing as VoicingStyle,
      range: range as [number, number],
      levels: variants(c.levels, "chords.levels", errs, tokens(CHORD_TOKEN, "comping", errs), "steps"),
    },
    ending: {
      rit: rit as number,
      ringBeats: ring as number,
      chordMajor: typeof chord.major === "string" ? chord.major : "",
      chordMinor: typeof chord.minor === "string" ? chord.minor : "m",
      drums: endDrums as "hit" | "roll",
    },
    forms: strings(raw.forms, "forms"),
    progressions: strings(raw.progressions, "progressions"),
  };
  if (errs.length) throw new GenreError(errs, typeof raw.id === "string" ? raw.id : undefined);
  return pack;
}

export class GenreError extends Error {
  constructor(
    readonly errors: string[],
    id?: string,
  ) {
    super(`Invalid genre pack${id ? ` "${id}"` : ""}:\n- ${errors.join("\n- ")}`);
  }
}
