# The context-tree algorithm

A context-management **middleware** for coding agents. An agent's prompt normally carries the entire
linear transcript of everything it has done, so the prompt grows without bound and eventually exceeds
the model's context window. Context-tree keeps a **bounded, cache-stable working set** in the window
and pulls older detail back **on demand**, so a long or resumed session sees compact representations of
past work instead of raw history. It bolts onto a host (opencode, Claude Code, Cline) at the
tool-result and prompt-assembly seams — it never owns the agent loop.

This page is the **implementation specification** and is self-contained: it is enough to build the
system from. The evidence, boundary conditions, rejected alternatives, parameter audit, and development
history live in `reports/algorithm-notebook.md` and the per-experiment reports under `reports/metrics/`.

## Design principles

1. **Bound the resource, not the model's freedom.** No caps on turns, wall-clock, or reply length —
   each is a guess about work nobody measured. Bound the actual resource: a cost cap and stall
   detection. (Sizing content to the window is arithmetic, not a cap.)
2. **A hardcoded value is a defect** unless shown to hold across models and harnesses. Derive every
   parameter from the host's declared limits; a value fitted on one host is a defect until re-derived.
3. **Err toward MORE context.** Eviction is conservative by construction: dropping context that turns
   out to be needed costs the *task*; keeping extra costs *tokens* — the two are not symmetric. The
   ejection trigger is therefore **topic shift, not budget pressure**, and uncertain relevance stays.
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
| **L3** | embeddings | derived, disposable |

Invariants: **L0 is append-only and the sole source of truth**; L1/L3/views are derived and
rebuildable; **L1 stores coordinates, not content** (a node names a `seq` range; the text lives in L2);
**summaries are versioned, never overwritten**.

## The pipeline (per turn)

Two scorers feed one decider, and retrieval serves on demand: the **classifier** scores
query-independent state (has the topic shifted), the **retriever** scores query-dependent relevance
(what matches this turn), and the **assembler/ejector** decides what to keep, cache-stable, to a soft
target.

**0 — Ingest.** Append each event to L0; store payloads in L2; cap edit-tool arguments once the
post-state blob exists. Segment L0 deterministically by **tool name → phase** (unknown → `other`); a
closed phase becomes a tree node with a `seq` range. Extract **fingerprints** (file paths, identifiers,
symbols) from raw events. Once the trace exceeds the window, **latch** (L0 only grows, so it never fits
again) and summarize each closed phase on a cheap model (versioned); a later edit marks its node stale,
and staleness travels to ancestors only.

**1 — Classify (dormancy).** For each unit, compute topic-shift drift from the recent window:
`z(lexical fingerprint-Jaccard) + z(semantic embedding-cosine)`. Units whose topic has drifted away are
marked **dormant**. Err toward keeping.

**2 — Assemble + eject.** The prompt is a **frozen cached head** (system + steering + all user prompts,
append-only) followed by a **creation-order flex buffer** of history units — each carried as one
representation, `ref | summary | retrieved-span | raw` (newest raw) — with a **secondary cache
breakpoint** after the stable head so the head caches. Evict toward a **soft target** (a floor below
which eviction does not fire, not a level to hold): score each non-pinned unit

```
score = 2·priority + 1·recency + 0.5·reference-recency − dormancy      (relevance ≈ 0)
```

where **priority** is query-independent state derived from L0 (boost on fetch/edit, decay with turns
since last reference, recurrence). **Relevance is an admission signal, not an eviction signal** — on
non-monotonic history (a unit that goes dormant and is needed again) it is the *worst* eviction signal,
dropping exactly the unit that returns. Drop **dormant-first, oldest-first**; keep a **recency anchor**
(the working set); never drop the open topic or the pinned head.

**Reduce-on-overflow.** A **raw** unit too large for the budget is shrunk by a **query-aware router**:
`summarize` (when the need survives abstraction — structural/navigational) · `chunk+retrieve` (when the
need is a *localized detail* a summary would drop) · `ref` · `drop`. This applies to **raw content only**;
a **curated retriever result is retained whole**, never re-chunked. Nothing reorders the cached prefix.

**3 — Retrieve on demand.** When the model needs older detail, retrieve from the transcript (L0): fan
out **BM25 + vector (kNN)** over one shared corpus and fuse by **RRF** (rank-based, scale-free) —
overlapping coverage fuses; a single-coverage query routes to the sole coverer. Return the best-matching
units; the fetched unit **appends after the buffer** so the cached prefix is untouched, and is
**retained whole**. A tool result the model fetched itself (e.g. its own graft/LSP call) is likewise
captured verbatim and retained whole — never re-retrieved or re-chunked (that would only lose signal).

## The middleware seam

The pipeline runs as host hooks and never owns the agent loop:

- **tool result** (`tool.execute.after` / PostToolUse): capture the result to L0; if it is raw and would
  overflow the budget, apply the reduce-on-overflow router. A curated retriever result is retained whole.
- **prompt assembly** (`chat.messages.transform`): run classify + assemble/eject on the message array
  before the model call; append retrieved results after the buffer.
- **frozen head** (system / tool-schema transform): the head (system + steering + user prompts) is
  assembled after the message transform, so it is out of the eviction path by construction.

## Parameters

Derived from the host's limits, not guessed:

| Parameter | Value / derivation |
|---|---|
| Window `W` | host-supplied |
| Soft target `f` | 25–50% of `W`, as a floor below which eviction does not fire |
| Eviction weights | priority 2, recency 1, reference-recency 0.5, relevance 0 — a *linear* mix, no nonlinear mixer |
| Reduce-on-overflow | a unit is reduced once it would pressure the budget; the router picks summarize vs chunk by whether the query seeks a localized detail |
| `RRF_K` | 60 |
| Chunker | recursive character splitter (~800 / 100 overlap) |
| Drift threshold | z-score over the running baseline; err toward keeping |
| Reply reserve | the host-declared `Model.limit.output`, not a fitted fraction of `W` |

## Status

Validated live: eviction saves tokens without losing the task; the reduce-on-overflow router
(summarization is insufficient for a buried detail, chunk+retrieve wins); the middleware is *required*
under a hard window; RRF ensemble retrieval and drift-based classification. Open: the soft target on a
genuinely overflowing session; whether retrieval should serve on-demand (as specified here) or up-front;
and a progress mechanism for the agent-indecision loop the footprint middleware does not fix. Evidence
and the full development record: `reports/algorithm-notebook.md` and `reports/metrics/`.
