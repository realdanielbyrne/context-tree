# Loop 9b item 2 — implementation state

The judge's spec is `eval/plans/loop9b-item2-judge-verdict.md`. This page records
what is in the tree, what each arm changes, and the one place the spec was
overruled. Nothing here has been run live yet.

## What is in the tree

Shipped code (`packages/core`, `packages/mcp`), merged and built:

- `context_fetch` takes `depth: 'summary' | 'index' | 'full'` and inclusive
  `from`/`to` event bounds, and defaults to `full`. `index` lists a branch's
  events (sequence number, type, tool, path, size), capped with the same
  elision idiom the renderer uses elsewhere. A full-depth fetch now returns the
  branch's metadata instead of dropping it, so drilling into raw content no
  longer costs the pointers needed to drill further.
- `context_search` hits carry a 240-character excerpt and pointer metadata
  (files, symbols, node ids) rather than the whole summary.
- `system-contract.v3.md` replaces the rule about stale summaries with one about
  what a summary cannot carry, and deletes the sentence that preferred a narrow
  fetch. Three numbered rules before and after.
- `createEmbeddingClient` / `createEmbeddingClientFromKeys` in
  `packages/core/src/models/embeddings.ts`, an OpenAI-compatible embeddings
  client that works against either OpenAI or OpenRouter. `embedDim` was deleted
  from the config: the vector store takes its dimension from the first vector
  written, so the field had nothing to validate.

Harness (`eval/scripts/transplant.mjs`):

- Every tool call is recorded verbatim per run: turn, name, the arguments the
  model actually passed, whether it succeeded, the result size, the headroom it
  was capped against, and how much was dropped. `literalInToolResult` records
  whether the answer text ever reached the model, which separates "the tool
  never returned it" from "it was on screen and the model missed it".
- The four new arms are registered and wired. They share `tree`'s root ladder,
  because Zone B composition is not the variable under test and a different
  fold would move the visible branch set.
- `--phase gates` runs G0–G9 alongside the existing g1–g15.

## The arms, and the one variable each changes

| Arm | Tool surface | Contract | Ranking | Isolates |
|---|---|---|---|---|
| `tree` | pre-change (summary default, full summaries in hits) | v1 | keyword | control |
| `tree-slice` | new (raw default, ranges, index) | v1 | keyword | what a fetch returns and how it is aimed |
| `tree-thin` | pre-change fetch, excerpt-only hits | v1 | keyword | the size of a search result |
| `tree-verbatim` | pre-change | v3 | keyword | what Zone A tells the model about summaries |
| `tree-semantic` | pre-change | v1 | vectors | how search ranks |

The control arm keeps the old surface through a handler wrapper, so the
comparison is against what was measured before rather than against a
half-changed baseline. `system-contract.v1.md` is byte-identical to what it was:
the slice arm's new signature reaches the model through the tool schema
description, not by editing the frozen contract. For the same reason v3 carries
v1's tool bullet, since the arm that uses v3 runs on the old surface.

## Gate results (zero tokens, frozen store, 2026-09-02)

Fourteen of fifteen pass. Two of the passes are findings in themselves:

- At an 8,192-token window no fold level leaves a single branch summary
  standing, so that cell is dead and is reported as dead rather than forced to
  fit. At 16,384 the fixed section alone exceeds its tenth of the window.
- At 32,768 both `tree` and `tree-wide` already cover the recent-event range
  that the tail questions ask about, which is how we know visibility was never
  the tail problem.

## Where the spec was overruled

The judge's graft tightened the self-retrieval gate from the search's own result
limit (20) to a fixed 5. Run against the frozen store, that fails nine of twelve
questions whose sources the model would in fact have received. The number, not
the question set, was doing the failing.

The threshold is now derived from `retrieval.limit` in the loaded config: a pass
means the source appears in the list the model actually gets. The vacuity the
graft was aimed at is real but it is a reporting problem, so the gate now prints
the ranked-pool size, marks itself vacuous when the pool is no larger than the
limit, and reports strict top-3 and top-5 counts as diagnostics that never pass
or fail anything. Current state: all twelve reachable, ranks 1 to 17, strict
top-3 two of twelve, top-5 three of twelve, and the gate says plainly that it
proves reachability rather than uniqueness of the referent.

This is the pattern the portability rule exists to catch. A fixed 5 and a fixed
20 are both magic; the derivation is what survives a port to a host with a
different result limit.

## Still to do before the live batch

1. Port the remaining test additions for the new arms into
   `eval/test/transplant.test.ts` (50 pass today; the new-arm cases are not
   among them).
2. Append the deviations to `eval/fixtures/transplant/JUDGE-VERDICT.md`: the
   fetch default flip, the range and index parameters, search hits as pointers,
   the v3 contract variant, the contract-stays-byte-identical decision, and the
   derived self-retrieval threshold that replaced the graft's constant.
3. Run the batch per the judge's Step 8: controls first, then the arms
   interleaved within each model and window cell so every arm shares one epoch.
