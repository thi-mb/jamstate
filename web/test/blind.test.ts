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
