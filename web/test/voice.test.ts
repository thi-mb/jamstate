// Voice cues (v0.5 layer 5, ADR-0026): what a recogniser result means.

import { describe, expect, it } from "vitest";
import { CUES } from "../src/core/engine";
import { cueOf, VOICE_GRAMMAR, VOICE_PHRASES, VoiceCues, type VoiceResult } from "../src/core/voice";

const words = (...w: [string, number][]): VoiceResult => ({
  text: w.map(([x]) => x).join(" "),
  result: w.map(([word, conf], i) => ({ word, conf, start: i * 0.3, end: i * 0.3 + 0.25 })),
});

describe("the cue grammar", () => {
  it("covers every cue key and trading on and off", () => {
    const cues = new Set(Object.values(VOICE_PHRASES));
    for (const c of CUES) expect(cues.has(c), c).toBe(true);
    expect(cues.has("trade_on") && cues.has("trade_off")).toBe(true);
    expect(VOICE_GRAMMAR).toContain("[unk]");
  });
});

describe("cueOf", () => {
  it("a whole phrase heard surely is its cue", () => {
    expect(cueOf(words(["take", 1], ["it", 0.9], ["down", 1]))).toMatchObject({ cue: "take_down", phrase: "take it down", conf: 0.9, end: 0.85 });
    expect(cueOf(words(["trade", 1], ["fours", 1]))?.cue).toBe("trade_on");
  });

  it("a word heard unsurely, part of a phrase or a phrase in a sentence is nothing", () => {
    expect(cueOf(words(["take", 1], ["it", 0.4], ["down", 1]))).toBeNull();
    expect(cueOf(words(["one", 1], ["more", 1]))).toBeNull();
    expect(cueOf(words(["let's", 1], ["end", 1], ["break", 1]))).toBeNull();
    expect(cueOf(words(["[unk]", 1], ["take", 1], ["it", 1], ["down", 1]))).toBeNull();
    expect(cueOf({ text: "[unk]" })).toBeNull();
  });

  it("an unsure unknown word at either end (a breath, a strum) is let go", () => {
    expect(cueOf(words(["[unk]", 0.3], ["drums", 1], ["only", 1], ["[unk]", 0.5]))?.cue).toBe("drums_only");
  });

  it("text without words (no confidences) is taken as heard", () => {
    expect(cueOf({ text: "end the song" })?.cue).toBe("end_song");
  });
});

describe("VoiceCues", () => {
  it("takes a phrase from the partial result once it has held, then not again from the final", () => {
    const v = new VoiceCues(0.25);
    expect(v.partial("take it", 1.0)).toBeNull();
    expect(v.partial("take it down", 1.1)).toBeNull();
    expect(v.partial("take it down", 1.3)).toBeNull();
    expect(v.partial("take it down", 1.4)).toMatchObject({ cue: "take_down", end: 1.4 });
    expect(v.partial("take it down", 1.5)).toBeNull();
    expect(v.final(words(["take", 1], ["it", 1], ["down", 1]))).toBeNull();
    // The next utterance starts afresh.
    expect(v.partial("trade fours", 3.0)).toBeNull();
    expect(v.partial("trade fours", 3.3)?.cue).toBe("trade_on");
  });

  it("a phrase another one starts with waits for the final result", () => {
    const v = new VoiceCues(0.25);
    expect(v.partial("build", 1)).toBeNull();
    expect(v.partial("build", 2)).toBeNull();
    expect(v.final(words(["build", 1], ["it", 1], ["up", 1]))?.cue).toBe("build");
  });

  it("a partial that changes is no cue; the final result decides", () => {
    const v = new VoiceCues(0.25);
    v.partial("one more time", 1);
    v.partial("one more time [unk]", 1.2);
    expect(v.partial("one more time [unk]", 1.6)).toBeNull();
    expect(v.final(words(["one", 1], ["more", 1], ["time", 1], ["[unk]", 0.9]))).toBeNull();
  });

  it("with an endless hold only final results count", () => {
    const v = new VoiceCues(Infinity);
    expect(v.partial("drums only", 1)).toBeNull();
    expect(v.partial("drums only", 9)).toBeNull();
    expect(v.final(words(["drums", 1], ["only", 1]))?.cue).toBe("drums_only");
  });
});
