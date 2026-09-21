# The context-tree algorithm

A context-management **middleware** for coding agents. An agent's prompt normally carries the entire
linear transcript of everything it has done, so the prompt grows without bound and eventually exceeds
the model's context window. Context-tree keeps a **bounded, cache-stable working set** in the window
and pulls older detail back **on demand**, so a long or resumed session sees compact representations of
past work instead of raw history. It bolts onto a host (opencode, Claude Code, Cline) at the
tool-result and prompt-assembly seams — it never owns the agent loop.

This page is the **implementation specification** and is self-contained: it is enough to build the
system from, except for two subsystems explicitly marked **OPEN** below (the retrieval trigger and the
resource bound), which are unresolved research questions, not omissions. The evidence, boundary
conditions, rejected alternatives, parameter audit, and development history live in
`reports/algorithm-notebook.md` and the per-experiment reports under `reports/metrics/`.

## Design principles

1. **Bound the resource, not the model's freedom.** No caps on turns, wall-clock, or reply length —
   each is a guess about work nobody measured. Bound the actual resource: a cost cap and stall
   detection (see **The resource bound (OPEN)**). Sizing content to the window is arithmetic, not a cap.
2. **A hardcoded value is a defect** unless shown to hold across models and harnesses. Derive every
   parameter from the host's declared limits; a value fitted on one host is a defect until re-derived.
3. **Err toward MORE context.** Eviction is conservative: dropping context that turns out to be needed
   costs the *task*; keeping extra costs *tokens* — not symmetric. This shapes the ejector: **topic
   shift decides *what* is eligible to evict; the soft-target floor decides *when* eviction fires and
   *how much*** — never prune below the floor, and uncertain relevance stays.
4. **Nothing reorders a cached prefix.** Prefix-keyed caches invalidate everything after the first
   changed byte, so the design rewards a *stable layout*, not a minimal payload. The working buffer only
   appends and evicts in place; it never re-mixes (a freely re-mixed buffer is cache-death).
5. **Ingestion is hermetic.** It reads only the event log, the blob store, and a parser — no network,
   no enrichment. Ingestion produces coordinates; retrieval answers questions; the two never cross.

Cumulative token consumption is **quadratic** in turn count (every turn re-sends the whole prefix), so
bounding the working set compounds on long sessions.

## Data model

| Layer | Contents | Mutability |
|---|---|---|
| **L0** | append-only event log, monotonic `seq` | source of truth, never edited |
| **L2** | content-addressed blobs (payloads) | write-once |
| **L1** | tree: nodes (each a `seq` range) + versioned summaries + links | derived, rebuildable from L0+L2 |
| **L3** | embeddings (one per unit) | derived, disposable |

Invariants: **L0 is append-only and the sole source of truth**; L1/L3/views are derived and
rebuildable; **L1 stores coordinates, not content** (a node names a `seq` range; the text lives in L2);
**summaries are versioned, never overwritten**.

## Units and the tree

- **One ladder of units, defined once and used by every stage** (decision D23):
  `phase ─ turn ─ chunk`.
  - A **phase** is the segmenter's (stage 0) contiguous run of events under one tool-phase. It is
    the *grouping*: a closed phase becomes an L1 node with a `seq` range and, once latched, a
    versioned summary.
  - A **turn** is **one host message** — its text plus every tool call it issued and their
    results. **The turn is the unit** the classifier, the assembler, the ejector and retrieval all
    operate on, because it is the only boundary a host can act on exactly. Importers stamp each L0
    event with its host message id (`turn_id`); a trace without it derives turns by a deterministic
    fallback (a message event plus the calls it issued). Turns are a pure function of L0 — not L1
    nodes, so there is nothing to persist or migrate. `unit = phase` remains selectable and
    reproduces the coarse behaviour (a single phase can reach tens of thousands of tokens, and
    nothing smaller than a phase can then be removed).
  - A **chunk** is a splitter piece of a turn's text under the session's one set of chunk options
    — the single sub-unit: the chunk retrieval ranks is the chunk a reduction keeps.
  Two things are **pinned** — never reduced, folded or removed — because losing them breaks the
  request rather than the policy: the **task statement** (a chat template rejects a prompt with no
  user message) and the **newest message**.
- **The tree is shallow — one root over the phase-leaves; there is no deep nesting.** The root is
  composed deterministically from the leaves' **headlines** (keyword fingerprints — file paths,
  identifiers, symbols) in creation order: the newest few phases keep their full representation, older
  ones fold to a one-line headline. `node_links` record `superseded_by` / derived edges. The value comes
  from summary-headed leaves plus on-demand retrieval, not from depth.

## The pipeline (per turn)

Two scorers feed one decider, and retrieval serves on demand: the **classifier** scores
query-independent state (has the topic shifted), the **retriever** scores query-dependent relevance
(what matches this turn). Then two separate rulings, in order: the **assembler** decides how each
unit is *represented*, and the **ejector** — optional, taking the assembly as its input, and free to
overrule it — decides what is *removed*. Both are sticky until explicitly restored, so a turn on which
no ruling is made leaves the prompt byte-for-byte as it was.

**0 — Ingest.** Append each event to L0; store payloads in L2; cap edit-tool arguments (replace the
argument blob with its L2 hash once the post-state blob exists). Segment L0 deterministically by
**tool name → phase** via a config `TOOL_PHASE` map (unknown → `other`); a phase closes when the mapped
phase changes, and the closed run becomes a node. Extract **fingerprints** by regex over raw event text
and tool arguments: file paths, `snake_case`/`camelCase`/`PascalCase`/`UPPER_SNAKE` identifiers, and
backticked spans. Once the trace exceeds the window, **latch** (L0 only grows, so it never fits again)
and summarize each closed phase on a **cheap model** into a new versioned `node_summaries` row; the
summary **must carry rehydration pointers** — the files+spans it touched, symbols, tests, ticket/PR ids
— so the model knows what it can fetch back. A later edit sets `stale_since_seq` on its node; staleness
travels up the ancestor path only, and a stale node is re-summarized at the next latch.

**1 — Classify (dormancy).** For each unit, compute a **continuous drift** from the recent window (the
last `K` units, default K=5):
```
drift(u) = 0.5·(1 − Jaccard(fingerprints(u), fingerprints(recent))) + 0.5·(1 − cosine(emb(u), centroid(recent)))
```
z-scored against the session's own running mean/std of drift (causal), so a unit's z-drift is measured
in standard deviations above the session's mean drift. **Dormancy is this drift**, min-max normalized to
[0,1] across the current units. A unit is coarsely "dormant" when its z-drift exceeds a conservative
threshold `τ = 1` (one SD above the running mean — err toward keeping), but eviction uses the continuous
magnitude, not the boolean. Embeddings are a small local encoder (MiniLM-class),
one per unit, cached in L3.

**2 — Assemble (representation; removes nothing).** The prompt is a **frozen cached head** (system + steering + all user prompts,
append-only) followed by a **creation-order flex buffer** of units, with a **cache breakpoint** after
the head so the head caches.
- **Representation:** units are **raw** by default. A **closed** phase lying wholly outside the
  **recency anchor** (the last `A` units) that has a latched summary is represented by that
  **summary** — carried by one of its turns, the rest covered by it (pinned turns stay raw and out of
  the fold). A raw unit over the per-unit budget is **reduced** (below). A representation, once
  ruled, is sticky: a unit does not flip back to raw on a roomier turn, which would rewrite the prefix.

**3 — Evict (removal; optional; input = the assembly).** Units are sized **as assembled**, so a
unit the assembler reduced competes at its reduced size, and any unit the assembler kept, reduced or
folded can still be removed here. The ejector never chooses a representation.
- **Eviction — what / when / how much.** *When:* eviction fires only when the buffer exceeds the
  **hard limit** `window − replyReserve`; never below it. *What:* above the limit, evict the
  **lowest-scoring** units first (the dormant, low-priority, old ones). *How much:* just enough to fit,
  plus an optional `evictHeadroomTokens` (default 0) so eviction need not fire again next turn.
  Score each non-pinned,
  > **Resolved 2026-09-14 (was OPEN).** The trigger was a soft-target floor `f = 0.375·W`. Live evidence
  > retired it: task success tracks **achieved peak** — the tokens actually present at call time — at
  > **OR 42× per e-fold** across 78 capped cells (arm-adjusted), and nothing else measured moves it
  > (selection signal p=0.70; reference-vs-positional recency p=1.000; needle position 180/180;
  > cadence p=0.54 given peak).
  > Evicting to a floor *below* the window discards the only quantity shown to matter, and DV2 adds that
  > it converts 0.1× cache reads into 1.25× cache writes to do so. `f` now sizes only the per-unit
  > reduce budget `b`. The headroom seam is deliberately 0 rather than a fitted fraction: headroom for
  > `N` turns is `N × growth-per-turn`, which as a fraction of the window is not constant across window
  > sizes — a fixed fraction is the wrong *shape*, the same defect `f` had. Single-problem evidence (C0).
  > `reports/metrics/context-dedup/report-{cadence-confound,window-metric}.md`.
  non-anchor unit, **min-max normalizing each signal across the current candidate units this turn**:
  ```
  score = 2·priorityN + 1·recencyN + 0.5·refRecencyN − 1·dormancyN        (relevance weight = 0)
  ```
  - **priority** = edit/fetch boost (a unit whose phase wrote a file, or that the model fetched, = +2)
    + recurrence (# other units whose fingerprints overlap this unit's), decayed by turns since last
    reference.
  - **recency** = 1 − normalized age (turns since the unit was created).
  - **reference-recency** = 1 − normalized turns since the unit's fingerprints were last referenced.
  - **dormancy** = the classifier's normalized drift (continuous), subtracted. *(The 2/1/0.5 weights are
    the offline-derived D-EV defaults; the dormancy term is the classifier's contribution and least
    tuned.)*

  Relevance (the retriever's query-match) is weighted **0** by default — it is an *admission* signal,
  not an eviction one (on non-monotonic history it drops exactly the unit that returns). It is a
  parameter, not a constant: at weight > 0 a unit's rank among the top-`k` hits for the current query
  enters the score.
  - **Protection is a score, not a wall.** The recency anchor is a **bonus** added to a unit's
    score — full for the newest unit, halving with distance — so an anchored unit is removed only when
    the budget cannot be met without it. `protection = hard` restores the absolute anchor (under which
    this is the original packing exactly). Only the two pinned units are absolute.
- **Reduce-on-overflow (part of stage 2, stated here with its budget).** A **raw** unit larger than the **per-unit budget** `b` — the floor's raw space
  shared across the raw slots, `b = (f − reply reserve) ÷ (A + 1)` (the active phase plus the `A`
  anchor units are the units kept raw, so no single raw unit may claim more than its share of the floor)
  — is shrunk by a **query-aware
  router**, decided by a heuristic on the current task/query: seeks a localized value/detail (a name,
  number, specific fact) → `chunk+retrieve`; a gist/overview suffices → `summarize`; **default
  `chunk+retrieve`** (err toward preserving detail). `ref` when a pointer suffices and the content is
  re-fetchable; `drop` only for a unit both dormant and low-priority. Applies to **raw content only**; a
  **curated retriever result is retained whole**, never re-chunked. Nothing reorders the cached prefix.

**4 — Retrieve on demand.** The corpus is the L0 units chunked by a recursive character splitter
(~800/100 overlap). Fan out **BM25 + vector (kNN over the same chunks, MiniLM-class embeddings)** and
fuse by **RRF**: `rrf(u) = Σ_r 1/(RRF_K + rank_r(u))`, `RRF_K = 60` — overlapping coverage fuses; a
single-coverage query routes to the sole coverer. Return the best-matching **whole units**; the fetched
unit **appends after the buffer** so the cached prefix is untouched, and is **retained whole**. A tool
result the model fetched itself (e.g. its own graft/LSP call) is likewise captured verbatim and retained
whole — never re-retrieved or re-chunked (that would only lose signal).

## The retrieval trigger (OPEN)

How a "need for older detail" is expressed is **not settled**. Current design: the model calls a
retrieval **tool** (an MCP `context_search` / `context_fetch` surface) — model-gated, on demand. Whether
to *additionally* push relevant units up-front (retrieve-first) is an open A/B (prior evidence: on-demand
loses below the overflow regime and wins in it). Implement the model-gated tool path; the up-front path
is intentionally unspecified.

## The resource bound (OPEN)

Principle 1 bounds cost and non-progress rather than turns. The **cost-cap** value and the **stall /
progress detector** — needed to break the agent-indecision loop where the model re-reads without acting
— are **not specified**; they are an open research gap, not part of the validated core. Treat them as
host-provided hooks (a `costCapUsd`, a stall predicate) with values TBD.

## The middleware seam

The pipeline runs as host hooks and never owns the agent loop:

- **tool result** (`tool.execute.after` / PostToolUse): capture the result to L0; if it is raw and would
  overflow the per-unit budget, apply the reduce-on-overflow router. A curated retriever result is kept whole.
- **prompt assembly** (`chat.messages.transform`): run classify → assemble → (optionally) evict, then
  apply the rulings to the host's message array **in place**. The host is never re-rendered: a whole
  message is dropped (a host keeps a call and its result in one message, so nothing is orphaned); a
  folded phase's summary replaces the text of one text-only message; a reduction replaces a tool's
  **output text** while the call and its result stay where they are. Because a turn *is* a host
  message, the mapping is exact. When to call evict — every turn, every Nth, never — is the host's
  policy, and is the whole difference between the trigger arms.
- **frozen head** (system / tool-schema transform): the head is assembled after the message transform, so
  it is out of the eviction path by construction. Cache breakpoints are Anthropic-explicit; on a host
  without them the *layout stability* (principle 4) still yields prefix reuse.

## Parameters

Derived from the host's limits, not guessed. **The list, defaults, bounds and environment names are
not restated here**: they are one registry in code — `packages/mcp/src/params.ts` `PIPELINE_PARAMS`,
served at `GET /v1/params` — from which the tool arguments, validation and the experiment harness's
knobs all derive. Every default there is PROVISIONAL (hand-set or borrowed, never swept). What the
registry cannot say is what each quantity *means*:

| Parameter | Meaning / derivation |
|---|---|
| Window `W` | host-supplied, per call. Compared against **heuristic** tokens (below), never served tokens |
| Unit | a turn (one host message), or a whole phase |
| Recency anchor `A` | the last `A` units carry a protection bonus; also sizes `b` |
| Soft target `f` | a fraction of `W`. **Not an eviction trigger** (resolved 2026-09-14); it only sizes `b` |
| Per-unit budget `b` | `(f·W − reserve) ÷ (A + 1)`; a raw unit over `b` is reduced to it. **Degenerate when `f·W ≤ reserve`** — at W = 50,347 with a 20,192 reserve and `f` = 0.375, `b` = 0 and reduce-on-overflow never fires |
| Drift `K`, `τ` | recent window in units; z-drift above which a unit is coarsely dormant |
| Signal normalization | per-turn min-max across candidate units, before weighting |
| Eviction weights | a *linear* mix of priority, recency, reference-recency, −dormancy, and relevance (default 0) |
| Reducer | chunk (keep the spans matching the query, mark the gaps) or summarize; default chunk |
| Chunker, `RRF_K` | recursive character splitter; rank-fusion constant |
| Reply reserve | the host-declared `Model.limit.output`, plus whatever the caller cannot see (system block, tool schemas) |
| Tokenizer | **heuristic**: an arithmetic count (`HeuristicTokenizer`), not the served tokenizer. The served-per-heuristic ratio is a per-turn *measurement* that differs by problem and drifts within a run (observed 1.14 → 1.19 in one session, ~1.28 in another) — never a conversion constant |
| Embedding model, summarizer | small local encoder (MiniLM-class); cheap model, output versioned, must include rehydration pointers |

## Status

Validated live: eviction saves tokens without losing the task; the reduce-on-overflow router
(summarization is insufficient for a buried detail, chunk+retrieve wins); the middleware is *required*
under a hard window; RRF ensemble retrieval and drift-based classification; **the eviction trigger is the
hard limit, not a soft floor** (resolved 2026-09-14 — see the eviction rule above). Also settled as a
*negative*: **position within the context is not a lever** on this model at these lengths (180/180 across
depths to 155,773 real tokens — `report-position-probe.md`), so the creation-order buffer forfeits
nothing by ignoring position. **Open** (see the OPEN
sections): how much headroom eviction should free when it fires (the cadence/cost question); whether the
selection *signal* matters at all, which is gated on the instrument-sensitivity control; the retrieval trigger
(on-demand-vs-up-front); and the resource bound (cost cap + stall/progress detector for the
agent-indecision loop the footprint middleware does not fix). Evidence and the full development record:
`reports/algorithm-notebook.md` and `reports/metrics/`.
