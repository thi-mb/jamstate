// Lineups: who plays on a song, on which instrument, how loud and where in
// the stereo field. A chart's `band` field, a genre pack's default band and
// its alternative lineups all use this one shape. The engine reads only which
// parts are in it; the sound (web/src/audio) reads the rest.
//
// The instrument catalog is sounds/instruments.json at the repo root, shared
// with the sample renderer (sounds/render.py).

import catalogJson from "../../../sounds/instruments.json";
import { PARTS, type Part } from "./types";

export interface InstrumentInfo {
  id: string;
  part: Part;
  name: string;
}

interface CatalogJSON {
  defaults: Record<Part | "player", string>;
  instruments: { id: string; part: string; name: string }[];
}

const catalog = catalogJson as CatalogJSON;

export const INSTRUMENTS: InstrumentInfo[] = catalog.instruments.map((i) => ({ id: i.id, part: i.part as Part, name: i.name }));
const byId = new Map(INSTRUMENTS.map((i) => [i.id, i]));

export function getInstrument(id: string): InstrumentInfo | undefined {
  return byId.get(id);
}

export function instrumentsFor(part: Part): InstrumentInfo[] {
  return INSTRUMENTS.filter((i) => i.part === part);
}

export function defaultInstrument(part: Part | "player"): string {
  return catalog.defaults[part];
}

/** Instruments the player's own notes can use (the keys). */
export function playerInstruments(): InstrumentInfo[] {
  return instrumentsFor("chords");
}

export interface BandSlot {
  instrument: string;
  /** 0–1, on top of the genre's mix. Omitted: the mix's level. */
  volume?: number;
  /** -1 (left) to 1 (right). Omitted: the mix's pan. */
  pan?: number;
}

/** Parts that play, each with its sound. A part that isn't listed sits out the song. */
export type Band = Partial<Record<Part, BandSlot>>;

/** In JSON a slot can be just the instrument id: `"bass": "upright"`. */
export type BandJSON = Partial<Record<string, string | { instrument?: string; volume?: number; pan?: number }>>;

/** The parts in a band, in the fixed PARTS order (so lineups compare and hash the same). */
export function bandParts(band: Band): Part[] {
  return PARTS.filter((p) => band[p]);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && x >= lo && x <= hi;

/**
 * Validate a band from a chart or genre pack. Problems go into `errs` (with
 * `where` in front); the band returned keeps only the valid slots. `allowed`
 * limits the parts (a genre's roles).
 */
export function parseBand(raw: unknown, where: string, errs: string[], allowed: readonly Part[] = PARTS): Band {
  const band: Band = {};
  if (!isObj(raw)) {
    errs.push(`${where} must map parts (${PARTS.join(", ")}) to an instrument`);
    return band;
  }
  for (const [k, v] of Object.entries(raw)) {
    const w = `${where}.${k}`;
    if (!(PARTS as readonly string[]).includes(k)) {
      errs.push(`${where}: unknown part "${k}" (use ${PARTS.join(", ")})`);
      continue;
    }
    const part = k as Part;
    if (!allowed.includes(part)) {
      errs.push(`${w}: this genre has no ${part} part`);
      continue;
    }
    const slot = typeof v === "string" ? { instrument: v } : isObj(v) ? v : null;
    if (!slot) {
      errs.push(`${w} must be an instrument id or {instrument, volume, pan}`);
      continue;
    }
    for (const key of Object.keys(slot)) if (!["instrument", "volume", "pan"].includes(key)) errs.push(`${w}: unknown field "${key}"`);
    const id = slot.instrument ?? defaultInstrument(part);
    const inst = typeof id === "string" ? getInstrument(id) : undefined;
    if (!inst || inst.part !== part) {
      errs.push(`${w}.instrument must be one of ${instrumentsFor(part).map((i) => i.id).join(", ")} (got ${JSON.stringify(id)})`);
      continue;
    }
    const out: BandSlot = { instrument: inst.id };
    if (slot.volume !== undefined) {
      if (!isNum(slot.volume, 0, 1)) errs.push(`${w}.volume must be from 0 to 1`);
      else out.volume = slot.volume;
    }
    if (slot.pan !== undefined) {
      if (!isNum(slot.pan, -1, 1)) errs.push(`${w}.pan must be from -1 (left) to 1 (right)`);
      else out.pan = slot.pan;
    }
    band[part] = out;
  }
  if (!Object.keys(band).length && !errs.length) errs.push(`${where} needs at least one part`);
  return band;
}

/** A band where each of `parts` plays its default instrument. */
export function defaultBand(parts: readonly Part[]): Band {
  return Object.fromEntries(parts.map((p) => [p, { instrument: defaultInstrument(p) }]));
}

/** Copy a band (bands are small plain objects; controls keep their own copy). */
export function cloneBand(band: Band): Band {
  return Object.fromEntries(Object.entries(band).map(([p, s]) => [p, { ...s }]));
}

/** Back to JSON, short form where a slot is just an instrument. */
export function bandJSON(band: Band): BandJSON {
  return Object.fromEntries(
    bandParts(band).map((p) => {
      const s = band[p]!;
      return [p, s.volume === undefined && s.pan === undefined ? s.instrument : { ...s }];
    }),
  );
}
