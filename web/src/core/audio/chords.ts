// Chords from a strum (v0.5 layer 3, ADR-0024). A pitch-class profile of
// the strum (from a chroma, or from notes a transcription model heard) is
// matched against chord templates on all twelve roots, with a bonus for the
// chart's current and next chord. The chord found is played back as a real
// guitar voicing near the hand, so the fretboard shows a shape and the
// session holds notes a guitarist could have played.

import { fft, hann, SR } from "./dsp";
import { noteName, type Chord } from "../theory";

/** Chord qualities heard, as intervals over the root. */
export const QUALITY_TONES = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  "7": [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  m7b5: [0, 3, 6, 10],
  dim: [0, 3, 6],
  sus4: [0, 5, 7],
  "5": [0, 7],
} as const satisfies Record<string, readonly number[]>;
export type Quality = keyof typeof QUALITY_TONES;
const QUALITIES = Object.keys(QUALITY_TONES) as Quality[];

export interface ChordGuess {
  root: number;
  quality: Quality;
  /** The chord's symbol, e.g. "F#m7". */
  symbol: string;
  /** Cosine match with the bonus, 0..1+. */
  score: number;
}

/** What the chart says (the chord sounding and the next one), and the chord last heard. */
export interface ChordPrior {
  chord: Chord | null;
  next: Chord | null;
  /** An up strum without the bass is most likely the chord just strummed. */
  heard?: { root: number; quality: Quality } | null;
}

/** A strum in: 16 kHz audio and the onset's index. Out: a chord, or null when it's not clearly one. */
export interface ChordDetector {
  readonly name: string;
  /** How long after the onset the detector needs audio to (seconds). */
  readonly needs: number;
  detect(x: Float32Array, onset: number, prior?: ChordPrior | null): ChordGuess | null;
}

/** Below this the profile isn't called a chord. */
export const CHORD_FLOOR = 0.72;
/** Bonus for the chart's chord, the next one, and the chord last heard. */
const PRIOR_NOW = 0.08;
const PRIOR_NEXT = 0.04;
const PRIOR_HEARD = 0.05;
/** What a four-note or diminished chord gives away against a plain one. */
let COMPLEX = 0.03;
/** For the eval. */
export function setComplexity(x: number): void {
  COMPLEX = x;
}

/**
 * The quality a chart chord comes down to here (a 9 is a 7, a 6 a major
 * triad), or null for qualities with no template (augmented).
 */
export function reduceQuality(intervals: readonly number[]): Quality | null {
  const has = (i: number) => intervals.some((x) => x % 12 === i);
  const third = has(4) ? 4 : has(3) ? 3 : null;
  const fifth = has(7) ? 7 : has(6) ? 6 : has(8) ? 8 : null;
  const seventh = has(10) ? 10 : has(11) ? 11 : null;
  if (fifth === 8) return null;
  if (third === null) return has(5) ? "sus4" : has(2) ? "sus4" : "5";
  if (third === 4) return seventh === 10 ? "7" : seventh === 11 ? "maj7" : "";
  if (fifth === 6) return seventh === 10 ? "m7b5" : "dim";
  return seventh === 10 ? "m7" : "m";
}

/** A tone's partials, as (pitch class offset, weight): the octaves, the twelfth, the major third two octaves up. */
const PARTIALS: [number, number][] = [1, 2, 3, 4, 5, 6].map((h) => [Math.round(12 * Math.log2(h)) % 12, Math.pow(0.6, h - 1)]);

/**
 * A chord's expected profile: each tone with its partials (or without, for
 * a profile of notes), the root a little stronger (usually the bass, and loudest).
 */
function template(tones: readonly number[], partials: [number, number][]): Float64Array {
  const t = new Float64Array(12);
  for (const [i, tone] of tones.entries()) for (const [off, w] of partials) t[(tone + off) % 12] += w * (i === 0 ? 1.3 : 1);
  return t;
}
const templates = (partials: [number, number][]) =>
  QUALITIES.map((q) => {
    const t = template(QUALITY_TONES[q], partials);
    return { q, t, norm: Math.hypot(...t) };
  });
const TEMPLATES = { audio: templates(PARTIALS), notes: templates([[0, 1]]) };

/**
 * Match a pitch-class profile (12 non-negative values) against every chord.
 * `from`: a profile of audio (partials and all) or of notes already transcribed.
 */
export function matchChord(profile: ArrayLike<number>, prior?: ChordPrior | null, from: keyof typeof TEMPLATES = "audio"): ChordGuess | null {
  let norm = 0;
  for (let i = 0; i < 12; i++) norm += profile[i] ** 2;
  if (norm <= 0) return null;
  norm = Math.sqrt(norm);
  const favour = (c: Chord | null | undefined, root: number, q: Quality) =>
    !!c && c.root === root && reduceQuality(c.intervals) === q;
  let best: ChordGuess | null = null;
  for (const { q, t, norm: tn } of TEMPLATES[from]) {
    for (let root = 0; root < 12; root++) {
      let dot = 0;
      for (let i = 0; i < 12; i++) dot += t[i] * profile[(root + i) % 12];
      // Simpler chords first: a seventh or a diminished triad has to be clearly there.
      let score = dot / (norm * tn) - (QUALITY_TONES[q].length > 3 || q === "dim" ? COMPLEX : 0);
      if (favour(prior?.chord, root, q)) score += PRIOR_NOW;
      else if (favour(prior?.next, root, q)) score += PRIOR_NEXT;
      if (prior?.heard && prior.heard.root === root && prior.heard.quality === q) score += PRIOR_HEARD;
      if (!best || score > best.score) best = { root, quality: q, symbol: `${noteName(root)}${q}`, score };
    }
  }
  return best;
}

/**
 * Chroma of a strum: the window of `size` samples from `start`, folded into
 * pitch classes from 80 Hz to 2 kHz on log magnitudes, each bin to the
 * semitone it's nearest (bins between semitones count less).
 */
export class Chroma {
  private re: Float64Array;
  private im: Float64Array;
  private win: Float32Array;
  /** Per bin: its pitch class and weight. */
  private map: { pc: number; w: number }[] = [];

  constructor(readonly size = 2048, lo = 80, hi = 2000) {
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.win = hann(size);
    for (let k = 0; k <= size / 2; k++) {
      const f = (k * SR) / size;
      if (f < lo || f > hi) {
        this.map.push({ pc: 0, w: 0 });
        continue;
      }
      const p = 69 + 12 * Math.log2(f / 440);
      const near = Math.round(p);
      const off = Math.abs(p - near);
      this.map.push({ pc: ((near % 12) + 12) % 12, w: Math.max(0, 1 - off / 0.5) });
    }
  }

  of(x: Float32Array, start: number, out = new Float64Array(12)): Float64Array {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.re[i] = (x[start + i] ?? 0) * this.win[i];
      this.im[i] = 0;
    }
    fft(this.re, this.im);
    out.fill(0);
    // Peaks only: a bin counts when it's a local maximum (partials, not their skirts).
    const mag = (k: number) => Math.hypot(this.re[k], this.im[k]);
    let prev = mag(0);
    let cur = mag(1);
    for (let k = 1; k < n / 2; k++) {
      const next = mag(k + 1);
      const m = this.map[k];
      if (m.w > 0 && cur >= prev && cur >= next) out[m.pc] += m.w * Math.log1p(100 * cur);
      prev = cur;
      cur = next;
    }
    return out;
  }
}

/** The default detector: the chroma of the strum, matched against templates. */
export class ChromaChords implements ChordDetector {
  readonly name = "chroma";
  private chroma: Chroma;
  /** Skip the pick's noise at the start of the strum. */
  private skip = Math.round(0.03 * SR);

  constructor(readonly size = 2048) {
    this.chroma = new Chroma(size);
  }

  get needs(): number {
    return (this.skip + this.size) / SR;
  }

  /** The strum's pitch-class profile. */
  profile(x: Float32Array, onset: number): Float64Array {
    return this.chroma.of(x, onset + this.skip);
  }

  detect(x: Float32Array, onset: number, prior?: ChordPrior | null): ChordGuess | null {
    const g = matchChord(this.profile(x, onset), prior);
    return g && g.score >= CHORD_FLOOR ? g : null;
  }
}

// ---------- voicings ----------

export interface Voicing {
  /** Per string (high first, as the fretboard draws it): the fret, or null for a muted string. */
  frets: (number | null)[];
  /** The notes sounding, low to high. */
  notes: number[];
}

/**
 * A guitar voicing of `root` and `quality` for strings `strings` (high
 * first), near fret `hand`: every string either a chord tone in a four-fret
 * box or muted (at most one muted string between sounding ones), the root in
 * the bass, the third (and seventh) present, as many strings as fit. Open
 * strings count when the hand is low on the neck. Null when nothing fits.
 */
export function voiceGuitar(root: number, quality: Quality, strings: readonly number[], hand: number, frets = 15): Voicing | null {
  const tones = QUALITY_TONES[quality];
  const pcs = tones.map((t) => (root + t) % 12);
  // Tones a voicing needs: the root, the third or sus, the seventh.
  const needed = tones.filter((t) => t !== 7).map((t) => (root + t) % 12);
  const low = [...strings].reverse(); // low string first
  let best: { v: Voicing; score: number } | null = null;
  for (let p = Math.max(0, Math.round(hand) - 3); p <= Math.min(frets - 3, Math.round(hand) + 3); p++) {
    const choices = low.map((open) => {
      const c: (number | null)[] = [null];
      for (let f = p; f <= p + 3; f++) if (pcs.includes((open + f) % 12)) c.push(f);
      if (p <= 3 && p > 0 && pcs.includes(open % 12)) c.push(0);
      return c;
    });
    const pick: (number | null)[] = new Array(low.length).fill(null);
    const walk = (s: number) => {
      if (s === low.length) {
        const sounding = pick.map((f, i) => (f === null ? null : low[i] + f));
        const first = sounding.findIndex((n) => n !== null);
        const last = sounding.length - 1 - [...sounding].reverse().findIndex((n) => n !== null);
        if (first < 0) return;
        const notes = sounding.filter((n): n is number => n !== null);
        if (notes.length < Math.min(3, tones.length)) return;
        if (notes[0] % 12 !== root) return;
        const gaps = sounding.slice(first, last + 1).filter((n) => n === null).length;
        if (gaps > 1) return;
        const have = new Set(notes.map((n) => n % 12));
        if (!needed.every((pc) => have.has(pc))) return;
        // Low notes close together sound muddy.
        if (notes.length > 1 && notes[1] - notes[0] < 3 && notes[0] < 52) return;
        const fretted = pick.filter((f): f is number => f !== null && f > 0);
        const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
        const opens = pick.filter((f) => f === 0).length;
        const score = notes.length * 0.5 + (have.size === pcs.length ? 1 : 0) - gaps * 1.5 - span * 0.3 - Math.abs(p - hand) * 0.4 + (hand <= 3 ? opens * 0.3 : 0);
        if (!best || score > best.score) best = { v: { frets: [...pick].reverse(), notes }, score };
        return;
      }
      for (const f of choices[s]) {
        pick[s] = f;
        walk(s + 1);
      }
      pick[s] = null;
    };
    walk(0);
  }
  return best ? (best as { v: Voicing }).v : null;
}
