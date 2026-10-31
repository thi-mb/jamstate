// Claude brain: the Anthropic Messages API with the player's own key, called
// straight from the page (the API allows browser calls when asked to). The
// SDK is loaded on first use so the page doesn't carry it until someone
// picks Claude.

import type Anthropic from "@anthropic-ai/sdk";
import type { LeaderContext } from "../rules";
import { extractJson, splitMoves } from "./check";
import { chartSchema, chartSystem, LEADER_SYSTEM, movesSchema, strictSchema } from "./prompt";
import { BrainError, now, type BrainAnswer, type BrainProvider, type ChartAnswer, type Fetch } from "./types";

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";
/** The default before 2026-10-31; settings that still hold it untouched move to the new one. */
export const OLD_DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export interface ClaudeConfig {
  apiKey: string;
  model?: string;
  /** Thinking depth; low keeps a phrase-level answer fast. */
  effort?: "low" | "medium" | "high";
  /** Override for a proxy; defaults to the Anthropic API. */
  baseURL?: string;
}

export class ClaudeBrain implements BrainProvider {
  readonly kind = "claude" as const;
  readonly label: string;
  private client: Promise<Anthropic> | null = null;

  constructor(
    private cfg: ClaudeConfig,
    private fetchFn?: Fetch,
  ) {
    this.label = `Claude ${cfg.model ?? DEFAULT_CLAUDE_MODEL}`;
  }

  private sdk(): Promise<Anthropic> {
    this.client ??= import("@anthropic-ai/sdk").catch((e) => {
      // Usually a page loaded before a rebuild asking for a chunk that is gone.
      this.client = null;
      throw new BrainError(`couldn't load the Claude client (${(e as Error).message}); reload the page`);
    }).then(
      ({ default: Anthropic }) =>
        new Anthropic({
          apiKey: this.cfg.apiKey,
          baseURL: this.cfg.baseURL,
          // The key is the player's own and stays on their machine (ADR-0016).
          dangerouslyAllowBrowser: true,
          // The conductor owns timeouts and fallback; a retry would only land late.
          maxRetries: 0,
          ...(this.fetchFn ? { fetch: this.fetchFn } : {}),
        }),
    );
    return this.client;
  }

  private async ask(system: string, user: string, schema: Record<string, unknown>, maxTokens: number, signal?: AbortSignal): Promise<{ data: unknown; model: string; usage?: unknown }> {
    if (!this.cfg.apiKey) throw new BrainError("no Claude API key set");
    const client = await this.sdk();
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.create(
        {
          model: this.cfg.model ?? DEFAULT_CLAUDE_MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
          output_config: { effort: this.cfg.effort ?? "low", format: { type: "json_schema", schema: strictSchema(schema) as Record<string, unknown> } },
        },
        { signal },
      );
    } catch (e) {
      const status = (e as { status?: number }).status;
      throw new BrainError(`Claude: ${(e as Error).message.slice(0, 200)}`, status);
    }
    if (msg.stop_reason === "refusal") throw new BrainError("Claude declined to answer");
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text) throw new BrainError(`Claude returned no text (stop: ${msg.stop_reason})`);
    try {
      return { data: extractJson(text), model: msg.model, usage: msg.usage };
    } catch (e) {
      throw new BrainError((e as Error).message);
    }
  }

  async decide(ctx: LeaderContext, signal?: AbortSignal): Promise<BrainAnswer> {
    const t0 = now();
    const { data, model, usage } = await this.ask(LEADER_SYSTEM, JSON.stringify(ctx), movesSchema(), 2000, signal);
    return { ...splitMoves(data, ctx.sections), model, latencyMs: Math.round(now() - t0), meta: { usage } };
  }

  async writeChart(prompt: string, genres: string[], signal?: AbortSignal): Promise<ChartAnswer> {
    const t0 = now();
    const { data, model } = await this.ask(chartSystem(genres), prompt.slice(0, 2000), chartSchema(genres), 8000, signal);
    return { chart: data, model, latencyMs: Math.round(now() - t0) };
  }
}
