// Page wiring: chart loading, controls, and one jam session at a time.

import { HitMonitor, MidiSink, MultiSink } from "./audio/midi";
import { SampleLibrary } from "./audio/sampler";
import { Synth } from "./audio/synth";
import { bandParts, cloneBand, defaultInstrument, getInstrument, instrumentsFor, playerInstruments, type Band } from "./core/band";
import { Ticker } from "./audio/ticker";
import { ChartError, loadChart, type Chart, type ChartJSON } from "./core/chart";
import { Conductor, ruleLeader, type Leader } from "./core/conductor";
import { TempoFollower } from "./core/tempo";
import { DEFAULT_PERSONALITY, PERSONALITIES, PERSONALITY_LABELS, type Personality } from "./core/leading";
import { Trader } from "./core/trade";
import { DEFAULT_LISTENING, LISTENING_LABELS, LISTENING_READY, listeningKey, NO_LISTENING, parseListening, type Listening } from "./core/listening";
import { CUE_LABELS, CUES, cueForKey, Engine, type BarPlan, type Cue } from "./core/engine";
import { NoteTracker } from "./core/features";
import { allGenres, getGenre } from "./core/genres";
import { exportSessionMidi } from "./core/midi-export";
import type { Move } from "./core/moves";
import { RuleLeader } from "./core/rules";
import { checkSession, replaySession, sessionBand, sessionEngine, SessionRecorder, summarizeBar, type SessionFile } from "./core/session";
import { DEMO_SCRIPT, parseScript, SimPlayer, type SimMode } from "./core/simplayer";
import { Transport, type Sink } from "./core/transport";
import { FEELS, PART_LABELS, PARTS, STINGERS, type Part } from "./core/types";
import {
  BLIND_NAMES, BRAIN_LABELS, BrainLeader, blindCandidates, blindLeader, isBlind, makeBrain, mergeSettings, pickBlind, summarizeBlind,
  type BrainKind, type BrainSettings, type LeaderChoice,
} from "./core/brain";
import { genreIds } from "./core/genres";
import type { SessionMeta, SessionStore } from "./core/platform";
import { ServerSessionStore, webPlatform } from "./platform/web";
import { renderSession } from "./render";
import { attachKeyboard } from "./ui/keyboard";
import { Overlay } from "./ui/overlay";
import { FretboardView } from "./ui/fretboard";
import { AudioInputPanel } from "./ui/audio-input";
import { VoicePanel } from "./ui/voice-input";
import { StudioDrawer } from "./ui/drawer";
import { RecapView } from "./ui/recap";
import { SR } from "./core/audio/dsp";
import { chordView, FRETBOARD_KINDS, FRETBOARD_MODES, TUNING_IDS, type FretboardKind, type FretboardMode, type Place, type TuningId } from "./core/fretboard";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const overlay = new Overlay();

let audio: AudioContext | null = null;
const getAudio = () => (audio ??= new AudioContext({ latencyHint: "interactive" }));
const platform = webPlatform(getAudio);
const drawer = new StudioDrawer(platform.settings);

// ---------- stage mute / solo / volume (v0.6) ----------

const mutedParts = new Set<Part>();
const soloParts = new Set<Part>();

function syncMuteSolo(): void {
  const hasSolo = soloParts.size > 0;
  for (const p of PARTS) {
    const silenced = mutedParts.has(p) || (hasSolo && !soloParts.has(p));
    if (session) {
      if (silenced) session.synth.muted.add(p);
      else session.synth.muted.delete(p);
      if (session.midiSink) {
        if (silenced) session.midiSink.muted.add(p);
        else session.midiSink.muted.delete(p);
      }
    }
  }
  overlay.setMuteSolo(mutedParts, soloParts);
}

overlay.musicianCb = {
  onMute: (p) => {
    if (mutedParts.has(p)) mutedParts.delete(p);
    else mutedParts.add(p);
    syncMuteSolo();
  },
  onSolo: (p) => {
    if (soloParts.has(p)) soloParts.delete(p);
    else soloParts.add(p);
    syncMuteSolo();
  },
  onVolume: (p, vol) => {
    session?.synth.setVolume(p, vol);
    // Keep the matching Studio fader in sync.
    const row = $("band-parts").querySelector<HTMLElement>(`.band-part[data-part="${p}"]`);
    const slider = row?.querySelector<HTMLInputElement>("input[type=range]");
    if (slider) slider.value = String(vol);
  },
};

function updateSongPill(): void {
  const el = document.getElementById("pill-song");
  if (!el || !chart) return;
  el.textContent = `${chart.title} · ${pickedGenre().name} · ${chart.bpm} bpm`;
}

function updateInputPill(): void {
  const el = document.getElementById("pill-input");
  if (!el) return;
  const parts: string[] = [];
  if ($<HTMLSelectElement>("audio-in").value) parts.push("Audio");
  if ($<HTMLSelectElement>("voice-in").value) parts.push("Voice");
  if (!parts.length) parts.push("Keys / MIDI");
  el.textContent = parts.join(" + ");
  el.classList.toggle("live", !!($<HTMLSelectElement>("audio-in").value || $<HTMLSelectElement>("voice-in").value));
}

function sectionBarsOf(c: Chart): number[] {
  return c.form.map((s) => c.sections.get(s)?.bars ?? 4);
}

function mixVolumesOf(gId: string): Partial<Record<Part, number>> {
  const mix = getGenre(gId).mix.parts;
  const out: Partial<Record<Part, number>> = {};
  for (const p of PARTS) out[p] = band[p]?.volume ?? mix[p]?.volume ?? 0.8;
  return out;
}

// ---------- fretboard (v0.3) ----------

const FRETBOARD_KEY = "jamstate.fretboard";
const fretboard = new FretboardView($("fretboard"));
const fretboardKind = $<HTMLSelectElement>("fretboard-kind");
{
  const saved = platform.settings.get<FretboardKind>(FRETBOARD_KEY);
  fretboardKind.value = saved && FRETBOARD_KINDS.includes(saved) ? saved : "guitar";
  fretboard.setKind(fretboardKind.value as FretboardKind);
  fretboardKind.addEventListener("change", () => {
    platform.settings.set(FRETBOARD_KEY, fretboardKind.value);
    fretboard.setKind(fretboardKind.value as FretboardKind);
    fretboardMode.disabled = fretboardKind.value === "off";
  });
}
const FRETBOARD_MODE_KEY = "jamstate.fretboardMode";
const fretboardMode = $<HTMLSelectElement>("fretboard-mode");
{
  const saved = platform.settings.get<FretboardMode>(FRETBOARD_MODE_KEY);
  fretboardMode.value = saved && FRETBOARD_MODES.includes(saved) ? saved : "scale";
  fretboardMode.disabled = fretboardKind.value === "off";
  fretboard.setMode(fretboardMode.value as FretboardMode);
  fretboardMode.addEventListener("change", () => {
    platform.settings.set(FRETBOARD_MODE_KEY, fretboardMode.value);
    fretboard.setMode(fretboardMode.value as FretboardMode);
  });
}
/** Committed bars by index (startBeat / beats per bar), for the fretboard. */
let committedPlans: BarPlan[] = [];
/** Sampled instruments, shared by every jam on this page. */
let library: SampleLibrary | null = null;
const getLibrary = () => (library ??= new SampleLibrary(getAudio()));
/** The lineup in the picker: who plays the next jam (and the current one, live). */
let band: Band = {};
const midi = platform.midi;
/** The companion server, if this page was served by one. */
let server: { sessions: boolean; relay: { llm: boolean; jev: boolean; anthropic: boolean } } | null = null;
const serverSessions = new ServerSessionStore();
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
  midiSink: MidiSink | null;
  hits: HitMonitor;
  rafId: number;
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
  resetBand();
  ($("chart-json") as HTMLTextAreaElement).value = chartJson;
  const bars = chart.form.reduce((n, s) => n + chart!.sections.get(s)!.bars, 0);
  $("chart-info").textContent = `${source}: ${chart.bpm} bpm, ${chart.beatsPerBar}/4${chart.key ? `, ${chart.key}` : ""}, ${getGenre(chart.genre).name.toLowerCase()}, ${bars} bars`;
  overlay.setForm(chart.form, sectionBarsOf(chart));
  overlay.chartBpm = chart.bpm;
  overlay.reset(chart.title);
  updateSongPill();
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
  if (session && !session.replay) {
    session.engine.setGenre(pickedGenre());
    session.synth.setMix(pickedGenre().mix);
  }
  updateSongPill();
  // A new genre brings its own band and mix.
  resetBand();
};

// ---------- band (lineup) ----------

/** The song's own band when it plays in its own genre, else the genre's. */
function songBand(): Band {
  const g = pickedGenre();
  return chart?.band && (!chart.genre || g.id === getGenre(chart.genre).id) ? chart.band : g.band;
}

function lineupOptions(): { id: string; name: string; band: Band }[] {
  const g = pickedGenre();
  const own = chart?.band && songBand() === chart.band ? [{ id: "song", name: "the song's band", band: chart.band }] : [];
  return [...own, { id: "genre", name: `${g.name} band`, band: g.band }, ...g.lineups];
}

function resetBand(): void {
  const opts = lineupOptions();
  const sel = $<HTMLSelectElement>("lineup-select");
  sel.replaceChildren(...opts.map((o) => new Option(o.name, o.id)), new Option("custom", "custom"));
  sel.value = opts[0].id;
  applyBand(opts[0].band);
}

$("lineup-select").onchange = () => {
  const o = lineupOptions().find((x) => x.id === $<HTMLSelectElement>("lineup-select").value);
  if (o) applyBand(o.band);
};

/** Use a lineup: from the next bar when playing, and for the next jam. */
function applyBand(next: Band, rebuild = true): void {
  band = cloneBand(next);
  if (session && !session.replay) {
    session.engine.setBand(band);
    session.synth.setBand(band);
  }
  if (!session) overlay.showLineup(bandParts(band).filter((p) => pickedGenre().parts.includes(p)), band, mixVolumesOf(pickedGenre().id));
  if (rebuild) renderBandParts();
  buildManualMoves();
  preload();
}

/** The picker changed by hand: the lineup becomes "custom". */
function editBand(next: Band, rebuild = false): void {
  const match = lineupOptions().find((o) => JSON.stringify(o.band) === JSON.stringify(next));
  $<HTMLSelectElement>("lineup-select").value = match?.id ?? "custom";
  applyBand(next, rebuild);
}

function renderBandParts(): void {
  const g = pickedGenre();
  $("band-parts").replaceChildren(
    ...g.parts.map((p) => {
      const slot = band[p];
      const row = document.createElement("div");
      row.className = `band-part${slot ? "" : " out"}`;
      row.dataset.part = p;
      const on = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!slot });
      const name = document.createElement("label");
      name.className = "inline";
      name.append(on, PART_LABELS[p]);
      const inst = document.createElement("select");
      inst.replaceChildren(...instrumentsFor(p).map((i) => new Option(i.name, i.id)));
      inst.value = slot?.instrument ?? defaultInstrument(p);
      const mix = g.mix.parts[p];
      const range = (min: number, max: number, value: number) => Object.assign(document.createElement("input"), { type: "range", min, max, step: 0.05, value });
      const vol = range(0, 1, slot?.volume ?? mix.volume);
      const pan = range(-1, 1, slot?.pan ?? mix.pan);
      const sliders = document.createElement("div");
      sliders.className = "sliders";
      sliders.append("vol", vol, "pan", pan);
      const state = document.createElement("div");
      state.className = "state";
      state.dataset.part = p;
      const slotNow = () => ({ instrument: inst.value, volume: Number(vol.value), pan: Number(pan.value) });
      on.onchange = () => {
        const next = cloneBand(band);
        if (on.checked) next[p] = slotNow();
        else delete next[p];
        if (!bandParts(next).length) return void (on.checked = true);
        row.classList.toggle("out", !on.checked);
        editBand(next);
      };
      inst.onchange = () => {
        if (!band[p]) return;
        editBand({ ...cloneBand(band), [p]: { ...band[p], instrument: inst.value } });
      };
      // Faders move the sound live while dragging; the lineup (and the recording) updates on release.
      vol.oninput = () => {
        const v = Number(vol.value);
        session?.synth.setVolume(p, v);
        overlay.setPartVolume(p, v);
      };
      pan.oninput = () => session?.synth.setPan(p, Number(pan.value));
      const commit = () => band[p] && editBand({ ...cloneBand(band), [p]: slotNow() });
      vol.onchange = commit;
      pan.onchange = commit;
      row.append(name, inst, sliders, state);
      return row;
    }),
  );
  showSampleStatus();
}

/** Start loading every sound the lineup needs, plus the player's. */
function preload(): Promise<unknown> {
  const lib = getLibrary();
  const ids = [...bandParts(band).map((p) => band[p]!.instrument), playerSound()];
  return Promise.all(ids.map((id) => lib.load(id)));
}

function showSampleStatus(): void {
  if (!library) return;
  for (const el of $("band-parts").querySelectorAll<HTMLElement>(".state")) {
    const p = el.dataset.part as Part;
    const id = band[p]?.instrument;
    const st = id ? library.state.get(id) : undefined;
    el.textContent = !id ? "" : st === "loading" ? "loading samples…" : st === "failed" ? "samples failed: synth sound" : st === "ready" ? "" : "";
  }
  const loading = [...library.state.values()].filter((s) => s === "loading").length;
  const failed = [...library.state].filter(([, s]) => s === "failed").map(([id]) => getInstrument(id)?.name ?? id);
  $("sample-status").textContent = loading
    ? `Loading sounds… (${(library.fetched / 1e6).toFixed(1)} MB so far)`
    : failed.length
      ? `Couldn't load ${failed.join(", ")}: the built-in synth plays those.`
      : library.fetched
        ? `Sounds ready (${(library.fetched / 1e6).toFixed(1)} MB downloaded, kept in this browser).`
        : "Sounds ready.";
}

const PLAYER_SOUND_KEY = "jamstate.player-sound";
function playerSound(): string {
  const id = platform.settings.get<string>(PLAYER_SOUND_KEY);
  return id && getInstrument(id) ? id : defaultInstrument("player");
}

{
  const sel = $<HTMLSelectElement>("player-sound");
  sel.replaceChildren(...playerInstruments().map((i) => new Option(i.name, i.id)));
  sel.value = playerSound();
  sel.onchange = () => {
    platform.settings.set(PLAYER_SOUND_KEY, sel.value);
    session?.synth.setPlayerInstrument(sel.value);
    void getLibrary().load(sel.value);
  };
}
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
    ...bandParts(band)
      .filter((p) => pickedGenre().parts.includes(p))
      .flatMap((p) => [btn(`+${PART_LABELS[p]}`, { move: "add_layer", part: p, reason: "Manual" }), btn(`−${PART_LABELS[p]}`, { move: "drop_layer", part: p, reason: "Manual" })]),
    ...FEELS.map((f) => btn(f.replace("_", " "), { move: "change_feel", feel: f, reason: "Manual" })),
    ...STINGERS.map((s) => btn(s, { move: "fire_stinger", stinger: s, reason: "Manual" })),
    ...[...new Set(chart?.form ?? [])].map((s) => btn(`→ ${s}`, { move: "jump_to_section", section: s, reason: "Manual" })),
    btn("extend 4", { move: "extend_section", bars: 4, reason: "Manual" }),
  );
}

// ---------- cues (v0.3) ----------

const BAR_CUES = new Set<Cue>(["drums_break", "drums_only", "build", "take_down"]);

function giveCue(c: Cue, by?: "voice"): void {
  if (!session) return overlay.note("Start the band first");
  if (session.replay) return overlay.note("This is a replay: it plays what was recorded");
  session.engine.cue(c, by);
  overlay.note(`Cue${by ? " (said)" : ""}: ${CUE_LABELS[c].toLowerCase()}`);
  overlay.toast(CUE_LABELS[c], BAR_CUES.has(c) ? "landing next bar" : "landing next phrase", by === "voice" ? "voice" : "cue");
}

function buildCues(): void {
  $("cues").replaceChildren(
    ...CUES.map((c, i) => {
      const b = document.createElement("button");
      const k = document.createElement("kbd");
      k.textContent = String(i + 1);
      b.append(k, CUE_LABELS[c]);
      b.onclick = () => giveCue(c);
      return b;
    }),
  );
}
buildCues();

window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  if (!t || t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || !e.code.startsWith("Digit")) return;
  if (e.code === "Digit8") {
    e.preventDefault();
    return toggleTrade();
  }
  const c = cueForKey(e.code.slice(5));
  if (!c) return;
  e.preventDefault();
  giveCue(c);
});

// ---------- trading fours (v0.4) ----------

const TRADE_KEY = "jamstate.trade";
const tradeBtn = $<HTMLButtonElement>("trade");
let trading = platform.settings.get<boolean>(TRADE_KEY) ?? false;
const showTrade = () => tradeBtn.setAttribute("aria-pressed", String(trading));
showTrade();

function toggleTrade(): void {
  trading = !trading;
  platform.settings.set(TRADE_KEY, trading);
  showTrade();
  if (session && !session.replay) {
    session.engine.setTrading(trading);
    overlay.note(trading ? "Trading fours: play a phrase, then lay out" : "Trading fours off");
  }
}
tradeBtn.onclick = toggleTrade;

// ---------- personality (v0.4) ----------

const PERSONALITY_KEY = "jamstate.personality";
const personalitySel = $<HTMLSelectElement>("personality");
let personality: Personality = PERSONALITIES.includes(platform.settings.get<Personality>(PERSONALITY_KEY) as Personality)
  ? platform.settings.get<Personality>(PERSONALITY_KEY)!
  : DEFAULT_PERSONALITY;
personalitySel.replaceChildren(...PERSONALITIES.map((p) => new Option(PERSONALITY_LABELS[p], p, false, p === personality)));
personalitySel.addEventListener("change", () => {
  personality = personalitySel.value as Personality;
  platform.settings.set(PERSONALITY_KEY, personality);
  if (session && !session.replay) session.engine.setPersonality(personality);
});

// ---------- brain (bandleader) ----------

// ---------- follow my tempo (v0.3, opt-in) ----------

const FOLLOW_KEY = "jamstate.followTempo";
const followBox = $<HTMLInputElement>("follow-tempo");
followBox.checked = platform.settings.get<boolean>(FOLLOW_KEY) ?? false;
followBox.addEventListener("change", () => {
  platform.settings.set(FOLLOW_KEY, followBox.checked);
  const s = session;
  if (!s || s.replay) return;
  if (followBox.checked) s.conductor.follower = new TempoFollower(s.engine.chart.bpm);
  else {
    // Back to strict: the chart tempo from the next bar.
    s.conductor.follower = null;
    s.engine.setTempo(s.engine.chart.bpm);
  }
});

// ---------- listening groups (v0.3) ----------

const LISTENING_KEY = "jamstate.listening";
let listening: Listening = { ...DEFAULT_LISTENING, ...(platform.settings.get<Partial<Listening>>(LISTENING_KEY) ?? {}) };
/** Last bar the conductor heard, to stamp listening changes in the recording. */
let lastHeardBar = -1;

function renderListening(): void {
  $("listening").replaceChildren(
    ...LISTENING_READY.map((g) => {
      const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: listening[g] });
      box.onchange = () => {
        listening = { ...listening, [g]: box.checked };
        platform.settings.set(LISTENING_KEY, listening);
        if (session && !session.replay) {
          session.conductor.listening = { ...listening };
          session.recorder?.listening(lastHeardBar, listeningKey(listening));
        }
      };
      const label = Object.assign(document.createElement("label"), { className: "inline" });
      label.append(box, LISTENING_LABELS[g]);
      return label;
    }),
  );
}
renderListening();

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
  if (!session) {
    const label = settings.kind === "jev" && !jevReachable() ? "rules" : BRAIN_LABELS[settings.kind].split(" (")[0].toLowerCase();
    overlay.leaderStatus(label);
  }
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
    openai: blindReady ? "didn't answer" : "needs the server's relay or a direct endpoint",
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
        await serverSessions.save(f);
        where += ` and ${serverSessions.label}`;
      } catch {
        /* kept in the browser; Sync to server can retry */
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

// ---------- audio input (v0.5) ----------

const audioIn = new AudioInputPanel(platform.audioIn, getAudio, platform.settings);
audioIn.onNote = (on, note, vel, time, place) => playerNote(on, note, vel, time, "audio", place);
audioIn.outputLatency = () => (audio ? (audio.baseLatency ?? 0) + (audio.outputLatency ?? 0) : 0);

// Voice cues (v0.5, ADR-0026): the same path as the keys.
const voice = new VoicePanel(platform.audioIn, getAudio, platform.settings);
voice.outputLatency = audioIn.outputLatency;
// For the page checks (npm run voice-check): main-thread time on the inputs and notes the band played late.
(window as unknown as { jamstateStats: () => unknown }).jamstateStats = () => ({ input: audioIn.cost, voice: voice.cost, late: session?.transport.lateness ?? null });
voice.onCue = (h) => {
  if (h.cue !== "trade_on" && h.cue !== "trade_off") return giveCue(h.cue, "voice");
  if (trading !== (h.cue === "trade_on")) {
    toggleTrade();
    overlay.toast(trading ? "Trade fours on" : "Trade fours off", trading ? "play a phrase, then lay out" : undefined, "voice");
  }
};
$("audio-in").addEventListener("change", () => setTimeout(updateInputPill, 50));
$("voice-in").addEventListener("change", () => setTimeout(updateInputPill, 50));

// The guitar's tuning (the neck and what audio input listens for) and a left-handed neck (v0.5).
const TUNING_KEY = "jamstate.fretboardTuning";
const LEFT_KEY = "jamstate.fretboardLeft";
{
  const tuning = $<HTMLSelectElement>("fretboard-tuning");
  const left = $<HTMLInputElement>("fretboard-left");
  const saved = platform.settings.get<TuningId>(TUNING_KEY);
  tuning.value = saved && TUNING_IDS.includes(saved) ? saved : "standard";
  left.checked = platform.settings.get<boolean>(LEFT_KEY) ?? false;
  const apply = () => {
    fretboard.setTuning(tuning.value as TuningId);
    fretboard.setLeftHanded(left.checked);
    audioIn.setTuning(tuning.value as TuningId);
  };
  apply();
  tuning.addEventListener("change", () => {
    platform.settings.set(TUNING_KEY, tuning.value);
    apply();
  });
  left.addEventListener("change", () => {
    platform.settings.set(LEFT_KEY, left.checked);
    apply();
  });
}

// ---------- player input ----------

const held = new Map<number, () => void>();

/** `from` audio: a note the audio input detected; the player hears their own instrument, so the page doesn't sound it. */
function playerNote(on: boolean, note: number, vel: number, audioTime?: number, from: "midi" | "audio" = "midi", place?: Place): void {
  if (!audio || !session || session.replay) return;
  const beat = session.transport.beatAt(audioTime ?? audio.currentTime);
  session.recorder?.note(beat, note, on ? vel : 0);
  fretboard.note(on, note, place);
  if (on) {
    held.get(note)?.();
    // Built-in sound off (playing through Ableton or another synth): the page doesn't sound the player either.
    if ($<HTMLInputElement>("builtin").checked && from === "midi") held.set(note, session.synth.liveNote(note, vel));
    session.tracker.noteOn(beat, note, vel);
  } else {
    held.get(note)?.();
    held.delete(note);
    session.tracker.noteOff(beat, note);
  }
}

attachKeyboard((on, note, vel) => playerNote(on, note, vel));

/**
 * What the browser and OS add between a key press and the speaker, which the
 * page can't remove: Bluetooth headphones and some Linux audio setups add 100 ms or more.
 */
function showLatency(): void {
  if (!audio || audio.state !== "running") return;
  const ms = Math.round(((audio.baseLatency ?? 0) + (audio.outputLatency ?? 0)) * 1000);
  $("audio-latency").textContent = ms
    ? `Audio output delay: ${ms} ms (browser and system)${ms > 40 ? ". Wired headphones or a lower-latency audio output will feel tighter." : ""}`
    : "";
}

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

function makeSink(ctx: AudioContext, synth: Synth): { sink: Sink; midiSink: MidiSink | null; hits: HitMonitor } {
  const hits = new HitMonitor();
  const sinks: Sink[] = [hits];
  if ($<HTMLInputElement>("builtin").checked) sinks.push(synth);
  const outId = $<HTMLSelectElement>("midi-out").value;
  const out = outId ? midi.outputs().find((o) => o.id === outId) : undefined;
  const midiSink = out ? new MidiSink(out, ctx) : null;
  if (midiSink) sinks.push(midiSink);
  return { sink: new MultiSink(sinks), midiSink, hits };
}

/** Next chord preview for Stage: next slot in this bar, else first chord of the next committed bar. */
function upcomingChord(c: Chart, plan: BarPlan | undefined, beatInBar: number, nextPlan: BarPlan | undefined): { next: string | null; anticipate: boolean } {
  if (!plan) return { next: null, anticipate: false };
  if (plan.kind === "count_in") {
    const first = nextPlan?.chords[0] ?? c.sections.get(c.form[0])?.barChords(0)[0]?.chord.symbol ?? null;
    return { next: first, anticipate: c.beatsPerBar - beatInBar <= 1 };
  }
  const slots = c.sections.get(plan.section)?.barChords(plan.barInSection) ?? [];
  const idx = slots.findIndex((s) => beatInBar >= s.start - 1e-6 && beatInBar < s.start + s.dur - 1e-6);
  if (idx >= 0 && idx + 1 < slots.length) {
    const nxt = slots[idx + 1];
    return { next: nxt.chord.symbol, anticipate: nxt.start - beatInBar <= 1 };
  }
  if (nextPlan && nextPlan.chords.length) {
    return { next: nextPlan.chords[0], anticipate: c.beatsPerBar - beatInBar <= 1 };
  }
  // Look ahead to the next bar in the chart before bar N+1 commits.
  const sec = c.sections.get(plan.section);
  if (sec && plan.barInSection + 1 < sec.bars) {
    const nxt = sec.barChords(plan.barInSection + 1)[0]?.chord.symbol ?? null;
    return { next: nxt, anticipate: c.beatsPerBar - beatInBar <= 1 };
  }
  const nextPos = plan.formPos + 1 < c.form.length ? plan.formPos + 1 : 0;
  const nextSec = c.sections.get(c.form[nextPos]);
  return { next: nextSec?.barChords(0)[0]?.chord.symbol ?? null, anticipate: c.beatsPerBar - beatInBar <= 1 };
}

function setRunning(running: boolean): void {
  $<HTMLButtonElement>("start").disabled = running;
  $<HTMLButtonElement>("stop").disabled = !running;
  $<HTMLButtonElement>("end-song").disabled = !running || !!session?.replay;
  $<HTMLButtonElement>("session-play").disabled = running || !replayFile;
}

/** Wait for the lineup's samples, but never more than a few seconds (the synth covers the rest). */
async function soundsReady(ids: string[]): Promise<void> {
  const lib = getLibrary();
  if (ids.every((id) => lib.get(id))) return;
  $("sample-status").textContent = "Loading sounds…";
  await Promise.race([Promise.all(ids.map((id) => lib.load(id))), new Promise((r) => setTimeout(r, 4000))]);
  showSampleStatus();
}

let starting = 0;

/** Start a jam, or play back a recorded session when `replay` is given (optionally seeking to `startBar`). */
async function start(replay?: SessionFile, startBar = 0): Promise<void> {
  if (!chart && !replay) return;
  stop();
  if (!replay) {
    recap.close();
    $("recap-banner").hidden = true;
    if (drawer.isOpen) drawer.close();
  }
  audio = getAudio();
  void audio.resume().then(() => setTimeout(showLatency, 500));
  const myStart = ++starting;
  const startBand = replay ? sessionBand(replay) : cloneBand(band);
  if ($<HTMLInputElement>("builtin").checked) await soundsReady([...bandParts(startBand).map((p) => startBand[p]!.instrument), playerSound()]);
  if (myStart !== starting) return; // pressed again while loading
  const c = replay ? loadChart(replay.chart) : chart!;
  const synth = new Synth(audio, getLibrary());
  synth.playerInstrument = playerSound();
  synth.setMix(replay ? getGenre(replay.genre).mix : pickedGenre().mix);
  synth.setBand(startBand);
  const { sink, midiSink, hits } = makeSink(audio, synth);

  const seed = (Math.random() * 0x7fffffff) | 0;
  const config = { loop: $<HTMLInputElement>("loop").checked };
  const genre = pickedGenre();
  const swing = pickedSwing();
  const engine = replay
    ? sessionEngine(replay, replay.controls)
    : new Engine(c, { config, seed, genre, swing, countIn: c.countIn, band: startBand, personality });
  if (!replay && trading) engine.setTrading(true);
  if (!replay) jamKind = null;
  showRatingPanel(false);
  overlay.blind = replay ? isBlind(replay.leader) : settings.kind === "blind";
  const { leader, remote, every } = replay ? { leader: null, remote: null, every: replay.every_bars } : makeLeader(c);
  const recorder = replay
    ? null
    : new SessionRecorder({ chart: chartRaw!, genre: genre.id, swing, band: startBand, seed, countIn: c.countIn, config, leader: leaderName(), everyBars: every, listening: listeningKey(listening), personality, input: audioIn.sessionInput() ?? undefined });
  if (!replay) {
    audioIn.startTape();
    audioIn.setBand(synth.output);
    voice.setBand(synth.output);
  }
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
    onHeard: (bar, heard) => {
      lastHeardBar = bar;
      overlay.heard(heard);
    },
  });
  if (!replay && followBox.checked) conductor.follower = new TempoFollower(c.bpm);
  if (!replay) conductor.trader = new Trader(engine);
  conductor.listening = replay ? (replay.listening?.length ? parseListening(replay.listening[0].groups) : { ...NO_LISTENING }) : { ...listening };
  const ctx = audio;
  const replayNotes = replay ? pairNotes(replay) : [];
  let mismatches = 0;
  let heardBand = startBand;
  let heardGenre = replay?.genre;
  const seekBar = replay ? Math.max(0, Math.min(Math.max(0, replay.bars.length - 1), Math.floor(startBar))) : 0;
  if (replay && seekBar > 0) {
    // Deterministically fast-forward the engine to seekBar so band/genre/seed match 100%.
    for (let k = 0; k < seekBar; k++) {
      const skipped = engine.nextBar();
      if (!skipped) break;
      if (skipped.band !== heardBand) heardBand = skipped.band;
      if (skipped.genre !== heardGenre) heardGenre = skipped.genre;
    }
    synth.setBand(heardBand);
    if (heardGenre) synth.setMix(getGenre(heardGenre).mix);
  }
  const transport = new Transport(
    engine,
    { now: () => ctx.currentTime },
    sink,
    {
      onCommit: (plan, startBeat) => {
        committedPlans[Math.round(startBeat / c.beatsPerBar)] = plan;
        recorder?.bar(plan);
        updateSessionStatus();
        if (replay) {
          // A replay sounds like the jam: lineup and genre changes come from the recording.
          if (plan.band !== heardBand) synth.setBand((heardBand = plan.band));
          if (plan.genre !== heardGenre) synth.setMix(getGenre((heardGenre = plan.genre)).mix);
          const want = replay.bars[plan.bar];
          if (want && want.hash !== summarizeBar(plan).hash) {
            mismatches++;
            overlay.note(`bar ${plan.bar}: plays differently from the recording`);
          }
          for (const n of replayNotes) {
            if (n.start < startBeat || n.start >= startBeat + c.beatsPerBar) continue;
            // Notes heard from an instrument (audio input) were never sounded by the page; a replay doesn't either.
            if (replay.input?.kind !== "audio") transport.inject({ start: 0, dur: n.dur, note: n.note, vel: n.vel, part: "player" }, n.start);
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
        if (replay && recap.isOpen) recap.setPlayingBar(plan.bar);
        if (replay && plan.bar >= replay.bars.length - 1) overlay.note("Last recorded bar.");
      },
      onBarEnd: (plan, startBeat) => {
        conductor.barFinished(plan, tracker.bar(startBeat, c.beatsPerBar));
        if (plan.kind !== "count_in") overlay.arc(conductor.arcNow(plan));
        if (replay && plan.bar >= replay.bars.length - 1) {
          overlay.note(mismatches ? `Replay done: ${mismatches} bars differed.` : "Replay done: every bar matched the recording.");
          stop();
        }
      },
      onEnd: () => {
        overlay.note(engine.log.some((m) => m.label === "end_song" && m.status === "applied") ? "The end." : "End of the form.");
        stop();
      },
    },
    { startBar: seekBar },
  );
  // The fretboard follows the beat on the scheduler's heartbeat (it keeps going in a background tab; it redraws only on a change).
  const drawFretboard = () => {
    const beat = transport.beatAt(ctx.currentTime);
    const k = Math.floor(beat / c.beatsPerBar);
    const plan = committedPlans[k];
    fretboard.frame(c, plan, beat - k * c.beatsPerBar, committedPlans[k + 1], getGenre(plan?.genre ?? engine.genre.id).listening);
  };
  // Chords heard from a guitar lean to the chart's chord at the strum.
  audioIn.chordPrior = (t) => {
    const beat = transport.beatAt(t);
    const k = Math.floor(beat / c.beatsPerBar);
    const plan = committedPlans[k];
    return plan ? chordView(c, plan, beat - k * c.beatsPerBar, committedPlans[k + 1]) : null;
  };
  const ticker = new Ticker(() => {
    transport.tick();
    drawFretboard();
  });
  session = { engine, transport, conductor, ticker, tracker, synth, midiSink, hits, rafId: 0, remote, recorder, replay: !!replay };
  syncMuteSolo();
  overlay.chartBpm = c.bpm;
  overlay.reset(replay ? `Replay: ${replay.title}` : c.title);
  if (replay) overlay.setForm(c.form, sectionBarsOf(c));
  overlay.leaderStatus(replay ? "replay" : leaderLabel(session));
  committedPlans = [];
  fretboard.clear();
  transport.start();
  ticker.start();
  setRunning(true);

  // Smooth 60fps Stage visual loop (playhead sweep, beat dots, next-chord preview, musician hit pulses).
  const rafFrame = () => {
    const cur = session;
    if (!cur) return;
    const now = ctx.currentTime;
    const beat = cur.transport.beatAt(now);
    const k = Math.floor(beat / c.beatsPerBar);
    const plan = committedPlans[k];
    const nextPlan = committedPlans[k + 1];
    const beatInBar = Math.max(0, beat - k * c.beatsPerBar);
    const { next, anticipate } = upcomingChord(c, plan, beatInBar, nextPlan);
    const hitLevels: Partial<Record<Part, number>> = {};
    for (const p of plan?.lineup ?? PARTS) hitLevels[p] = cur.hits.level(p, now);
    overlay.frame({
      beatInBar,
      bpb: c.beatsPerBar,
      kind: plan?.kind ?? "play",
      currentChord: plan?.chords[0] ?? null,
      nextChord: next,
      anticipate,
      hits: hitLevels,
    });
    cur.rafId = requestAnimationFrame(rafFrame);
  };
  session.rafId = requestAnimationFrame(rafFrame);
}

function stop(): void {
  if (!session) return;
  const wasLive = !session.replay;
  cancelAnimationFrame(session.rafId);
  if (wasLive && audio) {
    audioIn.setBand(null);
    voice.setBand(null);
    const t0 = audioIn.stopTape(audio.currentTime);
    if (t0 !== null && lastJam) {
      const bpb = lastJam.engine.chart.beatsPerBar;
      const tr = session.transport;
      const starts = Array.from({ length: lastJam.recorder.barCount }, (_, k) => tr.timeAt(k * bpb) - t0);
      lastJam.recorder.keepAudio(fileName(lastJam.recorder.finish(lastJam.engine)).replace(/\.json$/, ".wav"), SR, starts);
    }
  }
  session.ticker.stop();
  session.transport.stop();
  fretboard.clear();
  overlay.resetProgress();
  recap.setPlayingBar(null);
  for (const release of held.values()) release();
  held.clear();
  session = null;
  setRunning(false);
  updateSessionStatus();
  overlay.showLineup(bandParts(band).filter((p) => pickedGenre().parts.includes(p)), band, mixVolumesOf(pickedGenre().id));
  if (wasLive) {
    void keepJam();
    const f = currentFile();
    if (f && f.bars.length > 0) {
      $("recap-banner-text").textContent = `Recorded ${f.bars.length} bars of ${f.title}.`;
      $("recap-banner").hidden = false;
    }
  }
  if (wasLive && jamKind && lastJam?.recorder) {
    showRatingPanel(true);
    drawer.open("sessions");
  }
}

$("start").onclick = () => void start();
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

// ---------- session recap (v0.6) ----------

const recap = new RecapView({
  onBack: () => {
    if (session?.replay) stop();
  },
  onPlayFrom: (file, startBar) => {
    void start(file, startBar);
  },
  onStopReplay: () => {
    if (session?.replay) stop();
  },
  onExportMidi: (file) => {
    const bytes = exportSessionMidi(file);
    save(new Blob([bytes as BlobPart], { type: "audio/midi" }), fileName(file).replace(/\.json$/, ".mid"));
  },
  onExportWav: async (file, includeRaw) => {
    const rawWav = includeRaw ? jamAudio(file) : null;
    const bytes = await renderSession(file, { rawWav, playerInstrument: playerSound() });
    save(new Blob([bytes as BlobPart], { type: "audio/wav" }), fileName(file).replace(/\.json$/, ".wav"));
  },
  onExportJson: (file) => download(file),
  canSummarize: () => !!makeBrain(settings)?.summarizeSession,
  onSummarize: async (r) => {
    const brain = makeBrain(settings);
    if (!brain?.summarizeSession) throw new Error("Pick OpenAI-compatible or Claude under Bandleader");
    return brain.summarizeSession(r, AbortSignal.timeout(30_000));
  },
});

$("recap-open-btn").onclick = () => {
  const f = currentFile();
  if (!f) return;
  $("recap-banner").hidden = true;
  recap.open(f, { hasRawAudio: !!jamAudio(f) });
};
$("recap-dismiss-btn").onclick = () => ($("recap-banner").hidden = true);

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

function save(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function download(f: SessionFile): void {
  save(new Blob([JSON.stringify(f)], { type: "application/json" }), fileName(f));
}

/** The last jam's raw audio, when it was kept (it lives in memory until the next jam). */
function jamAudio(f: SessionFile): Uint8Array | null {
  return f.input?.audio && audioIn.lastTape ? audioIn.lastTape.wav : null;
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
    res.textContent = `Kept in ${platform.sessions.label}: ${f.title}, ${f.bars.length} bars. Pick it under Replay any time, or Download it.${jamAudio(f) ? " Its audio is kept until the next jam: Download or Sync it to keep it." : ""}`;
  } catch (e) {
    res.className = "small errors";
    res.textContent = `Couldn't keep it in ${platform.sessions.label} (${(e as Error).message}). Use Download.`;
  }
}

$("session-download").onclick = () => {
  const f = currentFile();
  if (!f) return;
  download(f);
  const wav = jamAudio(f);
  if (wav && f.input?.audio) setTimeout(() => save(new Blob([wav as BlobPart], { type: "audio/wav" }), f.input!.audio!.file), 300);
};

$("session-save").onclick = async () => {
  const f = currentFile();
  if (!f) return;
  const res = $("session-result");
  try {
    const name = await serverSessions.save(f);
    const wav = jamAudio(f);
    if (wav) await serverSessions.saveAudio(name, wav);
    res.textContent = `Synced to ${serverSessions.label} as ${name}${wav ? " with its audio" : ""}`;
    res.className = "small";
    void listSessions();
  } catch (e) {
    res.textContent = `Couldn't sync to ${serverSessions.label} (${(e as Error).message}). Use Download instead.`;
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
  $<HTMLButtonElement>("session-recap").disabled = !replayFile;
  $<HTMLButtonElement>("session-check").disabled = !replayFile;
  $<HTMLButtonElement>("session-export").disabled = !replayFile;
  $<HTMLButtonElement>("session-delete").disabled = !replayFile || !$<HTMLSelectElement>("session-list").value.startsWith("b:");
  setRunning(!!session);
}

const metaLabel = (s: SessionMeta) => `${s.created.slice(0, 16).replace("T", " ")} ${s.title} (${s.bars} bars${s.leader ? `, ${isBlind(s.leader) ? "blind" : s.leader}` : ""})`;

/** Sessions in this browser, plus the server's when there is one. Values are "b:<name>" or "s:<name>". */
async function listSessions(select?: string): Promise<void> {
  const sel = $<HTMLSelectElement>("session-list");
  const groups: HTMLElement[] = [];
  let count = 0;
  for (const [prefix, store] of [["b", platform.sessions], ...(server?.sessions ? [["s", serverSessions]] : [])] as [string, SessionStore][]) {
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
  const store = v.startsWith("s:") ? serverSessions : platform.sessions;
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

$("session-recap").onclick = () => {
  if (!replayFile) return;
  drawer.close();
  $("recap-banner").hidden = true;
  const cur = currentFile();
  const hasRaw = !!cur && cur.created === replayFile.created && !!jamAudio(replayFile);
  recap.open(replayFile, { hasRawAudio: hasRaw });
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
  if (replayFile) {
    drawer.close();
    void start(replayFile);
  }
};

showBrainSettings();
updateInputPill();
getLibrary().onChange = showSampleStatus;
void loadCharts();
void checkServer();
void initMidi();
void listSessions();
