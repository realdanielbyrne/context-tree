# Top-k Context Filtering vs the Tree — DSA-Arm Experiment Report

**Date:** 2026-09-01
**Scope:** `context-tree/eval` (`@context-tree/eval`) — §15 benchmark harness. Two new swappable arms (`dsa`, `tree-dsa`), one core assembler extension (`selection.keepBranches`), three mandated analyze→fix→rerun iteration loops.
**Models:** `claude-sonnet-5` (agent / root summarizer) · `claude-haiku-4-5-20251001` (leaf summarizer) · provider `anthropic`
**Question:** can a DeepSeek-Sparse-Attention-style top-k filter — over *events*, then over *branches* — beat vanilla full-transcript context on the metrics the harness tracks (success, turns, cost, speed, tokens), and can it complement the tree rather than replace it?
**Total live spend:** ≈ $0.55 across all runs below.

---

## 1. Executive summary

Three design loops were run, each analyzing the prior run's results, finding a defect or wrong assumption, fixing it, and re-running:

1. **Lazy summarization** (tree arm): the §8 summarizer was awaited on the critical path every turn — including at start on a 1-event trace and at completion after the final answer existed. Removing those passes made the tree arm **beat vanilla on cost (−48%), speed (−33%), turns (−25%) and tool calls (−33%) at equal accuracy** on the smoke task.
2. **Event-level top-k (`dsa` arm)**: cost-neutral vs vanilla at this scale — token savings were eaten by cache-boundary invalidation and extra reasoning tokens — but consistently **fewer turns**.
3. **Branch-level top-k (`tree-dsa` arm)**: implemented, tested, and verified harmless below k (the floor property fires: prompt is byte-identical to the plain tree when branches ≤ k) — but **selection never engaged on any real run** because phase-merging keeps branch counts at or below k=3 even for a 13-tool-call task.

The iteration process itself was the biggest producer of value: it surfaced and fixed **two harness defects** — a gameable exact-match judge (task text contained the expected answer verbatim) and a **premature-stop failure mode** in the tree arms (bare-text reply ends the run after 1 tool call; the fixed command judge caught context-tree at 0% on a task native passed).

---

## 2. Baseline and the lazy-summarization fix (loop 1)

Test: `deepswe-agents-last-exam/smoke-1`, 1 scenario × 2 arms per run.

| Run | Change | vanilla | context-tree |
|---|---|---|---|
| iter0 | baseline | 100%, 3 turns, 6.2s, $0.0092 | 100%, 2 turns, 22.7s, $0.0297 |
| iter1 | root summarizer → haiku (config only) | — | 100%, 4 turns, $0.0429 ❌ worse |
| iter2 | lazy summarize: only after ≥8 new events | — | 100%, 3 turns, 13.9s, $0.0206 |
| iter3 | drop the end-of-run summarize pass | — | 100%, 3 turns, 13.9s, **$0.0061** |
| iter4 | confirmation, both arms | 100%, 4 turns, 7.7s, $0.0121 | 100%, 3 turns, 5.1s, **$0.0063 (−48%)** |

**Diagnosis that drove it:** turn-level data showed agent turns at ~1.8s while wall time was 22.7s — ~85% of wall and ~70% of cost was the summarizer (sonnet root passes ≈ $0.01 each) being awaited (a) at start on a one-event trace, (b) after every turn, and (c) at completion, after the final answer existed.

**Design change** (`eval/src/loop.ts`): summarize only once ≥8 new events have accumulated (`SUMMARIZE_MIN_NEW_EVENTS`); never at start; never at end-of-run — refreshing the tree for a hypothetical next resumer is D11 sleep-time compute (`scheduleSummarize`), and charging it to the run bills maintenance as task work. iter1's lesson is recorded: downgrading the root summarizer *without* moving it off the critical path made things worse (4 turns vs 2).

Note on the remaining line vanilla "wins": raw total tokens (4,720 vs 15,392) — but 14,364 of the tree's are cache-reads billed ~10× cheaper, which is why USD flips to the tree.
## 3. Event-level top-k: the `dsa` arm (loop 2)

**Design:** vanilla's full transcript, but each turn only the top-k events are injected — `score = w_role + α·recency + β·(lexical overlap with the task)`, selected events re-emitted chronologically, the context head (system + task message) never re-selected so the provider cache prefix is stable, and the latest turn's tool results pinned (the investigate-1 lesson: an agent that can't see its own last action loops).

| Iteration | Finding | Fix applied |
|---|---|---|
| dsa-iter1 (smoke-1) | DSA ≈ vanilla ($0.0092 vs $0.0096) — but the transcript never exceeded k, so **the selector never fired**; the run measured nothing | Added a long probe task (`dsa-1-shopping-list`, 8 steps); `--limit 3` |
| dsa-iter2-long | Filtering active: DSA **worse on cost** ($0.0262 vs $0.0243) despite fewer input tokens/turn; better on speed (−35% wall) and turns (5 vs 6); both 100%. Also: my unit test asserting relevance-beats-recency had k too loose to ever evict — the test shared the wrong assumption | Tightened the test (k must force an eviction); added `DSA_MIN_TAIL = 10` eval floor — below it, pass through untouched |
| dsa-iter3-floor | Long task: DSA matched vanilla cost within noise ($0.0225 vs $0.0222) in **3 turns vs 4**, 100% each | — |

**Why cost stayed neutral:** every per-turn re-selection moves the cache boundary backwards, and the model spent the saved input tokens on extra output reasoning over a gappy history (+36% output tokens). At ~5–8k-token transcripts there simply isn't enough fat to pay the re-selection toll. The consistent win was **turns** — a tighter context made the model commit to multi-action batches (6 tool calls in one turn on iter3).
## 4. Branch-level top-k: the `tree-dsa` arm (loop 3)

**Design:** DSA over *branches* instead of events — top-k branch summaries kept in Zone B, `score = α·recency + β·task-relevance`, root and active branch exempt, membership-only selection (creation order preserved → prefix stability per the assembler's rule 1), and the floor property: **branches ≤ k ⇒ `undefined` ⇒ byte-identical to the plain tree arm**.

**Implementation:** `AssembleOptions.selection.keepBranches` added in core (`contracts/assemble.ts`, honored in `zoneB()` before budget accounting — selection is a relevance decision, rule-4 budget dropping stays the overflow valve). The eval `tree-dsa` arm hangs a selector off a new `selectBranches` seam in `runTreeArm` — no forked loop.

Probe task: `branch-1-five-cycles` (5 write+read cycles, designed to grow ~10 branches).

| Iteration | native | context-tree | tree-dsa | Defect found → fix |
|---|---|---|---|---|
| branch-iter1 | ✅ $0.028 / 7t | ✅ $0.077 / 3t | ✅ $0.0055 / 2t | **Too good.** exact_match answer appeared verbatim in the task text — tree-dsa passed having made **1 tool call**. → scenario moved to a `command` judge that checks all five files in the sandbox |
| branch-iter2 | ✅ $0.033 / 8t | ❌ **false completion** (1 tool call, $0.005) | ✅ $0.072 / 3t | **Premature-stop failure mode** in tree arms: any bare-text reply ends the run; native's growing transcript implicitly suppresses it, the thin early tree prompt doesn't. Also no selection telemetry. → completion gate + stderr telemetry |
| branch-iter3 | ✅ $0.030 / 8t | ✅ $0.063 / 7t | ✅ $0.113 / 6t | Telemetry showed **selection never fired**: `all N branches (within k)`, N ≤ 3 every turn |

**Completion gate** (both tree arms): the first bare-text reply after tool work gets an ephemeral "confirm or continue" nudge; only a *second* consecutive bare-text reply completes. Costs one cheap cached turn exactly when the failure mode would fire. Context-tree went 0%→100% on this task.

**Why selection never fired — the honest negative result:** the segmenter merges consecutive same-type tool calls into one phase (§7), and the model batched 6 calls in turn 0, so a 13-tool-call task produced only ~3 branches. The k=3/10-branches scenario needs heterogeneous phase *alternation* at a granularity models don't naturally produce. At real branch counts, k=3's floor correctly makes tree-dsa identical to the plain tree — the "don't hurt short problems" property worked exactly as specified, verified live. And cost was again dominated by the summarizer (≈$0.01/sonnet root pass, visible as ~1k cache-write tokens per turn), which branch pruning doesn't touch.

## 5. Defect ledger (what the iteration loop actually caught)

| # | Defect | Caught by | Fix |
|---|---|---|---|
| 1 | Summarizer awaited on critical path at start / every turn / end-of-run | turn-level latency vs wall time | lazy threshold + no end-of-run pass (loop 1) |
| 2 | Root summarizer on sonnet *while* on critical path | iter1 regression ($0.030→$0.043) | reverted; cheaper-model experiments belong after off-path scheduling |
| 3 | First DSA run measured nothing (transcript ≤ k) | identical token counts across arms | long probe task + `DSA_MIN_TAIL` floor |
| 4 | Selector unit test with k too loose to evict | test failure on inspection | k tightened so the assertion is real |
| 5 | exact_match judge gameable — answer in task text | tree-dsa "winning" with 1 tool call | `command` judge verifying sandbox state |
| 6 | Tree-arm premature stop after 1 tool call | honest judge: context-tree 0% | completion gate (second consecutive bare-text reply required) |

## 6. Current state of the code

- `packages/core/src/contracts/assemble.ts` — `AssembleOptions.selection?: { keepBranches?: ReadonlySet<NodeId> }` (structurally typed to avoid an import cycle).
- `packages/core/src/assemble/assembler.ts` — `ZoneBSelection`; `zoneB()` filters selected-out branches before budget accounting.
- `eval/src/loop.ts` — lazy-summarization policy; `runDsaArm` + `selectTopKMessages`; `selectTopKBranches` + `makeTreeDsaSelector`; `selectBranches` seam in `runTreeArm`; completion gate; `[tree-dsa]` selection telemetry.
- `eval/src/types.ts`, `eval/src/run.ts` — arms: `native`, `context-tree`, `dsa`, `tree-dsa`.
- `eval/test/loop.test.ts` — 6 new selector/gate tests (floor pass-through, stable head, pinned tail, relevance-beats-recency, chronological order, first-reply completion with no tool work).
- `eval/scenarios/deepswe-agents-last-exam/` — added `dsa-1-shopping-list` (exact-match) and `branch-1-five-cycles` (command judge).
- **Tests:** 49/49 eval suite, 518+9 skipped across core+eval — all green.
- **Results:** `eval/results/iter{0,1,2,3,4}-*/`, `eval/results/dsa-iter{1,2-long,3-floor}/`, `eval/results/branch-iter{1,2,3}/`.

## 7. Answers to the questions posed

**Does event-level DSA beat vanilla?** Not at this scale — cost-neutral at best, because re-selection breaks the cache prefix and the model reinvests the savings in reasoning tokens. It does reduce turns. Expected to pay off only on long, noisy transcripts where vanilla's full-fare input dominates (k bounds growth; vanilla's doesn't).

**Does branch-level DSA complement the tree?** Mechanically yes — it slots into Zone B as a membership filter with prefix stability and a strict floor, and costs nothing when it can't help. But the branch axis is too coarse at natural branch counts: phase-merging means even long tasks yield ~3 branches, so k=3 never prunes. The tree's existing rule-4 (drop oldest summaries over budget) already covers the overflow case branch-DSA was aimed at.

**Where the leverage actually is:** not selection, but (a) *when* summarization runs (lazy/off-critical-path was worth −48% cost) and (b) *what model* does it — once passes are rare and off-path, a haiku root summarizer is nearly free savings (iter1 failed only because summarization was still on the critical path).

## 8. Next steps

1. **Stress the floor upward:** a task written to force heterogeneous phase alternation (read→write→test→read→write→test across ≥4 cycles) should grow >k branches and finally exercise `selectTopKBranches` live; verify prefix stability via cache-read tokens turn-over-turn.
2. **Cheaper root summarizer, revisited:** with passes now rare and threshold-gated, retry `--root-model claude-haiku-4-5-20251001` — expect most of the remaining tree-arm cost gap to close.
3. **Long-horizon benchmarks:** HLE-tools or terminal-bench tasks with 30+-event traces, where vanilla's per-turn full-fare input dominates and k's bound matters. The dsa arm's floor and the tree-dsa floor mean both are safe to leave in the matrix.
4. **Sleep-time summarization (D11):** replace the threshold policy with `scheduleSummarize` + `drain` so summaries are ready before the next turn without blocking it — the design already has the queue; the harness just doesn't use it.
5. **Statistical honesty:** all runs above are n=1 per arm; model sampling moved turn counts by ±2 between identical configs (iter1 vs iter0). Any decision-grade comparison needs `--seeds`-style repetition (the `eval-resumption` harness already has this; the `eval` harness does not).
6. **Judge hygiene:** prefer `command` judges for anything with side effects; `exact_match` only when the answer string cannot appear in the task text.
