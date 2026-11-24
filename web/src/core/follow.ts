// Follow Me mode (v0.7): chartless, player-led improvisation.
// Infers tempo from cold onsets, key from pitch-class distributions, chords
// from either comping strums/voicings or single-note melodies, detects loops
// (2/4/8 bars), predicts next chords with a genre-aware Markov transition
// model, and exports the improvised jam as a valid ChartJSON. DOM-free.

import type { ChordPrior, Quality } from "./audio/chords";
import { bandJSON, type Band } from "./band";
import type { ChartJSON, SectionJSON } from "./chart";
import { isPitched, type PlayedNote } from "./features";
import { getGenre } from "./genres";
import { noteName, parseChord, type Chord } from "./theory";
import { clamp } from "./types";

export type FollowPhase = "listening" | "following" | "locked";
export type PlayStyle = "comping" | "melody";

// ---------- 1. Cold tempo latch-in from raw onsets ----------

export interface TempoEstimate {
  bpm: number;
  /** 0..1 agreement across recent inter-onset intervals. */
  confidence: number;
  onsets: number;
  ready: boolean;
}

/**
 * Estimates initial tempo from real-time note onset timestamps (seconds) before
 * the band has started. Collapses simultaneous chord notes (<65 ms) into one
 * rhythmic onset and folds IOIs into the 65–175 BPM beat octave.
 */
export class ColdTempo {
  private times: number[] = [];
  private readonly defaultBpm: number;

  constructor(defaultBpm = 108) {
    this.defaultBpm = clamp(defaultBpm, 60, 180);
  }

  reset(): void {
    this.times = [];
  }

  /** Record a note onset time in seconds (audio clock). */
  onset(timeSec: number): TempoEstimate {
    const last = this.times[this.times.length - 1];
    if (last !== undefined && timeSec - last < 0.065) return this.estimate();
    if (last !== undefined && timeSec - last > 3.0) this.times = [];
    this.times.push(timeSec);
    if (this.times.length > 24) this.times.shift();
    return this.estimate();
  }

  estimate(): TempoEstimate {
    const n = this.times.length;
    if (n < 3) return { bpm: this.defaultBpm, confidence: 0, onsets: n, ready: false };

    const iois: number[] = [];
    for (let i = 1; i < n; i++) {
      let dt = this.times[i] - this.times[i - 1];
      if (dt < 0.1 || dt > 2.4) continue;
      // Fold subdivisions / half-notes into a comfortable beat octave (65..175 BPM => 0.343..0.923 s).
      while (dt < 0.343) dt *= 2;
      while (dt > 0.923) dt /= 2;
      iois.push(dt);
    }
    if (iois.length < 2) return { bpm: this.defaultBpm, confidence: 0, onsets: n, ready: false };

    // Evaluate integer BPM candidates 65..175 with triangular kernel matching.
    let bestBpm = this.defaultBpm;
    let bestScore = -1;
    let rawAgree = 0;
    for (let bpm = 65; bpm <= 175; bpm++) {
      const target = 60 / bpm;
      let agree = 0;
      for (const dt of iois) {
        const err = Math.abs(dt - target) / target;
        if (err < 0.1) agree += 1 - err / 0.1;
      }
      // Gentle musical prior around 85..135 BPM so octave ties resolve naturally.
      const prior = 1 - 0.12 * Math.abs(bpm - 110) / 65;
      const score = (agree / iois.length) * prior;
      if (score > bestScore) {
        bestScore = score;
        bestBpm = bpm;
        rawAgree = agree / iois.length;
      }
    }

    const confidence = clamp(rawAgree, 0, 1);
    const ready = n >= 4 && confidence >= 0.45;
    return { bpm: bestBpm, confidence: Math.round(confidence * 100) / 100, onsets: n, ready };
  }
}

// ---------- 2. Key inference (Krumhansl-Schmuckler) ----------

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyEstimate {
  tonic: number;
  minor: boolean;
  name: string;
  confidence: number;
}

function pearson(a: ArrayLike<number>, b: readonly number[], shift: number): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[(i + shift) % 12];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const xa = a[(i + shift) % 12] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  return da > 1e-9 && db > 1e-9 ? num / Math.sqrt(da * db) : 0;
}

/** Infer tonic and major/minor mode from a 12-element pitch-class weight histogram. */
export function inferKey(pcWeights: ArrayLike<number>): KeyEstimate | null {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += pcWeights[i];
  if (sum <= 1e-6) return null;

  let best = { tonic: 0, minor: false, score: -Infinity };
  let second = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const score = pearson(pcWeights, minor ? KS_MINOR : KS_MAJOR, tonic);
      if (score > best.score) {
        second = best.score;
        best = { tonic, minor, score };
      } else if (score > second) {
        second = score;
      }
    }
  }
  const margin = Math.max(0, best.score - second);
  const confidence = clamp(0.55 * Math.max(0, best.score) + 1.8 * margin, 0, 1);
  return {
    tonic: best.tonic,
    minor: best.minor,
    name: `${noteName(best.tonic)} ${best.minor ? "minor" : "major"}`,
    confidence: Math.round(confidence * 100) / 100,
  };
}

// ---------- 3. Genre-aware Markov harmonic transitions ----------

interface DegreeSpec {
  /** Semitones above tonic (0..11). */
  semi: number;
  quality: Quality;
}

type TransitionTable = Record<string, { to: string; weight: number }[]>;

const MAJOR_DEGREES: Record<string, DegreeSpec> = {
  I: { semi: 0, quality: "" },
  Imaj7: { semi: 0, quality: "maj7" },
  I7: { semi: 0, quality: "7" },
  ii: { semi: 2, quality: "m" },
  ii7: { semi: 2, quality: "m7" },
  iii7: { semi: 4, quality: "m7" },
  IV: { semi: 5, quality: "" },
  IVmaj7: { semi: 5, quality: "maj7" },
  IV7: { semi: 5, quality: "7" },
  V: { semi: 7, quality: "" },
  V7: { semi: 7, quality: "7" },
  vi: { semi: 9, quality: "m" },
  vi7: { semi: 9, quality: "m7" },
  bVII: { semi: 10, quality: "" },
};

const MINOR_DEGREES: Record<string, DegreeSpec> = {
  i: { semi: 0, quality: "m" },
  i7: { semi: 0, quality: "m7" },
  ii7b5: { semi: 2, quality: "m7b5" },
  bIII: { semi: 3, quality: "" },
  bIIImaj7: { semi: 3, quality: "maj7" },
  iv: { semi: 5, quality: "m" },
  iv7: { semi: 5, quality: "m7" },
  IV7: { semi: 5, quality: "7" },
  v7: { semi: 7, quality: "m7" },
  V7: { semi: 7, quality: "7" },
  bVI: { semi: 8, quality: "" },
  bVImaj7: { semi: 8, quality: "maj7" },
  bVII: { semi: 10, quality: "" },
  bVII7: { semi: 10, quality: "7" },
};

const MARKOV_MAJOR: Record<string, TransitionTable> = {
  funk: {
    I7: [
      { to: "I7", weight: 0.45 },
      { to: "IV7", weight: 0.3 },
      { to: "bVII", weight: 0.15 },
      { to: "V7", weight: 0.1 },
    ],
    IV7: [
      { to: "I7", weight: 0.55 },
      { to: "V7", weight: 0.25 },
      { to: "bVII", weight: 0.2 },
    ],
    V7: [
      { to: "IV7", weight: 0.45 },
      { to: "I7", weight: 0.55 },
    ],
    bVII: [
      { to: "I7", weight: 0.6 },
      { to: "IV7", weight: 0.4 },
    ],
  },
  "blues-rock": {
    I7: [
      { to: "IV7", weight: 0.42 },
      { to: "I7", weight: 0.33 },
      { to: "V7", weight: 0.15 },
      { to: "bVII", weight: 0.1 },
    ],
    IV7: [
      { to: "I7", weight: 0.55 },
      { to: "V7", weight: 0.3 },
      { to: "IV7", weight: 0.15 },
    ],
    V7: [
      { to: "IV7", weight: 0.5 },
      { to: "I7", weight: 0.5 },
    ],
    bVII: [
      { to: "IV", weight: 0.5 },
      { to: "I", weight: 0.5 },
    ],
  },
  jazz: {
    Imaj7: [
      { to: "ii7", weight: 0.35 },
      { to: "vi7", weight: 0.35 },
      { to: "IVmaj7", weight: 0.2 },
      { to: "iii7", weight: 0.1 },
    ],
    ii7: [
      { to: "V7", weight: 0.72 },
      { to: "iii7", weight: 0.15 },
      { to: "Imaj7", weight: 0.13 },
    ],
    iii7: [
      { to: "vi7", weight: 0.65 },
      { to: "IVmaj7", weight: 0.35 },
    ],
    IVmaj7: [
      { to: "ii7", weight: 0.45 },
      { to: "V7", weight: 0.35 },
      { to: "Imaj7", weight: 0.2 },
    ],
    V7: [
      { to: "Imaj7", weight: 0.68 },
      { to: "vi7", weight: 0.2 },
      { to: "ii7", weight: 0.12 },
    ],
    vi7: [
      { to: "ii7", weight: 0.68 },
      { to: "IVmaj7", weight: 0.2 },
      { to: "V7", weight: 0.12 },
    ],
  },
  default: {
    I: [
      { to: "IV", weight: 0.32 },
      { to: "V", weight: 0.28 },
      { to: "vi", weight: 0.25 },
      { to: "ii", weight: 0.15 },
    ],
    ii: [
      { to: "V", weight: 0.65 },
      { to: "IV", weight: 0.2 },
      { to: "I", weight: 0.15 },
    ],
    IV: [
      { to: "V", weight: 0.45 },
      { to: "I", weight: 0.4 },
      { to: "ii", weight: 0.15 },
    ],
    V: [
      { to: "I", weight: 0.6 },
      { to: "vi", weight: 0.25 },
      { to: "IV", weight: 0.15 },
    ],
    vi: [
      { to: "IV", weight: 0.45 },
      { to: "ii", weight: 0.3 },
      { to: "V", weight: 0.25 },
    ],
  },
};

const MARKOV_MINOR: Record<string, TransitionTable> = {
  funk: {
    i7: [
      { to: "i7", weight: 0.45 },
      { to: "IV7", weight: 0.28 },
      { to: "bVII", weight: 0.15 },
      { to: "bVI", weight: 0.12 },
    ],
    IV7: [
      { to: "i7", weight: 0.58 },
      { to: "bVII", weight: 0.24 },
      { to: "V7", weight: 0.18 },
    ],
    bVI: [
      { to: "bVII", weight: 0.55 },
      { to: "V7", weight: 0.45 },
    ],
    bVII: [
      { to: "i7", weight: 0.65 },
      { to: "bVI", weight: 0.35 },
    ],
    V7: [{ to: "i7", weight: 1 }],
  },
  "blues-rock": {
    i7: [
      { to: "iv7", weight: 0.42 },
      { to: "bVII", weight: 0.28 },
      { to: "bVI", weight: 0.18 },
      { to: "V7", weight: 0.12 },
    ],
    iv7: [
      { to: "i7", weight: 0.55 },
      { to: "V7", weight: 0.3 },
      { to: "bVI", weight: 0.15 },
    ],
    bVI: [
      { to: "V7", weight: 0.55 },
      { to: "bVII", weight: 0.45 },
    ],
    bVII: [
      { to: "i7", weight: 0.6 },
      { to: "bVI", weight: 0.4 },
    ],
    V7: [
      { to: "i7", weight: 0.65 },
      { to: "iv7", weight: 0.35 },
    ],
  },
  jazz: {
    i7: [
      { to: "ii7b5", weight: 0.35 },
      { to: "iv7", weight: 0.35 },
      { to: "bVImaj7", weight: 0.2 },
      { to: "bIIImaj7", weight: 0.1 },
    ],
    ii7b5: [{ to: "V7", weight: 0.85 }, { to: "i7", weight: 0.15 }],
    iv7: [
      { to: "bVII7", weight: 0.45 },
      { to: "V7", weight: 0.35 },
      { to: "i7", weight: 0.2 },
    ],
    bVImaj7: [
      { to: "ii7b5", weight: 0.5 },
      { to: "V7", weight: 0.5 },
    ],
    bVII7: [{ to: "bIIImaj7", weight: 0.6 }, { to: "i7", weight: 0.4 }],
    bIIImaj7: [{ to: "ii7b5", weight: 0.5 }, { to: "bVImaj7", weight: 0.5 }],
    V7: [{ to: "i7", weight: 0.8 }, { to: "bVImaj7", weight: 0.2 }],
  },
  default: {
    i: [
      { to: "bVI", weight: 0.32 },
      { to: "bVII", weight: 0.28 },
      { to: "iv", weight: 0.25 },
      { to: "V7", weight: 0.15 },
    ],
    iv: [
      { to: "V7", weight: 0.45 },
      { to: "i", weight: 0.35 },
      { to: "bVII", weight: 0.2 },
    ],
    bVI: [
      { to: "bVII", weight: 0.5 },
      { to: "V7", weight: 0.35 },
      { to: "iv", weight: 0.15 },
    ],
    bVII: [
      { to: "i", weight: 0.55 },
      { to: "bVI", weight: 0.25 },
      { to: "bIII", weight: 0.2 },
    ],
    V7: [{ to: "i", weight: 1 }],
  },
};

function degreeToSymbol(deg: string, key: KeyEstimate): string {
  const dict = key.minor ? MINOR_DEGREES : MAJOR_DEGREES;
  const spec = dict[deg];
  if (!spec) return noteName(key.tonic) + (key.minor ? "m" : "");
  return noteName((key.tonic + spec.semi) % 12) + spec.quality;
}

function matchDegree(chord: Chord, key: KeyEstimate, table: TransitionTable): string | null {
  const semi = (chord.root - key.tonic + 12) % 12;
  const dict = key.minor ? MINOR_DEGREES : MAJOR_DEGREES;
  const isMinor = chord.intervals.includes(3) && !chord.intervals.includes(4);
  const isDom = chord.intervals.includes(4) && chord.intervals.includes(10);
  let bestKey: string | null = null;
  let bestScore = -1;
  for (const deg of Object.keys(table)) {
    const spec = dict[deg];
    if (!spec || spec.semi !== semi) continue;
    const specMinor = spec.quality.startsWith("m") && spec.quality !== "maj7";
    const specDom = spec.quality === "7";
    let sc = 1;
    if (specMinor === isMinor) sc += 1;
    if (specDom === isDom) sc += 0.5;
    if (sc > bestScore) {
      bestScore = sc;
      bestKey = deg;
    }
  }
  return bestKey;
}

/** Genre-aware next-chord candidates with probabilities (key-invariant Markov model). */
export function nextChordCandidates(current: Chord | null, key: KeyEstimate | null, genre: string): { symbol: string; weight: number }[] {
  if (!key) return current ? [{ symbol: current.symbol, weight: 1 }] : [];
  const maps = key.minor ? MARKOV_MINOR : MARKOV_MAJOR;
  const table = maps[genre] ?? maps.default;
  if (current) {
    const deg = matchDegree(current, key, table);
    if (deg && table[deg]?.length) {
      return table[deg].map((t) => ({ symbol: degreeToSymbol(t.to, key), weight: t.weight }));
    }
  }
  // Default tonic -> most likely continuation in this genre
  const firstDeg = Object.keys(table)[0];
  return (table[firstDeg] ?? []).map((t) => ({ symbol: degreeToSymbol(t.to, key), weight: t.weight }));
}

export function predictNextChord(current: Chord | null, key: KeyEstimate | null, genre: string): string | null {
  const cands = nextChordCandidates(current, key, genre);
  if (!cands.length) return current?.symbol ?? null;
  cands.sort((a, b) => b.weight - a.weight);
  return cands[0].symbol;
}

// ---------- 4. Bar chord inference (comping + single-note melody) ----------

const CHORD_CANDIDATES: { quality: Quality; tones: readonly number[]; complexity: number }[] = [
  { quality: "", tones: [0, 4, 7], complexity: 0 },
  { quality: "m", tones: [0, 3, 7], complexity: 0 },
  { quality: "7", tones: [0, 4, 7, 10], complexity: 0.02 },
  { quality: "m7", tones: [0, 3, 7, 10], complexity: 0.02 },
  { quality: "maj7", tones: [0, 4, 7, 11], complexity: 0.025 },
  { quality: "m7b5", tones: [0, 3, 6, 10], complexity: 0.04 },
  { quality: "sus4", tones: [0, 5, 7], complexity: 0.03 },
];

const MAJOR_SCALE = new Set([0, 2, 4, 5, 7, 9, 11]);
const MINOR_SCALE = new Set([0, 2, 3, 5, 7, 8, 10]);

export interface BarChordGuess {
  chord: Chord;
  symbol: string;
  confidence: number;
  style: PlayStyle;
}

/** Detect whether the bar's pitched notes look like polyphonic comping or a single-note melody. */
export function classifyPlayStyle(notes: PlayedNote[]): PlayStyle {
  const pitched = notes.filter(isPitched).sort((a, b) => a.start - b.start);
  if (pitched.length < 3) return "melody";
  let chords = 0;
  for (let i = 0; i < pitched.length; ) {
    let j = i + 1;
    const pcs = new Set([pitched[i].note % 12]);
    while (j < pitched.length && pitched[j].start - pitched[i].start < 0.16) {
      pcs.add(pitched[j].note % 12);
      j++;
    }
    if (pcs.size >= 3) chords++;
    i = j;
  }
  return chords >= 1 ? "comping" : "melody";
}

/**
 * Infer the best chord for a bar of player notes.
 * - Comping: weights notes by duration × velocity, favouring the lowest sounding note as root.
 * - Melody: weights strong beats (1 & 3) and held notes, leaning on diatonic key chords
 *   and genre Markov transitions so single-note solos get natural harmonic backing.
 */
export function inferBarChord(
  notes: PlayedNote[],
  bpb: number,
  opts: { key?: KeyEstimate | null; prevChord?: Chord | null; genre?: string } = {},
): BarChordGuess | null {
  const pitched = notes.filter(isPitched);
  if (!pitched.length) return null;

  const style = classifyPlayStyle(pitched);
  const profile = new Float64Array(12);
  let lowestNote = Infinity;
  let totalWeight = 0;

  for (const n of pitched) {
    const pc = ((n.note % 12) + 12) % 12;
    const dur = Math.max(0.2, Math.min(bpb, n.dur));
    const vel = Math.max(0.2, n.vel / 127);
    let w = dur * vel;
    if (style === "melody") {
      const beatDist = Math.abs(n.start - Math.round(n.start));
      const nearestBeat = Math.round(n.start);
      const strong = beatDist < 0.15 && (nearestBeat === 0 || nearestBeat === 2);
      const onBeat = beatDist < 0.15;
      w *= strong ? 1.9 : onBeat ? 1.3 : 0.65;
    }
    profile[pc] += w;
    totalWeight += w;
    if (n.note < lowestNote) lowestNote = n.note;
  }
  if (totalWeight <= 1e-6) return null;

  // Bass/lowest note boost in comping mode (helps separate Am7 from C6).
  const bassPc = ((lowestNote % 12) + 12) % 12;
  if (style === "comping") profile[bassPc] *= 1.35;

  const pNorm = Math.hypot(...profile);
  if (pNorm <= 1e-6) return null;

  const key = opts.key ?? null;
  const scale = key ? (key.minor ? MINOR_SCALE : MAJOR_SCALE) : null;
  const markov = new Map<string, number>();
  if (opts.genre && (key || opts.prevChord)) {
    for (const c of nextChordCandidates(opts.prevChord ?? null, key, opts.genre)) markov.set(c.symbol, c.weight);
  }

  let best: { root: number; quality: Quality; score: number } | null = null;
  for (let root = 0; root < 12; root++) {
    for (const cand of CHORD_CANDIDATES) {
      let dot = 0;
      let tNormSq = 0;
      let diatonicHits = 0;
      for (let i = 0; i < cand.tones.length; i++) {
        const pc = (root + cand.tones[i]) % 12;
        const tw = i === 0 ? 1.25 : 1.0;
        dot += profile[pc] * tw;
        tNormSq += tw * tw;
        if (scale && key && scale.has((pc - key.tonic + 12) % 12)) diatonicHits++;
      }
      let score = dot / (pNorm * Math.sqrt(tNormSq)) - cand.complexity;
      if (style === "comping" && root === bassPc) score += 0.06;

      // Diatonic key bonus (stronger when harmonizing a single-note melody).
      if (key && scale) {
        const diatonicFrac = diatonicHits / cand.tones.length;
        const keyBoost = (style === "melody" ? 0.2 : 0.08) * key.confidence;
        score += diatonicFrac === 1 ? keyBoost : -0.05 * (1 - diatonicFrac) * key.confidence;
      }

      // Genre Markov transition bonus (keeps harmonic motion idiomatic).
      const sym = noteName(root) + cand.quality;
      const trans = markov.get(sym);
      if (trans) score += (style === "melody" ? 0.1 : 0.04) * trans;

      // In jazz/funk, gently prefer 7th colours when the 7th is actually present in the profile.
      if (opts.genre === "jazz" && (cand.quality === "m7" || cand.quality === "maj7" || cand.quality === "7")) {
        const seventhPc = (root + cand.tones[3]) % 12;
        if (profile[seventhPc] > 0) score += 0.03;
      }

      if (!best || score > best.score) best = { root, quality: cand.quality, score };
    }
  }

  if (!best || best.score < 0.42) return null;
  const symbol = noteName(best.root) + best.quality;
  return {
    chord: parseChord(symbol),
    symbol,
    confidence: Math.round(clamp(best.score, 0, 1) * 100) / 100,
    style,
  };
}

// ---------- 5. Loop detection + 3-stage Follow Me state machine ----------

/** Detect a repeating chord cycle of length 2, 4 or 8 at the tail of `history`. */
export function detectLoop(history: string[]): string[] | null {
  const n = history.length;
  for (const len of [4, 2, 8]) {
    if (n < len * 2) continue;
    let matches = 0;
    for (let i = 0; i < len; i++) {
      if (history[n - len + i] === history[n - 2 * len + i]) matches++;
    }
    // Exact match for 2-bar loops; allow at most 1 turnaround variation in 4/8-bar loops.
    if (matches === len || (len >= 4 && matches >= len - 1)) {
      return history.slice(n - len);
    }
  }
  return null;
}

export interface FollowStatus {
  phase: FollowPhase;
  chord: string | null;
  nextChord: string | null;
  key: KeyEstimate | null;
  confidence: number;
  style: PlayStyle;
  loop: string[] | null;
  locked: boolean;
  /** True when the player just pivoted away from the predicted chord. */
  pivoted: boolean;
  barsHeard: number;
}

export class FollowMeController {
  private pcAccum = new Float64Array(12);
  private history: string[] = [];
  private detectedLoop: string[] | null = null;
  private loopPos = 0;
  private locked = false;
  private phase: FollowPhase = "listening";
  private currentChord: Chord | null = null;
  private predictedNext: string | null = null;
  private key: KeyEstimate | null = null;
  private lastStyle: PlayStyle = "comping";
  private lastConfidence = 0;

  constructor(
    public genre: string,
    public bpm: number,
  ) {}

  reset(genre = this.genre, bpm = this.bpm): void {
    this.genre = genre;
    this.bpm = bpm;
    this.pcAccum.fill(0);
    this.history = [];
    this.detectedLoop = null;
    this.loopPos = 0;
    this.locked = false;
    this.phase = "listening";
    this.currentChord = null;
    this.predictedNext = null;
    this.key = null;
    this.lastStyle = "comping";
    this.lastConfidence = 0;
  }

  get status(): FollowStatus {
    return {
      phase: this.phase,
      chord: this.currentChord?.symbol ?? null,
      nextChord: this.predictedNext,
      key: this.key,
      confidence: this.lastConfidence,
      style: this.lastStyle,
      loop: this.detectedLoop ? [...this.detectedLoop] : null,
      locked: this.locked,
      pivoted: false,
      barsHeard: this.history.length,
    };
  }

  /** Current ChordPrior for v0.5 audio chord detection (replaces static chart prior). */
  chordPrior(): ChordPrior | null {
    if (!this.currentChord && !this.predictedNext) return null;
    let next: Chord | null = null;
    if (this.predictedNext) {
      try {
        next = parseChord(this.predictedNext);
      } catch {
        next = null;
      }
    }
    return { chord: this.currentChord, next };
  }

  /** Lock or unlock the detected progression so the player can solo freely over it. */
  setLocked(on: boolean): FollowStatus {
    if (on) {
      if (!this.detectedLoop && this.history.length >= 2) {
        const len = this.history.length >= 4 ? 4 : 2;
        this.detectedLoop = this.history.slice(-len);
        this.loopPos = 0;
      }
      if (this.detectedLoop) {
        this.locked = true;
        this.phase = "locked";
      }
    } else {
      this.locked = false;
      this.phase = this.currentChord ? "following" : "listening";
    }
    return this.status;
  }

  toggleLock(): FollowStatus {
    return this.setLocked(!this.locked);
  }

  /**
   * Observe one finished bar of player notes and compute the live chord + next
   * chord prediction for the upcoming bar.
   */
  observeBar(notes: PlayedNote[], bpb: number): FollowStatus {
    // Accumulate decaying pitch-class histogram for key inference.
    for (let i = 0; i < 12; i++) this.pcAccum[i] *= 0.88;
    for (const n of notes) {
      if (!isPitched(n)) continue;
      const pc = ((n.note % 12) + 12) % 12;
      this.pcAccum[pc] += Math.max(0.2, n.dur) * Math.max(0.25, n.vel / 127);
    }
    const nextKey = inferKey(this.pcAccum);
    if (nextKey && (!this.key || nextKey.confidence >= 0.3)) this.key = nextKey;

    // Locked loop: walk the locked chords deterministically while the player solos.
    if (this.locked && this.detectedLoop?.length) {
      const sym = this.detectedLoop[this.loopPos % this.detectedLoop.length];
      const nxt = this.detectedLoop[(this.loopPos + 1) % this.detectedLoop.length];
      this.loopPos = (this.loopPos + 1) % this.detectedLoop.length;
      this.currentChord = parseChord(sym);
      this.predictedNext = nxt;
      this.history.push(sym);
      return { ...this.status, pivoted: false };
    }

    const guess = inferBarChord(notes, bpb, { key: this.key, prevChord: this.currentChord, genre: this.genre });
    if (!guess) {
      // Player rested this bar: keep the current/predicted groove cycling smoothly.
      if (this.detectedLoop?.length) {
        const sym = this.detectedLoop[this.loopPos % this.detectedLoop.length];
        const nxt = this.detectedLoop[(this.loopPos + 1) % this.detectedLoop.length];
        this.loopPos = (this.loopPos + 1) % this.detectedLoop.length;
        this.currentChord = parseChord(sym);
        this.predictedNext = nxt;
      }
      return { ...this.status, pivoted: false };
    }

    this.lastStyle = guess.style;
    this.lastConfidence = guess.confidence;

    const expected = this.predictedNext;
    const pivoted = this.phase !== "listening" && !!expected && expected !== guess.symbol && guess.confidence >= 0.58;

    this.currentChord = guess.chord;
    this.history.push(guess.symbol);
    if (this.history.length > 64) this.history.shift();
    this.phase = "following";

    // Check for a repeating 2/4/8-bar progression at the tail of history.
    const loop = detectLoop(this.history);
    if (loop) {
      this.detectedLoop = loop;
      this.loopPos = 0;
      this.predictedNext = loop[0];
    } else if (pivoted) {
      // Player broke out of the old loop — clear it and predict via genre Markov model.
      this.detectedLoop = null;
      this.predictedNext = predictNextChord(this.currentChord, this.key, this.genre);
    } else if (this.detectedLoop?.length) {
      const idx = this.detectedLoop.indexOf(guess.symbol);
      if (idx >= 0) {
        this.loopPos = (idx + 1) % this.detectedLoop.length;
        this.predictedNext = this.detectedLoop[this.loopPos];
      } else {
        this.predictedNext = predictNextChord(this.currentChord, this.key, this.genre);
      }
    } else {
      this.predictedNext = predictNextChord(this.currentChord, this.key, this.genre);
    }

    return { ...this.status, pivoted };
  }

  /** Export the improvised jam into a clean, schema-valid ChartJSON. */
  exportChart(opts: { title?: string; band?: Band } = {}): ChartJSON {
    const title = opts.title?.trim() || (this.key ? `Free Jam in ${this.key.name}` : "Free Jam");
    const bpm = Math.round(clamp(this.bpm, 40, 240));
    const sections: SectionJSON[] = [];
    const form: string[] = [];

    if (this.detectedLoop?.length) {
      sections.push({ name: "groove", bars: Math.max(4, this.detectedLoop.length * 2), chords: [...this.detectedLoop], intensity: 0.55 });
      form.push("groove", "groove");
    } else if (this.history.length >= 2) {
      // Group history into 4-bar or 8-bar sections (deduplicating identical repeats).
      const chunkSize = this.history.length >= 8 ? 4 : this.history.length;
      const seen = new Map<string, string>();
      const names = ["verse", "chorus", "bridge", "outro"];
      for (let i = 0; i < this.history.length; i += chunkSize) {
        const chords = this.history.slice(i, i + chunkSize);
        if (chords.length < 2 && sections.length > 0) break;
        const sig = chords.join("|");
        let name = seen.get(sig);
        if (!name) {
          name = names[seen.size] ?? `part_${seen.size + 1}`;
          seen.set(sig, name);
          sections.push({ name, bars: chords.length, chords, intensity: seen.size === 2 ? 0.75 : 0.5 });
        }
        form.push(name);
      }
    } else {
      const fallback = this.currentChord?.symbol ?? (this.key ? noteName(this.key.tonic) + (this.key.minor ? "m7" : "7") : "Am7");
      sections.push({ name: "jam", bars: 4, chords: [fallback], intensity: 0.5 });
      form.push("jam");
    }

    return {
      version: "0.2",
      title,
      bpm,
      time_sig: "4/4",
      ...(this.key ? { key: this.key.name } : {}),
      genre: getGenre(this.genre).id,
      count_in: 1,
      ...(opts.band ? { band: bandJSON(opts.band) } : {}),
      sections,
      form,
    };
  }
}

/** Valid placeholder chart used to bootstrap Engine in Follow Me mode (no count-in, loops forever). */
export function freeJamChart(genreId: string, bpm: number, startChord?: string): ChartJSON {
  const g = getGenre(genreId);
  const chord = startChord ?? (g.id === "jazz" ? "Dm7" : g.id === "blues-rock" ? "A7" : "Fm7");
  return {
    version: "0.2",
    title: "Follow Me",
    bpm: Math.round(clamp(bpm, 40, 240)),
    time_sig: "4/4",
    genre: g.id,
    count_in: 0,
    sections: [{ name: "jam", bars: 4, chords: [chord], intensity: 0.35 }],
    form: ["jam"],
  };
}
