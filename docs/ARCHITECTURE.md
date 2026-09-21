# Architecture

This document is the map. `IMPLEMENTATION_PLAN.md` is the authority — it carries
the decision record (D1–D15) with rationale and citations, and no code here may
silently deviate from a D-numbered decision.

## The one invariant

```
L1, L3, L4 are ALWAYS deterministic functions of L0 + L2.
```

| Layer | What | File | Mutability |
|---|---|---|---|
| **L0** | append-only event log, monotonic `seq` | `trace.jsonl` | source of truth, never edited |
| **L2** | content-addressed payloads | `blobs/<first2>/<sha256>` | write-once |
| **L1** | `nodes` / `node_summaries` / `node_links` | `tree.db` | derived, **rebuilt not migrated** |
| **L3** | sqlite-vec embeddings | `tree.db` | derived, disposable |
| **L4** | generated markdown views | `views/<rootId>.md` | render-only, never hand-edited |

Consequences you will feel while working here:

- Changing the segmenter or a summary prompt means **delete the derived layers
  and rebuild** (`context-tree rebuild`). There is no L1 data migration, ever —
  if you find yourself writing one, the design has been violated.
- L1 stores **coordinates, not content**. A node references L0 through
  `span_start_seq` / `span_end_seq`; the text lives in L2.
- `node_summaries` rows are **versioned, never overwritten** (D3). "What did the
  model actually see" is an audit trail, and it is a feature.

## Module map

```
packages/core/src/
  contracts/   every interface in the system. Frozen; modules compile against it.
  config.ts    context-tree.config.json + env-only API keys
  paths.ts     on-disk layout; DERIVED_LAYERS is what a rebuild deletes

  trace/       L0  append-only JSONL writer/replayer, event type guards
  blobs/       L2  SHA-256 content store, atomic write-once
  store/       L1+L3  SQLite schema, versioned summaries, staleness cascade
  segment/     §7  pure state machine: TraceEvent[] -> TreeOp[]
  spans/       §12 tree-sitter span extraction + line differ
  ingest/      §7.1 the hermetic pipeline; rebuild; optional enrichment post-pass
  tokens/      deterministic tokenizer for zone budgets and cache assertions
  prompts/     versioned .md artifacts: system contract, leaf/root summary
  models/      §11 Anthropic + OpenRouter + mock/recorded, retries, cost meter
  summarize/   §8  leaf/root summarizers, invalidation cascade, background queue
  assemble/    §10 zone assembler, budgets, cache breakpoints
  retrieve/    §9  collapsed-tree search, beam fallback, fetch/peek
  providers/   §9.1 graft / Serena / Augment / grep + deterministic merge
  render/      L4  markdown views

packages/mcp/   §9  the tool registry (retrieval + pipeline stages), MCP stdio + loopback HTTP (D22)
packages/cli/   init | import | rebuild | render | eval
eval/           §15 resumption benchmark, arms A–D
```

## Three boundaries that are easy to violate

### 1. Ingestion is hermetic (D15, §7.1)

The mandatory pipeline — segmenter, span extraction, store — reads **only** L0,
L2, and tree-sitter. It never calls graft, Serena, Augment, or any network API.

Why: rebuild determinism. External indexes drift, so if ingestion consulted
them, rebuilding after a segmenter change would mix algorithm diffs with
tool-state diffs — unreproducible and unauditable. Also latency: ingestion is
stream-shaped and inline (ms per event); `graft ask` is query-shaped (seconds).

Semantic enrichment is a **separate, optional, non-blocking post-pass** writing
provenance-stamped `meta_json.enrichment[]` fields that nothing structural
depends on.

> **Ingestion produces coordinates, retrieval answers questions, enrichment
> decorates — never the reverse.**

### 2. Tree-sitter is span extraction only (D9, §12)

Parse the post-edit blob, map diff hunks to minimal enclosing named nodes, write
spans + symbol names. It is not a store and not a query engine.

Error tolerance is the whole reason it's here: a work-in-progress file with
syntax errors must still yield spans. A missing grammar degrades to diff-hunk
line spans rather than failing.

### 3. Prompt layout is fixed; only content migrates (D5, §10)

```
┌──────────────────────────────────────────────┐
│ Zone A  system + tool schemas      (frozen)  │ ← cache: permanent
├──────────────────────────────────────────────┤ ← cache breakpoint
│ Zone B  root + branch summaries    (stable)  │ ← cache: grows rarely
│         in CREATION ORDER                    │
├──────────────────────────────────────────────┤ ← cache breakpoint
│ Zone C  active branch full detail (mutable)  │ ← rewritten each phase
├──────────────────────────────────────────────┤
│ tail    fetch results                │ ← prefix untouched
└──────────────────────────────────────────────┘
```

Zone B is **never relevance-ordered**. Relevance is expressed by *expansion in
Zone C*; reordering the cached prefix is the cache killer. `fetch`
results append *after* Zone C for the same reason.

The **cache assertion harness** (§17) is where D5 regressions surface, and
essentially nowhere else: a deterministic tokenizer plus a provider cache
simulator asserting exactly which prefix ranges survive each event type.

## Data flow

```
agent events ─┐
              ├─▶ L0 trace.jsonl ──┐
file contents ┘   L2 blobs/        │
                                   ▼
                    segment() ──▶ TreeOp[] ──▶ applySegmentation ──▶ L1
                                   │                                  │
                    spans/ ────────┘                                  │
                    (tree-sitter, post-edit blob)                      │
                                                                       ▼
                                            summarize/ (async, D11) ──▶ node_summaries
                                                                       │
                                                    retrieve/ ◀────────┤
                                                    assemble/ ◀────────┤
                                                    render/   ◀────────┘
```

## Extension points (post-v1, §14)

The interfaces are explicit and stable precisely so these can land without a
redesign:

1. **Learned edit policy** (ContextPilot) replaces the §9 system-prompt contract
   — which is why that contract lives in one versioned file.
2. **Automatic memory evolution** (A-MEM): `node_links` + versioned summaries
   already support it; the trigger policy is the missing piece.
3. **Cross-session workflow mining** (Agent Workflow Memory) over closed task
   trees keyed by their root-summary headings.
4. **Predictive prefetch** (Sleep-time Compute) for still-open branches.
