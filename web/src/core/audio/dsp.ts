// Small DSP pieces for audio input (v0.5, ADR-0023): an in-place radix-2
// FFT, windows, levels in dB, and the resampler the input worklet and the
// Node tools share, so the page and the eval hear the same 16 kHz signal.

/** Everything the detectors see runs at this rate. */
export const SR = 16000;

/** In-place radix-2 FFT of (re, im); length a power of two. */
export function fft(re: Float32Array | Float64Array, im: Float32Array | Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const windows = new Map<number, Float32Array>();

/** A Hann window of length n (cached). */
export function hann(n: number): Float32Array {
  let w = windows.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    windows.set(n, w);
  }
  return w;
}

/**
 * Magnitude spectrum (n/2 + 1 bins) of the last `n` samples of `x` ending at
 * `end`, Hann windowed. `re` and `im` are scratch buffers of length n.
 */
export function magnitudes(x: Float32Array, end: number, n: number, re: Float64Array, im: Float64Array, out: Float32Array): Float32Array {
  const w = hann(n);
  const start = end - n;
  for (let i = 0; i < n; i++) {
    const j = start + i;
    re[i] = j >= 0 ? x[j] * w[i] : 0;
    im[i] = 0;
  }
  fft(re, im);
  for (let k = 0; k <= n / 2; k++) out[k] = Math.hypot(re[k], im[k]) * (2 / n);
  return out;
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = Math.max(0, from); i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Level in dBFS; silence is -120. */
export const db = (amp: number) => (amp > 1e-6 ? 20 * Math.log10(amp) : -120);
export const fromDb = (d: number) => Math.pow(10, d / 20);

/** MIDI note of a frequency, fractional. */
export const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const hzOf = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/**
 * Streaming resampler to `outRate`: a windowed-sinc low-pass at the input
 * rate (cut at 0.45 of the output rate), then linear interpolation. Good
 * enough for detection, cheap enough for a worklet. Keeps state between
 * blocks, so blocks of any size give the same output as one long block.
 */
export class Resampler {
  private taps: Float32Array;
  private hist: Float32Array;
  private pos = 0;
  private step: number;
  /** Filtered input samples kept for interpolation across blocks. */
  private prev = 0;
  private haveprev = false;

  constructor(readonly inRate: number, readonly outRate = SR, ntaps = 31) {
    this.step = inRate / outRate;
    const fc = Math.min(0.5, (0.45 * outRate) / inRate);
    this.taps = new Float32Array(ntaps);
    const m = (ntaps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < ntaps; i++) {
      const t = i - m;
      const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (ntaps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (ntaps - 1));
      this.taps[i] = sinc * w;
      sum += this.taps[i];
    }
    for (let i = 0; i < ntaps; i++) this.taps[i] /= sum;
    this.hist = new Float32Array(ntaps);
  }

  /** Resample one block; returns the output samples it completes. */
  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input.slice();
    const out: number[] = [];
    const taps = this.taps;
    const hist = this.hist;
    const nt = taps.length;
    for (let i = 0; i < input.length; i++) {
      hist.copyWithin(0, 1);
      hist[nt - 1] = input[i];
      let y = 0;
      for (let k = 0; k < nt; k++) y += hist[k] * taps[k];
      if (!this.haveprev) {
        this.prev = y;
        this.haveprev = true;
        continue;
      }
      // Output samples falling between the previous filtered sample and this one.
      while (this.pos <= 1) {
        out.push(this.prev + (y - this.prev) * this.pos);
        this.pos += this.step;
      }
      this.pos -= 1;
      this.prev = y;
    }
    return Float32Array.from(out);
  }
}

/** Resample a whole signal (offline: WAV files in the eval and tests). */
export function resample(x: Float32Array, inRate: number, outRate = SR): Float32Array {
  if (inRate === outRate) return x;
  return new Resampler(inRate, outRate).process(x);
}
