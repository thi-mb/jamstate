// Page wiring: chart loading, controls, and one jam session at a time.

import { MidiSink, Midi, MultiSink } from "./audio/midi";
import { Synth } from "./audio/synth";
import { Ticker } from "./audio/ticker";
import { ChartError, loadChart, type Chart, type ChartJSON } from "./core/chart";
import { Conductor, ruleLeader, type Leader } from "./core/conductor";
import { Engine } from "./core/engine";
import { NoteTracker } from "./core/features";
import { allGenres, getGenre } from "./core/genres";
import type { Move } from "./core/moves";
import { RuleLeader } from "./core/rules";
import { checkSession, replaySession, sessionEngine, SessionRecorder, summarizeBar, type SessionFile } from "./core/session";
import { DEMO_SCRIPT, parseScript, SimPlayer, type SimMode } from "./core/simplayer";
import { Transport, type Sink } from "./core/transport";
import { FEELS, STINGERS } from "./core/types";
import { RemoteLeader } from "./leader/remote";
import { attachKeyboard } from "./ui/keyboard";
import { Overlay } from "./ui/overlay";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const overlay = new Overlay();
const midi = new Midi();
let chart: Chart | null = null;
let chartRaw: ChartJSON | null = null;
let chartJson = "";
let audio: AudioContext | null = null;
let session: Session | null = null;
/** The last jam (running or stopped), ready to save. */
let lastJam: { recorder: SessionRecorder; engine: Engine } | null = null;
/** A session opened for replay. */
let replayFile: SessionFile | null = null;

interface Session {
  engine: Engine;
  transport: Transport;
  conductor: Conductor;
  ticker: Ticker;
  tracker: NoteTracker;
  synth: Synth;
  remote: RemoteLeader | null;
  recorder: SessionRecorder | null;
  /** Playing back a recorded session: live input and the genre/swing pickers are ignored. */
  replay: boolean;
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
  chartRaw = raw as ChartJSON;
  chartJson = JSON.stringify(raw, null, 2);
  fillGenres();
  ($("chart-json") as HTMLTextAreaElement).value = chartJson;
  const bars = chart.form.reduce((n, s) => n + chart!.sections.get(s)!.bars, 0);
  $("chart-info").textContent = `${source}: ${chart.bpm} bpm, ${chart.beatsPerBar}/4${chart.key ? `, ${chart.key}` : ""}, ${getGenre(chart.genre).name.toLowerCase()}, ${bars} bars`;
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

// ---------- genre and swing ----------

function fillGenres(): void {
  const sel = $<HTMLSelectElement>("genre-select");
  const keep = sel.value;
  const own = getGenre(chart?.genre);
  sel.replaceChildren(new Option(`song's genre (${own.name})`, ""), ...allGenres().map((g) => new Option(g.name, g.id)));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
  sel.title = pickedGenre().description;
}

/** The genre picked in the page, or the chart's own. */
function pickedGenre() {
  return getGenre($<HTMLSelectElement>("genre-select").value || chart?.genre);
}

function pickedSwing(): number | null {
  const v = $<HTMLSelectElement>("swing-select").value;
  return v === "" ? null : Number(v);
}

$("genre-select").onchange = () => {
  $("genre-select").title = pickedGenre().description;
  if (session && !session.replay) session.engine.setGenre(pickedGenre());
  buildManualMoves();
};
$("swing-select").onchange = () => {
  if (session && !session.replay) session.engine.setSwing(pickedSwing());
};

// ---------- manual moves ----------

function submitManual(move: Move): void {
  if (!session) return overlay.note("Start the band first");
  if (session.replay) return overlay.note("This is a replay: it plays what was recorded");
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
    ...pickedGenre().parts.flatMap((p) => [btn(`+${p}`, { move: "add_layer", part: p, reason: "Manual" }), btn(`−${p}`, { move: "drop_layer", part: p, reason: "Manual" })]),
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
    el.textContent = "No jamstate server reachable: the LLM leader will fall back to rules.";
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
  $("midi-out").onchange = listenMidi;
  refresh();
}

function listenMidi(): void {
  unlistenMidi?.();
  const outId = $<HTMLSelectElement>("midi-out").value;
  const outName = outId ? midi.outputs().find((o) => o.id === outId)?.name : undefined;
  unlistenMidi = midi.listen($<HTMLSelectElement>("midi-in").value, (on, note, vel, ts) => {
    // MIDI timestamps are on the performance.now() timeline; map to the audio clock.
    const t = audio ? audio.currentTime - Math.max(0, performance.now() - ts) / 1000 : 0;
    playerNote(on, note, vel, t);
  }, outName);
}

// ---------- player input ----------

const held = new Map<number, () => void>();

function playerNote(on: boolean, note: number, vel: number, audioTime?: number): void {
  if (!audio || !session || session.replay) return;
  const beat = session.transport.beatAt(audioTime ?? audio.currentTime);
  session.recorder?.note(beat, note, on ? vel : 0);
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

function makeSink(ctx: AudioContext, synth: Synth): Sink {
  const sinks: Sink[] = [];
  if ($<HTMLInputElement>("builtin").checked) sinks.push(synth);
  const outId = $<HTMLSelectElement>("midi-out").value;
  const out = outId ? midi.outputs().find((o) => o.id === outId) : undefined;
  if (out) sinks.push(new MidiSink(out, ctx));
  return new MultiSink(sinks);
}

function setRunning(running: boolean): void {
  $<HTMLButtonElement>("start").disabled = running;
  $<HTMLButtonElement>("stop").disabled = !running;
  $<HTMLButtonElement>("end-song").disabled = !running || !!session?.replay;
  $<HTMLButtonElement>("session-play").disabled = running || !replayFile;
}

/** Start a jam, or play back a recorded session when `replay` is given. */
function start(replay?: SessionFile): void {
  if (!chart && !replay) return;
  stop();
  audio ??= new AudioContext({ latencyHint: "interactive" });
  void audio.resume();
  const c = replay ? loadChart(replay.chart) : chart!;
  const synth = new Synth(audio);
  const sink = makeSink(audio, synth);

  const seed = (Math.random() * 0x7fffffff) | 0;
  const config = { loop: $<HTMLInputElement>("loop").checked };
  const genre = pickedGenre();
  const swing = pickedSwing();
  const engine = replay
    ? sessionEngine(replay, replay.controls)
    : new Engine(c, { config, seed, genre, swing, countIn: c.countIn });
  const { leader, remote, every } = replay ? { leader: null, remote: null, every: replay.every_bars } : makeLeader(c);
  const recorder = replay
    ? null
    : new SessionRecorder({ chart: chartRaw!, genre: genre.id, swing, seed, countIn: c.countIn, config, leader: $<HTMLSelectElement>("leader-select").value, everyBars: every });
  if (recorder) lastJam = { recorder, engine };
  const tracker = new NoteTracker();
  const sim = new SimPlayer(seed & 0xffff);
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
  const replayNotes = replay ? pairNotes(replay) : [];
  let mismatches = 0;
  const transport = new Transport(engine, { now: () => ctx.currentTime }, sink, {
    onCommit: (plan, startBeat) => {
      recorder?.bar(plan);
      updateSessionStatus();
      if (replay) {
        const want = replay.bars[plan.bar];
        if (want && want.hash !== summarizeBar(plan).hash) {
          mismatches++;
          overlay.note(`bar ${plan.bar}: plays differently from the recording`);
        }
        for (const n of replayNotes) {
          if (n.start < startBeat || n.start >= startBeat + c.beatsPerBar) continue;
          transport.inject({ start: 0, dur: n.dur, note: n.note, vel: n.vel, part: "player" }, n.start);
          tracker.noteOn(n.start, n.note, n.vel);
          tracker.noteOff(n.start + n.dur, n.note);
        }
        return;
      }
      if (plan.kind === "count_in") return;
      const mode = simModeFor(plan.bar);
      if (!mode) return;
      for (const n of sim.play(plan, mode, c.beatsPerBar)) {
        transport.inject({ ...n, part: "player" }, startBeat + n.start);
        tracker.noteOn(startBeat + n.start, n.note, n.vel);
        tracker.noteOff(startBeat + n.start + n.dur, n.note);
        recorder?.note(startBeat + n.start, n.note, n.vel);
        recorder?.note(startBeat + n.start + n.dur, n.note, 0);
      }
    },
    onBarStart: (plan) => {
      overlay.bar(plan);
      if (replay && plan.bar >= replay.bars.length - 1) overlay.note("Last recorded bar.");
    },
    onBarEnd: (plan, startBeat) => {
      conductor.barFinished(plan, tracker.bar(startBeat, c.beatsPerBar));
      if (replay && plan.bar >= replay.bars.length - 1) {
        overlay.note(mismatches ? `Replay done: ${mismatches} bars differed.` : "Replay done: every bar matched the recording.");
        stop();
      }
    },
    onEnd: () => {
      overlay.note(engine.log.some((m) => m.label === "end_song" && m.status === "applied") ? "The end." : "End of the form.");
      stop();
    },
  });
  const ticker = new Ticker(() => transport.tick());
  session = { engine, transport, conductor, ticker, tracker, synth, remote, recorder, replay: !!replay };
  overlay.reset(replay ? `Replay: ${replay.title}` : c.title);
  if (replay) overlay.setForm(c.form);
  overlay.leaderStatus(replay ? "replay" : leaderLabel(session));
  transport.start();
  ticker.start();
  setRunning(true);
}

function stop(): void {
  if (!session) return;
  session.ticker.stop();
  session.transport.stop();
  for (const release of held.values()) release();
  held.clear();
  session = null;
  setRunning(false);
  updateSessionStatus();
}

$("start").onclick = () => start();
$("stop").onclick = stop;
$("end-song").onclick = () => submitManual({ move: "end_song", reason: "You called the ending" });
$("leader-select").onchange = () => {
  if (session && chart && !session.replay) {
    const { leader, remote, every } = makeLeader(chart);
    session.conductor.leader = leader;
    session.conductor.everyBars = every;
    session.remote = remote;
    overlay.leaderStatus(leaderLabel(session));
  }
};

// ---------- recording and replay ----------

/** Recorded on/off events → notes with start and length, in absolute beats. */
function pairNotes(f: SessionFile): { start: number; dur: number; note: number; vel: number }[] {
  const open = new Map<number, { start: number; vel: number }>();
  const out: { start: number; dur: number; note: number; vel: number }[] = [];
  for (const [beat, note, vel] of f.player) {
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

function updateSessionStatus(): void {
  const has = !!lastJam && lastJam.recorder.barCount > 0;
  $<HTMLButtonElement>("session-download").disabled = !has;
  $<HTMLButtonElement>("session-save").disabled = !has;
  if (!lastJam) return;
  const r = lastJam.recorder;
  $("session-status").textContent = `${session && !session.replay ? "Recording" : "Recorded"}: ${r.setup.chart.title}, ${r.barCount} bars.`;
}

function currentFile(): SessionFile | null {
  return lastJam ? lastJam.recorder.finish(lastJam.engine) : null;
}

function fileName(f: SessionFile): string {
  const slug = f.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "session";
  return `${f.created.slice(0, 19).replace(/[:T]/g, "-")}-${slug}.json`;
}

$("session-download").onclick = () => {
  const f = currentFile();
  if (!f) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(f)], { type: "application/json" }));
  a.download = fileName(f);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

$("session-save").onclick = async () => {
  const f = currentFile();
  if (!f) return;
  const res = $("session-result");
  try {
    const r = await fetch("api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f), signal: AbortSignal.timeout(10_000) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    res.textContent = `Saved on the Spark as ${body.name}`;
    res.className = "small";
    void listSessions();
  } catch (e) {
    res.textContent = `Couldn't save on the Spark (${(e as Error).message}). Use Download instead.`;
    res.className = "small errors";
  }
};

function openReplay(raw: unknown, label: string): void {
  const res = $("session-result");
  try {
    replayFile = checkSession(raw);
    res.className = "small";
    res.textContent = `${label}: ${replayFile.title}, ${replayFile.genre}, ${replayFile.bars.length} bars, leader ${replayFile.leader}, recorded ${replayFile.created.slice(0, 16).replace("T", " ")}.`;
  } catch (e) {
    replayFile = null;
    res.className = "small errors";
    res.textContent = `Can't replay ${label}: ${(e as Error).message}`;
  }
  $<HTMLButtonElement>("session-check").disabled = !replayFile;
  setRunning(!!session);
}

async function listSessions(): Promise<void> {
  const sel = $<HTMLSelectElement>("session-list");
  try {
    const r = await fetch("api/sessions", { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return;
    const list: { name: string; title: string; bars: number }[] = (await r.json()).sessions ?? [];
    sel.replaceChildren(new Option(list.length ? "sessions saved on the Spark…" : "no sessions on the Spark yet", ""), ...list.map((s) => new Option(`${s.name} (${s.bars} bars)`, s.name)));
  } catch {
    /* no server: file replay still works */
  }
}

$("session-list").onchange = async () => {
  const name = $<HTMLSelectElement>("session-list").value;
  if (!name) return;
  try {
    const r = await fetch(`api/sessions/${encodeURIComponent(name)}`);
    openReplay(await r.json(), name);
  } catch (e) {
    openReplay(null, `${name} (${(e as Error).message})`);
  }
};

$("session-file").onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    openReplay(JSON.parse(await file.text()), file.name);
  } catch (err) {
    openReplay(null, `${file.name} (${(err as Error).message})`);
  }
};

$("session-check").onclick = async () => {
  if (!replayFile) return;
  const res = $("session-result");
  try {
    const a = await replaySession(replayFile);
    const b = await replaySession(replayFile);
    const same = a.bars.every((x, i) => x.hash === b.bars[i]?.hash);
    res.className = a.mismatches.length || !same ? "small errors" : "small";
    res.textContent = a.mismatches.length
      ? `${a.mismatches.length} of ${a.bars.length} bars play differently from the recording (first: bar ${a.mismatches[0].bar}).`
      : `All ${a.bars.length} bars replay exactly${same ? ", twice in a row" : ", but two replays differ"}.`;
  } catch (e) {
    res.className = "small errors";
    res.textContent = `Replay failed: ${(e as Error).message}`;
  }
};

$("session-play").onclick = () => {
  if (replayFile) start(replayFile);
};

void loadCharts();
void checkServer();
void initMidi();
void listSessions();
