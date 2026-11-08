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
  "69": [0, 4, 7, 9, 14],
  "7b9": [0, 4, 7, 10, 13],
  "7#9": [0, 4, 7, 10, 15],
  "13": [0, 4, 7, 10, 14, 21],
  m11: [0, 3, 7, 10, 14, 17],
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

// ---------- degrees, scales and voicings (v0.1 groove) ----------

const has = (c: Chord, i: number) => c.intervals.some((x) => x % 12 === i);

/**
 * Semitones above the root for a degree name, read against the chord:
 * "3" is the chord's own third (minor or major), "7" its seventh (b7 when the
 * chord has none), and so on. Unknown names fall back to the root.
 */
export function degreeSemis(chord: Chord, name: string): number {
  switch (name) {
    case "R":
    case "1":
      return 0;
    case "2":
    case "9":
      return 2;
    case "b3":
      return 3;
    case "3":
      return has(chord, 3) && !has(chord, 4) ? 3 : has(chord, 5) && !has(chord, 4) && !has(chord, 3) ? 5 : 4;
    case "4":
    case "11":
      return 5;
    case "b5":
      return 6;
    case "5":
      return has(chord, 6) && !has(chord, 7) ? 6 : has(chord, 8) && !has(chord, 7) ? 8 : 7;
    case "6":
    case "13":
      return 9;
    case "b7":
      return 10;
    case "7":
      return has(chord, 11) ? 11 : has(chord, 9) && has(chord, 6) && !has(chord, 10) ? 9 : 10;
    case "8":
      return 12;
    default:
      return 0;
  }
}

export type ChordClass = "major" | "minor" | "dominant" | "half_diminished" | "diminished";
export const CHORD_CLASSES: ChordClass[] = ["major", "minor", "dominant", "half_diminished", "diminished"];

/** The family a chord belongs to, for genre scales (v0.3 listening). */
export function chordClass(chord: Chord): ChordClass {
  if (has(chord, 3) && has(chord, 6) && has(chord, 9) && !has(chord, 10)) return "diminished";
  if (has(chord, 3) && has(chord, 6) && !has(chord, 7)) return "half_diminished";
  if (has(chord, 3) && !has(chord, 4)) return "minor";
  if (has(chord, 10)) return "dominant";
  return "major";
}

/** Chord scale as semitones above the root, picked from the chord's quality. */
export function chordScale(chord: Chord): number[] {
  if (has(chord, 3) && has(chord, 6) && has(chord, 9) && !has(chord, 10)) return [0, 2, 3, 5, 6, 8, 9, 11]; // diminished
  if (has(chord, 3) && has(chord, 6)) return [0, 1, 3, 5, 6, 8, 10]; // locrian
  if (has(chord, 4) && has(chord, 8) && !has(chord, 7)) return [0, 2, 4, 6, 8, 10]; // whole tone
  if (has(chord, 3) && !has(chord, 4)) return [0, 2, 3, 5, 7, 9, 10]; // dorian
  if (has(chord, 11)) return [0, 2, 4, 5, 7, 9, 11]; // ionian
  if (has(chord, 10)) return [0, 2, 4, 5, 7, 9, 10]; // mixolydian
  return [0, 2, 4, 5, 7, 9, 11];
}

export type VoicingStyle = "close" | "shell" | "triad" | "stab";
export const VOICING_STYLES: VoicingStyle[] = ["close", "shell", "triad", "stab"];

/**
 * Pitch classes for a voicing style, in the order they'd stack from the bottom.
 * - close: the chord as written, at most four notes (v0).
 * - shell: rootless jazz voicing: 3rd, 7th (6th on a plain triad), 9th, plus the 5th or 13th.
 * - triad: root, 3rd, 5th, adding the b7 of a dominant chord. Rock and blues keys.
 * - stab: three high notes for funk hits: 3rd, 7th and 9th (5th instead of 7th on a plain major triad).
 */
export function voicingPcs(chord: Chord, style: VoicingStyle): number[] {
  const pc = (semi: number) => (chord.root + semi) % 12;
  const third = degreeSemis(chord, "3");
  const seventh = has(chord, 10) || has(chord, 11) || (has(chord, 9) && has(chord, 6)) ? degreeSemis(chord, "7") : null;
  const isDim = has(chord, 6) && has(chord, 3) && !has(chord, 7);
  const isMinor = has(chord, 3) && !has(chord, 4);
  const isDom = has(chord, 4) && has(chord, 10);
  let semis: number[];
  switch (style) {
    case "close":
      return voicingPitchClasses(chord);
    case "shell": {
      const top = isDim ? 5 : has(chord, 1) ? 1 : has(chord, 3) && has(chord, 4) ? 3 : 2; // 11 over half-dim, b9/#9 if written
      const sev = seventh ?? (isMinor ? 10 : 9);
      const fourth = isDom ? 9 : isDim ? degreeSemis(chord, "5") : 7;
      semis = [third, sev, top, fourth];
      break;
    }
    case "triad":
      semis = [0, third, degreeSemis(chord, "5"), ...(isDom ? [10] : [])];
      break;
    case "stab":
      semis = isDim ? [third, degreeSemis(chord, "5"), seventh ?? 9] : [third, seventh ?? (isMinor ? 10 : 7), 2];
      break;
  }
  return [...new Set(semis.map(pc))];
}

/**
 * Voice a chord near the previous voicing (smallest total movement), staying
 * inside [lo, hi] and pulled gently toward `center`. Every inversion in close
 * position is a candidate.
 */
export function voiceLead(pcs: number[], prev: number[] | null, lo: number, hi: number, center: number): number[] {
  let best: number[] = [];
  let bestScore = Infinity;
  for (let lowest = lo; lowest <= hi; lowest++) {
    const lowPc = lowest % 12;
    if (!pcs.includes(lowPc)) continue;
    const rest = pcs.filter((p) => p !== lowPc).sort((a, b) => ((a - lowPc + 12) % 12) - ((b - lowPc + 12) % 12));
    const notes = [lowest];
    for (const p of rest) {
      let n = notes[notes.length - 1] + 1;
      while (n % 12 !== p) n++;
      notes.push(n);
    }
    if (notes[notes.length - 1] > hi) continue;
    const mean = notes.reduce((a, b) => a + b, 0) / notes.length;
    let move = 0;
    if (prev && prev.length) {
      if (prev.length === notes.length) move = notes.reduce((s, n, i) => s + Math.abs(n - prev[i]), 0);
      else move = notes.reduce((s, n) => s + Math.min(...prev.map((p) => Math.abs(p - n))), 0);
    }
    const score = move + 0.6 * Math.abs(mean - center);
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = notes;
    }
  }
  return best.length ? best : voiceChord({ symbol: "", root: pcs[0], bass: pcs[0], intervals: pcs.map((p) => (p - pcs[0] + 12) % 12) }, center);
}

/** Root of a chord in the bass register (31–43), ignoring any slash bass. */
export function bassRoot(chord: Chord): number {
  const n = 36 + chord.root;
  return n > 43 ? n - 12 : n;
}

/** "F minor", "Fm", "A major", "Bb" → tonic pitch class and mode. Null if it can't be read. */
export function parseKey(key: string | undefined): { tonic: number; minor: boolean } | null {
  if (!key) return null;
  const m = /^\s*([A-G])([#b]?)\s*(m|min|minor|-)?\b/i.exec(key.replace(/♭/g, "b").replace(/♯/g, "#"));
  if (!m) return null;
  const letter = m[1].toUpperCase();
  if (!(letter in LETTERS)) return null;
  const minor = !!m[3] || /minor/i.test(key);
  return { tonic: pitchClass(letter, m[2]), minor };
}

const NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/** Spell a pitch class as a chord root (flats). */
export function noteName(pc: number): string {
  return NAMES[((pc % 12) + 12) % 12];
}
