// Voice cues under You (v0.5, ADR-0026): a device and channel of their own
// (on a Scarlett Solo the mic on 1, the guitar on 2), and Vosk in the page
// with the cue grammar. The recogniser (Kaldi in WASM, in its own worker)
// and its model load only when voice cues are switched on.

import { BleedGate } from "../core/audio/bleed";
import { SR } from "../core/audio/dsp";
import type { AudioInputHandle, AudioInputPlatform, InputChannel, KeyValueStore } from "../core/platform";
import { VOICE_GRAMMAR, VoiceCues, type VoiceHeard } from "../core/voice";
import type { KaldiRecognizer, Model } from "vosk-browser";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const DEVICE_KEY = "jamstate.voice.device";
const CHANNEL_KEY = "jamstate.voice.channel";
const GATE_KEY = "jamstate.voice.gate";
export const VOICE_MODEL = "models/vosk-model-small-en-us-0.15.tar.gz";
/** Audio goes to the recogniser in 0.1 s chunks. */
const CHUNK = SR / 10;

export class VoicePanel {
  /** A cue heard (it has passed the grammar and the confidence floor). */
  onCue: (h: VoiceHeard) => void = () => {};
  private handle: AudioInputHandle | null = null;
  private model: Promise<Model> | null = null;
  private rec: KaldiRecognizer | null = null;
  private buf = new Float32Array(CHUNK);
  private fill = 0;
  private bandOut: AudioNode | null = null;
  private gate: BleedGate | null = null;
  outputLatency: () => number = () => 0;
  /** Main-thread time spent on the voice input (gate and hand-off; recognition runs in a worker) and the audio it covered. */
  readonly cost = { dsp: 0, audio: 0 };

  constructor(
    private input: AudioInputPlatform,
    private audio: () => AudioContext,
    private settings: KeyValueStore,
  ) {
    const dev = $<HTMLSelectElement>("voice-in");
    if (!input.available()) {
      dev.disabled = true;
      return;
    }
    const ch = $<HTMLSelectElement>("voice-channel");
    ch.value = settings.get<string>(CHANNEL_KEY) ?? "1";
    ch.onchange = () => {
      settings.set(CHANNEL_KEY, ch.value);
      this.handle?.setChannel(this.channel);
    };
    const gate = $<HTMLInputElement>("voice-gate");
    gate.checked = settings.get<boolean>(GATE_KEY) ?? false;
    gate.onchange = () => {
      settings.set(GATE_KEY, gate.checked);
      this.setBand(this.bandOut);
    };
    dev.onchange = () => void this.open();
    void this.fillDevices(settings.get<string>(DEVICE_KEY) ? "off-but-remembered" : null);
  }

  get active(): boolean {
    return !!this.rec;
  }

  private get channel(): InputChannel {
    const v = $<HTMLSelectElement>("voice-channel").value;
    return v === "mix" ? "mix" : v === "2" ? 1 : 0;
  }

  private async fillDevices(keep: string | null): Promise<void> {
    const dev = $<HTMLSelectElement>("voice-in");
    const list = await this.input.devices().catch(() => []);
    const want = keep === "off-but-remembered" ? "" : (keep ?? dev.value);
    dev.replaceChildren(new Option("off", ""), ...list.map((d, i) => new Option(d.label === "input" ? `input ${i + 1}` : d.label, d.id || "default")));
    dev.value = [...dev.options].some((o) => o.value === want) ? want : "";
  }

  private status(text: string): void {
    $("voice-status").textContent = text;
  }

  /** The recogniser's model: fetched once (then from the browser's cache) and kept while the page lives. */
  private loadModel() {
    this.model ??= import("vosk-browser").then(({ createModel }) => createModel(new URL(VOICE_MODEL, document.baseURI).href, -1));
    return this.model;
  }

  /** Open the picked device and start listening for cues, or stop when it's "off". */
  async open(): Promise<void> {
    this.close();
    const dev = $<HTMLSelectElement>("voice-in");
    const id = dev.value;
    this.settings.set(DEVICE_KEY, id);
    if (!id) return this.showActive();
    try {
      void this.audio().resume();
      this.status("Loading the speech model (about 40 MB the first time)…");
      const model = await this.loadModel();
      const rec = new model.KaldiRecognizer(SR, JSON.stringify(VOICE_GRAMMAR));
      rec.setWords(true);
      // A phrase is taken from the partial results once it holds, or from the final result.
      const cues = new VoiceCues();
      rec.on("partialresult", (m) => {
        const h = m.event === "partialresult" ? cues.partial(m.result.partial, performance.now() / 1000) : null;
        if (h) this.onCue(h);
      });
      rec.on("result", (m) => {
        if (m.event !== "result") return;
        const h = cues.final(m.result);
        if (h) this.onCue(h);
        else if (m.result.text && m.result.text !== "[unk]") this.status(`Heard "${m.result.text.replace(/\[unk\]/g, "…")}".`);
      });
      this.handle = await this.input.open((s, _t, ref) => this.frame(s, ref), { deviceId: id === "default" ? undefined : id, channel: this.channel });
      this.rec = rec;
      await this.fillDevices(id);
      if (dev.value !== id) dev.value = id;
      this.setBand(this.bandOut);
      this.status(`Listening on ${this.handle.label}: say "take it down", "one more chorus"… (the cue keys' names).`);
    } catch (e) {
      this.close();
      dev.value = "";
      this.model = null;
      this.status(`Couldn't start voice cues: ${(e as Error).message}`);
    }
    this.showActive();
  }

  close(): void {
    this.handle?.stop();
    this.handle = null;
    this.rec?.remove();
    this.rec = null;
    this.fill = 0;
  }

  private showActive(): void {
    for (const id of ["voice-channel", "voice-gate"]) $<HTMLInputElement>(id).disabled = !this.active;
    if (!this.active) $("voice-status").textContent ||= "";
  }

  /** A jam starts (the band's output) or stops (null): the bleed gate, as for the instrument. */
  setBand(node: AudioNode | null): void {
    this.bandOut = node;
    const on = !!node && $<HTMLInputElement>("voice-gate").checked;
    this.gate = on ? new BleedGate({ delay: this.outputLatency() + (this.handle?.latency ?? 0) + 0.01 }) : null;
    this.handle?.setReference(on ? node : null);
  }

  private frame(samples: Float32Array, ref?: Float32Array): void {
    if (!this.rec) return;
    const t0 = performance.now();
    this.cost.audio += samples.length / SR;
    if (this.gate && ref) samples = this.gate.push(samples, ref);
    for (let i = 0; i < samples.length; ) {
      const n = Math.min(samples.length - i, CHUNK - this.fill);
      this.buf.set(samples.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === CHUNK) {
        this.rec.acceptWaveformFloat(this.buf.slice(), SR);
        this.fill = 0;
      }
    }
    this.cost.dsp += (performance.now() - t0) / 1000;
  }
}
