// Built-in sound: sampled instruments (sampler.ts) through the mix bus
// (mixer.ts), with small Web Audio synth voices that play any part whose
// samples haven't loaded (or can't), so the band always plays. Every note is
// scheduled at an exact AudioContext time.

import { ampFor, defaultInstrument, type Band } from "../core/band";
import { DEFAULT_MIX, type MixPreset } from "../core/genre";
import { DRUM, PERC } from "../core/groove";
import type { Sink } from "../core/transport";
import { PARTS, type NoteEvent, type Voice } from "../core/types";
import { Mixer } from "./mixer";
import type { SampleLibrary } from "./sampler";

const mtof = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export class Synth implements Sink {
  private mixer!: Mixer;
  private noise: AudioBuffer;
  private mix: MixPreset = DEFAULT_MIX;
  private band: Band = {};
  /** The instrument each part plays right now (switches once the new one has loaded). */
  private active: Partial<Record<Voice, string>> = {};
  /** The player's own sound. */
  playerInstrument = defaultInstrument("player");
  readonly muted = new Set<Voice>();

  constructor(
    readonly ctx: BaseAudioContext,
    readonly library: SampleLibrary | null = null,
  ) {
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.buildBus();
  }

  private buildBus(): void {
    this.mixer = new Mixer(this.ctx);
    for (const p of PARTS) this.mixer.setAmp(p, ampFor(this.active[p]));
    this.mixer.apply(this.mix, this.band, true);
  }

  /** The genre's production: EQ, compression, room, saturation. */
  setMix(mix: MixPreset): void {
    this.mix = mix;
    this.mixer.apply(mix, this.band);
  }

  /**
   * The lineup's sounds, volumes and pans. A part keeps its old instrument
   * until the new one has loaded, so switching mid-song never drops notes.
   */
  setBand(band: Band): void {
    this.band = band;
    this.mixer.apply(this.mix, band);
    for (const p of PARTS) {
      const id = band[p]?.instrument;
      if (id) this.use(p, id);
    }
    this.use("player", this.playerInstrument);
  }

  setPlayerInstrument(id: string): void {
    this.playerInstrument = id;
    this.use("player", id);
  }

  private use(v: Voice, id: string): void {
    if (this.active[v] === id) return;
    if (!this.library) return void this.activate(v, id);
    if (this.library.get(id) || !this.active[v]) this.activate(v, id);
    void this.library.load(id).then((inst) => {
      const want = v === "player" ? this.playerInstrument : this.band[v]?.instrument;
      if (inst && want === id) this.activate(v, id);
    });
  }

  /** Switch a part's sound, and its amp with it. */
  private activate(v: Voice, id: string): void {
    this.active[v] = id;
    if (v !== "player") this.mixer.setAmp(v, ampFor(id));
  }

  /** Which instrument plays a part: the sample set's id, or null while the synth covers for it. */
  sounding(v: Voice): string | null {
    const id = this.active[v];
    return id && this.library?.get(id) ? id : null;
  }

  setVolume(v: Voice, gain: number): void {
    this.mixer.setVolume(v, gain);
  }

  setPan(v: Voice, pan: number): void {
    this.mixer.setPan(v, pan);
  }

  play(ev: NoteEvent, time: number, duration: number): void {
    // An unpitched hit from audio input (pitch -1) has nothing to sound.
    if (this.muted.has(ev.part) || ev.note < 0) return;
    const out = this.mixer.input(ev.part);
    const id = this.active[ev.part];
    const inst = id ? this.library?.get(id) : undefined;
    const tune = ev.part === "drums" ? this.mix.parts.drums.tune : 0;
    if (inst && inst.play(this.ctx, out, ev.note, ev.vel, time, duration, { tune })) return;
    const v = ev.vel / 127;
    if (ev.part === "drums" || ev.part === "percussion") this.drum(ev.note, v, time, out);
    else if (ev.part === "bass") this.bass(ev.note, v, time, duration, out);
    else if (ev.part === "chords" || ev.part === "pad") this.pad(ev.note, v * (ev.part === "pad" ? 0.7 : 1), time, duration, out);
    else if (ev.part === "guitar") this.pluck(ev.note, v, time, duration, out);
    else this.keys(ev.note, v, time, duration, out);
  }

  /** Fade the current mix out and start a fresh one, cutting every scheduled note. */
  panic(): void {
    this.mixer.dispose();
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
      case PERC.conga_hi:
      case PERC.conga_mute:
      case PERC.bongo_hi:
        return this.tone(t, "sine", 420, 330, 0.03, v * 0.6, note === PERC.conga_mute ? 0.06 : 0.18, out);
      case PERC.conga_lo:
      case PERC.bongo_lo:
        return this.tone(t, "sine", 300, 230, 0.03, v * 0.6, 0.22, out);
      case PERC.tambourine:
        return this.noiseBurst(t, v * 0.35, 0.12, "highpass", 6500, out);
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

  /** A plucked string (the guitar until its samples load). */
  private pluck(note: number, v: number, t: number, dur: number, out: AudioNode): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = mtof(note);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(800 + 3000 * v, t);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.3);
    const g = ctx.createGain();
    const end = t + Math.max(dur, 0.05);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 * v + 0.02, t + 0.004);
    g.gain.setTargetAtTime(0.08 * v, t + 0.01, 0.3);
    g.gain.setTargetAtTime(0.0001, end, 0.04);
    o.connect(f).connect(g).connect(out);
    o.start(t);
    o.stop(end + 0.3);
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
    const inst = this.active.player ? this.library?.get(this.active.player) : undefined;
    const sampled = inst?.hold(ctx, this.mixer.input("player"), note, vel);
    if (sampled) return sampled;
    const t = ctx.currentTime;
    const v = vel / 127;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * v + 0.02, t + 0.005);
    g.gain.setTargetAtTime(0.15 * v, t + 0.01, 0.4);
    g.connect(this.mixer.input("player"));
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
