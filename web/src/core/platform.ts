// Platform interfaces (ADR-0017). The core never calls the browser directly
// for MIDI, audio input, storage or models; a shell plugs these in. The web
// page uses web/src/platform/web.ts; tests and Node scripts use the memory
// versions below; a desktop shell can bring native ones.

import type { Fetch } from "./brain/types";
import type { SessionFile } from "./session";

// ---------- MIDI ----------

export interface MidiPortInfo {
  id: string;
  name: string;
}

/** (on, note, velocity, timeStamp on the performance.now() timeline) */
export type MidiNoteHandler = (on: boolean, note: number, vel: number, timeStamp: number) => void;

export interface MidiOutPort extends MidiPortInfo {
  /** Raw bytes at a time on the performance.now() timeline (ms). */
  send(data: number[], timeStampMs?: number): void;
  clear?(): void;
}

export interface MidiPlatform {
  /** Ask for access; false (with `error`) when the platform has no MIDI. */
  init(): Promise<boolean>;
  readonly error: string | null;
  inputs(): MidiPortInfo[];
  outputs(): MidiOutPort[];
  /** Listen to one input id, or "all" except the one named `skipName` (a loopback). Returns an unsubscribe. */
  listen(id: string, handler: MidiNoteHandler, skipName?: string | null): () => void;
  /** Ports came or went. */
  onChange(cb: () => void): void;
}

// ---------- audio input (guitar, v0.5) ----------

export interface AudioInputDevice {
  id: string;
  label: string;
}

/** 16 kHz mono frames from an input, with the audio-clock time of the first sample; `ref` is the band's mix (bleed gate). */
export type AudioFrameHandler = (samples: Float32Array, time: number, ref?: Float32Array) => void;

/** Which channel of the device: 0 (input 1), 1 (input 2) or both mixed. */
export type InputChannel = 0 | 1 | "mix";

export interface AudioInputOptions {
  deviceId?: string;
  channel?: InputChannel;
}

export interface AudioInputHandle {
  /** Channels the device gave (1 or 2). */
  readonly channels: number;
  /** Seconds the browser says the input runs behind (0 when it doesn't say). */
  readonly latency: number;
  readonly label: string;
  setChannel(c: InputChannel): void;
  /** Route the input to the speakers (for interfaces without direct monitoring). */
  setMonitor(on: boolean): void;
  /** Feed the band's mix in as the bleed reference (null to stop). */
  setReference(node: unknown | null): void;
  stop(): void;
}

export interface AudioInputPlatform {
  available(): boolean;
  /** Labels show once the player has allowed an input. */
  devices(): Promise<AudioInputDevice[]>;
  /** Start streaming 16 kHz frames from a device (the default when omitted). */
  open(onFrame: AudioFrameHandler, opts?: AudioInputOptions): Promise<AudioInputHandle>;
}

// ---------- storage ----------

/** Small settings (brain choice, keys, UI state). Stays on the player's machine. */
export interface KeyValueStore {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

export interface SessionMeta {
  name: string;
  title: string;
  bars: number;
  created: string;
  leader: string;
  genre: string;
}

/** Where recorded jams live: browser storage, a folder, or a sync server. */
export interface SessionStore {
  readonly label: string;
  list(): Promise<SessionMeta[]>;
  load(name: string): Promise<SessionFile>;
  /** Returns the name it was saved under. */
  save(f: SessionFile): Promise<string>;
  remove?(name: string): Promise<void>;
}

export function sessionName(f: SessionFile): string {
  const slug = f.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "session";
  return `${f.created.slice(0, 19).replace(/[:T]/g, "-")}-${slug}`;
}

export function sessionMeta(name: string, f: SessionFile): SessionMeta {
  return { name, title: f.title, bars: f.bars.length, created: f.created, leader: f.leader, genre: f.genre };
}

// ---------- model runtime ----------

/**
 * How brains reach models. Hosted and server brains need only HTTP; a local
 * model (Laya in ONNX, later) is loaded through `local`, which a shell
 * provides when it can run one.
 */
export interface ModelRuntime {
  fetch: Fetch;
  local?: LocalModelLoader;
}

export interface LocalModel {
  run(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
  dispose(): void;
}

export interface LocalModelLoader {
  /** e.g. "onnx" in the browser, "mlx" in a desktop shell. */
  readonly backend: string;
  load(id: string, onProgress?: (loaded: number, total: number) => void): Promise<LocalModel>;
}

export interface Platform {
  name: string;
  midi: MidiPlatform;
  audioIn: AudioInputPlatform;
  settings: KeyValueStore;
  sessions: SessionStore;
  models: ModelRuntime;
}

// ---------- memory versions (tests, Node scripts) ----------

export class MemoryStore implements KeyValueStore {
  private m = new Map<string, string>();
  get<T>(key: string): T | null {
    const v = this.m.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  set(key: string, value: unknown): void {
    this.m.set(key, JSON.stringify(value));
  }
  remove(key: string): void {
    this.m.delete(key);
  }
}

export class MemorySessionStore implements SessionStore {
  readonly label = "memory";
  private m = new Map<string, SessionFile>();
  async list(): Promise<SessionMeta[]> {
    return [...this.m].map(([n, f]) => sessionMeta(n, f)).sort((a, b) => b.created.localeCompare(a.created));
  }
  async load(name: string): Promise<SessionFile> {
    const f = this.m.get(name);
    if (!f) throw new Error(`no session ${name}`);
    return structuredClone(f);
  }
  async save(f: SessionFile): Promise<string> {
    let name = sessionName(f);
    for (let i = 2; this.m.has(name) && JSON.stringify(this.m.get(name)) !== JSON.stringify(f); i++) name = `${sessionName(f)}-${i}`;
    this.m.set(name, structuredClone(f));
    return name;
  }
  async remove(name: string): Promise<void> {
    this.m.delete(name);
  }
}
