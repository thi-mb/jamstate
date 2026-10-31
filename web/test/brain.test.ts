/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { BrainLeader, makeBrain, mergeSettings, RulesBrain, splitMoves, checkMove, extractJson, DEFAULT_SETTINGS, type BrainProvider, type Fetch } from "../src/core/brain";
import { ClaudeBrain } from "../src/core/brain/claude";
import { changeOptions, JevBrain, jevMoves, jevQuestions, jevState, LEVELS } from "../src/core/brain/jev";
import { LayaBrain, layaChangeOptions, layaMoves, layaQuestions, layaState } from "../src/core/brain/laya";
import { OpenAIBrain } from "../src/core/brain/openai";
import { chartSchema, LEADER_SYSTEM, movesSchema, strictSchema } from "../src/core/brain/prompt";
import { MemorySessionStore, MemoryStore, sessionName } from "../src/core/platform";
import { RuleLeader, type LeaderContext } from "../src/core/rules";
import { replaySession } from "../src/core/session";
import { recordSimSession } from "../src/core/simsession";
import type { ChartJSON } from "../src/core/chart";
import nightShiftJson from "../public/charts/night-shift.json";
import leaderDoc from "../../docs/bandleader.md?raw";

const CTX: LeaderContext = {
  bar: 15,
  section: "verse",
  bar_in_section: 3,
  section_bars: 8,
  phrase_bars: 4,
  intensity: 0.4,
  target: 0.4,
  layers: ["drums", "bass", "chords"],
  feel: "normal",
  form: ["intro", "verse", "chorus"],
  form_pos: 1,
  sections: ["intro", "verse", "chorus"],
  player: { bars: 4, energy: 0.8, density: 3.1, mean_velocity: 0.8, rest_ratio: 0.1, repetition: 0.2, register: "mid", trend: "rising", silent_bars: 0 },
  recent_moves: [],
};

const SILENT: LeaderContext = { ...CTX, player: { ...CTX.player, energy: 0, density: 0, mean_velocity: 0, rest_ratio: 1, register: null, trend: "falling", silent_bars: 4 } };

/** A fetch that answers from a list and records what it was sent. */
function fakeFetch(replies: { status?: number; body: unknown }[]) {
  const sent: { url: string; init: RequestInit; body: any }[] = [];
  const fn: Fetch = async (url, init) => {
    sent.push({ url: String(url), init: init!, body: init?.body ? JSON.parse(String(init.body)) : null });
    const r = replies.shift() ?? { body: {} };
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fn, sent };
}

describe("move checking (moved from the server)", () => {
  it("keeps good moves, rejects bad ones with a reason, and caps at two", () => {
    const { moves, rejected } = splitMoves(
      {
        moves: [
          { move: "set_intensity", value: 0.8, reason: "You're pushing" },
          { move: "jump_to_section", section: "bridge", reason: "nope" },
          { move: "end_song", reason: "bye" },
          { move: "add_layer", part: "drums", reason: "in" },
          { move: "fire_stinger", stinger: "fill", reason: "three" },
        ],
      },
      CTX.sections,
    );
    expect(moves.map((m) => m.move)).toEqual(["set_intensity", "add_layer"]);
    expect(rejected.map((r) => r.error)).toEqual([expect.stringMatching(/^section must be one of/), "end_song is the player's call", "more than 2 moves"]);
  });

  it("matches the old server validator on edge cases", () => {
    expect(checkMove({ move: "add_layer", part: "drums", reason: "x" })).toBeNull();
    expect(checkMove({ move: "add_layer", part: "keys", reason: "x" })).toBeTruthy();
    expect(checkMove({ move: "set_intensity", value: 2, reason: "x" })).toBeTruthy();
    expect(checkMove({ move: "set_intensity", value: 0.5 })).toBe("reason is required");
    expect(checkMove({ move: "extend_section", bars: true, reason: "x" })).toBeTruthy();
    expect(checkMove({ move: "set_intensity", value: 0.5, reason: "x".repeat(121) })).toMatch(/longer/);
    expect(splitMoves("nonsense").rejected[0].error).toBe("reply has no moves list");
  });

  it("extracts JSON from chatty replies", () => {
    expect(extractJson('<think>hmm</think>Sure! {"moves": []} hope that helps')).toEqual({ moves: [] });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson("no json here")).toThrow(/did not return JSON/);
  });
});

describe("prompts and schemas", () => {
  it("ships the documented system prompt", () => {
    expect(leaderDoc).toContain(LEADER_SYSTEM);
  });

  it("offers only installed genres and strips $-keys", () => {
    const s = chartSchema(["funk", "jazz"]) as any;
    expect(s.properties.genre.enum).toEqual(["funk", "jazz"]);
    expect(Object.keys(s).some((k) => k.startsWith("$"))).toBe(false);
    expect((movesSchema() as any).properties.moves.maxItems).toBe(2);
  });

  it("makes a strict schema with anyOf and no numeric limits", () => {
    const s = JSON.stringify(strictSchema(movesSchema()));
    expect(s).not.toMatch(/oneOf|maximum|maxItems|maxLength|"title"/);
    expect(s).toContain("anyOf");
    expect(s).toContain('"additionalProperties":false');
  });
});

describe("OpenAI-compatible brain", () => {
  it("asks for schema-constrained JSON and checks the reply", async () => {
    const { fn, sent } = fakeFetch([{ body: { model: "qwen", choices: [{ message: { content: JSON.stringify({ moves: [{ move: "set_intensity", value: 0.7, reason: "with you" }] }) } }] } }]);
    const a = await new OpenAIBrain({ url: "http://x/v1/", model: "leader", apiKey: "k" }, fn).decide(CTX);
    expect(a.moves).toEqual([{ move: "set_intensity", value: 0.7, reason: "with you" }]);
    expect(a.model).toBe("qwen");
    expect(sent[0].url).toBe("http://x/v1/chat/completions");
    expect((sent[0].init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(sent[0].body.response_format.type).toBe("json_schema");
    expect(JSON.parse(sent[0].body.messages[1].content).bar).toBe(15);
  });

  it("degrades to json_object, then plain text, when the server rejects the format", async () => {
    const { fn, sent } = fakeFetch([{ status: 400, body: { error: "no" } }, { status: 400, body: { error: "no" } }, { body: { choices: [{ message: { content: '{"moves":[]}' } }] } }]);
    const a = await new OpenAIBrain({ url: "http://x/v1", model: "m" }, fn).decide(CTX);
    expect(a.moves).toEqual([]);
    expect(sent.map((s) => s.body.response_format?.type ?? null)).toEqual(["json_schema", "json_object", null]);
  });

  it("throws on server errors and writes charts", async () => {
    const { fn } = fakeFetch([{ status: 502, body: { error: "down" } }, { body: { choices: [{ message: { content: JSON.stringify(nightShiftJson) } }] } }]);
    const b = new OpenAIBrain({ url: "http://x/v1", model: "m" }, fn);
    await expect(b.decide(CTX)).rejects.toThrow(/HTTP 502/);
    expect(((await b.writeChart("moody", ["funk"])).chart as ChartJSON).title).toBe("Night Shift");
  });
});

describe("Claude brain", () => {
  it("calls the Messages API with structured output and checks the moves", async () => {
    const reply = { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ moves: [{ move: "add_layer", part: "drums", reason: "Drums in" }, { move: "end_song", reason: "x" }] }) }], usage: { input_tokens: 1, output_tokens: 1 } };
    const { fn, sent } = fakeFetch([{ body: reply }]);
    const a = await new ClaudeBrain({ apiKey: "sk-test" }, fn).decide(CTX);
    expect(a.moves).toEqual([{ move: "add_layer", part: "drums", reason: "Drums in" }]);
    expect(a.rejected).toHaveLength(1);
    expect(sent[0].url).toMatch(/\/v1\/messages$/);
    expect(sent[0].body.model).toBe("claude-haiku-5-5");
    expect(sent[0].body.output_config.format.type).toBe("json_schema");
    expect(sent[0].body.output_config.effort).toBe("low");
    expect(sent[0].body.system).toBe(LEADER_SYSTEM);
  });

  it("needs a key and reports refusals", async () => {
    await expect(new ClaudeBrain({ apiKey: "" }).decide(CTX)).rejects.toThrow(/no Claude API key/);
    const { fn } = fakeFetch([{ body: { id: "m", type: "message", role: "assistant", model: "x", stop_reason: "refusal", content: [], usage: {} } }]);
    await expect(new ClaudeBrain({ apiKey: "k" }, fn).decide(CTX)).rejects.toThrow(/declined/);
  });
});

describe("Jev brain", () => {
  it("asks a score and a choice built from the band's state", () => {
    const q = jevQuestions(CTX) as any;
    expect(q.level.type).toBe("score");
    expect(q.level.criteria).toHaveLength(LEVELS.length);
    expect(q.change.type).toBe("choice");
    const ids = Object.keys(q.change.criteria);
    expect(ids).toContain("keep");
    expect(ids).toContain("drop_drums");
    expect(ids).not.toContain("add_drums"); // drums already play
    expect(ids).not.toContain("feel_normal"); // already normal
    expect(ids).not.toContain("jump_verse"); // already there
    const quiet = jevQuestions({ ...CTX, layers: ["bass"] }) as any;
    expect(Object.keys(quiet.change.criteria)).toContain("add_drums");
    expect(Object.keys(quiet.change.criteria)).not.toContain("drop_bass"); // never drop the last part
    expect((jevState(SILENT).player as any).sounds).toBe("stopped");
    expect((jevState(CTX).player as any).sounds).toBe("busy and loud");
  });

  it("maps answers to moves with templated reasons", () => {
    const up = jevMoves(CTX, { level: { score: 3.5 }, change: { choice: "stinger_fill" } });
    expect(up.moves).toEqual([
      { move: "set_intensity", value: 0.9, reason: "You're building, the band lifts with you" },
      { move: "fire_stinger", stinger: "fill", reason: "A fill to mark the lift" },
    ]);
    const down = jevMoves(SILENT, { level: { score: 0 }, change: { choice: "drop_drums" } });
    expect(down.moves.map((m) => m.move)).toEqual(["set_intensity", "drop_layer"]);
    expect(down.moves[0]).toMatchObject({ value: 0.1, reason: "You went quiet, giving you space" });
    // Within the deadband and "keep": nothing to do.
    expect(jevMoves(CTX, { level: { score: 2 }, change: { choice: "keep" } }).moves).toEqual([]);
    expect(jevMoves(CTX, { level: { score: 2 }, change: { choice: "bogus" } }).rejected[0].error).toBe("unknown option");
    for (const opt of changeOptions(CTX).values()) if (opt.move) expect(checkMove(opt.move, CTX.sections)).toBeNull();
  });

  it("posts to the TypeSafe API (or a relay) and surfaces errors", async () => {
    const { fn, sent } = fakeFetch([{ body: { model: "jev-1", answers: { level: { type: "score", score: 0.2 }, change: { type: "choice", choice: "keep" } } } }, { status: 401, body: "bad key" }]);
    const b = new JevBrain({ apiKey: "tk", url: "api/relay/jev" }, fn);
    const a = await b.decide(SILENT);
    expect(a.model).toBe("jev-1");
    expect(a.moves[0]).toMatchObject({ move: "set_intensity" });
    expect(sent[0].url).toBe("api/relay/jev");
    expect(sent[0].body.model).toBe("jev-latest");
    expect(sent[0].body.state.band.not_playing).toEqual([]);
    await expect(b.decide(CTX)).rejects.toThrow(/HTTP 401/);
  });
});

describe("Laya brain", () => {
  it("states the player in words and offers changes that fit them", () => {
    expect(layaState(SILENT)).toMatch(/^The player has stopped playing: 4 silent bars/);
    expect(layaState(CTX)).toMatch(/busy and loud.*getting louder/);
    expect(layaState(CTX)).not.toMatch(/intensity/); // told the band's level, Laya repeats it
    expect(layaState({ ...CTX, layers: ["bass"] })).toMatch(/drums and chords are out/);
    const q = layaQuestions(CTX) as any;
    expect(q.level.type).toBe("choice");
    expect(Object.keys(q.level.criteria)).toEqual(["silent", "soft", "medium", "strong", "full"]);
    // Busy player, everyone in: keep or a fill, nothing to drop.
    expect([...layaChangeOptions(CTX).keys()]).toEqual(["keep", "fill"]);
    // Stopped: drops only, never the last part.
    expect([...layaChangeOptions(SILENT).keys()]).toEqual(["keep", "drop_drums", "drop_bass", "drop_chords"]);
    expect([...layaChangeOptions({ ...SILENT, layers: ["bass"] }).keys()]).toEqual(["keep"]);
    expect([...layaChangeOptions({ ...CTX, layers: ["bass"] }).keys()]).toEqual(["keep", "add_drums", "add_chords", "fill"]);
    for (const c of [CTX, SILENT, { ...CTX, layers: ["bass"] as LeaderContext["layers"] }])
      for (const opt of layaChangeOptions(c).values()) if (opt.move) expect(checkMove(opt.move, c.sections)).toBeNull();
  });

  it("maps its top picks to moves", () => {
    const down = layaMoves(SILENT, { level: { choice: "silent" }, change: { choice: "drop_drums" } });
    expect(down.moves).toEqual([
      { move: "set_intensity", value: 0.1, reason: "You went quiet, giving you space" },
      { move: "drop_layer", part: "drums", reason: "You went quiet, drums out so it can breathe" },
    ]);
    expect(layaMoves({ ...CTX, target: 0.5 }, { level: { choice: "medium" }, change: { choice: "keep" } }).moves).toEqual([]);
    expect(layaMoves(CTX, { level: { choice: "loud" } }).rejected[0].error).toBe("unknown level");
    expect(layaMoves(CTX, { change: { choice: "drop_drums" } }).rejected[0].error).toBe("unknown option"); // not offered to a busy player
  });

  it("posts to the local server on Jev's wire", async () => {
    const { fn, sent } = fakeFetch([{ body: { model: "laya@mlx", answers: { level: { type: "choice", choice: "strong" }, change: { type: "choice", choice: "fill" } } } }]);
    const a = await new LayaBrain({ url: "http://127.0.0.1:8010/v1/systemone" }, fn).decide(CTX);
    expect(a.model).toBe("laya@mlx");
    expect(a.moves.map((m) => m.move)).toEqual(["set_intensity", "fire_stinger"]);
    expect(typeof sent[0].body.state).toBe("string");
    expect(sent[0].init.headers).not.toHaveProperty("authorization");
  });
});

describe("brain leader (fallback wrapper)", () => {
  it("falls back to rules after repeated failures and recovers", async () => {
    let fail = true;
    const brain: BrainProvider = {
      kind: "jev",
      label: "Flaky",
      decide: async () => {
        if (fail) throw new Error("down");
        return { moves: [{ move: "set_intensity", value: 0.9, reason: "back" }], rejected: [], latencyMs: 1 };
      },
    };
    const leader = new BrainLeader(brain, new RuleLeader(), { timeoutMs: 1000, maxFailures: 2 });
    expect((await leader.decide(CTX)).source).toBe("rules (jev failed)");
    expect((await leader.decide(CTX)).source).toBe("rules (jev failed)");
    expect(leader.status.mode).toBe("fallback");
    fail = false;
    expect((await leader.decide(CTX)).source).toBe("rules (jev down)");
    await new Promise((r) => setTimeout(r, 0));
    expect(leader.status.mode).toBe("brain");
    const r = await leader.decide(CTX);
    expect(r.source).toBe("jev");
    expect(r.moves).toHaveLength(1);
  });

  it("times out slow brains", async () => {
    const slow: BrainProvider = { kind: "openai", label: "Slow", decide: (_c, signal) => new Promise((_, no) => signal?.addEventListener("abort", () => no(Object.assign(new Error("aborted"), { name: "AbortError" })))) };
    const leader = new BrainLeader(slow, new RuleLeader(), { timeoutMs: 20 });
    expect((await leader.decide(CTX)).source).toBe("rules (openai failed)");
    expect(leader.status.lastError).toBe("timed out after 20 ms");
  });
});

describe("brain settings", () => {
  it("merges stored settings over defaults and builds providers", () => {
    const s = mergeSettings({ kind: "jev", jev: { apiKey: "x" } });
    expect(s.jev).toEqual({ ...DEFAULT_SETTINGS.jev, apiKey: "x" });
    expect(mergeSettings({ kind: "wat" }).kind).toBe("rules");
    expect(makeBrain({ ...s, kind: "none" })).toBeNull();
    expect(makeBrain(s)?.kind).toBe("jev");
    expect(makeBrain({ ...s, kind: "openai" })?.kind).toBe("openai");
    expect(makeBrain({ ...s, kind: "claude" })?.kind).toBe("claude");
    expect(makeBrain({ ...s, kind: "rules" })).toBeInstanceOf(RulesBrain);
  });
});

describe("platform: storage", () => {
  it("memory stores keep settings and sessions", async () => {
    const kv = new MemoryStore();
    kv.set("a", { b: 1 });
    expect(kv.get("a")).toEqual({ b: 1 });
    kv.remove("a");
    expect(kv.get("a")).toBeNull();

    const store = new MemorySessionStore();
    const f = recordSimSession(nightShiftJson as ChartJSON, "busy:4,silent:4", { seed: 3 });
    const name = await store.save(f);
    expect(name).toBe(sessionName(f));
    expect((await store.list())[0]).toMatchObject({ name, title: "Night Shift", bars: f.bars.length });
    expect((await store.load(name)).player).toEqual(f.player);
    await store.remove(name);
    expect(await store.list()).toEqual([]);
  });
});

describe("simulated sessions and brain replay", () => {
  it("records a session that replays exactly", async () => {
    const f = recordSimSession(nightShiftJson as ChartJSON, "medium:4,sparse:4,busy:6,silent:4", { seed: 9 });
    expect(f.bars.length).toBe(18 + ((nightShiftJson as ChartJSON).count_in ?? 1));
    const r = await replaySession(f);
    expect(r.mismatches).toEqual([]);
  });

  it("lets any brain drive a replay through the governor", async () => {
    const f = recordSimSession(nightShiftJson as ChartJSON, "busy:8,silent:8", { seed: 5 });
    const { fn } = fakeFetch(
      Array.from({ length: 10 }, () => ({ body: { model: "jev-1", answers: { level: { score: 0 }, change: { choice: "drop_drums" } } } })),
    );
    const leader = new BrainLeader(new JevBrain({ apiKey: "k" }, fn), new RuleLeader(), { timeoutMs: 1000 });
    const r = await replaySession(f, { leader, everyBars: 4 });
    expect(r.decisions).toBeGreaterThan(2);
    const applied = r.bars.flatMap((b) => b.moves);
    expect(applied.some((m) => m.startsWith("drop_layer(drums) [jev]"))).toBe(true);
    expect(applied.some((m) => m.startsWith("set_intensity(0.10) [jev]"))).toBe(true);
  });
});
