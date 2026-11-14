// The leader eval's scenarios, as data. docs/eval/scenarios.md is the spec;
// change the rules there first, then here.
//
// A check reads what the band did (the bar plans of a run): the governor's
// intensity target, who played, the feel, the section, stingers, and the
// moves that landed. Most checks are about the band's state; checks about
// "the leader raised / lowered / added" look only at moves a leader made
// (not the chart's own nudges, the governor's automatic fills or the
// player's cues).

import type { ChartJSON } from "../chart";
import type { BarPlan, Cue, MoveRecord } from "../engine";
import { getGenre } from "../genres";
import { moveMatches, type Personality } from "../leading";
import { PLAYER_SOURCES } from "../session";
import { parseScript, type SimMode } from "../simplayer";
import type { Part } from "../types";

export type CheckKind = "must" | "must_not" | "stretch";
export type ScenarioGroup = "follow" | "phrasing" | "harmony_rhythm" | "tempo" | "cues" | "arc" | "personality" | "genre" | "trading";
/** The groups v0.4 added (leading): reported apart from the v0.3 set. */
export const LEADING_GROUPS: ScenarioGroup[] = ["arc", "personality", "genre", "trading"];

export interface Check {
  kind: CheckKind;
  text: string;
  test(v: RunView): boolean;
  /** A number worth reporting next to the check (e.g. the target at the check bar), for tuning thresholds. */
  observe?(v: RunView): number;
}

export interface ScenarioRun {
  modes: SimMode[];
  bars: number;
  checks: Check[];
  /** Follow my tempo on for this run. */
  followTempo?: boolean;
  /** Cues the player gives, pressed during `bar` (before the next bar is committed). */
  cues?: { bar: number; cue: Cue }[];
  /** The leader's personality (v0.4; supportive when left out). */
  personality?: Personality;
  /** Trading fours on from the start (v0.4). */
  trade?: boolean;
  /** Play the song in another genre (v0.4's genre-taste scenarios). */
  genre?: string;
}

export interface Song {
  id: string;
  chart: ChartJSON;
  genre: string;
}

export interface Scenario {
  id: string;
  title: string;
  group: ScenarioGroup;
  /** Song ids this scenario runs on (default: all). */
  songs?: string[];
  build(song: SongShape): ScenarioRun;
}

/** Where each section of the form starts, in song bars. */
export interface SectionSpan {
  name: string;
  formPos: number;
  start: number;
  bars: number;
}

export interface SongShape {
  id: string;
  genre: string;
  bpm: number;
  phraseBars: number;
  spans: SectionSpan[];
}

export function songShape(song: Song): SongShape {
  const c = song.chart;
  const len = new Map(c.sections.map((s) => [s.name, s.bars]));
  let at = 0;
  const spans = c.form.map((name, formPos) => {
    const s = { name, formPos, start: at, bars: len.get(name)! };
    at += s.bars;
    return s;
  });
  return { id: song.id, genre: c.genre ?? song.genre, bpm: c.bpm, phraseBars: c.phrase_bars ?? 4, spans };
}

/** Read-only helpers over a run's bar plans. */
export class RunView {
  constructor(
    readonly plans: BarPlan[],
    readonly chartBpm: number,
  ) {}

  at(bar: number): BarPlan {
    const p = this.plans[bar];
    if (!p) throw new Error(`the run has no bar ${bar}`);
    return p;
  }
  target(bar: number): number {
    return this.at(bar).target;
  }
  /** The band's tempo at a bar. */
  tempo(bar: number): number {
    return this.at(bar).bpm;
  }
  playing(bar: number, part: Part): boolean {
    const p = this.at(bar);
    return !p.lineup.includes(part) || p.layers.includes(part);
  }
  bars(a: number, b: number): number[] {
    const out: number[] = [];
    for (let i = a; i <= Math.min(b, this.plans.length - 1); i++) out.push(i);
    return out;
  }
  /** Moves a leader made that landed on bars a..b, with the bar they landed on. */
  leaderMoves(a: number, b: number): { bar: number; m: MoveRecord }[] {
    return this.bars(a, b).flatMap((i) =>
      this.plans[i].moves.filter((m) => m.status === "applied" && m.source !== "governor" && !PLAYER_SOURCES.has(m.source)).map((m) => ({ bar: i, m })),
    );
  }
  /** Leader intensity changes in a..b as (from, to), "from" being the target before the bar. */
  intensityChanges(a: number, b: number): { bar: number; from: number; to: number }[] {
    return this.leaderMoves(a, b)
      .filter(({ m }) => m.move.move === "set_intensity")
      .map(({ bar, m }) => ({ bar, from: bar > 0 ? this.target(bar - 1) : this.target(0), to: (m.move as { value: number }).value }));
  }
}

// ---------- check builders ----------

const STEP = 0.05;
const fmt = (x: number) => x.toFixed(2).replace(/\.?0+$/, "");

const targetAtMost = (bar: number, x: number): Check => ({
  kind: "must",
  text: `by bar ${bar}, target ≤ ${fmt(x)}`,
  test: (v) => v.target(bar) <= x + 1e-9,
  observe: (v) => v.target(bar),
});
const targetAtLeast = (bar: number, x: number): Check => ({
  kind: "must",
  text: `by bar ${bar}, target ≥ ${fmt(x)}`,
  test: (v) => v.target(bar) >= x - 1e-9,
  observe: (v) => v.target(bar),
});
const targetRisesBy = (bar: number, from: number, dx: number, kind: CheckKind = "must"): Check => ({
  kind,
  text: `by bar ${bar}, target ≥ target at bar ${from} + ${fmt(dx)}`,
  test: (v) => v.target(bar) >= v.target(from) + dx - 1e-9,
  observe: (v) => v.target(bar) - v.target(from),
});
const targetFallsBy = (bar: number, from: number, dx: number): Check => ({
  kind: "must",
  text: `by bar ${bar}, target ≤ target at bar ${from} − ${fmt(dx)}`,
  test: (v) => v.target(bar) <= v.target(from) - dx + 1e-9,
  observe: (v) => v.target(bar) - v.target(from),
});
const noRaise = (a: number, b: number): Check => ({
  kind: "must_not",
  text: `bars ${a}–${b}, the leader raises the target`,
  test: (v) => !v.intensityChanges(a, b).some((c) => c.to > c.from + STEP),
});
const noLower = (a: number, b: number): Check => ({
  kind: "must_not",
  text: `bars ${a}–${b}, the leader lowers the target`,
  test: (v) => !v.intensityChanges(a, b).some((c) => c.to < c.from - STEP),
});
const noRaiseAbove = (a: number, b: number, ref: number, dx: number): Check => ({
  kind: "must_not",
  text: `bars ${a}–${b}, the leader raises the target more than ${fmt(dx)} above bar ${ref}'s`,
  test: (v) => !v.intensityChanges(a, b).some((c) => c.to > v.target(ref) + dx + 1e-9),
});
const noMove = (a: number, b: number, what: string, pred: (m: MoveRecord) => boolean): Check => ({
  kind: "must_not",
  text: `bars ${a}–${b}, ${what}`,
  test: (v) => !v.leaderMoves(a, b).some(({ m }) => pred(m)),
});
const isMove = (kind: string, arg?: Partial<Record<string, string>>) => (m: MoveRecord) =>
  m.move.move === kind && Object.entries(arg ?? {}).every(([k, val]) => (m.move as unknown as Record<string, string>)[k] === val);
const noLayerAdded = (a: number, b: number) => noMove(a, b, "the leader adds a layer", isMove("add_layer"));
const noLayerDropped = (a: number, b: number) => noMove(a, b, "the leader drops a layer", isMove("drop_layer"));
const noRiser = (a: number, b: number) => noMove(a, b, "the leader fires a riser", isMove("fire_stinger", { stinger: "riser" }));
const noStinger = (a: number, b: number) => noMove(a, b, "the leader fires a stinger", isMove("fire_stinger"));
const noFeelChange = (a: number, b: number) => noMove(a, b, "the leader changes the feel", isMove("change_feel"));
const noFeel = (a: number, b: number, feel: string) => noMove(a, b, `the leader goes to ${feel.replace("_", " ")}`, isMove("change_feel", { feel }));
const noJump = (a: number, b: number) => noMove(a, b, "the leader jumps to another section", isMove("jump_to_section"));
const partsIn = (a: number, b: number, parts: Part[], kind: CheckKind = "must"): Check => ({
  kind,
  text: `bars ${a}–${b}, ${parts.join(" and ")} stay in`,
  test: (v) => v.bars(a, b).every((i) => parts.every((p) => v.playing(i, p))),
});
const targetStaysAtLeast = (a: number, b: number, x: number): Check => ({
  kind: "must",
  text: `bars ${a}–${b}, target stays ≥ ${fmt(x)}`,
  test: (v) => v.bars(a, b).every((i) => v.target(i) >= x - 1e-9),
  observe: (v) => Math.min(...v.bars(a, b).map((i) => v.target(i))),
});
const tempoHolds = (a: number, b: number): Check => ({
  kind: "must",
  text: `bars ${a}–${b}, tempo stays at the chart tempo`,
  test: (v) => v.bars(a, b).every((i) => Math.abs(v.tempo(i) - v.chartBpm) < 1e-6),
  observe: (v) => Math.max(...v.bars(a, b).map((i) => Math.abs(v.tempo(i) / v.chartBpm - 1))),
});

/** Follow my tempo: moved the player's way by `bar`, within ±5%, at most 1% a bar. */
const followChecks = (bar: number, way: "up" | "down"): Check[] => [
  {
    kind: "must",
    text: `by bar ${bar}, tempo ${way === "up" ? "above" : "below"} the chart tempo`,
    test: (v) => (way === "up" ? v.tempo(bar) > v.chartBpm : v.tempo(bar) < v.chartBpm),
    observe: (v) => v.tempo(bar) / v.chartBpm - 1,
  },
  {
    kind: "must",
    text: "every bar within 5% of the chart tempo",
    test: (v) => v.bars(0, bar).every((i) => Math.abs(v.tempo(i) / v.chartBpm - 1) <= 0.05 + 1e-9),
  },
  {
    kind: "must",
    text: "tempo changes by at most 1% from one bar to the next",
    test: (v) => v.bars(1, bar).every((i) => Math.abs(v.tempo(i) / v.tempo(i - 1) - 1) <= 0.01 + 1e-9),
  },
];

/** "medium:4, sparse:8" → modes. */
const script = (s: string) => parseScript(s.replace(/\s+/g, ""));
const repeat = (s: string, times: number) => Array(times).fill(s).join(",");

/** The first change into a different section that has at least 8 bars of the previous section before it, from bar 12. */
function buildPoint(s: SongShape): { bar: number; into: string } {
  for (let i = 1; i < s.spans.length; i++) {
    const prev = s.spans[i - 1];
    const cur = s.spans[i];
    if (cur.name !== prev.name && prev.bars >= 8 && cur.start >= 12) return { bar: cur.start, into: cur.name };
  }
  throw new Error(`${s.id}: no section change to build into`);
}

const firstSolo = (s: SongShape) => s.spans.find((x) => x.name === "solo")!;
/** The first solo section followed by something else (the head coming back in). */
const soloBeforeHead = (s: SongShape) => s.spans.find((x, i) => x.name === "solo" && s.spans[i + 1] && s.spans[i + 1].name !== "solo")!;

const SOLO_SONGS = ["blues-in-a", "late-set"];

// ---------- cues (v0.3) ----------

/** Pressed during bar 9, inside a phrase; "next bar" is 10, "next phrase" 12. */
const CUE_BAR = 9;
const cueAt = (cue: Cue, bar = CUE_BAR) => [{ bar, cue }];
const targetNeverRises = (a: number, b: number): Check => ({
  kind: "must_not",
  text: `bars ${a}–${b}, target goes up`,
  test: (v) => !v.bars(a, b).some((i) => v.target(i) > v.target(i - 1) + 1e-9),
});
const targetNeverFalls = (a: number, b: number): Check => ({
  kind: "must_not",
  text: `bars ${a}–${b}, target goes down`,
  test: (v) => !v.bars(a, b).some((i) => v.target(i) < v.target(i - 1) - 1e-9),
});
const PERC: Part[] = ["drums", "percussion"];
/** A section longer than a phrase, from bar 8 on, so the next phrase isn't the next section anyway. */
const longSection = (s: SongShape) => {
  const span = s.spans.find((x) => x.start >= 8 && x.bars > s.phraseBars);
  if (!span) throw new Error(`${s.id}: no section longer than a phrase`);
  return span;
};

const CUE_SCENARIOS: Scenario[] = [
  {
    id: "C1",
    title: "Take it down",
    group: "cues",
    build: () => ({
      modes: script("busy:16"),
      bars: 16,
      cues: cueAt("take_down"),
      checks: [targetFallsBy(10, 9, 0.2), targetNeverRises(10, 14)],
    }),
  },
  {
    id: "C2",
    title: "Build",
    group: "cues",
    build: () => ({
      modes: script("sparse:16"),
      bars: 16,
      cues: cueAt("build"),
      checks: [
        targetRisesBy(10, 9, 0.2),
        { kind: "must", text: "a riser or fill on bar 10 or 11", test: (v) => [10, 11].some((i) => v.at(i).stingers.some((x) => x === "riser" || x === "fill")) },
        targetNeverFalls(10, 14),
      ],
    }),
  },
  {
    id: "C3",
    title: "Drums/perc break",
    group: "cues",
    build: () => ({
      modes: script("medium:16"),
      bars: 16,
      cues: cueAt("drums_break"),
      checks: [
        { kind: "must", text: "bars 10–11, drums and percussion out, the rest of the band in", test: (v) => v.bars(10, 11).every((i) => !v.at(i).layers.some((p) => PERC.includes(p)) && v.at(i).layers.length > 0) },
        { kind: "must", text: "bar 12, drums back", test: (v) => v.at(12).layers.includes("drums") },
      ],
    }),
  },
  {
    id: "C4",
    title: "Drums/perc only",
    group: "cues",
    build: () => ({
      modes: script("medium:16"),
      bars: 16,
      cues: cueAt("drums_only"),
      checks: [
        { kind: "must", text: "bars 10–11, only drums and percussion", test: (v) => v.bars(10, 11).every((i) => v.at(i).layers.includes("drums") && v.at(i).layers.every((p) => PERC.includes(p))) },
        { kind: "must", text: "bar 12, the bass back", test: (v) => v.at(12).layers.includes("bass") },
      ],
    }),
  },
  {
    id: "C5",
    title: "Next section",
    group: "cues",
    build: (s) => {
      const span = longSection(s);
      const land = span.start + s.phraseBars;
      return {
        modes: script(`medium:${land + 4}`),
        bars: land + 4,
        cues: cueAt("next_section", span.start + 1),
        checks: [
          {
            kind: "must",
            text: `bar ${land} is the first bar of the section after the ${span.name}`,
            test: (v) => v.at(land).barInSection === 0 && v.at(land).formPos === (span.formPos + 1) % s.spans.length,
          },
        ],
      };
    },
  },
  {
    id: "C6",
    title: "One more",
    group: "cues",
    build: (s) => {
      const span = longSection(s);
      const end = span.start + span.bars;
      return {
        modes: script(`medium:${end + span.bars + 2}`),
        bars: end + span.bars + 2,
        cues: cueAt("one_more", end - 2),
        checks: [
          { kind: "must", text: `bars ${end}–${end + span.bars - 1}, the ${span.name} again`, test: (v) => v.bars(end, end + span.bars - 1).every((i) => v.at(i).formPos === span.formPos) },
          { kind: "must", text: `bar ${end + span.bars}, the form goes on`, test: (v) => v.at(end + span.bars).formPos === (span.formPos + 1) % s.spans.length && v.at(end + span.bars).barInSection === 0 },
        ],
      };
    },
  },
  {
    id: "C7",
    title: "End song",
    group: "cues",
    build: () => ({
      modes: script("medium:16"),
      bars: 16,
      cues: cueAt("end_song"),
      checks: [{ kind: "must", text: "bar 11 is the ending and the song stops there", test: (v) => v.plans.length === 12 && v.at(11).kind === "ending" }],
    }),
  },
];

// ---------- leading (v0.4) ----------

const meanTarget = (v: RunView, a: number, b: number) => {
  const bs = v.bars(a, b);
  return bs.reduce((s, i) => s + v.target(i), 0) / Math.max(1, bs.length);
};
/** Parts that played in most bars of a..b. */
const partsOf = (v: RunView, a: number, b: number): Part[] => {
  const bs = v.bars(a, b);
  const count = new Map<Part, number>();
  for (const i of bs) for (const p of v.at(i).layers) count.set(p, (count.get(p) ?? 0) + 1);
  return [...count].filter(([, n]) => n * 2 > bs.length).map(([p]) => p).sort();
};
const sameParts = (x: Part[], y: Part[]) => x.length === y.length && x.every((p, i) => p === y[i]);

/** The first section the form plays twice in a row of visits worth comparing: a chorus or a solo. */
function repeatedSection(s: SongShape): [SectionSpan, SectionSpan] {
  for (const name of ["chorus", "solo"]) {
    const visits = s.spans.filter((x) => x.name === name);
    if (visits.length >= 2) return [visits[0], visits[1]];
  }
  throw new Error(`${s.id}: no chorus or solo played twice`);
}

/** Moves a leader made in a..b that the genre avoids. */
const avoided = (v: RunView, a: number, b: number, genre: string) =>
  v.leaderMoves(a, b).filter(({ m }) => getGenre(genre).leading.avoid.some((t) => moveMatches(m.move as never, t)));

const layerMoves = (v: RunView) => v.leaderMoves(0, VARIED_BARS - 1).filter(({ m }) => m.move.move === "add_layer" || m.move.move === "drop_layer").length;
const feelMoves = (v: RunView) => v.leaderMoves(0, VARIED_BARS - 1).filter(({ m }) => m.move.move === "change_feel").length;

const marks = (v: RunView) => v.leaderMoves(0, VARIED_BARS - 1).filter(({ m }) => isMove("fire_stinger", { stinger: "crash" })(m) || isMove("fire_stinger", { stinger: "riser" })(m)).length;

/** One varied player for the personality and genre runs: 40 bars of everything. */
const VARIED = "medium:4, busy:8, sparse:8, medium:8, held:4, busy:8";
const VARIED_BARS = 41;
const followsVaried: Check[] = [targetAtLeast(12, 0.5), targetAtMost(20, 0.45), targetAtLeast(40, 0.5)];
const leaderMoveCount = (v: RunView) => v.leaderMoves(0, VARIED_BARS - 1).length;

const personalityRun = (personality: Personality, extra: Check[]): ScenarioRun => ({
  modes: script(VARIED),
  bars: VARIED_BARS,
  personality,
  checks: [
    ...followsVaried,
    ...extra,
    { kind: "stretch", text: "leader moves (count)", test: () => true, observe: leaderMoveCount },
  ],
});

/** Trading: the band's turns (4 bars) after each of the player's, in the first 32 bars. */
const TRADE_BARS = 32;
const tradeModes = () => script(`${repeat("busy:4, silent:4", 4)}, busy:1`);
const bandTurns = [4, 12, 20, 28];
const playerTurns = [0, 8, 16, 24];
const soloIn = (v: RunView, bar: number) => !!v.at(bar).solo;
const groove = (v: RunView, i: number) => (v.playing(i, "drums") && v.playing(i, "bass")) || v.at(i).solo?.part === "drums";

const LEADING_SCENARIOS: Scenario[] = [
  {
    id: "A1",
    title: "Second time through",
    group: "arc",
    build: (s) => {
      const [one, two] = repeatedSection(s);
      const end = two.start + two.bars;
      // The same steady playing both times: what's different is the band's plan.
      const modes: SimMode[] = script(`medium:${end}`);
      // Judge from the visit's third bar: the plan lands in its first bars.
      const a = [one.start + 2, one.start + one.bars - 1] as const;
      const b = [two.start + 2, end - 1] as const;
      const style = getGenre(s.genre).leading.arc;
      const differs: Check =
        style === "build"
          ? { kind: "must", text: `${two.name} 2 sits at least 0.05 above ${one.name} 1 (build)`, test: (v) => meanTarget(v, ...b) >= meanTarget(v, ...a) + 0.05 - 1e-9, observe: (v) => meanTarget(v, ...b) - meanTarget(v, ...a) }
          : style === "dynamic"
            ? { kind: "must", text: `${two.name} 2 differs from ${one.name} 1 by 0.08 or in who plays (dynamic)`, test: (v) => Math.abs(meanTarget(v, ...b) - meanTarget(v, ...a)) >= 0.08 - 1e-9 || !sameParts(partsOf(v, ...a), partsOf(v, ...b)), observe: (v) => meanTarget(v, ...b) - meanTarget(v, ...a) }
            : { kind: "must", text: `${two.name} 2 has another texture than ${one.name} 1 at about the same level (locked)`, test: (v) => !sameParts(partsOf(v, ...a), partsOf(v, ...b)) && Math.abs(meanTarget(v, ...b) - meanTarget(v, ...a)) <= 0.15 + 1e-9, observe: (v) => meanTarget(v, ...b) - meanTarget(v, ...a) };
      return {
        modes,
        bars: end,
        checks: [
          differs,
          { kind: "must", text: `${two.name} 2 still follows the player: target 0.35–0.8`, test: (v) => meanTarget(v, ...b) >= 0.35 - 1e-9 && meanTarget(v, ...b) <= 0.8 + 1e-9, observe: (v) => meanTarget(v, ...b) },
          partsIn(two.start, end - 1, ["drums", "bass"]),
        ],
      };
    },
  },
  {
    id: "P1",
    title: "Steady",
    group: "personality",
    build: () => personalityRun("steady", [{ kind: "must", text: "at most 7 leader moves over 40 bars", test: (v) => leaderMoveCount(v) <= 7, observe: leaderMoveCount }]),
  },
  {
    id: "P2",
    title: "Supportive",
    group: "personality",
    build: () => personalityRun("supportive", []),
  },
  {
    id: "P3",
    title: "Adventurous",
    group: "personality",
    build: () => personalityRun("adventurous", [{ kind: "must", text: "at least 10 leader moves over 40 bars", test: (v) => leaderMoveCount(v) >= 10, observe: leaderMoveCount }]),
  },
  ...(["funk", "blues-rock", "jazz"] as const).map(
    (genre): Scenario => ({
      id: `G1-${genre}`,
      title: `Same playing, ${genre}`,
      group: "genre",
      songs: ["night-shift"],
      build: () => ({
        modes: script(VARIED),
        bars: VARIED_BARS,
        genre,
        checks: [
          ...followsVaried,
          { kind: "must_not", text: `the leader makes a move ${genre} avoids`, test: (v) => avoided(v, 0, VARIED_BARS - 1, genre).length === 0, observe: (v) => avoided(v, 0, VARIED_BARS - 1, genre).length },
          ...(genre === "funk"
            ? [
                { kind: "must" as const, text: "texture over feel: the leader moves parts in or out at least as often as it changes the feel (funk locks in)", test: (v: RunView) => layerMoves(v) >= 1 && layerMoves(v) >= feelMoves(v), observe: (v: RunView) => layerMoves(v) - feelMoves(v) },
              ]
            : genre === "jazz"
              ? [{ kind: "must" as const, text: "the leader answers with a fill or moves a part at least twice (jazz talks back)", test: (v: RunView) => v.leaderMoves(0, VARIED_BARS - 1).filter(({ m }) => isMove("fire_stinger", { stinger: "fill" })(m) || m.move.move === "add_layer" || m.move.move === "drop_layer").length >= 2, observe: (v: RunView) => v.leaderMoves(0, VARIED_BARS - 1).filter(({ m }) => isMove("fire_stinger", { stinger: "fill" })(m) || m.move.move === "add_layer" || m.move.move === "drop_layer").length }]
              : [{ kind: "must" as const, text: "the leader marks a lift with a crash or a riser (rock)", test: (v: RunView) => marks(v) >= 1, observe: marks }]),
        ],
      }),
    }),
  ),
  {
    id: "T1",
    title: "Trades fours",
    group: "trading",
    build: () => ({
      modes: tradeModes(),
      bars: TRADE_BARS + 1,
      trade: true,
      checks: [
        { kind: "must", text: "the band takes at least 3 of its 4 turns (bars 4, 12, 20, 28)", test: (v) => bandTurns.filter((b) => soloIn(v, b)).length >= 3, observe: (v) => bandTurns.filter((b) => soloIn(v, b)).length },
        { kind: "must_not", text: "a band solo in the player's turns", test: (v) => !playerTurns.some((t) => v.bars(t, t + 3).some((i) => soloIn(v, i))) },
        { kind: "must", text: `bars 4–${TRADE_BARS - 1}, drums and bass in (or a drum solo)`, test: (v) => v.bars(4, TRADE_BARS - 1).every((i) => groove(v, i)) },
        noLayerDropped(4, TRADE_BARS - 1),
        { kind: "must", text: `bars 4–${TRADE_BARS - 1}, target stays ≥ 0.4`, test: (v) => v.bars(4, TRADE_BARS - 1).every((i) => v.target(i) >= 0.4 - 1e-9), observe: (v) => Math.min(...v.bars(4, TRADE_BARS - 1).map((i) => v.target(i))) },
      ],
    }),
  },
  {
    id: "T2",
    title: "Comes back in early",
    group: "trading",
    build: () => ({
      modes: script("busy:4, silent:1, busy:7"),
      bars: 12,
      trade: true,
      checks: [
        { kind: "must", text: "bar 4, the band takes its turn", test: (v) => soloIn(v, 4) },
        { kind: "must", text: "bar 7, the band has handed back", test: (v) => !soloIn(v, 7) },
      ],
    }),
  },
  {
    id: "T3",
    title: "Trading off",
    group: "trading",
    build: () => ({
      modes: script("busy:4, silent:4, busy:4, silent:4, busy:1"),
      bars: 17,
      checks: [{ kind: "must_not", text: "a band solo with trading off", test: (v) => !v.bars(0, 16).some((i) => soloIn(v, i)) }],
    }),
  },
];

export const SCENARIOS: Scenario[] = [
  // ---------- follow the player ----------
  {
    id: "E1",
    title: "Goes sparse",
    group: "follow",
    build: () => ({ modes: script("medium:8, sparse:8"), bars: 17, checks: [targetAtMost(16, 0.4), noRaise(8, 16), noLayerAdded(8, 16), noRiser(8, 16)] }),
  },
  {
    id: "E2",
    title: "Stops",
    group: "follow",
    build: () => ({
      modes: script("medium:8, silent:8"),
      bars: 17,
      checks: [
        { kind: "must", text: "by bar 16, target ≤ 0.3 or drums out", test: (v) => v.target(16) <= 0.3 + 1e-9 || !v.playing(16, "drums"), observe: (v) => v.target(16) },
        noLayerAdded(8, 16),
        noStinger(8, 16),
      ],
    }),
  },
  {
    id: "E3",
    title: "Comes back",
    group: "follow",
    build: () => ({
      modes: script("silent:8, medium:8"),
      bars: 17,
      checks: [
        { kind: "must", text: "by bar 16, target ≥ 0.45 and drums and bass in", test: (v) => v.target(16) >= 0.45 - 1e-9 && v.playing(16, "drums") && v.playing(16, "bass"), observe: (v) => v.target(16) },
        noLower(8, 16),
      ],
    }),
  },
  {
    id: "E4",
    title: "Stays busy",
    group: "follow",
    build: (s) => ({
      modes: script("medium:4, busy:12"),
      bars: 17,
      checks: [
        // Tuned from the baseline: jazz sections sit lower, so "busy" lands lower.
        targetAtLeast(12, s.genre === "jazz" ? 0.55 : 0.6),
        { kind: "must", text: "by bar 16, every part in the lineup plays", test: (v) => v.at(16).lineup.every((p) => v.at(16).layers.includes(p)) },
        noFeel(4, 16, "half_time"),
        noLower(4, 16),
      ],
    }),
  },
  {
    id: "E5",
    title: "Builds into the next section",
    group: "follow",
    build: (s) => {
      const { bar } = buildPoint(s);
      return {
        modes: [...script(`medium:${bar - 8}`), ...script("sparse:4, medium:2, busy:2, busy:8")],
        bars: bar + 8,
        checks: [
          targetRisesBy(bar, bar - 8, 0.2),
          {
            kind: "must",
            text: `a fill or crash on bar ${bar - 1} or ${bar}`,
            test: (v) => [bar - 1, bar].some((i) => v.at(i).stingers.some((x) => x === "fill" || x === "crash")),
          },
          noLayerDropped(bar - 4, bar - 1),
          noLower(bar - 4, bar - 1),
        ],
      };
    },
  },
  {
    id: "E6",
    title: "Crescendo inside a phrase",
    group: "follow",
    build: () => ({ modes: script("medium:4, crescendo:8"), bars: 13, checks: [targetRisesBy(12, 4, 0.1), noLower(4, 12)] }),
  },
  {
    id: "E7",
    title: "Decrescendo inside a phrase",
    group: "follow",
    build: () => ({ modes: script("busy:4, decrescendo:8"), bars: 13, checks: [targetFallsBy(12, 4, 0.1), noLayerAdded(4, 12)] }),
  },
  {
    id: "E8",
    title: "Held notes",
    group: "follow",
    build: () => ({
      modes: script("medium:4, held:8"),
      bars: 13,
      checks: [targetAtMost(12, 0.45), noLayerAdded(4, 12), noFeel(4, 12, "double_time"), noRiser(4, 12)],
    }),
  },

  // ---------- phrasing ----------
  {
    id: "E9",
    title: "Call and response",
    group: "phrasing",
    build: () => {
      const modes = script(`medium:4, ${repeat("busy:2, silent:2", 4)}, medium:1`);
      const silentBars = modes.flatMap((m, i) => (m === "silent" && i >= 8 && i <= 20 ? [i] : []));
      return {
        modes,
        bars: 21,
        checks: [
          partsIn(8, 20, ["drums", "bass"]),
          targetStaysAtLeast(8, 20, 0.3),
          {
            kind: "must_not",
            text: "bars 8–20, the leader moves the target by more than 0.2 at once",
            test: (v) => !v.intensityChanges(8, 20).some((c) => Math.abs(c.to - c.from) > 0.2 + 1e-9),
          },
          noFeelChange(8, 20),
          {
            kind: "stretch",
            text: "at least two fills land in the silent bars",
            test: (v) => silentBars.filter((i) => v.at(i).stingers.includes("fill")).length >= 2,
            observe: (v) => silentBars.filter((i) => v.at(i).stingers.includes("fill")).length,
          },
        ],
      };
    },
  },
  {
    id: "E10",
    title: "Taking a chorus",
    group: "phrasing",
    songs: SOLO_SONGS,
    build: (s) => {
      const solo = firstSolo(s);
      const end = solo.start + solo.bars - 1;
      // The leader first hears the solo at the end of its first phrase: judge from the phrase after.
      const from = solo.start + s.phraseBars;
      return {
        modes: script(`medium:${solo.start}, busy:${solo.bars}, medium:1`),
        bars: end + 2,
        checks: [targetStaysAtLeast(from, end, 0.5), partsIn(solo.start, end, ["drums", "bass"]), noJump(solo.start, end), noLayerDropped(solo.start, end)],
      };
    },
  },
  {
    id: "E11",
    title: "Keeps going at the end of a solo",
    group: "phrasing",
    songs: SOLO_SONGS,
    build: (s) => {
      const solo = soloBeforeHead(s);
      const end = solo.start + solo.bars - 1;
      return {
        modes: script(`medium:${solo.start}, busy:${solo.bars + 4}`),
        bars: end + 5,
        checks: [
          noMove(end - 3, end + 1, "a jump away from the solo", (m) => m.move.move === "jump_to_section" && (m.move as { section: string }).section !== "solo"),
          { kind: "stretch", text: `bar ${end + 1} is still the solo (extended or repeated)`, test: (v) => v.at(end + 1).section === "solo" },
        ],
      };
    },
  },

  // ---------- harmony and rhythm ----------
  {
    id: "E12",
    title: "Plays outside",
    group: "harmony_rhythm",
    songs: ["night-shift", "blues-in-a"],
    build: () => ({ modes: script("medium:4, outside:8"), bars: 13, checks: [noRaiseAbove(4, 12, 4, 0.1), noLayerAdded(4, 12), noRiser(4, 12)] }),
  },
  {
    id: "E12j",
    title: "Plays outside (jazz)",
    group: "harmony_rhythm",
    songs: ["late-set"],
    build: () => ({ modes: script("medium:4, outside:8"), bars: 13, checks: [partsIn(4, 12, ["drums", "bass"]), noLower(4, 12), targetRisesBy(12, 4, 0.1, "stretch")] }),
  },
  {
    id: "E13",
    title: "Locks into a riff",
    group: "harmony_rhythm",
    songs: ["night-shift"],
    build: () => ({
      modes: script("riff:16"),
      bars: 17,
      checks: [
        {
          kind: "must_not",
          text: "bars 0–16, more than one leader target change bigger than 0.1",
          test: (v) => v.intensityChanges(0, 16).filter((c) => Math.abs(c.to - c.from) > 0.1 + 1e-9).length <= 1,
          observe: (v) => v.intensityChanges(0, 16).filter((c) => Math.abs(c.to - c.from) > 0.1 + 1e-9).length,
        },
        noFeelChange(0, 16),
        noJump(0, 16),
      ],
    }),
  },
  {
    id: "E14",
    title: "Syncopated",
    group: "harmony_rhythm",
    build: () => ({ modes: script("medium:4, syncopated:8"), bars: 13, checks: [noLower(4, 12), noFeel(4, 12, "half_time")] }),
  },

  // ---------- tempo ----------
  {
    id: "E15",
    title: "Pushing and laying back",
    group: "tempo",
    build: () => ({ modes: script("push:8, layback:8"), bars: 17, checks: [tempoHolds(0, 16)] }),
  },
  {
    id: "E16",
    title: "Rushing (strict tempo)",
    group: "tempo",
    build: () => ({ modes: script("medium:4, rush:12"), bars: 17, checks: [tempoHolds(0, 16)] }),
  },
  {
    id: "E17",
    title: "Dragging (strict tempo)",
    group: "tempo",
    build: () => ({ modes: script("medium:4, drag:12"), bars: 17, checks: [tempoHolds(0, 16)] }),
  },
  {
    id: "E15f",
    title: "Pushing and laying back (follow my tempo)",
    group: "tempo",
    build: () => ({ modes: script("push:8, layback:8"), bars: 17, followTempo: true, checks: [tempoHolds(0, 16)] }),
  },
  {
    id: "E16f",
    title: "Rushing (follow my tempo)",
    group: "tempo",
    build: () => ({ modes: script("medium:4, rush:12"), bars: 17, followTempo: true, checks: [...followChecks(16, "up")] }),
  },
  {
    id: "E17f",
    title: "Dragging (follow my tempo)",
    group: "tempo",
    build: () => ({ modes: script("medium:4, drag:12"), bars: 17, followTempo: true, checks: [...followChecks(16, "down")] }),
  },
  ...CUE_SCENARIOS,
  ...LEADING_SCENARIOS,
];

/** Scenario runs for a song, with the scenario each belongs to. */
export function scenariosFor(song: Song, only?: string[]): { scenario: Scenario; run: ScenarioRun }[] {
  const shape = songShape(song);
  return SCENARIOS.filter((s) => (!s.songs || s.songs.includes(song.id)) && (!only || only.includes(s.id))).map((scenario) => ({ scenario, run: scenario.build(shape) }));
}

export interface CheckResult {
  kind: CheckKind;
  text: string;
  pass: boolean;
  observed?: number;
}

export function judge(run: ScenarioRun, view: RunView): CheckResult[] {
  return run.checks.map((c) => ({ kind: c.kind, text: c.text, pass: c.test(view), observed: c.observe?.(view) }));
}

/** Checks passed / checks, stretch checks left out. Null when a run has only stretch checks. */
export function scoreOf(results: CheckResult[]): number | null {
  const scored = results.filter((r) => r.kind !== "stretch");
  return scored.length ? scored.filter((r) => r.pass).length / scored.length : null;
}
