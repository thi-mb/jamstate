// Song Creator data model, browser storage for custom songs, and Play-In
// progression capture (v0.7). DOM-free and unit-tested.

import { validateChart, type ChartJSON, type SectionJSON } from "./chart";
import type { PlayedNote } from "./features";
import { inferBarChord, inferKey } from "./follow";
import { getGenre } from "./genres";
import type { KeyValueStore } from "./platform";
import { parseChord } from "./theory";

export interface SavedChart {
  id: string;
  updated: string;
  chart: ChartJSON;
}

const CHARTS_KEY = "jamstate.customCharts";

export class SavedChartStore {
  constructor(private kv: KeyValueStore) {}

  list(): SavedChart[] {
    const raw = this.kv.get<SavedChart[]>(CHARTS_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  get(id: string): SavedChart | null {
    return this.list().find((c) => c.id === id) ?? null;
  }

  save(chart: ChartJSON, existingId?: string): SavedChart {
    const errs = validateChart(chart);
    if (errs.length) throw new Error(errs.join("; "));
    const list = this.list();
    const slug = chart.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "song";
    const id = existingId || `${slug}-${Date.now().toString(36)}`;
    const entry: SavedChart = { id, updated: new Date().toISOString(), chart: structuredClone(chart) };
    const idx = list.findIndex((c) => c.id === id);
    if (idx >= 0) list[idx] = entry;
    else list.unshift(entry);
    this.kv.set(CHARTS_KEY, list);
    return entry;
  }

  remove(id: string): void {
    this.kv.set(
      CHARTS_KEY,
      this.list().filter((c) => c.id !== id),
    );
  }
}

/** Starter chart for "New song" in the Song Creator. */
export function createBlankChart(genreId = "funk"): ChartJSON {
  const g = getGenre(genreId);
  if (g.id === "jazz") {
    return {
      version: "0.2",
      title: "New Jazz Tune",
      bpm: 124,
      time_sig: "4/4",
      key: "Bb major",
      genre: "jazz",
      count_in: 1,
      sections: [
        { name: "head", bars: 8, chords: ["Bbmaj7", "Gm7", "Cm7", "F7"], intensity: 0.45 },
        { name: "bridge", bars: 8, chords: ["Dm7", "G7", "Cm7", "F7"], intensity: 0.65 },
      ],
      form: ["head", "bridge", "head"],
    };
  }
  if (g.id === "blues-rock") {
    return {
      version: "0.2",
      title: "New Blues Jam",
      bpm: 100,
      time_sig: "4/4",
      key: "A minor",
      genre: "blues-rock",
      count_in: 1,
      sections: [
        { name: "verse", bars: 8, chords: ["A7", "A7", "D7", "A7"], intensity: 0.5 },
        { name: "chorus", bars: 4, chords: ["E7", "D7", "A7", "E7"], intensity: 0.78 },
      ],
      form: ["verse", "chorus", "verse", "chorus"],
    };
  }
  return {
    version: "0.2",
    title: "New Funk Groove",
    bpm: 110,
    time_sig: "4/4",
    key: "E minor",
    genre: "funk",
    count_in: 1,
    sections: [
      { name: "verse", bars: 8, chords: ["Em7", "Em7", "A7", "Em7"], intensity: 0.45 },
      { name: "chorus", bars: 8, chords: ["Cmaj7", "D", "Em7", "B7"], intensity: 0.75 },
    ],
    form: ["verse", "chorus", "verse", "chorus"],
  };
}

/** Check whether a single bar chord entry ("Fm", "Db C7") parses cleanly. */
export function isValidBarChord(entry: string): boolean {
  const syms = entry.trim().split(/\s+/).filter(Boolean);
  if (!syms.length) return false;
  for (const s of syms) {
    try {
      parseChord(s);
    } catch {
      return false;
    }
  }
  return true;
}

/** Ensure a section's chords list matches a new bar count (cycling or trimming). */
export function resizeSectionChords(chords: string[], bars: number): string[] {
  const n = Math.max(1, Math.min(64, Math.floor(bars)));
  const src = chords.length ? chords : ["Am7"];
  return Array.from({ length: n }, (_, i) => src[i % src.length]);
}

/** Clean up a draft before validating against schema/chart.schema.json. */
export function normalizeDraft(raw: ChartJSON): { chart: ChartJSON; errors: string[] } {
  const chart: ChartJSON = {
    version: "0.2",
    title: raw.title.trim() || "Untitled",
    bpm: Math.round(raw.bpm),
    time_sig: raw.time_sig,
    ...(raw.key?.trim() ? { key: raw.key.trim() } : {}),
    ...(raw.genre ? { genre: raw.genre } : {}),
    ...(raw.swing !== undefined ? { swing: raw.swing } : {}),
    ...(raw.count_in !== undefined ? { count_in: raw.count_in } : {}),
    ...(raw.phrase_bars !== undefined ? { phrase_bars: raw.phrase_bars } : {}),
    ...(raw.band ? { band: raw.band } : {}),
    sections: raw.sections.map((s): SectionJSON => ({
      name: s.name.trim(),
      bars: Math.floor(s.bars),
      chords: s.chords.map((c) => c.trim()).filter(Boolean),
      ...(s.intensity !== undefined ? { intensity: Math.round(s.intensity * 100) / 100 } : {}),
      ...(s.swing !== undefined ? { swing: s.swing } : {}),
      ...(s.cymbal ? { cymbal: s.cymbal } : {}),
    })),
    form: raw.form.filter((name) => raw.sections.some((s) => s.name.trim() === name)),
  };
  return { chart, errors: validateChart(chart) };
}

/**
 * Play-in progression capture: listens to notes bar-by-bar over a click track
 * and converts them into a chord array (one chord symbol per bar) plus inferred key.
 */
export class PlayInCapture {
  private bars: PlayedNote[][] = [];
  private pcAccum = new Float64Array(12);

  constructor(
    readonly targetBars: number,
    readonly bpb: number,
    readonly genre: string,
  ) {}

  get recordedBars(): number {
    return this.bars.length;
  }

  get done(): boolean {
    return this.bars.length >= this.targetBars;
  }

  pushBar(notes: PlayedNote[]): { bar: number; chord: string | null; done: boolean } {
    this.bars.push([...notes]);
    for (const n of notes) {
      if (n.note < 0) continue;
      this.pcAccum[((n.note % 12) + 12) % 12] += Math.max(0.2, n.dur) * Math.max(0.25, n.vel / 127);
    }
    const key = inferKey(this.pcAccum);
    const guess = inferBarChord(notes, this.bpb, { key, genre: this.genre });
    return { bar: this.bars.length - 1, chord: guess?.symbol ?? null, done: this.done };
  }

  finish(): { chords: string[]; key: string | null } {
    const key = inferKey(this.pcAccum);
    const chords: string[] = [];
    let prev = null;
    for (const notes of this.bars) {
      const guess = inferBarChord(notes, this.bpb, { key, prevChord: prev, genre: this.genre });
      if (guess) {
        chords.push(guess.symbol);
        prev = guess.chord;
      } else {
        chords.push(chords[chords.length - 1] ?? "Am7");
      }
    }
    return { chords: chords.length ? chords : ["Am7"], key: key?.name ?? null };
  }
}
