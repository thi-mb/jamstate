// Record a session file from a scripted pretend player, with no clock. Gives
// the bake-off and tests sessions to replay when no real recordings are at
// hand. The commit/finish order matches the page (bar k+1 is committed
// before bar k ends), so the file replays exactly.

import { loadChart, type ChartJSON } from "./chart";
import { Conductor, ruleLeader } from "./conductor";
import { Engine, type BarPlan } from "./engine";
import { NoteTracker, type PlayedNote } from "./features";
import { getGenre } from "./genres";
import { RuleLeader } from "./rules";
import { SessionRecorder, type SessionFile, type SessionInput } from "./session";
import { parseScript, SimPlayer } from "./simplayer";

export interface SimSessionOptions {
  seed?: number;
  genre?: string;
  title?: string;
  /** Change what the pretend player plays (e.g. audio input's unpitched hits). */
  notes?: (n: PlayedNote) => PlayedNote;
  input?: SessionInput;
}

export function recordSimSession(chartJson: ChartJSON, script: string, opts: SimSessionOptions = {}): SessionFile {
  const c = loadChart(chartJson);
  const genre = getGenre(opts.genre ?? c.genre);
  const seed = opts.seed ?? 11;
  const config = { loop: true };
  const engine = new Engine(c, { config, seed, genre, swing: null, countIn: c.countIn });
  const rec = new SessionRecorder({ chart: chartJson, genre: genre.id, swing: null, band: engine.band, seed, countIn: c.countIn, config, leader: "rules", everyBars: 2, input: opts.input });
  const conductor = new Conductor(engine, ruleLeader(new RuleLeader()), 2);
  const sim = new SimPlayer(seed & 0xffff);
  const modes = parseScript(script);
  const tracker = new NoteTracker();
  const plans: BarPlan[] = [];
  const total = modes.length + c.countIn;
  const commit = () => {
    if (plans.length >= total) return;
    const p = engine.nextBar();
    if (!p) return;
    plans.push(p);
    rec.bar(p);
    if (p.kind === "count_in") return;
    const start = p.bar * c.beatsPerBar;
    for (const played of sim.play(p, modes[Math.min(p.bar - c.countIn, modes.length - 1)], c.beatsPerBar)) {
      const n = opts.notes ? opts.notes(played) : played;
      rec.note(start + n.start, n.note, n.vel);
      rec.note(start + n.start + n.dur, n.note, 0);
      tracker.noteOn(start + n.start, n.note, n.vel);
      tracker.noteOff(start + n.start + n.dur, n.note);
    }
  };
  commit();
  commit();
  for (let k = 0; k < plans.length; k++) {
    conductor.barFinished(plans[k], tracker.bar(k * c.beatsPerBar, c.beatsPerBar));
    commit();
  }
  const f = rec.finish(engine);
  if (opts.title) f.title = opts.title;
  return JSON.parse(JSON.stringify(f));
}
