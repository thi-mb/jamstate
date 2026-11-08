// The mix bus: a channel strip per part (EQ, compressor, fader, pan, reverb
// send), one shared reverb, and a master with tape-style saturation, a glue
// compressor and a limiter. Settings come from the genre pack's `mix` and the
// lineup's volume and pan (web/src/core/genre.ts, band.ts). Changes glide
// over a few milliseconds, so moving a fader mid-song never clicks.

import type { Amp, Band } from "../core/band";
import { DEFAULT_PART_MIX, type MixPreset, type PartMix } from "../core/genre";
import { PARTS, type Voice } from "../core/types";

const GLIDE = 0.03;

interface Strip {
  input: GainNode;
  /** Amp stage (guitar and bass only): the dry path and the amp path, crossfaded. */
  amp?: AmpStage;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  /** Absent on the player's strip: a compressor delays its signal by its lookahead. */
  comp?: DynamicsCompressorNode;
  fader: GainNode;
  pan: StereoPannerNode;
  send: GainNode;
}

/** Parts with an amp stage on their strip. */
const AMP_PARTS: ReadonlySet<Voice> = new Set(["guitar", "bass"]);

/**
 * An amp and a speaker, after the part's input and before its EQ: a high-pass
 * and a mid push into the amp (so the low end doesn't turn to mud), an
 * asymmetric soft clipper (even harmonics, like a tube), then a speaker cab
 * (two low-passes and a body bump) that takes the fizz off the top. With no
 * amp the dry path plays and the amp path is silent.
 */
interface AmpStage {
  dry: GainNode;
  wet: GainNode;
  push: BiquadFilterNode;
  shaper: WaveShaperNode;
  cab1: BiquadFilterNode;
  cab2: BiquadFilterNode;
  makeup: GainNode;
  bass: boolean;
  key: string;
}

/**
 * The player's monitoring strip: their own notes, a little room, centered.
 * No compression, and it skips the master chain: every DynamicsCompressor
 * holds its signal back by a fixed lookahead (6 ms in Chrome and Firefox), and
 * three in a row made each key press sound about 20 ms late. The band is
 * scheduled ahead, so its share of that delay is never heard.
 */
const PLAYER_MIX: PartMix = { volume: 0.65, pan: 0, eq: [0, 0, 0], comp: 0, reverb: 0.1, tune: 0 };

export class Mixer {
  private strips = new Map<Voice, Strip>();
  private master: GainNode;
  private shaper: WaveShaperNode;
  private reverb: ConvolverNode;
  private reverbKey = "";
  /** Each part's instrument amp (set when the instrument changes). */
  private amps = new Map<Voice, Amp | undefined>();
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
    // The compressor-limiter can overshoot on a fast transient, and the player joins after it; a soft
    // ceiling (no oversampling, so no delay) keeps the sum under 0 dBFS.
    const ceiling = ctx.createWaveShaper();
    ceiling.curve = ceilingCurve();
    const sum = ctx.createGain();
    this.master.connect(this.shaper).connect(glue).connect(limiter).connect(sum).connect(ceiling).connect(this.output);
    this.reverb = ctx.createConvolver();
    const ret = ctx.createGain();
    ret.gain.value = 0.9;
    this.reverb.connect(ret).connect(this.master);
    for (const v of PARTS) {
      const s = this.strip(this.master, true);
      if (AMP_PARTS.has(v)) s.amp = this.ampStage(s, v === "bass");
      this.strips.set(v, s);
    }
    this.strips.set("player", this.strip(sum, false));
    this.setStrip("player", PLAYER_MIX, true);
  }

  private strip(out: AudioNode, compress: boolean): Strip {
    const c = this.ctx;
    const s: Strip = {
      input: c.createGain(),
      low: c.createBiquadFilter(),
      mid: c.createBiquadFilter(),
      high: c.createBiquadFilter(),
      comp: compress ? c.createDynamicsCompressor() : undefined,
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
    const eq = s.input.connect(s.low).connect(s.mid).connect(s.high);
    if (s.comp) {
      s.comp.attack.value = 0.005;
      s.comp.release.value = 0.12;
      eq.connect(s.comp).connect(s.fader);
    } else eq.connect(s.fader);
    s.fader.connect(s.pan).connect(out);
    s.fader.connect(s.send).connect(this.reverb);
    return s;
  }

  private ampStage(s: Strip, bass: boolean): AmpStage {
    const c = this.ctx;
    const filter = (type: BiquadFilterType, f: number, q: number, gain = 0) => {
      const n = c.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      n.gain.value = gain;
      return n;
    };
    const a: AmpStage = {
      dry: c.createGain(),
      wet: c.createGain(),
      push: filter("peaking", bass ? 700 : 900, 0.7),
      shaper: c.createWaveShaper(),
      cab1: filter("lowpass", 4000, 0.9),
      cab2: filter("lowpass", 5000, 0.6),
      makeup: c.createGain(),
      bass,
      key: "",
    };
    a.wet.gain.value = 0;
    a.shaper.oversample = "4x";
    // Keep chords inside the shaper's -1..1 input range; the curve itself carries the drive.
    const pad = c.createGain();
    pad.gain.value = 0.25;
    s.input.disconnect();
    s.input.connect(a.dry).connect(s.low);
    s.input
      .connect(filter("highpass", bass ? 40 : 90, 0.7))
      .connect(a.push)
      .connect(pad)
      .connect(a.shaper)
      .connect(filter("highpass", 30, 0.7)) // the asymmetric curve leaves a little DC
      .connect(a.cab1)
      .connect(a.cab2)
      .connect(filter("peaking", bass ? 90 : 120, 1, 3))
      .connect(a.makeup)
      .connect(a.wet)
      .connect(s.low);
    return a;
  }

  /** The amp a part's instrument plays through (none: the dry signal). */
  setAmp(v: Voice, amp: Amp | undefined): void {
    this.amps.set(v, amp);
    this.applyAmp(v, false);
  }

  private applyAmp(v: Voice, now: boolean): void {
    const a = this.strips.get(v)?.amp;
    if (!a) return;
    const own = this.amps.get(v);
    const extra = this.mix?.parts[v as keyof MixPreset["parts"]]?.drive ?? 0;
    const drive = Math.min(1, (own?.drive ?? 0) + extra);
    const on = own !== undefined || extra > 0;
    this.set(a.dry.gain, on ? 0 : 1, now);
    this.set(a.wet.gain, on ? 1 : 0, now);
    if (!on) return;
    const tone = own?.tone ?? 0.5;
    const settings = ampSettings(drive, tone, a.bass);
    const key = `${drive}:${tone}`;
    if (key !== a.key) {
      a.shaper.curve = ampCurve(settings.k);
      a.key = key;
    }
    this.set(a.push.gain, settings.push, now);
    this.set(a.cab1.frequency, settings.cab, now);
    this.set(a.cab2.frequency, settings.cab * 1.3, now);
    this.set(a.makeup.gain, settings.makeup, now);
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
    if (s.comp) {
      this.set(s.comp.threshold, -30 * m.comp, now);
      this.set(s.comp.ratio, 1 + 5 * m.comp, now);
    }
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
    for (const v of AMP_PARTS) this.applyAmp(v, now);
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

/**
 * The amp's numbers for a drive (0–1) and tone (0–1). `k` is the gain into the
 * clipper (the input is padded by 4 first, so k 4 is unity), `push` the mid
 * boost into it in dB, `cab` the speaker's low-pass in Hz, and `makeup` brings
 * the level back near the dry signal's.
 */
export function ampSettings(drive: number, tone: number, bass: boolean): { k: number; push: number; cab: number; makeup: number } {
  const k = 4 * (1 + Math.pow(drive, 1.5) * (bass ? 6 : 30));
  return {
    k,
    push: 2 + 6 * drive,
    cab: bass ? 1800 + 2500 * tone : 2800 + 4000 * tone,
    makeup: 1 / Math.min(0.3 * k, 4), // small-signal gain is about 0.3k; a hard-driven amp tops out near 4x
  };
}

/** Asymmetric tanh: the positive side clips a little earlier, which adds even harmonics. Passes 0 through 0. */
export function ampCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  const bias = 0.2;
  const off = Math.tanh(bias);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x + bias) - off;
    peak = Math.max(peak, Math.abs(curve[i]));
  }
  for (let i = 0; i < n; i++) curve[i] /= peak;
  return curve;
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
