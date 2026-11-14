// The pretend player as a guitar (v0.5 row 5): the notes it plays each bar
// are rendered as plucks and heard through the audio listener, as the page
// hears a guitar, so the eval can run every scenario on audio input and
// compare it with MIDI. Notes come out in beats with the listener's own
// delay: a note detected after its bar was summed counts in the next bar,
// as it does live.

import type { Chart } from "../chart";
import type { BarPlan } from "../engine";
import { chordView } from "../fretboard";
import { AudioListener, type ListenerEvent } from "./listener";
import { renderGuitar, type PluckNote } from "./pluck";
import { SR } from "./dsp";

/** Seconds a bar's notes are rendered past its end (ringing strings), and before its start (notes pushed ahead of the beat). */
const TAIL = 3;
const LEAD = 0.5;

export class GuitarEar {
  readonly listener = new AudioListener();
  private audio = new Float32Array(SR * 60);
  /** Samples heard so far. */
  private heard = 0;
  /** Each committed bar: its start in the take (seconds; the first starts LEAD in) and in beats, and its tempo. */
  private bars: { sec: number; beat: number; bpm: number; plan: BarPlan }[] = [];

  constructor(
    private chart: Chart,
    private seed = 1,
  ) {
    this.listener.chordPrior = (t) => {
      const k = this.barAt(t);
      return k < 0 ? null : chordView(chart, this.bars[k].plan, this.beatAt(t) - this.bars[k].beat, this.bars[k + 1]?.plan);
    };
  }

  /** A bar is committed with the notes the player plays in it (beats from the bar's start). */
  play(plan: BarPlan, notes: { start: number; dur: number; note: number; vel: number }[]): void {
    const bpb = this.chart.beatsPerBar;
    const last = this.bars.at(-1);
    const sec = last ? last.sec + (bpb * 60) / last.bpm : LEAD;
    this.bars.push({ sec, beat: plan.bar * bpb, bpm: plan.bpm, plan });
    const spb = 60 / plan.bpm;
    const plucks: PluckNote[] = notes.map((n) => {
      let note = n.note;
      while (note > 88) note -= 12;
      while (note >= 0 && note < 40) note += 12;
      return { time: LEAD + n.start * spb, note: note < 0 ? 52 : note, vel: n.vel, dur: Math.max(0.05, n.dur * spb), muted: note < 0 };
    });
    const x = renderGuitar(plucks, LEAD + bpb * spb + TAIL, { seed: this.seed * 1000 + plan.bar, noiseDb: -72 });
    const at = Math.round((sec - LEAD) * SR);
    if (at + x.length > this.audio.length) {
      const grown = new Float32Array(Math.max(this.audio.length * 2, at + x.length));
      grown.set(this.audio);
      this.audio = grown;
    }
    for (let i = 0; i < x.length; i++) this.audio[at + i] += x[i];
  }

  /** Listen up to the end of bar `k`: what the listener heard, with times in beats. */
  hearUntilEndOf(k: number): (ListenerEvent & { beat: number })[] {
    const b = this.bars[k];
    if (!b) return [];
    const end = Math.round((b.sec + (this.chart.beatsPerBar * 60) / b.bpm) * SR);
    const out: (ListenerEvent & { beat: number })[] = [];
    for (; this.heard + 256 <= end; this.heard += 256) {
      for (const e of this.listener.push(this.audio.subarray(this.heard, this.heard + 256), this.heard / SR)) out.push({ ...e, beat: this.beatAt(e.time) });
    }
    return out;
  }

  private barAt(t: number): number {
    for (let k = this.bars.length - 1; k >= 0; k--) if (this.bars[k].sec <= t) return k;
    return -1;
  }

  private beatAt(t: number): number {
    const k = Math.max(0, this.barAt(t));
    const b = this.bars[k];
    return b ? b.beat + ((t - b.sec) * b.bpm) / 60 : 0;
  }
}
