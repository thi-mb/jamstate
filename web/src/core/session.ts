// Session recording and replay. A session file holds everything needed to
// run the same jam again offline: the chart, genre, seed and settings, the
// player's notes with beat stamps, every outside change to the band (moves,
// genre and swing switches) stamped with the bar it arrived in, and a
// summary plus a hash of what the band played in each bar.
//
// Replay has two modes:
// - exact: feed the recorded changes back in; the band must play the same
//   notes (same hashes). This is the regression check for groove changes.
// - with a leader: feed only the player's notes (and the player's own
//   buttons) and let a leader decide again, for scoring leaders (v0.3).
// Format: ADR-0014.

import { bandJSON, defaultBand, parseBand, type Band, type BandJSON } from "./band";
import { loadChart, type ChartJSON } from "./chart";
import { Conductor, type Leader, type LeaderReply } from "./conductor";
import { Engine, type BarPlan, type Control, type GovernorConfig } from "./engine";
import { NoteTracker } from "./features";
import { getGenre } from "./genres";
import { hash } from "./rand";
import { V01_PARTS, type NoteEvent } from "./types";

export const SESSION_FORMAT = "jamstate-session/0.1";

/** What the band did in one bar. */
export interface SessionBar {
  bar: number;
  kind: BarPlan["kind"];
  section: string;
  bar_in_section: number;
  chords: string[];
  intensity: number;
  level: number;
  feel: string;
  genre: string;
  swing: number;
  layers: string[];
  stingers: string[];
  moves: string[];
  /** Hash of every note the band played in the bar. */
  hash: string;
}

/** [beat, note, velocity]; velocity 0 is a note off. Beats count from the start of bar 0 (the count-in, if any). */
export type PlayerEvent = [number, number, number];

export interface SessionFile {
  format: typeof SESSION_FORMAT;
  created: string;
  title: string;
  chart: ChartJSON;
  /** The genre at the start (the chart's, or the one picked in the page). */
  genre: string;
  swing: number | null;
  /** The lineup at the start (v0.2). Missing in older files: drums, bass and keys on their default sounds. */
  band?: BandJSON;
  seed: number;
  count_in: number;
  config: Partial<GovernorConfig>;
  /** Which leader played ("rules", "llm", "none"); informational. */
  leader: string;
  every_bars: number;
  player: PlayerEvent[];
  controls: Control[];
  bars: SessionBar[];
  /** The player's rating of a blind-test jam (see brain/blind.ts). */
  rating?: { stars: number; note?: string; fallback?: boolean };
}

export interface SessionSetup {
  chart: ChartJSON;
  genre: string;
  swing: number | null;
  band: Band;
  seed: number;
  countIn: number;
  config: Partial<GovernorConfig>;
  leader: string;
  everyBars: number;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** A stable hash of a bar's notes (order-independent, rounded to 0.1 ms at 60 bpm). */
export function barHash(events: NoteEvent[]): string {
  const rows = events.map((e) => `${e.part}:${e.note}:${e.vel}:${r4(e.start)}:${r4(e.dur)}`).sort();
  return hash(...rows).toString(16).padStart(8, "0");
}

export function summarizeBar(plan: BarPlan): SessionBar {
  return {
    bar: plan.bar,
    kind: plan.kind,
    section: plan.section,
    bar_in_section: plan.barInSection,
    chords: plan.chords,
    intensity: Math.round(plan.intensity * 1000) / 1000,
    level: plan.level,
    feel: plan.feel,
    genre: plan.genre,
    swing: plan.swing,
    layers: plan.layers,
    stingers: plan.stingers,
    moves: plan.moves.filter((m) => m.status === "applied").map((m) => `${m.label} [${m.source}]`),
    hash: barHash(plan.events.filter((e) => e.part !== "player")),
  };
}

/** Collects a live session. The page calls it from the transport and the input handlers. */
export class SessionRecorder {
  private player: PlayerEvent[] = [];
  private bars: SessionBar[] = [];
  readonly created = new Date().toISOString();

  constructor(readonly setup: SessionSetup) {}

  note(beat: number, note: number, vel: number): void {
    this.player.push([r4(beat), note, vel]);
  }

  bar(plan: BarPlan): void {
    this.bars.push(summarizeBar(plan));
  }

  get barCount(): number {
    return this.bars.length;
  }

  finish(engine: Engine): SessionFile {
    const s = this.setup;
    return {
      format: SESSION_FORMAT,
      created: this.created,
      title: s.chart.title,
      chart: s.chart,
      genre: s.genre,
      swing: s.swing,
      band: bandJSON(s.band),
      seed: s.seed,
      count_in: s.countIn,
      config: s.config,
      leader: s.leader,
      every_bars: s.everyBars,
      player: [...this.player].sort((a, b) => a[0] - b[0]),
      controls: [...engine.controls],
      bars: [...this.bars],
    };
  }
}

/** Throws if the file isn't a session this version can replay. */
export function checkSession(raw: unknown): SessionFile {
  const f = raw as SessionFile;
  if (!f || typeof f !== "object" || f.format !== SESSION_FORMAT) throw new Error(`not a ${SESSION_FORMAT} file`);
  for (const k of ["chart", "player", "controls", "bars"] as const) if (!f[k]) throw new Error(`session has no ${k}`);
  return f;
}

/** The lineup a session started with. */
export function sessionBand(f: SessionFile): Band {
  if (f.band === undefined) return defaultBand(V01_PARTS);
  const errs: string[] = [];
  const band = parseBand(f.band, "band", errs);
  if (errs.length) throw new Error(`session band: ${errs.join("; ")}`);
  return band;
}

/** Build an engine set up like the recorded one. `controls` are replayed at their bars. */
export function sessionEngine(f: SessionFile, controls: Control[]): Engine {
  return new Engine(loadChart(f.chart), {
    seed: f.seed,
    genre: getGenre(f.genre),
    swing: f.swing,
    band: sessionBand(f),
    countIn: f.count_in,
    config: f.config,
    script: controls,
  });
}

export interface ReplayResult {
  bars: SessionBar[];
  plans: BarPlan[];
  /** Bars whose notes differ from the recording (exact mode only). */
  mismatches: { bar: number; expected: string; got: string }[];
  /** Leader turns taken (leader mode only). */
  decisions: number;
}

/** Sources of moves that came from the player rather than a leader. */
export const PLAYER_SOURCES = new Set(["you", "cue"]);

/**
 * Replay a session offline. Without a leader the recorded changes are fed
 * back in and every bar is compared with the recording. With a leader, only
 * the player's notes and the player's own moves are kept, and the leader
 * decides again; it is asked at the same points as live, and its answer
 * lands on the next bar not yet committed (one bar later than the rule
 * leader live, about the same as the LLM).
 */
export async function replaySession(f: SessionFile, opts: { leader?: Leader; everyBars?: number; bars?: number } = {}): Promise<ReplayResult> {
  const total = opts.bars ?? f.bars.length;
  const exact = !opts.leader;
  const controls = exact ? f.controls : f.controls.filter((c) => c.kind !== "moves" || PLAYER_SOURCES.has(c.source));
  const engine = sessionEngine(f, controls);
  const bpb = engine.chart.beatsPerBar;
  const plans: BarPlan[] = [];
  let decisions = 0;
  let pending: Promise<unknown> | null = null;
  const leader: Leader | null = opts.leader
    ? {
        decide: (ctx) => {
          decisions++;
          const r = opts.leader!.decide(ctx);
          if (r instanceof Promise) pending = r.catch(() => null);
          return r as Promise<LeaderReply> | LeaderReply;
        },
      }
    : null;
  const conductor = new Conductor(engine, leader, opts.everyBars ?? f.every_bars);
  const tracker = new NoteTracker();
  let pi = 0;
  const commit = () => {
    if (plans.length >= total) return;
    const p = engine.nextBar();
    if (p) plans.push(p);
  };

  // Live, bar k+1 is committed before bar k ends; keep that one-bar lead.
  commit();
  commit();
  for (let k = 0; k < plans.length; k++) {
    const end = (k + 1) * bpb;
    for (; pi < f.player.length && f.player[pi][0] < end; pi++) {
      const [beat, note, vel] = f.player[pi];
      if (vel > 0) tracker.noteOn(beat, note, vel);
      else tracker.noteOff(beat, note);
    }
    conductor.barFinished(plans[k], tracker.bar(k * bpb, bpb));
    if (pending) {
      await pending;
      await Promise.resolve();
      pending = null;
    }
    commit();
  }

  const bars = plans.map(summarizeBar);
  const mismatches = exact
    ? bars.flatMap((b, i) => (f.bars[i] && f.bars[i].hash !== b.hash ? [{ bar: b.bar, expected: f.bars[i].hash, got: b.hash }] : []))
    : [];
  return { bars, plans, mismatches, decisions };
}
