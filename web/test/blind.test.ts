import { describe, expect, it } from "vitest";
import { blindCandidates, DEFAULT_SETTINGS, makeBrain, mergeSettings, pickBlind, summarizeBlind } from "../src/core/brain";

describe("blind test", () => {
  it("only offers brains that can run here", () => {
    const s = mergeSettings({});
    expect(blindCandidates(s, { llmRelay: false, jevRelay: false })).toEqual(["rules"]);
    expect(blindCandidates(s, { llmRelay: true, jevRelay: true })).toEqual(["rules", "openai", "jev"]);
    const withKey = mergeSettings({ claude: { apiKey: "k" }, openai: { url: "http://localhost:11434/v1" } });
    expect(blindCandidates(withKey, { llmRelay: false, jevRelay: false })).toEqual(["rules", "openai", "claude"]);
    expect(blindCandidates(mergeSettings({ jev: { ...DEFAULT_SETTINGS.jev, relay: false } }), { llmRelay: false, jevRelay: true })).toEqual(["rules"]);
  });

  it("picks the least-tried brain", () => {
    expect(pickBlind(["rules", "jev", "claude"], { rules: 2, jev: 1, claude: 2 })).toBe("jev");
    const seen = new Set([0, 0.5, 0.99].map((r) => pickBlind(["rules", "jev"], {}, () => r)));
    expect(seen).toEqual(new Set(["rules", "jev"]));
    expect(() => pickBlind([], {})).toThrow();
  });

  it("blind is a setting, not a brain", () => {
    expect(mergeSettings({ kind: "blind" }).kind).toBe("blind");
    expect(makeBrain(mergeSettings({ kind: "blind" }))).toBeNull();
  });

  it("summarizes ratings per brain, ignoring other jams", () => {
    const rows = summarizeBlind([
      { leader: "blind:jev", rating: { stars: 4, note: "tight" } },
      { leader: "blind:jev", rating: { stars: 5 } },
      { leader: "blind:rules", rating: { stars: 3 } },
      { leader: "blind:rules" },
      { leader: "jev", rating: { stars: 1 } },
    ]);
    expect(rows).toEqual([
      { brain: "jev", jams: 2, rated: 2, mean: 4.5, notes: ["tight"] },
      { brain: "rules", jams: 2, rated: 1, mean: 3, notes: [] },
    ]);
  });
});

describe("Claude through the server", () => {
  it("uses the relay when the page has no key, and joins the blind pool", async () => {
    expect(blindCandidates(mergeSettings({}), { llmRelay: false, jevRelay: false, claudeRelay: true })).toEqual(["rules", "claude"]);
    const g = globalThis as { location?: unknown };
    g.location = { href: "http://spark:8765/app/" };
    const seen: { url: string; key: string | null }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), key: new Headers(init.headers).get("x-api-key") });
      const body = { id: "m", type: "message", role: "assistant", model: "claude-x", stop_reason: "end_turn", content: [{ type: "text", text: '{"moves":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as never;
    try {
      const brain = makeBrain(mergeSettings({ kind: "claude" }), fetchFn)!;
      const a = await brain.decide({ bar: 1, section: "a", bar_in_section: 0, section_bars: 4, phrase_bars: 4, intensity: 0.5, target: 0.5, layers: [], feel: "normal", form: ["a"], form_pos: 0, sections: ["a"], player: { bars: 4, energy: 0.5, density: 1, mean_velocity: 0.5, rest_ratio: 0.2, repetition: 0, register: "mid", trend: "steady", silent_bars: 0 }, recent_moves: [] } as never);
      expect(a.moves).toEqual([]);
      expect(seen[0]).toEqual({ url: "http://spark:8765/app/api/relay/anthropic/v1/messages", key: "relay" });
    } finally {
      delete g.location;
    }
  });
});

describe("Claude default model", () => {
  it("is Haiku 5.5, and an untouched old default moves to it", () => {
    expect(mergeSettings({}).claude.model).toBe("claude-haiku-5-5");
    expect(mergeSettings({ claude: { model: "claude-opus-5-5", apiKey: "" } }).claude.model).toBe("claude-haiku-5-5");
    expect(mergeSettings({ claude: { model: "claude-opus-5-5", apiKey: "", modelChosen: true } }).claude.model).toBe("claude-opus-5-5");
  });
});
