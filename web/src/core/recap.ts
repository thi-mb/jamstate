// Session recap analysis (v0.6): builds per-bar timelines (band intensity,
// player energy, form sections, applied moves with reasons, stats, and a
// deterministic fallback summary) from any recorded SessionFile. DOM-free.

import type { BarKind } from "./engine";
import { barFeatures, NoteTracker, type BarFeatures } from "./features";
import { getGenre } from "./genres";
import { PLAYER_SOURCES, sessionEngine, type SessionFile } from "./session";

export interface RecapBar {
  /** Zero-based index in the recorded session (matches session.bars[k] and replay startBar). */
  index: number;
  bar: number;
  kind: BarKind;
  section: string;
  barInSection: number;
  chords: string[];
  bpm: number;
  intensity: number;
  playerEnergy: number;
  playerNotes: number;
  feel: string;
  layers: string[];
  soloPart: string | null;
}

export interface RecapMove {
  index: number;
  bar: number;
  label: string;
  source: string;
  reason?: string;
}

export interface RecapSection {
  section: string;
  startIndex: number;
  bars: number;
}

export interface RecapStats {
  playedBars: number;
  peakIntensity: number;
  peakSection: string;
  peakBar: number;
  meanPlayerEnergy: number;
  leaderMoves: number;
  playerCues: number;
  feelChanges: number;
  tradedSolos: number;
}

export interface RecapData {
  title: string;
  genre: string;
  genreName: string;
  leader: string;
  bpm: number;
  bpb: number;
  durationSec: number;
  bars: RecapBar[];
  sections: RecapSection[];
  moves: RecapMove[];
  stats: RecapStats;
  /** Deterministic summary used offline or before an LLM summary is requested. */
  fallbackSummary: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Reconstruct the full recap timeline from a recorded session.
 * Runs the session's exact engine synchronously so per-bar tempos and full
 * move reasons are recovered even for sessions imported from disk.
 */
export function buildRecap(file: SessionFile): RecapData {
  const engine = sessionEngine(file, file.controls);
  const bpb = engine.chart.beatsPerBar;
  const genreName = getGenre(file.genre).name.toLowerCase();
  const tracker = new NoteTracker();
  const prevFeatures: BarFeatures[] = [];

  const bars: RecapBar[] = [];
  const moves: RecapMove[] = [];
  const sections: RecapSection[] = [];
  let pi = 0;
  let durationSec = 0;
  let tradedSolos = 0;
  let inSolo = false;

  const total = file.bars.length;
  for (let k = 0; k < total; k++) {
    const plan = engine.nextBar();
    if (!plan) break;
    const startBeat = k * bpb;
    const endBeat = (k + 1) * bpb;
    for (; pi < file.player.length && file.player[pi][0] < endBeat; pi++) {
      const [beat, note, vel] = file.player[pi];
      if (vel > 0) tracker.noteOn(beat, note, vel);
      else tracker.noteOff(beat, note);
    }
    const notes = plan.kind === "count_in" ? [] : tracker.bar(startBeat, bpb);
    const feat = plan.kind === "count_in" ? null : barFeatures(notes, bpb, prevFeatures);
    if (feat) {
      prevFeatures.push(feat);
      if (prevFeatures.length > 8) prevFeatures.shift();
    }

    durationSec += (bpb * 60) / plan.bpm;
    if (plan.solo && !inSolo) {
      tradedSolos++;
      inSolo = true;
    } else if (!plan.solo) {
      inSolo = false;
    }

    bars.push({
      index: k,
      bar: plan.bar,
      kind: plan.kind,
      section: plan.section,
      barInSection: plan.barInSection,
      chords: plan.chords,
      bpm: plan.bpm,
      intensity: r2(plan.intensity),
      playerEnergy: r2(feat?.energy ?? 0),
      playerNotes: feat?.noteCount ?? 0,
      feel: plan.feel,
      layers: [...plan.layers],
      soloPart: plan.solo?.part ?? null,
    });

    const secLabel = plan.kind === "count_in" ? "count-in" : plan.section;
    const lastSec = sections[sections.length - 1];
    if (lastSec && lastSec.section === secLabel && (plan.kind === "count_in" || plan.barInSection > 0)) {
      lastSec.bars++;
    } else {
      sections.push({ section: secLabel, startIndex: k, bars: 1 });
    }

    for (const m of plan.moves) {
      if (m.status !== "applied") continue;
      moves.push({
        index: k,
        bar: plan.bar,
        label: m.label,
        source: m.source,
        ...(m.move.reason ? { reason: m.move.reason } : {}),
      });
    }
  }

  const played = bars.filter((b) => b.kind !== "count_in");
  let peakBar = played[0] ?? bars[0];
  for (const b of played) if (b.intensity > (peakBar?.intensity ?? -1)) peakBar = b;

  const meanPlayerEnergy = played.length
    ? r2(played.reduce((s, b) => s + b.playerEnergy, 0) / played.length)
    : 0;
  const playerCues = moves.filter((m) => PLAYER_SOURCES.has(m.source)).length;
  const leaderMoves = moves.length - playerCues;
  const feelChanges = moves.filter((m) => m.label.startsWith("change_feel")).length;

  const stats: RecapStats = {
    playedBars: played.length,
    peakIntensity: peakBar?.intensity ?? 0,
    peakSection: peakBar?.section ?? "–",
    peakBar: peakBar?.bar ?? 0,
    meanPlayerEnergy,
    leaderMoves,
    playerCues,
    feelChanges,
    tradedSolos,
  };

  const fallbackSummary = summarizeRecapFallback(file.title, genreName, stats, moves);

  return {
    title: file.title,
    genre: file.genre,
    genreName,
    leader: file.leader,
    bpm: engine.chart.bpm,
    bpb,
    durationSec: Math.round(durationSec),
    bars,
    sections,
    moves,
    stats,
    fallbackSummary,
  };
}

function summarizeRecapFallback(title: string, genreName: string, stats: RecapStats, moves: RecapMove[]): string {
  if (!stats.playedBars) return `Short take on ${title} (${genreName}).`;
  const parts: string[] = [
    `${stats.playedBars} bars of ${title} (${genreName}) peaking at ${Math.round(stats.peakIntensity * 100)}% intensity in ${stats.peakSection} (bar ${stats.peakBar + 1}).`,
  ];
  const highlights: string[] = [];
  if (stats.leaderMoves > 0) highlights.push(`${stats.leaderMoves} bandleader move${stats.leaderMoves === 1 ? "" : "s"}`);
  if (stats.playerCues > 0) highlights.push(`${stats.playerCues} cue${stats.playerCues === 1 ? "" : "s"}`);
  if (stats.tradedSolos > 0) highlights.push(`${stats.tradedSolos} traded solo${stats.tradedSolos === 1 ? "" : "s"}`);
  const half = moves.find((m) => m.label.includes("half_time"));
  if (half) highlights.push(`a drop into half time at bar ${half.bar + 1}`);
  if (highlights.length) parts.push(`Featured ${highlights.join(", ")}.`);
  else parts.push("The band held a steady groove throughout.");
  return parts.join(" ");
}

/** Compact JSON payload sent to an LLM brain for a natural-language session recap. */
export function recapPromptPayload(recap: RecapData): Record<string, unknown> {
  return {
    title: recap.title,
    genre: recap.genreName,
    bpm: recap.bpm,
    duration_sec: recap.durationSec,
    stats: recap.stats,
    sections: recap.sections.filter((s) => s.section !== "count-in").map((s) => {
      const slice = recap.bars.slice(s.startIndex, s.startIndex + s.bars);
      const avgInt = slice.length ? r2(slice.reduce((a, b) => a + b.intensity, 0) / slice.length) : 0;
      const avgPl = slice.length ? r2(slice.reduce((a, b) => a + b.playerEnergy, 0) / slice.length) : 0;
      return { section: s.section, bars: s.bars, band_intensity: avgInt, player_energy: avgPl };
    }),
    key_moves: recap.moves.slice(0, 20).map((m) => ({
      bar: m.bar + 1,
      move: m.label,
      source: m.source,
      ...(m.reason ? { reason: m.reason } : {}),
    })),
  };
}
