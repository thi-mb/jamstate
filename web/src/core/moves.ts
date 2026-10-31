// The bandleader's fixed move set. schema/moves.schema.json mirrors this.

import { FEELS, PARTS, STINGERS, type Feel, type Part, type Stinger } from "./types";

export type Move =
  | { move: "set_intensity"; value: number; reason: string }
  | { move: "add_layer" | "drop_layer"; part: Part; reason: string }
  | { move: "jump_to_section"; section: string; reason: string }
  | { move: "extend_section"; bars: number; reason: string }
  | { move: "change_feel"; feel: Feel; reason: string }
  | { move: "fire_stinger"; stinger: Stinger; reason: string }
  | { move: "end_song"; reason: string };

export type MoveKind = Move["move"];

export const MOVE_KINDS: MoveKind[] = [
  "set_intensity",
  "add_layer",
  "drop_layer",
  "jump_to_section",
  "extend_section",
  "change_feel",
  "fire_stinger",
  "end_song",
];

/**
 * Moves only the player (buttons, cues) may make. The LLM's schema
 * (schema/moves.schema.json) leaves them out, and the conductor drops them
 * from any leader's reply.
 */
export const PLAYER_ONLY_MOVES: MoveKind[] = ["end_song"];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Parse one untrusted move (from the LLM, the server or a UI button). */
export function parseMove(raw: unknown): { move: Move } | { error: string } {
  if (!isObj(raw)) return { error: "move must be an object" };
  const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 120) : "";
  switch (raw.move) {
    case "set_intensity":
      if (typeof raw.value !== "number" || !(raw.value >= 0 && raw.value <= 1)) return { error: "value must be 0–1" };
      return { move: { move: raw.move, value: raw.value, reason } };
    case "add_layer":
    case "drop_layer":
      if (!PARTS.includes(raw.part as Part)) return { error: `part must be one of ${PARTS.join(", ")}` };
      return { move: { move: raw.move, part: raw.part as Part, reason } };
    case "jump_to_section":
      if (typeof raw.section !== "string") return { error: "section must be a string" };
      return { move: { move: raw.move, section: raw.section, reason } };
    case "extend_section":
      if (typeof raw.bars !== "number" || !Number.isInteger(raw.bars) || raw.bars < 1 || raw.bars > 16)
        return { error: "bars must be an integer 1–16" };
      return { move: { move: raw.move, bars: raw.bars, reason } };
    case "change_feel":
      if (!FEELS.includes(raw.feel as Feel)) return { error: `feel must be one of ${FEELS.join(", ")}` };
      return { move: { move: raw.move, feel: raw.feel as Feel, reason } };
    case "fire_stinger":
      if (!STINGERS.includes(raw.stinger as Stinger)) return { error: `stinger must be one of ${STINGERS.join(", ")}` };
      return { move: { move: raw.move, stinger: raw.stinger as Stinger, reason } };
    case "end_song":
      return { move: { move: raw.move, reason } };
    default:
      return { error: `unknown move "${String(raw.move)}"` };
  }
}

/** Short label for logs and the overlay, e.g. `set_intensity(0.7)`. */
export function describeMove(m: Move): string {
  switch (m.move) {
    case "set_intensity":
      return `set_intensity(${m.value.toFixed(2)})`;
    case "add_layer":
    case "drop_layer":
      return `${m.move}(${m.part})`;
    case "jump_to_section":
      return `jump_to_section(${m.section})`;
    case "extend_section":
      return `extend_section(${m.bars})`;
    case "change_feel":
      return `change_feel(${m.feel})`;
    case "fire_stinger":
      return `fire_stinger(${m.stinger})`;
    case "end_song":
      return "end_song";
  }
}
