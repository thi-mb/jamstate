// Page wiring: chart loading, controls, and one jam session at a time.

import { MidiSink, Midi, MultiSink } from "./audio/midi";
import { Synth } from "./audio/synth";
import { Ticker } from "./audio/ticker";
import { ChartError, loadChart, type Chart } from "./core/chart";
import { Conductor, ruleLeader, type Leader } from "./core/conductor";
import { Engine } from "./core/engine";
import { NoteTracker } from "./core/features";
import type { Move } from "./core/moves";
import { RuleLeader } from "./core/rules";
import { DEMO_SCRIPT, parseScript, SimPlayer, type SimMode } from "./core/simplayer";
import { Transport, type Sink } from "./core/transport";
import { FEELS, PARTS, STINGERS } from "./core/types";
import { RemoteLeader } from "./leader/remote";
import { attachKeyboard } from "./ui/keyboard";
import { Overlay } from "./ui/overlay";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const overlay = new Overlay();
const midi = new Midi();
let chart: Chart | null = null;
let chartJson = "";
let audio: AudioContext | null = null;
let session: Session | null = null;

interface Session {
  engine: Engine;
  transport: Transport;
  conductor: Conductor;
  ticker: Ticker;
  tracker: NoteTracker;
  synth: Synth;
  remote: RemoteLeader | null;
}

// ---------- chart ----------

function useChart(raw: unknown, source: string): boolean {
  $("chart-errors").textContent = "";
  try {
    chart = loadChart(raw);
  } catch (e) {
    $("chart-errors").textContent = e instanceof ChartError ? e.errors.join("\n") : String(e);
    return false;
  }
  chartJson = JSON.stringify(raw, null, 2);
  ($("chart-json") as HTMLTextAreaElement).value = chartJson;
  const bars = chart.form.reduce((n, s) => n + chart!.sections.get(s)!.bars, 0);
  $("chart-info").textContent = `${source}: ${chart.bpm} bpm, ${chart.beatsPerBar}/4${chart.key ? `, ${chart.key}` : ""}, ${bars} bars`;
  overlay.setForm(chart.form);
  overlay.reset(chart.title);
  buildManualMoves();
  return true;
}

async function loadCharts(): Promise<void> {
  const select = $<HTMLSelectElement>("chart-select");
  const list: { file: string; title: string }[] = await fetch("charts/index.json").then((r) => r.json());
  select.replaceChildren(...list.map((c) => new Option(c.title, c.file)));
  const load = async () => useChart(await fetch(`charts/${select.value}`).then((r) => r.json()), select.selectedOptions[0].text);
  select.onchange = load;
  await load();
}

$("chart-file").onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    useChart(JSON.parse(await file.text()), file.name);
  } catch (err) {
    $("chart-errors").textContent = `Not valid JSON: ${(err as Error).message}`;
  }
};
$("chart-edit-toggle").onclick = () => ($("chart-editor").hidden = !$("chart-editor").hidden);
$("chart-apply").onclick = () => {
  try {
    useChart(JSON.parse(($("chart-json") as HTMLTextAreaElement).value), "edited chart");
  } catch (err) {
    $("chart-errors").textContent = `Not valid JSON: ${(err as Error).message}`;
  }
};

$("chart-ask").onclick = async () => {
  const prompt = ($("chart-prompt") as HTMLInputElement).value.trim();
  if (!prompt) return;
  const btn = $<HTMLButtonElement>("chart-ask");
  btn.disabled = true;
  $("chart-errors").textContent = "";
  $("chart-info").textContent = "Asking the LLM for a chart…";
  try {
    const r = await fetch("api/chart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    if (useChart(body.chart, `LLM chart (${body.latency_ms} ms)`)) $("chart-editor").hidden = false;
    else $("chart-info").textContent = "The LLM's chart has problems; fix it in the editor.";
    ($("chart-json") as HTMLTextAreaElement).value = JSON.stringify(body.chart, null, 2);
  } catch (err) {
    $("chart-info").textContent = "";
    $("chart-errors").textContent = `Couldn't write a chart: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
};

// ---------- manual moves ----------

function submitManual(move: Move): void {
  if (!session) return overlay.note("Start the band first");
  session.engine.submit([move], "you");
}

function buildManualMoves(): void {
  const box = $("manual");
  const btn = (label: string, move: Move) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => submitManual(move);
    return b;
  };
  box.replaceChildren(
    ...[0.15, 0.4, 0.65, 0.9].map((v) => btn(`intensity ${v}`, { move: "set_intensity", value: v, reason: "Manual" })),
    ...PARTS.flatMap((p) => [btn(`+${p}`, { move: "add_layer", part: p, reason: "Manual" }), btn(`−${p}`, { move: "drop_layer", part: p, reason: "Manual" })]),
    ...FEELS.map((f) => btn(f.replace("_", " "), { move: "change_feel", feel: f, reason: "Manual" })),
    ...STINGERS.map((s) => btn(s, { move: "fire_stinger", stinger: s, reason: "Manual" })),
    ...[...new Set(chart?.form ?? [])].map((s) => btn(`→ ${s}`, { move: "jump_to_section", section: s, reason: "Manual" })),
    btn("extend 4", { move: "extend_section", bars: 4, reason: "Manual" }),
  );
}

// ---------- server / leader ----------

async function checkServer(): Promise<void> {
  const el = $("server-status");
  try {
    const r = await fetch("api/health", { signal: AbortSignal.timeout(2000) });
    const h = await r.json();
    el.textContent = h.llm_url ? `Server up · model ${h.model ?? "?"} at ${h.llm_url}` : "Server up · no LLM configured";
  } catch {
    el.textContent = "No houseband server reachable: the LLM leader will fall back to rules.";
  }
}

function makeLeader(c: Chart): { leader: Leader | null; remote: RemoteLeader | null; every: number } {
  const kind = $<HTMLSelectElement>("leader-select").value;
  const rules = new RuleLeader();
  if (kind === "none") return { leader: null, remote: null, every: 4 };
  if (kind === "rules") return { leader: ruleLeader(rules), remote: null, every: 2 };
  const phraseMs = (c.phraseBars * c.beatsPerBar * 60_000) / c.bpm;
  const remote = new RemoteLeader(rules, { endpoint: "api/leader", timeoutMs: phraseMs });
  return { leader: remote, remote, every: c.phraseBars };
}

function leaderLabel(s: Session): string {
  if (!s.conductor.leader) return "off";
  if (!s.remote) return "rules";
  const st = s.remote.status;
  if (st.mode === "fallback") return `rules (LLM down: ${st.lastError ?? "?"})`;
  return `LLM${st.model ? ` ${st.model}` : ""}${st.lastLatencyMs ? ` · ${st.lastLatencyMs} ms` : ""}${st.failures ? ` · ${st.failures} failed` : ""}`;
}

// ---------- MIDI ----------

let unlistenMidi: (() => void) | null = null;

async function initMidi(): Promise<void> {
  const ok = await midi.init();
  $("midi-status").textContent = ok ? `${midi.inputs().length} MIDI in, ${midi.outputs().length} MIDI out` : (midi.error ?? "");
  if (!ok) return;
  const refresh = () => {
    const inSel = $<HTMLSelectElement>("midi-in");
    const outSel = $<HTMLSelectElement>("midi-out");
    const keepIn = inSel.value;
    const keepOut = outSel.value;
    inSel.replaceChildren(new Option("all inputs", "all"), ...midi.inputs().map((i) => new Option(i.name ?? i.id, i.id)));
    outSel.replaceChildren(new Option("none", ""), ...midi.outputs().map((o) => new Option(o.name ?? o.id, o.id)));
    inSel.value = [...inSel.options].some((o) => o.value === keepIn) ? keepIn : "all";
    outSel.value = [...outSel.options].some((o) => o.value === keepOut) ? keepOut : "";
    $("midi-status").textContent = `${midi.inputs().length} MIDI in, ${midi.outputs().length} MIDI out`;
    listenMidi();
  };
  midi.access!.onstatechange = refresh;
  $("midi-in").onchange = listenMidi;
  refresh();
}

function listenMidi(): void {
  unlistenMidi?.();
  unlistenMidi = midi.listen($<HTMLSelectElement>("midi-in").value, (on, note, vel, ts) => {
    // MIDI timestamps are on the performance.now() timeline; map to the audio clock.
    const t = audio ? audio.currentTime - Math.max(0, performance.now() - ts) / 1000 : 0;
    playerNote(on, note, vel, t);
  });
}

// ---------- player input ----------

const held = new Map<number, () => void>();

function playerNote(on: boolean, note: number, vel: number, audioTime?: number): void {
  if (!audio || !session) return;
  const beat = session.transport.beatAt(audioTime ?? audio.currentTime);
  if (on) {
    held.get(note)?.();
    held.set(note, session.synth.liveNote(note, vel));
    session.tracker.noteOn(beat, note, vel);
  } else {
    held.get(note)?.();
    held.delete(note);
    session.tracker.noteOff(beat, note);
  }
}

attachKeyboard((on, note, vel) => playerNote(on, note, vel));

// ---------- session ----------

function simModeFor(bar: number): SimMode | null {
  const v = $<HTMLSelectElement>("sim").value;
  if (v === "off") return null;
  if (v === "demo") {
    const script = parseScript(DEMO_SCRIPT);
    return script[bar % script.length];
  }
  return v as SimMode;
}

function start(): void {
  if (!chart) return;
  stop();
  audio ??= new AudioContext({ latencyHint: "interactive" });
  void audio.resume();
  const c = chart;
  const synth = new Synth(audio);
  const sinks: Sink[] = [];
  if ($<HTMLInputElement>("builtin").checked) sinks.push(synth);
  const outId = $<HTMLSelectElement>("midi-out").value;
  const out = outId ? midi.outputs().find((o) => o.id === outId) : undefined;
  if (out) sinks.push(new MidiSink(out, audio));
  const sink = new MultiSink(sinks);

  const engine = new Engine(c, { config: { loop: $<HTMLInputElement>("loop").checked } });
  const { leader, remote, every } = makeLeader(c);
  const tracker = new NoteTracker();
  const sim = new SimPlayer(Date.now() & 0xffff);
  const conductor = new Conductor(engine, leader, every, {
    onFeatures: (_bar, f) => overlay.setEnergy(f),
    onDecision: (reply, bar) => {
      if (!reply.moves.length && reply.source !== "rules") overlay.note(`bar ${bar}: ${reply.source} says keep going${reply.latencyMs ? ` (${reply.latencyMs} ms)` : ""}`);
      else if (reply.latencyMs) overlay.note(`bar ${bar}: ${reply.source} answered in ${reply.latencyMs} ms`);
      overlay.leaderStatus(leaderLabel(session!));
    },
    onSkip: (bar) => overlay.note(`bar ${bar}: bandleader still thinking, skipped a turn`),
  });
  const ctx = audio;
  const transport = new Transport(engine, { now: () => ctx.currentTime }, sink, {
    onCommit: (plan, startBeat) => {
      const mode = simModeFor(plan.bar);
      if (!mode) return;
      for (const n of sim.play(plan, mode, c.beatsPerBar)) {
        transport.inject({ ...n, part: "player" }, startBeat + n.start);
        tracker.noteOn(startBeat + n.start, n.note, n.vel);
        tracker.noteOff(startBeat + n.start + n.dur, n.note);
      }
    },
    onBarStart: (plan) => overlay.bar(plan),
    onBarEnd: (plan, startBeat) => conductor.barFinished(plan, tracker.bar(startBeat, c.beatsPerBar)),
    onEnd: () => {
      overlay.note("End of the form.");
      stop();
    },
  });
  const ticker = new Ticker(() => transport.tick());
  session = { engine, transport, conductor, ticker, tracker, synth, remote };
  overlay.reset(c.title);
  overlay.leaderStatus(leaderLabel(session));
  transport.start();
  ticker.start();
  $<HTMLButtonElement>("start").disabled = true;
  $<HTMLButtonElement>("stop").disabled = false;
}

function stop(): void {
  if (!session) return;
  session.ticker.stop();
  session.transport.stop();
  for (const release of held.values()) release();
  held.clear();
  session = null;
  $<HTMLButtonElement>("start").disabled = false;
  $<HTMLButtonElement>("stop").disabled = true;
}

$("start").onclick = start;
$("stop").onclick = stop;
$("leader-select").onchange = () => {
  if (session && chart) {
    const { leader, remote, every } = makeLeader(chart);
    session.conductor.leader = leader;
    session.conductor.everyBars = every;
    session.remote = remote;
    overlay.leaderStatus(leaderLabel(session));
  }
};

void loadCharts();
void checkServer();
void initMidi();
