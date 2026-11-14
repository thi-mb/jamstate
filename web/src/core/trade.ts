// Trading fours (v0.4, ADR-0022). With trading on, turns are counted from
// the top of each section in the genre's trade length (4 bars by default).
// When the player plays in their turn, the band takes the next one: a
// soloist from the lineup (the genre's list, in rotation) answers the
// player's phrase. When the player comes back in early, the soloist stops
// on the next bar the band hasn't committed yet. A player who sits out their
// turn gets the band comping and waiting, not another solo.
//
// The trader listens in the page (it needs the player's notes) and starts
// and stops turns through the engine, which records them, so a session
// replays without it.

import type { BarPlan, Engine } from "./engine";
import type { PlayedNote } from "./features";
import type { MotifNote } from "./solo";
import type { Part } from "./types";

/** Notes a bar needs to count as the player playing (a stray note or a pickup doesn't). */
const PLAYED = 2;

export interface TradeState {
  /** Whose turn the bar just played was. */
  turn: "player" | "band";
  /** Who takes the band's turns now (the next one, during the player's). */
  soloist: Part | null;
  /** Bars to the end of the turn after the bar just played. */
  bars_left: number;
}

export class Trader {
  /** The player's notes in the current turn, by bar (absolute bars). */
  private heard = new Map<number, PlayedNote[]>();
  private turns = 0;
  /** The player's turn that the band last answered (its first bar), so one player turn gets one answer. */
  private answered = -1;

  constructor(private engine: Engine) {}

  private get bars(): number {
    return this.engine.genre.leading.trade.bars;
  }

  /** Who solos next: the genre's soloists in the lineup, in rotation. */
  soloist(): Part | null {
    const lineup = this.engine.lineup;
    const list = this.engine.genre.leading.trade.soloists.filter((p) => lineup.includes(p));
    return list.length ? list[this.turns % list.length] : null;
  }

  /** What the leader hears about the trade, after `plan`; null when trading is off. */
  state(plan: BarPlan): TradeState | null {
    if (!this.engine.trading) return null;
    const pos = plan.barInSection % this.bars;
    const band = !!plan.solo;
    return { turn: band ? "band" : "player", soloist: band ? plan.solo!.part : this.soloist(), bars_left: this.bars - 1 - pos };
  }

  /** Call when a bar has finished, with what the player played in it. */
  barFinished(plan: BarPlan, notes: PlayedNote[]): void {
    const e = this.engine;
    if (!e.trading || plan.kind !== "play") {
      this.heard.clear();
      return;
    }
    const bpb = e.chart.beatsPerBar;
    this.heard.set(plan.bar, notes);
    for (const b of this.heard.keys()) if (b < plan.bar - 2 * this.bars) this.heard.delete(b);
    const played = (n: PlayedNote[]) => n.filter((x) => x.start >= 0 && x.start < bpb).length >= PLAYED;

    // The band's turn: the player came back in early, so hand it back.
    const solo = e.soloAt(plan.bar);
    if (solo) {
      const lastOfTurn = plan.bar === solo.from + solo.bars - 1;
      // Notes in the turn's last bar are the player's pickup into their own turn.
      if (!lastOfTurn && played(notes) && e.soloAt(plan.bar + 1)) e.setSolo(null);
      return;
    }

    // The bar after next is the first we can still change. Is it the start of a turn?
    const next = e.upcoming();
    if (!next || next.barInSection % this.bars !== 0 || next.sectionBars - next.barInSection < 2) return;
    const from = e.currentBar + 1;
    // The player's turn: the bars before `from` back to the turn's start (the last one not heard yet).
    const turnStart = from - this.bars;
    if (turnStart <= this.answered) return;
    const theirs: MotifNote[] = [];
    let playedBars = 0;
    for (let b = turnStart; b < from; b++) {
      const ns = this.heard.get(b);
      if (!ns) continue;
      if (played(ns)) playedBars++;
      for (const n of ns) if (n.start >= 0 && n.start < bpb) theirs.push({ start: (b - turnStart) * bpb + n.start, dur: n.dur, note: n.note, vel: n.vel });
    }
    // A turn sat out (or a bar or two of noodling) isn't a phrase to answer: keep comping.
    if (playedBars < Math.min(2, this.bars - 1)) return;
    const part = this.soloist();
    if (!part) return;
    this.answered = turnStart;
    this.turns++;
    e.setSolo({ part, from, bars: Math.min(this.bars, next.sectionBars - next.barInSection), motif: theirs });
  }
}
