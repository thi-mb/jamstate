// Page wiring: chart loading, controls, and one jam session at a time.

import { MidiSink, MultiSink } from "./audio/midi";
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
import {
  BLIND_NAMES, BRAIN_LABELS, BrainLeader, blindCandidates, blindLeader, isBlind, makeBrain, mergeSettings, pickBlind, summarizeBlind,
  type BrainKind, type BrainSettings, type LeaderChoice,
} from "./core/brain";
import { genreIds } from "./core/genres";
import type { SessionMeta, SessionStore } from "./core/platform";
import { ServerSessionStore, webPlatform } from "./platform/web";
import { attachKeyboard } from "./ui/keyboard";
import { Overlay } from "./ui/overlay";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const overlay = new Overlay();
let audio: AudioContext | null = null;
const getAudio = () => (audio ??= new AudioContext({ latencyHint: "interactive" }));
const platform = webPlatform(getAudio);
const midi = platform.midi;
/** The companion server (the Spark, or a local one), if this page was served by one. */
let server: { sessions: boolean; relay: { llm: boolean; jev: boolean; anthropic: boolean } } | null = null;
const spark: SessionStore = new ServerSessionStore();
let chart: Chart | null = null;
let chartRaw: ChartJSON | null = null;
let chartJson = "";
let session: Session | null = null;
/** The last jam (running or stopped), ready to save. */
let lastJam: { recorder: SessionRecorder; engine: Engine } | null = null;
/** A session opened for replay. */
let replayFile: SessionFile | null = null;
/** Blind test: the brain secretly playing this jam, whether it ever failed, and how often each was tried. */
let jamKind: BrainKind | null = null;
let jamFallback = false;
let blindTried: Partial<Record<BrainKind, number>> = {};
/** Brains that answered the blind-test check; null until checked. */
let blindReady: BrainKind[] | null = null;

interface Session {
  engine: Engine;
  transport: Transport;
  conductor: Conductor;
  ticker: Ticker;
  tracker: NoteTracker;
  synth: Synth;
  remote: BrainLeader | null;
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
  const brain = makeBrain(settings);
  if (!brain?.writeChart) {
    $("chart-errors").textContent = "Writing a chart needs an LLM brain: pick OpenAI-compatible or Claude under Bandleader.";
    return;
  }
  const btn = $<HTMLButtonElement>("chart-ask");
  btn.disabled = true;
  $("chart-errors").textContent = "";
  $("chart-info").textContent = `Asking ${brain.label} for a chart…`;
  try {
    const res = await brain.writeChart(prompt, genreIds(), AbortSignal.timeout(90_000));
    if (useChart(res.chart, `${brain.label} chart (${res.latencyMs} ms)`)) $("chart-editor").hidden = false;
    else $("chart-info").textContent = "The model's chart has problems; fix it in the editor.";
    ($("chart-json") as HTMLTextAreaElement).value = JSON.stringify(res.chart, null, 2);
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

// ---------- brain (bandleader) ----------

const SETTINGS_KEY = "jamstate.brain";
let settings: BrainSettings = mergeSettings(platform.settings.get(SETTINGS_KEY));

const field = (id: string) => $<HTMLInputElement>(id);
const BRAIN_FIELDS: [string, (s: BrainSettings) => string, (s: BrainSettings, v: string) => void][] = [
  ["openai-url", (s) => s.openai.url, (s, v) => (s.openai.url = v)],
  ["openai-model", (s) => s.openai.model, (s, v) => (s.openai.model = v)],
  ["openai-key", (s) => s.openai.apiKey, (s, v) => (s.openai.apiKey = v)],
  ["claude-model", (s) => s.claude.model, (s, v) => {
    if (v !== s.claude.model) s.claude.modelChosen = true;
    s.claude.model = v;
  }],
  ["claude-key", (s) => s.claude.apiKey, (s, v) => (s.claude.apiKey = v)],
  ["jev-model", (s) => s.jev.model, (s, v) => (s.jev.model = v)],
  ["jev-key", (s) => s.jev.apiKey, (s, v) => (s.jev.apiKey = v)],
  ["jev-url", (s) => s.jev.url, (s, v) => (s.jev.url = v)],
  ["laya-url", (s) => s.laya.url, (s, v) => (s.laya.url = v)],
];

function showBrainSettings(): void {
  const sel = $<HTMLSelectElement>("leader-select");
  if (!sel.options.length) sel.replaceChildren(...(Object.keys(BRAIN_LABELS) as LeaderChoice[]).map((k) => new Option(BRAIN_LABELS[k], k)));
  sel.value = settings.kind;
  for (const [id, get] of BRAIN_FIELDS) field(id).value = get(settings);
  field("jev-relay").checked = settings.jev.relay;
  field("jev-url").disabled = !settings.jev.relay;
  for (const k of ["openai", "claude", "jev", "laya", "blind"]) $(`brain-${k}`).hidden = settings.kind !== k;
  if (settings.kind === "blind") {
    showBlindPool();
    if (!blindReady && !blindChecking && serverChecked) void checkBlind();
  }
  $("brain-keys-note").hidden = !["openai", "claude", "jev"].includes(settings.kind);
  $<HTMLButtonElement>("brain-test").disabled = settings.kind === "none";
}

function saveBrainSettings(): void {
  const next = mergeSettings(settings);
  next.kind = $<HTMLSelectElement>("leader-select").value as LeaderChoice;
  for (const [id, , set] of BRAIN_FIELDS) set(next, field(id).value.trim());
  next.jev.relay = field("jev-relay").checked;
  if (JSON.stringify({ ...next, kind: "" }) !== JSON.stringify({ ...settings, kind: "" })) blindReady = null;
  settings = next;
  platform.settings.set(SETTINGS_KEY, settings);
  showBrainSettings();
  if (session && chart && !session.replay) {
    const { leader, remote, every } = makeLeader(chart);
    session.conductor.leader = leader;
    session.conductor.everyBars = every;
    session.remote = remote;
    overlay.leaderStatus(leaderLabel(session));
  }
}

$("leader-select").onchange = saveBrainSettings;
for (const [id] of BRAIN_FIELDS) field(id).onchange = saveBrainSettings;
field("jev-relay").onchange = saveBrainSettings;

/** A sample phrase: the player got busy over four bars. */
const SAMPLE_CONTEXT = {
  bar: 15, section: "verse", bar_in_section: 3, section_bars: 8, phrase_bars: 4, intensity: 0.4, target: 0.4,
  layers: ["drums", "bass", "chords"], feel: "normal", form: ["intro", "verse", "chorus"], form_pos: 1, sections: ["intro", "verse", "chorus"],
  player: { bars: 4, energy: 0.8, density: 3.1, mean_velocity: 0.8, rest_ratio: 0.1, repetition: 0.2, register: "mid", trend: "rising", silent_bars: 0 },
  recent_moves: [],
} as const;

$("brain-test").onclick = async () => {
  if (settings.kind === "blind") return void checkBlind();
  const brain = makeBrain(settings);
  const out = $("brain-result");
  if (!brain) return;
  out.className = "small dim";
  out.textContent = `Asking ${brain.label}…`;
  try {
    const a = await brain.decide(structuredClone(SAMPLE_CONTEXT) as never, AbortSignal.timeout(20_000));
    out.className = "small";
    const moves = a.moves.map((m) => `${m.move}: “${m.reason}”`).join("; ") || "keep going";
    out.textContent = `${a.model ?? brain.label}, ${a.latencyMs} ms: ${moves}${a.rejected.length ? ` (${a.rejected.length} rejected: ${a.rejected[0].error})` : ""}`;
  } catch (e) {
    out.className = "small errors";
    out.textContent = `${brain.label} failed: ${(e as Error).message}`;
  }
};

async function checkServer(): Promise<void> {
  const el = $("server-status");
  try {
    const r = await fetch("api/health", { signal: AbortSignal.timeout(2000) });
    const h = await r.json();
    if (!h.ok) throw new Error("not a jamstate server");
    server = { sessions: !!h.sessions, relay: { llm: !!h.relay?.llm, jev: !!h.relay?.jev, anthropic: !!h.relay?.anthropic } };
    const relays = [server.relay.llm && `LLM ${h.model ?? ""}`.trim(), server.relay.jev && "Jev", server.relay.anthropic && "Claude"].filter(Boolean).join(", ");
    el.textContent = `jamstate server here${relays ? ` · relays ${relays}` : ""}${server.sessions ? " · session sync" : ""}`;
  } catch {
    server = null;
    el.textContent = "Standalone: no jamstate server. Rules, Claude and direct LLM endpoints work; Jev (the default) needs the server's relay, so the band plays with rules here.";
  }
  $("session-save").hidden = !server?.sessions;
  serverChecked = true;
  blindReady = null;
  showBrainSettings();
  void listSessions();
}

/** Jev goes through the server's relay; a page without one plays with rules instead of failing every phrase. */
function jevReachable(): boolean {
  return settings.kind !== "jev" || !settings.jev.relay || !serverChecked || !!server?.relay.jev;
}

// ---------- blind test ----------

const blindEnv = () => ({ llmRelay: !!server?.relay.llm, jevRelay: !!server?.relay.jev, claudeRelay: !!server?.relay.anthropic });
const blindPool = () => blindReady ?? blindCandidates(settings, blindEnv());

function showBlindPool(): void {
  const all: BrainKind[] = ["rules", "openai", "claude", "jev", "laya"];
  const pool = blindPool();
  const why: Record<BrainKind, string> = {
    rules: "",
    openai: blindReady ? "didn't answer" : "needs the Spark's relay or a direct endpoint",
    claude: blindReady && (settings.claude.apiKey || server?.relay.anthropic) ? "didn't answer" : "no key: pick Claude above and paste one, or give the server ANTHROPIC_API_KEY",
    jev: blindReady ? "didn't answer" : "needs the jamstate server's relay",
    laya: blindReady ? "not answering: start localbrain/laya_server.py on this machine, then Test" : "press Test to look for it on this machine (localbrain/)",
  };
  const out = all.filter((k) => !pool.includes(k)).map((k) => `${BLIND_NAMES[k]} (${why[k]})`);
  $("blind-pool").textContent = `In the pool: ${pool.map((k) => BLIND_NAMES[k]).join(", ")}${blindReady ? " (checked)" : ""}.${out.length ? ` Left out: ${out.join("; ")}.` : ""}`;
}

/** Ask each candidate once; only the ones that answer go in the pool. */
let blindChecking = false;
/** The server probe is done, so the blind check knows which relays exist. */
let serverChecked = false;
async function checkBlind(): Promise<void> {
  blindChecking = true;
  const out = $("brain-result");
  out.className = "small dim";
  out.textContent = "Checking each brain…";
  // Laya runs on the player's machine, so it can only be found by asking it.
  const cands: BrainKind[] = [...blindCandidates(settings, blindEnv()), "laya"];
  const ok = await Promise.all(
    cands.map(async (k) => {
      try {
        await makeBrain({ ...settings, kind: k })!.decide(structuredClone(SAMPLE_CONTEXT) as never, AbortSignal.timeout(20_000));
        return k;
      } catch {
        return null;
      }
    }),
  );
  blindReady = ok.filter((k): k is BrainKind => !!k);
  blindChecking = false;
  out.className = "small";
  out.textContent = `${blindReady.length} of ${cands.length} brains answered.`;
  showBlindPool();
}

function showRatingPanel(show: boolean): void {
  $("blind-rate").hidden = !show;
  if (!show) return;
  stars = 0;
  for (const b of $("blind-stars").querySelectorAll("button")) b.classList.remove("on");
  field("blind-note").value = "";
  $("blind-rate-result").textContent = "";
}

let stars = 0;
$("blind-stars").replaceChildren(
  ...["1 bad", "2 meh", "3 ok", "4 good", "5 great"].map((t, i) => {
    const b = Object.assign(document.createElement("button"), { textContent: t });
    b.onclick = () => {
      stars = i + 1;
      for (const o of $("blind-stars").querySelectorAll("button")) o.classList.toggle("on", o === b);
    };
    return b;
  }),
);

$("blind-save").onclick = async () => {
  const f = currentFile();
  const res = $("blind-rate-result");
  if (!f || !isBlind(f.leader)) return;
  if (!stars) return void (res.textContent = "Pick 1 to 5 first.");
  f.rating = { stars, ...(field("blind-note").value.trim() ? { note: field("blind-note").value.trim() } : {}), ...(jamFallback ? { fallback: true } : {}) };
  try {
    await platform.sessions.save(f);
    let where = platform.sessions.label;
    if (server?.sessions) {
      try {
        await spark.save(f);
        where += ` and ${spark.label}`;
      } catch {
        /* kept in the browser; Sync to Spark can retry */
      }
    }
    res.textContent = `Saved in ${where}. Start another jam for the next hidden brain.`;
    void listSessions();
  } catch (e) {
    res.textContent = `Couldn't save the rating (${(e as Error).message}).`;
  }
};

$("blind-results-btn").onclick = async () => {
  const out = $("blind-results");
  const files: SessionFile[] = [];
  for (const m of await platform.sessions.list()) if (isBlind(m.leader)) files.push(await platform.sessions.load(m.name));
  const rows = summarizeBlind(files);
  if (!rows.length) return void (out.textContent = "No blind jams yet.");
  out.replaceChildren(
    ...rows.map((r) =>
      Object.assign(document.createElement("div"), {
        textContent: `${BLIND_NAMES[r.brain]}: ${r.mean === null ? "not rated" : `${r.mean.toFixed(1)} / 5`} over ${r.rated} rated of ${r.jams} jams${r.notes.length ? ` · “${r.notes.join("”, “")}”` : ""}`,
      }),
    ),
  );
};

function makeLeader(c: Chart): { leader: Leader | null; remote: BrainLeader | null; every: number } {
  const rules = new RuleLeader();
  const blind = settings.kind === "blind";
  if (blind && !jamKind) {
    jamKind = pickBlind(blindPool(), blindTried);
    jamFallback = false;
  }
  const brain = makeBrain(blind ? { ...settings, kind: jamKind! } : jevReachable() ? settings : { ...settings, kind: "rules" });
  if (!brain) return { leader: null, remote: null, every: 4 };
  if (brain.kind === "rules") return { leader: ruleLeader(rules), remote: null, every: 2 };
  const phraseMs = (c.phraseBars * c.beatsPerBar * 60_000) / c.bpm;
  const remote = new BrainLeader(brain, rules, {
    timeoutMs: phraseMs,
    onAnswer: (_ctx, a, err) => {
      const name = blind ? "bandleader" : brain.label;
      if (err) jamFallback = true;
      if (a?.rejected.length) overlay.note(`${name}: ${a.rejected.length} move(s) rejected${blind ? "" : ` (${a.rejected[0].error})`}`);
      if (err) overlay.note(blind ? "bandleader: no answer this phrase" : `${brain.label}: ${err}`);
    },
  });
  return { leader: remote, remote, every: c.phraseBars };
}

function leaderLabel(s: Session): string {
  if (!s.conductor.leader) return "off";
  if (jamKind && !s.replay) return "hidden brain (blind test)";
  if (!s.remote) return jevReachable() ? "rules" : "rules (Jev needs the jamstate server)";
  const st = s.remote.status;
  const name = s.remote.brain.label;
  if (st.mode === "fallback") return `rules (${name} down: ${st.lastError ?? "?"})`;
  return `${name}${st.model && !name.includes(st.model) ? ` (${st.model})` : ""}${st.lastLatencyMs ? ` · ${st.lastLatencyMs} ms` : ""}${st.failures ? ` · ${st.failures} failed` : ""}`;
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
    inSel.replaceChildren(new Option("all inputs", "all"), ...midi.inputs().map((i) => new Option(i.name, i.id)));
    outSel.replaceChildren(new Option("none", ""), ...midi.outputs().map((o) => new Option(o.name, o.id)));
    inSel.value = [...inSel.options].some((o) => o.value === keepIn) ? keepIn : "all";
    outSel.value = [...outSel.options].some((o) => o.value === keepOut) ? keepOut : "";
    $("midi-status").textContent = `${midi.inputs().length} MIDI in, ${midi.outputs().length} MIDI out`;
    listenMidi();
  };
  midi.onChange(refresh);
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
  audio = getAudio();
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
  if (!replay) jamKind = null;
  showRatingPanel(false);
  overlay.blind = replay ? isBlind(replay.leader) : settings.kind === "blind";
  const { leader, remote, every } = replay ? { leader: null, remote: null, every: replay.every_bars } : makeLeader(c);
  const recorder = replay
    ? null
    : new SessionRecorder({ chart: chartRaw!, genre: genre.id, swing, seed, countIn: c.countIn, config, leader: leaderName(), everyBars: every });
  if (recorder) lastJam = { recorder, engine };
  const tracker = new NoteTracker();
  const sim = new SimPlayer(seed & 0xffff);
  const conductor = new Conductor(engine, leader, every, {
    onFeatures: (_bar, f) => overlay.setEnergy(f),
    onDecision: (reply, bar) => {
      if (overlay.blind) return overlay.leaderStatus(leaderLabel(session!));
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
  const wasLive = !session.replay;
  session.ticker.stop();
  session.transport.stop();
  for (const release of held.values()) release();
  held.clear();
  session = null;
  setRunning(false);
  updateSessionStatus();
  if (wasLive) void keepJam();
  if (wasLive && jamKind && lastJam?.recorder) showRatingPanel(true);
}

$("start").onclick = () => start();
$("stop").onclick = stop;
$("end-song").onclick = () => submitManual({ move: "end_song", reason: "You called the ending" });

/** What the recording says played: "rules", "none", or the brain and model ("jev", "openai:leader"). */
function leaderName(): string {
  if (settings.kind === "blind" && jamKind) return blindLeader(jamKind);
  if (settings.kind === "openai") return `openai:${settings.openai.model}`;
  if (settings.kind === "claude") return `claude:${settings.claude.model}`;
  if (!jevReachable()) return "rules";
  return settings.kind;
}

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

function download(f: SessionFile): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(f)], { type: "application/json" }));
  a.download = fileName(f);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Keep the jam that just stopped in browser storage (ADR-0015). */
async function keepJam(): Promise<void> {
  const f = currentFile();
  if (!f || !f.bars.length) return;
  const res = $("session-result");
  try {
    const name = await platform.sessions.save(f);
    await listSessions(`b:${name}`);
    res.className = "small";
    res.textContent = `Kept in ${platform.sessions.label}: ${f.title}, ${f.bars.length} bars. Pick it under Replay any time, or Download it.`;
  } catch (e) {
    res.className = "small errors";
    res.textContent = `Couldn't keep it in ${platform.sessions.label} (${(e as Error).message}). Use Download.`;
  }
}

$("session-download").onclick = () => {
  const f = currentFile();
  if (f) download(f);
};

$("session-save").onclick = async () => {
  const f = currentFile();
  if (!f) return;
  const res = $("session-result");
  try {
    const name = await spark.save(f);
    res.textContent = `Synced to ${spark.label} as ${name}`;
    res.className = "small";
    void listSessions();
  } catch (e) {
    res.textContent = `Couldn't sync to ${spark.label} (${(e as Error).message}). Use Download instead.`;
    res.className = "small errors";
  }
};

function openReplay(raw: unknown, label: string): void {
  const res = $("session-result");
  try {
    replayFile = checkSession(raw);
    res.className = "small";
    res.textContent = `${label}: ${replayFile.title}, ${replayFile.genre}, ${replayFile.bars.length} bars, leader ${isBlind(replayFile.leader) ? "hidden (blind test)" : replayFile.leader}, recorded ${replayFile.created.slice(0, 16).replace("T", " ")}.`;
  } catch (e) {
    replayFile = null;
    res.className = "small errors";
    res.textContent = `Can't replay ${label}: ${(e as Error).message}`;
  }
  $<HTMLButtonElement>("session-check").disabled = !replayFile;
  $<HTMLButtonElement>("session-export").disabled = !replayFile;
  $<HTMLButtonElement>("session-delete").disabled = !replayFile || !$<HTMLSelectElement>("session-list").value.startsWith("b:");
  setRunning(!!session);
}

const metaLabel = (s: SessionMeta) => `${s.created.slice(0, 16).replace("T", " ")} ${s.title} (${s.bars} bars${s.leader ? `, ${isBlind(s.leader) ? "blind" : s.leader}` : ""})`;

/** Sessions in this browser, plus the Spark's when a server is here. Values are "b:<name>" or "s:<name>". */
async function listSessions(select?: string): Promise<void> {
  const sel = $<HTMLSelectElement>("session-list");
  const groups: HTMLElement[] = [];
  let count = 0;
  for (const [prefix, store] of [["b", platform.sessions], ...(server?.sessions ? [["s", spark]] : [])] as [string, SessionStore][]) {
    try {
      const list = await store.list();
      count += list.length;
      if (prefix === "b") {
        blindTried = {};
        for (const m of list) if (isBlind(m.leader)) blindTried[m.leader!.slice(6) as BrainKind] = (blindTried[m.leader!.slice(6) as BrainKind] ?? 0) + 1;
      }
      if (!list.length) continue;
      const g = document.createElement("optgroup");
      g.label = `in ${store.label}`;
      g.append(...list.map((s) => new Option(metaLabel(s), `${prefix}:${s.name}`)));
      groups.push(g);
    } catch {
      /* that store is unavailable; the others still work */
    }
  }
  sel.replaceChildren(new Option(count ? "pick a session…" : "no sessions yet", ""), ...groups);
  if (select && [...sel.options].some((o) => o.value === select)) {
    sel.value = select;
    await pickSession();
  }
}

async function pickSession(): Promise<void> {
  const v = $<HTMLSelectElement>("session-list").value;
  if (!v) return;
  const store = v.startsWith("s:") ? spark : platform.sessions;
  const name = v.slice(2);
  try {
    openReplay(await store.load(name), name);
  } catch (e) {
    openReplay(null, `${name} (${(e as Error).message})`);
  }
}

$("session-list").onchange = () => void pickSession();

$("session-file").onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";
  let f: SessionFile;
  try {
    f = checkSession(JSON.parse(await file.text()));
  } catch (err) {
    return openReplay(null, `${file.name} (${(err as Error).message})`);
  }
  try {
    const name = await platform.sessions.save(f);
    await listSessions(`b:${name}`);
  } catch {
    openReplay(f, file.name);
  }
};

$("session-export").onclick = () => {
  if (replayFile) download(replayFile);
};

$("session-delete").onclick = async () => {
  const v = $<HTMLSelectElement>("session-list").value;
  if (!v.startsWith("b:") || !platform.sessions.remove) return;
  if (!confirm("Remove this session from this browser?")) return;
  await platform.sessions.remove(v.slice(2));
  replayFile = null;
  $("session-result").textContent = "Removed.";
  await listSessions();
  openReplay(null, "");
  $("session-result").textContent = "Removed.";
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

showBrainSettings();
void loadCharts();
void checkServer();
void initMidi();
void listSessions();
