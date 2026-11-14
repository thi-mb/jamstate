// The audio input worklet (v0.5, ADR-0023): picks a channel of the
// interface (on a Scarlett Solo, 1 is the mic and 2 the instrument),
// resamples it to 16 kHz and posts blocks with the audio-clock time of their
// first sample. The detection runs on the main thread (core/audio). Its one
// output carries the picked channel at the context rate, for "hear input".
//
// Input 1, when connected, is the band's own mix (the bleed gate's
// reference, ADR-0025): resampled the same way and posted beside it.

import { Resampler, SR } from "../core/audio/dsp";

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

/** Samples per message at 16 kHz (16 ms). */
const CHUNK = 256;

export type Channel = 0 | 1 | "mix";

class InputProcessor extends AudioWorkletProcessor {
  private channel: Channel = "mix";
  private rs = new Resampler(sampleRate, SR);
  private rsRef = new Resampler(sampleRate, SR);
  private acc = new Float32Array(CHUNK);
  private accRef = new Float32Array(CHUNK);
  private n = 0;
  private nRef = 0;
  /** Output samples posted so far and the time of the first. */
  private sent = 0;
  private t0 = -1;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ channel?: Channel }>) => {
      if (e.data.channel !== undefined) this.channel = e.data.channel;
    };
  }

  private pick(inp: Float32Array[]): Float32Array | null {
    if (!inp?.length) return null;
    if (this.channel === "mix" || inp.length === 1) {
      if (inp.length === 1) return inp[0];
      const m = new Float32Array(inp[0].length);
      for (const ch of inp) for (let i = 0; i < m.length; i++) m[i] += ch[i] / inp.length;
      return m;
    }
    return inp[Math.min(this.channel, inp.length - 1)];
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const mono = this.pick(inputs[0]);
    if (!mono) return true;
    if (this.t0 < 0) this.t0 = currentTime;
    for (const ch of outputs[0] ?? []) ch.set(mono);
    const ref = inputs[1]?.length ? this.pick(inputs[1]) : null;
    const y = this.rs.process(mono);
    const yr = ref ? this.rsRef.process(ref) : null;
    for (let i = 0; i < y.length; i++) {
      this.acc[this.n++] = y[i];
      if (yr && i < yr.length) this.accRef[this.nRef++] = yr[i];
      if (this.n === CHUNK) {
        const time = this.t0 + this.sent / SR;
        const msg: { samples: Float32Array; time: number; ref?: Float32Array } = { samples: this.acc.slice(), time };
        if (yr) msg.ref = this.accRef.slice(0, CHUNK);
        this.port.postMessage(msg);
        this.sent += CHUNK;
        this.n = 0;
        this.nRef = 0;
      }
    }
    return true;
  }
}

registerProcessor("jamstate-input", InputProcessor);
