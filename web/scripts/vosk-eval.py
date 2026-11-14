"""The voice-cue eval's recogniser (ADR-0026): Vosk in Python, the same
engine, model and grammar the page runs in WASM (vosk-browser).

Reads {"model": DIR, "grammar": [...], "files": [WAV, ...]} on stdin (16 kHz
mono 16-bit WAVs) and writes one JSON line per file: its final results, each
with its words and `at`, the seconds of audio fed when the result came out,
and its partial results (each change of the text so far, with `at`).
The audio goes in 0.1 s chunks, as the page's worklet sends it.

Run by scripts/guitar-voice.ts with VOSK_PYTHON (a Python with `vosk`).
"""

import json
import sys
import wave

from vosk import KaldiRecognizer, Model, SetLogLevel

CHUNK = 1600


def main() -> None:
    job = json.load(sys.stdin)
    SetLogLevel(-1)
    model = Model(job["model"])
    grammar = json.dumps(job["grammar"])
    for path in job["files"]:
        rec = KaldiRecognizer(model, 16000, grammar)
        rec.SetWords(True)
        results = []
        partials = []
        fed = 0
        with wave.open(path, "rb") as w:
            assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, path
            while True:
                data = w.readframes(CHUNK)
                if not data:
                    break
                fed += len(data) // 2
                if rec.AcceptWaveform(data):
                    r = json.loads(rec.Result())
                    if r.get("text"):
                        results.append({**r, "at": fed / 16000})
                    if partials and partials[-1]["partial"]:
                        partials.append({"partial": "", "at": fed / 16000})
                else:
                    p = json.loads(rec.PartialResult()).get("partial", "")
                    if not partials or partials[-1]["partial"] != p:
                        partials.append({"partial": p, "at": fed / 16000})
        r = json.loads(rec.FinalResult())
        if r.get("text"):
            results.append({**r, "at": fed / 16000})
        print(json.dumps({"file": path, "results": results, "partials": partials}), flush=True)


if __name__ == "__main__":
    main()
