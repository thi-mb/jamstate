// The web shell's platform (ADR-0017): Web MIDI, getUserMedia, localStorage,
// IndexedDB and fetch. Optional pieces fail soft: the page plays without
// MIDI, without a mic and without storage.

import workletUrl from "../audio/input-worklet.ts?worker&url";
import type {
  AudioFrameHandler,
  AudioInputDevice,
  AudioInputHandle,
  AudioInputOptions,
  AudioInputPlatform,
  KeyValueStore,
  MidiNoteHandler,
  MidiOutPort,
  MidiPlatform,
  MidiPortInfo,
  Platform,
  SessionMeta,
  SessionStore,
} from "../core/platform";
import { MemorySessionStore, MemoryStore, sessionMeta, sessionName } from "../core/platform";
import { checkSession, type SessionFile } from "../core/session";

// ---------- MIDI ----------

/**
 * Inputs to listen to. "all" skips any input named like the band's MIDI out:
 * a loopback port (IAC bus, loopMIDI) echoes the band back in, and its notes
 * would count as the player's.
 */
export function pickInputs<T extends { id: string; name?: string | null }>(inputs: T[], id: string, outName?: string | null): T[] {
  if (id !== "all") return inputs.filter((i) => i.id === id);
  return inputs.filter((i) => !outName || i.name !== outName);
}

export class WebMidi implements MidiPlatform {
  private access: MIDIAccess | null = null;
  error: string | null = null;
  private listeners: (() => void)[] = [];

  async init(): Promise<boolean> {
    if (!("requestMIDIAccess" in navigator)) {
      this.error = window.isSecureContext ? "Web MIDI isn't supported in this browser (try Chrome)" : "Web MIDI needs HTTPS or localhost";
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess();
      this.access.onstatechange = () => this.listeners.forEach((l) => l());
      return true;
    } catch (e) {
      this.error = `MIDI access denied: ${(e as Error).message}`;
      return false;
    }
  }

  inputs(): MidiPortInfo[] {
    return this.access ? [...this.access.inputs.values()].map((i) => ({ id: i.id, name: i.name ?? i.id })) : [];
  }

  outputs(): MidiOutPort[] {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map((o) => ({
      id: o.id,
      name: o.name ?? o.id,
      send: (data, ts) => o.send(data, ts),
      clear: () => (o as MIDIOutput & { clear?: () => void }).clear?.(),
    }));
  }

  listen(id: string, handler: MidiNoteHandler, skipName?: string | null): () => void {
    const all = this.access ? [...this.access.inputs.values()] : [];
    const ins = pickInputs(all, id, skipName);
    const cb = (e: MIDIMessageEvent) => {
      const d = e.data;
      if (!d || d.length < 3) return;
      const kind = d[0] & 0xf0;
      if (kind === 0x90 && d[2] > 0) handler(true, d[1], d[2], e.timeStamp);
      else if (kind === 0x80 || (kind === 0x90 && d[2] === 0)) handler(false, d[1], 0, e.timeStamp);
    };
    for (const i of ins) i.addEventListener("midimessage", cb as EventListener);
    return () => ins.forEach((i) => i.removeEventListener("midimessage", cb as EventListener));
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }
}

// ---------- audio input ----------

/**
 * Microphone or interface input as 16 kHz mono frames, through an
 * AudioWorklet that picks the channel and resamples (v0.5, ADR-0023).
 */
export class WebAudioInput implements AudioInputPlatform {
  private loaded: Promise<void> | null = null;

  constructor(private ctx: () => AudioContext) {}

  available(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";
  }

  async devices(): Promise<AudioInputDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, label: d.label || "input" }));
  }

  async open(onFrame: AudioFrameHandler, opts: AudioInputOptions = {}): Promise<AudioInputHandle> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        // Two channels, or Chrome mixes the Scarlett's mic and instrument inputs into one.
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const ctx = this.ctx();
    this.loaded ??= ctx.audioWorklet.addModule(workletUrl);
    await this.loaded;
    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings() as MediaTrackSettings & { latency?: number; channelCount?: number };
    const src = ctx.createMediaStreamSource(stream);
    const channels = Math.min(2, settings?.channelCount ?? src.channelCount ?? 1);
    const node = new AudioWorkletNode(ctx, "jamstate-input", {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    node.port.onmessage = (e: MessageEvent<{ samples: Float32Array; time: number; ref?: Float32Array }>) => onFrame(e.data.samples, e.data.time, e.data.ref);
    node.port.postMessage({ channel: opts.channel ?? "mix" });
    src.connect(node, 0, 0);
    // The worklet only runs while something pulls on it: a silent sink keeps it going.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    const monitor = ctx.createGain();
    monitor.gain.value = 0;
    node.connect(monitor).connect(ctx.destination);
    let ref: AudioNode | null = null;
    return {
      channels,
      latency: typeof settings?.latency === "number" ? settings.latency : 0,
      label: track?.label ?? "input",
      setChannel: (c) => node.port.postMessage({ channel: c }),
      setMonitor: (on) => monitor.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.02),
      setReference: (n) => {
        ref?.disconnect(node);
        ref = (n as AudioNode | null) ?? null;
        ref?.connect(node, 0, 1);
      },
      stop: () => {
        ref?.disconnect(node);
        src.disconnect();
        node.disconnect();
        node.port.onmessage = null;
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  }
}

// ---------- storage ----------

export class LocalStore implements KeyValueStore {
  private fallback = new MemoryStore();
  get<T>(key: string): T | null {
    try {
      const v = localStorage.getItem(key);
      return v === null ? null : (JSON.parse(v) as T);
    } catch {
      return this.fallback.get<T>(key);
    }
  }
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      this.fallback.set(key, value);
    }
  }
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      this.fallback.remove(key);
    }
  }
}

const DB = "jamstate";
const STORE = "sessions";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

/** Recorded jams in IndexedDB: survives reloads, stays on this machine. */
export class BrowserSessionStore implements SessionStore {
  readonly label = "this browser";
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((ok, fail) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "name" });
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
    return this.db;
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async list(): Promise<SessionMeta[]> {
    const rows = (await req((await this.tx("readonly")).getAll())) as { name: string; meta: SessionMeta }[];
    return rows.map((r) => r.meta).sort((a, b) => b.created.localeCompare(a.created));
  }

  async load(name: string): Promise<SessionFile> {
    const row = (await req((await this.tx("readonly")).get(name))) as { file: SessionFile } | undefined;
    if (!row) throw new Error(`no session ${name} in this browser`);
    return checkSession(row.file);
  }

  async save(f: SessionFile): Promise<string> {
    const name = sessionName(f);
    await req((await this.tx("readwrite")).put({ name, meta: sessionMeta(name, f), file: f }));
    return name;
  }

  async remove(name: string): Promise<void> {
    await req((await this.tx("readwrite")).delete(name));
  }
}

/** Optional sync target: the companion server's /api/sessions (the Spark). */
export class ServerSessionStore implements SessionStore {
  readonly label = "the Spark";
  constructor(private base = "api/sessions") {}

  async list(): Promise<SessionMeta[]> {
    const r = await fetch(this.base, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list: { name: string; title: string; bars: number; created?: string; leader?: string; genre?: string }[] = (await r.json()).sessions ?? [];
    return list.map((s) => ({ name: s.name, title: s.title, bars: s.bars, created: s.created ?? "", leader: s.leader ?? "", genre: s.genre ?? "" }));
  }

  async load(name: string): Promise<SessionFile> {
    const r = await fetch(`${this.base}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return checkSession(await r.json());
  }

  async save(f: SessionFile): Promise<string> {
    const r = await fetch(this.base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f), signal: AbortSignal.timeout(10_000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body.name;
  }

  /** The raw audio kept with a session (v0.5), saved beside it. */
  async saveAudio(name: string, wav: Uint8Array): Promise<void> {
    const r = await fetch(`${this.base}/${encodeURIComponent(name)}/audio`, { method: "POST", headers: { "content-type": "audio/wav" }, body: new Blob([wav as BlobPart], { type: "audio/wav" }), signal: AbortSignal.timeout(60_000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  }
}

function sessionStore(): SessionStore {
  try {
    if (typeof indexedDB !== "undefined") return new BrowserSessionStore();
  } catch {
    /* private mode or blocked storage */
  }
  return new MemorySessionStore();
}

export function webPlatform(audio: () => AudioContext): Platform {
  return {
    name: "web",
    midi: new WebMidi(),
    audioIn: new WebAudioInput(audio),
    settings: new LocalStore(),
    sessions: sessionStore(),
    models: { fetch: globalThis.fetch.bind(globalThis) },
  };
}
