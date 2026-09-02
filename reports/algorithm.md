# The context-tree algorithm — reference description

This is the one document that states the algorithm as it currently runs. Judges
count the pseudo-code lines here against the program's simplicity budget
(twelve lines, set before loop 1); implementers change the code and then this
page in the same change; every new finding that alters a line is recorded in the
change log at the end. The file is `reports/algorithm.md`; the markdown is the
canonical form.

Terms used below. **L0** is the append-only event log (`trace.jsonl`). **L1** is
the SQLite tree of nodes that reference L0 by sequence-number spans and hold
versioned summaries. **L2** is the content-addressed blob store for payloads.
**Zone A / B / C** are the three fixed sections of every prompt: the frozen
contract and tool schemas, the summaries in creation order, and the active
branch's raw detail. A **phase** is a run of events classified by the tool that
produced them; a closed phase becomes a **leaf**; the leaves' parent is the
**root**. The **window** W is the model's context size. The **lazy budget** T is
the prompt size below which the tree summarizes nothing.

## Pseudo-code (12 lines, all in force)

```
 1  on each event: append to L0; payload → L2; the edit-tool's args are capped at 512 B once the post-state blob exists
 2  segment L0 in one deterministic pass: tool name → phase (config-remappable; unknown → other); a closed phase is a leaf with span coordinates only
 3  DEVOLVED while last prompt's real tokens < T and not yet crossed:  Zone C := whole trace, Zone B := ∅, summarize nothing
 4  the crossing is one-way: once real tokens ≥ T, latch (L0 only grows, so the whole trace never fits again)
 5  after the crossing: summarize closed leaves in parallel on the cheap model (cap 8), versioned, with rehydration pointers; staleness cascades up the ancestor path only
 6  root := deterministic composition of leaf headlines; keep the newest rootKeep headlines, fold older ones to one line each
 7  assemble prompt = Zone A (frozen; schemas travel as the API tools param, not as text) → Zone B (root + branch summaries, creation order, capped) → Zone C (open phase, else latest branch, else root)
 8  never reorder Zone B; tool results and the completion nudge are appended as L0 events after Zone C, so the cached prefix survives
 9  budgets derive from W: zoneB, zoneC, T are fractions of W divided by the measured heuristic→BPE ratio
10  context_search(query) ranks over summary text (lexical beam; vector once L3 exists) and returns node ids with snippets
11  context_fetch(id, depth=summary|full, file?) returns a branch's summary or its raw events; context_peek(id) returns a raw prefix; annotate records a note
12  the contract in Zone A states the trigger for those tools, not the mechanics; there is no learned policy anywhere
```

## Where each line lives

| Line | Code | Decision / gate | Established by |
|---|---|---|---|
| 1 | `packages/core/src/trace/`, `blobs/`; `packages/core/src/assemble/format.ts:128` (`ARGS_CAP_WITH_BLOB = 512`) | D-storage layering; v5.9b | loop 7: capped args beat dropped args (dropping forced re-verification, sw-1 turns 13→25) |
| 2 | `packages/core/src/ingest/` segmenter; `context-tree.config.json` `toolPhase` | §7, D15 (hermetic ingestion) | M0–M2; loop 9 added 8 tool→phase entries so `unmappedTools` is empty |
| 3 | `eval/src/loop.ts` ~761–775 (`EVAL_LAZY_TOKENS`, `lastPromptTokens`, `belowLazyBudget`) | v6.0 token gate; **item 1 (2026-09-02): real tokens replace chars÷4** | loop 7 (v6.0/6.1 identical, zero crossings); loop 9b: chars÷4 undercounted 13–31% on sw-5/sw-6 and never fired; with real tokens it fires on 6/6 runs and the curve flattens 35–39% below the loop-8 tree, but total tokens rise 22–35% because a 30k absolute switch forces a transition a 200k model does not need — see the single-derivation candidate |
| 4 | `eval/src/loop.ts` (`lazyCrossed`) | **item 1 latch (2026-09-02)** | first live crossing oscillated (40k → <30k → 43k, 2× cost); test "the crossing is one-way" |
| 5 | `packages/core/src/summarize/summarizer.ts` (concurrency, versioned `node_summaries`) | §8, D3, D4 | M3; loop 6–7 truncation-retry bounding |
| 6 | `packages/core/src/summarize/compose-root.ts:72–88` (`composeRootSummary`, `rootKeep`) | v5.7 det-root; D17 fold; `EVAL_ROOT_KEEP=40` (v6.5 candidate) | loop 7: root model call deleted; loop 8: fold fires without flail |
| 7 | `packages/core/src/assemble/assembler.ts:135–140`; `eval/src/loop.ts` ~909–935 (`activeNodeId`, `EVAL_NO_ATOOLS`) | D5, §10, D18 caps | loop 7: schema text was a 1.1k-token/turn duplicate |
| 8 | `eval/src/loop.ts` ~792 (`EVAL_FETCH_EVENTS`) | D5; v5.8 | loop 7: the "ephemeral tail" was never dropped and one fetch was re-billed for 12 turns |
| 9 | `eval/scripts/transplant.mjs` `deriveBudgets` — **transplant harness only**; the live harness still takes absolute values (`--zone-b-budget`, `--zone-c-budget`, `EVAL_LAZY_TOKENS`) | D19 | loop 9 transplant judge: the hand-tuned constant removed as a rule there; reconciling the live harness to the same derivation is an open item |
| 10 | `packages/mcp/src/tools/context-search.ts`; `packages/core/src/retrieve/retriever.ts` (`search`, `beamSearch`, `embedSummaries`) | §9, §9.1 | loop 8 probe validated lexical search; **loop 9b: no embedder or provider registry is wired in the shipped server or the harness — every measured search was lexical** |
| 11 | `packages/mcp/src/tools/context-fetch.ts`, `context-peek.ts`, `annotate.ts`; `retriever.ts:188–269` | §9 (exactly four tools) | loop 9b: drill-down exists through `meta.node_ids`; no children listing, no sub-range, peek is prefix-only |
| 12 | `packages/core/src/prompts/system-contract.v1.md`, `packages/core/src/prompts/index.ts` | §14, D7 | loop 9b item 3: contract v2 (one section deleted) runs as a flagged arm, v1 stays default |

## Simplicity rule

The program's standing constraint, set by the owner before loop 1 and restated on
2026-09-02: the algorithm stays simple, with no special conditions that are
fragile and can break. Rule-removal beats rule-addition; a candidate that replaces
a rule outranks one that adds a trigger. The lines below are audited for
conditions each time this page changes:

| Line | Condition it carries | Status |
|---|---|---|
| 1 | "capped once the post-state blob exists" | one condition, evidenced (uncapped and dropped both measured worse in loop 7); keep |
| 3–4 | the crossing itself, plus the latch | the latch is a proof (L0 only grows), not a heuristic; keep |
| 7 | "open phase, else latest branch, else root" | a three-way fallback: the segmenter closes every phase on re-ingest so `openPhase()` is always null in the live harness and the first branch of the chain never fires; **candidate for deletion** |
| 10 | "lexical beam; vector once L3 exists" | a silent mode switch on the presence of embeddings; becomes a single path once an embedder is always wired |

## Configuration parameters

Values that may need to be set differently for a model, a window size, or a host
harness. Every one is listed with where it is set and what it depends on, so a
port to a new model or harness starts from this table rather than from the code.

| Parameter | Current value | Set where | Depends on | Notes |
|---|---|---|---|---|
| T, lazy budget | 30,000 tokens (live); `0.35·W ÷ ratio` (transplant) | `EVAL_LAZY_TOKENS`; `deriveBudgets` | window W, tokenizer | live value is absolute and should become the W-derived form (line 9) |
| rootKeep | 40 | `EVAL_ROOT_KEEP`; `compose-root.ts:32` | trace length, Zone B budget | v6.5 candidate; the transplant chooses the largest rung whose assembled Zone B fits (R5) |
| Zone B budget | 8,000 tokens (live); fraction of W (transplant) | `--zone-b-budget`; `deriveBudgets` | window W | |
| Zone C budget | 30,000 tokens (live; unbounded while devolved); fraction of W (transplant) | `--zone-c-budget`; `deriveBudgets` | window W | v6.4: devolved mode passes `Infinity` |
| heuristic→BPE ratio | 0.851 (measured on s1, cl100k) | `measureRatio` in transplant | tokenizer family, corpus | re-measure per model family; the assembler counts with a heuristic, the provider bills BPE |
| summarize.concurrency | 8 | `context-tree.config.json` | provider rate limits | |
| summarize.maxSummaryTokens | 1,024; up to 3 doublings on truncation | config; `summarizer.ts:90` | summary model | |
| leaf summarizer model | claude-haiku-4-5 (anthropic) / anthropic/claude-haiku-4.5 (openrouter) | config `leafModel` | cost tiering | plan: move to a flash model from scenario s2 onward; never switch mid-scenario |
| root summarizer model | none (deterministic composition) | config `rootModel` is dead since v5.7 | | delete the knob (open item 3 from loop 7) |
| embed model / dim | `voyage-3-lite` / 512 (dead defaults; nothing wired) | config `embedModel`, `embedDim` | provider | to be replaced by an OpenAI-compatible client; sqlite-vec takes the dimension from the first vector |
| retrieval.limit | 20 | config | window W (each hit carries its full summary text today) | at W=16k the search payload alone overflowed headroom; snippet-only results are a pending candidate |
| retrieval.providers | graft, serena, augment, vector, grep | config | host | none of them is wired in the shipped server or the harness |
| peek size | 2,000 chars (tool default) / 800 (retriever default) | `context-peek.ts:15`, `retriever.ts:49` | | two defaults for one thing; reconcile |
| list caps (D18) | 40 values per rendered list | `format.ts:38` | Zone B budget | |
| edit-args cap | 512 B when a post-state blob exists | `format.ts:128` | | |
| tool→phase map | 8 entries in `context-tree.config.json` | config `toolPhase` | **host harness** (tool names differ per harness) | unknown tool → `other`, never a crash |
| contract version | v1 default; v2 = v1 minus one section | `EVAL_CONTRACT_VERSION` | model (how much instruction it needs) | item 3 arm |
| agent model | claude-sonnet-5 (live suites); qwen-2.5-72b, gpt-3.5 (transplant) | `--model` | | models must pass a one-call tool-use probe before entering a scored grid |
| max turns / time cap | 40 / 900 s (short suites); 80 / 1,800 s (long); 6 turns (transplant) | `--max-turns`, `--time-cap-ms`; `MAX_TURNS` | task length | the transplant's 6 is a gathering cap under review |
| reply cap (transplant) | 800 tokens | `MAX_REPLY_TOKENS` | window W | |
| shipping gate set (v6.x) | `EVAL_NATIVE_CACHE EVAL_ZONEC_LATEST EVAL_SUMMARIZE_ON_CLOSE EVAL_ZONEC_CACHE EVAL_DET_ROOT EVAL_NO_ATOOLS EVAL_FETCH_EVENTS` all =1 | env | | these are the algorithm; promoting them to defaults is roadmap item 4 (gated on the checkpoint report) |
| retired gates | `EVAL_LAZY_K`, `EVAL_DSA_V6`, `EVAL_SUMMARY_DEDUP` | env | | delete from code when item 4 lands |

## Line budget ledger

| When | Change | Lines |
|---|---|---|
| Loop 1 start | budget set: the algorithm must fit in twelve lines | 12 |
| Loops 5–7 | branch-count k → token budget (replacement); root model call → deterministic composition (replacement); Zone A schema text deleted; ephemeral tail deleted | 12 |
| Loop 9 kickoff (transplant judge) | budgets derived from W (line 9) replaces the hand-tuned constant | 12 |
| 2026-09-02 item 1 | chars÷4 → real tokens (line 3, replacement); latch added (line 4, **+1**, absorbed by merging the old "Zone C is the whole trace / Zone B empty" statement into line 3) | 12 |

The count is at the limit. Any candidate from the loop-9b design panels that adds
a line must name the line it replaces.

## Candidates with a judge verdict (not yet in force; each runs as its own arm)

- **Raw by default** (item 2, judge A, arm `tree-slice`): `context_fetch` returns raw events by default, aimed by an inclusive sequence range, with `depth:'index'` listing events; summaries stay reachable by asking. Replaces line 11's "summary or raw" with "raw, sized to fit". Grounds: none of the twelve answer literals occurs in any summary text or metadata, so the current default is a guaranteed zero on verbatim questions.
- **Search hits are coordinates** (item 2, arm `tree-thin`): a hit carries a 240-character snippet and pointer metadata, not the full summary. Changes line 10's return value only. Grounds: at a 16k window the search payload alone overflowed headroom in 8 of 15 runs.
- **Contract v3** (item 2, arm `tree-verbatim`): rule 2 replaced by "a summary can never tell you what it said; fetch at full depth before stating a number, identifier or quote", and the sentence preferring `file`/`peek` over a branch fetch deleted. Line 12, one rule replaced, one removed.
- **Semantic ranking** (item 2, arm `tree-semantic`, conditional on an offline rank check): an embeddings client so line 10's vector path runs. No line change.
- **Completion-gate removal** (item 3, arm `no-gate`) — **measured null and retired** (2026-09-02, n=5 same-epoch: paired turn deltas +2, +3, −2, +3, −1; the gate stays because it rescued 23 runs elsewhere). The same batch corrected the sw-3 headline: the tree runs 1.71× native on tokens same-day, not the 3.4× of the cross-day comparison, with equal median turns.
- **Contract v2 trim** (item 3, arm `tree+v2`) — **measured null and retired** as a live candidate; it moved turn counts (0, +2, +3, −2, +6), so the deleted section was not behaviourally inert.
- **One budget derivation** (from the 2026-09-02 runs): delete the live harness's absolute 30,000-token switch and derive it from W as the transplant does; set the switch equal to the Zone C fraction as line 3 already states. Line 9 becomes true of both harnesses.
- **Dropped:** `tree-active` (pre-filling Zone C with the newest branch) — headroom was not the constraint, and it hands the tail stratum its answer by construction.

## Change log

- **2026-09-02 10:20** — item 3 measured same-epoch at n=5: sw-3 gap corrected to 1.71× native; completion-gate removal and the contract trim both null and retired; batching-density hypothesis refuted (p = 0.81). No line changes.
- **2026-09-02 09:35** — item 1 measured at n=3 (long-v65-gate): gate fires, curve flattens, final context not below native, total tokens up; evidence row for line 3 updated.
- **2026-09-02 09:30** — judge verdicts for items 2 and 3 folded into the candidates section; `tree-active` recorded as dropped; the single-derivation candidate for the budget switch added after the first live crossings cost more than they saved on a 200k model.
- **2026-09-02 09:20** — simplicity audit and configuration-parameter register added at the owner's request ("simple algorithm without special conditions that are fragile"; "configuration parameters that might need to be tweaked to fit a particular model or harness should be tracked"). Line 7's fallback chain flagged as a deletion candidate.
- **2026-09-02 09:15** — document created. Lines 3 and 4 reflect item 1 (real-token
  gate + latch) landed this morning; first live crossing observed on sw-5-dozen at
  turn 8. Loop-9b analysis (`eval/plans/loop9b-analysis/`) recorded against lines
  10–12.
