// What the fretboard view shows (v0.3), in one of two modes. Changes: for the
// chord sounding, its chord tones (strong) and the genre's scale tones for it
// (faint). Scale: one scale for the whole song (from its key and genre) held
// still, with only the chord tones moving on top. On a guitar neck (frets
// 0–15, in any tuning, v0.5) or two octaves of piano that follow where the
// player plays. From an audio input (v0.5) a played note lights one place on
// the neck, near where the hand has been. The player's notes are coloured by how they fit (noteFit, the
// same test the harmony listening uses). The page draws it (ui/fretboard.ts);
// this module only decides what goes where.

import type { BarPlan } from "./engine";
import type { Chart } from "./chart";
import type { GenreListening, KeyScale } from "./genre";
import { noteFit, type NoteFit } from "./listening";
import { noteName, parseChord, parseKey, type Chord } from "./theory";

export type FretboardKind = "guitar" | "piano" | "off";
export const FRETBOARD_KINDS: FretboardKind[] = ["guitar", "piano", "off"];
export type FretboardMode = "scale" | "changes";
export const FRETBOARD_MODES: FretboardMode[] = ["scale", "changes"];

/** chord: a chord tone; scale: in the genre's scale for the chord; null: neither. */
export type Mark = "chord" | "scale" | null;

export interface Cell {
  /** MIDI note. */
  note: number;
  mark: Mark;
  /** Changes mode: the chord's root. Scale mode: the key's tonic. */
  root: boolean;
  /** Scale mode: a chord tone outside the song's scale (a passing colour). */
  passing?: boolean;
}

/** The scale held for a whole song in scale mode. */
export interface SongScale {
  /** "A blues", "F dorian". */
  name: string;
  tonic: number;
  /** Pitch classes. */
  pcs: number[];
}

const MAJOR: KeyScale = { name: "major", notes: [0, 2, 4, 5, 7, 9, 11] };
const MINOR: KeyScale = { name: "minor", notes: [0, 2, 3, 5, 7, 8, 10] };
const pcOf = (n: number) => ((n % 12) + 12) % 12;

/**
 * The song's scale: the chart's key, and of the genre's scales for that key
 * mode the one that holds the most chord tones over the whole chart (weighted
 * by beats; the first listed wins a tie). Null when the chart has no key.
 */
export function songScale(chart: Chart, genre?: GenreListening): SongScale | null {
  const key = parseKey(chart.key);
  if (!key) return null;
  const options = genre?.keyScales[key.minor ? "minor" : "major"] ?? [key.minor ? MINOR : MAJOR];
  const tones: { pcs: number[]; beats: number }[] = [];
  for (const sec of chart.sections.values())
    for (let b = 0; b < sec.bars; b++)
      for (const s of sec.barChords(b)) tones.push({ pcs: s.chord.intervals.map((i) => pcOf(s.chord.root + i - key.tonic)), beats: s.dur });
  let best = options[0];
  let bestScore = -1;
  for (const o of options) {
    const score = tones.reduce((sum, t) => sum + t.beats * t.pcs.filter((pc) => o.notes.includes(pc)).length, 0);
    if (score > bestScore) [best, bestScore] = [o, score];
  }
  return { name: `${noteName(key.tonic)} ${best.name}`, tonic: key.tonic, pcs: best.notes.map((n) => pcOf(key.tonic + n)) };
}

/** Strings high to low (as tab reads): E4 B3 G3 D3 A2 E2. */
export const GUITAR_STRINGS = [64, 59, 55, 50, 45, 40];
export const GUITAR_FRETS = 15;

/** Tunings, strings high to low. */
export const TUNINGS = {
  standard: { name: "standard", strings: GUITAR_STRINGS },
  "half-down": { name: "half step down", strings: [63, 58, 54, 49, 44, 39] },
  "drop-d": { name: "drop D", strings: [64, 59, 55, 50, 45, 38] },
  dadgad: { name: "DADGAD", strings: [62, 57, 55, 50, 45, 38] },
  "open-g": { name: "open G", strings: [62, 59, 55, 50, 43, 38] },
  "open-d": { name: "open D", strings: [62, 57, 54, 50, 45, 38] },
  bass: { name: "bass", strings: [43, 38, 33, 28] },
} as const satisfies Record<string, { name: string; strings: readonly number[] }>;
export type TuningId = keyof typeof TUNINGS;
export const TUNING_IDS = Object.keys(TUNINGS) as TuningId[];

/** The notes an instrument in this tuning plays (for the listener's pitch range). */
export function tuningRange(id: TuningId): { lowest: number; highest: number } {
  const s = TUNINGS[id].strings;
  return { lowest: Math.min(...s), highest: Math.max(...s) + 22 };
}

export interface Place {
  /** Row, high string first. */
  string: number;
  fret: number;
}

/**
 * Where on the neck a note from an audio input was most likely played: in
 * the four-fret box of the hand (index finger at `pos`), on a string not
 * already sounding. Open strings ring when the hand is low on the neck. A note
 * outside the box moves the hand toward it, halfway, so one stretch doesn't
 * drag the whole picture up the neck.
 */
export class Hand {
  /** The fret under the index finger. */
  pos = 1;

  constructor(private strings: readonly number[] = GUITAR_STRINGS, private frets = GUITAR_FRETS) {}

  place(note: number, busy: ReadonlySet<number> = new Set()): Place | null {
    let best: Place | null = null;
    let bestCost = Infinity;
    for (const [string, open] of this.strings.entries()) {
      const fret = note - open;
      if (fret < 0 || fret > this.frets || busy.has(string)) continue;
      const off = fret - this.pos;
      let cost = off < -1 ? -off * 1.5 : off > 3 ? off - 2 : 0.1 * Math.abs(off - 1.5);
      if (fret === 0) cost = Math.max(0, this.pos - 3) * 0.8;
      if (cost < bestCost) [best, bestCost] = [{ string, fret }, cost];
    }
    if (best && best.fret > 0) {
      if (best.fret < this.pos) this.pos += (best.fret - this.pos) * 0.5;
      else if (best.fret > this.pos + 3) this.pos += (best.fret - 3 - this.pos) * 0.5;
    }
    return best;
  }
}

/** Two octaves and the C on top. */
export const PIANO_KEYS = 25;

export function markOf(note: number, chord: Chord | null, genre?: GenreListening): Mark {
  if (!chord) return null;
  const fit: NoteFit = noteFit(((note % 12) + 12) % 12, chord, genre);
  return fit === "inside" ? "chord" : fit === "colour" ? "scale" : null;
}

/** Scale mode: the song scale faint, the chord's tones strong on top, the tonic ringed. */
export function scaleMarkOf(note: number, chord: Chord | null, song: SongScale): Pick<Cell, "mark" | "passing"> {
  const pc = pcOf(note);
  const inScale = song.pcs.includes(pc);
  if (chord && chord.intervals.some((i) => pcOf(chord.root + i) === pc)) return { mark: "chord", passing: !inScale };
  return { mark: inScale ? "scale" : null };
}

/** `song` given: scale mode; otherwise changes mode. */
function cell(note: number, chord: Chord | null, genre?: GenreListening, song?: SongScale | null): Cell {
  if (song) return { note, ...scaleMarkOf(note, chord, song), root: pcOf(note) === song.tonic };
  return { note, mark: markOf(note, chord, genre), root: !!chord && pcOf(note) === chord.root };
}

/** Rows of cells, one per string (high first), frets 0..15. With `song`, scale mode. */
export function guitarCells(chord: Chord | null, genre?: GenreListening, song?: SongScale | null, strings: readonly number[] = GUITAR_STRINGS): Cell[][] {
  return strings.map((open) => Array.from({ length: GUITAR_FRETS + 1 }, (_, f) => cell(open + f, chord, genre, song)));
}

/** Keys from `low` (a C) up two octaves. With `song`, scale mode. */
export function pianoCells(low: number, chord: Chord | null, genre?: GenreListening, song?: SongScale | null): Cell[] {
  return Array.from({ length: PIANO_KEYS }, (_, i) => cell(low + i, chord, genre, song));
}

export const isBlack = (note: number) => [1, 3, 6, 8, 10].includes(((note % 12) + 12) % 12);

/** Lowest and highest C the piano window can start on (C1 .. C6). */
const LOW_MIN = 24;
const LOW_MAX = 84;

/**
 * The piano window follows the player: it moves (by octaves) when the middle
 * of what they played lately leaves the window's inner part, so it doesn't
 * jump on every note. `notes` are the MIDI notes of their last bars.
 */
export function followWindow(low: number, notes: number[]): number {
  if (!notes.length) return low;
  const sorted = [...notes].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  if (mid >= low + 4 && mid <= low + 20) return low;
  const want = Math.round((mid - 12) / 12) * 12;
  return Math.max(LOW_MIN, Math.min(LOW_MAX, want));
}

/** Where the view is: the chord sounding and the next one, fading in on the beat before it. */
export interface ChordView {
  chord: Chord | null;
  /** Shown faintly during the beat before a change; null otherwise. */
  next: Chord | null;
}

/**
 * The chord at `beat` of `plan`, and the next one when a change comes within
 * a beat. `nextPlan` is the bar after (the page commits it at the start of
 * this bar's last beat, so it is known in time).
 */
export function chordView(chart: Chart, plan: BarPlan, beat: number, nextPlan?: BarPlan | null): ChordView {
  const slots = slotsOf(chart, plan);
  if (!slots.length) return { chord: null, next: null };
  const i = Math.max(0, slots.findIndex((s) => beat >= s.start && beat < s.start + s.dur));
  const cur = slots[i];
  const changeAt = cur.start + cur.dur;
  if (beat < changeAt - 1) return { chord: cur.chord, next: null };
  const after = i + 1 < slots.length ? slots[i + 1].chord : nextPlan ? (slotsOf(chart, nextPlan)[0]?.chord ?? null) : null;
  return { chord: cur.chord, next: after && after.symbol !== cur.chord.symbol ? after : null };
}

function slotsOf(chart: Chart, plan: BarPlan) {
  if (plan.kind === "count_in") return [];
  if (plan.liveHarmony && plan.chords.length) {
    const dur = chart.beatsPerBar / plan.chords.length;
    return plan.chords.map((sym, k) => ({ start: k * dur, dur, chord: parseChord(sym) }));
  }
  return chart.sections.get(plan.section)?.barChords(plan.barInSection) ?? [];
}
