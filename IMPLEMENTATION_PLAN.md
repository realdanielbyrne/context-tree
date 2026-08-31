# context-tree — Implementation Plan

**Version:** 1.0 (design finalized in design review, 2026-08-31)
**Packages:** `@context-tree/core`, `@context-tree/mcp`, `@context-tree/cli` (npm, TypeScript)
**Target:** Organize multi-turn agent conversations (prompts, responses, tool
calls/outputs, file chunks) into a summary-headed tree with cache-aware prompt
assembly and on-demand branch retrieval via tools. Tested against
**non-finetuned frontier models** (Anthropic API, OpenRouter) — no training in v1.

---

## 1. Executive summary

An agent working a long task (fix bug → edit 3 files → run tests → create ticket
→ open PR → address review comments) produces a linear token stream that degrades
context quality and cost. This system reorganizes that stream into a **tree of
semantically-segmented branches**, each headed by an **LLM summary**, such that:

1. The **active branch** is expanded in full in the prompt; other branches appear
   as summaries only.
2. Summaries carry **rehydration pointers** (node IDs, file spans) so the model
   can call `context_fetch` to pull a non-active branch's detail on demand.
3. Prompt assembly is **prefix-stable** (cache-friendly): summaries in the cached
   prefix; mutable detail always at the tail.
4. Updates are **incremental**: appending a turn touches one leaf; only summaries
   on its ancestor path are recomputed (amortized 1–3 LLM calls/turn).

Everything is derived deterministically from an immutable trace log, so the
segmentation algorithm can change without data migration.

## 2. Goals / non-goals

**Goals**
- G1: Deterministic O(n) trace segmentation from tool-call structure (0 LLM calls).
- G2: RAPTOR-style hierarchical summarization (O(segments) parallel LLM calls).
- G3: Cache-aware prompt assembly (lifecycle-ordered layout).
- G4: Tool-based requery via prompting only, on non-finetuned frontier models.
- G5: Layered storage: event log → SQLite tree → derived views; all rebuildable.
- G6: Installable npm package; MCP server as the agent-facing surface.
- G7: Evaluation harness for **session-resumption quality** on coding tasks.

**Non-goals (v1)**
- No fine-tuning/RL of the context-edit policy (extension point; see ContextPilot).
- No server/multi-tenant deployment (SQLite local-first; Postgres adapter later).
- No cross-session workflow mining in v1 (AWM-style reuse is §14 extension).
- No automatic A-MEM-style memory-evolution triggers in v1 beyond `annotate`
  tool (schema supports it now; auto-evolution is v1.1).

## 3. Design decisions (decision record)

| # | Decision | Rationale / evidence |
|---|----------|----------------------|
| D1 | Segment deterministically from tool-type transitions, not content clustering | Agent traces carry free structural signal; O(n), 0 LLM calls, exact. Gap vs RAPTOR's content clustering |
| D2 | Summarize per-branch, bottom-up, parallel; cheap model at leaves, strong model at root | RAPTOR (+20% abs on QuALITY vs flat RAG); arXiv:2401.18059 |
| D3 | Summaries are **versioned rows**, never overwritten | Audit trail ("what did the model see"); enables A-MEM evolution later; arXiv:2502.12110 |
| D4 | Path-scoped invalidation on append (leaf + ancestors only) | Amortized 1–3 calls/turn; same idea as tree-sitter incremental reparse |
| D5 | Prompt layout: frozen system → stable summary zone → mutable tail | Prefix-keyed caches: middle edits invalidate suffix. Caching rewards *stable layout*, not *minimal payload* |
| D6 | Fetched branches live at the tail and die at phase boundaries (soft offloading) | Prevents accumulation/context-rot; ContextPilot shows offload tools help; arXiv:2608.28476 |
| D7 | Requery via tools; prompting only | MemGPT validated self-paging via function calls, untrained; arXiv:2310.08560 |
| D8 | JSONL event log (truth) + hash-addressed blobs + SQLite tree + disposable embeddings + generated markdown views | Replayability, structural sharing, local-first; tree is a *view* of an interpretation |
| D9 | Tree-sitter **in ingestion only** (exact spans like `pricing.go:142–168`) | Parsers aren't databases; exact spans make rehydration pointers trustworthy |
| D10 | Typed node kinds (task/phase/file/turn) + lateral `node_links` | MIRIX: typed memory > flat (arXiv:2507.07957); links fix pure-tree blindness (A-MEM) |
| D11 | Background summarization of closed branches ("sleep-time compute") | 5× test-compute reduction, +13–18% acc; SWE case study; arXiv:2504.13171 |
| D12 | TypeScript/npm monorepo; MCP server surface | Frontier tool-calling works untrained; MCP is the standard agent-tool interface |
| D13 | Pluggable retrieval backends: `context_search` fans out to graft / Serena / Augment Context Engine / local vectors / ripgrep; structural (graph) hits rank above fuzzy (semantic) hits | Graph = ground truth, similarity = recall assistant (design review); graft's ask-vs-grep split maps directly to ranked-vs-exhaustive |
| D14 | Optional **middleware mode**: context-tree can be the agent's *only* code-semantics tool surface, proxying/fanning out provider calls and owning assembly + eviction | One stable tool set in Zone A instead of a dozen host tools → larger frozen cache prefix; centralized eviction; every retrieval event is an L0 `tool_call` row, so D1 indexes it into the tree unchanged |
| D15 | Ingestion stays **hermetic**: the mandatory pipeline (segmenter, spans, store) uses only L0 + L2 + tree-sitter — no graft-like semantic search. Cross-file semantic enrichment is an optional post-pass: provenance-stamped, non-blocking, discardable | Rebuild determinism (D8): tree must not depend on external index state (graft graph drifts, APIs change). Latency: ingestion is ms-scale inline; `graft ask` is seconds-scale query-shaped. Symbol spans within edited files (the semantic work ingestion needs) are covered locally by tree-sitter (D9) |

## 4. Prior art and reference implementations

| Paper | arXiv | Take from it | Sample code |
|-------|-------|--------------|-------------|
| RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval | [2401.18059](https://arxiv.org/abs/2401.18059) | Bottom-up cluster+summarize tree; collapsed-tree retrieval from any level | https://github.com/parthsarthi03/raptor (Python) |
| MemGPT: Towards LLMs as Operating Systems | [2310.08560](https://arxiv.org/abs/2310.08560) | Self-directed memory paging via function calls, untrained models | https://github.com/letta-ai/letta (Python/TS) |
| Mem0: Scalable Long-Term Memory | [2504.19413](https://arxiv.org/abs/2504.19413) | Extract/consolidate ops (ADD/UPDATE/DELETE/NOOP); 91% lower p95 latency vs full-context | https://github.com/mem0ai/mem0 (Python) |
| A-MEM: Agentic Memory for LLM Agents | [2502.12110](https://arxiv.org/abs/2502.12110) | Note linking + memory evolution (new inserts update historical notes) | https://github.com/agiresearch/A-mem (Python) |
| Agent Workflow Memory | [2409.07429](https://arxiv.org/abs/2409.07429) | Inducing reusable routines from trajectories; cross-session value of phase segments | https://github.com/zorazrw/agent-workflow-memory (Python) |
| MIRIX: Multi-Agent Memory System | [2507.07957](https://arxiv.org/abs/2507.07957) | Typed memory tiers; SOTA LOCOMO 85.4% | https://github.com/Mirix-AI/MIRIX (Python) |
| Sleep-time Compute | [2504.13171](https://arxiv.org/abs/2504.13171) | Offline precompute over stored context; 5× test-compute reduction; SWE case study | https://github.com/letta-ai/sleep-time-compute (Python) |
| ContextPilot: Proactive Context Mgmt via RL | [2608.28476](https://arxiv.org/abs/2608.28476) | Frontier: learned edit policies, soft offloading, action-level credit. Our v1 = its zero-shot baseline | code link in paper abstract |
| Survey: Memory Mechanism of LLM Agents | [2404.13501](https://arxiv.org/abs/2404.13501) | Taxonomy of memory ops; evaluation caveats | — |
| Survey: Context Engineering for LLMs | [2507.13334](https://arxiv.org/abs/2507.13334) | 1400+ paper taxonomy: retrieval/processing/management | — |
| tree-sitter | thesis/intro [1805.10208](https://arxiv.org/abs/1805.10208) | Incremental reparse + structural sharing as the model for D4/D9 | https://github.com/tree-sitter/tree-sitter (C) |

Supporting libraries: `sqlite-vec` (https://github.com/asg017/sqlite-vec),
`tree-sitter` npm + grammars (https://github.com/tree-sitter/node-tree-sitter),
MCP SDK `@modelcontextprotocol/sdk`
(https://github.com/modelcontextprotocol/typescript-sdk),
`@anthropic-ai/sdk`, and the `openai` npm client pointed at
`https://openrouter.ai/api/v1` for OpenRouter models.

**Literature gaps this project fills** (cite when publishing):
1. Deterministic *tool-trace* segmentation (RAPTOR clusters content; ignores agent structure).
2. Incremental consistency on append (all cited systems are batch-build).
3. Session-resumption evaluation for coding agents (LOCOMO-style QA doesn't test
   "can a fresh agent resume this task from the tree alone").

## 5. Architecture overview

```
                 ┌──────────────────── ingestion ────────────────────┐
agent events ───▶│ L0 trace.jsonl (append-only)   L2 blobs/ (hash)   │
(tool calls,     │ L0 segmenter (tool-type state machine, O(n))      │
 messages,       │ L0 tree-sitter span extraction for edit_file      │
 file edits)     └───────────────┬───────────────────────────────────┘
                                 ▼
                 ┌──────────────────── tree store ───────────────────┐
                 │ L1 SQLite: nodes / node_summaries / node_links    │
                 │    versioned summaries, stale_since_seq markers   │
                 └───────┬──────────────────────────┬────────────────┘
                         ▼                          ▼
        L3 sqlite-vec embeddings      L4 markdown views (render-only)
           (disposable, rebuildable)     (agent- and human-readable)
                         │
                         ▼
   prompt assembler (layered lifecycle layout, prefix-stable)
                         │
        ┌────────────────┼──────────────────────┐
        ▼                ▼                      ▼
  MCP server        CLI reporter         eval harness
  (context_fetch,   (tree print/dump)    (resumption tasks)
   context_search,
   context_peek)
```

Rebuild rule: L1, L3, L4 are **always** deterministic functions of L0 + L2.
Changing the segmenter or summary prompts = delete derived layers + rebuild.


## 6. Storage specification

### L0 — Trace log (`trace.jsonl`, append-only, immutable)

One JSON object per line, monotonically increasing `seq`. Never edited; the
source of truth for every derived layer.

```jsonc
{"seq":47,"type":"tool_call","tool":"edit_file","path":"pricing.go",
 "blob":"b3f1a2…","ts":"2026-08-31T12:00:00Z","parent_seq":44}
{"seq":48,"type":"tool_result","call_seq":47,"output_blob":"9a2c…","truncated":false}
{"seq":52,"type":"segment_boundary","from":"implementation","to":"verification"}
{"seq":53,"type":"user_message","blob":"c1d0…"}
```

`type` ∈ {`user_message`, `assistant_message`, `tool_call`, `tool_result`,
`segment_boundary`, `manual_annotation`}. Large payloads live in L2 and are
referenced by content hash.

### L2 — Content store (`blobs/<first2>/<hash>`)

Hash-addressed (SHA-256) files: file contents, diffs, tool outputs, message
bodies. Structural sharing = same content stored once, referenced many times
(git / tree-sitter persistent-tree model). Free dedup across sessions.

### L1 — Tree store (SQLite; `better-sqlite3` for sync, transactional access)

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,              -- 'n_<ulid>'
  parent_id TEXT REFERENCES nodes(id),
  kind TEXT NOT NULL,               -- task|phase|file|turn
  title TEXT NOT NULL,              -- short human label (pre-LLM or LLM)
  phase_type TEXT,                  -- phases only: diagnosis|implementation|verification|delivery|review|other
  span_start_seq INTEGER,           -- trace coverage
  span_end_seq INTEGER,
  status TEXT DEFAULT 'open',       -- open|closed|superseded
  current_summary_version INTEGER DEFAULT 0,
  stale_since_seq INTEGER           -- set when content changed after last summary
);

CREATE TABLE node_summaries (       -- D3: versioned, never overwritten
  node_id TEXT, version INTEGER, model TEXT,
  text TEXT,                       -- the branch heading
  meta_json TEXT,                  -- structured rehydration pointers (see §9)
  created_at TEXT, PRIMARY KEY (node_id, version)
);

CREATE TABLE node_links (           -- lateral edges (A-MEM-style)
  from_id TEXT, to_id TEXT, kind TEXT,  -- superseded_by|relates_to|blocks
  created_at TEXT, PRIMARY KEY (from_id, to_id, kind)
);

CREATE TABLE embeddings (           -- L3, disposable
  node_id TEXT, version INTEGER, vec BLOB, PRIMARY KEY (node_id, version)
);
```

Invariants enforced in code:
- `nodes.parent_id` forms a forest; exactly one root per task/session.
- A node's content is defined by its `span_*_seq` range over L0 — never inline
  message text in L1 (content lives in L2; spans are coordinates).
- Any content append under a node sets `stale_since_seq`; the summarizer clears
  it after writing a new `node_summaries` version.

### L4 — Markdown views (render-only)

`render(task_id)` emits one `.md` per task: an indented outline of branches with
their current summaries, spans, and links. Generated from L1 — **never edited by
hand**. Two consumers: humans reviewing the tree, and the agent when the host
doesn't support MCP (the file is readable context). Mirrors graft's model
(markdown nodes as views over an index).

## 7. Segmentation engine (D1)

Deterministic state machine over the trace. Zero LLM calls, O(n), exact.

```ts
type PhaseType = "diagnosis" | "implementation" | "verification"
               | "delivery" | "review" | "other";

const TOOL_PHASE: Record<string, PhaseType> = {
  edit_file: "implementation", write_file: "implementation",
  run_tests: "verification",  run_command: "other",
  create_ticket: "delivery",  push_pr: "delivery",  open_pr: "delivery",
  post_comment: "review",     reply_comment: "review",
};
```

Algorithm: single pass over L0. A new **phase node** opens when the current
tool's mapped phase differs from the open phase node's `phase_type`. File edits
create **file nodes** under the implementation phase, keyed by path (re-edits
append spans to the same file node). User messages attach to the currently open
phase. Config file (`context-tree.config.json`) lets a project remap tools →
phases, since tool names vary by harness (Claude Code vs Codex vs custom).

For **unstructured traces** (no tool calls), fall back to text segmentation:
sliding-window embedding similarity with a changepoint threshold (TextTiling /
Bayesian online changepoint detection — Hessel et al. 2021). This is a
documented fallback; agent traces almost never need it.

Acceptance: segmenting a 400-message fixture trace produces the expected
phase sequence, <5 ms, bit-identical across runs.

### 7.1 Hermeticity boundary (D15) — no semantic search in the mandatory path

The ingestion pipeline is **hermetic**: it reads only L0 (trace), L2 (blobs),
and parses blobs with tree-sitter. It never calls graft, Serena, Augment, or
any network API. Three reasons:

1. **Rebuild determinism (D8).** External indexes drift (graft's graph updates
   with the code; hosted APIs change results). If ingestion consulted them,
   rebuilding the tree after a segmenter change would mix algorithm diffs with
   tool-state diffs — unreproducible, unauditable.
2. **Latency.** Ingestion is stream-shaped and inline (ms per event);
   `graft ask` is query-shaped (seconds). Wrong tool shape for the stage.
3. **Coverage.** The semantics ingestion needs — defs, spans, symbols *within
   edited files* — is exactly tree-sitter's local, error-tolerant job (D9).

**Optional enrichment pass (the sanctioned way semantics enters ingestion):**
after segmentation + summarization complete for a phase, a background pass may
consult available §9.1 providers to annotate nodes:
- file nodes: callers of changed symbols, related modules (`graft callers`)
- branch-to-branch `relates_to` links: embedding similarity between branch
  summaries via L3 (internal, no external tool needed)

Rules that keep this from contaminating the core:
- Enrichment writes **provenance-stamped fields** (`meta_json.enrichment[]`
  with `provider`, `timestamp`, `index_version`) — never a field the tree's
  structural correctness depends on.
- Non-blocking, best-effort; absent providers → identical tree minus the
  annotations.
- Discarded on rebuild by default; rebuilt lazily from current providers.

Rule of thumb for the implementer: **ingestion produces coordinates, retrieval
answers questions, enrichment decorates — never the reverse.**

## 8. Summarization engine (D2, D11)

- **Trigger:** a phase node closes (new phase opened, or session ended). Leaf
  summaries are generated in parallel (`Promise.all`, concurrency cap 8) using
  the **cheap model** (default: `claude-haiku` family via provider config).
- **Root/task summary:** one call to the **strong model** over the set of leaf
  summaries, after all leaves complete.
- **Summary content contract** (the rehydration-pointer requirement): every
  summary MUST include structured metadata so relevance is detectable from the
  summary alone — files touched (with spans from tree-sitter), symbols changed,
  tests run/failed, external artifacts (ticket IDs, PR numbers, URLs), open
  questions. Stored in `node_summaries.meta_json`; rendered after the prose.
- **Incremental (D4):** on append to an open leaf, mark `stale_since_seq`.
  Re-summarize that leaf, then cascade up the ancestor path only. Amortized
  1–3 calls/turn. Sibling branches are never re-summarized.
- **Background (D11):** summarization runs async after phase close ("sleep-time
  compute"); the prompt assembler reads whatever summary version is current and
  never blocks on the summarizer.


## 9. Retrieval and tool API (D7) — the MCP server

`@context-tree/mcp` exposes three tools over stdio MCP. These are the *only*
way a hosted model interacts with the tree — no fine-tuning, tool schemas +
system-prompt discipline only (validated by MemGPT on untrained models).

| Tool | Signature | Behavior |
|------|-----------|----------|
| `context_fetch` | `{branch_id: string, depth?: "summary"\|"full", file?: string}` | Returns branch content. `file` narrows to one file node (common case: testing phase needs one file from implementation). Result is appended to the host transcript's tail — never mutates the stored tree or the cache prefix |
| `context_search` | `{query: string, kind?: NodeKind}` | Collapsed-tree retrieval (RAPTOR): embed query, search node-summary vectors (L3), return ranked summaries + node IDs. Falls back to top-down beam search over summary text if L3 is absent |
| `context_peek` | `{node_id: string, max_chars?: number}` | Cheap excerpt for relevance checking — "suspicion costs one small call, not a full expansion" |

Plus one write-side tool:

| Tool | Signature | Behavior |
|------|-----------|----------|
| `annotate` | `{node_id, text, link_to?: node_id, link_kind?}` | Adds a `node_links` edge and/or a note. This is the v1 seed of A-MEM-style memory evolution (a review-phase discovery can mark the implementation branch `superseded_by` a later branch) |

System-prompt contract shipped by the package (the "prompting not training"
surface, kept in one versioned file so a future learned policy can replace it):
1. "Before editing any file, if its current content is not in context, call
   `context_fetch` first" (read-before-edit discipline).
2. "Branch summaries list the files/artifacts each phase touched. If a summary
   mentions something you need, fetch that branch."
3. "Summaries may be stale or incomplete; when in doubt, `context_peek`."

Failure mode design (from design review):
- **Unknown-unknowns** (model can't ask for what it doesn't know exists) →
  mitigated by the structured `meta_json` in every summary (files/symbols/
  decisions/open-questions are always visible).
- **Accumulation drift** (fetched content never leaves) → host-side discipline:
  fetched content lives in the transcript tail only; the assembler drops
  demoted-branch detail at phase boundaries (soft offloading, ContextPilot).

### 9.1 Retrieval backends (D13) — graft, Serena, Augment, vectors, grep

`context_search` and `context_fetch` are **facades over pluggable providers**
(live in `packages/core/src/providers/`). Context-tree does not reimplement
code semantics — it orchestrates the tools that already do this:

```ts
interface RetrievalProvider {
  id: string;                                     // "graft" | "serena" | "augment" | "vector" | "grep"
  available(): Promise<boolean>;                  // capability probe at startup
  search(q: SearchQuery): Promise<Candidate[]>;   // ranked refs: {path, span?, symbol?, score, provider}
  hydrate(ref: Candidate): Promise<Content>;      // full text for a candidate (file:span or node)
}
```

| Provider | Mechanism | Tier |
|----------|-----------|------|
| `GraftProvider` | Shells out to `graft ask --source` (ranked nodes + `covers:` spans), `graft grep` (exhaustive), `graft callers` (blast radius); `hydrate` opens the exact file:line | structural |
| `SerenaProvider` | MCP client to Serena's LSP-backed symbol tools (`find_symbol`, `find_referencing_symbols`); precise defs/refs where the language server exists | structural |
| `AugmentProvider` | Augment Context Engine API — semantic recall over the codebase | fuzzy |
| `VectorProvider` | L3 sqlite-vec over node summaries (always available; the v1 default) | fuzzy |
| `GrepProvider` | ripgrep over the repo — universal fallback, authoritative for exhaustive-pattern queries | fallback |

**Deterministic merge policy** (so rankings are reproducible and auditable):
1. Structural hits first (graft, Serena) — exact edges, verifiable spans.
2. Fuzzy hits next (Augment, VectorProvider).
3. Grep last — unless `mode: "exhaustive"`, in which case grep is authoritative
   (mirrors graft's own `ask` vs `grep` distinction: ranked-top-N vs complete).
Dedup by `(path, span)`; survivors become candidates the agent resolves via
`context_fetch`. Provider provenance is recorded in each tool result so the
eval harness can measure which tier actually contributed.

### 9.2 Middleware role (D14) — two operating modes

**Mode A — tool backend (v1 default, additive).** The agent host keeps its
native tools; context-tree runs alongside as one more MCP server whose tools
fan out per §9.1. Lowest integration cost; measure value first.

**Mode B — context middleware (opt-in).** Context-tree is the *only*
code-semantics surface the agent sees. It owns tool selection/fan-out, result
placement (tail-side, cache-prefix untouched), eviction at phase boundaries,
and the L0 trace. Rationale:
- Zone A stays frozen and small — 3–4 tool schemas instead of the host's full
  toolbox → larger stable cache prefix (D5).
- Eviction/offload policy is centralized instead of spread across the host.
- Every retrieval (including proxied graft/grep calls) lands in L0 as a normal
  `tool_call` event, so the segmenter indexes it into the tree with zero new
  machinery — retrieval history becomes first-class context.

When Mode B is off, context-tree can still *observe* host tool calls (via
transcript import) and index their outputs into the tree — observation is
always on; proxying is optional.

## 10. Prompt assembly — layered lifecycle layout (D5)

The assembler produces the message list for each turn. Layout is **fixed**;
content migrates through it by lifecycle:

```
┌───────────────────────────────────────────────┐
│ Zone A  system + MCP tool schemas   (frozen)  │ ← cache: permanent
├───────────────────────────────────────────────┤
│ Zone B  task root summary            (stable) │ ← cache: grows rarely
│         branch summaries in CREATION ORDER    │   (insertion invalidates
│         (+ lateral-link annotations)          │    only the suffix, which
├───────────────────────────────────────────────┤ │    Zone C rewrites anyway)
│ Zone C  ACTIVE BRANCH full detail   (mutable) │ ← rewritten each phase
│         + this turn's tool results            │
└───────────────────────────────────────────────┘
```

Rules:
1. Zone B order = node creation order, **never** relevance-ordered. Relevance
   is expressed by *expansion in Zone C*, not by reordering the prefix —
   reordering is the cache killer.
2. Phase transition = Zone C rewrite: previous phase's detail collapses into
   its (already-generated, backgrounded) summary, which is inserted into Zone
   B. Cost is proportional to summaries + new branch, not history length.
3. `context_fetch` results are appended after Zone C — cache-prefix untouched.
4. Budget: Zone B ≤ ~8k tokens (summarize harder if exceeded); Zone C ≤ ~30k
   tokens (fetch narrowly via `file:` param instead of whole branches).
5. Emit cache-control breakpoints at the Zone A/B and B/C boundaries
   (Anthropic prompt caching: `cache_control` markers; OpenRouter: pass through
   provider-native caching where available).

## 11. Model provider integration (non-finetuned frontier models)

- **Anthropic:** `@anthropic-ai/sdk`. Tool use via native tool schemas. Both
  roles needed by the system are plain hosted models:
  - summarizer (leaf): `claude-haiku-*` — cheap, parallel, high volume
  - summarizer (root) + eval judge: `claude-sonnet-*` / `claude-opus-*`
- **OpenRouter:** OpenAI-compatible client base-URL override; same tool schema
  shape; model ids from the OpenRouter catalog. Provider config:
  ```jsonc
  // context-tree.config.json
  { "leafModel": "anthropic/claude-haiku-…", "rootModel": "anthropic/claude-sonnet-…",
    "embedModel": "voyage-…", "providers": { … api keys via env only } }
  ```
- The agent-under-test consumes the MCP tools from whatever host (Claude Code,
  Codex CLI, a raw tool-use loop in the eval harness). **The eval harness
  implements its own minimal tool-use loop** so tests don't depend on any host.
- No model in the loop is ever fine-tuned. Prompt templates are versioned
  artifacts (`src/prompts/*.md`) with fixture-based golden tests.


## 12. Tree-sitter ingestion (D9)

Scope: **span extraction only**, never storage. On each `edit_file` event:

1. Parse the post-edit blob with the file's language grammar (lazy-load
   `tree-sitter-typescript`, `-python`, `-go`, … from config).
2. For each diff hunk, find the minimal enclosing named node(s) → exact spans
   like `pricing.go:142–168` and symbol names.
3. Write spans + symbol lists into the file node's metadata (feeds
   `meta_json` in summaries).

Error tolerance is the reason for tree-sitter here: WIP files always parse to a
partial tree (`ERROR` nodes), so spans exist even for broken code. If a language
grammar is unavailable, fall back to diff-hunk line spans (degraded but functional).

## 13. Repository / package layout (npm monorepo, pnpm workspaces)

```
context-tree/
├── IMPLEMENTATION_PLAN.md          ← this document
├── package.json / pnpm-workspace.yaml / tsconfig.base.json
├── packages/
│   ├── core/                       ← @context-tree/core
│   │   └── src/
│   │       ├── trace/              L0: event types, append-only writer, replay
│   │       ├── blobs/              L2: content-addressed store
│   │       ├── segment/            §7 state machine + text-segmentation fallback
│   │       ├── summarize/          §8 leaf/root summarizers, invalidation cascade
│   │       ├── store/              L1 SQLite schema + migrations + queries
│   │       ├── spans/              §12 tree-sitter ingestion
│   │       ├── assemble/           §10 prompt assembler
│   │       ├── retrieve/           collapsed-tree + beam search
│   │       └── models/             Anthropic + OpenRouter clients, retries, cost meter
│   ├── mcp/                        ← @context-tree/mcp  (§9 server, stdio)
│   └── cli/                        ← @context-tree/cli
│       └── (init | import <trace.jsonl> | rebuild | render | eval)
├── eval/                           fixtures + harness + results (not published)
└── docs/
```

Install end-state: `npm i -g @context-tree/cli && context-tree init` wires the
MCP server into Claude Code / Codex config, mirroring graft's onboarding UX.

## 14. Documented extension points (post-v1)

1. **Learned edit policy** (ContextPilot, arXiv:2608.28476): replace the §9
   system-prompt contract with an RL-trained policy; tool interface is already
   explicit and stable for exactly this reason.
2. **Automatic memory evolution** (A-MEM, arXiv:2502.12110): trigger
   re-summary + `superseded_by` links when a later branch contradicts an
   earlier one (schema supports it; policy is the missing piece).
3. **Cross-session workflow mining** (Agent Workflow Memory, arXiv:2409.07429):
   harvest closed task trees into reusable workflow summaries keyed by their
   root-summary headings.
4. **Predictive prefetch** (Sleep-time Compute, arXiv:2504.13171): background
   pre-drafting of summaries for still-open branches, sized by query
   predictability.


## 15. Evaluation plan (G7 — the literature gap)

**Benchmark: session resumption on coding tasks.** No existing benchmark tests
"can a fresh agent resume this task from the tree alone" (LOCOMO-style QA does
not). Build 20–30 scripted tasks (10 fresh / 10 resumed-mid-task / 10
adversarial: stale summary, contradiction across branches, fetch-not-needed
trap), each with: full trace log, golden file states, and a checker script.

Baselines, same frontier model in all arms:

| Arm | Context given to the fresh resuming agent |
|-----|-------------------------------------------|
| A | full transcript (upper bound quality, worst cost) |
| B | flat last-N-token window (what naive agents do) |
| C | single-level whole-transcript summary (Mem0-style flatten) |
| D | **this system** (tree summaries + active branch + tools) |

Metrics: task success rate, tool-call count, input tokens (cache-read vs
cache-write split), p50/p95 latency, cost/task, organization quality
(stale-summary incidents; `context_peek` precision). Grading: script checkers +
LLM-as-judge (strong model, rubric at `eval/rubric.md`). n≥5 seeds per task.

v1 success criteria: D ≥ A − 5 pts on success rate, ≥50% lower input-token cost
than A, ≥30% lower than C, tool-call overhead < 2.5/task.

## 16. Milestones

| M | Deliverable | Acceptance |
|---|-------------|------------|
| M0 | Scaffolding, L0 writer/replay, L2 blob store | Fixture trace round-trips hash-identical |
| M1 | Segmenter (§7) + SQLite schema (§6) + rebuild CLI | 400-msg fixture segments <5 ms, deterministic |
| M2 | Summarizer + invalidation cascade (§8), mocked LLM | Stale-marking + cascade unit tests pass |
| M3 | Live-model summarization (Anthropic + OpenRouter) + cost meter | Real summaries pass §9 content contract on 5 golden branches |
| M4 | Prompt assembler (§10) + cache assertions | Phase transition invalidates only the expected token range |
| M5 | MCP server (§9) wired into Claude Code | Live bug-fix session → tree → fresh session resumes with ≤3 tool calls |
| M6 | Eval harness + arms A–D + results | §15 criteria met |
| M7 | npm publish, README, `context-tree init` | Cold install → first session < 5 min |

M0–M2 need **zero LLM budget** — do them first. M3+ consumes real tokens; cap
per-PR spend via the cost meter.

## 17. Testing strategy

- **Unit:** segmenter (table-driven per tool mapping), store invariants,
  invalidation cascade, assembler layout (token-range assertions).
- **Golden fixtures:** recorded traces (real Claude Code sessions, scrubbed)
  under `eval/fixtures/`; snapshot the derived tree.
- **Contract tests:** prompts tested against recorded completions (no network
  in CI); `LIVE=1` opt-in suite hits real models.
- **Cache assertion harness:** deterministic tokenizer + provider cache
  simulator asserting exactly which prefix ranges survive each event type —
  this is where D5 regressions will surface.
- **Focused tests locally** (`pnpm vitest run <path>`); full suite in CI.

## 18. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Frontier model doesn't requery reliably (under/over-fetch) | §9 prompt contract + structured `meta_json`; measure fetch precision in eval; documented upgrade path to RL policy |
| Stale summaries mislead resumption | Versioned summaries + `stale_since_seq`; adversarial stale fixtures in eval |
| Tool-name drift across harnesses breaks segmentation | Config-remapped TOOL_PHASE; unknown tools → `other`, never crash |
| Cache behavior differs per provider | Per-provider cache-simulator tests; provider-neutral layout + provider-specific cache markers |
| Scope creep toward a full memory product | v1 frozen to single-task trees; extensions behind §14 interfaces |
| Provider availability varies (graft not installed, Serena language server missing, Augment API key absent) | Capability probe at init (§9.1); GrepProvider + VectorProvider always available; degrade gracefully tier-by-tier, never hard-fail |

## 19. Open questions (for the implementing agent)

1. Embedding model default (local vs API) — decide in M6; L3 must stay disposable.
2. Should `context_search` search raw turns or summaries only? Start summaries-only.
3. Multi-task workspaces: one SQLite DB per task, or one DB with task roots?
   Start one-DB-per-task (mirrors graft's per-repo index simplicity).
4. Two agents on one tree: SQLite WAL is likely sufficient; revisit only if
   eval shows contention.
5. Mode A vs Mode B as the default: start Mode A (additive, zero host
   changes), and only switch the default to Mode B if the eval shows Zone A
   size savings and eviction wins are real (§15 adds a Mode A/B arm).
6. Provider ranking weights: the §9.1 tier order is fixed in v1; if eval
   shows a tier is dead weight for coding tasks, drop it rather than tune it.

