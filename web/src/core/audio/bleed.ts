// The bleed gate (v0.5 layer 4, ADR-0025): with speakers, the input hears
// the band too. The page knows what the band plays (its own mix, fed to the
// input worklet as a reference), so each short frame of the input is
// compared with the reference, delayed by the trip through the speakers
// and the room and scaled by how much of it reaches the input in each of
// 24 bands. Bins not clearly above that expected bleed are zeroed, and the
// cleaned audio goes on to the listener unchanged.
//
// The gate learns as the jam goes: the delay from how the input's level
// follows the band's, the coupling from the moments the player is quiet (the input is
// nothing but bleed).

import { fft, SR } from "./dsp";

const N = 512;
const HOP = 128;
const BINS = N / 2 + 1;
const BANDS = 24;
/** A bin passes when it's this far over the expected bleed (in magnitude; 2 is 6 dB). */
export const OVER = 2;
/** The room's tail: the expected bleed falls this much a hop at most (about 0.35 s to −60 dB). */
export const TAIL = 0.85;
/** The hops of level kept to find the delay (3 s), and the longest delay looked for (0.4 s). */
const HISTORY = 375;
const MAX_LAG = 50;

/** The band each bin belongs to: log-spaced from 60 Hz to 8 kHz. */
const BAND_OF = Array.from({ length: BINS }, (_, k) => {
  const f = Math.max(60, (k * SR) / N);
  return Math.min(BANDS - 1, Math.floor((BANDS * Math.log(f / 60)) / Math.log(8000 / 60)));
});

export interface BleedState {
  /** Seconds from the band's output to the input. */
  delay: number;
  /** How sure the delay is (the envelopes' correlation, 0..1). */
  sure: number;
  /** The coupling per band (input over reference magnitude). */
  coupling: number[];
}

export class BleedGate {
  /** Samples the cleaned audio runs behind the input. */
  readonly latency = N - HOP;
  private win: Float32Array;
  private inBuf = new Float32Array(N);
  private refBuf = new Float32Array(1 << 14);
  private refLen = 0;
  private fill = 0;
  private out = new Float32Array(N);
  private ready: number[] = [];
  private re = new Float64Array(N);
  private im = new Float64Array(N);
  private rre = new Float64Array(N);
  private rim = new Float64Array(N);
  /** The expected bleed per bin, with the room's tail. */
  private expect = new Float64Array(BINS);
  private coupling: Float64Array;
  /** Delay in samples. */
  private delay: number;
  private sure = 0;
  private inEnv: number[] = [];
  private refEnv: number[] = [];
  private hops = 0;
  /** Hops the coupling has learned from. */
  private learned = 0;
  private over: number;
  private tail: number;

  /** `delay`: a first guess (seconds) until the gate has heard enough to measure it. */
  constructor(opts: { delay?: number; coupling?: number; over?: number; tail?: number } = {}) {
    this.over = opts.over ?? OVER;
    this.tail = opts.tail ?? TAIL;
    // A square-root Hann for analysis and synthesis: at a quarter-frame hop they add up to 2.
    this.win = Float32Array.from({ length: N }, (_, i) => Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)));
    this.coupling = new Float64Array(BANDS).fill(opts.coupling ?? 1);
    this.delay = Math.round((opts.delay ?? 0.05) * SR);
  }

  get state(): BleedState {
    return { delay: this.delay / SR, sure: this.sure, coupling: [...this.coupling].map((c) => Math.round(c * 1000) / 1000) };
  }

  /** Input and reference (16 kHz, the same clock and length): the cleaned input, `latency` samples late. */
  push(input: Float32Array, ref: Float32Array): Float32Array {
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      this.addRef(ref[i] ?? 0);
      this.inBuf[this.fill++] = input[i];
      if (this.fill === N) {
        this.frame();
        this.inBuf.copyWithin(0, HOP);
        this.fill = N - HOP;
      }
      out[i] = this.ready.length ? this.ready.shift()! : 0;
    }
    return out;
  }

  private addRef(v: number): void {
    if (this.refLen === this.refBuf.length) {
      this.refBuf.copyWithin(0, this.refBuf.length / 2);
      this.refLen = this.refBuf.length / 2;
    }
    this.refBuf[this.refLen++] = v;
  }

  private frame(): void {
    const { re, im, rre, rim, win } = this;
    // The reference frame that reached the input with this one.
    const rStart = this.refLen - N - this.delay;
    for (let i = 0; i < N; i++) {
      re[i] = this.inBuf[i] * win[i];
      im[i] = 0;
      rre[i] = rStart + i >= 0 ? this.refBuf[rStart + i] * win[i] : 0;
      rim[i] = 0;
    }
    fft(re, im);
    fft(rre, rim);
    let inE = 0;
    let refE = 0;
    const bandIn = new Float64Array(BANDS);
    const bandRef = new Float64Array(BANDS);
    for (let k = 0; k < BINS; k++) {
      const x = Math.hypot(re[k], im[k]);
      const r = Math.hypot(rre[k], rim[k]);
      const b = BAND_OF[k];
      bandIn[b] += x;
      bandRef[b] += r;
      inE += x * x;
      refE += r * r;
      const e = Math.max(this.coupling[b] * r, this.expect[k] * this.tail);
      this.expect[k] = e;
      if (x <= this.over * e) {
        re[k] = 0;
        im[k] = 0;
        if (k > 0 && k < N / 2) {
          re[N - k] = 0;
          im[N - k] = 0;
        }
      }
    }
    // The coupling follows the lowest input-to-band ratio in each band: falling
    // fast, rising slowly. Frames with the player in them only ever raise the
    // ratio, so it settles on the frames that are nothing but bleed.
    if (refE > 1e-6) {
      for (let b = 0; b < BANDS; b++) {
        if (bandRef[b] < 1e-4) continue;
        const ratio = Math.min(4, bandIn[b] / bandRef[b]);
        const c = this.coupling[b];
        this.coupling[b] += (ratio < c ? (this.learned < 60 ? 0.3 : 0.1) : 0.004) * (ratio - c);
      }
      this.learned++;
    }
    // Back to samples: inverse FFT by conjugation, windowed again and overlapped.
    for (let i = 0; i < N; i++) im[i] = -im[i];
    fft(re, im);
    for (let i = 0; i < N; i++) this.out[i] += ((re[i] / N) * win[i]) / 2;
    for (let i = 0; i < HOP; i++) this.ready.push(this.out[i]);
    this.out.copyWithin(0, HOP);
    this.out.fill(0, N - HOP);
    // Levels of the newest hop of each, undelayed, for the delay.
    let a = 0;
    let c = 0;
    for (let i = N - HOP; i < N; i++) a += this.inBuf[i] ** 2;
    for (let i = this.refLen - HOP; i < this.refLen; i++) c += (this.refBuf[i] ?? 0) ** 2;
    this.track(Math.sqrt(a / HOP), Math.sqrt(c / HOP));
  }

  /** Follow the delay: where the input's level changes line up best with the reference's. */
  private track(inLevel: number, refLevel: number): void {
    this.inEnv.push(Math.log1p(1000 * inLevel));
    this.refEnv.push(Math.log1p(1000 * refLevel));
    if (this.inEnv.length > HISTORY) {
      this.inEnv.shift();
      this.refEnv.shift();
    }
    if (++this.hops % 125 !== 0 || this.inEnv.length < HISTORY) return;
    // Rises only (onsets carry the timing; the tails are the room's).
    const rise = (a: number[]) => a.map((v, i) => (i ? Math.max(0, v - a[i - 1]) : 0));
    const x = rise(this.inEnv);
    const r = rise(this.refEnv);
    const norm = (a: number[], from: number, to: number) => Math.sqrt(a.slice(from, to).reduce((s, v) => s + v * v, 0)) || 1;
    let best = -1;
    let lag = 0;
    for (let l = 0; l <= MAX_LAG; l++) {
      let dot = 0;
      for (let i = l; i < x.length; i++) dot += x[i] * r[i - l];
      const c = dot / (norm(x, l, x.length) * norm(r, 0, x.length - l));
      if (c > best) [best, lag] = [c, l];
    }
    if (best > 0.5 && best >= this.sure * 0.8) {
      this.delay = lag * HOP;
      this.sure = best;
    }
  }
}
