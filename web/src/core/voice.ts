// Voice cues (v0.5 layer 5, ADR-0026): a fixed grammar of spoken phrases,
// each meaning one cue (or trading on / off). The recogniser can only answer
// with one of these phrases or "[unk]"; a result counts only when it's one
// whole phrase and every word in it is heard with enough confidence.
//
// The recogniser's final result waits for a pause after the phrase. A
// phrase no other phrase starts with can be taken sooner, from the partial
// result, once it has held for a moment (VoiceCues).

import type { Cue } from "./engine";

export type VoiceCue = Cue | "trade_on" | "trade_off";

export const VOICE_PHRASES: Record<string, VoiceCue> = {
  "next section": "next_section",
  "next part": "next_section",
  "break": "drums_break",
  "drums break": "drums_break",
  "drums only": "drums_only",
  "build": "build",
  "build it up": "build",
  "take it down": "take_down",
  "bring it down": "take_down",
  "one more chorus": "one_more",
  "one more time": "one_more",
  "end the song": "end_song",
  "let's end it": "end_song",
  "trade fours": "trade_on",
  "stop trading": "trade_off",
};

/** The recogniser's grammar: the phrases and the catch-all for anything else. */
export const VOICE_GRAMMAR = [...Object.keys(VOICE_PHRASES), "[unk]"];

/** The lowest confidence any word of a phrase may have. */
export const VOICE_FLOOR = 0.7;

/** A final result as Vosk gives it (with words on). */
export interface VoiceResult {
  text: string;
  result?: { word: string; conf: number; start: number; end: number }[];
}

export interface VoiceHeard {
  cue: VoiceCue;
  phrase: string;
  /** The lowest word confidence. */
  conf: number;
  /** When the phrase ended, in the recogniser's seconds. */
  end: number;
}

/**
 * The cue a final result means, or null. Unknown words around the phrase (a
 * breath, the guitar) are let go only when the recogniser was unsure of
 * them; a confident unknown word means the phrase was part of something else.
 */
export function cueOf(r: VoiceResult, floor = VOICE_FLOOR): VoiceHeard | null {
  const words = r.result ?? r.text.split(/\s+/).filter(Boolean).map((word) => ({ word, conf: 1, start: 0, end: 0 }));
  let a = 0;
  let b = words.length;
  while (a < b && words[a].word === "[unk]" && words[a].conf < floor) a++;
  while (b > a && words[b - 1].word === "[unk]" && words[b - 1].conf < floor) b--;
  const core = words.slice(a, b);
  if (!core.length) return null;
  const phrase = core.map((w) => w.word).join(" ");
  const cue = VOICE_PHRASES[phrase];
  if (!cue) return null;
  const conf = Math.min(...core.map((w) => w.conf));
  if (conf < floor) return null;
  return { cue, phrase, conf, end: core[core.length - 1].end };
}

/** A partial result taken early has to stay the same this long (seconds). */
export const VOICE_HOLD = 0.25;
const PHRASES = Object.keys(VOICE_PHRASES);
/** Phrases another phrase starts with ("build", "build it up"): only a final result settles those. */
const PREFIXES = new Set(PHRASES.filter((p) => PHRASES.some((q) => q !== p && q.startsWith(`${p} `))));

/**
 * One utterance at a time, one cue each: from its partial results when a
 * whole phrase holds for `hold` seconds, otherwise from its final result.
 * Feed every partial result (vosk-browser sends one per chunk) and every
 * final one, with the time of the audio heard so far.
 */
export class VoiceCues {
  private text = "";
  private since = 0;
  private fired = false;

  constructor(
    private hold = VOICE_HOLD,
    private floor = VOICE_FLOOR,
  ) {}

  partial(text: string, at: number): VoiceHeard | null {
    if (text !== this.text) {
      this.text = text;
      this.since = at;
    }
    if (this.fired || this.hold === Infinity || at - this.since < this.hold) return null;
    const cue = VOICE_PHRASES[text];
    if (!cue || PREFIXES.has(text)) return null;
    this.fired = true;
    return { cue, phrase: text, conf: 1, end: at };
  }

  final(r: VoiceResult): VoiceHeard | null {
    const fired = this.fired;
    this.fired = false;
    this.text = "";
    return fired ? null : cueOf(r, this.floor);
  }
}
