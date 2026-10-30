// Chord symbols → pitch classes, voicings and bass notes.

const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const QUALITIES: Record<string, number[]> = {
  "": [0, 4, 7],
  maj: [0, 4, 7],
  M: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  "-": [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  "+": [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  sus: [0, 5, 7],
  "5": [0, 7],
  "6": [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  min7: [0, 3, 7, 10],
  "-7": [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  "7sus4": [0, 5, 7, 10],
  add9: [0, 4, 7, 14],
  "9": [0, 4, 7, 10, 14],
  m9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
};

export interface Chord {
  symbol: string;
  root: number; // pitch class 0–11
  bass: number; // pitch class of the bass note (differs from root for slash chords)
  intervals: number[];
}

const CHORD_RE = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/;

function pitchClass(letter: string, accidental: string): number {
  const offset = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
  return (LETTERS[letter] + offset + 12) % 12;
}

export function parseChord(symbol: string): Chord {
  const s = symbol.trim();
  const m = CHORD_RE.exec(s);
  if (!m) throw new Error(`Can't read chord "${symbol}"`);
  const [, letter, acc, quality, bassLetter, bassAcc] = m;
  const intervals = QUALITIES[quality];
  if (!intervals) throw new Error(`Unknown chord quality "${quality}" in "${symbol}"`);
  const root = pitchClass(letter, acc);
  const bass = bassLetter ? pitchClass(bassLetter, bassAcc ?? "") : root;
  return { symbol: s, root, bass, intervals };
}

/** Pitch classes to voice, at most four (drops the fifth first, then the highest extension). */
function voicingPitchClasses(chord: Chord): number[] {
  let ivs = [...chord.intervals];
  if (ivs.length > 4 && ivs.includes(7)) ivs = ivs.filter((i) => i !== 7);
  ivs = ivs.slice(0, 4);
  return [...new Set(ivs.map((i) => (chord.root + i) % 12))];
}

/**
 * A closed voicing whose average pitch is nearest `center`. Picking the
 * inversion this way keeps successive chords close together, which is a
 * cheap stand-in for voice leading.
 */
export function voiceChord(chord: Chord, center = 62): number[] {
  const pcs = voicingPitchClasses(chord);
  let best: number[] = [];
  let bestScore = Infinity;
  for (let lowest = 52; lowest <= 67; lowest++) {
    const lowPc = lowest % 12;
    if (!pcs.includes(lowPc)) continue;
    const rest = pcs.filter((p) => p !== lowPc).sort((a, b) => ((a - lowPc + 12) % 12) - ((b - lowPc + 12) % 12));
    const notes = [lowest];
    for (const p of rest) {
      let n = notes[notes.length - 1] + 1;
      while (n % 12 !== p) n++;
      notes.push(n);
    }
    const mean = notes.reduce((a, b) => a + b, 0) / notes.length;
    const score = Math.abs(mean - center);
    if (score < bestScore) {
      bestScore = score;
      best = notes;
    }
  }
  return best;
}

/** Bass register: between G1 (31) and G2 (43). */
export function bassNote(chord: Chord): number {
  const n = 36 + chord.bass;
  return n > 43 ? n - 12 : n;
}

/** Chord tones in a given octave range, for the simulated player. */
export function chordTones(chord: Chord, lo: number, hi: number): number[] {
  const pcs = chord.intervals.map((i) => (chord.root + i) % 12);
  const out: number[] = [];
  for (let n = lo; n <= hi; n++) if (pcs.includes(n % 12)) out.push(n);
  return out;
}
