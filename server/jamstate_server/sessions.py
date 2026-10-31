"""Recorded jam sessions, saved as JSON files on the Spark.

The page records every jam (jamstate-session/0.1, ADR-0014) and can save it
here; replay runs in the browser or with `npm run replay` in web/. The
server only stores files: it never reads the music in them.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

SESSION_FORMAT = "jamstate-session/0.1"
MAX_SESSION_BYTES = 8 * 1024 * 1024
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.json$")


class SessionError(ValueError):
    pass


def default_dir() -> Path:
    return Path.home() / ".local" / "share" / "jamstate" / "sessions"


class SessionStore:
    def __init__(self, root: Path):
        self.root = root

    def _path(self, name: str) -> Path:
        if not NAME_RE.match(name):
            raise SessionError("bad session name")
        return self.root / name

    def save(self, session: Any) -> str:
        if not isinstance(session, dict) or session.get("format") != SESSION_FORMAT:
            raise SessionError(f"not a {SESSION_FORMAT} file")
        for key in ("chart", "player", "controls", "bars"):
            if key not in session:
                raise SessionError(f"session has no {key}")
        title = str(session.get("title") or "session")
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "session"
        stamp = time.strftime("%Y%m%d-%H%M%S")
        self.root.mkdir(parents=True, exist_ok=True)
        name = f"{stamp}-{slug}.json"
        n = 2
        while (self.root / name).exists():
            name = f"{stamp}-{slug}-{n}.json"
            n += 1
        (self.root / name).write_text(json.dumps(session, separators=(",", ":")))
        return name

    def list(self) -> list[dict[str, Any]]:
        if not self.root.is_dir():
            return []
        out = []
        for p in sorted(self.root.glob("*.json"), reverse=True):
            try:
                s = json.loads(p.read_text())
                out.append({"name": p.name, "title": s.get("title"), "created": s.get("created"), "bars": len(s.get("bars") or []),
                            "genre": s.get("genre"), "leader": s.get("leader")})
            except (OSError, ValueError):
                continue
        return out

    def load(self, name: str) -> Any:
        p = self._path(name)
        if not p.is_file():
            raise FileNotFoundError(name)
        return json.loads(p.read_text())
