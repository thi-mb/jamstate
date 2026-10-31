// The mix bus: a channel strip per part (EQ, compressor, fader, pan, reverb
// send), one shared reverb, and a master with tape-style saturation, a glue
// compressor and a limiter. Settings come from the genre pack's `mix` and the
// lineup's volume and pan (web/src/core/genre.ts, band.ts). Changes glide
// over a few milliseconds, so moving a fader mid-song never clicks.

import type { Band } from "../core/band";
import { DEFAULT_PART_MIX, type MixPreset, type PartMix } from "../core/genre";
import { PARTS, type Voice } from "../core/types";

const GLIDE = 0.03;

interface Strip {
  input: GainNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  fader: GainNode;
  pan: StereoPannerNode;
  send: GainNode;
}

/** The player's monitoring strip: their own notes, a little room, centered. */
const PLAYER_MIX: PartMix = { volume: 0.6, pan: 0, eq: [0, 0, 0], comp: 0.2, reverb: 0.1, tune: 0 };

export class Mixer {
  private strips = new Map<Voice, Strip>();
  private master: GainNode;
  private shaper: WaveShaperNode;
  private reverb: ConvolverNode;
  private reverbKey = "";
  readonly output: GainNode;
  mix: MixPreset | null = null;

  constructor(readonly ctx: BaseAudioContext, destination: AudioNode = ctx.destination) {
    this.output = ctx.createGain();
    this.output.connect(destination);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.08;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -12;
    glue.knee.value = 6;
    glue.ratio.value = 2;
    glue.attack.value = 0.015;
    glue.release.value = 0.2;
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = "2x";
    this.master = ctx.createGain();
    // The compressor-limiter can overshoot on a fast transient; a soft ceiling after it keeps the output under 0 dBFS.
    const ceiling = ctx.createWaveShaper();
    ceiling.curve = ceilingCurve();
    this.master.connect(this.shaper).connect(glue).connect(limiter).connect(ceiling).connect(this.output);
    this.reverb = ctx.createConvolver();
    const ret = ctx.createGain();
    ret.gain.value = 0.9;
    this.reverb.connect(ret).connect(this.master);
    for (const v of [...PARTS, "player"] as Voice[]) this.strips.set(v, this.strip());
    this.setStrip("player", PLAYER_MIX, true);
  }

  private strip(): Strip {
    const c = this.ctx;
    const s: Strip = {
      input: c.createGain(),
      low: c.createBiquadFilter(),
      mid: c.createBiquadFilter(),
      high: c.createBiquadFilter(),
      comp: c.createDynamicsCompressor(),
      fader: c.createGain(),
      pan: c.createStereoPanner(),
      send: c.createGain(),
    };
    s.low.type = "lowshelf";
    s.low.frequency.value = 100;
    s.mid.type = "peaking";
    s.mid.frequency.value = 1500;
    s.mid.Q.value = 0.8;
    s.high.type = "highshelf";
    s.high.frequency.value = 8000;
    s.comp.attack.value = 0.005;
    s.comp.release.value = 0.12;
    s.input.connect(s.low).connect(s.mid).connect(s.high).connect(s.comp).connect(s.fader).connect(s.pan).connect(this.master);
    s.fader.connect(s.send).connect(this.reverb);
    return s;
  }

  /** Where a part's notes go. */
  input(v: Voice): AudioNode {
    return this.strips.get(v)!.input;
  }

  private set(p: AudioParam, value: number, now: boolean): void {
    if (now) p.value = value;
    else p.setTargetAtTime(value, this.ctx.currentTime, GLIDE);
  }

  private setStrip(v: Voice, m: PartMix, now = false): void {
    const s = this.strips.get(v)!;
    this.set(s.low.gain, m.eq[0], now);
    this.set(s.mid.gain, m.eq[1], now);
    this.set(s.high.gain, m.eq[2], now);
    // comp 0 → off (ratio 1); 1 → threshold -30 dB at 6:1. Makeup gain keeps the level.
    this.set(s.comp.threshold, -30 * m.comp, now);
    this.set(s.comp.ratio, 1 + 5 * m.comp, now);
    this.set(s.fader.gain, m.volume * (1 + 0.6 * m.comp), now);
    this.set(s.pan.pan, m.pan, now);
    this.set(s.send.gain, m.reverb, now);
  }

  /** Apply a genre's mix with the lineup's own volume and pan on top. `now` skips the glide (a fresh mixer). */
  apply(mix: MixPreset, band: Band, now = false): void {
    this.mix = mix;
    for (const p of PARTS) {
      const slot = band[p];
      const m = mix.parts[p] ?? DEFAULT_PART_MIX[p];
      this.setStrip(p, { ...m, volume: slot?.volume ?? m.volume, pan: slot?.pan ?? m.pan }, now);
    }
    this.set(this.master.gain, mix.gain, now);
    this.shaper.curve = saturationCurve(mix.saturation);
    const key = `${mix.reverb.seconds}:${mix.reverb.tone}`;
    if (key !== this.reverbKey) {
      this.reverb.buffer = impulse(this.ctx, mix.reverb.seconds, mix.reverb.tone);
      this.reverbKey = key;
    }
  }

  /** Fader for one part, 0–1 (the lineup picker). */
  setVolume(v: Voice, volume: number): void {
    const m = v === "player" ? PLAYER_MIX : (this.mix?.parts[v] ?? DEFAULT_PART_MIX[v]);
    this.set(this.strips.get(v)!.fader.gain, volume * (1 + 0.6 * m.comp), false);
  }

  setPan(v: Voice, pan: number): void {
    this.set(this.strips.get(v)!.pan.pan, pan, false);
  }

  /** Fade everything out and let go of the graph. */
  dispose(fade = 0.02): void {
    const t = this.ctx.currentTime;
    this.output.gain.setTargetAtTime(0, t, fade);
    setTimeout(() => this.output.disconnect(), fade * 10_000);
  }
}

/** tanh soft clipping, normalised so a full-scale input stays full scale. 0 is a straight line. */
export function saturationCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = 0.01 + amount * 4;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/** Straight up to -2 dBFS, then a smooth knee that never passes -0.3 dBFS. */
export function ceilingCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  const knee = 0.794;
  const top = 0.966;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1; // the shaper maps -1..1 across the curve; louder input holds at the ends
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (top - knee) * Math.tanh((a - knee) / (top - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

/**
 * A room as a stereo impulse response: decaying noise, darker as it fades
 * (tone 0 dark, 1 bright), with a short pre-delay. Seeded, so every page
 * builds the same room.
 */
export function impulse(ctx: BaseAudioContext, seconds: number, tone: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const buf = ctx.createBuffer(2, len, rate);
  const pre = Math.floor(0.012 * rate);
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / rate;
      const env = Math.pow(1 - (i - pre) / (len - pre), 2) * Math.exp((-3 * t) / seconds);
      // One-pole lowpass whose cutoff falls over the tail.
      const a = Math.min(0.99, 0.25 + 0.7 * tone) * Math.exp(-t * (1.5 - tone));
      lp = lp + a * (rnd() - lp);
      d[i] = lp * env;
    }
  }
  // Normalise the energy so a longer room isn't simply louder.
  let e = 0;
  for (let ch = 0; ch < 2; ch++) for (const x of buf.getChannelData(ch)) e += x * x;
  const g = 1 / Math.sqrt(e / 2 + 1e-9) * 0.5;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] *= g;
  }
  return buf;
}
