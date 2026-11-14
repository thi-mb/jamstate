// A simple soloist for trading fours (v0.4, ADR-0022). When the player lays
// out after their turn, a band instrument takes the next turn:
//
// - Keys, guitar or bass answer the player's last phrase: the same rhythm,
//   loosened a little (a note moved or left out), on new notes from the
//   genre's scale for each chord, chord tones on the beats, rising through
//   the first half of the turn and coming down at the end, with the last
//   note held and the last beat left free for the player to come in.
// - Drums play a short solo: cells of snare, kick and toms, building through
//   the turn, the hi-hat pedal keeping 2 and 4.
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

  /** A drum solo bar: one cell per beat, louder and busier through the turn. */
  private drumBar(ctx: BarContext, solo: Solo, i: number, rand: () => number): NoteEvent[] {
    const bpb = ctx.bpb;
    const build = (i + 1) / solo.bars;
    const S = DRUM.snare, K = DRUM.kick, H = DRUM.tomHi, M = DRUM.tomMid, L = DRUM.tomLo;
    // Sixteenth cells; null is a rest.
    const cells: (number | null)[][] = [
      [S, null, S, null],
      [K, null, S, null],
      [S, null, null, S],
      [null, null, S, null],
      [K, S, null, S],
      [S, S, S, null],
      [H, M, L, L],
      [S, H, M, L],
    ];
    const out: NoteEvent[] = [];
    for (let b = 0; b < bpb; b++) {
      const lastBeat = i === solo.bars - 1 && b === bpb - 1;
      // Busier cells (the toms) are likelier later in the turn; the turn ends on a tom run.
      const pool = lastBeat ? [cells[6], cells[7]] : cells.slice(0, Math.max(4, Math.round(4 + build * 4)));
      const cell = pool[Math.floor(rand() * pool.length)];
      cell.forEach((n, s) => {
        if (n === null) return;
        const v = 62 + 40 * build + (s === 0 ? 10 : 0) + rand() * 8;
        out.push({ start: b + s / 4, dur: 0.1, note: n, vel: vel(v), part: "drums" });
      });
      // The hi-hat pedal keeps 2 and 4 under the solo.
      if (b % 2 === 1) out.push({ start: b, dur: 0.1, note: DRUM.pedalHat, vel: 64, part: "drums" });
    }
    return out;
  }
}
