// Prompts and schemas for text-writing brains (LLMs). Moved from the Python
// server (ADR-0015): the prompt now ships with the page. Kept identical to
// docs/bandleader.md so model servers can cache the prefix.

import chartSchemaJson from "../../../../schema/chart.schema.json";
import movesSchemaJson from "../../../../schema/moves.schema.json";

export const LEADER_SYSTEM = `You are the bandleader of a live backing band (the parts in "lineup") jamming
with one human player. Every few bars you get a summary of how they played
and what the band is doing. Decide whether the band should change anything.

Follow the player: when they get busier or louder, build; when they thin out,
make space; when they stop, drop back. Prefer small changes. Saying nothing is
often right. Never move more than two things at once.

Answer only with JSON matching the schema. Each move needs a short, friendly
reason addressed to the player, under 100 characters.`;

export function chartSystem(genres: string[]): string {
  return `You write chord charts for a backing band. Given a description, return one
JSON chart matching the schema: version "0.1", title, bpm, time_sig ("4/4" or
another N/4), key, genre (one of ${genres.join(", ")}; pick the closest), sections
(name, bars, chords, optional intensity 0-1) and form (section names in play
order). Add swing (0 straight to 0.66 triplet) only if the description asks
for a feel the genre doesn't have. Chords are symbols like Fm, Db, Ab, Eb7,
Cmaj7, Bbm7, F#m7b5, C/E; one entry per bar, cycled to fill the section; an
entry with a space splits the bar ("Fm Eb"). Describe structure only, never
lyrics or melody. Answer only with JSON.`;
}

type Schema = Record<string, unknown>;

const stripMeta = (s: Schema): Schema => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith("$")));

/** schema/moves.schema.json, without the $-keys some servers reject. */
export function movesSchema(): Schema {
  return stripMeta(structuredClone(movesSchemaJson) as Schema);
}

/**
 * schema/chart.schema.json with the genre limited to the installed packs. The
 * band is left out: a written chart plays with its genre's band, and the
 * player picks another lineup in the page.
 */
export function chartSchema(genres: string[]): Schema {
  const s = stripMeta(structuredClone(chartSchemaJson) as Schema);
  const props = s.properties as Record<string, Schema>;
  props.genre = { ...props.genre, enum: genres };
  delete props.band;
  return s;
}

/**
 * A schema reduced to what strict structured-output decoders accept
 * (Anthropic's): anyOf instead of oneOf, no numeric/length limits, no
 * titles. The checker enforces the dropped limits afterwards.
 */
export function strictSchema(schema: unknown): unknown {
  const DROP = new Set(["minimum", "maximum", "maxLength", "minLength", "maxItems", "minItems", "title", "description", "$schema", "$id", "pattern", "format", "default", "examples"]);
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Schema = {};
  for (const [k, v] of Object.entries(schema as Schema)) {
    if (DROP.has(k)) continue;
    out[k === "oneOf" ? "anyOf" : k] = k === "properties" ? Object.fromEntries(Object.entries(v as Schema).map(([p, ps]) => [p, strictSchema(ps)])) : strictSchema(v);
  }
  if (out.type === "object" && out.properties && !("additionalProperties" in out)) out.additionalProperties = false;
  return out;
}
