// The brain provider contract (ADR-0016). Every bandleader brain takes the
// same request (the summary from docs/bandleader.md) and returns zero or more
// moves; the page checks them here and the governor checks them again against
// the song. Nothing in this folder touches the DOM: HTTP goes through an
// injected fetch, so the same providers run in the page, in Node (replay and
// the bake-off) and later in a desktop shell.

import type { Move } from "../moves";
import type { LeaderContext } from "../rules";

export type BrainKind = "rules" | "openai" | "claude" | "jev" | "laya";

export interface Rejected {
  move: unknown;
  error: string;
}

export interface BrainAnswer {
  moves: Move[];
  /** Moves dropped by the checker, with why (for the overlay and evals). */
  rejected: Rejected[];
  /** Model that answered, as the provider reports it. */
  model?: string;
  /** Round trip, measured by the provider. */
  latencyMs: number;
  /** Provider-specific detail kept for the bake-off (choice probabilities, usage). */
  meta?: Record<string, unknown>;
}

export interface ChartAnswer {
  chart: unknown;
  model?: string;
  latencyMs: number;
}

export interface BrainProvider {
  readonly kind: BrainKind;
  /** Short label for the overlay, e.g. "Jev" or "Rules (in the page)". */
  readonly label: string;
  decide(ctx: LeaderContext, signal?: AbortSignal): Promise<BrainAnswer>;
  /** Text to chart. Only text-writing brains (LLMs) have it. */
  writeChart?(prompt: string, genres: string[], signal?: AbortSignal): Promise<ChartAnswer>;
}

export class BrainError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BrainError";
  }
}

/** fetch, injected so tests and other shells can swap it. */
export type Fetch = typeof globalThis.fetch;

export const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
