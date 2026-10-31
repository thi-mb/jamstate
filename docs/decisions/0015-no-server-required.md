# 0015. jamstate runs without a server; the Spark is optional

- Status: Accepted (Thiago, 2026-10-31)
- Date: 2026-10-31
- Supersedes: [0008](0008-spark-as-stateless-advisor.md)

## Context
ADR-0008 made the DGX Spark the host: it serves the page, saves sessions and
proxies the bandleader to Qwen. That was right for building v0 fast, but it
ties installing jamstate to a $5,000 box most players don't have. jamstate is
meant to be open source and run locally or self-hosted by people with a Mac
or a PC.

The server does very little today. It has four jobs: serve the built page,
`/api/leader` (build the prompt, call the model, check the moves),
`/api/chart` (text to chart through the model) and `/api/sessions` (save to
disk). The music, timing, governor, generators and rule-based leader already
run in the page. All four jobs can move into the page.

## Decision
- **The page runs alone.** It is a static build that any host, a local file
  server or a desktop app can load. Playing needs no jamstate server.
- **Server jobs move into the page:**
  - Prompt building and move checking for the bandleader move into
    TypeScript, behind the brain providers of
    [ADR-0016](0016-brain-providers.md).
  - Text to chart goes through the same providers.
  - Sessions are saved in browser storage, with download and import as files.
    Saving to a server stays possible as an optional sync target.
- **The Spark becomes optional**, used for what only a big local GPU does
  well:
  - an **eval lab**: replay recorded sessions through each brain and score
    them, and later fine-tune on Thiago's taste;
  - **offline jobs**: stem splitting, audio to chart, sample rendering;
  - **generative R&D**: a band that produces audio, steered by our chart and
    moves (see [ADR-0009](0009-magenta-realtime-spike.md));
  - a **prototype of a hosted tier**, to learn what serving gen AI costs
    before paying for cloud GPUs;
  - Thiago's own rig: it keeps serving Qwen as one brain among several.
- The Python server stays in the repo as an optional companion (static
  hosting, a session sync endpoint, a CORS-friendly proxy for providers that
  need one), not as a requirement.
- The rules from ADR-0008 that still hold carry over: nothing remote owns
  time, each request carries all it needs, and a lost brain only loses taste,
  never the band.

## Consequences
- Anyone can play from a static URL or an app with nothing else installed.
- API keys live on the player's machine, not on a server we run.
- The phone app after v1.0 gets easier: the page is already self-contained.
- We lose the server as a single place to fix prompts; prompts ship with the
  page, so a prompt change is a page release.
- Sessions on the Spark become a sync choice, so evals need a way to collect
  them (export, or opt-in sync).

## Alternatives considered
- **Keep the Spark as required host (ADR-0008).** Simplest for Thiago, but
  no one else can run it.
- **A jamstate cloud server for everyone.** Easy onboarding, but we would pay
  for every user's inference and host their data. Kept as a possible paid
  tier for generative audio later, not the base.
