// GuitarSet's JAMS annotations (v0.5 eval): notes per string, chords (the
// lead sheet's and what was played) and beats. Harte chord labels
// ("D#:maj7", "A:min7(*5)/b7") come down to the qualities heard here.

import { reduceQuality, type Quality } from "./chords";

export interface JamsNote {
  time: number;
  dur: number;
  note: number;
  string: number;
}
export interface JamsChord {
  time: number;
  dur: number;
  root: number;
  quality: Quality | null;
  label: string;
}
export interface Jams {
  notes: JamsNote[];
  /** The lead sheet's chords and the chords as played. */
  instructed: JamsChord[];
  performed: JamsChord[];
  beats: number[];
}

const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const HARTE: Record<string, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10],
  hdim7: [0, 3, 6, 10], dim7: [0, 3, 6, 9], minmaj7: [0, 3, 7, 11], maj6: [0, 4, 7, 9], min6: [0, 3, 7, 9], "9": [0, 4, 7, 10, 2],
  maj9: [0, 4, 7, 11, 2], min9: [0, 3, 7, 10, 2], "11": [0, 4, 7, 10, 2, 5], min11: [0, 3, 7, 10, 2, 5], sus2: [0, 2, 7], sus4: [0, 5, 7],
};
const DEGREES: Record<string, number> = { "1": 0, "2": 2, "3": 4, "4": 5, "5": 7, "6": 9, "7": 11, "9": 2, "11": 5, "13": 9 };

function degree(d: string): number | null {
  const m = /^([b#]*)(\d+)$/.exec(d);
  if (!m || DEGREES[m[2]] === undefined) return null;
  return (DEGREES[m[2]] + [...m[1]].reduce((s, c) => s + (c === "#" ? 1 : -1), 0) + 12) % 12;
}

/** A Harte label's root and the quality it comes down to. */
export function harte(label: string): { root: number; quality: Quality | null } | null {
  const [r, rest = "maj"] = label.split(":");
  if (!r || r === "N" || r === "X") return null;
  const root = (ROOTS[r[0]] + [...r.slice(1)].reduce((s, c) => s + (c === "#" ? 1 : c === "b" ? -1 : 0), 0) + 12) % 12;
  const body = rest.split("/")[0];
  const m = /^([a-z0-9]*)(?:\(([^)]*)\))?$/.exec(body);
  let tones = [...(HARTE[m?.[1] || (m?.[2] ? "" : "maj")] ?? (m?.[2] ? [] : [0, 4, 7]))];
  for (const d of (m?.[2] ?? "").split(",").filter(Boolean)) {
    if (d.startsWith("*")) {
      const x = degree(d.slice(1));
      tones = tones.filter((t) => t !== x);
    } else {
      const x = degree(d);
      if (x !== null && !tones.includes(x)) tones.push(x);
    }
  }
  if (!tones.includes(0)) tones.push(0);
  return { root, quality: reduceQuality(tones) };
}

interface Raw {
  annotations: { namespace: string; data: { time: number; duration: number; value: unknown }[] }[];
}

export function readJams(text: string): Jams {
  const j = JSON.parse(text) as Raw;
  const notes: JamsNote[] = [];
  let string = 0;
  const chords: JamsChord[][] = [];
  const beats: number[] = [];
  for (const a of j.annotations) {
    if (a.namespace === "note_midi") {
      for (const d of a.data) notes.push({ time: d.time, dur: d.duration, note: Math.round(d.value as number), string });
      string++;
    } else if (a.namespace === "chord") {
      chords.push(
        a.data.flatMap((d) => {
          const h = harte(d.value as string);
          return h ? [{ time: d.time, dur: d.duration, ...h, label: d.value as string }] : [];
        }),
      );
    } else if (a.namespace === "beat_position") beats.push(...a.data.map((d) => d.time));
  }
  notes.sort((a, b) => a.time - b.time);
  return { notes, instructed: chords[0] ?? [], performed: chords[1] ?? chords[0] ?? [], beats };
}

/** The chord at time `t`. */
export function chordAt(list: JamsChord[], t: number): JamsChord | null {
  return list.find((c) => t >= c.time && t < c.time + c.dur) ?? null;
}
