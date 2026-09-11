# Integration — tying the pieces together, and where it breaks

**Goal.** Wire the validated pieces into one middleware and stress it in an agent loop under a hard
window: **ensemble retriever** (RRF over BM25 + vector/MiniLM) as the reducer, **ensemble classifier**
(z(lexical)+z(semantic) drift) as dormancy, **D-EV assembler** (priority-dominant eviction) + the
**router** reducer (D-EV6). Task: read 4 large catalogs, extract each buried price, sum them — under
the 8.2K window. The point was to **find where it works and breaks**, not to score a win.
Code: `middleware.mjs` (best-of-breed), `integration-full.mjs` (uses it), `integration-pipeline.mjs`
(lightweight first pass). Numbers: `results-integration-pipeline.json`.

## What happened

- **Docs must actually overflow.** First pass had docs too small → no eviction, both arms passed
  trivially. Enlarged so 4 raw reads ≫ budget.
- **truncate-tail (raw + recency) CRASHED** on the 8.2K model: once raw reads filled context near the
  window, the weak model emitted **malformed tool-call JSON → HTTP 500**. Footprint control would have
  prevented this.
- **full-pipeline (reducer + eviction) did NOT crash or overflow** — the reducer kept reads small — **but
  still failed the task**: the agent **read-looped** (40 reads, 9–36 re-reads, maxTurns) and never
  committed to `write_file`.
- **The disentangle (stronger 27B, same setup): BOTH arms still failed** — the 27B *also* read-looped
  (22–40 reads, 18–36 re-reads; it even guessed "100"). So the loop here is **not** weak-model-specific
  and **not** footprint thrashing (the reducer kept content available).

## The finding: two different read-loops, and the middleware only fixes one

- **Read-loop A — working-set thrashing** (report-readloop.md): eviction drops needed content → the
  agent re-fetches forever. **The footprint reducer fixes this** (verified: summarize/chunk break it).
- **Read-loop B — behavioral indecision**: with a restricted toolset (`read_file`+`write_file`, no grep
  to "verify"), the model reads the documents but **won't commit to the final action**, re-reading
  instead. This reproduced on **both** the 8.2K and the 27B models. **The footprint middleware does NOT
  fix this** — it is an agent-progress problem, not a context-size problem.

So the honest integration result: **the pieces compose and control footprint** (the full pipeline
avoided the crash truncate-tail hit), **but agent-behavioral factors dominate loop task-success** on
these local models. The middleware's value is **cleanest in single-turn / forced-overflow** tests
(`buried-detail`, `hard-window-synthesis`), where footprint is isolated from agent behavior; in the
**agentic loop**, two extra factors dominate: **behavioral indecision under restricted tools**, and —
with a full toolset — the model **self-healing via grep** (its own on-demand retrieval), which reduces
the middleware's marginal role.

## Implication

The middleware is **footprint infrastructure** (overflow + thrashing) — necessary and validated in
isolation. End-to-end agentic success additionally needs a **progress mechanism** we have *not* cracked
(a completed-steps ledger / a reliable "stop reading and act" signal), and it interacts with **tool
availability** (grep lets the model substitute its own retrieval). These are separable problems; this
session established the footprint half and localized the behavioral half.

## Tested vs. open

- **Tested:** the pieces compose; footprint is controlled (full pipeline avoids the raw-context crash);
  read-loop B (behavioral indecision under restricted tools) reproduces on both weak and strong local
  models and is NOT fixed by footprint reduction.
- **Open:** a clean `integration-full` (best-of-breed) end-to-end number; a **progress ledger** to break
  read-loop B; a loop task where cross-turn **retention is genuinely required with no re-read escape**
  (to isolate the middleware's loop value from grep self-heal); stronger models.

**Caveats.** n=1 per arm, temp 0. Weak local models (8.2K IQ4, 27B Q8/CPU-offloaded). Synthetic task.
The restricted-tool setup induces read-loop B; the realistic-tool setup invites grep self-heal — neither
cleanly isolates the middleware's loop contribution, which is itself part of the finding.
