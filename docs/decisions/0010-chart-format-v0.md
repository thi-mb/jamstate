# 0010. Chart format v0

- Status: Superseded by [0013](0013-chart-format-v0.1.md) (additively: every v0 chart is a valid v0.1 chart)
- Date: 2026-10-30

## Context
The chart is the contract between whoever writes a song skeleton (a person, an
LLM from a text prompt, or v1 audio analysis) and the engine. It needs to be
easy to type by hand and easy for a model to emit.

## Decision
The brief's format, with these v0 rules:

```json
{
  "title": "Night Drive", "bpm": 112, "time_sig": "4/4", "key": "F minor",
  "sections": [
    {"name": "intro", "bars": 8, "chords": ["Fm", "Db", "Ab", "Eb"], "intensity": 0.3},
    {"name": "verse", "bars": 16, "chords": ["Fm", "Fm Eb", "Db", "Eb"]}
  ],
  "form": ["intro", "verse", "chorus", "verse", "chorus", "outro"]
}
```

- `time_sig` is limited to N/4 in v0.
- Chords cycle one per bar through the section.
- A chord string with spaces splits the bar evenly (`"Fm Eb"` = two beats each
  in 4/4).
- Optional per-section `intensity` (0–1) is a hint for the arranger's starting
  intensity; the bandleader can still move it.
- `form` entries must name sections that exist.

## Consequences
- Simple enough to type and for an LLM to produce reliably with a JSON schema.
- No odd meters, pickups, per-beat chord durations or key changes yet. Adding
  them later means a `version` field and a new record.

## Alternatives considered
- **ChordPro or MusicXML.** Richer, but heavy for v0 and awkward for an LLM to
  emit.
