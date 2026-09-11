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

- **A unit is a closed phase-node** *(design decision — override if you want turn- or event-level units)*.
  The segmenter (stage 0) cuts L0 into **phases**: a contiguous run of events under one tool-phase; a
  closed phase becomes a node with a `seq` range and, once latched, a versioned summary. **This
  phase-node is the unit** the classifier, buffer, and ejector operate on. Two things live outside that
  buffer: the **frozen head** (system + steering + all user prompts) and the **active (still-open)
  phase**, which is always kept raw.
- **The tree is shallow — one root over the phase-leaves; there is no deep nesting.** The root is
  composed deterministically from the leaves' **headlines** (keyword fingerprints — file paths,
  identifiers, symbols) in creation order: the newest few phases keep their full representation, older
  ones fold to a one-line headline. `node_links` record `superseded_by` / derived edges. The value comes
  from summary-headed leaves plus on-demand retrieval, not from depth.

## The pipeline (per turn)

Two scorers feed one decider, and retrieval serves on demand: the **classifier** scores
query-independent state (has the topic shifted), the **retriever** scores query-dependent relevance
(what matches this turn), and the **assembler/ejector** decides what to keep, cache-stable, to a floor.

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

**2 — Assemble + eject.** The prompt is a **frozen cached head** (system + steering + all user prompts,
append-only) followed by a **creation-order flex buffer** of units, with a **cache breakpoint** after
the head so the head caches.
- **Representation (default):** the **active phase** and the **recency anchor** (the last `A` units,
  default A=4, covering the current sub-task) are kept **raw**; an older closed+latched unit defaults to
  its **summary**; reduce-on-overflow may demote further to `retrieved-span` / `ref` / `drop`.
- **Eviction — what / when / how much.** *When:* eviction fires only when the buffer exceeds the
  soft-target floor `f`; never below it. *What:* above the floor, evict the **lowest-scoring** units
  first (the dormant, low-priority, old ones). *How much:* down to `f`. Score each non-pinned,
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

  Relevance (the retriever's query-match) is weighted **0** here — it is an *admission* signal, not an
  eviction one (on non-monotonic history it drops exactly the unit that returns). Never drop the open
  topic, the recency anchor, or the pinned head.
- **Reduce-on-overflow.** A **raw** unit larger than the **per-unit budget** `b` — the floor's raw space
  shared across the raw slots, `b = (f − reply reserve) ÷ (A + 1)` (the active phase plus the `A`
  anchor units are the units kept raw, so no single raw unit may claim more than its share of the floor)
  — is shrunk by a **query-aware
  router**, decided by a heuristic on the current task/query: seeks a localized value/detail (a name,
  number, specific fact) → `chunk+retrieve`; a gist/overview suffices → `summarize`; **default
  `chunk+retrieve`** (err toward preserving detail). `ref` when a pointer suffices and the content is
  re-fetchable; `drop` only for a unit both dormant and low-priority. Applies to **raw content only**; a
  **curated retriever result is retained whole**, never re-chunked. Nothing reorders the cached prefix.

**3 — Retrieve on demand.** The corpus is the L0 units chunked by a recursive character splitter
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
- **prompt assembly** (`chat.messages.transform`): run classify + assemble/eject on the message array
  before the model call; append retrieved results after the buffer.
- **frozen head** (system / tool-schema transform): the head is assembled after the message transform, so
  it is out of the eviction path by construction. Cache breakpoints are Anthropic-explicit; on a host
  without them the *layout stability* (principle 4) still yields prefix reuse.

## Parameters

Derived from the host's limits, not guessed:

| Parameter | Value / derivation |
|---|---|
| Window `W` | host-supplied |
| Unit | a closed phase-node (segmenter output) |
| Soft target `f` | 25–50% of `W`, as a floor below which eviction does not fire |
| Recency anchor `A` | 4 most-recent units, always raw / never evicted |
| Recent window `K` (drift) | last 5 units |
| Drift threshold `τ` (coarse "dormant") | z-drift > 1 — one SD above the session's running mean (conservative) |
| Signal normalization | per-turn min-max across candidate units, before weighting |
| Per-unit budget `b` | `(f − reply reserve) ÷ (A + 1)` — the floor's raw space shared across the active phase + the `A` anchor units; a raw unit over `b` triggers reduce-on-overflow |
| Eviction weights | priority 2, recency 1, reference-recency 0.5, dormancy −1, relevance 0 — a *linear* mix |
| Reduce-on-overflow | a unit is reduced once it exceeds its per-unit budget; router picks chunk (detail) vs summarize (gist), default chunk |
| Embedding model | small local encoder, MiniLM-class (dim ~384) |
| Chunker | recursive character splitter (~800 / 100 overlap) |
| `RRF_K` | 60 |
| Summarizer | cheap model; output versioned; must include rehydration pointers |
| Reply reserve | the host-declared `Model.limit.output`, not a fitted fraction of `W` |
| Tokenizer | the host's; fallback ≈ chars ÷ 4 |

## Status

Validated live: eviction saves tokens without losing the task; the reduce-on-overflow router
(summarization is insufficient for a buried detail, chunk+retrieve wins); the middleware is *required*
under a hard window; RRF ensemble retrieval and drift-based classification. **Open** (see the OPEN
sections): the soft target `f` on a genuinely overflowing session; the retrieval trigger
(on-demand-vs-up-front); and the resource bound (cost cap + stall/progress detector for the
agent-indecision loop the footprint middleware does not fix). Evidence and the full development record:
`reports/algorithm-notebook.md` and `reports/metrics/`.
