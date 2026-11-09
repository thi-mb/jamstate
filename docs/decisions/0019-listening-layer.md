# 0019. The listening layer: five switchable groups, one summary for every brain

- Status: Accepted
- Date: 2026-11-08

## Context
Up to v0.2 the bandleader hears one number that matters: energy (density and
velocity), plus its trend. The v0.2 baseline of the leader eval
([results](../eval/results/baseline-v0.2/summary.md)) shows where that runs
out: no brain lets the band down under held notes or a decrescendo inside a
phrase, none builds into the next section with the player, and call and
response is followed bar by bar. v0.3 adds more listening. Three forces:

- Every brain must get the same input, or the eval compares prompts rather
  than brains.
- More fields make the request bigger and slower (ADR-0006), and a field that
  doesn't help can make a brain worse. Each group has to earn its place.
- The player has to be able to switch groups off to hear the difference.

## Decision
- Listening is five groups, each adding one field to the leader's request
  when it is on: `position` (song position), `rhythm`, `harmony`, `phrasing`,
  `dynamics`. Off, the request is the v0.2 one. Code:
  `web/src/core/listening.ts`; the conductor computes every group after every
  bar and puts in the ones that are on.
- The player switches groups under **Bandleader → Listening**. The setting is
  kept in the browser, recorded in the session file with every change
  (`listening`), and a replay with a leader hears the same groups. Defaults
  are the groups the eval says help: phrasing only
  ([results](../eval/results/v0.3-groups.md)). The overlay always shows
  everything heard.
- LLM brains get one fixed paragraph per field present, after the fixed
  system prompt (its cached prefix doesn't change). Jev gets the same fields
  in its state. The rule leader uses song position (lift into a bigger
  section when the player builds; hold parts in the two bars before a change),
  phrasing gaps and outside playing.
- Groups listen over the last phrase (`phrase_bars`); phrasing over the last
  8 bars, to see trades.
- The governor's chart nudge at a new section leaves a target the leader set
  within the last phrase (`holdFreshTarget`). Listening that makes the leader
  move earlier is wasted if the chart halves the move at the section line.
- Harmony classifies each note against the chord sounding when it starts:
  a chord tone is **inside**, a note of the genre's scale for the chord's class
  is **colour**, anything else is **outside**; shares are weighted by how long
  each note sounds. The same function (`noteFit`) colours the fretboard.
- Genre-specific listening lives in the genre pack under a new optional
  `listening` key (ADR-0012 reserved it): `scales` per chord class (major,
  minor, dominant, half_diminished, diminished; semitones above the chord's
  root) and `outside` (`hold` or `lift`: what the band does when the player
  goes outside). A pack without it uses the chord's own scale and holds. The
  key is optional, so the format stays `jamstate-genre/0.2`.
- Added 2026-11-09 (Thiago's fretboard test): optional `key_scales`, per key
  mode (major, minor) a list of named scales over the key's tonic, in order
  of preference. The fretboard's scale mode holds the one that covers the
  most chord tones over the whole chart (first listed wins a tie): blues for
  blues-rock, dorian or natural minor for funk, major (minor: dorian,
  harmonic or natural minor) for jazz. Display only; the harmony signal
  still judges each note against the chord sounding.

| Genre | Colour beyond the chord | Outside |
|---|---|---|
| funk | dorian with the flat five on minor; mixolydian with the blue third and flat five on dominant | hold |
| blues-rock | blues scale plus mixolydian on major and dominant; blues and dorian on minor | hold |
| jazz | everything on a dominant; lydian and the sharp five on major; melodic and dorian on minor | lift |

## Consequences
- The eval ([v0.3-groups](../eval/results/v0.3-groups.md)): phrasing helps
  or holds every brain (rules 0.95 → 0.98); all five help the rules and Jev
  but cost Qwen 0.11; dynamics alone costs Claude and Qwen 0.06. Brains
  differ, so the player keeps the switches.
- A brain's score can be compared group by group, on the same scenarios.
- The request grows by up to five small objects. Jev stays at p95 237 ms
  with every group on; Qwen was over ADR-0006's 1.5 s before v0.3 and gets
  slower with each group (2.3 s → 3.4 s), Claude goes over with all five.
- Genre authors can say what "outside" means in their genre without code.
- Busy and sparse thresholds stay global for now: the baseline gave no
  evidence that they should differ by genre.
- The listening window is a phrase, so a change mid-phrase is heard late;
  the trend fields carry the direction within it.

## Alternatives considered
- **One richer summary, always on.** Simpler, but no way to tell which part
  helps, and no way for the player to compare.
- **Per-brain inputs** (words for Jev, numbers for LLMs). Better for each
  brain, but the eval would no longer compare like with like. Jev's state
  regroups the same fields instead.
- **Key-relative harmony** (scale degrees of the song's key). Breaks on
  modulations and secondary dominants; chord-relative classes follow the chart.
- **Thresholds per genre in the pack now.** Deferred until the eval shows a
  need.
