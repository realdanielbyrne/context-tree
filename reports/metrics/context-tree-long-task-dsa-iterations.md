# Long-Horizon DSA — Hidden-Test Task, Vector-Space Selection, Summary Circuit Breaker

**Date:** 2026-09-01
**Scope:** `context-tree/eval` — a DeepSWE-style long task built in-sandbox (`sw-1-jsonc`, hidden grader tests), `judge_files` adapter support, three analyze→improve→rerun iterations of the long-task A/B, a deterministic vector-space branch selector, and a summary circuit breaker.
**Models:** `claude-sonnet-5` (agent / root summarizer) · `claude-haiku-4-5-20251001` (leaf summarizer) · provider `anthropic`
**Live spend this report:** ≈ $2.32 across the three long-task iterations (9 runs, 3 arms × 3).
**Question posed:** why does the tree pay *more* while reducing context tokens — and can selection/grouping move into a cheaper space (embeddings / cosine / KNN / KL) instead of more LLM summarization?

---

## 1. Executive summary

1. **On long tasks the plain tree arm loses on cost** — context-tree averaged **$0.365 vs native's $0.206** (+77%) while tree-dsa **tied native ($0.201) at half the turns (9.3 vs 17)**. All nine runs succeeded (100% accuracy on every arm); cost and turns are the differentiators, not correctness.
2. **The "why more money" answer is three add-backs**, not the context: (a) root summarizer passes at sonnet prices on every lazy-threshold crossing, (b) §8 contract failures billed try+retry — the *same* node was re-billed **3× in one run**, (c) 5–27k cacheWrite tokens per run from prefix invalidation. Fresh input *is* reduced (25–40k vs native's 45–94k); the add-backs exceed the savings at this horizon.
3. **Two design fixes landed:** a deterministic **vector-space branch selector** (idf-weighted TF + cosine relevance + farthest-point diversity — the DSA move with zero embedding-API tokens) and a **per-node summary circuit breaker** (D11 `scheduleSummarize`/`drain`) that stops repeat-failure billing. 58/58 eval tests green.
4. **Honest limits:** the vector-space selector never fired live — branches stayed ≤ k=3, so the floor property held (byte-identical prompt) and iter2's tree-dsa win is floor + variance, *not* the selector. And native itself swung 12→21→18 turns on identical configs: n=1 cannot rank arms.
5. **Next experiments are phased by dependency (§9):** make the mechanism measurable (>k-branch task, seeded repetition), then cut the summarizer cost floor (per-node breaker live-run, **append-only summaries**, cosine dedup, haiku root), and only then run the tree-dsa hyperparameter search (~$10, OFAT + coordinate descent, with a selector-fire guard metric) — tuning before the mechanism fires would re-measure the floor.

---

## 2. Sourcing the benchmark, and the task that replaced it

Upstream datasets were unreachable from this environment: GitHub API/raw returned 404s on every candidate repo name, `git ls-remote` confirmed "Repository not found", the HF datasets API did not resolve usable JSON, and DuckDuckGo served only JS-redirect stubs. Rather than chase mirrors, the harness gained a **faithful in-sandbox equivalent**:

**`sw-1-jsonc`** — a JSON-with-comments loader whose shipped `strip_comments` is a naive regex (`//[^\n]*|/\*.*?\*/` with DOTALL) that strips `//` and `/* */` *inside string values*, corrupting JSON. The agent must write and run its own tests, then fix `strip_comments` so comments outside strings are removed (replaced by one space), inside strings preserved, multi-line block comments handled. Grading is a **hidden test suite** (`hidden_test.py`, 10 cases + an end-to-end example check) written into the sandbox only at scoring time — the terminal-bench contract, now available to JSONL benchmarks.

To make that possible, the adapters gained **`judge_files`** (`eval/src/adapters/util.ts`): a `command` judge may carry hidden files materialized only at scoring time (`judgeFromRow` now attaches them; malformed maps fail loud).

The generator (`eval/scripts/build-jsonc-scenario.py`) is **self-verifying**: it ships the buggy loader, asserts it FAILS the hidden suite, writes a correct string-aware reference loader, asserts it PASSES, and only then writes the scenario row. Getting there surfaced three of this report's defects (§6) — the honest path: heredoc escaping produced a hidden test with unterminated string literals, and the first "buggy" variant was actually a *correct* stripper that passed all 10 cases.

| Check | Result |
|---|---|
| buggy regex loader vs hidden suite | **exit 1** — 5 case failures + example failure |
| string-aware reference loader | **exit 0** — all 10 cases + example pass |

## 3. Three iterations on the long task (analyze → improve → rerun)

Arms: `native`, `context-tree`, `tree-dsa`. Task: `sw-1-jsonc` (hidden `command` judge). One scenario per run.

| Iter | Change under test | native | context-tree | tree-dsa |
|---|---|---|---|---|
| 1 | baseline (lazy summarizer, lexical-overlap branch scorer) | 12t · **$0.157** | 9t · $0.200 (1 contract fail) | 9t · $0.188 (1) |
| 2 | vector-space farthest-point branch scorer (weights 4/1/2) | 21t · $0.260 | 15t · **$0.456** (**3** fails) | 9t · **$0.198** (1) |
| 3 | summary circuit breaker (whole-plan) | 18t · $0.201 | 15t · $0.440 (2) | 10t · $0.218 (2) |
| **avg** | | **$0.206 / 17t** | **$0.365 / 13t** | **$0.201 / 9.3t** |

Token shape (iter2, the extremes): native in=93.7k / cr=0 / cw=0; context-tree in=84.2k / cr=68.5k / **cw=27.0k**; tree-dsa in=31.4k / cr=45.6k / cw=7.7k. Tree-dsa was the *only* arm whose wall time fell as the task grew (97s in iter2 vs 195–322s for the others).

**Iteration 1 finding:** on a long task the tree arms cost *more* than native — the exact inversion the question asked about. Turn-level data showed agent turns healthy; the delta was summarizer passes at sonnet prices plus the first observed §8 contract failures (`claude-sonnet-5 broke the §8 summary contract after one retry: no JSON object found`).

**Iteration 2 finding:** the failure mode is *recurring* — context-tree was billed for the **same failed node 3 times** in one run. `resummarizeStale()` has no failure memory: a node that threw stays stale and is retried, each retry a full try+retry pair. That is the single largest identifiable waste in the tree arms.

**Iteration 3 finding:** the whole-plan breaker (skip a pass only when *every* pending node has failed) cut repeat failures 3→2 but not to 1 — when a fresh leaf rides along with a repeatedly-failing root, the pass still runs and the root fails again. → replaced with the **per-node** version (`splitSummarizePlan` + D11 `scheduleSummarize`/`drain`), which excludes failed nodes individually while fresh siblings still summarize. Landed and unit-tested; not yet live-run (that is iter4).

## 4. What the vector-space selector actually is (and honestly, what it isn't yet)

The question: *can the trees go through an embedding model, get organized, and run DSA — more efficiently in latent space?* For **selection**, yes — but no embedding API is needed at branch-summary granularity:

- `termCounts` / `idfVectors` — idf-weighted TF over the branch summaries + the task (a deterministic lexical vector space).
- `cosineSimilarity(branch, task)` — relevance, replacing the fragile `overlapScore`.
- **Farthest-point (max-min diversity) sampling** in `selectTopKBranches` — pick the best branch, then repeatedly the branch that is relevant/recency-strong *and semantically furthest* from the picks so far. Top-k by score alone over-selects near-duplicates; spreading is the DSA sparse-attention move, done for free.

Weights were rebalanced after a unit test + simulation caught a real bug: at recency 1.5 / relevance 3, a max-recency irrelevant branch (1.5) beat the relevant anchor (typically ≤0.9) on the first pick. Now relevance 4 / recency 1 / diversity 2 — relevance is the anchor; recency only breaks ties.

**Honest limit:** branches never exceeded k=3 on this task, so the selector never fired live — the floor property (branches ≤ k ⇒ `undefined` ⇒ byte-identical prompt) held every turn, which is why tree-dsa is cost-stable across all three iterations. Its iter2 win is **floor + sampling variance, not selector gains**. Exercising it needs a task that grows >k branches.

**On embeddings proper:** they earn their keep when relevance must survive paraphrasing (lexical overlap misses "renew credentials" ≈ "rotate the token"); at that point swap `idfVectors` for embedding vectors behind the same cosine/farthest-point interface. For **summarization**, latent space can decide *what* to compress but cannot render prose — an LLM still writes summaries, which is why the cost lever below matters more.

## 5. Why more money while "reducing tokens" — the three add-backs

| Mechanism | Evidence |
|---|---|
| Root summarizer at sonnet prices, re-run on every ≥8-event threshold crossing | root passes appear as per-turn `cw≈1k` cache-write tokens; the task crossed the threshold repeatedly across 9–21 turns |
| §8 contract failure = try + retry, then throw; **no failure memory** | iter2 context-tree: same node failed 3× ≈ 6 sonnet calls for zero summary |
| cacheWrite on every prefix invalidation | 7.7–27.4k cw per tree run vs native's 0 (native pays full fresh input instead: 45–94k) |

Fresh input *is* reduced — 25–40k vs native's 45–94k — and on the short smoke task (one or zero summarize passes) that reduction won outright (−48%). At long horizon the add-backs win. The fix is not "summarize less" but "summarize *fewer distinct things*, more reliably, more cheaply" — hence the breaker (reliability) and dedup-before-summarize (§9).

## 6. Defect ledger (what this iteration loop caught)

| # | Defect | Caught by | Fix |
|---|---|---|---|
| 1 | Upstream benchmarks unreachable (GitHub 404s, HF API unusable) | environment probing | faithful in-sandbox task with hidden grader tests |
| 2 | `--limit 1` ran the *first* scenario (branch-1-five-cycles), not the new task | live log mismatch | scenario file isolated to the single `sw-1-jsonc` row |
| 3 | Hidden test shipped with literal newlines inside single-quoted strings → `SyntaxError: unterminated string literal` in the sandbox | py_compile check in the self-verify step | cases regenerated via `repr()` escapes |
| 4 | The first "buggy" loader was a *correct* string-aware stripper (passed all 10 cases) — the experiment would have measured nothing | self-verification assert | naive regex shipped as the bug; state machine kept as reference fix |
| 5 | Recency dominated relevance in the branch scorer (1.5 max vs ≤0.9 typical) — a brand-new irrelevant branch won the anchor pick | unit test + simulation | weights rebalanced to relevance 4 / recency 1 / diversity 2 |
| 6 | Test premise wrong: "more mentions = more relevant" is false under idf-cosine (norm dilution penalizes verbose branches) | failing assertion + trace | test rewritten to the sharp property: identical duplicates don't *both* survive when relevance is tied |
| 7 | No summarization failure memory — the same node re-billed 3× in one run (≈6 wasted sonnet calls) | iter2 stderr telemetry | summary circuit breaker: whole-plan (iter3), then per-node via `splitSummarizePlan` + D11 scheduler |

## 7. Answers to the questions posed

**Why are we consuming more money and tokens when we explicitly reduce context tokens?** Because "reduce context tokens" only reduces the *fresh input* bill (25–40k vs 45–94k). The tree adds back (1) sonnet-priced summarizer passes on every threshold crossing, (2) double-billed contract failures with no failure memory, and (3) 7–27k cacheWrite from prefix invalidation. On short tasks there are few or zero passes, so the reduction wins (−48%); at long horizon the add-backs exceed it. The tree's cacheRead economics only pay when the prefix stays stable — which repeated summarization breaks.

**Can we run trees through an embedding model, organize them, and run DSA — more efficiently in latent space?** For *selection*, yes, and it is now implemented without an embedding API: a deterministic idf-weighted lexical vector space + cosine + farthest-point sampling gives the same shape at zero token cost and full offline testability. A real embedding model is a drop-in upgrade behind the same interface when relevance must survive paraphrasing. For *summarization*, latent space chooses what to compress but cannot write the prose — so the summarizer remains the cost center and must be attacked with grouping/dedup (below), not replaced.

**Deterministic algorithms — cosine, KNN, KL divergence, unsupervised grouping?** Cosine + farthest-point (a greedy KNN-style diversification) landed and are unit-tested. The natural next application is **dedup-before-summarize**: skip summarizing a branch whose content is ≥0.9 cosine to an already-summarized sibling, and cluster near-identical branches so one summary serves the group — that reduces the *number* of LLM summarize calls, which is the actual cost, whereas the breaker only stops *repeated* failures.

**How can we optimize the summaries?** In order of measured leverage: (1) per-node circuit breaker — never re-pay a failed node (landed; expect context-tree failures 2→1); (2) cosine dedup-before-summarize — fewer calls; (3) retry the root summarizer on haiku now that failures are bounded (iter1's haiku regression was a critical-path artifact, and the failures suggest the sonnet+prompt contract itself is fragile); (4) consider not charging maintenance retries to the run at all (sleep-time compute).

**Append-only summaries — would that help?** Yes, and it attacks two of §5's three add-backs at once. Today every summarization *rewrites*: the leaf pass re-reads the branch's entire detail (O(total detail) per pass — quadratic across a run) and replaces the Zone B text wholesale, invalidating the assembled prompt's cache prefix (the 7–27k cacheWrite line). An append pass reads only the prior summary plus the events since it (O(delta)), asks the model for an appended segment, and lets Zone B grow at its tail — the summary prefix stays stable, exactly as branch ordering (rule 1) already keeps Zone B's structure stable. The store is ready (`putSummary` already appends versions, D3); the change is the summarizer's prompt/strategy (prior summary + delta → appended segment) plus meta-merging (append text, union the open-questions list). The risk is **drift**: a self-correction stays contradicted inside the summary until compaction, so bound it — append N times, then one full rewrite when the summary exceeds a length cap. Root summaries should stay rewrite-based (one node, composed from children, already cheap). See §9 Phase 1.

## 8. Current state of the code

- `eval/src/loop.ts` — `termCounts`, `cosineSimilarity`, `idfVectors`; `selectTopKBranches` rewritten as farthest-point diversity (weights 4/1/2); `splitSummarizePlan`; `maybeResummarize` now runs the per-node breaker through `scheduleSummarize` + `drain` with failure memory (`failedSummaryNodes`).
- `eval/src/adapters/util.ts` — `judgeFromRow(row, where)`; `judgeFilesFromRow` attaches hidden files to `command` judges; `filesFromRow` behavior unchanged.
- `eval/test/adapters/util.test.ts` — 4 tests (attach/absent/malformed `judge_files`, malformed `files`).
- `eval/test/loop.test.ts` — +6 (floor, relevance-anchor, duplicate-spread, cosine determinism, idf weighting, breaker split). **Suite: 58/58 across 7 files.**
- `eval/scripts/build-jsonc-scenario.py` — self-verifying generator (buggy FAILS / fixed PASSES asserts).
- `eval/scenarios/deepswe-agents-last-exam/agents-last-exam.jsonl` — single `sw-1-jsonc` row (local-only, gitignored by design per README).
- **Results:** `eval/results/long-swe-iter{1,2,3}/` (results.json + report.md each).

## 9. Next experiments

Ordered by **dependency, not interest** — each phase changes the baseline the next phase tunes against. Running the hyperparameter search before Phases 0–1 would tune the DSA weights against a summarizer-noise floor (and an inert selector) that will move underneath the result.

### Phase 0 — make the mechanism measurable (prerequisites)

1. **A task that grows > k branches.** The selector never fired live: branches stayed ≤ 3 = k on every run, so the floor property made tree-dsa byte-identical to the plain tree and every weight unmeasurable. Build a heterogeneous-phase task (read→write→test across ≥ 4 cycles) so segmentation produces 6–10 branches. *Acceptance:* the `[tree-dsa] kept N/M branches` telemetry line shows N < M on ≥ 2 turns of a run.
2. **Seeded repetition in the §15 harness.** native swung 12→21→18 turns on identical configs — n=1 cannot rank arms (`eval-resumption` already has seeded runs; port the pattern). n ≥ 5 per config, report **medians + IQR**, never means.

### Phase 1 — cut the summarizer cost floor (changes what the search tunes against)

3. **Live-run the per-node breaker (iter4).** Already landed and unit-tested; expect context-tree contract failures 2→1. The `summary circuit breaker: skipping N node(s)` stderr line makes the saving directly auditable. Cheapest next data point — do first.
4. **Append-only leaf summaries** (the §7 proposal). Predicted: summarizer input per pass O(total detail) → O(delta); cacheWrite down (stable Zone B text prefix). Implementation: summarizer prompt takes prior summary + delta events and returns an appended segment; §8 meta merged (union open-questions); bounded compaction (rewrite once the summary exceeds a length cap) to resolve drift; root stays rewrite-based. *Acceptance:* summarizer input tokens per pass fall with run length instead of growing; cw per run drops ≥ 30% vs iter3's tree arms.
5. **Cosine dedup-before-summarize:** skip a branch ≥ 0.9 cosine to an already-summarized sibling — reduces the *number* of calls, not just their failures.
6. **Root summarizer on haiku,** retried now that the breaker bounds failures.

### Phase 2 — the tree-dsa hyperparameter search

Only meaningful once Phase 0 confirms the selector fires. Knobs at current values:

| Knob | Current | Sweep | Note |
|---|---|---|---|
| `TREE_DSA_TOP_K_BRANCHES` (k) | 3 | {2, 3, 5} | effective range bounded by the task's branch count *and* the zoneB budget (rule 4 truncates what k lets through) |
| `TREE_DSA_RELEVANCE_WEIGHT` | 4 | {2, 4, 8} | the anchor term post-rebalance |
| `TREE_DSA_DIVERSITY_WEIGHT` | 2 | {0, 2, 4} | 0 = relevance-only top-k (the pre-DSA ablation) |
| `TREE_DSA_RECENCY_WEIGHT` | 1 | fixed | secondary; only breaks relevance ties |
| `SUMMARIZE_MIN_NEW_EVENTS` | 8 | {4, 8, 16} | shared knob, not DSA-specific — but §5 says summarizer passes dominate cost, so it is likely the *highest-leverage* knob in the whole search |

Design:

- **Stage 1 — OFAT** (one-factor-at-a-time around the current point): 8 new configs + the current-point baseline, n = 5 each ≈ 45 runs × ≈ $0.20 ≈ **$9–10**. Coordinate descent is more defensible than Bayesian optimization at this noise level and this budget.
- **Stage 2 — coordinate descent** from the Stage-1 winner: ±1 step on the two most sensitive knobs (2–3 configs, ≈ $3).
- **Metrics:** primary = cost per *successful* run (median); secondary = turns, cacheWrite, wall; **guard metric = selector-fire rate** — a config whose telemetry never shows `kept N/M` is indistinguishable from the floor and must not be ranked.
- **Acceptance:** a config beating the current point's median cost by > 20% at equal success rate (100%), on n ≥ 5, with the selector firing.

Sequencing note: run Phase 2 **after** the append-only change lands — otherwise the search optimizes branch selection against a summarizer cost model that Phase 1 is about to change.