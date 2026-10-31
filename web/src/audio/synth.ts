// Built-in sound: small Web Audio voices so the band plays with nothing
// installed. Every note is scheduled at an exact AudioContext time.

import { DRUM } from "../core/groove";
import type { Sink } from "../core/transport";
import type { NoteEvent, Voice } from "../core/types";

const mtof = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export class Synth implements Sink {
  private master!: GainNode;
  private buses = new Map<Voice, GainNode>();
  private noise: AudioBuffer;
  readonly muted = new Set<Voice>();

  constructor(readonly ctx: AudioContext) {
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.buildBus();
  }

  private buildBus(): void {
    const ctx = this.ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(comp).connect(ctx.destination);
    const levels: Record<Voice, number> = { drums: 0.9, bass: 0.7, chords: 0.32, player: 0.45 };
    this.buses.clear();
    for (const [v, g] of Object.entries(levels) as [Voice, number][]) {
      const bus = ctx.createGain();
      bus.gain.value = g;
      bus.connect(this.master);
      this.buses.set(v, bus);
    }
  }

  setVolume(v: Voice, gain: number): void {
    this.buses.get(v)!.gain.value = gain;
  }

  play(ev: NoteEvent, time: number, duration: number): void {
    if (this.muted.has(ev.part)) return;
    const out = this.buses.get(ev.part)!;
    const v = ev.vel / 127;
    if (ev.part === "drums") this.drum(ev.note, v, time, out);
    else if (ev.part === "bass") this.bass(ev.note, v, time, duration, out);
    else if (ev.part === "chords") this.pad(ev.note, v, time, duration, out);
    else this.keys(ev.note, v, time, duration, out);
  }

  /** Fade the current mix out and start a fresh one, cutting every scheduled note. */
  panic(): void {
    const old = this.master;
    const t = this.ctx.currentTime;
    old.gain.setTargetAtTime(0, t, 0.02);
    setTimeout(() => old.disconnect(), 200);
    this.buildBus();
  }

  private env(time: number, peak: number, attack: number, decay: number, out: AudioNode): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), time + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, time + attack + decay);
    g.connect(out);
    return g;
  }

  private noiseBurst(time: number, v: number, decay: number, type: BiquadFilterType, freq: number, out: AudioNode): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    src.connect(f).connect(this.env(time, v, 0.002, decay, out));
    src.start(time, Math.random() * 0.5);
    src.stop(time + decay + 0.05);
  }

  private tone(time: number, type: OscillatorType, from: number, to: number, sweep: number, v: number, decay: number, out: AudioNode): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, time);
    o.frequency.exponentialRampToValueAtTime(to, time + sweep);
    o.connect(this.env(time, v, 0.002, decay, out));
    o.start(time);
    o.stop(time + decay + 0.05);
  }

  private drum(note: number, v: number, t: number, out: AudioNode): void {
    switch (note) {
      case DRUM.kick:
        return this.tone(t, "sine", 150, 45, 0.12, v, 0.35, out);
      case DRUM.snare:
        this.tone(t, "triangle", 220, 160, 0.05, v * 0.5, 0.1, out);
        return this.noiseBurst(t, v * 0.7, 0.16, "highpass", 1500, out);
      case DRUM.stick:
        return this.noiseBurst(t, v * 0.6, 0.04, "bandpass", 2500, out);
      case DRUM.hat:
        return this.noiseBurst(t, v * 0.35, 0.045, "highpass", 7500, out);
      case DRUM.openHat:
        return this.noiseBurst(t, v * 0.35, 0.3, "highpass", 7000, out);
      case DRUM.pedalHat:
        return this.noiseBurst(t, v * 0.25, 0.03, "highpass", 6500, out);
      case DRUM.crash:
        return this.noiseBurst(t, v * 0.45, 1.6, "highpass", 4500, out);
      case DRUM.ride:
        this.tone(t, "square", 3200, 3150, 0.3, v * 0.03, 0.35, out);
        return this.noiseBurst(t, v * 0.22, 0.35, "bandpass", 6000, out);
      case DRUM.bell:
        this.tone(t, "square", 2400, 2380, 0.4, v * 0.06, 0.5, out);
        return this.noiseBurst(t, v * 0.18, 0.2, "bandpass", 5000, out);
      case DRUM.clap:
        return this.noiseBurst(t, v * 0.6, 0.12, "bandpass", 1800, out);
      case DRUM.tomHi:
      case DRUM.tomMid:
      case DRUM.tomLo: {
        const f = note === DRUM.tomHi ? 200 : note === DRUM.tomMid ? 150 : 110;
        return this.tone(t, "sine", f * 1.6, f, 0.08, v, 0.3, out);
      }
      default:
        return this.noiseBurst(t, v * 0.3, 0.05, "bandpass", 3000, out);
    }
  }

  private bass(note: number, v: number, t: number, dur: number, out: AudioNode): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = mtof(note);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.Q.value = 6;
    f.frequency.setValueAtTime(200 + 1400 * v, t);
    f.frequency.exponentialRampToValueAtTime(180, t + Math.min(dur, 0.25));
    const g = ctx.createGain();
    const end = t + Math.max(dur, 0.08);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6 * v + 0.05, t + 0.008);
    g.gain.setTargetAtTime(0.35 * v, t + 0.01, 0.15);
    g.gain.setTargetAtTime(0.0001, end, 0.03);
    o.connect(f).connect(g).connect(out);
    o.start(t);
    o.stop(end + 0.2);
  }

  private pad(note: number, v: number, t: number, dur: number, out: AudioNode): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const end = t + Math.max(dur, 0.1);
    const attack = dur > 1.5 ? 0.06 : 0.01;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 * v + 0.02, t + attack);
    g.gain.setTargetAtTime(0.0001, end, 0.08);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 900 + 2200 * v;
    f.connect(g).connect(out);
    for (const detune of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = mtof(note);
      o.detune.value = detune;
      o.connect(f);
      o.start(t);
      o.stop(end + 0.5);
    }
  }

  /** The player's own notes (monitoring). */
  private keys(note: number, v: number, t: number, dur: number, out: AudioNode): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const end = t + Math.max(dur, 0.05);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * v + 0.02, t + 0.005);
    g.gain.setTargetAtTime(0.15 * v, t + 0.01, 0.4);
    g.gain.setTargetAtTime(0.0001, end, 0.06);
    g.connect(out);
    for (const [type, mul, lvl] of [["triangle", 1, 1], ["sine", 2, 0.3]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = mtof(note) * mul;
      const og = ctx.createGain();
      og.gain.value = lvl;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(end + 0.4);
    }
  }

  /** Live note from the player: starts now, ends on release. Returns a release function. */
  liveNote(note: number, vel: number): () => void {
    if (this.muted.has("player")) return () => {};
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const v = vel / 127;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * v + 0.02, t + 0.005);
    g.gain.setTargetAtTime(0.15 * v, t + 0.01, 0.4);
    g.connect(this.buses.get("player")!);
    const oscs = (["triangle", "sine"] as const).map((type, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = mtof(note) * (i + 1);
      const og = ctx.createGain();
      og.gain.value = i ? 0.3 : 1;
      o.connect(og).connect(g);
      o.start(t);
      return o;
    });
    return () => {
      const r = ctx.currentTime;
      g.gain.cancelScheduledValues(r);
      g.gain.setTargetAtTime(0.0001, r, 0.06);
      for (const o of oscs) o.stop(r + 0.4);
    };
  }
}
