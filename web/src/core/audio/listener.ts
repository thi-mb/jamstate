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

import { UNPITCHED } from "../features";
import { db, magnitudes, rms, SR } from "./dsp";

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
/** How long after an onset the listener decides what it was (and its velocity). */
export const DECIDE = 0.04;
/** The flux peak sits this far after the attack, on average (from the synthesised set). */
const ONSET_LAG = 0.006;

export interface ListenerOptions {
  calibration?: Calibration;
  /** Flux threshold over the running median; lower hears softer attacks and more false ones. */
  sensitivity?: number;
}

interface Pending {
  time: number;
  peakDb: number;
  /** Samples index of the onset. */
  at: number;
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
  private lastOnset = -Infinity;
  private pending: Pending | null = null;
  /** The note sounding (one at a time from the onset layer). */
  private sounding: { note: number; peakDb: number; time: number } | null = null;
  private out: ListenerEvent[] = [];
  /** Current level (dBFS, 16 ms RMS) and its recent peak, for the meter. */
  levelDb = -120;
  peakDb = -120;
  /** Onsets heard (for the calibration screen). */
  onsets: { time: number; peakDb: number }[] = [];

  constructor(opts: ListenerOptions = {}) {
    this.cal = { ...DEFAULT_CALIBRATION, ...opts.calibration };
    this.sensitivity = opts.sensitivity ?? 0.06;
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
    if (this.flux.length > 40) this.flux.shift();

    // Decide a pending onset once enough of it has been heard.
    const p = this.pending;
    if (p) {
      p.peakDb = Math.max(p.peakDb, level);
      if (abs - p.at >= DECIDE * SR) {
        this.pending = null;
        this.decide(p, events);
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
      const t = now - HOP / SR - ONSET_LAG;
      if (isPeak && c > median * 1.5 + this.sensitivity && level > this.cal.gateDb && t - this.lastOnset >= MIN_IOI) {
        this.lastOnset = t;
        if (this.pending) this.decide(this.pending, events);
        this.pending = { time: t, peakDb: level, at: abs };
      }
    }

    // A sounding note ends when it fades under the gate or well under its peak.
    const s = this.sounding;
    if (s && !this.pending && (level < this.cal.gateDb || level < s.peakDb - 30)) {
      events.push({ kind: "off", time: now - this.cal.latency, note: s.note });
      this.sounding = null;
    }
  }

  /** What an onset was: here, an unpitched hit with the velocity of its peak. */
  private decide(p: Pending, events: ListenerEvent[]): void {
    const time = p.time - this.cal.latency;
    if (this.sounding) events.push({ kind: "off", time, note: this.sounding.note });
    const vel = this.velocityOf(p.peakDb);
    this.onsets.push({ time: p.time, peakDb: p.peakDb });
    if (this.onsets.length > 200) this.onsets.shift();
    events.push({ kind: "on", time, note: UNPITCHED, vel });
    this.sounding = { note: UNPITCHED, peakDb: p.peakDb, time };
  }
}
