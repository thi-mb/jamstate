// The groove generators (mid layer, v0.1). One generator per part role,
// each reading its vocabulary from the genre pack: drums with ghost notes,
// open-hat lifts, fills and ride/hat by section; bass lines that move
// (patterns with degrees and approaches, or walking); comping rhythms with
// voice leading. Choices are seeded by the session seed and the place in the
// song, so the same session always plays the same notes.

import type { ChordSlot } from "./chart";
import type { BarContext, PartGenerator } from "./engine";
import { drumSteps, placeSteps, type Step } from "./pattern";
import type { DrumLine, DrumLines, Fill, GenrePack, Variant } from "./genre";
import { pickWeighted, rngFor } from "./rand";
import { bassNote, bassRoot, chordScale, degreeSemis, voiceLead, voicingPcs, type Chord } from "./theory";
import { clamp, type NoteEvent, type Part } from "./types";

/** General MIDI drum map, so MIDI out lands on the right pads in a DAW. */
export const DRUM = {
  kick: 36,
  stick: 37,
  snare: 38,
  clap: 39,
  hat: 42,
  pedalHat: 44,
  openHat: 46,
  tomLo: 45,
  tomMid: 47,
  tomHi: 50,
  crash: 49,
  ride: 51,
  bell: 53,
} as const;

const vel = (v: number) => Math.round(clamp(v, 1, 127));
const EPS = 1e-6;

/** Velocity scale per intensity level, so the same pattern plays softer at level 0. */
const LEVEL_GAIN = [0.76, 0.86, 0.94, 1];

type Rand = () => number;

/** Pick a pattern variant for this bar: phrase-end variants only on a phrase's last bar. */
function choose<T>(list: Variant<T>[], ctx: BarContext, rand: Rand): T {
  const phraseEnd = ctx.barInPhrase === ctx.phraseBars - 1;
  const pool = list.filter((v) => v.phraseEnd === phraseEnd && v.weight > 0);
  const from = pool.length ? pool : list.filter((v) => !v.phraseEnd);
  return pickWeighted(from.length ? from : list, (v) => v.weight, rand()).value;
}

/** The chord slot sounding at beat `t`. */
function slotAt(slots: ChordSlot[], t: number): ChordSlot {
  for (let i = slots.length - 1; i >= 0; i--) if (t >= slots[i].start - EPS) return slots[i];
  return slots[0];
}

/** The chord after the one at beat `t` (later in this bar, or the next bar's first). */
function chordAfter(slots: ChordSlot[], t: number, next: Chord | null): Chord | null {
  const i = slots.indexOf(slotAt(slots, t));
  return i + 1 < slots.length ? slots[i + 1].chord : next;
}

// ---------- drums ----------

function cymbalNote(c: "hat" | "ride", open: boolean): number {
  if (c === "ride") return open ? DRUM.bell : DRUM.ride;
  return open ? DRUM.openHat : DRUM.hat;
}

const LINE_NOTE: Record<Exclude<DrumLine, "cymbal">, number> = {
  kick: DRUM.kick, snare: DRUM.snare, stick: DRUM.stick, pedal: DRUM.pedalHat, tom_hi: DRUM.tomHi, tom_mid: DRUM.tomMid,
  tom_lo: DRUM.tomLo, crash: DRUM.crash, clap: DRUM.clap,
};
const CHAR_VEL: Record<string, number> = { X: 112, x: 90, o: 90, h: 68, g: 30 };

function drumLinesToEvents(lines: DrumLines, grid: number, beats: number, feel: BarContext["feel"], cymbal: "hat" | "ride", level: number, offset = 0): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const [line, row] of Object.entries(lines) as [DrumLine, string][]) {
    for (const s of placeSteps(drumSteps(row), grid, beats, feel)) {
      const note = line === "cymbal" ? cymbalNote(cymbal, s.token === "o") : LINE_NOTE[line];
      const ghost = s.token === "g";
      const v = ghost ? CHAR_VEL.g : CHAR_VEL[s.token] * LEVEL_GAIN[level];
      const dur = note === DRUM.openHat ? Math.max(0.25, s.dur) : note === DRUM.crash ? 2 : 0.1;
      out.push({ start: offset + s.start, dur, note, vel: vel(v), part: "drums" });
    }
  }
  return out;
}

const CYMBALS: Set<number> = new Set([DRUM.hat, DRUM.openHat, DRUM.ride, DRUM.bell]);
const FILL_CLEARS: Set<number> = new Set([DRUM.snare, DRUM.stick, DRUM.clap, DRUM.hat, DRUM.openHat, DRUM.ride, DRUM.bell, DRUM.tomHi, DRUM.tomMid, DRUM.tomLo]);

function pickFill(g: GenrePack["drums"], level: number, bpb: number, maxBeats: number, rand: Rand): Fill | null {
  const ok = g.fills.filter((f) => level >= f.minLevel && level <= f.maxLevel && f.beats <= Math.min(bpb, maxBeats));
  if (!ok.length) return null;
  // Longer fills are likelier at higher levels.
  return pickWeighted(ok, (f) => 1 + (f.beats - 1) * (level / 3), rand());
}

/** Replace the end of a bar with a fill. Kicks stay unless the fill has its own. */
export function withFill(events: NoteEvent[], fill: Fill, grid: number, bpb: number, level: number): NoteEvent[] {
  const from = bpb - fill.beats;
  const ownKick = !!fill.lines.kick;
  const kept = events.filter((e) => e.start < from - EPS || !(FILL_CLEARS.has(e.note) || (ownKick && e.note === DRUM.kick)));
  return [...kept, ...drumLinesToEvents(fill.lines, grid, fill.beats, "normal", "hat", Math.max(level, 1), from)];
}

export function crashHit(events: NoteEvent[], level: number): NoteEvent[] {
  const kept = events.filter((e) => !(e.start < EPS && (CYMBALS.has(e.note) || e.note === DRUM.kick)));
  return [...kept, { start: 0, dur: 2, note: DRUM.crash, vel: vel(84 + 10 * level), part: "drums" }, { start: 0, dur: 0.1, note: DRUM.kick, vel: vel(96 + 8 * level), part: "drums" }];
}

/** A snare roll over the bar that builds into the next downbeat. */
export function riser(bpb: number): NoteEvent[] {
  const ev: NoteEvent[] = [];
  for (let t = 0; t < bpb - EPS; t += t < bpb / 2 ? 0.5 : 0.25) ev.push({ start: t, dur: 0.1, note: DRUM.snare, vel: vel(35 + (85 * t) / bpb), part: "drums" });
  return ev;
}

function drumsBar(ctx: BarContext, rand: Rand): NoteEvent[] {
  const g = ctx.genre.drums;
  const { bpb, level } = ctx;
  if (ctx.kind === "count_in") {
    const clicks: NoteEvent[] = [];
    const pickup = g.pickup && bpb >= 2 ? g.pickup : null;
    for (let b = 0; b < (pickup ? bpb - 1 : bpb); b++) clicks.push({ start: b, dur: 0.1, note: DRUM.stick, vel: b === 0 ? 100 : 80, part: "drums" });
    if (pickup) clicks.push(...drumLinesToEvents(pickup, g.grid, 1, "normal", "hat", 2, bpb - 1));
    return clicks;
  }
  const lines = choose(g.levels[level], ctx, rand);
  const only = !!ctx.stingersOnly;
  let ev = only ? [] : drumLinesToEvents(lines, g.grid, bpb, ctx.feel, ctx.cymbal, level);

  // Ghost notes on empty sixteenths, away from other snare hits and off the beat.
  const chance = g.ghosts[level];
  if (!only && chance > 0 && ctx.feel !== "double_time") {
    const snares = ev.filter((e) => e.note === DRUM.snare || e.note === DRUM.stick).map((e) => e.start);
    for (let t = 0.25; t < bpb - EPS; t += 0.25) {
      if (Math.abs(t - Math.round(t)) < EPS) continue;
      if (snares.some((s) => Math.abs(s - t) < 0.3)) continue;
      if (rand() < chance) ev.push({ start: t, dur: 0.1, note: DRUM.snare, vel: vel(22 + rand() * 14), part: "drums" });
    }
  }

  // Open-hat lift into the next phrase.
  const phraseEnd = ctx.barInPhrase === ctx.phraseBars - 1;
  if (ctx.cymbal === "hat" && level >= 2 && phraseEnd && !ev.some((e) => e.note === DRUM.openHat)) {
    const last = ev.filter((e) => e.note === DRUM.hat && Math.abs(e.start - Math.round(e.start)) > EPS && e.start >= bpb - 1).pop();
    if (last) {
      last.note = DRUM.openHat;
      last.dur = 0.45;
      last.vel = vel(last.vel + 8);
    }
  }

  let stingers = ctx.stingers;
  // A short fill at the end of some phrases, more often at higher intensity.
  if (!only && !stingers.includes("fill") && phraseEnd && !ctx.lastBarOfSection && rand() < g.phraseFills[level]) stingers = [...stingers, "fill"];
  for (const s of stingers) {
    if (s === "fill") {
      const maxBeats = ctx.lastBarOfSection || ctx.kind === "ending" ? 4 : 1;
      const fill = pickFill(g, level, bpb, maxBeats, rand);
      if (fill) ev = withFill(ev, fill, g.grid, bpb, level);
    } else if (s === "crash") ev = crashHit(ev, level);
    else ev = [...ev.filter((e) => e.note !== DRUM.snare), ...riser(bpb)];
  }

  if (ctx.ending) {
    const { ringBeats } = ctx.ending;
    const e = ctx.genre.ending;
    ev.push({ start: bpb, dur: ringBeats, note: DRUM.crash, vel: 118, part: "drums" }, { start: bpb, dur: 0.2, note: DRUM.kick, vel: 118, part: "drums" });
    if (e.drums === "roll") {
      for (let t = 0.25; t < ringBeats - 0.25 - EPS; t += 0.25) {
        const toms = [DRUM.snare, DRUM.tomHi, DRUM.tomMid, DRUM.tomLo];
        ev.push({ start: bpb + t, dur: 0.1, note: toms[Math.floor((t / ringBeats) * toms.length)], vel: vel(60 + (50 * t) / ringBeats), part: "drums" });
      }
      ev.push({ start: bpb + ringBeats, dur: 2, note: DRUM.crash, vel: 124, part: "drums" }, { start: bpb + ringBeats, dur: 0.2, note: DRUM.kick, vel: 124, part: "drums" });
    }
  }
  return ev;
}

// ---------- bass ----------

const BASS_LO = 28;
const BASS_HI = 55;

function fold(n: number, lo = BASS_LO, hi = BASS_HI): number {
  while (n > hi) n -= 12;
  while (n < lo) n += 12;
  return n;
}

/** The octave of pitch class `pc` closest to `near`, inside the bass range. */
function nearest(pc: number, near: number, lo = BASS_LO, hi = BASS_HI): number {
  let best = fold(pc + 36, lo, hi);
  for (let n = lo; n <= hi; n++) if (n % 12 === ((pc % 12) + 12) % 12 && Math.abs(n - near) < Math.abs(best - near)) best = n;
  return best;
}

export function approachNote(target: number, from: number, mode: GenrePack["bass"]["approach"], rand: Rand, targetChord: Chord | null): number {
  const m = mode === "mixed" ? pickWeighted(["chromatic", "scale", "fifth"] as const, (x) => (x === "chromatic" ? 2 : 1), rand()) : mode;
  if (m === "fifth") return fold(from <= target ? target - 5 : target + 7);
  if (m === "scale" && targetChord) {
    const scale = chordScale(targetChord).map((s) => (targetChord.root + s) % 12);
    const below = [1, 2].map((d) => target - d).find((n) => scale.includes(((n % 12) + 12) % 12));
    if (below !== undefined) return fold(below);
  }
  // Chromatic: from below when coming up to the target, from above when coming down.
  return fold(from < target || (from === target && rand() < 0.5) ? target - 1 : target + 1);
}

interface BassState {
  last: number;
}

function parseBassToken(t: string): { deg: string; octave: number; accent: boolean } {
  let s = t;
  const accent = s.endsWith("!");
  if (accent) s = s.slice(0, -1);
  let octave = 0;
  if (s.endsWith("'")) (octave = 12), (s = s.slice(0, -1));
  else if (s.endsWith(",")) (octave = -12), (s = s.slice(0, -1));
  return { deg: s, octave, accent };
}

function walkBar(ctx: BarContext, st: BassState, rand: Rand): NoteEvent[] {
  const { slots, bpb, genre } = ctx;
  const out: NoteEvent[] = [];
  const twoFeel = ctx.feel === "half_time";
  const beats = twoFeel ? Array.from({ length: Math.ceil(bpb / 2) }, (_, i) => i * 2) : Array.from({ length: bpb }, (_, i) => i);
  for (const b of beats) {
    const slot = slotAt(slots, b);
    const chord = slot.chord;
    const slotEnd = slot.start + slot.dur;
    const target = chordAfter(slots, b, ctx.next) ?? chord;
    const stepLen = twoFeel ? 2 : 1;
    const lastBeforeChange = b + stepLen >= slotEnd - EPS;
    let note: number;
    if (Math.abs(b - slot.start) < EPS) note = nearest(chord.bass, st.last, BASS_LO, 50);
    else if (lastBeforeChange) {
      const tNote = nearest(target.bass, st.last, BASS_LO, 50);
      note = approachNote(tNote, st.last, genre.bass.approach === "chromatic" ? "mixed" : genre.bass.approach, rand, target);
    } else {
      // Step through the chord scale toward the next target, preferring chord tones.
      const tNote = nearest(target.bass, st.last, BASS_LO, 50);
      const dir = Math.sign(tNote - st.last) || (rand() < 0.5 ? 1 : -1);
      const scale = chordScale(chord).map((s) => (chord.root + s) % 12);
      const tones = [0, degreeSemis(chord, "3"), degreeSemis(chord, "5"), degreeSemis(chord, "7")].map((s) => (chord.root + s) % 12);
      const cands: number[] = [];
      for (let n = st.last - 5; n <= st.last + 5; n++) {
        if (n === st.last || n < BASS_LO || n > 50) continue;
        if (!scale.includes(n % 12)) continue;
        if (Math.sign(n - st.last) !== dir && rand() < 0.8) continue;
        cands.push(n);
      }
      note = cands.length ? pickWeighted(cands, (n) => (tones.includes(n % 12) ? 3 : 1) / (1 + Math.abs(n - st.last) / 3), rand()) : fold(st.last + dir * 2);
    }
    const v = vel((b === 0 ? 96 : 86) * LEVEL_GAIN[ctx.level] + (rand() - 0.5) * 6);
    // Skip note: a ghosted pickup on the "and" into the next beat.
    if (!twoFeel && b < bpb - 1 && rand() < genre.bass.skipChance) {
      out.push({ start: b, dur: 0.45, note, vel: v, part: "bass" }, { start: b + 0.5, dur: 0.4, note, vel: vel(v * 0.55), part: "bass" });
    } else out.push({ start: b, dur: stepLen * 0.92, note, vel: v, part: "bass" });
    st.last = note;
  }
  return out;
}

function bassBar(ctx: BarContext, st: BassState, rand: Rand): NoteEvent[] {
  const { slots, bpb, genre, level } = ctx;
  const g = genre.bass;
  if (ctx.kind === "count_in") {
    if (!ctx.firstChord || !genre.drums.pickup) return [];
    const tNote = bassNote(ctx.firstChord);
    st.last = tNote;
    return [{ start: bpb - 0.5, dur: 0.45, note: approachNote(tNote, tNote - 2, "chromatic", rand, ctx.firstChord), vel: 84, part: "bass" }];
  }
  let out: NoteEvent[];
  if (g.walkLevels.includes(level)) out = walkBar(ctx, st, rand);
  else {
    const steps = placeSteps(choose(g.levels[level], ctx, rand), g.grid, bpb, ctx.feel);
    out = [];
    for (const s of steps) {
      const slot = slotAt(slots, s.start);
      const chord = slot.chord;
      const { deg, octave, accent } = parseBassToken(s.token);
      const onBeat = Math.abs(s.start - Math.round(s.start)) < EPS;
      let note: number;
      let v = (accent ? 112 : onBeat ? 94 : 80) * LEVEL_GAIN[level];
      let dur = Math.max(0.1, s.dur * 0.92);
      if (deg === "x") (note = bassNote(chord)), (v = 26), (dur = 0.06);
      else if (deg === "g") (note = bassNote(chord)), (v = 46), (dur = Math.min(dur, 0.15));
      else if (deg === "N") note = bassNote(chordAfter(slots, s.start, ctx.next) ?? chord);
      else if (deg === "A") {
        const target = chordAfter(slots, s.start, ctx.next) ?? chord;
        note = approachNote(nearest(target.bass, st.last), st.last, g.approach, rand, target);
      } else if (deg === "R" || deg === "1") note = fold(bassNote(chord) + octave);
      else note = fold(bassRoot(chord) + degreeSemis(chord, deg) + octave);
      out.push({ start: s.start, dur, note, vel: vel(v), part: "bass" });
      if (deg !== "x" && deg !== "g") st.last = note;
    }
    // Lead into a chord change: turn the bar's last note into an approach.
    const next = ctx.next;
    if (next && rand() < g.approachChance[level] && !steps.some((s) => s.token.startsWith("A") && s.start >= bpb - 1)) {
      const lastSlot = slots[slots.length - 1];
      const target = nearest(next.bass, st.last);
      const lastNote = [...out].reverse().find((e) => e.start >= Math.max(bpb - 1, lastSlot.start + 0.5) - EPS && e.vel > 50);
      if (lastNote && lastNote.note % 12 !== target % 12) lastNote.note = approachNote(target, st.last, g.approach, rand, next);
      else if (!lastNote && level >= 1 && !out.some((e) => e.start >= bpb - 0.5 - EPS))
        out.push({ start: bpb - 0.5, dur: 0.45, note: approachNote(target, st.last, g.approach, rand, next), vel: vel(80 * LEVEL_GAIN[level]), part: "bass" });
    }
  }
  if (ctx.ending) {
    const root = nearest(ctx.ending.tonic.bass, st.last, BASS_LO, 45);
    out.push({ start: bpb, dur: ctx.ending.ringBeats, note: root, vel: 108, part: "bass" });
    if (genre.ending.drums === "roll") out.push({ start: bpb + ctx.ending.ringBeats, dur: 1.5, note: root, vel: 116, part: "bass" });
  }
  return out;
}

// ---------- comping ----------

interface ChordState {
  voicing: number[] | null;
}

function voice(chord: Chord, ctx: BarContext, st: ChordState): number[] {
  const { voicing, range } = ctx.genre.chords;
  const v = voiceLead(voicingPcs(chord, voicing), st.voicing, range[0], range[1], (range[0] + range[1]) / 2);
  st.voicing = v;
  return v;
}

const COMP_VEL: Record<string, number> = { X: 100, x: 82, p: 92, g: 34 };

function chordsBar(ctx: BarContext, st: ChordState, rand: Rand): NoteEvent[] {
  const { slots, bpb, genre, level } = ctx;
  if (ctx.kind === "count_in") return [];
  const g = genre.chords;
  const steps: Step[] = placeSteps(choose(g.levels[level], ctx, rand), g.grid, bpb, ctx.feel);
  const out: NoteEvent[] = [];
  const voiced = new Map<string, number[]>();
  const voicingFor = (c: Chord) => {
    let v = voiced.get(c.symbol);
    if (!v) voiced.set(c.symbol, (v = voice(c, ctx, st)));
    return v;
  };
  const hit = (start: number, dur: number, chord: Chord, v: number) => {
    for (const note of voicingFor(chord)) out.push({ start, dur, note, vel: vel(v), part: "chords" });
  };
  const covered = new Set<ChordSlot>();
  for (const s of steps) {
    const slot = slotAt(slots, s.start);
    const push = s.token === "p" && s.start + s.dur >= slot.start + slot.dur - EPS;
    const chord = push ? (chordAfter(slots, s.start, ctx.next) ?? slot.chord) : slot.chord;
    if (!push) covered.add(slot);
    const ghost = s.token === "g";
    const v = ghost ? COMP_VEL.g : COMP_VEL[s.token] * LEVEL_GAIN[level] + (rand() - 0.5) * 6;
    hit(s.start, ghost ? 0.06 : Math.max(0.1, s.dur * 0.9), chord, v);
  }
  // A chord that changes mid-bar with no hit gets one, so the harmony is always heard.
  for (const slot of slots) if (!covered.has(slot) && slot.dur >= 1 && !(ctx.feel === "half_time" && slot.start > 0)) hit(slot.start, Math.min(slot.dur, 1) * 0.9, slot.chord, 70 * LEVEL_GAIN[level]);
  if (ctx.ending) hit(bpb, ctx.ending.ringBeats, ctx.ending.tonic, 96);
  return out;
}

// ---------- the generator ----------

/** Role → bar generator. A new role in v0.2 registers here; the engine walks the genre's lineup. */
type RoleGen = (ctx: BarContext, rand: Rand) => NoteEvent[];

export class GrooveGenerator implements PartGenerator {
  private bass: BassState = { last: 38 };
  private chords: ChordState = { voicing: null };
  private roles: Record<Part, RoleGen> = {
    drums: (ctx, r) => drumsBar(ctx, r),
    bass: (ctx, r) => bassBar(ctx, this.bass, r),
    chords: (ctx, r) => chordsBar(ctx, this.chords, r),
  };

  generate(ctx: BarContext): Partial<Record<Part, NoteEvent[]>> {
    const out: Partial<Record<Part, NoteEvent[]>> = {};
    for (const p of ctx.parts) {
      // Pattern choice is keyed by where we are in the section, so a section keeps its character;
      // everything else (ghosts, approaches) by the absolute bar.
      const pick = rngFor(ctx.seed, "pattern", p, ctx.genre.id, ctx.section, ctx.barInSection, ctx.level, ctx.feel);
      const vary = rngFor(ctx.seed, "vary", p, ctx.bar);
      let first = true;
      const rand = () => (first ? ((first = false), pick()) : vary());
      out[p] = this.roles[p](ctx, rand);
    }
    return out;
  }
}

