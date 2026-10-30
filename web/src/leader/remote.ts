// The LLM bandleader, reached through /api/leader on the houseband server
// (which proxies to the model on the DGX Spark). Never trusted for timing:
// short timeout, and after a few failures the rule leader takes over until
// the LLM answers again.

import type { Leader, LeaderReply } from "../core/conductor";
import type { LeaderContext, RuleLeader } from "../core/rules";

export interface RemoteLeaderOptions {
  endpoint?: string;
  timeoutMs: number;
  maxFailures?: number;
}

export type LeaderStatus = { mode: "llm" | "fallback"; failures: number; lastLatencyMs?: number; lastError?: string; model?: string };

export class RemoteLeader implements Leader {
  status: LeaderStatus = { mode: "llm", failures: 0 };
  private probing = false;

  constructor(
    private rules: RuleLeader,
    private opts: RemoteLeaderOptions,
  ) {}

  set timeoutMs(ms: number) {
    this.opts.timeoutMs = ms;
  }

  private async call(ctx: LeaderContext): Promise<LeaderReply> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(this.opts.endpoint ?? "/api/leader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ctx),
        signal: ctrl.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const latencyMs = Math.round(performance.now() - t0);
      this.status = { mode: "llm", failures: 0, lastLatencyMs: latencyMs, model: body.model };
      return { moves: Array.isArray(body.moves) ? body.moves : [], source: "llm", latencyMs };
    } catch (e) {
      const err = (e as Error).name === "AbortError" ? `timed out after ${this.opts.timeoutMs} ms` : (e as Error).message;
      const failures = this.status.failures + 1;
      this.status = { ...this.status, failures, lastError: err, mode: failures >= (this.opts.maxFailures ?? 3) ? "fallback" : this.status.mode };
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async decide(ctx: LeaderContext): Promise<LeaderReply> {
    // Keep the rule leader's mood up to date either way, so a switch is seamless.
    const ruleMoves = this.rules.decide(ctx);
    if (this.status.mode === "fallback") {
      // Probe the LLM in the background; its answer only flips us back.
      if (!this.probing) {
        this.probing = true;
        this.call(ctx)
          .catch(() => {})
          .finally(() => (this.probing = false));
      }
      return { moves: ruleMoves, source: "rules (llm down)" };
    }
    try {
      return await this.call(ctx);
    } catch {
      return { moves: ruleMoves, source: "rules (llm failed)" };
    }
  }
}
