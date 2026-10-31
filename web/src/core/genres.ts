/// <reference types="vite/client" />
// The genre registry. Every genres/*.json pack at the repo root is bundled
// and validated at startup, so adding a genre is adding a file.

import { loadGenre, type GenrePack } from "./genre";

const files = import.meta.glob("../../../genres/*.json", { eager: true, import: "default" }) as Record<string, unknown>;

const registry = new Map<string, GenrePack>();
for (const raw of Object.values(files)) {
  const pack = loadGenre(raw);
  registry.set(pack.id, pack);
}

/** Used when a chart names no genre. */
export const DEFAULT_GENRE = "blues-rock";

export function genreIds(): string[] {
  return [...registry.keys()];
}

export function allGenres(): GenrePack[] {
  return [...registry.values()];
}

export function getGenre(id: string | undefined): GenrePack {
  const g = registry.get(id ?? DEFAULT_GENRE) ?? registry.get(DEFAULT_GENRE);
  if (!g) throw new Error(`No genre "${id}" and no default genre pack`);
  return g;
}

/** Add or replace a pack at runtime (tests, or a pack loaded from a file). */
export function registerGenre(raw: unknown): GenrePack {
  const pack = loadGenre(raw);
  registry.set(pack.id, pack);
  return pack;
}
