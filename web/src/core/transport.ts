// Fast layer. Turns committed bars into time-stamped events on one clock
// (AudioContext.currentTime in the page, a fake clock in tests). It never
// computes music: it asks the engine for bar N+1 at the commit deadline in
// bar N and plays what it gets.

import type { BarPlan, Engine } from "./engine";
import type { NoteEvent } from "./types";

export interface Clock {
  /** Seconds, monotonic. */
  now(): number;
}

export interface Sink {
  /** Play `ev` at absolute clock time `time` (seconds); duration in seconds. */
  play(ev: NoteEvent, time: number, duration: number): void;
  /** Silence everything (stop button). */
  panic(): void;
}

export interface TransportEvents {
  /** A bar was committed (prepared ahead of time). */
  onCommit?(plan: BarPlan, startBeat: number): void;
  /** A bar started sounding. */
  onBarStart?(plan: BarPlan): void;
  /** A bar finished sounding. */
  onBarEnd?(plan: BarPlan, startBeat: number): void;
  /** The form ended and the last bar finished. */
  onEnd?(): void;
}

export interface TransportOptions {
  /** Schedule events this far ahead (seconds). */
  lookahead?: number;
  /** Delay before bar 0 after start() (seconds). */
  startDelay?: number;
}

interface Pending {
  time: number;
  dur: number;
  ev: NoteEvent;
}

export class Transport {
  readonly lookahead: number;
  readonly startDelay: number;
  private t0 = 0;
  private running = false;
  private queue: Pending[] = [];
  private committed: { plan: BarPlan; startBeat: number }[] = [];
  private started = 0; // bars whose start has been announced
  private ended = 0; // bars whose end has been announced
  private formDone = false;

  constructor(
    private engine: Engine,
    private clock: Clock,
    private sink: Sink,
    private events: TransportEvents = {},
    opts: TransportOptions = {},
  ) {
    this.lookahead = opts.lookahead ?? 0.1;
    this.startDelay = opts.startDelay ?? 0.15;
  }

  get secondsPerBeat(): number {
    return 60 / this.engine.chart.bpm;
  }

  get bpb(): number {
    return this.engine.chart.beatsPerBar;
  }

  get isRunning(): boolean {
    return this.running;
  }

  timeAt(beat: number): number {
    return this.t0 + beat * this.secondsPerBeat;
  }

  /** Beat position of a clock time (can be negative before bar 0). */
  beatAt(time: number): number {
    return (time - this.t0) / this.secondsPerBeat;
  }

  start(): void {
    this.t0 = this.clock.now() + this.startDelay;
    this.running = true;
    this.commit();
    this.tick();
  }

  stop(): void {
    this.running = false;
    this.queue = [];
    this.sink.panic();
  }

  private commit(): boolean {
    const plan = this.engine.nextBar();
    if (!plan) {
      this.formDone = true;
      return false;
    }
    const startBeat = this.committed.length * this.bpb;
    this.committed.push({ plan, startBeat });
    const spb = this.secondsPerBeat;
    for (const ev of plan.events) this.queue.push({ time: this.timeAt(startBeat + ev.start), dur: ev.dur * spb, ev });
    this.queue.sort((a, b) => a.time - b.time);
    this.events.onCommit?.(plan, startBeat);
    return true;
  }

  /** Add extra events (e.g. a simulated player) at absolute beats. */
  inject(ev: NoteEvent, absBeat: number): void {
    this.queue.push({ time: this.timeAt(absBeat), dur: ev.dur * this.secondsPerBeat, ev });
    this.queue.sort((a, b) => a.time - b.time);
  }

  /** Commit deadline for the bar after `k`: start of k's last beat, minus the lookahead. */
  private deadlineAfter(k: number): number {
    return this.timeAt(k * this.bpb + this.bpb - 1) - this.lookahead;
  }

  /** Call every ~25 ms (from a Worker timer in the page). */
  tick(): void {
    if (!this.running) return;
    const now = this.clock.now();

    while (!this.formDone && now >= this.deadlineAfter(this.committed.length - 1)) if (!this.commit()) break;

    const horizon = now + this.lookahead;
    let i = 0;
    while (i < this.queue.length && this.queue[i].time < horizon) {
      const p = this.queue[i++];
      this.sink.play(p.ev, Math.max(p.time, now), p.dur);
    }
    if (i) this.queue.splice(0, i);

    while (this.started < this.committed.length && now >= this.timeAt(this.committed[this.started].startBeat))
      this.events.onBarStart?.(this.committed[this.started++].plan);

    // Close a bar a little after it ends so late note-offs make it in.
    while (this.ended < this.started && now >= this.timeAt(this.committed[this.ended].startBeat + this.bpb) + 0.03) {
      const c = this.committed[this.ended++];
      this.events.onBarEnd?.(c.plan, c.startBeat);
    }

    if (this.formDone && this.ended === this.committed.length) {
      this.running = false;
      this.events.onEnd?.();
    }
  }
}
