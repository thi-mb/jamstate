// npm run guitar -- render <session.json> <out.wav> [--rate 48000] [--channels 2] [--on 2]
// npm run guitar -- sim <chart.json> <script> <out.wav> [same options] [--seed N]
//   [--voice "6:take it down,14:trade fours"]
//
// Renders a session's player notes (or a pretend player's, from a script
// like "busy:8,silent:4") as a plucked guitar into a WAV. With --channels 2
// the guitar goes on one input (--on 1 or 2) and the other is silent, like a
// Scarlett Solo's instrument input. --voice says phrases (Piper, as in the
// voice eval) at those seconds on the other input, like a mic on input 1.
// Test material for the page's audio and voice checks and the guitar eval
// (v0.5).
import { readFileSync, writeFileSync } from "node:fs";
import { resample, SR } from "../src/core/audio/dsp";
import { renderSessionTake } from "../src/core/audio/takes";
import { encodeWav } from "../src/core/audio/wav";
import type { ChartJSON } from "../src/core/chart";
import { checkSession } from "../src/core/session";
import { recordSimSession } from "../src/core/simsession";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const rate = Number(opt("rate") ?? 48000);
const channels = Number(opt("channels") ?? 1);
const on = Number(opt("on") ?? 2);
const seed = Number(opt("seed") ?? 11);
const voice = opt("voice");
const [cmd, ...rest] = args;

let session;
let out: string;
if (cmd === "render" && rest.length === 2) {
  session = checkSession(JSON.parse(readFileSync(rest[0], "utf8")));
  out = rest[1];
} else if (cmd === "sim" && rest.length === 3) {
  session = recordSimSession(JSON.parse(readFileSync(rest[0], "utf8")) as ChartJSON, rest[1], { seed });
  out = rest[2];
} else {
  console.error("usage: npm run guitar -- render <session.json> <out.wav> | sim <chart.json> <script> <out.wav> [--rate R] [--channels 1|2] [--on 1|2] [--seed N]");
  process.exit(2);
}
// Rendered at 16 kHz like the detector hears it, then brought up to the device rate.
const take = resample(renderSessionTake(session, { seed }), SR, rate);
const other = new Float32Array(take.length);
if (voice) {
  const { say } = await import("./guitar-voice");
  for (const item of voice.split(",")) {
    const [at, text] = item.split(":");
    const s = resample(say(text.trim(), "en_US-ryan-low", 1).x, SR, rate);
    other.set(s.subarray(0, Math.max(0, other.length - Math.round(Number(at) * rate))), Math.round(Number(at) * rate));
  }
}
const chans = channels === 2 ? (on === 1 ? [take, other] : [other, take]) : [take];
writeFileSync(out, encodeWav(chans, rate));
console.log(`${out}: ${(take.length / rate).toFixed(1)} s, ${channels} channel(s) at ${rate} Hz${channels === 2 ? `, guitar on input ${on}` : ""}`);
