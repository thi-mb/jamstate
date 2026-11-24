// Standard MIDI File (SMF Type 1) exporter for recorded sessions (v0.6).
// Zero dependencies, DOM-free. Replays the exact recorded band and writes a
// tempo/time-signature track plus one named track per part on jamstate's DAW
// channel layout (player 1, bass 2, keys 3, guitar 4, pad 5, drums 10, perc 11).

import { sessionEngine, type SessionFile } from "./session";
import { clamp, PART_LABELS, type Voice } from "./types";

const PPQ = 480;

/** 0-based MIDI channels matching web/src/audio/midi.ts. */
export const MIDI_CHANNELS: Record<Voice, number> = {
  player: 0,
  bass: 1,
  chords: 2,
  guitar: 3,
  pad: 4,
  drums: 9,
  percussion: 10,
};

const TRACK_NAMES: Record<Voice, string> = {
  player: "Player",
  drums: "Drums",
  bass: "Bass",
  chords: "Keys",
  guitar: "Guitar",
  pad: "Pad",
  percussion: "Percussion",
};

interface RawEvent {
  tick: number;
  order: number; // 0 = meta/note-off, 1 = note-on
  bytes: number[];
}

function vlq(n: number): number[] {
  let v = Math.max(0, Math.round(n));
  const out = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0) & 0x7f);
}

function meta(type: number, data: number[]): number[] {
  return [0xff, type, ...vlq(data.length), ...data];
}

function u16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}

function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function encodeTrack(events: RawEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let prev = 0;
  for (const e of events) {
    const tick = Math.max(prev, e.tick);
    body.push(...vlq(tick - prev), ...e.bytes);
    prev = tick;
  }
  // End of track
  body.push(0x00, 0xff, 0x2f, 0x00);
  return [...ascii("MTrk"), ...u32(body.length), ...body];
}

function pairPlayerNotes(file: SessionFile): { start: number; dur: number; note: number; vel: number }[] {
  const open = new Map<number, { start: number; vel: number }>();
  const out: { start: number; dur: number; note: number; vel: number }[] = [];
  for (const [beat, note, vel] of file.player) {
    if (note < 0) continue; // unpitched audio hits have no MIDI pitch
    const o = open.get(note);
    if (o) {
      out.push({ start: o.start, dur: Math.max(0.05, beat - o.start), note, vel: o.vel });
      open.delete(note);
    }
    if (vel > 0) open.set(note, { start: beat, vel });
  }
  for (const [note, o] of open) out.push({ start: o.start, dur: 1, note, vel: o.vel });
  return out;
}

export interface MidiExportOptions {
  /** Include the recorded player notes on channel 1 (default true for MIDI sessions). */
  includePlayer?: boolean;
}

/** Render a recorded session to a Type 1 Standard MIDI File (.mid). */
export function exportSessionMidi(file: SessionFile, opts: MidiExportOptions = {}): Uint8Array {
  const engine = sessionEngine(file, file.controls);
  const bpb = engine.chart.beatsPerBar;
  const includePlayer = opts.includePlayer ?? file.input?.kind !== "audio";

  const tempoEvents: RawEvent[] = [
    { tick: 0, order: 0, bytes: meta(0x03, ascii(file.title || "jamstate")) },
    // Time signature: bpb / 4
    { tick: 0, order: 0, bytes: meta(0x58, [bpb, 2, 24, 8]) },
  ];

  const byVoice = new Map<Voice, RawEvent[]>();
  const pushNote = (voice: Voice, startBeat: number, durBeats: number, note: number, vel: number) => {
    if (note < 0 || note > 127) return;
    let list = byVoice.get(voice);
    if (!list) {
      list = [{ tick: 0, order: 0, bytes: meta(0x03, ascii(TRACK_NAMES[voice] ?? PART_LABELS[voice as keyof typeof PART_LABELS] ?? voice)) }];
      byVoice.set(voice, list);
    }
    const ch = MIDI_CHANNELS[voice];
    const onTick = Math.max(0, Math.round(startBeat * PPQ));
    const offTick = Math.max(onTick + 1, Math.round((startBeat + Math.max(0.05, durBeats)) * PPQ));
    const v = Math.round(clamp(vel, 1, 127));
    list.push({ tick: onTick, order: 1, bytes: [0x90 | ch, note & 0x7f, v] });
    list.push({ tick: offTick, order: 0, bytes: [0x80 | ch, note & 0x7f, 0] });
  };

  let lastBpm = -1;
  for (let k = 0; k < file.bars.length; k++) {
    const plan = engine.nextBar();
    if (!plan) break;
    const barStart = k * bpb;
    if (Math.abs(plan.bpm - lastBpm) > 0.01) {
      const usPerBeat = Math.round(60_000_000 / Math.max(20, plan.bpm));
      tempoEvents.push({
        tick: Math.round(barStart * PPQ),
        order: 0,
        bytes: meta(0x51, [(usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff]),
      });
      lastBpm = plan.bpm;
    }
    for (const ev of plan.events) {
      pushNote(ev.part, barStart + ev.start, ev.dur, ev.note, ev.vel);
    }
  }

  if (includePlayer) {
    for (const n of pairPlayerNotes(file)) {
      pushNote("player", n.start, n.dur, n.note, n.vel);
    }
  }

  const tracks = [encodeTrack(tempoEvents), ...[...byVoice.values()].map(encodeTrack)];
  const header = [...ascii("MThd"), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQ)];
  const totalLen = header.length + tracks.reduce((s, t) => s + t.length, 0);
  const out = new Uint8Array(totalLen);
  let o = 0;
  out.set(header, o);
  o += header.length;
  for (const t of tracks) {
    out.set(t, o);
    o += t.length;
  }
  return out;
}
