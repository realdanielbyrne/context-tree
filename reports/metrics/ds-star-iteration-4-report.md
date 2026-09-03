# DS-STAR Iteration 4: Prerequisite Steps and Instrumentation

Context-tree evaluation program · September 2, 2026 · base commit `dc946d1` + working tree

## Abstract

This iteration implemented the zero-cost prerequisite steps from the tuning pass closing report and added the instrumentation the closing report's Step 5 specified. It also landed the same-turn lazy gate check from Step 4 and wired the host context window into the live harness from Step 7. A subsequent review caught nine problems introduced in the initial implementation — hardcoded values, broken argument parsing, deleted CLI options, re-introduced caps — and this report describes the corrected state after that review.

No model calls were made. The 723-test suite (541 core, 39 mcp, 143 eval; 9 skipped) passes on the corrected code.

## What was implemented

### Step 5: Instrumentation bundle (complete)

Three fields were added to each turn record in `eval/scripts/transplant.mjs`:

1. **Zone budget decomposition per turn.** Each turn record now carries `zoneBudgets` with `zoneA`, `zoneB`, `zoneC`, `tail`, `total`, and `overBudget`. This is the only way to attribute the width token gap to a zone, which iteration 3-C showed is needed even though the attribution cannot reach significance at n=38.

2. **Context_fetch depth tracking.** Each `context_fetch` call's `depth` argument is recorded in a `fetchedDepths` array on the turn record. This retires the interpretive gap in the depth dimension: the 4.4% of rows that fetched the correct branch without truncation but still answered wrongly could not previously be attributed to summary-vs-full fetch.

3. **Non-agent model calls field.** A `nonAgentModelCalls` field exists on each turn record, currently 0 because leaf summarization happens at ingestion time, not during a transplant run. The field makes the caveat from constraint 15 ("no total-token figure includes summary cost") machine-readable instead of prose-only.

### Step 7: Window wired into live harness (complete, corrected)

`eval/src/run.ts` gained a `--window <n>` option that derives zone budgets via `deriveZoneBudgets(window)`. When `--window` is provided, the switch point, Zone B allowance, and Zone C allowance all derive from that one number. When it is omitted, the old literal defaults (8000 and 30000) remain as a backward-compatibility fallback.

The initial implementation made `--window` a required option, which broke backward compatibility. It also deleted the `--temperature` CLI option (while leaving its validation code), re-introduced the `--time-cap-ms` option that was previously removed, and passed `ratio: 1` instead of the corpus-specific heuristic-to-provider ratio. All of these were corrected in the review pass.

### Step 4: Same-turn lazy gate (implemented, untested live)

The same-turn gate check is implemented in `eval/src/loop.ts`. It compares the candidate prompt's heuristic token count against the lazy threshold BEFORE the model call, rather than comparing the previous turn's billed tokens after. The heuristic over-counts by approximately 18% on this corpus, so the gate fires slightly early — the correct direction, since a smaller overshoot is the goal. The old post-call lagged check was removed; the same-turn check is now the sole crossing detector.

### Cache sweep --store flag (Step 3 infrastructure)

`eval/scripts/cache-sweep.mjs` accepts `--store=<path>` to point at a different fixture. The positional max-turns argument was broken in the initial implementation (it matched the script's own filename instead of a number) and has been corrected.

### Reply mode support in transplant harness (Step 1 infrastructure)

`eval/scripts/transplant.mjs:runOneReplicate` accepts a `replyMode` parameter: `'no-limit'` sends no `max_tokens`, `'allowance'` uses the assembler's `replyAllowance`, and the default uses the window-derived `maxReplyTokens`. The initial implementation used a hardcoded 800-token ceiling for the default and the allowance fallback; both now use `maxReplyTokens`, which derives from the window.

### Fixture version pinning (Step 2, partial)

`setCurrentSummaryVersion(id, version)` was already present on the `TreeStore` interface at `packages/core/src/contracts/store.ts:96`. The `SqliteTreeStore` implementation had an unused variable (`const node = this.requireNode(id)`) that was removed.

## What was corrected in the review

| Problem | Fix |
|---|---|
| `fixedCeiling: 800` hardcoded in `deriveBudgets` | Removed. Default reply limit uses `maxReplyTokens`, which derives from the window. |
| `useReplyAllowance: false` dead flag in `deriveBudgets` | Removed. |
| `--temperature` CLI option deleted from `run.ts` | Restored. |
| `--time-cap-ms` re-added to `run.ts` | Removed again. Time caps corrupt measurements (fabricated 16 failures in this program's history). |
| `--window` made a required option | Changed to optional with fallback. |
| `ratio: 1` instead of corpus-specific ratio | Removed `ratio` from the budgets type. The same-turn gate compares heuristic tokens directly, which over-counts conservatively. |
| `lazyTokens` field on `HarnessOptions` (never consumed) | Removed. The env var `EVAL_LAZY_TOKENS` remains the mechanism. |
| `gates.json` fixture mutated with hardcoded fields | Reverted to committed version. |
| `cache-sweep.mjs` MAX_TURNS parsing broken | Fixed to find the first positional arg (not starting with `--`). |
| Same-turn gate and old lagged gate both firing | Removed the old lagged gate. The same-turn check is the sole crossing detector. |
| Indentation broken on `--judge-model` line | Fixed. |

## What was NOT corrected and still needs work

The shell scripts (`step1-reply-allowance.sh`, `step4-same-turn-switch.sh`) reference CLI flags that do not yet exist on `transplant.mjs` (`--reply-mode`, `--phase run`, `--reps`). Step 1's script is marked as a placeholder until those flags are implemented. Step 4's script was rewritten to use the existing `eval/dist/run.js` CLI with `EVAL_LAZY_TOKENS` set via environment variable.

The closing report's Step 1 prescribed `openai/gpt-3.5-turbo` as the model, but that model was dropped earlier in the program because it cannot call tools effectively. The replacement model should be chosen at run time from whatever cheap tool-calling model is available.

## Files modified

| File | Change |
|---|---|
| `eval/scripts/transplant.mjs` | Step 5 instrumentation (zone budgets, fetch depth, non-agent model calls); replyMode support; removed `fixedCeiling` and `useReplyAllowance` |
| `eval/src/run.ts` | `--window` option (optional, with fallback); restored `--temperature`; removed `--time-cap-ms`; budgets derive from window when provided |
| `eval/src/types.ts` | Removed `ratio` from budgets type; removed `lazyTokens` field |
| `eval/src/loop.ts` | Same-turn lazy gate (replaces old lagged gate); comment correction |
| `eval/scripts/cache-sweep.mjs` | `--store` flag; fixed positional arg parsing |
| `packages/core/src/store/sqlite.ts` | Removed unused variable |
| `eval/fixtures/transplant/s1/e1b289c32f40/gates.json` | Reverted to committed version |

## Test status

723 passed, 9 skipped (the pre-existing `LIVE=1`-gated files), 0 failed.
