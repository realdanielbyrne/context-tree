# context-tree

Reorganize an agent's linear conversation trace into a **summary-headed tree**,
so a long-running or resumed session sees branch summaries instead of raw
history — and pulls detail back on demand through MCP tools.

An agent working a real task (fix bug → edit 3 files → run tests → open PR →
address review) produces a linear token stream that degrades both context
quality and cost. context-tree turns that stream into a tree of
semantically-segmented branches, each headed by an LLM summary:

1. The **active branch** is expanded in full; every other branch appears as a
   summary only.
2. Summaries carry **rehydration pointers** — node ids, file spans, symbols,
   tests, ticket/PR ids — so the model can fetch a non-active branch on demand.
3. Prompt assembly is **prefix-stable**: summaries live in the cached prefix,
   mutable detail always at the tail.
4. Updates are **incremental**: appending a turn touches one leaf, and only the
   summaries on its ancestor path are recomputed.

Everything is derived deterministically from an immutable trace log, so the
segmentation algorithm can change without a data migration.

No fine-tuning anywhere. Every behavior is prompt + tool-schema driven on hosted
frontier models.

## Packages

| Package | What |
|---|---|
| `@context-tree/core` | trace log, blob store, segmenter, tree store, summarizer, prompt assembler, retrieval |
| `@context-tree/mcp` | the four agent-facing tools over stdio MCP |
| `@context-tree/cli` | `init` / `import` / `rebuild` / `render` / `summarize` / `tree` / `eval` |

## Quick start

```bash
npm i -g @context-tree/cli
cd your-project
context-tree init                     # wire the MCP server into your host's config
context-tree import ~/session.jsonl --from-claude-code
context-tree summarize                # spend tokens once, get the tree headings
context-tree render                   # human-readable outline of the tree
```

`init --host print` writes nothing and shows what it *would* do — use that first
if you'd rather not have your host config touched.

## The tools

The agent never sees the storage. It sees tools, and a system-prompt contract that
tells it when to reach for them. Retrieval:

| Tool | Signature | Behavior |
|---|---|---|
| `fetch` | `{branch_id, depth?, file?}` | Branch content. `file` narrows to one file node — the common case, since a verification phase usually needs one file from implementation. Appended to the transcript tail; never mutates the tree or the cache prefix. |
| `search` | `{query, kind?}` | Ranks branches by collapsed-tree retrieval over summary vectors (beam search over summary text when embeddings are absent), then returns the best-matching **events** across them — each with its `seq` and a `retrieval.excerptChars` excerpt of its own text, `retrieval.eventHits` of them. A hit is a payload; fetch only when the excerpt is not enough. |
| `peek` | `{node_id, max_chars?}` | A cheap excerpt for relevance checking — suspicion costs one small call, not a full expansion. |
| `annotate` | `{node_id, text, link_to?, link_kind?}` | Write side: adds a lateral link and/or a note. A review-phase discovery can mark an implementation branch `superseded_by` a later one. |

The pipeline itself is tools too, so an agent can manage its own context and a host
plugin can drive each stage — or skip one — instead of calling a black box:

| Tool | Behavior |
|---|---|
| `units` | The units in the session (one per work phase): size, evicted?, protected by the recency anchor? |
| `classify` | Which units have drifted away from the current work. |
| `evict` | `{window_tokens, anchor?, weights?, dry_run?, …}` — evict the least valuable units to fit. Sticky until restored; nothing is lost. |
| `restore` | `{node_ids? \| all?}` — bring evicted units back. |
| `reduce` | `{node_id, budget_tokens, reducer?, query?}` — one unit shrunk to a budget. |
| `assemble` | What a limit would do to the prompt, without doing it. |
| `verdicts` | HTTP only, for host plugins: keep / drop / fold per host message. |

Both transports serve one registry over one session: MCP stdio for the agent, and
`context-tree-mcp --http <port>` (`GET /v1/tools`, `POST /v1/tools/<name>`) for a
plugin that sits in the prompt path. Server defaults for every tunable come from
`CT_CT_*` environment variables; each is also a tool argument.

## Configuration

`context-tree.config.json` in your project root. API keys come from the
environment **only** — never from this file.

```jsonc
{
  "root": ".context-tree",
  "leafModel": "claude-haiku-4-5-20251001",   // cheap, parallel, high volume
  "rootModel": "claude-sonnet-5",             // one strong call over the leaves
  "embedModel": "voyage-3-lite",
  "provider": "anthropic",                    // anthropic | openrouter | mock | recorded
  "mode": "tool-backend",                     // or "middleware" — see §9.2
  "toolPhase": { "Bash": "verification" },    // remap your harness's tool names
  "neutralPhases": ["other"],
  "budgets": { "zoneB": 8000, "zoneC": 30000 },
  "costCapUsd": 5.0
}
```

`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `VOYAGE_API_KEY`.

### Tool → phase mapping

Segmentation reads structure that agent traces already carry: a tool's *kind*
tells you which phase of the task it belongs to. Tool names differ per harness,
so the map is config-remappable, and an unmapped tool becomes `other` — never a
crash.

`other` is *neutral* by default: it attaches to the open phase rather than
opening a new one. Without that, a trace where reads and greps dominate — which
is every real trace — degenerates into dozens of one-event phases. Set
`"neutralPhases": []` for strict per-tool phase changes.

## Development

```bash
pnpm install
pnpm vitest run <path>          # targeted — the local default
pnpm vitest run                 # full suite = CI's
pnpm typecheck
pnpm build
```

Tests never hit the network. Live-model tests are opt-in with `LIVE=1` plus an
API key; CI runs against recorded completions.

## Design

`docs/ARCHITECTURE.md` is the map; `IMPLEMENTATION_PLAN.md` is the authority —
it carries the decision record (D1–D15) with rationale and citations. The three
boundaries worth knowing before you edit anything:

- **Ingestion is hermetic.** The mandatory pipeline reads only the trace log,
  the blob store, and tree-sitter. No graft, no Serena, no network. Semantic
  enrichment is a separate, optional, discardable post-pass.
- **tree-sitter is span extraction only.** Parse the post-edit blob, map diff
  hunks to minimal enclosing named nodes. Broken WIP files must still yield
  spans — that error tolerance is the whole reason it's there.
- **The prompt layout is fixed; only content migrates.** Zone A (frozen system +
  tool schemas) → Zone B (summaries in creation order) → Zone C (active branch
  detail). Zone B is never relevance-ordered: reordering the cached prefix is
  the cache killer, and relevance is expressed by expansion in Zone C.

## Prior art

Built on published work, with the gaps named explicitly:
[RAPTOR](https://arxiv.org/abs/2401.18059) (hierarchical summary trees),
[MemGPT](https://arxiv.org/abs/2310.08560) (self-paged memory via function calls
on untrained models), [A-MEM](https://arxiv.org/abs/2502.12110) (note linking
and memory evolution), [MIRIX](https://arxiv.org/abs/2507.07957) (typed memory
tiers), [Sleep-time Compute](https://arxiv.org/abs/2504.13171) (offline
precompute), [ContextPilot](https://arxiv.org/abs/2608.28476) (learned edit
policies — this system is its zero-shot baseline).

What the literature doesn't cover, and this project does: deterministic
segmentation of *tool traces* rather than content clustering; incremental
consistency on append rather than batch rebuild; and a session-resumption
benchmark for coding agents, since LOCOMO-style QA never asks whether a fresh
agent can resume a task from the tree alone.

## License

MIT
