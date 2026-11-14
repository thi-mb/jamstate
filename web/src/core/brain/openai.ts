// OpenAI-compatible brain: llama.cpp (Qwen on the Spark), Ollama, vLLM,
// OpenAI itself. Asks for JSON constrained by the moves schema and degrades
// to json_object, then plain text, when the server rejects the format.

import { guardFollow } from "../leading";
import type { Move } from "../moves";
import type { LeaderContext } from "../rules";
import { extractJson, splitMoves } from "./check";
import { chartSchema, chartSystem, leaderSystem, movesSchema } from "./prompt";
import { BrainError, now, type BrainAnswer, type BrainProvider, type ChartAnswer, type Fetch } from "./types";

export interface OpenAIConfig {
  /** Base URL that ends before /chat/completions, e.g. http://127.0.0.1:8080/v1 or api/relay/llm. */
  url: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  label?: string;
}

export class OpenAIBrain implements BrainProvider {
  readonly kind = "openai" as const;
  readonly label: string;

  constructor(
    private cfg: OpenAIConfig,
    private fetchFn: Fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.label = cfg.label ?? `LLM ${cfg.model}`;
  }

  private async post(payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.fetchFn(this.cfg.url.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
      body: JSON.stringify(payload),
      signal,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 300) };
    }
    return { status: res.status, body };
  }

  /** One chat turn; returns the reply text and model. */
  async chat(system: string, user: string, schema: Record<string, unknown> | null, name: string, signal?: AbortSignal): Promise<{ text: string; model: string }> {
    const base = {
      model: this.cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: this.cfg.temperature ?? 0.3,
      max_tokens: this.cfg.maxTokens ?? 300,
      stream: false,
    };
    const formats: (Record<string, unknown> | null)[] = schema
      ? [{ type: "json_schema", json_schema: { name, strict: true, schema } }, { type: "json_object" }, null]
      : [null];
    let last = "";
    for (const fmt of formats) {
      const { status, body } = await this.post(fmt ? { ...base, response_format: fmt } : base, signal);
      if (status === 400 && fmt) {
        // Usually this response_format isn't supported; try the next one.
        last = JSON.stringify(body.error ?? body).slice(0, 200);
        continue;
      }
      if (status < 200 || status >= 300) throw new BrainError(`HTTP ${status} from model server: ${JSON.stringify(body.error ?? body).slice(0, 200)}`, status);
      const choices = body.choices as { message?: { content?: string } }[] | undefined;
      const text = choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new BrainError(`unexpected response shape: ${JSON.stringify(body).slice(0, 200)}`);
      return { text, model: typeof body.model === "string" ? body.model : this.cfg.model };
    }
    throw new BrainError(`no response format accepted: ${last}`, 400);
  }

  async decide(ctx: LeaderContext, signal?: AbortSignal): Promise<BrainAnswer> {
    const t0 = now();
    const { text, model } = await this.chat(leaderSystem(ctx), JSON.stringify(ctx), movesSchema(), "moves", signal);
    let payload: unknown;
    try {
      payload = extractJson(text);
    } catch (e) {
      throw new BrainError((e as Error).message);
    }
    const { moves, rejected } = splitMoves(payload, ctx.sections);
    // v0.4 policy: the LLM leads, the follow guard keeps the band with the player.
    return { moves: guardFollow(ctx, moves) as Move[], rejected, model, latencyMs: Math.round(now() - t0) };
  }

  async writeChart(prompt: string, genres: string[], signal?: AbortSignal): Promise<ChartAnswer> {
    const t0 = now();
    const res = await this.chat(chartSystem(genres), prompt.slice(0, 2000), chartSchema(genres), "chart", signal);
    return { chart: extractJson(res.text), model: res.model, latencyMs: Math.round(now() - t0) };
  }
}
