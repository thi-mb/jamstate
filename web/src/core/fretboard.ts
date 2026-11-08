// What the fretboard view shows (v0.3): for the chord sounding, its chord
// tones (strong) and the genre's scale tones for it (faint), on a guitar neck
// (standard tuning, frets 0–15) or two octaves of piano that follow where the
// player plays. The player's notes are coloured by how they fit (noteFit, the
// same test the harmony listening uses). The page draws it (ui/fretboard.ts);
// this module only decides what goes where.

import type { BarPlan } from "./engine";
import type { Chart } from "./chart";
import type { GenreListening } from "./genre";
import { noteFit, type NoteFit } from "./listening";
import type { Chord } from "./theory";

export type FretboardKind = "guitar" | "piano" | "off";
export const FRETBOARD_KINDS: FretboardKind[] = ["guitar", "piano", "off"];

/** chord: a chord tone; scale: in the genre's scale for the chord; null: neither. */
export type Mark = "chord" | "scale" | null;

export interface Cell {
  /** MIDI note. */
  note: number;
  mark: Mark;
  root: boolean;
}

/** Strings high to low (as tab reads): E4 B3 G3 D3 A2 E2. */
export const GUITAR_STRINGS = [64, 59, 55, 50, 45, 40];
export const GUITAR_FRETS = 15;
/** Two octaves and the C on top. */
export const PIANO_KEYS = 25;

export function markOf(note: number, chord: Chord | null, genre?: GenreListening): Mark {
  if (!chord) return null;
  const fit: NoteFit = noteFit(((note % 12) + 12) % 12, chord, genre);
  return fit === "inside" ? "chord" : fit === "colour" ? "scale" : null;
}

const cell = (note: number, chord: Chord | null, genre?: GenreListening): Cell => ({
  note,
  mark: markOf(note, chord, genre),
  root: !!chord && ((note % 12) + 12) % 12 === chord.root,
});

/** Rows of cells, one per string (high first), frets 0..15. */
export function guitarCells(chord: Chord | null, genre?: GenreListening): Cell[][] {
  return GUITAR_STRINGS.map((open) => Array.from({ length: GUITAR_FRETS + 1 }, (_, f) => cell(open + f, chord, genre)));
}

/** Keys from `low` (a C) up two octaves. */
export function pianoCells(low: number, chord: Chord | null, genre?: GenreListening): Cell[] {
  return Array.from({ length: PIANO_KEYS }, (_, i) => cell(low + i, chord, genre));
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
  return chart.sections.get(plan.section)?.barChords(plan.barInSection) ?? [];
}
