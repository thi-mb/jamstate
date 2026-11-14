// npm run fetch-models
//
// The speech model for voice cues (ADR-0026): Vosk's small English model
// (Apache 2.0, about 40 MB), from alphacephei.com, unpacked to
// ~/.local/share/jamstate/vosk (where the voice eval reads it) and packed
// as the tar.gz vosk-browser loads, in public/models/ (not committed; the
// build copies it into dist/). Needs curl, unzip and tar.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "vosk-model-small-en-us-0.15";
const URL = `https://alphacephei.com/vosk/models/${NAME}.zip`;
const home = join(homedir(), ".local/share/jamstate/vosk");
const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(web, "public/models", `${NAME}.tar.gz`);

mkdirSync(home, { recursive: true });
if (!existsSync(join(home, NAME, "am"))) {
  const zip = join(home, `${NAME}.zip`);
  console.log(`fetching ${URL}`);
  execFileSync("curl", ["-fL", "--retry", "3", "-o", zip, URL], { stdio: "inherit" });
  execFileSync("unzip", ["-q", "-o", zip, "-d", home], { stdio: "inherit" });
  rmSync(zip);
}
if (!existsSync(out)) {
  mkdirSync(dirname(out), { recursive: true });
  execFileSync("tar", ["-czf", out, "-C", home, NAME]);
}
console.log(`model: ${join(home, NAME)}\npage:  ${out}`);
