# context-tree — design summary

**Branch** `feat/context-tree-v1` · 11 commits · 791 tests · typecheck clean
**Date** 2026-08-31 · **Spec** `IMPLEMENTATION_PLAN.md` (decision record D1–D16)

---

## What it is

An agent working a real task — fix bug → edit three files → run tests → open PR
→ address review — produces a linear token stream that degrades in both quality
and cost as it grows. context-tree reorganizes that stream into a **tree of
semantically-segmented branches, each headed by an LLM summary**, so a
long-running or resumed session sees branch summaries instead of raw history and
pulls detail back on demand through four MCP tools.

No fine-tuning anywhere. Every behavior is prompt and tool-schema driven on
hosted frontier models.

## The invariant everything rests on

```
L1, L3, L4 are ALWAYS deterministic functions of L0 + L2.
```

| Layer | What | Mutability |
| --- | --- | --- |
| **L0** | `trace.jsonl` — append-only event log, monotonic `seq` | source of truth, never edited |
| **L2** | `blobs/<first2>/<sha256>` | write-once |
| **L1** | SQLite `nodes` / `node_summaries` / `node_links` | derived, **rebuilt, never migrated** |
| **L3** | sqlite-vec embeddings | derived, disposable |
| **L4** | generated markdown views | render-only |

L1 stores **coordinates, not content**: a node references L0 by `seq` range, and
the text lives in L2. Changing the segmenter or a summary prompt means delete
the derived layers and rebuild — there is no L1 migration path, by design.

## Shape

```
packages/core   16 modules, ~10.0k lines   trace · blobs · store · segment · spans ·
                                           ingest · tokens · cache · prompts · models ·
                                           summarize · assemble · retrieve · providers · render
packages/mcp                               the tool registry over stdio MCP + loopback HTTP (D22)
packages/cli    ~1.6k lines                init · import · rebuild · render · summarize · tree · eval
eval-resumption ~6.3k lines                §15 benchmark: arms A–D, 30 tasks, 37 fixtures
```

Every module was written against a frozen interface surface in
`core/src/contracts/`, defined before any implementation, so the layer
boundaries are enforced by the type system rather than by convention.

## The three boundaries that carry the design

**1. Ingestion is hermetic (D15).** The mandatory pipeline reads only L0, L2 and
tree-sitter. It never calls graft, Serena, Augment, or any network API — because
external indexes drift, and a tree that depended on them could not be rebuilt
reproducibly. Semantic enrichment is a separate, optional, discardable post-pass
writing provenance-stamped fields nothing structural reads. *Proven by test:*
ingest completes with `fetch` trapped and a provider registry that throws on any
access.

**2. tree-sitter is span extraction only (D9).** Parse the post-edit blob, map
diff hunks to minimal enclosing named nodes. Error tolerance is the entire
reason it is here — a work-in-progress file with syntax errors must still yield
spans, and a missing grammar degrades to raw hunk ranges rather than failing.

**3. The prompt layout is fixed; only content migrates (D5).** Zone A (frozen
system + tool schemas) → Zone B (summaries in **creation order**) → Zone C
(active branch detail) → tail (fetch results). Zone B is never
relevance-ordered: reordering the cached prefix is the cache killer, and
relevance is expressed by expansion in Zone C instead.

## What is verified, and how

| Claim | Evidence |
| --- | --- |
| **D5 caching works** | Live against Anthropic: call 1 wrote 4,039 tokens to cache, call 2 read 4,039 back, input 12 both times. Ships with a counterfactual — the same request without the breakpoint caches nothing. |
| **M5 resumption** | End-to-end test drives the real pipeline and resumes in **2 tool calls** against a ≤3 bar; 3 of 4 needed facts came from Zone B with zero calls. |
| **D1 determinism** | 400-event fixture segments in <5 ms, byte-identical across runs. |
| **D8 rebuild** | `rebuild()` reproduces the identical tree; `trace.jsonl` verified byte-identical before and after. |
| **D4 cascade** | Marks leaf + ancestors and provably never a sibling. |
| **§15 criteria** | Report `unproven` with per-criterion reasons when an arm did not run — never a fabricated pass. |

## Decisions taken during implementation

- **D16 (added to the plan, not deviated from):** node ids are a deterministic
  function of the segmentation NodeKey, not random ULIDs. With random ids,
  `rebuild()` minted new ones, so L0 events naming a node could not be resolved
  afterwards — which was silently destroying every annotation and lateral link.
- **`other` is a neutral phase.** A literal reading of §7 opens a phase per tool
  change; on real traces read-shaped tools dominate and the tree degenerates
  into dozens of one-event phases. Config-controlled, `[]` restores the literal rule.
- **The unstructured fallback is lexical**, not embedding-based, because D15
  forbids a network call in the ingestion path.
- **Synthetic fixtures only.** §17 asks for scrubbed real sessions; scrubbing is
  never provably complete and a trace log is a verbatim record of private work.

## Known state

**Complete:** M0–M5, M7. **Built but unrun:** M6 — a full benchmark projects
$8.84 per seed (~$44 at §15's five seeds) and refuses to start against the
default $5 cap with *"Nothing was sent."*

**Open:** L3 embeddings are unbuildable with the current keys — neither
Anthropic nor OpenRouter exposes an embedding endpoint — so `search`
runs entirely on the lexical beam-search fallback. A Voyage key is the drop-in;
config already supports it.

## Provisional parameters

Not listed here. Every tunable is one row in `packages/mcp/src/params.ts` (`PIPELINE_PARAMS`:
environment name, bounds, default, which stage reads it, description), served at `GET /v1/params`;
what each one *means* is in `reports/algorithm.md` § Parameters. None has been swept.

Stale above, as of this date: `eval-resumption` and `cli eval` were deleted (D20); the
decision record runs to D24; test and line counts are from 2026-08-31.
