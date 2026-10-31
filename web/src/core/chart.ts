// Chart = song skeleton. Validated here by hand; schema/chart.schema.json is
// the same contract for editors and for the Python side. Format v0.1
// (ADR-0013) adds genre, swing, count-in and per-section feel to v0
// (ADR-0010); every v0 chart is still a valid v0.1 chart.

import { genreIds } from "./genres";
import { parseChord, type Chord } from "./theory";

export interface SectionJSON {
  name: string;
  bars: number;
  chords: string[];
  intensity?: number;
  /** Overrides the song's swing for this section. */
  swing?: number;
  /** Time on the hi-hat or the ride for this section (overrides the genre). */
  cymbal?: "hat" | "ride";
}

export interface ChartJSON {
  version?: string;
  title: string;
  bpm: number;
  time_sig: string;
  key?: string;
  phrase_bars?: number;
  /** Genre pack id (genres/*.json). Sets the groove vocabulary, swing and feel. */
  genre?: string;
  /** 0 = straight, 0.66 = triplet swing. Overrides the genre's swing. */
  swing?: number;
  /** Bars the band counts in before the first bar (default 1). */
  count_in?: number;
  sections: SectionJSON[];
  form: string[];
}

/** One chord inside a bar, in beats from the bar start. */
export interface ChordSlot {
  start: number;
  dur: number;
  chord: Chord;
}

export interface Section {
  name: string;
  bars: number;
  /** Suggested intensity for this section, used until the bandleader says otherwise. */
  intensity?: number;
  swing?: number;
  cymbal?: "hat" | "ride";
  /** Chord slots for bar `i` of the section. Bars past the end cycle the progression. */
  barChords(i: number): ChordSlot[];
}

export interface Chart {
  title: string;
  bpm: number;
  beatsPerBar: number;
  key?: string;
  phraseBars: number;
  genre?: string;
  swing?: number;
  countIn: number;
  sections: Map<string, Section>;
  form: string[];
}

export class ChartError extends Error {
  constructor(readonly errors: string[]) {
    super(`Invalid chart:\n- ${errors.join("\n- ")}`);
  }
}

const TOP_KEYS = new Set(["version", "title", "bpm", "time_sig", "key", "phrase_bars", "genre", "swing", "count_in", "sections", "form"]);
const SECTION_KEYS = new Set(["name", "bars", "chords", "intensity", "swing", "cymbal"]);
const isSwing = (x: unknown) => typeof x === "number" && x >= 0 && x <= 1;
const NAME_RE = /^[A-Za-z0-9_-]+$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

/** Returns a list of human-readable problems; empty means valid. */
export function validateChart(raw: unknown, genres: string[] = genreIds()): string[] {
  const errs: string[] = [];
  if (!isObj(raw)) return ["chart must be a JSON object"];
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) errs.push(`unknown field "${k}"`);
  if (raw.version !== undefined && raw.version !== "0" && raw.version !== "0.1") errs.push('version must be "0.1" (or "0")');
  if (raw.genre !== undefined && (typeof raw.genre !== "string" || !genres.includes(raw.genre)))
    errs.push(`genre must be one of ${genres.join(", ")}`);
  if (raw.swing !== undefined && !isSwing(raw.swing)) errs.push("swing must be a number from 0 (straight) to 1 (0.66 = triplet)");
  if (raw.count_in !== undefined && (!isInt(raw.count_in) || raw.count_in < 0 || raw.count_in > 2)) errs.push("count_in must be 0, 1 or 2 bars");
  if (typeof raw.title !== "string" || !raw.title) errs.push("title must be a non-empty string");
  if (typeof raw.bpm !== "number" || raw.bpm < 40 || raw.bpm > 240) errs.push("bpm must be a number from 40 to 240");
  if (typeof raw.time_sig !== "string" || !/^[2-7]\/4$/.test(raw.time_sig))
    errs.push('time_sig must look like "4/4" (2/4 to 7/4 in v0)');
  if (raw.key !== undefined && typeof raw.key !== "string") errs.push("key must be a string");
  if (raw.phrase_bars !== undefined && (!isInt(raw.phrase_bars) || raw.phrase_bars < 1 || raw.phrase_bars > 16))
    errs.push("phrase_bars must be an integer from 1 to 16");

  const names = new Set<string>();
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
    errs.push("sections must be a non-empty list");
  } else {
    raw.sections.forEach((s, i) => {
      const where = `sections[${i}]`;
      if (!isObj(s)) return void errs.push(`${where} must be an object`);
      for (const k of Object.keys(s)) if (!SECTION_KEYS.has(k)) errs.push(`${where}: unknown field "${k}"`);
      if (typeof s.name !== "string" || !NAME_RE.test(s.name)) errs.push(`${where}: name must be letters, digits, _ or -`);
      else if (names.has(s.name)) errs.push(`${where}: duplicate section name "${s.name}"`);
      else names.add(s.name);
      if (!isInt(s.bars) || s.bars < 1 || s.bars > 64) errs.push(`${where}: bars must be an integer from 1 to 64`);
      if (!Array.isArray(s.chords) || s.chords.length === 0) errs.push(`${where}: chords must be a non-empty list`);
      else
        s.chords.forEach((c, j) => {
          if (typeof c !== "string" || !c.trim()) return void errs.push(`${where}.chords[${j}] must be a chord string`);
          for (const sym of c.trim().split(/\s+/)) {
            try {
              parseChord(sym);
            } catch (e) {
              errs.push(`${where}.chords[${j}]: ${(e as Error).message}`);
            }
          }
        });
      if (s.intensity !== undefined && (typeof s.intensity !== "number" || s.intensity < 0 || s.intensity > 1))
        errs.push(`${where}: intensity must be a number from 0 to 1`);
      if (s.swing !== undefined && !isSwing(s.swing)) errs.push(`${where}: swing must be a number from 0 to 1`);
      if (s.cymbal !== undefined && s.cymbal !== "hat" && s.cymbal !== "ride") errs.push(`${where}: cymbal must be "hat" or "ride"`);
    });
  }

  if (!Array.isArray(raw.form) || raw.form.length === 0) errs.push("form must be a non-empty list of section names");
  else
    raw.form.forEach((f, i) => {
      if (typeof f !== "string" || !names.has(f)) errs.push(`form[${i}]: "${String(f)}" is not a section`);
    });
  return errs;
}

function buildSection(s: SectionJSON, beatsPerBar: number): Section {
  // A chord entry with spaces splits its bar evenly: "Fm Eb" = two beats each in 4/4.
  const bars: ChordSlot[][] = s.chords.map((entry) => {
    const syms = entry.trim().split(/\s+/);
    const dur = beatsPerBar / syms.length;
    return syms.map((sym, k) => ({ start: k * dur, dur, chord: parseChord(sym) }));
  });
  return {
    name: s.name,
    bars: s.bars,
    intensity: s.intensity,
    swing: s.swing,
    cymbal: s.cymbal,
    barChords: (i) => bars[((i % bars.length) + bars.length) % bars.length],
  };
}

export function loadChart(raw: unknown): Chart {
  const errs = validateChart(raw);
  if (errs.length) throw new ChartError(errs);
  const c = raw as ChartJSON;
  const beatsPerBar = Number(c.time_sig.split("/")[0]);
  const sections = new Map<string, Section>();
  for (const s of c.sections) sections.set(s.name, buildSection(s, beatsPerBar));
  return {
    title: c.title,
    bpm: c.bpm,
    beatsPerBar,
    key: c.key,
    phraseBars: c.phrase_bars ?? 4,
    genre: c.genre,
    swing: c.swing,
    countIn: c.count_in ?? 1,
    sections,
    form: [...c.form],
  };
}
