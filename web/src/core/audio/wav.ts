// WAV files: the opt-in raw audio kept beside a session (16 kHz mono,
// 16-bit, ADR-0023), and test material for the eval.

export interface Wav {
  rate: number;
  /** One array per channel, -1..1. */
  channels: Float32Array[];
}

/** 16-bit PCM WAV of mono or multichannel float audio. */
export function encodeWav(channels: Float32Array[], rate: number): Uint8Array {
  const nch = channels.length;
  const n = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(44 + n * nch * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * nch * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * nch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  return bytes;
}

/** Reads 16/24/32-bit PCM and 32-bit float WAV. */
export function decodeWav(buf: ArrayBuffer | Uint8Array): Wav {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let o = 12;
  let fmt = 1;
  let nch = 1;
  let rate = 44100;
  let bits = 16;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      fmt = v.getUint16(body, true);
      nch = v.getUint16(body + 2, true);
      rate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (fmt === 0xfffe) fmt = v.getUint16(body + 24, true);
    } else if (id === "data") {
      const width = bits / 8;
      const n = Math.floor(Math.min(size, bytes.length - body) / (width * nch));
      const channels = Array.from({ length: nch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++)
        for (let c = 0; c < nch; c++) {
          const p = body + (i * nch + c) * width;
          channels[c][i] =
            fmt === 3 ? v.getFloat32(p, true)
            : bits === 16 ? v.getInt16(p, true) / 0x8000
            : bits === 24 ? ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)) / 0x800000)
            : bits === 32 ? v.getInt32(p, true) / 0x80000000
            : (v.getUint8(p) - 128) / 128;
        }
      return { rate, channels };
    }
    o = body + size + (size & 1);
  }
  throw new Error("WAV file has no data");
}

/** Mono mix of all channels. */
export function mono(w: Wav): Float32Array {
  if (w.channels.length === 1) return w.channels[0];
  const out = new Float32Array(w.channels[0].length);
  for (const ch of w.channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / w.channels.length;
  return out;
}
