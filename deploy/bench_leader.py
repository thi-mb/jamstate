#!/usr/bin/env python3
"""Measure bandleader latency and output validity against an OpenAI-compatible server.

Sends realistic leader requests (see docs/bandleader.md) to the model server
and reports latency percentiles against the bar length at a given tempo, so we
can tell whether moves land on the next phrase (ADR-0006, ADR-0011).

Stdlib only. Examples:

    python3 deploy/bench_leader.py --url http://127.0.0.1:8080/v1 --model qwen3-30b-a3b
    python3 deploy/bench_leader.py --url http://127.0.0.1:8080/v1 --model gpt-oss-20b -n 50 --bpm 112
    python3 deploy/bench_leader.py --url http://127.0.0.1:8765/api/relay/llm   # through the jamstate server's relay

The prompt and move checking now live in the page (web/src/core/brain); to
compare every brain on recorded sessions use `npm run bakeoff` in web/.
"""

import argparse
import json
import random
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

SYSTEM_PROMPT = """You are the bandleader of a live backing band (drums, bass, chords) jamming
with one human player. Every few bars you get a summary of how they played
and what the band is doing. Decide whether the band should change anything.

Follow the player: when they get busier or louder, build; when they thin out,
make space; when they stop, drop back. Prefer small changes. Saying nothing is
often right. Never move more than two things at once.

Answer only with JSON matching the schema. Each move needs a short, friendly
reason addressed to the player."""

MOVES = {
    "set_intensity": "value",
    "add_layer": "part",
    "drop_layer": "part",
    "jump_to_section": "section",
    "extend_section": "bars",
    "change_feel": "feel",
    "fire_stinger": "stinger",
}

# Used only if schema/moves.schema.json is not in the repo yet.
FALLBACK_SCHEMA = {
    "type": "object",
    "properties": {
        "moves": {
            "type": "array",
            "maxItems": 2,
            "items": {
                "type": "object",
                "properties": {
                    "move": {"type": "string", "enum": list(MOVES)},
                    "value": {"type": "number", "minimum": 0, "maximum": 1},
                    "part": {"type": "string", "enum": ["drums", "bass", "chords"]},
                    "section": {"type": "string"},
                    "bars": {"type": "integer", "minimum": 1, "maximum": 16},
                    "feel": {"type": "string", "enum": ["normal", "half_time", "double_time"]},
                    "stinger": {"type": "string", "enum": ["fill", "crash", "riser"]},
                    "reason": {"type": "string", "maxLength": 120},
                },
                "required": ["move", "reason"],
            },
        }
    },
    "required": ["moves"],
}

SCENARIOS = {
    "sparse": dict(energy=0.25, density=0.4, rest_ratio=0.7, trend="falling", silent_bars=0),
    "busy": dict(energy=0.8, density=2.6, rest_ratio=0.05, trend="rising", silent_bars=0),
    "silent": dict(energy=0.0, density=0.0, rest_ratio=1.0, trend="falling", silent_bars=4),
    "steady": dict(energy=0.55, density=1.2, rest_ratio=0.3, trend="steady", silent_bars=0),
}


def load_schema():
    path = REPO / "schema" / "moves.schema.json"
    if path.exists():
        return json.loads(path.read_text()), str(path.relative_to(REPO))
    return FALLBACK_SCHEMA, "built-in fallback"


def make_request(rng, scenario):
    sections = ["intro", "verse", "chorus", "outro"]
    layers = rng.choice([["bass"], ["bass", "chords"], ["drums", "bass", "chords"]])
    intensity = round(rng.uniform(0.2, 0.8), 2)
    player = dict(SCENARIOS[scenario])
    player.update(
        bars=4,
        mean_velocity=round(min(1.0, player["energy"] + 0.1), 2) if player["silent_bars"] == 0 else 0.0,
        repetition=round(rng.uniform(0, 0.5), 2),
        register=None if player["silent_bars"] else rng.choice(["low", "mid", "high"]),
    )
    return {
        "bar": rng.randrange(8, 160),
        "section": rng.choice(sections[1:3]),
        "bar_in_section": rng.choice([4, 8, 12]),
        "section_bars": 16,
        "phrase_bars": 4,
        "intensity": intensity,
        "target": intensity,
        "layers": layers,
        "feel": "normal",
        "form": ["intro", "verse", "chorus", "verse", "chorus", "outro"],
        "form_pos": rng.randrange(1, 5),
        "sections": sections,
        "player": player,
        "recent_moves": rng.choice([[], ["set_intensity(0.50)"], ["drop_layer(drums)"]]),
    }


def post(url, body, timeout):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def validate(moves):
    """Return a list of problems with a parsed {"moves": [...]} answer."""
    if not isinstance(moves, list):
        return ["moves is not a list"]
    problems = []
    if len(moves) > 2:
        problems.append(f"{len(moves)} moves (max 2)")
    for m in moves:
        name = m.get("move")
        if name not in MOVES:
            problems.append(f"unknown move {name!r}")
        elif MOVES[name] not in m:
            problems.append(f"{name} missing {MOVES[name]}")
        if not m.get("reason"):
            problems.append(f"{name} has no reason")
    return problems


def call_model(args, schema, request):
    body = {
        "model": args.model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(request)},
        ],
        "temperature": 0.4,
        "max_tokens": 200,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "moves", "schema": schema, "strict": True},
        },
    }
    t0 = time.perf_counter()
    resp = post(args.url.rstrip("/") + "/chat/completions", body, args.timeout)
    ms = (time.perf_counter() - t0) * 1000
    text = resp["choices"][0]["message"].get("content") or ""
    tokens = (resp.get("usage") or {}).get("completion_tokens")
    moves = json.loads(text).get("moves")
    return ms, tokens, moves


def pct(values, p):
    values = sorted(values)
    k = max(0, min(len(values) - 1, round(p / 100 * (len(values) - 1))))
    return values[k]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--url", default="http://127.0.0.1:8080/v1", help="OpenAI-compatible base URL")
    ap.add_argument("--model", default="default")
    ap.add_argument("-n", type=int, default=30, help="number of requests")
    ap.add_argument("--bpm", type=float, default=112)
    ap.add_argument("--beats-per-bar", type=int, default=4)
    ap.add_argument("--timeout", type=float, default=10)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--show", action="store_true", help="print each answer")
    args = ap.parse_args()

    schema, schema_src = load_schema()
    rng = random.Random(args.seed)
    bar_ms = 60000 / args.bpm * args.beats_per_bar
    target_ms = 1500

    target = f"{args.url} ({args.model})"
    print(f"target: {target}\nschema: {schema_src}\nrequests: {args.n}, bar = {bar_ms:.0f} ms at {args.bpm:g} bpm\n")

    # One untimed call so model load and prompt-cache warm-up don't skew results.
    try:
        req = make_request(rng, "steady")
        call_model(args, schema, req)
    except Exception as e:  # noqa: BLE001 - report and keep going
        print(f"warm-up failed: {e}")

    latencies, token_counts, invalid, errors = [], [], 0, 0
    by_scenario = {s: [] for s in SCENARIOS}
    for i in range(args.n):
        scenario = list(SCENARIOS)[i % len(SCENARIOS)]
        req = make_request(rng, scenario)
        try:
            ms, tokens, moves = call_model(args, schema, req)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError) as e:
            errors += 1
            print(f"[{i:3}] {scenario:7} ERROR {e}")
            continue
        latencies.append(ms)
        if tokens:
            token_counts.append((tokens, ms))
        problems = validate(moves)
        invalid += bool(problems)
        by_scenario[scenario].append(moves or [])
        summary = ", ".join(m.get("move", "?") for m in moves or []) or "(no move)"
        flag = f"  INVALID: {'; '.join(problems)}" if problems else ""
        print(f"[{i:3}] {scenario:7} {ms:7.0f} ms  {summary}{flag}")
        if args.show:
            print("      " + json.dumps(moves))

    if not latencies:
        print("\nno successful requests")
        return 1

    p50, p95, worst = pct(latencies, 50), pct(latencies, 95), max(latencies)
    print("\nlatency  p50 {:.0f} ms   p95 {:.0f} ms   max {:.0f} ms".format(p50, p95, worst))
    print(f"         p95 = {p95 / bar_ms:.2f} bars at {args.bpm:g} bpm (target p95 < {target_ms} ms)")
    if token_counts:
        rates = [t / (ms / 1000) for t, ms in token_counts]
        avg_tokens = statistics.mean(t for t, _ in token_counts)
        print(f"output   {avg_tokens:.0f} tokens avg, {statistics.median(rates):.0f} tok/s end-to-end median")
    print(f"quality  {invalid} invalid, {errors} errors of {args.n}")
    for scenario, answers in by_scenario.items():
        counts = {}
        for moves in answers:
            for m in moves:
                counts[m.get("move")] = counts.get(m.get("move"), 0) + 1
        empty = sum(1 for moves in answers if not moves)
        print(f"         {scenario:7} no-move {empty}/{len(answers)}  {counts}")
    verdict = "PASS" if p95 < target_ms and not invalid and not errors else "MISS"
    print(f"\n{verdict}")
    return 0 if verdict == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
