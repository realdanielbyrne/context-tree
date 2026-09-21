# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Limit exposition

Limit code comments and let the code speak for itself. Limit excessive exposition in reponses.

## Plan and decisions

`docs/IMPLEMENTATION_PLAN.md` carries the design and a decision record
(§3, D1–D24) with rationale and citations. **Do not silently deviate from a D-numbered
decision.** If implementation reveals a decision is wrong, say so, propose the
change, and update the plan's decision row — don't just write different code.
§19 lists deliberately open questions; those are yours to decide (with a stated
default already given for each).

Evaluation is **not** an in-repo harness (D20). The bespoke `eval/` harness was
deleted because its `ChatMessage` could not represent tool calls, invalidating
every measurement. Evaluation means running tasks in an external host (opencode)
with and without the MCP server attached.

## What this project is

`context-tree` reorganizes an agent's linear conversation trace (prompts,
responses, tool calls, file edits) into a summary-headed tree so a long-running
or resumed session sees branch summaries instead of raw history, and pulls
detail back on demand through MCP tools. Three npm packages:
`@context-tree/core`, `@context-tree/mcp`, `@context-tree/cli`. TypeScript,
pnpm workspaces, vitest, SQLite (`better-sqlite3`) + `sqlite-vec`, tree-sitter,
Anthropic SDK + OpenRouter. No fine-tuning anywhere in v1 — every behavior is
prompt + tool-schema driven on hosted frontier models.

## The architecture invariant that governs everything

Storage is layered, and **L1/L3/L4 are always deterministic functions of L0 + L2**:

| Layer | What | Mutability |
| --- | --- | --- |
| L0 | `trace.jsonl` — append-only event log, monotonic `seq` | source of truth, never edited |
| L2 | `blobs/<first2>/<sha256>` — content-addressed payloads | write-once |
| L1 | SQLite `nodes` / `node_summaries` / `node_links` | derived, rebuildable |
| L3 | sqlite-vec embeddings | derived, disposable |
| L4 | generated markdown views | render-only, never hand-edited |

Consequences to hold onto while coding:

- Changing the segmenter or a summary prompt means *delete derived layers and
  rebuild* — never write a data migration for L1.
- L1 stores **coordinates, not content**: nodes reference L0 via
  `span_start_seq`/`span_end_seq`; message text lives in L2.
- `node_summaries` rows are **versioned, never overwritten** (D3) — the audit
  trail of "what did the model actually see" is a feature, not overhead.

## Three boundaries that are easy to violate

1. **Ingestion is hermetic (D15, §7.1).** The mandatory pipeline — segmenter,
   span extraction, store — reads only L0, L2, and tree-sitter. It must never
   call graft, Serena, Augment, or any network API. Semantic enrichment is a
   separate, optional, non-blocking post-pass writing provenance-stamped
   `meta_json.enrichment[]` fields that nothing structural depends on.
   Mnemonic from the plan: *ingestion produces coordinates, retrieval answers
   questions, enrichment decorates — never the reverse.*
2. **Tree-sitter is span extraction only (D9, §12).** Parse the post-edit blob,
   map diff hunks to minimal enclosing named nodes, write spans + symbol names.
   It is not a store and not a query engine. Broken WIP files must still yield
   spans (that error tolerance is the whole reason it's here); missing grammar
   degrades to diff-hunk line spans rather than failing.
3. **Prompt layout is fixed; only content migrates (D5, §10).** Zone A
   (system + tool schemas, frozen) → Zone B (root + branch summaries in
   **creation order**) → Zone C (active branch detail, rewritten each phase).
   Zone B is never relevance-ordered — reordering the prefix is the cache
   killer; relevance is expressed by expansion in Zone C. `fetch`
   results append *after* Zone C so the cached prefix is untouched.

## Component notes worth knowing before you edit

- **Segmenter (§7)**: single O(n) pass, zero LLM calls, bit-identical across
  runs. Phase boundaries come from `TOOL_PHASE` tool-name → phase mapping, which
  is config-remappable (`context-tree.config.json`) because tool names differ per
  harness. **Unknown tool → `other`, never a crash.**
- **Summarizer (§8)**: leaves in parallel on the cheap model (concurrency cap 8),
  root on the strong model. Append marks `stale_since_seq` on the leaf and
  cascades **up the ancestor path only** — siblings are never re-summarized.
  Runs async after phase close; the assembler reads the current version and
  never blocks on it. Every summary must carry structured rehydration pointers
  in `meta_json` (files+spans, symbols, tests, ticket/PR ids, open questions) —
  that metadata is the mitigation for the model not knowing what it doesn't know.
- **Tool surface (§9, D22, D23)**: every pipeline stage is a tool in one registry
  (`packages/mcp/src/tools/index.ts` `TOOLS`), served to agents over MCP and to host plugins
  over loopback HTTP, on one session: `fetch`, `search`, `peek`, `annotate`, `units`,
  `classify`, `assemble`, `evict`, `restore`. The set is frozen *within a session* (D5), not
  capped. **`assemble` represents and never removes; `evict` is optional, takes the assembly
  as input and may overrule it** — keep their rules in separate code. Every stage works on the
  same unit (a turn = one host message). Every tunable is one row in
  `packages/mcp/src/params.ts`; never restate that list. Spec: `reports/algorithm.md`.
- **Retrieval providers (§9.1)**: `search`/`fetch` are facades
  over a `RetrievalProvider` interface (graft, Serena, Augment, vector, grep).
  Merge order is fixed and deterministic: structural → fuzzy → grep, except
  `mode: "exhaustive"` where grep is authoritative. `VectorProvider` and
  `GrepProvider` are always available; every other provider must degrade
  gracefully on a failed capability probe.

## Commands

```bash
pnpm install
pnpm vitest run <path>        # targeted tests — the local default
pnpm vitest run               # full suite = CI's
context-tree init             # wire the MCP server into a host's config
context-tree import <trace.jsonl> | rebuild | render | summarize | tree
```

Live-model tests are opt-in via `LIVE=1`; CI never hits the
network and runs against recorded completions.

The test that will catch the subtlest regressions is the **cache assertion
harness** (§17): a deterministic tokenizer + provider cache simulator asserting
which prefix ranges survive each event type. D5 breakage shows up there and
essentially nowhere else.

## Workspace context

This repo lives inside the `rpm` umbrella workspace (`/Users/danielbyrne/GitHub/rpm`)
alongside MoveEarth, ios-field-app-api, MoveEarthWeb, and em-net30, but shares
no code or data with them — it is an independent tool, not part of the RPMX
field-operations ecosystem. The workspace `CLAUDE.md` and the federated graft
graph currently list only those four projects; this one is a fifth, unindexed
repo. Graft and Linear MCP servers are enabled here via `.claude/settings.local.json`.
