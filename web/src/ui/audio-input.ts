// The audio input panel under You (v0.5, ADR-0023): device and channel, a
// level meter with a clip light, "hear input", the calibration steps, and
// keeping the raw audio of a jam. Detected notes go to the page's player
// input like MIDI notes do.

import { calibrateLevels, latencyFromTaps, type LevelTake } from "../core/audio/calibrate";
import { db, SR } from "../core/audio/dsp";
import { AudioListener, DEFAULT_CALIBRATION, type Calibration, type ListenerEvent } from "../core/audio/listener";
import { encodeWav } from "../core/audio/wav";
import type { AudioInputHandle, AudioInputPlatform, InputChannel, KeyValueStore } from "../core/platform";
import type { SessionInput } from "../core/session";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const DEVICE_KEY = "jamstate.audio.device";
const CHANNEL_KEY = "jamstate.audio.channel";
const CAL_KEY = "jamstate.audio.calibration";
/** Calibration kept per device and channel. */
type Stored = Record<string, Calibration & { tapped?: boolean }>;

export const DETECTOR = "jamstate-listener/0.5";

export class AudioInputPanel {
  listener: AudioListener | null = null;
  private handle: AudioInputHandle | null = null;
  private clipUntil = 0;
  private raf = 0;
  /** While a jam keeps its audio: the 16 kHz chunks and the time of the first sample. */
  private taping: { chunks: Float32Array[]; t0: number | null } | null = null;
  /** The last jam's audio, ready to download or sync. */
  lastTape: { wav: Uint8Array; t0: number } | null = null;
  /** Calibration steps listen through this while they run. */
  private tap: ((samples: Float32Array, time: number) => void) | null = null;

  /** A detected note (time on the audio clock). */
  onNote: (on: boolean, note: number, vel: number, time: number) => void = () => {};
  /** The output latency the player hears, for the timing step. */
  outputLatency: () => number = () => 0;

  constructor(
    private input: AudioInputPlatform,
    private audio: () => AudioContext,
    private settings: KeyValueStore,
  ) {
    const dev = $<HTMLSelectElement>("audio-in");
    const ch = $<HTMLSelectElement>("audio-channel");
    if (!input.available()) {
      dev.disabled = true;
      $("audio-status").textContent = "This browser can't take audio input.";
      return;
    }
    ch.value = settings.get<string>(CHANNEL_KEY) ?? "1";
    dev.onchange = () => void this.open();
    ch.onchange = () => {
      settings.set(CHANNEL_KEY, ch.value);
      this.handle?.setChannel(this.channel);
      this.applyCalibration();
    };
    $<HTMLInputElement>("audio-monitor").onchange = (e) => this.handle?.setMonitor((e.target as HTMLInputElement).checked);
    $("calibrate").onclick = () => void this.calibrate();
    void this.fillDevices(settings.get<string>(DEVICE_KEY) ? "off-but-remembered" : null);
  }

  get active(): boolean {
    return !!this.handle;
  }

  private get channel(): InputChannel {
    const v = $<HTMLSelectElement>("audio-channel").value;
    return v === "mix" ? "mix" : v === "2" ? 1 : 0;
  }

  private get calKey(): string {
    return `${$<HTMLSelectElement>("audio-in").value}|${$<HTMLSelectElement>("audio-channel").value}`;
  }

  private async fillDevices(keep: string | null): Promise<void> {
    const dev = $<HTMLSelectElement>("audio-in");
    const list = await this.input.devices().catch(() => []);
    const want = keep === "off-but-remembered" ? "" : (keep ?? dev.value);
    dev.replaceChildren(new Option("off", ""), ...list.map((d, i) => new Option(d.label === "input" ? `input ${i + 1}` : d.label, d.id || "default")));
    dev.value = [...dev.options].some((o) => o.value === want) ? want : "";
  }

  private applyCalibration(): void {
    if (!this.listener) return;
    const stored = this.settings.get<Stored>(CAL_KEY)?.[this.calKey];
    const cal = { ...DEFAULT_CALIBRATION, ...stored };
    // Untapped: trust what the browser says about the input's latency.
    if (!stored?.tapped) cal.latency = this.handle?.latency ?? 0;
    this.listener.cal = cal;
    $("calibration-info").textContent = stored
      ? `Calibrated: gate ${cal.gateDb} dB, soft ${cal.softDb} dB, hard ${cal.hardDb} dB, input delay ${Math.round(cal.latency * 1000)} ms${stored.tapped ? " (tapped)" : ""}.`
      : `Not calibrated yet (defaults for a guitar at about 12 o'clock gain${cal.latency ? `, input delay ${Math.round(cal.latency * 1000)} ms` : ""}).`;
  }

  /** Open the picked device, or close input when it's "off". */
  async open(): Promise<void> {
    this.close();
    const dev = $<HTMLSelectElement>("audio-in");
    const id = dev.value;
    this.settings.set(DEVICE_KEY, id);
    if (!id) return this.showActive();
    try {
      void this.audio().resume();
      this.listener = new AudioListener();
      this.handle = await this.input.open((s, t) => this.frame(s, t), { deviceId: id === "default" ? undefined : id, channel: this.channel });
      // Labels show only once the browser has allowed an input.
      await this.fillDevices(id);
      if (dev.value !== id) dev.value = id;
      this.handle.setMonitor($<HTMLInputElement>("audio-monitor").checked);
      this.applyCalibration();
      $("audio-status").textContent = `${this.handle.label}, ${this.handle.channels === 2 ? "two channels" : "one channel"}.`;
    } catch (e) {
      this.close();
      dev.value = "";
      $("audio-status").textContent = `Couldn't open the input: ${(e as Error).message}`;
    }
    this.showActive();
  }

  close(): void {
    this.handle?.stop();
    this.handle = null;
    this.listener = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private showActive(): void {
    const on = this.active;
    for (const id of ["audio-channel", "audio-monitor", "calibrate"]) $<HTMLInputElement>(id).disabled = !on;
    $("audio-meter").hidden = !on;
    if (!on) {
      $("audio-status").textContent ||= "Audio input is off: MIDI and the computer keys still play.";
      $("calibration-info").textContent = "";
    }
    if (on) this.meter();
  }

  private meter(): void {
    const draw = () => {
      if (!this.listener) return;
      const lv = this.listener.levelDb;
      const pct = Math.max(0, Math.min(100, ((lv + 70) / 70) * 100));
      $("audio-level").style.width = `${pct}%`;
      $("audio-level").classList.toggle("gate", lv < this.listener.cal.gateDb);
      $("audio-clip").hidden = performance.now() > this.clipUntil;
      this.raf = requestAnimationFrame(draw);
    };
    this.raf = requestAnimationFrame(draw);
  }

  private frame(samples: Float32Array, time: number): void {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (db(peak) > -1) this.clipUntil = performance.now() + 1500;
    if (this.taping) {
      this.taping.t0 ??= time;
      this.taping.chunks.push(samples);
    }
    this.tap?.(samples, time);
    if (!this.listener) return;
    for (const e of this.listener.push(samples, time)) this.emit(e);
  }

  private emit(e: ListenerEvent): void {
    if (e.kind === "on") this.onNote(true, e.note, e.vel, e.time);
    else this.onNote(false, e.note, 0, e.time);
  }

  /** A jam starts: tape the input when "keep the audio" is on. */
  startTape(): void {
    this.lastTape = null;
    this.taping = this.active && $<HTMLInputElement>("keep-audio").checked ? { chunks: [], t0: null } : null;
  }

  /** The jam stopped: let go of a held note, and finish the tape. Returns the time of its first sample. */
  stopTape(now: number): number | null {
    if (this.listener) for (const e of this.listener.flush(now)) this.emit(e);
    const t = this.taping;
    this.taping = null;
    if (!t || t.t0 === null || !t.chunks.length) return null;
    const n = t.chunks.reduce((s, c) => s + c.length, 0);
    const all = new Float32Array(n);
    let o = 0;
    for (const c of t.chunks) {
      all.set(c, o);
      o += c.length;
    }
    this.lastTape = { wav: encodeWav([all], SR), t0: t.t0 };
    return t.t0;
  }

  /** What goes in the session's `input` (null when audio input is off). */
  sessionInput(): SessionInput | null {
    if (!this.handle || !this.listener) return null;
    return {
      kind: "audio",
      device: this.handle.label,
      channel: $<HTMLSelectElement>("audio-channel").value,
      detector: DETECTOR,
      calibration: { ...this.listener.cal },
    };
  }

  // ---------- calibration ----------

  private async calibrate(): Promise<void> {
    const L = this.listener;
    if (!L) return;
    const btn = $<HTMLButtonElement>("calibrate");
    const say = (s: string) => ($("calibration-step").textContent = s);
    btn.disabled = true;
    const listen = async (seconds: number, label: string): Promise<LevelTake & { onsetTimes: number[] }> => {
      const take = { levels: [] as number[], peaks: [] as number[], onsetTimes: [] as number[] };
      const before = L.onsets.length;
      this.tap = () => take.levels.push(L.levelDb);
      for (let s = seconds; s > 0; s--) {
        say(`${label} (${s})`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      this.tap = null;
      for (const o of L.onsets.slice(before)) {
        take.peaks.push(o.peakDb);
        take.onsetTimes.push(o.time);
      }
      return take;
    };
    try {
      // Hear everything while calibrating.
      const base = { ...L.cal, gateDb: -90 };
      L.cal = base;
      const silence = await listen(2, "Stay quiet");
      const soft = await listen(4, "Play softly: single notes and light strums");
      const hard = await listen(4, "Now play hard");
      const cal = calibrateLevels(silence.levels, soft, hard, { ...DEFAULT_CALIBRATION, latency: this.handle?.latency ?? 0 });
      L.cal = { ...cal, gateDb: Math.min(cal.gateDb, -60) };
      say("Timing: play one short note on each click (or wait to skip)");
      const ctx = this.audio();
      const start = ctx.currentTime + 1.5;
      const clicks = Array.from({ length: 8 }, (_, i) => start + i * 0.6);
      for (const t of clicks) click(ctx, t);
      const taps = await listen(Math.ceil(1.5 + 8 * 0.6 + 0.5), "Play on each click");
      const lat = latencyFromTaps(clicks, taps.onsetTimes, this.outputLatency());
      const stored = this.settings.get<Stored>(CAL_KEY) ?? {};
      stored[this.calKey] = lat === null ? { ...cal } : { ...cal, latency: lat, tapped: true };
      this.settings.set(CAL_KEY, stored);
      say(lat === null ? "Done (timing skipped: the browser's input delay is used)." : "Done.");
    } finally {
      this.tap = null;
      this.applyCalibration();
      btn.disabled = !this.active;
    }
  }
}

function click(ctx: AudioContext, t: number): void {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = 1500;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.4, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + 0.06);
}
