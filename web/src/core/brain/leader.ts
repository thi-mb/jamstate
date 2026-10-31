// A brain provider as the conductor's Leader. Never trusted for timing: a
// short timeout, and after a few failures the rule leader takes over until
// the brain answers again (ADR-0006). Replaces the old /api/leader client.

import type { Leader, LeaderReply } from "../conductor";
import { RuleLeader, type LeaderContext } from "../rules";
import { now, type BrainAnswer, type BrainProvider } from "./types";

export interface BrainLeaderOptions {
  timeoutMs: number;
  maxFailures?: number;
  /** Called with every answer (or error), for the overlay and recordings. */
  onAnswer?(ctx: LeaderContext, answer: BrainAnswer | null, error: string | null, latencyMs: number): void;
}

export type BrainStatus = { mode: "brain" | "fallback"; failures: number; lastLatencyMs?: number; lastError?: string; model?: string };

export class BrainLeader implements Leader {
  status: BrainStatus = { mode: "brain", failures: 0 };
  private probing = false;

  constructor(
    readonly brain: BrainProvider,
    private rules: RuleLeader,
    private opts: BrainLeaderOptions,
  ) {}

  set timeoutMs(ms: number) {
    this.opts.timeoutMs = ms;
  }

  private async call(ctx: LeaderContext): Promise<LeaderReply> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    const t0 = now();
    try {
      const answer = await this.brain.decide(ctx, ctrl.signal);
      const latencyMs = Math.round(now() - t0);
      this.status = { mode: "brain", failures: 0, lastLatencyMs: latencyMs, model: answer.model };
      this.opts.onAnswer?.(ctx, answer, null, latencyMs);
      return { moves: answer.moves, source: this.brain.kind, latencyMs };
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e as Error).name === "AbortError";
      const err = aborted ? `timed out after ${this.opts.timeoutMs} ms` : (e as Error).message;
      const failures = this.status.failures + 1;
      this.status = { ...this.status, failures, lastError: err, mode: failures >= (this.opts.maxFailures ?? 3) ? "fallback" : this.status.mode };
      this.opts.onAnswer?.(ctx, null, err, Math.round(now() - t0));
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async decide(ctx: LeaderContext): Promise<LeaderReply> {
    // Keep the rule leader's mood current either way, so a switch is seamless.
    const ruleMoves = this.rules.decide(ctx);
    if (this.status.mode === "fallback") {
      // Probe the brain in the background; its answer only flips us back.
      if (!this.probing) {
        this.probing = true;
        this.call(ctx)
          .catch(() => {})
          .finally(() => (this.probing = false));
      }
      return { moves: ruleMoves, source: `rules (${this.brain.kind} down)` };
    }
    try {
      return await this.call(ctx);
    } catch {
      return { moves: ruleMoves, source: `rules (${this.brain.kind} failed)` };
    }
  }
}
