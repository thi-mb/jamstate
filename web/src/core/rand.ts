// Seeded randomness. Everything the band varies (pattern choice, ghost notes,
// micro-timing) draws from a generator seeded by the session seed plus where
// we are in the song, so a recorded session replays note for note.

/** Small deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the string forms of the parts. Stable across runs and machines. */
export function hash(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x1f; // separator, so ("ab","c") and ("a","bc") differ
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A generator for one decision, keyed by the session seed and a place in the song. */
export function rngFor(seed: number, ...where: (string | number)[]): () => number {
  return rng(hash(seed, ...where));
}

/** Pick from weighted options. */
export function pickWeighted<T>(items: T[], weight: (x: T) => number, r: number): T {
  const total = items.reduce((s, x) => s + weight(x), 0);
  let at = r * total;
  for (const x of items) {
    at -= weight(x);
    if (at < 0) return x;
  }
  return items[items.length - 1];
}
