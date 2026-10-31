// Sampled instruments. The page loads samples/manifest.json (written by
// sounds/render.py) and, only when an instrument is in the lineup, its small
// Opus files. Files are kept in the browser's Cache Storage, so the second
// visit plays from disk. Until an instrument has loaded (or if it fails), the
// synth voices in synth.ts play that part instead.

const CACHE = "jamstate-samples-v1";

export interface Zone {
  file: string;
  key: number;
  vel: number;
  /** Loop points in seconds (sustained instruments). */
  loop?: [number, number];
}

export interface ManifestInstrument {
  part: string;
  name: string;
  kind: "pitched" | "kit" | "percussion";
  release: number;
  bytes: number;
  zones: Zone[];
}

export interface SampleManifest {
  format: string;
  rate: number;
  bytes: number;
  instruments: Record<string, ManifestInstrument>;
}

interface LoadedZone extends Zone {
  buffer: AudioBuffer;
}

/** Kit notes that may be missing from a kit, and what to play instead. */
const KIT_STANDIN: Record<number, number[]> = { 53: [51], 44: [42], 39: [38], 37: [38], 46: [42], 51: [53, 42], 49: [51] };

export interface PlayOptions {
  /** Semitones (drum tuning). */
  tune?: number;
}

export class Instrument {
  private byKey = new Map<number, LoadedZone[]>();
  /** Open hi-hats still ringing, so a closed hat can choke them. */
  private openHats = new Set<{ gain: GainNode; end: number }>();

  constructor(
    readonly id: string,
    readonly info: ManifestInstrument,
    zones: LoadedZone[],
  ) {
    for (const z of zones) this.byKey.set(z.key, [...(this.byKey.get(z.key) ?? []), z]);
    for (const list of this.byKey.values()) list.sort((a, b) => a.vel - b.vel);
  }

  get kind(): ManifestInstrument["kind"] {
    return this.info.kind;
  }

  /** The zone for a note and velocity, and how far to repitch it (semitones). */
  pick(note: number, vel: number): { zone: LoadedZone; shift: number } | null {
    if (this.info.kind !== "pitched") {
      const keys = [note, ...(KIT_STANDIN[note] ?? [])];
      const key = keys.find((k) => this.byKey.has(k));
      if (key === undefined) return null;
      return { zone: layerFor(this.byKey.get(key)!, vel), shift: 0 };
    }
    // Nearest sampled key (every 3 semitones), then the velocity layer.
    let best = -1;
    for (const k of this.byKey.keys()) if (best < 0 || Math.abs(k - note) < Math.abs(best - note)) best = k;
    if (best < 0) return null;
    return { zone: layerFor(this.byKey.get(best)!, vel), shift: note - best };
  }

  /**
   * Schedule one note. `vel` is MIDI velocity, `dur` seconds. Returns false if
   * the instrument has nothing for this note (the caller can use a synth voice).
   */
  play(ctx: BaseAudioContext, out: AudioNode, note: number, vel: number, time: number, dur: number, o: PlayOptions = {}): boolean {
    const hit = this.pick(note, vel);
    if (!hit) return false;
    const { zone, shift } = hit;
    const src = ctx.createBufferSource();
    src.buffer = zone.buffer;
    const drum = this.info.kind !== "pitched";
    // Drums: a few cents and a fraction of a dB different every hit, so repeated notes don't machine-gun.
    const humanCents = drum ? (Math.random() * 2 - 1) * 12 : 0;
    src.playbackRate.value = Math.pow(2, (shift + (o.tune ?? 0)) / 12 + humanCents / 1200);
    if (zone.loop) {
      src.loop = true;
      src.loopStart = zone.loop[0];
      src.loopEnd = zone.loop[1];
    }
    // Within a layer, scale by how far the velocity is from the layer's own.
    const g = Math.min(1.6, Math.max(0.15, Math.pow(vel / zone.vel, drum ? 1.1 : 0.9))) * (drum ? 1 + (Math.random() * 2 - 1) * 0.08 : 1);
    const amp = ctx.createGain();
    const attack = drum ? 0.001 : 0.004;
    amp.gain.setValueAtTime(0, time);
    amp.gain.linearRampToValueAtTime(g, time + attack);
    src.connect(amp).connect(out);
    src.start(time);
    const natural = zone.buffer.duration / src.playbackRate.value;
    if (drum) {
      if (note === 46) {
        const h = { gain: amp, end: time + natural };
        this.openHats.add(h);
      } else if (note === 42 || note === 44) this.choke(time);
      src.stop(time + natural + 0.01);
      return true;
    }
    const release = this.info.release;
    const end = time + Math.max(dur, attack + 0.01);
    if (zone.loop || end < time + natural) {
      amp.gain.setValueAtTime(g, end);
      amp.gain.setTargetAtTime(0, end, release / 3);
      src.stop(Math.min(end + release * 3, zone.loop ? Infinity : time + natural) + 0.01);
    } else src.stop(time + natural + 0.01);
    return true;
  }

  /** Start a note now and hold it until the returned function is called (the player's live notes). */
  hold(ctx: BaseAudioContext, out: AudioNode, note: number, vel: number): (() => void) | null {
    const hit = this.info.kind === "pitched" ? this.pick(note, vel) : null;
    if (!hit) return null;
    const { zone, shift } = hit;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = zone.buffer;
    src.playbackRate.value = Math.pow(2, shift / 12);
    if (zone.loop) {
      src.loop = true;
      src.loopStart = zone.loop[0];
      src.loopEnd = zone.loop[1];
    }
    const g = Math.min(1.6, Math.max(0.15, Math.pow(vel / zone.vel, 0.9)));
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(g, t + 0.004);
    src.connect(amp).connect(out);
    src.start(t);
    const release = this.info.release;
    return () => {
      const r = ctx.currentTime;
      amp.gain.cancelScheduledValues(r);
      amp.gain.setValueAtTime(amp.gain.value, r);
      amp.gain.setTargetAtTime(0, r, release / 3);
      src.stop(r + release * 3 + 0.01);
    };
  }

  /** A closed or pedal hat cuts a ringing open hat, like a real hi-hat. */
  private choke(time: number): void {
    for (const h of this.openHats) {
      if (h.end <= time) {
        this.openHats.delete(h);
        continue;
      }
      h.gain.gain.cancelScheduledValues(time);
      h.gain.gain.setTargetAtTime(0, time, 0.012);
      this.openHats.delete(h);
    }
  }
}

function layerFor(list: LoadedZone[], vel: number): LoadedZone {
  // The softest layer at or above the velocity (scaled down), else the loudest.
  return list.find((z) => z.vel >= vel - 4) ?? list[list.length - 1];
}

export type LoadState = "loading" | "ready" | "failed";

/** Fetches and decodes instruments once per page, shared by every jam. */
export class SampleLibrary {
  private manifestP: Promise<SampleManifest | null> | null = null;
  private loaded = new Map<string, Promise<Instrument | null>>();
  private ready = new Map<string, Instrument>();
  readonly state = new Map<string, LoadState>();
  /** Bytes fetched so far (progress for the page). */
  fetched = 0;
  onChange: (() => void) | null = null;

  constructor(
    private ctx: BaseAudioContext,
    private base = "samples/",
    private fetcher: typeof fetch = (...a) => fetch(...a),
  ) {}

  manifest(): Promise<SampleManifest | null> {
    return (this.manifestP ??= this.fetcher(`${this.base}manifest.json`)
      .then((r) => (r.ok ? (r.json() as Promise<SampleManifest>) : null))
      .catch(() => null));
  }

  get(id: string): Instrument | undefined {
    return this.ready.get(id);
  }

  /** Load an instrument (once). Resolves to null when it can't be loaded; the synth covers for it. */
  load(id: string): Promise<Instrument | null> {
    let p = this.loaded.get(id);
    if (p) return p;
    this.state.set(id, "loading");
    this.onChange?.();
    p = (async () => {
      const m = await this.manifest();
      const info = m?.instruments[id];
      if (!info) throw new Error(`no samples for ${id}`);
      const cache = await openCache(`${CACHE}-${m!.bytes}`);
      const zones = await Promise.all(
        info.zones.map(async (z) => {
          const data = await this.fetchFile(`${this.base}${z.file}`, cache);
          return { ...z, buffer: await this.ctx.decodeAudioData(data) };
        }),
      );
      const inst = new Instrument(id, info, zones);
      this.ready.set(id, inst);
      this.state.set(id, "ready");
      return inst;
    })().catch((e) => {
      console.warn(`samples for ${id} didn't load; the synth plays instead`, e);
      this.state.set(id, "failed");
      this.loaded.delete(id); // a later lineup change can try again
      return null;
    });
    p.finally(() => this.onChange?.());
    this.loaded.set(id, p);
    return p;
  }

  private async fetchFile(url: string, cache: Cache | null): Promise<ArrayBuffer> {
    const hit = await cache?.match(url).catch(() => undefined);
    if (hit) return hit.arrayBuffer();
    const r = await this.fetcher(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    if (cache) void cache.put(url, r.clone()).catch(() => {});
    const buf = await r.arrayBuffer();
    this.fetched += buf.byteLength;
    return buf;
  }
}

/** One cache per sample set (named by its size), so re-rendered samples never mix with old ones. */
async function openCache(name: string): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(name);
  } catch {
    return null; // not a secure context, or storage is off
  }
}
