import { describe, expect, it } from "vitest";
import { loadChart, type ChartJSON } from "../src/core/chart";
import { Conductor, ruleLeader } from "../src/core/conductor";
import { Engine } from "../src/core/engine";
import { NoteTracker } from "../src/core/features";
import { getGenre } from "../src/core/genres";
import { exportSessionMidi } from "../src/core/midi-export";
import { buildRecap, recapPromptPayload } from "../src/core/recap";
import { RuleLeader } from "../src/core/rules";
import { replaySession, SessionRecorder, type SessionFile } from "../src/core/session";
import { parseScript, SimPlayer } from "../src/core/simplayer";
import { Transport, type Sink } from "../src/core/transport";
import type { NoteEvent } from "../src/core/types";
import nightShiftJson from "../public/charts/night-shift.json";

const nightShift = nightShiftJson as ChartJSON;

function recordSampleSession(bars = 16): SessionFile {
  const chart = loadChart(nightShift);
  const genre = getGenre(chart.genre);
  const engine = new Engine(chart, { seed: 42, genre, countIn: 1, band: genre.band });
  const recorder = new SessionRecorder({
    chart: nightShift,
    genre: genre.id,
    swing: null,
    band: genre.band,
    seed: 42,
    countIn: 1,
    config: {},
    leader: "rules",
    everyBars: 2,
  });
  const conductor = new Conductor(engine, ruleLeader(new RuleLeader()), 2);
  const tracker = new NoteTracker();
  const sim = new SimPlayer(42);
  const script = parseScript("sparse:4,busy:6,silent:4,medium:4");
  const bpb = chart.beatsPerBar;

  for (let k = 0; k < bars; k++) {
    const plan = engine.nextBar();
    if (!plan) break;
    const startBeat = k * bpb;
    recorder.bar(plan);
    if (plan.kind !== "count_in") {
      if (k === 6) engine.cue("build");
      const mode = script[k % script.length];
      for (const n of sim.play(plan, mode, bpb)) {
        tracker.noteOn(startBeat + n.start, n.note, n.vel);
        tracker.noteOff(startBeat + n.start + n.dur, n.note);
        recorder.note(startBeat + n.start, n.note, n.vel);
        recorder.note(startBeat + n.start + n.dur, n.note, 0);
      }
    }
    conductor.barFinished(plan, tracker.bar(startBeat, bpb));
  }
  return recorder.finish(engine);
}

describe("recap (v0.6)", () => {
  it("builds per-bar curves, proportional sections, move reasons and fallback summary", () => {
    const file = recordSampleSession(18);
    const recap = buildRecap(file);

    expect(recap.title).toBe(file.title);
    expect(recap.bars.length).toBe(file.bars.length);
    expect(recap.sections.length).toBeGreaterThanOrEqual(2);
    expect(recap.sections.reduce((s, x) => s + x.bars, 0)).toBe(recap.bars.length);
    expect(recap.stats.playedBars).toBe(file.bars.length - 1); // minus 1 count-in bar
    expect(recap.stats.peakIntensity).toBeGreaterThan(0);
    expect(recap.stats.meanPlayerEnergy).toBeGreaterThan(0);
    expect(recap.stats.playerCues).toBeGreaterThanOrEqual(1);
    expect(recap.moves.length).toBeGreaterThan(0);
    expect(recap.moves.some((m) => !!m.reason)).toBe(true);
    expect(recap.fallbackSummary).toContain(file.title);

    const payload = recapPromptPayload(recap);
    expect(payload.title).toBe(file.title);
    expect(Array.isArray(payload.sections)).toBe(true);
  });
});

describe("midi export (v0.6)", () => {
  it("writes a valid Type 1 Standard MIDI File matching the replayed session", async () => {
    const file = recordSampleSession(12);
    const bytes = exportSessionMidi(file);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);

    expect(tag(0)).toBe("MThd");
    expect(view.getUint32(4)).toBe(6);
    expect(view.getUint16(8)).toBe(1); // format 1
    const tracks = view.getUint16(10);
    expect(tracks).toBeGreaterThanOrEqual(4); // tempo + drums + bass + chords (+ player)
    expect(view.getUint16(12)).toBe(480); // PPQ

    // Walk every MTrk chunk and confirm exact byte bounds + End-of-Track meta event.
    let offset = 14;
    let seen = 0;
    let noteOns = 0;
    while (offset < bytes.length) {
      expect(tag(offset)).toBe("MTrk");
      const len = view.getUint32(offset + 4);
      const end = offset + 8 + len;
      expect(end).toBeLessThanOrEqual(bytes.length);
      // Last 3 bytes of each track are FF 2F 00 (End of Track)
      expect([bytes[end - 3], bytes[end - 2], bytes[end - 1]]).toEqual([0xff, 0x2f, 0x00]);
      // Rough count of note-on status bytes (0x90..0x9f)
      for (let i = offset + 8; i < end - 3; i++) {
        if ((bytes[i] & 0xf0) === 0x90) noteOns++;
      }
      offset = end;
      seen++;
    }
    expect(seen).toBe(tracks);
    expect(offset).toBe(bytes.length);

    const rep = await replaySession(file);
    const bandEvents = rep.plans.reduce((s, p) => s + p.events.filter((e) => e.note >= 0).length, 0);
    expect(noteOns).toBeGreaterThanOrEqual(bandEvents);
  });
});

describe("seekable transport (v0.6)", () => {
  it("aligns startBeat and beatAt when starting replay from startBar > 0", () => {
    const chart = loadChart(nightShift);
    const engine = new Engine(chart, { seed: 7, genre: getGenre(chart.genre), countIn: 0 });
    // Skip 4 bars before handing engine to Transport
    for (let k = 0; k < 4; k++) engine.nextBar();

    let clock = 0;
    const played: { ev: NoteEvent; time: number }[] = [];
    const sink: Sink = {
      play: (ev, time) => played.push({ ev, time }),
      panic: () => {},
    };
    const committedBeats: number[] = [];
    const startedBars: number[] = [];
    const tr = new Transport(
      engine,
      { now: () => clock },
      sink,
      {
        onCommit: (_plan, startBeat) => committedBeats.push(startBeat),
        onBarStart: (plan) => startedBars.push(plan.bar),
      },
      { startBar: 4, startDelay: 0.1, lookahead: 0.1 },
    );
    tr.start();
    expect(committedBeats[0]).toBe(16); // bar 4 * 4 beats
    expect(tr.timeAt(16)).toBeCloseTo(0.1, 6);
    expect(tr.beatAt(0.1)).toBeCloseTo(16, 6);

    // Advance 2.5 seconds (~1 bar at 112 bpm)
    for (let step = 0; step < 120; step++) {
      clock += 0.025;
      tr.tick();
    }
    expect(startedBars[0]).toBe(4);
    expect(committedBeats).toContain(20);
    expect(played.length).toBeGreaterThan(0);
  });
});
