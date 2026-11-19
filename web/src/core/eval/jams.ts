// Guitar jams for the eval (v0.5 row 12): one per song, played on guitar
// and heard through the audio listener, labelled with checks like the other
// scenarios (J1–J3 in scenarios.ts). Until real recorded jams are in
// (docs/eval/jams/<id>.json, a downloaded session), each is a synthesised
// jam: the pretend player on a script, recorded as a session. Recorded
// notes don't answer the band, so the checks ask only for the band to
// follow the player.

import type { ChartJSON } from "../chart";
import { UNPITCHED } from "../features";
import type { SessionFile } from "../session";
import { recordSimSession } from "../simsession";

export interface Jam {
  id: string;
  song: string;
  script: string;
  seed: number;
  /** Funk: every other short note is a muted scratch. */
  scratches?: boolean;
}

export const JAMS: Jam[] = [
  { id: "night-shift-guitar", song: "night-shift", script: "medium:8,busy:8,sparse:4,silent:4,busy:8", seed: 501, scratches: true },
  { id: "blues-in-a-guitar", song: "blues-in-a", script: "sparse:6,medium:6,crescendo:4,busy:8,decrescendo:4,silent:6", seed: 502 },
  { id: "late-set-guitar", song: "late-set", script: "sparse:8,medium:8,outside:4,medium:4,held:4,sparse:4", seed: 503 },
];

/** The synthesised jam as a session (deterministic). */
export function synthJam(jam: Jam, chart: ChartJSON): SessionFile {
  let i = 0;
  return recordSimSession(chart, jam.script, {
    seed: jam.seed,
    title: `${chart.title} (synthesised guitar jam)`,
    input: { kind: "audio", mode: "auto", tuning: "standard" },
    notes: jam.scratches ? (n) => (n.dur <= 0.25 && i++ % 2 === 0 ? { ...n, note: UNPITCHED } : n) : undefined,
  });
}

/** A session's playing, bar by bar from the song's first bar (after its count-in): notes in beats from the bar's start. */
export function jamBars(f: SessionFile): { start: number; dur: number; note: number; vel: number }[][] {
  const bpb = Number(f.chart.time_sig.split("/")[0]);
  const countIn = f.count_in;
  const out: { start: number; dur: number; note: number; vel: number }[][] = [];
  const open = new Map<number, { beat: number; vel: number }>();
  for (const [beat, note, vel] of [...f.player].sort((a, b) => a[0] - b[0] || a[2] - b[2])) {
    if (vel > 0) {
      open.set(note, { beat, vel });
      continue;
    }
    const o = open.get(note);
    if (!o) continue;
    open.delete(note);
    const bar = Math.floor(o.beat / bpb) - countIn;
    if (bar < 0) continue;
    (out[bar] ??= []).push({ start: o.beat - (bar + countIn) * bpb, dur: beat - o.beat, note, vel: o.vel });
  }
  return Array.from({ length: f.bars.length - countIn }, (_, k) => out[k] ?? []);
}
