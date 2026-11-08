#!/usr/bin/env python3
"""Render jamstate's built-in instrument samples from a SoundFont.

    pip install pyfluidsynth numpy   # needs libfluidsynth and ffmpeg (libopus)
    python sounds/render.py path/to/MuseScore_General.sf2 [--out web/public/samples] [--only piano,kit]

Reads sounds/instruments.json and writes one small mono Ogg Opus file per
note and velocity layer, plus web/public/samples/manifest.json, which the page
reads to map a note and velocity to a file. Pitched instruments are sampled
every three semitones and the page repitches up to 1.5 semitones either way.
Sustained instruments (organ, pads) get a loop with a baked crossfade so a
held chord can ring as long as the song needs. The SoundFont's own reverb and
chorus are off: the page adds the room (web/src/audio/mixer.ts).

Licenses and sizes are written down in docs/samples.md.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import fluidsynth
import numpy as np

RATE = 48000
ROOT = Path(__file__).resolve().parent.parent
BITRATE = "56k"
SILENCE_DB = -60.0


def db(x: float) -> float:
    return 20 * np.log10(max(x, 1e-12))


def render_note(fs: fluidsynth.Synth, chan: int, key: int, vel: int, hold: float, tail: float) -> np.ndarray:
    fs.noteon(chan, key, vel)
    a = fs.get_samples(int(hold * RATE))
    fs.noteoff(chan, key)
    b = fs.get_samples(int(tail * RATE))
    fs.all_sounds_off(chan) if hasattr(fs, "all_sounds_off") else None
    flush = fs.get_samples(int(0.3 * RATE))  # let the voice die before the next note
    del flush
    st = np.concatenate([a, b]).astype(np.float32).reshape(-1, 2) / 32768.0
    return st.mean(axis=1)


def trim(x: np.ndarray, keep_start: bool = False) -> tuple[np.ndarray, int]:
    """Cut leading and trailing silence. Returns the audio and how many samples were cut at the start."""
    thr = 10 ** (SILENCE_DB / 20)
    idx = np.nonzero(np.abs(x) > thr)[0]
    if not len(idx):
        return x[:0], 0
    start = 0 if keep_start else max(0, int(idx[0]) - int(0.0005 * RATE))
    # Trailing: last 10 ms window above the threshold.
    win = int(0.01 * RATE)
    n = len(x) // win
    env = np.abs(x[: n * win]).reshape(n, win).max(axis=1)
    loud = np.nonzero(env > thr)[0]
    end = min(len(x), (int(loud[-1]) + 2) * win) if len(loud) else len(x)
    y = x[start:end].copy()
    fade = min(len(y), int(0.02 * RATE))
    if fade:
        y[-fade:] *= np.linspace(1, 0, fade)
    return y, start


def bake_loop(x: np.ndarray, start: float, end: float, xfade: float = 0.25) -> tuple[np.ndarray, float, float]:
    """Crossfade the end of the loop into the audio before its start, so end→start is seamless."""
    s, e, f = int(start * RATE), int(end * RATE), int(xfade * RATE)
    e = min(e, len(x))
    y = x[:e].copy()
    ramp = np.linspace(0, 1, f, dtype=np.float32)
    # Equal-power crossfade: the loop's last f samples blend into the f samples just before the loop start.
    y[e - f : e] = x[e - f : e] * np.cos(ramp * np.pi / 2) + x[s - f : s] * np.sin(ramp * np.pi / 2)
    return y, s / RATE, e / RATE


def write_ogg(x: np.ndarray, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
        with wave.open(tmp.name, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(pcm.tobytes())
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", tmp.name, "-c:a", "libopus", "-b:a", BITRATE, "-application", "audio", "-map_metadata", "-1", str(path)],
            check=True,
        )
    return path.stat().st_size


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("soundfont")
    ap.add_argument("--out", default=str(ROOT / "web/public/samples"))
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    spec = json.loads((ROOT / "sounds/instruments.json").read_text())
    out = Path(args.out)
    only = set(filter(None, args.only.split(",")))
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() and only else {"instruments": {}}
    manifest.update({"format": "jamstate-samples/0.1", "source": spec["source"], "rate": RATE})

    fs = fluidsynth.Synth(samplerate=float(RATE), gain=0.4)
    fs.setting("synth.reverb.active", 0)
    fs.setting("synth.chorus.active", 0)
    sfid = fs.sfload(args.soundfont)

    for inst in spec["instruments"]:
        iid = inst["id"]
        if only and iid not in only:
            continue
        if "samples" in inst:
            continue  # plays another instrument's samples; written after the loop
        bank, prog = inst["preset"]
        chan = 9 if bank == 128 else 0
        fs.program_select(chan, sfid, bank, prog)
        kind = inst.get("kind", "pitched")
        zones = []
        raw: list[tuple[dict, np.ndarray]] = []
        if kind in ("kit", "percussion"):
            keys = spec["kit_keys"] if kind == "kit" else spec["percussion_keys"]
            for key, length in keys.items():
                for vel in inst["velocities"]:
                    x = render_note(fs, chan, int(key), vel, 0.05, float(length))
                    x, _ = trim(x)
                    if not len(x):
                        print(f"  {iid}: key {key} vel {vel} is silent, skipped", file=sys.stderr)
                        continue
                    raw.append(({"file": f"{iid}/{key}-{vel}.ogg", "key": int(key), "vel": vel}, x))
        else:
            lo, hi = inst["range"]
            hold = float(inst["hold"])
            loop = inst.get("loop")
            for key in range(lo, hi + 1, 3):
                for vel in inst["velocities"]:
                    x = render_note(fs, chan, key, vel, hold, 0.05 if loop else 1.5)
                    x, cut = trim(x)
                    zone = {"file": f"{iid}/{key}-{vel}.ogg", "key": key, "vel": vel}
                    if loop:
                        x, ls, le = bake_loop(x, loop[0] - cut / RATE, loop[1] - cut / RATE)
                        zone["loop"] = [round(ls, 4), round(le, 4)]
                    raw.append((zone, x))
        # One gain for the whole instrument: the loudest sample peaks at -1 dBFS, dynamics between layers kept.
        peak = max(float(np.abs(x).max()) for _, x in raw)
        scale = 10 ** (-1 / 20) / peak
        total = 0
        for zone, x in raw:
            total += write_ogg(x * scale, out / zone["file"])
            zones.append(zone)
        manifest["instruments"][iid] = {
            "part": inst["part"],
            "name": inst["name"],
            "kind": kind,
            "release": inst.get("release", 0.1),
            "bytes": total,
            "zones": zones,
        }
        print(f"{iid}: {len(zones)} samples, {total / 1e6:.2f} MB (peak was {db(peak):.1f} dBFS)")

    # Instruments that reuse another's samples (the crunch guitar is the clean one through an amp).
    for inst in spec["instruments"]:
        src = inst.get("samples")
        if not src or src not in manifest["instruments"]:
            continue
        base = manifest["instruments"][src]
        manifest["instruments"][inst["id"]] = {
            "part": inst["part"],
            "name": inst["name"],
            "kind": base["kind"],
            "release": inst.get("release", base["release"]),
            "bytes": base["bytes"],
            "zones": [dict(z) for z in base["zones"]],
            "samples": src,
        }

    manifest["bytes"] = sum(i["bytes"] for i in manifest["instruments"].values() if "samples" not in i)
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"total {manifest['bytes'] / 1e6:.2f} MB → {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
