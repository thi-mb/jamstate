// The audio listener (v0.5, ADR-0023): 16 kHz input in, the same note
// on/off events MIDI gives out, so features, listening, trading, the
// fretboard and sessions work on guitar unchanged.
//
// Every 8 ms (a hop of 128 samples) it measures the level and a log
// spectral flux, and picks onsets above an adaptive threshold and the
// calibrated noise gate. A short while after an onset it decides what was
// played: a pitched note, a chord, or an unpitched hit (pitch -1: a muted
// strum or a slap, which counts for energy and rhythm but not harmony).
// Events carry the audio-clock time of the onset, not of the decision.
//
// A pitched note is followed between onsets: a new steady pitch without a
// new attack (a hammer-on, a pull-off, a slide) ends it and starts the next.

import { UNPITCHED } from "../features";
import { db, hzOf, magnitudes, midiOf, rms, SR } from "./dsp";
import { cents, Yin } from "./pitch";

export type ListenerEvent =
  | { kind: "on"; time: number; note: number; vel: number }
  | { kind: "off"; time: number; note: number };

/** Levels from the calibration screen (dBFS of the 16 ms RMS). */
export interface Calibration {
  /** Below this the input counts as silent. */
  gateDb: number;
  /** A soft hit's peak (velocity 40) and a hard one's (velocity 115). */
  softDb: number;
  hardDb: number;
  /** Seconds the input runs behind the audio clock (subtracted from onset times). */
  latency: number;
}

/** Suits a guitar into a Scarlett at about 12 o'clock gain. */
export const DEFAULT_CALIBRATION: Calibration = { gateDb: -52, softDb: -34, hardDb: -12, latency: 0 };

export const HOP = 128;
const FRAME = 512;
const BINS = FRAME / 2 + 1;
/** Flux over 60 Hz–5 kHz. */
const LO_BIN = Math.ceil((60 * FRAME) / SR);
const HI_BIN = Math.floor((5000 * FRAME) / SR);
const MIN_IOI = 0.07;
/**
 * How long after an onset the listener decides what it was (and its
 * velocity): the pitch window then starts just after the attack.
 */
export const DECIDE = 0.07;
/** The flux peak sits this far after the attack, on average (from the synthesised set). */
const ONSET_LAG = 0.006;

/**
 * What the listener listens for: "single" hears single notes (and unpitched
 * hits), "chords" hears chords, "auto" both.
 */
export type DetectionMode = "auto" | "single" | "chords";

export interface ListenerOptions {
  calibration?: Calibration;
  /** Flux threshold over the running median; lower hears softer attacks and more false ones. */
  sensitivity?: number;
  mode?: DetectionMode;
  /** The lowest and highest notes the instrument plays (pitches outside are unpitched). */
  lowest?: number;
  highest?: number;
  /** For the eval: the pitch window (samples), when to decide (seconds after an onset), YIN's aperiodicity limit. */
  pitch?: Partial<PitchSettings>;
}

export interface PitchSettings {
  window: number;
  decide: number;
  periodic: number;
  /** Frames that vote on a new note's pitch (a hop apart). */
  votes: number;
  /** YIN's absolute threshold. */
  threshold: number;
  /** Following a held note for slurs: its window, how long after the attack it starts, every how many hops, frames in a row, aperiodicity limit. */
  followWindow: number;
  settle: number;
  every: number;
  frames: number;
  followPeriodic: number;
  /** Seconds to wait on past `decide` for a pitch before an onset counts as unpitched. */
  patience: number;
}

export const PITCH_SETTINGS: PitchSettings = { window: 1024, decide: DECIDE, periodic: 0.25, votes: 2, threshold: 0.15, followWindow: 1024, settle: 0.06, every: 2, frames: 3, followPeriodic: 0.12, patience: 0.08 };

/** A pitch counts when YIN's aperiodicity is under this; a legato change needs a cleaner one. */
/** A hit that fell this many dB under its peak by the time it's decided was a scratch, not a note. */
const DIED = 25;
/** Two frames agree within this many cents. */
const AGREE = 60;
/** Frames between onsets that follow a held note (every other hop, 16 ms). */
/** A legato change needs this many steady frames in a row. */
/** Seconds after an attack before legato changes count. */

interface Pending {
  time: number;
  peakDb: number;
  /** Samples index of the onset. */
  at: number;
  /** The note sounding when it came. */
  before: Sounding | null;
}

interface Sounding {
  note: number;
  peakDb: number;
  time: number;
  vel: number;
  /** The pitch it was heard at, for pitched notes. */
  hz?: number;
  /** A note picked before it, likely still ringing on another string (legato never goes back to it). */
  ringing?: number;
}

export class AudioListener {
  cal: Calibration;
  private sensitivity: number;
  /** Samples heard so far, with room to look back (pitch and chords need up to 4096). */
  private buf = new Float32Array(1 << 16);
  private len = 0;
  /** Absolute index of buf[0]. */
  private base = 0;
  private nextHop = FRAME;
  private timeAt0 = 0;
  private started = false;
  private re = new Float64Array(FRAME);
  private im = new Float64Array(FRAME);
  private mag = new Float32Array(BINS);
  private prevLog = new Float32Array(BINS);
  private flux: number[] = [];
  /** Levels of the same hops. */
  private levels: number[] = [];
  private lastOnset = -Infinity;
  private pending: Pending | null = null;
  /** The note sounding (one at a time from the onset layer). */
  private sounding: Sounding | null = null;
  private combed: Float32Array;
  private followYin: Yin;
  private ps: PitchSettings;
  /** A new pitch heard while a note is held, before it counts as a legato change. */
  private legato: { note: number; frames: number; time: number } | null = null;
  private hopCount = 0;
  private yin: Yin;
  mode: DetectionMode;
  private lowest: number;
  private highest: number;
  private out: ListenerEvent[] = [];
  /** Current level (dBFS, 16 ms RMS) and its recent peak, for the meter. */
  levelDb = -120;
  peakDb = -120;
  /** Onsets heard (for the calibration screen). */
  onsets: { time: number; peakDb: number }[] = [];

  constructor(opts: ListenerOptions = {}) {
    this.cal = { ...DEFAULT_CALIBRATION, ...opts.calibration };
    this.sensitivity = opts.sensitivity ?? 0.06;
    this.mode = opts.mode ?? "auto";
    this.lowest = opts.lowest ?? 40;
    this.highest = opts.highest ?? 88;
    this.ps = { ...PITCH_SETTINGS, ...opts.pitch };
    this.yin = new Yin(hzOf(this.lowest - 2), hzOf(this.highest + 2), this.ps.threshold, this.ps.window);
    this.combed = new Float32Array(this.ps.window);
    // A bass's lowest period doesn't fit half of a short window.
    const fw = SR / hzOf(this.lowest - 2) < this.ps.followWindow / 2 ? this.ps.followWindow : this.ps.window;
    this.ps.followWindow = fw;
    this.followYin = fw === this.ps.window ? this.yin : new Yin(hzOf(this.lowest - 2), hzOf(this.highest + 2), this.ps.threshold, fw);
  }

  /** The pitch of the window ending at buffer index `end`: a MIDI note (fractional), or null. */
  private pitchAt(end: number, periodic = this.ps.periodic): number | null {
    if (end < this.ps.window) return null;
    const f = this.yin.frame(this.buf, end);
    if (!f.hz || f.aperiodicity > periodic) return null;
    const m = midiOf(f.hz);
    return m < this.lowest - 0.5 || m > this.highest + 0.5 ? null : m;
  }

  /** A pitch most of the last few frames (a hop apart, ending at `end`) agree on, or null. */
  private steadyPitch(end: number, periodic = this.ps.periodic): number | null {
    const n = this.ps.votes;
    const frames: number[] = [];
    for (let k = 0; k < n; k++) {
      const m = this.pitchAt(end - k * HOP, periodic);
      if (m !== null) frames.push(m);
    }
    let best: number[] = [];
    for (const a of frames) {
      const near = frames.filter((b) => Math.abs(cents(hzOf(a), hzOf(b))) <= AGREE);
      if (near.length > best.length) best = near;
    }
    return best.length >= Math.floor(n / 2) + 1 ? best.reduce((s, m) => s + m, 0) / best.length : null;
  }

  /**
   * The pitch of a new note while an old one (at `oldHz`) still rings on
   * another string: a comb at the old period takes it out first. Null when
   * nothing new is left (the same note again, or an octave of it).
   */
  private newPitch(end: number, oldHz: number): number | null {
    const P = SR / oldHz;
    const pi = Math.floor(P);
    const fr = P - pi;
    const W = this.ps.window;
    const start = end - W;
    if (start - pi - 1 < 0) return null;
    const x = this.buf;
    for (let i = 0; i < W; i++) {
      const j = start + i;
      this.combed[i] = x[j] - ((1 - fr) * x[j - pi] + fr * x[j - pi - 1]);
    }
    const f = this.yin.frame(this.combed, W);
    if (!f.hz || f.aperiodicity > this.ps.periodic) return null;
    const m = midiOf(f.hz);
    return m < this.lowest - 0.5 || m > this.highest + 0.5 ? null : m;
  }

  /** Time (audio clock) of an absolute sample index. */
  private timeOf(i: number): number {
    return this.timeAt0 + i / SR;
  }

  /**
   * Feed 16 kHz samples; `time` is the audio-clock time of the first. Returns
   * the events decided so far (also kept for `drain`).
   */
  push(samples: Float32Array, time: number): ListenerEvent[] {
    const abs = this.base + this.len;
    if (!this.started) {
      this.timeAt0 = time;
      this.started = true;
    } else if (Math.abs(this.timeOf(abs) - time) > 0.05) {
      // A gap in the stream (a tab in the background, a device change): carry on from the new time.
      this.timeAt0 = time - abs / SR;
    }
    if (this.len + samples.length > this.buf.length) {
      const keep = 8192;
      const drop = this.len - keep;
      this.buf.copyWithin(0, drop, this.len);
      this.base += drop;
      this.len = keep;
    }
    this.buf.set(samples, this.len);
    this.len += samples.length;
    const events: ListenerEvent[] = [];
    while (this.nextHop <= this.base + this.len) {
      this.hop(this.nextHop - this.base, events);
      this.nextHop += HOP;
    }
    this.out.push(...events);
    return events;
  }

  /** Events since the last drain. */
  drain(): ListenerEvent[] {
    const e = this.out;
    this.out = [];
    return e;
  }

  /** Let go of a sounding note (the input stopped). */
  flush(time: number): ListenerEvent[] {
    const events: ListenerEvent[] = [];
    if (this.sounding) events.push({ kind: "off", time, note: this.sounding.note });
    this.sounding = null;
    this.pending = null;
    this.out.push(...events);
    return events;
  }

  velocityOf(peakDb: number): number {
    const { softDb, hardDb } = this.cal;
    const v = 40 + ((peakDb - softDb) / Math.max(1, hardDb - softDb)) * 75;
    return Math.max(1, Math.min(127, Math.round(v)));
  }

  /** One hop ending at buffer index `end`. */
  private hop(end: number, events: ListenerEvent[]): void {
    const abs = this.base + end;
    const now = this.timeOf(abs);
    const level = db(rms(this.buf, end - 256, end));
    this.levelDb = level;
    this.peakDb = Math.max(level, this.peakDb - 0.15);

    // Log spectral flux, each bin against the max of its neighbours a hop ago (steadier on vibrato).
    const m = magnitudes(this.buf, end, FRAME, this.re, this.im, this.mag);
    let f = 0;
    for (let k = LO_BIN; k <= HI_BIN; k++) {
      const v = Math.log1p(1000 * m[k]);
      const p = Math.max(this.prevLog[k - 1], this.prevLog[k], this.prevLog[k + 1]);
      if (v > p) f += v - p;
    }
    for (let k = 0; k < BINS; k++) this.prevLog[k] = Math.log1p(1000 * m[k]);
    f /= HI_BIN - LO_BIN + 1;
    this.flux.push(f);
    this.levels.push(level);
    if (this.flux.length > 40) {
      this.flux.shift();
      this.levels.shift();
    }

    // Decide a pending onset once enough of it has been heard.
    const p = this.pending;
    if (p) {
      p.peakDb = Math.max(p.peakDb, level);
      const waited = (abs - p.at) / SR;
      // No clear pitch yet: listen a little longer before calling it unpitched.
      // (A muted scratch dies away: what rings after it isn't its pitch.)
      const unsure = () => this.mode !== "chords" && waited < this.ps.decide + this.ps.patience && level > p.peakDb - DIED && this.steadyPitch(end) === null;
      if (waited >= this.ps.decide && !unsure()) {
        this.pending = null;
        this.decide(p, events, end);
      }
    }

    // Peak-pick the previous hop (one hop of look-ahead).
    const fl = this.flux;
    const n = fl.length;
    if (n >= 4) {
      const c = fl[n - 2];
      const sorted = fl.slice(0, n - 2).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const isPeak = c >= fl[n - 1] && c > fl[n - 3] && c >= fl[n - 4];
      // An attack doesn't come with a falling level (a string damped clicks too).
      const lv = this.levels;
      const falling = n >= 6 && Math.max(lv[n - 1], lv[n - 2]) < Math.max(lv[n - 4], lv[n - 5], lv[n - 6]) - 1.5;
      const t = now - HOP / SR - ONSET_LAG;
      if (isPeak && !falling && c > median * 1.5 + this.sensitivity && level > this.cal.gateDb && t - this.lastOnset >= MIN_IOI) {
        this.lastOnset = t;
        if (this.pending) this.decide(this.pending, events, end);
        this.pending = { time: t, peakDb: level, at: abs, before: this.sounding };
      }
    }

    // A sounding note ends when it fades under the gate or well under its peak.
    const s = this.sounding;
    if (s && !this.pending && (level < this.cal.gateDb || level < s.peakDb - 30)) {
      events.push({ kind: "off", time: now - this.cal.latency, note: s.note });
      this.sounding = null;
      this.legato = null;
    }

    // Follow a held pitched note for legato changes.
    this.hopCount++;
    if (this.sounding && this.sounding.note >= 0 && !this.pending && this.hopCount % this.ps.every === 0) this.follow(end, now, level, events);
  }

  private follow(end: number, now: number, level: number, events: ListenerEvent[]): void {
    const s = this.sounding!;
    // The window must lie after the note's attack, and other strings ring
    // on for a while after it: changes come once the note has settled.
    const W = this.ps.followWindow;
    if (now - W / SR < s.time + this.cal.latency + this.ps.settle) return;
    // A slur keeps the level up; a note damped over another still ringing doesn't.
    const lv = this.levels;
    if (level < Math.max(...lv.slice(-8)) - 6) {
      this.legato = null;
      return;
    }
    const f = this.followYin.frame(this.buf, end);
    const m = f.hz && f.aperiodicity <= this.ps.followPeriodic ? midiOf(f.hz) : null;
    const note = m === null || m < this.lowest - 0.5 || m > this.highest + 0.5 ? null : Math.round(m);
    if (note === null || note === s.note || note === s.ringing || Math.abs(m! - note) > 0.35) {
      this.legato = null;
      return;
    }
    const l = this.legato;
    if (l && l.note === note) l.frames++;
    // The change happened about half a window before the first frame that heard it.
    else this.legato = { note, frames: 1, time: now - W / SR / 2 - this.cal.latency };
    if (this.legato!.frames >= this.ps.frames) {
      const time = Math.max(this.legato!.time, s.time + 0.01);
      const vel = Math.max(1, s.vel - 8);
      events.push({ kind: "off", time, note: s.note });
      events.push({ kind: "on", time, note, vel });
      this.sounding = { note, peakDb: s.peakDb, time, vel, hz: hzOf(m!) };
      this.legato = null;
    }
  }

  /** What an onset was: a pitched note when two frames agree on one, else an unpitched hit. */
  private decide(p: Pending, events: ListenerEvent[], end: number): void {
    const time = p.time - this.cal.latency;
    if (this.sounding) events.push({ kind: "off", time, note: this.sounding.note });
    this.legato = null;
    const vel = this.velocityOf(p.peakDb);
    this.onsets.push({ time: p.time, peakDb: p.peakDb });
    if (this.onsets.length > 200) this.onsets.shift();
    let m = this.mode === "chords" || this.levelDb < p.peakDb - DIED ? null : this.steadyPitch(end);
    // Heard the old note again (or an octave of it)? Look past it for a new one.
    // (What the comb leaves can't be the old note's pitch class: only an attack's leftovers sound like that.)
    const old = p.before;
    const sameClass = (a: number, b: number) => Math.abs(((((a - b) % 12) + 18) % 12) - 6) < 1.2;
    if (m !== null && old?.hz && sameClass(m, midiOf(old.hz))) {
      const n = this.newPitch(end, old.hz);
      if (n !== null && !sameClass(n, midiOf(old.hz))) m = n;
    }
    const note = m === null ? UNPITCHED : Math.round(m);
    events.push({ kind: "on", time, note, vel });
    this.sounding = { note, peakDb: p.peakDb, time, vel, hz: m === null ? undefined : hzOf(m), ringing: old && old.note >= 0 && old.note !== note ? old.note : undefined };
  }
}
