// Genre packs: one data file per genre that every layer of the band reads.
// v0.1 filled in the composition layer (grooves per part and intensity level,
// swing, humanize, fills, endings). v0.2 adds instrumentation (the default
// band, alternative lineups, grooves for guitar, pad and percussion) and
// production (the mix). Later releases add listening and leading to the same
// file. Format: ADR-0012, ADR-0018 and schema/genre.schema.json; the packs
// live in genres/ at the repo root.

import { defaultBand, parseBand, type Band } from "./band";
import { drumSteps, tokenSteps } from "./pattern";
import { parseChord, VOICING_STYLES, type VoicingStyle } from "./theory";
import { LEVELS, ROLES, V01_PARTS, type Part } from "./types";

export const GENRE_FORMAT = "jamstate-genre/0.2";
/** Packs written for v0.1 still load: three parts, default sounds and mix. */
export const GENRE_FORMATS = ["jamstate-genre/0.1", GENRE_FORMAT];

/** Percussion lines (General MIDI percussion notes). */
export const PERC_LINES = ["tambourine", "cowbell", "bongo_hi", "bongo_lo", "conga_mute", "conga_hi", "conga_lo", "cabasa", "shaker", "claves"] as const;
export type PercLine = (typeof PERC_LINES)[number];
export type PercLines = Partial<Record<PercLine, string>>;

/** Guitar voicings on top of the keys' ones: power chords, full grips, three-note jazz shells (root, 7th, 3rd). */
export const GUITAR_VOICINGS = ["power", "grip", "shell3"] as const;
export type CompVoicing = VoicingStyle | (typeof GUITAR_VOICINGS)[number];

/** A comping part's vocabulary: keys, guitar and pad all use this shape. */
export interface CompPack {
  grid: number;
  voicing: CompVoicing;
  range: [number, number];
  levels: Variant<string[]>[][];
}

/** Mix settings for one part. */
export interface PartMix {
  /** Fader, 0–1. */
  volume: number;
  /** -1 left to 1 right. */
  pan: number;
  /** Low shelf (100 Hz), presence (1.5 kHz) and high shelf (8 kHz) in dB. */
  eq: [number, number, number];
  /** How hard the part's compressor works, 0 (off) to 1. */
  comp: number;
  /** Send to the shared reverb, 0–1. */
  reverb: number;
  /** Drum tuning in semitones (kits only). */
  tune: number;
}

/** Production: the room, the master bus and a channel strip per part. */
export interface MixPreset {
  /** Reverb tail length in seconds and brightness (0 dark to 1 bright). */
  reverb: { seconds: number; tone: number };
  /** Tape-style saturation on the master, 0 (clean) to 1. */
  saturation: number;
  /** Master level before the limiter, 0–1.5. */
  gain: number;
  parts: Record<Part, PartMix>;
}

export const DEFAULT_PART_MIX: Record<Part, PartMix> = {
  drums: { volume: 0.85, pan: 0, eq: [0, 0, 0], comp: 0.3, reverb: 0.12, tune: 0 },
  bass: { volume: 0.8, pan: 0, eq: [0, 0, 0], comp: 0.4, reverb: 0.02, tune: 0 },
  chords: { volume: 0.55, pan: -0.15, eq: [0, 0, 0], comp: 0.2, reverb: 0.18, tune: 0 },
  guitar: { volume: 0.5, pan: 0.3, eq: [0, 0, 0], comp: 0.2, reverb: 0.15, tune: 0 },
  pad: { volume: 0.35, pan: 0, eq: [0, 0, 0], comp: 0, reverb: 0.35, tune: 0 },
  percussion: { volume: 0.45, pan: 0.35, eq: [0, 0, 0], comp: 0.1, reverb: 0.15, tune: 0 },
};

export const DEFAULT_MIX: MixPreset = { reverb: { seconds: 1.4, tone: 0.5 }, saturation: 0.1, gain: 0.9, parts: DEFAULT_PART_MIX };

export interface Lineup {
  id: string;
  name: string;
  band: Band;
}

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
  /** Parts this genre has grooves for. */
  parts: Part[];
  /** Who plays by default. */
  band: Band;
  /** Other lineups that suit the genre (the page offers them). */
  lineups: Lineup[];
  mix: MixPreset;
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
  guitar: CompPack | null;
  pad: CompPack | null;
  percussion: { grid: number; levels: Variant<PercLines>[][] } | null;
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

const TOP_KEYS = new Set([
  "format", "id", "name", "description", "parts", "band", "lineups", "mix", "feel", "humanize", "drums", "bass", "chords", "guitar", "pad", "percussion",
  "ending", "forms", "progressions",
]);
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

function percLines(raw: unknown, where: string, errs: string[]): PercLines {
  if (!isObj(raw)) return errs.push(`${where} must be an object of percussion lines`), {};
  const out: PercLines = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(PERC_LINES as readonly string[]).includes(k)) errs.push(`${where}: unknown percussion line "${k}" (use ${PERC_LINES.join(", ")})`);
    else if (typeof v !== "string" || !drumSteps(v).length) errs.push(`${where}.${k} must be a non-empty step string`);
    else {
      const bad = drumSteps(v).find((c) => !DRUM_CHAR.test(c));
      if (bad) errs.push(`${where}.${k}: unknown step "${bad}" (use . x X g)`);
      else out[k as PercLine] = v;
    }
  }
  return out;
}

const COMP_VOICINGS: readonly string[] = [...VOICING_STYLES, ...GUITAR_VOICINGS];

function compPack(raw: unknown, where: string, errs: string[], defaults: { range: [number, number]; voicing: CompVoicing }): CompPack {
  const c = isObj(raw) ? raw : (errs.push(`${where} must be an object`), {} as Record<string, unknown>);
  const voicing = c.voicing ?? defaults.voicing;
  if (!COMP_VOICINGS.includes(voicing as string)) errs.push(`${where}.voicing must be one of ${COMP_VOICINGS.join(", ")}`);
  const range = c.range ?? defaults.range;
  if (!Array.isArray(range) || range.length !== 2 || !isNum(range[0], 24, 96) || !isNum(range[1], 24, 108) || range[1] - range[0] < 12)
    errs.push(`${where}.range must be [low, high] MIDI notes at least an octave apart`);
  const g = c.grid ?? 4;
  if (g !== 2 && g !== 3 && g !== 4) errs.push(`${where}.grid must be 2, 3 or 4 steps per beat`);
  return {
    grid: g as number,
    voicing: voicing as CompVoicing,
    range: range as [number, number],
    levels: variants(c.levels, `${where}.levels`, errs, tokens(CHORD_TOKEN, "comping", errs), "steps"),
  };
}

const MIX_KEYS = new Set(["volume", "pan", "eq", "comp", "reverb", "tune"]);

function mixPreset(raw: unknown, errs: string[]): MixPreset {
  if (raw === undefined) return DEFAULT_MIX;
  if (!isObj(raw)) return errs.push("mix must be an object"), DEFAULT_MIX;
  for (const k of Object.keys(raw)) if (!["reverb", "saturation", "gain", "parts"].includes(k)) errs.push(`mix: unknown field "${k}"`);
  const num = (v: unknown, def: number, lo: number, hi: number, where: string) => {
    if (v === undefined) return def;
    if (!isNum(v, lo, hi)) return errs.push(`${where} must be a number from ${lo} to ${hi}`), def;
    return v;
  };
  const rv = isObj(raw.reverb) ? raw.reverb : {};
  const parts = {} as Record<Part, PartMix>;
  const src = isObj(raw.parts) ? raw.parts : {};
  if (raw.parts !== undefined && !isObj(raw.parts)) errs.push("mix.parts must be an object keyed by part");
  for (const k of Object.keys(src)) if (!(ROLES as readonly string[]).includes(k)) errs.push(`mix.parts: unknown part "${k}"`);
  for (const part of ROLES) {
    const d = DEFAULT_PART_MIX[part];
    const m = isObj(src[part]) ? src[part] : {};
    const w = `mix.parts.${part}`;
    for (const k of Object.keys(m)) if (!MIX_KEYS.has(k)) errs.push(`${w}: unknown field "${k}"`);
    let eq = d.eq;
    if (m.eq !== undefined) {
      if (!Array.isArray(m.eq) || m.eq.length !== 3 || !m.eq.every((x) => isNum(x, -12, 12))) errs.push(`${w}.eq must be [low, mid, high] in dB from -12 to 12`);
      else eq = m.eq as [number, number, number];
    }
    parts[part] = {
      volume: num(m.volume, d.volume, 0, 1, `${w}.volume`),
      pan: num(m.pan, d.pan, -1, 1, `${w}.pan`),
      eq,
      comp: num(m.comp, d.comp, 0, 1, `${w}.comp`),
      reverb: num(m.reverb, d.reverb, 0, 1, `${w}.reverb`),
      tune: num(m.tune, d.tune, -12, 12, `${w}.tune`),
    };
  }
  return {
    reverb: { seconds: num(rv.seconds, DEFAULT_MIX.reverb.seconds, 0.2, 6, "mix.reverb.seconds"), tone: num(rv.tone, DEFAULT_MIX.reverb.tone, 0, 1, "mix.reverb.tone") },
    saturation: num(raw.saturation, DEFAULT_MIX.saturation, 0, 1, "mix.saturation"),
    gain: num(raw.gain, DEFAULT_MIX.gain, 0, 1.5, "mix.gain"),
    parts,
  };
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
  if (!GENRE_FORMATS.includes(raw.format as string)) errs.push(`format must be "${GENRE_FORMAT}" (or "${GENRE_FORMATS[0]}")`);
  const v01 = raw.format === GENRE_FORMATS[0];
  if (v01) for (const k of ["band", "lineups", "mix", "guitar", "pad", "percussion"]) if (raw[k] !== undefined) errs.push(`${k} needs format "${GENRE_FORMAT}"`);
  if (typeof raw.id !== "string" || !/^[a-z0-9-]+$/.test(raw.id)) errs.push("id must be lowercase letters, digits or -");
  if (typeof raw.name !== "string" || !raw.name) errs.push("name must be a non-empty string");

  const parts = Array.isArray(raw.parts) ? raw.parts : v01 ? [...V01_PARTS] : [...ROLES];
  if (!parts.length || !parts.every((p) => (ROLES as readonly string[]).includes(p as string))) errs.push(`parts must list roles from ${ROLES.join(", ")}`);
  for (const p of ["guitar", "pad", "percussion"] as const) {
    if (parts.includes(p) && raw[p] === undefined) errs.push(`parts lists ${p} but there is no "${p}" groove section`);
    if (!parts.includes(p) && raw[p] !== undefined) errs.push(`there is a "${p}" section but parts doesn't list ${p}`);
  }
  const roles = (parts as Part[]).filter((p) => (ROLES as readonly string[]).includes(p));
  const band = raw.band === undefined ? defaultBand(roles) : parseBand(raw.band, "band", errs, roles);
  const lineups: Lineup[] = [];
  if (raw.lineups !== undefined) {
    if (!Array.isArray(raw.lineups)) errs.push("lineups must be a list of {id, name, band}");
    else
      raw.lineups.forEach((l, i) => {
        const w = `lineups[${i}]`;
        if (!isObj(l) || typeof l.id !== "string" || typeof l.name !== "string") return void errs.push(`${w} must have an id, a name and a band`);
        lineups.push({ id: l.id, name: l.name, band: parseBand(l.band, `${w}.band`, errs, roles) });
      });
  }

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

  let percussion: GenrePack["percussion"] = null;
  if (raw.percussion !== undefined) {
    const pc = isObj(raw.percussion) ? raw.percussion : (errs.push("percussion must be an object"), {} as Record<string, unknown>);
    percussion = { grid: grid(pc.grid, "percussion"), levels: variants(pc.levels, "percussion.levels", errs, (x, w) => percLines(x, w, errs), "lines") };
  }

  const pack: GenrePack = {
    id: raw.id as string,
    name: raw.name as string,
    description: typeof raw.description === "string" ? raw.description : "",
    parts: roles,
    band,
    lineups,
    mix: mixPreset(raw.mix, errs),
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
    guitar: raw.guitar === undefined ? null : compPack(raw.guitar, "guitar", errs, { range: [52, 76], voicing: "grip" }),
    pad: raw.pad === undefined ? null : compPack(raw.pad, "pad", errs, { range: [55, 79], voicing: "close" }),
    percussion,
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
