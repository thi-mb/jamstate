// Monophonic pitch (v0.5 layer 2, ADR-0023): YIN on a 1024-sample window
// (64 ms at 16 kHz) or 512, with the difference function from an FFT
// cross-correlation so a frame costs three FFTs of twice the window.
// Single-note guitar, bass, voice and horns.

import { fft, SR } from "./dsp";

export interface PitchFrame {
  /** Hz, or 0 when nothing periodic was found. */
  hz: number;
  /** YIN's aperiodicity at the dip: 0 a pure tone, 1 noise. */
  aperiodicity: number;
}

export const PITCH_WINDOW = 1024;

export class Yin {
  private tauMin: number;
  private tauMax: number;
  private wi: number;
  private ar: Float64Array;
  private ai: Float64Array;
  private br: Float64Array;
  private bi: Float64Array;
  private d: Float64Array;

  /**
   * Between `lowHz` and `highHz` over a window of `size` samples (the lowest
   * period must fit in half of it); `threshold` is YIN's absolute threshold.
   */
  constructor(lowHz = 60, highHz = 1500, private threshold = 0.15, readonly size = PITCH_WINDOW) {
    this.tauMin = Math.max(2, Math.floor(SR / highHz));
    this.tauMax = Math.min(size / 2 - 1, Math.ceil(SR / lowHz));
    this.wi = size - this.tauMax;
    this.d = new Float64Array(this.tauMax + 2);
    const n2 = size * 2;
    this.ar = new Float64Array(n2);
    this.ai = new Float64Array(n2);
    this.br = new Float64Array(n2);
    this.bi = new Float64Array(n2);
  }

  /** The pitch of the window of `x` ending at `end`. */
  frame(x: Float32Array, end: number): PitchFrame {
    const W = this.size;
    const N2 = W * 2;
    const start = end - W;
    if (start < 0) return { hz: 0, aperiodicity: 1 };
    const wi = this.wi;
    const { ar, ai, br, bi } = this;
    ar.fill(0);
    ai.fill(0);
    br.fill(0);
    bi.fill(0);
    let mean = 0;
    for (let i = 0; i < W; i++) mean += x[start + i];
    mean /= W;
    for (let i = 0; i < W; i++) {
      const v = x[start + i] - mean;
      br[i] = v;
      if (i < wi) ar[i] = v;
    }
    // r(τ) = Σ_{j<wi} a_j b_{j+τ}: the correlation of the first part with the whole window.
    fft(ar, ai);
    fft(br, bi);
    for (let k = 0; k < N2; k++) {
      const re = ar[k] * br[k] + ai[k] * bi[k];
      const im = ar[k] * bi[k] - ai[k] * br[k];
      br[k] = re;
      bi[k] = -im;
    }
    fft(br, bi);
    const r = (tau: number) => br[tau] / N2;
    // Energies of the two windows, sliding.
    let e0 = 0;
    for (let j = 0; j < wi; j++) e0 += (x[start + j] - mean) ** 2;
    let et = e0;
    const d = this.d;
    d[0] = 1;
    let sum = 0;
    for (let tau = 1; tau <= this.tauMax; tau++) {
      const out = x[start + tau - 1] - mean;
      const inn = x[start + wi + tau - 1] - mean;
      et += inn * inn - out * out;
      const diff = Math.max(0, e0 + et - 2 * r(tau));
      sum += diff;
      d[tau] = sum > 0 ? (diff * tau) / sum : 1;
    }
    if (e0 < 1e-9) return { hz: 0, aperiodicity: 1 };
    // The first dip under the threshold, else the deepest.
    let best = -1;
    for (let tau = this.tauMin; tau < this.tauMax; tau++) {
      if (d[tau] < this.threshold) {
        while (tau + 1 < this.tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      best = this.tauMin;
      for (let tau = this.tauMin; tau < this.tauMax; tau++) if (d[tau] < d[best]) best = tau;
    }
    // Parabolic interpolation.
    const a = d[best - 1] ?? d[best];
    const b = d[best];
    const c = d[best + 1] ?? d[best];
    const den = a - 2 * b + c;
    const shift = den > 0 ? (0.5 * (a - c)) / den : 0;
    const tau = best + Math.max(-0.5, Math.min(0.5, shift));
    return { hz: SR / tau, aperiodicity: Math.max(0, Math.min(1, b)) };
  }
}

/** Cents between two frequencies. */
export function cents(a: number, b: number): number {
  return 1200 * Math.log2(a / b);
}
