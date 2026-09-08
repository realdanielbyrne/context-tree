# A2: Regime analysis for the Fable-interface pass

Analyzer lens A2. Computed from the frozen s1 fixture (trace sha `e1b289c32f40`, 196,385 cl100k tokens, 754 L0 events, ratio 0.8509) using `a2-regime.mjs`. All numbers offline; zero LLM calls.

## 0. Harness pad expressibility

The harness has no pad parameter. Searched `transplant.mjs` for `pad`, `systemPad`, `systemText` pad, `FLAT_SYSTEM` pad, `TREE_SYSTEM` pad, Zone A pad: zero hits. The workaround is to pass `--window (W - P)` as the effective window. This is semantically exact: every budget in `deriveBudgets` derives from the `--window` argument alone (`transplant.mjs:449-495`). The cells below model P = 70,000 by setting effective W = W - P.

The 70,000 token pad models a realistic host system prompt. Claude Fable 5.1's production system prompt is 275,723 characters (~65-70k tokens per `reports/metrics/window-regime-and-retrieval-unit/fable-5.1-past-chats-tools.md`). The context-tree's own Zone A (contract + tool schemas) is 2,271 heuristic / ~1,932 cl100k (measured from run turn data `zoneBudgets.zoneA`). A host carrying both would occupy ~68-72k tokens before any conversation content.

## 1. Truncate-tail K and boundary seq (instrument audit)

`truncationBoundarySeq` (`transplant.mjs:1214-1222`) walks events from the end, accumulating heuristic cost up to K = `floor(0.85 * W / ratio) - reply`. The boundary is non-increasing in K: wider windows yield lower boundary seqs, and more answers fall inside the tail (become "decayed" overflow questions).

questions-deep.json: `ref_window = 131072`, `boundary_seq = 268`, question seqs: 18, 151, 193, 218, 264.
questions-overflow.json: `ref_window = 65536`, `boundary_seq = 523`, question seqs: 151, 339, 402, 469, 507.

| W | P | eff W | K (heur) | boundary | deep valid | deep decayed | overflow valid | overflow decayed |
|---|---|-------|----------|----------|:----------:|:------------:|:--------------:|:----------------:|
| 65,536 | 0 | 65,536 | 61,616 | 523 | 5/5 | 0/5 | 5/5 | 0/5 |
| 65,536 | 70,000 | -4,464 | -- | -- | DEAD | -- | DEAD | -- |
| 131,072 | 0 | 131,072 | 123,232 | 268 | 5/5 | 0/5 | 1/5 | 4/5 |
| 131,072 | 70,000 | 61,072 | 57,419 | ~568 | 5/5 | 0/5 | 5/5 | 0/5 |
| 200,000 | 0 | 200,000 | 188,037 | ~145 | 1/5 | 4/5 | 0/5 | 5/5 |
| 200,000 | 70,000 | 130,000 | 122,224 | ~358 | 5/5 | 0/5 | 2/5 | 3/5 |
| 1,000,000 | 0 | 1,000,000 | 940,185 | 1 | 0/5 | 5/5 | 0/5 | 5/5 |
| 1,000,000 | 70,000 | 930,000 | 874,371 | 1 | 0/5 | 5/5 | 0/5 | 5/5 |

Boundary values at W = 65,536 and W = 131,072 are exact (from the frozen question files). Others use the linear approximation `boundary ~ 754 * (1 - K / 232624)`, which over-estimates by 31-87 seq (conservative for validity: a question marked "valid" at the approximate boundary is genuinely valid at the true, lower boundary).

The deep set decays rapidly above W = 131k: at W = 200k P = 0 only one question (seq 18) survives; at W = 1M all five are inside the tail and the set is invalid. The deep set is valid for W in {65k, 131k} at P = 0 and for W = 200k at P = 70k. The overflow set is valid at W = 65k (both pads) and at W = 131k P = 70k. At W = 200k P = 0 both sets are fully or nearly decayed.

This is the binding constraint: **the s1 trace (196k cl100k) is too short for a true overflow regime at W = 200k without a pad**. At that window the tail budget is 188k heuristic tokens, which covers ~81% of the trace's 232k heuristic tokens. Only 19% of the trace sits outside the tail, and four of five deep questions (seq 151-264) fall inside it.

## 2. Tree prompt size and headroom

tree-tail-v2 builds Zone A + Zone B (heuristic tokens) then fills the remaining window with raw recent events. Zone C = 0 for this arm. `buildArm` (`transplant.mjs:3783-3793`) computes the tail budget in mixed units: `headroom = W(cl100k) - total(heuristic) - maxReply(cl100k)`. Since cl100k tokens are ~15% fewer than heuristic tokens for the same text (ratio = 0.851), the mixed-unit computation over-allocates the tail by that margin. This is documented in the prior report as the source of occasional provider-side 400 errors at small windows.

| W | P | eff W | rootKeep | Zone B (h) | base (h) | tail (~cl100k) | total (~cl100k) | headroom (~cl100k) | 20-hit search fits? |
|---|---|-------|:--------:|:----------:|:--------:|:--------------:|:---------------:|:------------------:|:-------------------:|
| 65,536 | 0 | 65,536 | 40 | 15,403 | 17,674 | 37,938 | 52,977 | 9,207 | YES |
| 131,072 | 0 | 131,072 | 40 | 30,807 | 33,078 | 77,807 | 105,953 | 18,490 | YES |
| 131,072 | 70,000 | 61,072 | 16 | 14,354 | 16,625 | 35,222 | 49,368 | 8,575 | YES |
| 200,000 | 0 | 200,000 | 40 | 47,009 | 49,280 | 119,738 | 161,670 | 28,254 | YES |
| 200,000 | 70,000 | 130,000 | 40 | 30,556 | 32,827 | 77,153 | 105,085 | 18,339 | YES |
| 1,000,000 | 0 | 1,000,000 | 40 | 235,046 | 237,317 | 197,939 | 399,871 | 550,053 | YES |
| 1,000,000 | 70,000 | 930,000 | 40 | 218,592 | 220,863 | 197,939 | 385,871 | 497,553 | YES |

W = 65,536 P = 70,000 is a dead cell (negative effective window).

At W = 65,536 the prior report measured headroom at ~7.9k after the first tool turn, with "77/88 fetches began with non-positive headroom." My computation shows ~9.2k headroom at the first turn (before any tool results are appended). The difference is consistent: tool results consume headroom on subsequent turns, and by turn 2 the prompt exceeds the window.

At W = 200k P = 0 the headroom is ~28k. At W = 200k P = 70k it is ~18k. Both comfortably accommodate a 20-hit search list (6.1-7.3k tokens per the prior report). This confirms the user's hypothesis: **the small-window regime starved the model of tool headroom; at W >= 130k the first tool turn has 8-28k tokens of room**.

The search-list cost estimate of 6.1-7.3k is from the prior centering report (no search telemetry is recorded in the frozen result files). The result files record `resultTokensTruncated` per row but not per-search-response token counts.

## 3. Deep-set answers inside/outside tree raw tail

The tree-tail-v2 arm's raw tail uses the `tailBudgetMixed` heuristic tokens, which approximates to a boundary seq via the same linear model. All five deep-set seqs (18, 151, 193, 218, 264) are **outside** the tree's raw tail at every W from 65k to 200k at both pads. They are inside only at W = 1M (where the entire trace fits).

This confirms: the deep set genuinely requires retrieval at the windows being tested. A correct answer at W = 65k-200k cannot come from passive raw-tail reading alone.

## 4. Naive-full fit

| W | P | eff W | total needed | fits? |
|---|---|-------|:------------:|:-----:|
| 65,536 | 0 | 65,536 | 199,814 | NO |
| 131,072 | 0 | 131,072 | 203,091 | NO |
| 131,072 | 70,000 | 61,072 | 199,591 | NO |
| 200,000 | 0 | 200,000 | 206,538 | NO |
| 200,000 | 70,000 | 130,000 | 203,038 | NO |
| 1,000,000 | 0 | 1,000,000 | 246,538 | YES |
| 1,000,000 | 70,000 | 930,000 | 243,038 | YES |

Total needed = `native(196,385) + FLAT_SYSTEM(~77) + overhead(76) + reply(0.05 * eff_W)`.

naive-full does not fit at any window below 1M. The trace alone (196k tokens) exceeds every effective window up to 200k. The existing W = 200k naive-full results (file `run-W200000-naive-full-z-ai_glm-5.3-flash.json`) show `peakRequestTokens = 196634`, which exceeds the effective window but succeeded because the provider accepted it (some providers allow slight overruns). That result is therefore unreliable as a baseline at W = 200k.

At W = 1M, naive-full fits with 750k+ tokens of headroom. The existing result confirms: `status = completed`, `peakRequestTokens = 196634`.

## 5. Cost estimate

One live batch: n = 5 replicates x 5 deep questions x 4 arms {naive-full, truncate-tail, tree-tail-v2, tree-search-coordinates}, priced at glm-5.3-flash ($0.075/M in, $0.25/M out).

Median turns from measured results: naive-full = 1 (`run-W200000-naive-full`), truncate-tail = 1 (`run-W65536-truncate-tail`), tree-tail-v2 = 4 (`run-W65536-tree-tail-v2-questions-deep`), tree-search-coordinates = 4 (estimated, no live result).

**W = 200,000 P = 0:**

| arm | turns | prompt (cl100k) | total input | total output | cost |
|-----|:-----:|:---------------:|:-----------:|:------------:|:----:|
| naive-full | 1 | 196,538 | 4,913,450 | 5,000 | $0.37 |
| truncate-tail | 1 | 160,153 | 4,003,825 | 5,000 | $0.30 |
| tree-tail-v2 | 4 | 161,670 | 16,167,000 | 20,000 | $1.22 |
| tree-search-coordinates | 4 | 161,670 | 16,167,000 | 20,000 | $1.22 |
| **batch** | | | **41,251,275** | **50,000** | **$3.11** |

**W = 200,000 P = 70,000:**

| arm | turns | prompt (cl100k) | total input | total output | cost |
|-----|:-----:|:---------------:|:-----------:|:------------:|:----:|
| naive-full | 1 | 196,538 | 4,913,450 | 5,000 | $0.37 |
| truncate-tail | 1 | 104,153 | 2,603,825 | 5,000 | $0.20 |
| tree-tail-v2 | 4 | 105,086 | 10,508,600 | 20,000 | $0.79 |
| tree-search-coordinates | 4 | 105,086 | 10,508,600 | 20,000 | $0.79 |
| **batch** | | | **28,534,475** | **50,000** | **$2.15** |

Note: naive-full at W = 200k P = 0 does not fit the window (Section 4). Its cost is listed because the provider may accept a slight overrun, but the score is unreliable. At P = 70k it overruns by 73k tokens — it cannot run. The correct comparison baseline at these windows is truncate-tail.

## 6. Dead cells

| W | P | eff W | status | reason |
|---|---|-------|--------|--------|
| 65,536 | 0 | 65,536 | LIVE | |
| 65,536 | 70,000 | -4,464 | DEAD | W - P <= 0 |
| 131,072 | 0 | 131,072 | LIVE | |
| 131,072 | 70,000 | 61,072 | LIVE | |
| 200,000 | 0 | 200,000 | LIVE | |
| 200,000 | 70,000 | 130,000 | LIVE | |
| 1,000,000 | 0 | 1,000,000 | LIVE | |
| 1,000,000 | 70,000 | 930,000 | LIVE | |

One dead cell: (65,536, 70,000). All others are live for the tree arms. naive-full is not a dead cell in the tree sense but cannot fit at any window below 1M.

## 7. Longer traces

Six scenario builders exist under `eval/scripts/`:

- `build-dozen-scenario.py`: generates sw-5-dozen, a 12-module task targeting >200KB raw trace. Offline generator, zero LLM. The resulting trace would be substantially longer than s1's 196k tokens but the script builds a TASK scenario (for the eval loop), not a transplant fixture — the trace must then be captured from a live agent run and frozen.
- `marathon.mjs`: offline prompt-construction harness, 160-200 branches. Zero LLM. Produces a synthetic trace for prompt-sizing analysis, not a Q&A transplant fixture.
- `build-multimod-scenario.py`, `build-jsonc-scenario.py`, `build-ripple-scenario.py`, `build-refactor-scenario.py`, `build-bughunt-scenario.py`: shorter scenarios, all under 60KB raw trace per their headers.

None of these directly produce a transplant-format frozen fixture with >200k cl100k tokens. Freezing a trace for the transplant harness requires: (1) a live agent session that generates the trace, (2) `--phase prep` to ingest/segment/summarize, and (3) `--phase prep-overflow` to cut question sets against the new boundary. The cost depends on the agent model and task; a 400k-token session on a cheap model (glm-5.3-flash) would cost roughly $30-50 in agent tokens plus the summarization pass.

The s1 trace barely overflows at W = 200k P = 0: the tail budget is 188k heuristic (equivalent to ~160k cl100k), and the trace is 196k cl100k / 232k heuristic. Only ~19% of heuristic content is outside the tail. At W = 200k P = 70k the overflow is robust (effective W = 130k, K ~ 122k heuristic, boundary ~ seq 358, 48% of the trace outside). For a true large-window overflow experiment, a 400k+ token trace is needed.

## Harness defects found

1. **Mixed-unit tail budget** (`transplant.mjs:3787`): `headroom = budgets.window(cl100k) - prompt.budgets.total(heuristic) - budgets.maxReplyTokens(cl100k)`. This over-allocates the tail by ~15% (the ratio gap), which is why provider 400 errors were observed at small windows. Not a crash — `capToolResult` catches the overflow on tool results — but it means the prompt is ~15% over the window's token budget on the first turn, with subsequent tool results further exceeding it.

2. **Boundary approximation imprecision**: the linear model `boundary ~ 754 * (1 - K / 232624)` over-estimates by 31-87 seq at the two known points. This is because events are not uniformly sized — tool_result events near the middle of the trace are denser. The exact boundary requires running `truncationBoundarySeq` against the real L0/L2, which needs the `@context-tree/core` imports. Values marked "~" in the tables use this approximation.
