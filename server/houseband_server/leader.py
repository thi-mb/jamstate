"""Bandleader and chart-writer prompts, plus validation of what the model returns.

The browser's governor re-checks every move against the song; validation here
only keeps malformed output away from the page and reports it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .llm import LLMClient, LLMError, extract_json

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "schema"

# Kept identical to docs/bandleader.md so the server can cache the prefix.
LEADER_SYSTEM = """You are the bandleader of a live backing band (drums, bass, chords) jamming
with one human player. Every few bars you get a summary of how they played
and what the band is doing. Decide whether the band should change anything.

Follow the player: when they get busier or louder, build; when they thin out,
make space; when they stop, drop back. Prefer small changes. Saying nothing is
often right. Never move more than two things at once.

Answer only with JSON matching the schema. Each move needs a short, friendly
reason addressed to the player."""

CHART_SYSTEM = """You write chord charts for a backing band. Given a description, return one
JSON chart matching the schema: title, bpm, time_sig ("4/4" or another N/4),
key, sections (name, bars, chords, optional intensity 0-1) and form (section
names in play order). Chords are symbols like Fm, Db, Ab, Eb7, Cmaj7, Bbm7,
F#m7b5, C/E; one entry per bar, cycled to fill the section; an entry with a
space splits the bar ("Fm Eb"). Describe structure only, never lyrics or
melody. Answer only with JSON."""

PARTS = ("drums", "bass", "chords")
FEELS = ("normal", "half_time", "double_time")
STINGERS = ("fill", "crash", "riser")
MAX_MOVES = 2


def load_schema(name: str) -> dict[str, Any]:
    return json.loads((SCHEMA_DIR / name).read_text())


def validate_move(m: Any, sections: list[str] | None = None) -> str | None:
    """Return an error string, or None if the move is well-formed."""
    if not isinstance(m, dict):
        return "move must be an object"
    kind = m.get("move")
    reason = m.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        return "reason is required"
    if len(reason) > 120:
        return "reason is longer than 120 characters"
    if kind == "set_intensity":
        v = m.get("value")
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not 0 <= v <= 1:
            return "value must be a number from 0 to 1"
    elif kind in ("add_layer", "drop_layer"):
        if m.get("part") not in PARTS:
            return f"part must be one of {', '.join(PARTS)}"
    elif kind == "jump_to_section":
        s = m.get("section")
        if not isinstance(s, str) or (sections is not None and s not in sections):
            return f"section must be one of {', '.join(sections or [])}"
    elif kind == "extend_section":
        b = m.get("bars")
        if not isinstance(b, int) or isinstance(b, bool) or not 1 <= b <= 16:
            return "bars must be an integer from 1 to 16"
    elif kind == "change_feel":
        if m.get("feel") not in FEELS:
            return f"feel must be one of {', '.join(FEELS)}"
    elif kind == "fire_stinger":
        if m.get("stinger") not in STINGERS:
            return f"stinger must be one of {', '.join(STINGERS)}"
    else:
        return f"unknown move {kind!r}"
    return None


def split_moves(payload: Any, sections: list[str] | None = None) -> tuple[list[dict], list[dict]]:
    """Split a model reply into (valid moves, rejected [{move, error}])."""
    raw = payload.get("moves") if isinstance(payload, dict) else payload
    if not isinstance(raw, list):
        return [], [{"move": payload, "error": "reply has no moves list"}]
    ok: list[dict] = []
    bad: list[dict] = []
    for m in raw:
        err = validate_move(m, sections)
        if err:
            bad.append({"move": m, "error": err})
        elif len(ok) >= MAX_MOVES:
            bad.append({"move": m, "error": f"more than {MAX_MOVES} moves"})
        else:
            ok.append(m)
    return ok, bad


def ask_leader(client: LLMClient, summary: dict[str, Any]) -> dict[str, Any]:
    """One bandleader turn: summary in, {moves, rejected, latency_ms, model} out."""
    res = client.chat(LEADER_SYSTEM, json.dumps(summary, separators=(",", ":")), load_schema("moves.schema.json"), "moves")
    sections = summary.get("sections") if isinstance(summary.get("sections"), list) else None
    moves, rejected = split_moves(extract_json(res.text), sections)
    return {"moves": moves, "rejected": rejected, "latency_ms": res.latency_ms, "model": res.model}


def write_chart(client: LLMClient, prompt: str) -> dict[str, Any]:
    """Ask the model for a chart. The browser validates it fully before use."""
    schema = load_schema("chart.schema.json")
    schema = {k: v for k, v in schema.items() if not k.startswith("$")}
    res = client.chat(CHART_SYSTEM, prompt, schema, "chart")
    chart = extract_json(res.text)
    if not isinstance(chart, dict) or not isinstance(chart.get("sections"), list) or not isinstance(chart.get("form"), list):
        raise LLMError("model did not return a chart")
    return {"chart": chart, "latency_ms": res.latency_ms, "model": res.model}
