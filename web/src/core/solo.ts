// A simple soloist for trading fours (v0.4, ADR-0022). When the player lays
// out after their turn, a band instrument takes the next turn:
//
// - Keys, guitar or bass answer with the player's own phrase: played back,
//   answered with the notes turned round, a fragment repeated, then landing
//   on a held chord tone with the last beat left free for the player. Notes
//   that clash with the chord sounding move to the nearest one the player
//   used that fits, or a chord tone.
// - Drums answer the player's phrase too: their rhythm stated on the snare,
//   answered on the toms, filled in with ghost notes, then a tom run into the
//   player's downbeat, louder through the turn, the hi-hat foot on 2 and 4.
//
// Notes are on the straight grid; the engine adds swing and humanize as for
// any part. Seeded by the session seed and the turn, so replays match.

import type { Chart } from "./chart";
import type { BarContext } from "./engine";
import { songScale } from "./fretboard";
import { DRUM } from "./groove";
import { rngFor } from "./rand";
import { chordScale, type Chord } from "./theory";
import { clamp, type NoteEvent, type Part } from "./types";

/** A note of the player's phrase, in beats from the start of their turn. */
export interface MotifNote {
  start: number;
  dur: number;
  note: number;
  vel: number;
}

/** A band turn while trading: who plays, from which bar, for how long, answering what. */
export interface Solo {
  part: Part;
  from: number;
  bars: number;
  /** The player's last turn, which a melodic soloist answers. */
  motif: MotifNote[];
}

const EPS = 1e-6;
const vel = (v: number) => Math.round(clamp(v, 1, 127));
const RANGE: Partial<Record<Part, [number, number]>> = { chords: [60, 84], guitar: [55, 79], bass: [36, 57] };

function chordAt(ctx: BarContext, t: number): Chord {
  for (let i = ctx.slots.length - 1; i >= 0; i--) if (t >= ctx.slots[i].start - EPS) return ctx.slots[i].chord;
  return ctx.slots[0].chord;
}

/** A note of the player's phrase within one bar: beat on the eighth grid, pitch, velocity. */
interface Cell {
  t: number;
  note: number;
  vel: number;
}

/** Plays band turns. A melodic turn is built once from the player's phrase; the bars play it out. */
export class Soloist {
  private turn: Solo | null = null;
  /** The player's phrase by bar, moved into the soloist's range. */
  private bars: Cell[][] = [];
  /** The pitch classes the player used. */
  private pcs: number[] = [];

  /** The song's scale for this turn (from the chart's key and the genre), null without a key. */
  private key: number[] | null = null;

  constructor(
    private seed: number,
    private chart?: Chart,
  ) {}

  /** One bar of the band's turn: `i` is the bar within the turn. */
  bar(ctx: BarContext, solo: Solo, i: number): NoteEvent[] {
    if (this.turn !== solo) {
      this.turn = solo;
      this.learn(solo, ctx.bpb);
      this.key = this.chart ? (songScale(this.chart, ctx.genre.listening)?.pcs ?? null) : null;
    }
    const rand = rngFor(this.seed, "solo", solo.part, solo.from, i);
    return solo.part === "drums" ? this.drumBar(ctx, solo, i, rand) : this.lineBar(ctx, solo, i);
  }

  /** Cut the player's phrase into bars on the eighth grid, an octave shift away from the soloist's range. */
  private learn(solo: Solo, bpb: number): void {
    const [lo, hi] = RANGE[solo.part] ?? [60, 84];
    const ns = solo.motif;
    const mean = ns.length ? ns.reduce((s, n) => s + n.note, 0) / ns.length : (lo + hi) / 2;
    const shift = 12 * Math.round(((lo + hi) / 2 - mean) / 12);
    this.bars = Array.from({ length: Math.max(1, Math.ceil((ns.at(-1)?.start ?? 0) / bpb) + 1) }, () => []);
    for (const n of ns) {
      const b = Math.floor(n.start / bpb);
      const t = Math.round((n.start - b * bpb) * 2) / 2;
      if (t >= bpb - EPS || !this.bars[b] || this.bars[b].some((c) => c.t === t)) continue;
      let note = n.note + shift;
      while (note < lo) note += 12;
      while (note > hi) note -= 12;
      this.bars[b].push({ t, note, vel: n.vel });
    }
    for (const b of this.bars) b.sort((x, y) => x.t - y.t);
    this.pcs = [...new Set(ns.map((n) => n.note % 12))];
  }

  /** The player's bar to answer with in bar `i`: the same bar of their turn, or their busiest one when it was nearly empty. */
  private source(i: number): Cell[] {
    const own = this.bars[i] ?? [];
    if (own.length >= 2) return own;
    return [...this.bars].sort((a, b) => b.length - a.length)[0] ?? [];
  }

  /**
   * Fit a note to the chord sounding: kept when it's a chord tone or, off
   * the beat, in the song's scale (the chord's own scale when the chart has
   * no key: a chord's textbook scale ignores the key, so D natural over Fm in
   * F minor); otherwise moved to the nearest note the player used that fits,
   * else to the nearest chord tone. No outside notes of its own.
   */
  private fit(note: number, chord: Chord, [lo, hi]: [number, number], strong: boolean): number {
    const tones = chord.intervals.map((iv) => (chord.root + iv) % 12);
    const scale = this.key ?? chordScale(chord).map((iv) => (chord.root + iv) % 12);
    const ok = (pc: number) => tones.includes(pc) || (!strong && scale.includes(pc));
    if (ok(note % 12)) return note;
    const pick = (pcs: number[]) => {
      let best: number | null = null;
      for (let n = lo; n <= hi; n++) if (pcs.includes(n % 12) && (best === null || Math.abs(n - note) < Math.abs(best - note))) best = n;
      return best;
    };
    return pick(this.pcs.filter(ok)) ?? pick(tones) ?? note;
  }

  /**
   * A melodic bar of the band's turn, from the player's own notes: the first
   * bar plays their phrase back, the next answers it (the same rhythm and
   * notes, the order turned round), the next repeats its first half, and the
   * last plays its opening and lands on a held chord tone, leaving the last
   * beat for the player. Every note fits the chord it sounds over.
   */
  private lineBar(ctx: BarContext, solo: Solo, i: number): NoteEvent[] {
    const range = RANGE[solo.part] ?? ([60, 84] as [number, number]);
    const bpb = ctx.bpb;
    const last = i === solo.bars - 1;
    const role = last ? "end" : (["state", "answer", "develop"] as const)[i % 3];
    let src = this.source(i);
    if (!src.length) src = [{ t: 0, note: Math.round((range[0] + range[1]) / 2), vel: 90 }];
    let cells: Cell[];
    if (role === "answer") {
      // Same rhythm, the notes in reverse order: an answer, not an echo.
      const notes = src.map((c) => c.note).reverse();
      cells = src.map((c, k) => ({ ...c, note: notes[k] }));
    } else if (role === "develop") {
      // The first half of the phrase, twice.
      const half = src.filter((c) => c.t < bpb / 2);
      cells = (half.length ? half : src.slice(0, 2)).flatMap((c) => [c, { ...c, t: c.t + bpb / 2 }]).filter((c) => c.t < bpb - EPS);
    } else if (role === "end") {
      cells = src.filter((c) => c.t < bpb - 2 + EPS);
      if (!cells.length) cells = [src[0]];
    } else cells = src;
    const out: NoteEvent[] = [];
    cells.forEach((c, k) => {
      const chord = chordAt(ctx, c.t);
      const strong = Math.abs(c.t - Math.round(c.t)) < EPS;
      const lastNote = role === "end" && k === cells.length - 1;
      // The turn lands on a chord tone.
      const note = this.fit(c.note, chord, range, strong || lastNote);
      const next = cells[k + 1]?.t ?? bpb;
      const dur = lastNote ? Math.max(0.5, bpb - 1 - c.t) : clamp(next - c.t, 0.25, 1) * 0.9;
      out.push({ start: c.t, dur, note, vel: vel(c.vel * 0.85 + 8 * ctx.level), part: solo.part });
    });
    return out;
  }

  /**
   * A drum solo bar, built on the player's phrase so it sounds like an
   * answer, not a random fill: the first bar states their rhythm on the
   * snare (kick under their accents), the next answers it on the toms, the
   * next fills between its notes with ghost notes, and the last plays the
   * first half of it, then a tom run into the crash on the player's
   * downbeat. The hi-hat foot keeps 2 and 4 throughout.
   */
  private drumBar(ctx: BarContext, solo: Solo, i: number, rand: () => number): NoteEvent[] {
    const bpb = ctx.bpb;
    const { onsets, accents } = this.drumMotif(solo, bpb);
    const last = i === solo.bars - 1;
    const role = last ? "end" : (["state", "answer", "develop"] as const)[i % 3];
    const build = solo.bars > 1 ? i / (solo.bars - 1) : 1;
    const base = 66 + 26 * build;
    const out: NoteEvent[] = [];
    const hit = (start: number, note: number, v: number) => out.push({ start, dur: 0.1, note, vel: vel(v + rand() * 6 - 3), part: "drums" });
    const toms = [DRUM.tomHi, DRUM.tomMid, DRUM.tomLo];
    const runFrom = Math.max(1, bpb - 2);
    onsets.forEach((t, k) => {
      const accent = accents.has(t);
      if (role === "end" && t >= runFrom - 1e-6) return;
      if (role === "answer") hit(t, toms[Math.min(toms.length - 1, Math.floor((k / onsets.length) * toms.length))], base + (accent ? 12 : 0));
      else hit(t, DRUM.snare, base + (accent ? 14 : 0));
      if (accent || (k === 0 && role !== "answer")) hit(t, DRUM.kick, base + 8);
    });
    if (role === "develop") {
      // Ghost notes on the free eighths between the player's notes.
      for (let t = 0; t < bpb - 1e-6; t += 0.5) if (!onsets.some((o) => Math.abs(o - t) < 0.26)) hit(t, DRUM.snare, 38);
    }
    if (role === "end") {
      // A sixteenth run down the kit into the next downbeat.
      const run = [DRUM.snare, DRUM.snare, DRUM.tomHi, DRUM.tomHi, DRUM.tomMid, DRUM.tomMid, DRUM.tomLo, DRUM.tomLo];
      const steps = Math.round((bpb - runFrom) * 4);
      for (let s = 0; s < steps; s++) hit(runFrom + s / 4, run[Math.floor((s / steps) * run.length)], base + (s / steps) * 20);
      hit(bpb - 0.25, DRUM.kick, base + 10);
    }
    // The hi-hat foot keeps 2 and 4 under the solo.
    for (let b = 1; b < bpb; b += 2) out.push({ start: b, dur: 0.1, note: DRUM.pedalHat, vel: 64, part: "drums" });
    return out;
  }

  /** One bar of the player's rhythm (the busiest bar of their turn, on the eighth grid), and which of its notes they leaned on. */
  private drumMotif(solo: Solo, bpb: number): { onsets: number[]; accents: Set<number> } {
    const bars = new Map<number, { t: number; vel: number }[]>();
    for (const n of solo.motif) {
      const b = Math.floor(n.start / bpb);
      const t = Math.round((n.start - b * bpb) * 2) / 2;
      if (t >= bpb) continue;
      const row = bars.get(b) ?? [];
      if (!row.some((x) => x.t === t)) row.push({ t, vel: n.vel });
      bars.set(b, row);
    }
    let best = [...bars.values()].sort((a, b) => b.length - a.length)[0] ?? [];
    // Too few notes to answer: a plain figure (one, the and of two, three, the and of four).
    if (best.length < 2) best = [0, 1.5, 2, 3.5].filter((t) => t < bpb).map((t, k) => ({ t, vel: k % 2 ? 90 : 110 }));
    // Too many to read as a rhythm: keep the downbeats and the louder half.
    if (best.length > 6) {
      const cut = [...best].sort((a, b) => b.vel - a.vel)[Math.floor(best.length / 2)].vel;
      best = best.filter((x) => Number.isInteger(x.t) || x.vel >= cut).slice(0, 6);
    }
    best.sort((a, b) => a.t - b.t);
    const loud = [...best].sort((a, b) => b.vel - a.vel)[Math.min(best.length - 1, 1)].vel;
    return { onsets: best.map((x) => x.t), accents: new Set(best.filter((x) => x.vel >= loud).map((x) => x.t)) };
  }
}
