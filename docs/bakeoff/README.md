# Brain bake-off (v0.1.1)

Picks the default bandleader brain by measurement
([ADR-0016](../decisions/0016-brain-providers.md)). Status: **in progress**.
Rules, Jev and Claude (from the cloud) and Qwen (on the Spark) are measured
on simulated sessions; there are no real recorded jams on the Spark yet;
Thiago's blind rating is still to do. Until
it's done the default stays **rules**.

## How it works

`npm run bakeoff` in `web/` ([scripts/bakeoff.ts](../../web/scripts/bakeoff.ts))
replays recorded sessions through each brain in two ways:

1. **Same questions.** A replay with the rule leader records the request at
   every phrase; then every brain answers exactly those requests. This gives
   latency, errors, the move mix, and side-by-side answers for blind rating
   (`rating.json`: only turns where the brains disagree, shuffled, labelled A,
   B, C; the key is in `results.json`).
2. **Closed loop.** Each brain drives its own replay of the session: the
   player's notes are fixed and the band follows the brain through the real
   governor. Scores:
   - **follow**: correlation of the player's energy in a phrase with the
     band's intensity target one phrase later;
   - **silent→drop**: after 2+ silent bars, the band is at or below 0.3 by
     the next turn;
   - **busy→lift**: after a busy phrase, the band is at or above 0.6 by the
     next turn.

These scores are shaped like the rule leader's own behavior, so rules score
well by construction. They catch a brain that doesn't follow at all; they
can't tell taste. Taste is the blind rating.

Latency is measured from wherever the script runs (`--label`). The numbers
below are from a claude.ai cloud container on the US East coast calling
TypeSafe and the Anthropic API directly. From the page it goes through the companion server's relay,
which adds a hop (190 to 430 ms in a headless run through a local relay).

## Sessions

[sessions-sim/](sessions-sim/) holds nine sessions recorded from the pretend
player (three player scripts, arc / slow burn / stop-start, over the three
bundled charts) with `npm run make-sessions`. They replay exactly. They are
crude players; Thiago's real jams on the Spark go in next.

## Results so far

[2026-10-31-cloud/summary.md](2026-10-31-cloud/summary.md), 9 simulated
sessions, 102 turns per brain:

| Brain | p50 | p95 | max | Errors | Moves per turn | follow | silent→drop | busy→lift |
|-------|-----|-----|-----|--------|----------------|--------|-------------|-----------|
| Rules | 0 ms | 0 ms | 0 ms | 0 | 0.94 | 0.94 | 1.00 | 1.00 |
| Jev (jev-1.14.0) | 89 ms | 134 ms | 190 ms | 0 | 0.88 | 0.96 | 1.00 | 1.00 |
| Claude (claude-opus-5-5, effort low) | 1969 ms | 3274 ms | 3916 ms | 0 | 0.87 | 0.81 | 0.00 | 0.95 |

Jev's latency moved from 75 / 97 ms in the first run to 89 / 134 ms in this
one (same sessions, same container type); treat it as run-to-run noise.

What we learned about Claude:

- **It never drops out.** When the player stops, Claude eases back to 0.4 to
  0.6 and drops the *chords*, where rules and Jev go to about 0.1 and drop
  the drums. Its reasons say the right thing ("you've gone quiet, so we'll
  ease off") but the number stays high, so silent→drop is 0.00 in every
  session. Sparse playing gets 0.4 to 0.45 where the others go to about 0.3.
  Qwen does the same below, and both get the shared `LEADER_SYSTEM` prompt,
  which was never tuned the way Jev's questions were; it may be fixable with explicit levels in the prompt
  ("player stopped: 0.1, drums out").
- **It is slow but on time.** p95 3.3 s is well inside a 6 to 10 s phrase, so
  no answer was late, but it is far over Jev's ~0.1 s.
- **Its moves are the most varied:** the most stingers (21) and some feel
  changes, and its reasons are written fresh each turn. One move in 102
  turns was rejected by the check. Whether that variety is good is what the
  blind rating is for.

[2026-10-31-spark-sim/summary.md](2026-10-31-spark-sim/summary.md), same 9
sessions on the DGX Spark, Qwen local (llama-server, Q4_K_M):

| Brain | p50 | p95 | max | Errors | Moves per turn | follow | silent→drop | busy→lift |
|-------|-----|-----|-----|--------|----------------|--------|-------------|-----------|
| Qwen3-30B-A3B | 787 ms | 1111 ms | 1360 ms | 0 | 1.04 | 0.14 | 0.00 | 0.51 |

Qwen is valid and on time (2 of 102 turns had a rejected move, none late),
but it barely follows the player: it almost never says "keep going" (1 turn
of 102, vs 44 for rules), never drops back when the player stops, and swings
intensity between extremes (0.28 and 1.0 are its most common answers). With
the same prompt as v0, so this is the v0 LLM's behavior too; it was never
measured this way before. Prompting or tuning Qwen is v0.4 work; for now it
is the weakest brain here.

What we learned about Jev on the way:

- **First questions failed.** Asked "how hard should the band play?" with the
  raw request as state, Jev anchored on the band's current intensity and
  never dropped out when the player stopped (follow 0.61, silent→drop 0.00).
- **What fixed it:** ask the level *ignoring how hard the band plays now*,
  name the playing each level matches ("barely there: the player stopped"),
  regroup the state into `player` / `band` / `song`, add `player.sounds` as
  words for the numbers ("busy and loud"), and give the change question
  explicit guidance (drop the drums when they stop, bring parts back when
  they play again). After that: follow 0.96, silent→drop 1.00, busy→lift
  1.00.
- Caveat: the questions were tuned on these same nine sessions, so the score
  is optimistic until it holds on Thiago's real recordings.
- It is fast: well inside the latency contract even through a relay
  ([ADR-0006](../decisions/0006-bandleader-latency-contract.md); a phrase is
  6 to 10 s at these tempos). Cost is tiny: about 800 input tokens per turn at
  $0.042 per million.
- It makes fewer structural moves than rules (no feel changes, few stingers)
  and its reasons are templates.

## Still to do

- [x] Qwen3-30B-A3B on the Spark, simulated sessions.
- [ ] Real jams: none saved on the Spark yet (`~/.local/share/jamstate/sessions`
      doesn't exist). Play a few, keep them (now automatic in the browser,
      **Sync to Spark** to put them there), then re-run
      (`--brains rules,qwen,jev --label spark`, see
      [spark/README.md](../../spark/README.md)).
- [x] Claude on the simulated sessions (2026-10-31, cloud). The script reads
      `ANTHROPIC_API_KEY` or `JAMSTATE_ANTHROPIC_API_KEY`.
- [ ] Claude: try explicit levels for silence in the prompt and rerun; it
      currently never drops below 0.4 when the player stops.
- [ ] Thiago blind-rates 24 turns where at least three of the four brains
      (rules, Jev, Qwen, Claude) disagree, on his phone. Items are in
      [rating-items.json](rating-items.json) (labels A to D shuffled per
      item); the key is [rating-key.json](rating-key.json). Picks are saved
      on the rating page and read back from there.
- [ ] Pick the default and record it here and in ADR-0016.
- [ ] Laya-in-the-browser spike (ONNX), alongside.
