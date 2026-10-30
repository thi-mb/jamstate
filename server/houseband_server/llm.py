"""Minimal OpenAI-compatible chat client (llama.cpp llama-server, vLLM, ...).

Standard library only, so the server installs anywhere, including the Spark.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


class LLMError(RuntimeError):
    pass


@dataclass
class ChatResult:
    text: str
    latency_ms: int
    model: str


@dataclass
class LLMClient:
    base_url: str
    model: str = "default"
    api_key: str | None = None
    timeout: float = 10.0
    temperature: float = 0.3
    max_tokens: int = 300

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        req = urllib.request.Request(
            self.base_url.rstrip("/") + "/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json", **({"authorization": f"Bearer {self.api_key}"} if self.api_key else {})},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            raise LLMError(f"HTTP {e.code} from model server: {body}") from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise LLMError(f"model server unreachable: {e}") from e

    def chat(self, system: str, user: str, schema: dict[str, Any] | None = None, schema_name: str = "response") -> ChatResult:
        """One chat turn. With a schema, asks for constrained JSON and degrades
        to json_object, then to plain text, if the server rejects the format."""
        base = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": False,
        }
        formats: list[dict[str, Any] | None] = [None]
        if schema is not None:
            formats = [
                {"type": "json_schema", "json_schema": {"name": schema_name, "strict": True, "schema": schema}},
                {"type": "json_object"},
                None,
            ]
        t0 = time.monotonic()
        last: LLMError | None = None
        for fmt in formats:
            payload = dict(base, **({"response_format": fmt} if fmt else {}))
            try:
                data = self._post(payload)
            except LLMError as e:
                # A 400 usually means this response_format isn't supported; try the next one.
                if "HTTP 400" in str(e) and fmt is not None:
                    last = e
                    continue
                raise
            try:
                text = data["choices"][0]["message"]["content"] or ""
            except (KeyError, IndexError, TypeError) as e:
                raise LLMError(f"unexpected response shape: {str(data)[:200]}") from e
            return ChatResult(text=text, latency_ms=round((time.monotonic() - t0) * 1000), model=data.get("model") or self.model)
        raise last or LLMError("no response format accepted")


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def extract_json(text: str) -> Any:
    """Parse JSON from a model reply, tolerating code fences, <think> blocks and chatter."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    text = _FENCE.sub("", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            pass
    raise LLMError(f"model did not return JSON: {text[:200]!r}")
