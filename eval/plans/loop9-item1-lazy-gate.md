# Loop 9, item 1 — replace the characters÷4 lazy gate with a real token count

Self-contained runbook. An agent with no other context can execute it. Evidence
and the full analysis are in `eval/plans/loop9b-analysis/04-lazy-gate.md`.

## What the gate is and why it is wrong

The context-tree eval arm runs in "devolved mode" while the raw trace is small:
it shows the whole transcript and summarizes nothing. The switch into summarized
operation is the **lazy gate**: `EVAL_LAZY_TOKENS=30000` names a token budget,
and `eval/src/loop.ts` compares the trace against it. Today that comparison is
`traceChars / 4 < lazyTokens` (loop.ts, `belowLazyBudget`, ~line 764). On code-dense
traces four characters per token undercounts. Measured on the six `long-v6x` tree
runs (sw-5-dozen, sw-6-ripple, claude-sonnet-5), the final-turn trace as billed by
the provider was 33,951–39,404 tokens, 13–31% above the 30,000 budget, and the gate
never fired on any of them. That is why every live run in `reports/metrics/context-growth.md`
tracks the baseline's growth curve instead of flattening.

## Success criterion (verbatim from `reports/metrics/context-growth.md:138`)

The tree's per-turn context curve flattens at the crossing instead of tracking the
trace, and its final-turn context falls below the baseline's on at least one of
sw-5-dozen / sw-6-ripple.

## Steps

1. **Code change** in `eval/src/loop.ts`, inside `runTreeArm`. Replace the
   character heuristic with the provider's own last-turn prompt count, which every
   turn already returns for free (`TurnRecord.usage`):

   ```diff
   -    let traceChars = args.scenario.task.length;
   -    const belowLazyBudget = (): boolean => lazyTokens > 0 && traceChars / 4 < lazyTokens;
   +    // Real tokens from the last completed turn — free (already returned by the
   +    // API), exact for whatever model is running, no chars/4 approximation.
   +    // 0 at turn 0: a fresh trace is always small enough to stay devolved.
   +    let lastPromptTokens = 0;
   +    const belowLazyBudget = (): boolean => lazyTokens > 0 && lastPromptTokens < lazyTokens;
   ```
   and right after the model call in the per-turn loop (after `args.turns.push(record)`):
   ```diff
   +      lastPromptTokens = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;
   +      if (belowLazyK && !belowLazyBudget()) {
   +        process.stderr.write(`[eval] lazy gate crossed at turn ${turnIndex}: ${lastPromptTokens} >= ${lazyTokens}\n`);
   +      }
   ```
   Leave the `traceChars` accumulation lines in place; touch nothing else in the file.

2. **Regression test** in `eval/test/loop.test.ts`, inside the existing
   `describe('v6.0 gate (EVAL_LAZY_TOKENS)')` block: a `ScriptedProvider` whose
   tool-call text is a few characters (`content: 'x'`) but whose mocked
   `usage.input` is 500 per turn, with `EVAL_LAZY_TOKENS=150`. Under the old
   chars÷4 gate the summarizer is never called; under the real-token gate it is
   called at least once. Assert `summarizer.requests.length > 0`. Verify the test
   fails with the gate line reverted, then passes. (Full listing in the analysis
   report §6.)

3. **Run** `pnpm vitest run eval/test/loop.test.ts` and the eval package typecheck.
   Rebuild whatever the live runner executes from (see "Run command" below).

4. **Rerun** the context-tree arm only — the native arm never reads this gate, so
   its `long-v6x` results remain a same-code-path baseline (state plainly in the
   report that they are from an earlier date). Scenarios sw-5-dozen and sw-6-ripple,
   n=3 each, model claude-sonnet-5 (the only model those baselines exist for;
   switching would void the comparison), config = the v6.5 candidate:
   `EVAL_LAZY_TOKENS=30000 EVAL_ROOT_KEEP=40`. Expected spend: about 1.3M tokens,
   $1.50–2.50 total. Results to `eval/results/long-v65-gate/long-v65-gate-rep{1,2,3}/`.

5. **Success check**, computed from each run's `turns[]`:
   ```js
   const ctx = (turns) => turns.map(t => t.usage.input + t.usage.cacheRead + t.usage.cacheWrite);
   // PASS if, for at least one scenario, median(final ctx, tree) < median(final ctx, native from long-v6x)
   ```
   plus the crossing turn from the `[eval] lazy gate crossed` stderr line and the
   slope before/after it from `eval/scripts/ct-growth.mjs`. Re-plot the two
   scenarios with the same pipeline that produced `context-growth.md` figures 2–3
   and add the cumulative "tokens saved vs native" line with its honest sign.

## Finding from the first live run: the gate must latch

The first replicate with the real-token gate crossed at turn 8 (40,158-token
prompt), summarized, and at turn 9 the prompt fell below 30,000 again because
Zone C now held only the active branch. The gate read that as "the trace fits",
re-expanded the whole trace into Zone C, and crossed again at turn 10 (43,331).
The run finished at 223,917 tokens and $0.42, about twice the loop-8 tree cost on
sw-5-dozen (`eval/results/long-v65-gate-oscillating.log`). The character count
never showed this because it only grows.

The rule asks whether the whole trace fits the budget. After the crossing the
prompt no longer contains the whole trace, so its size is not evidence either
way, and the trace itself only grows, so the condition can never become true
again. The crossing is therefore one-way: `lazyCrossed` latches in
`eval/src/loop.ts` and the test "the crossing is one-way" in
`eval/test/loop.test.ts` fails without it (two crossings reported, one expected).
The batch was stopped, rebuilt, and relaunched with the latch at 09:11 CDT.

## Ordering constraint

Land this before measuring item 3 (`loop9-item3-sw3-overhead.md`): the gate
change shifts the epoch for short-task devolved mode, and equal-n reruns are
cheaper done once.

## Run command (verified, and executed 2026-09-02 09:10 CDT)

`sw-5-dozen` and `sw-6-ripple` live in `eval/scenarios-long/` (written by
`eval/scripts/build-dozen-scenario.py` and `build-ripple-scenario.py`), not in
`eval/scenarios/`, so no filtering step is needed. Live runs execute the built
`eval/dist/run.js` (rebuild with `pnpm --filter @context-tree/eval build` and
confirm `grep -n lastPromptTokens eval/dist/loop.js` shows the new gate before
spending). `EVAL_ROOT_KEEP` is only read when `EVAL_DET_ROOT=1`, so the standing
v6.x flags carry forward. This is the exact line the loop-8 `long-v64` batch used,
plus `EVAL_ROOT_KEEP=40`:

```bash
for i in 1 2 3; do
  EVAL_NATIVE_CACHE=1 EVAL_ZONEC_LATEST=1 EVAL_SUMMARIZE_ON_CLOSE=1 EVAL_ZONEC_CACHE=1 \
  EVAL_DET_ROOT=1 EVAL_NO_ATOOLS=1 EVAL_FETCH_EVENTS=1 EVAL_LAZY_TOKENS=30000 EVAL_ROOT_KEEP=40 \
  node eval/dist/run.js --benchmarks deepswe-agents-last-exam --scenarios-dir eval/scenarios-long \
    --arms context-tree --max-turns 80 --time-cap-ms 1800000 \
    --out eval/results/long-v65-gate --run-id long-v65-gate-rep$i
done
```

Output: `eval/results/long-v65-gate/long-v65-gate-rep{1,2,3}/results.json` and
`report.md`; stderr (with the `[eval] lazy gate crossed at turn N` lines) in
`eval/results/long-v65-gate.log`. Baseline for the success check: the native rows
in `eval/results/long-v6x/long-v6x-rep{1,2,3}/results.json`.
