// A simple soloist for trading fours (v0.4, ADR-0022). When the player lays
// out after their turn, a band instrument takes the next turn:
//
// - Keys, guitar or bass answer the player's last phrase: the same rhythm,
//   loosened a little (a note moved or left out), on new notes from the
//   genre's scale for each chord, chord tones on the beats, rising through
//   the first half of the turn and coming down at the end, with the last
//   note held and the last beat left free for the player to come in.
// - Drums answer the player's phrase too: their rhythm stated on the snare,
//   answered on the toms, filled in with ghost notes, then a tom run into the
//   player's downbeat, louder through the turn, the hi-hat foot on 2 and 4.
//
// Notes are on the straight grid; the engine adds swing and humanize as for
// any part. Seeded by the session seed and the turn, so replays match.

import type { BarContext } from "./engine";
import { DRUM } from "./groove";
import { rngFor } from "./rand";
import { chordClass, chordScale, type Chord } from "./theory";
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

/** Pitch classes a soloist uses over a chord: the genre's scale, or the chord's own when the genre's is too wide to sound like a scale. */
function scaleFor(chord: Chord, ctx: BarContext): number[] {
  const g = ctx.genre.listening.scales[chordClass(chord)];
  const ivs = g && g.length <= 9 ? g : chordScale(chord);
  return ivs.map((i) => (chord.root + i) % 12);
}

function chordAt(ctx: BarContext, t: number): Chord {
  for (let i = ctx.slots.length - 1; i >= 0; i--) if (t >= ctx.slots[i].start - EPS) return ctx.slots[i].chord;
  return ctx.slots[0].chord;
}

/** Notes of a pitch-class set in a range, ascending. */
function inRange(pcs: number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let n = lo; n <= hi; n++) if (pcs.includes(n % 12)) out.push(n);
  return out;
}

const nearestIndex = (notes: number[], to: number) => notes.reduce((b, n, i) => (Math.abs(n - to) < Math.abs(notes[b] - to) ? i : b), 0);

/** Plays band turns. Keeps the last note between bars of a turn; a new turn starts fresh. */
export class Soloist {
  private turn: Solo | null = null;
  private last = 0;

  constructor(private seed: number) {}

  /** One bar of the band's turn: `i` is the bar within the turn. */
  bar(ctx: BarContext, solo: Solo, i: number): NoteEvent[] {
    if (this.turn !== solo) {
      this.turn = solo;
      const range = RANGE[solo.part] ?? [60, 84];
      const mean = solo.motif.length ? solo.motif.reduce((s, n) => s + n.note, 0) / solo.motif.length : (range[0] + range[1]) / 2;
      // Start where the player was, folded into the instrument's range.
      let start = Math.round(mean);
      while (start < range[0]) start += 12;
      while (start > range[1]) start -= 12;
      this.last = start;
    }
    const rand = rngFor(this.seed, "solo", solo.part, solo.from, i);
    return solo.part === "drums" ? this.drumBar(ctx, solo, i, rand) : this.lineBar(ctx, solo, i, rand);
  }

  /** The rhythm for bar `i`: the player's onsets in that bar of their turn, loosened; or a made-up one. */
  private rhythm(ctx: BarContext, solo: Solo, i: number, rand: () => number): number[] {
    const bpb = ctx.bpb;
    const lastBar = i === solo.bars - 1;
    let on = solo.motif
      .filter((n) => n.start >= i * bpb - EPS && n.start < (i + 1) * bpb - EPS)
      .map((n) => Math.round((n.start - i * bpb) * 2) / 2)
      .filter((t, k, a) => t < bpb - EPS && a.indexOf(t) === k);
    if (on.length >= 2) {
      on = on.flatMap((t) => (rand() < 0.15 ? [] : [rand() < 0.2 && t + 0.5 < bpb - EPS ? t + 0.5 : t]));
    } else {
      // The player left this bar mostly empty: make up a line of eighths and rests.
      on = [];
      const density = 0.35 + 0.12 * ctx.level;
      for (let t = 0; t < bpb - EPS; t += 0.5) if ((t === 0 && rand() < 0.8) || rand() < density) on.push(t);
    }
    on = [...new Set(on)].sort((a, b) => a - b);
    // The last bar of the turn ends early: the last beat is the player's way back in.
    if (lastBar) on = on.filter((t) => t < bpb - 1.5 - EPS);
    if (!on.length) on = [0];
    return on;
  }

  private lineBar(ctx: BarContext, solo: Solo, i: number, rand: () => number): NoteEvent[] {
    const [lo, hi] = RANGE[solo.part] ?? [60, 84];
    const bpb = ctx.bpb;
    const onsets = this.rhythm(ctx, solo, i, rand);
    const lastBar = i === solo.bars - 1;
    // Up through the first half of the turn, down through the second.
    const rising = i < solo.bars / 2;
    const out: NoteEvent[] = [];
    onsets.forEach((t, k) => {
      const chord = chordAt(ctx, t);
      const strong = Math.abs(t - Math.round(t)) < EPS;
      const tones = chord.intervals.map((iv) => (chord.root + iv) % 12);
      const notes = inRange(strong ? tones : scaleFor(chord, ctx), lo, hi);
      if (!notes.length) return;
      let idx = nearestIndex(notes, this.last);
      const step = (rising ? 1 : -1) * (1 + (rand() < 0.3 ? 1 : 0)) * (rand() < 0.2 ? -1 : 1);
      // At the edge of the range the line turns round instead of sitting on one note.
      idx = idx + step < 0 || idx + step > notes.length - 1 ? clamp(idx - step, 0, notes.length - 1) : idx + step;
      const note = notes[idx];
      this.last = note;
      const next = onsets[k + 1] ?? (lastBar ? bpb - 1 : bpb);
      const isLast = lastBar && k === onsets.length - 1;
      const dur = isLast ? Math.max(0.5, bpb - 1 - t) : clamp(next - t, 0.25, 1) * 0.9;
      const accent = strong ? 10 : 0;
      out.push({ start: t, dur, note, vel: vel(66 + 8 * ctx.level + accent + rand() * 10 - 5), part: solo.part });
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
