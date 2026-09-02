# Lens 4 / Roadmap item 1 — replace the characters÷4 lazy gate with a real token count

## Abstract

`eval/src/loop.ts:764` decides whether context-tree's tree arm stays in "devolved mode" (show the whole trace, build no summaries) by estimating trace size as `traceChars / 4` and comparing it to `EVAL_LAZY_TOKENS`. On the two live 60 kB tasks this gate is meant to protect (`sw-5-dozen`, `sw-6-ripple`, threshold 30,000, the `long-v6x` batch), the gate never fired in any of the six tree runs — but it should have: the real, provider-billed size of the trace the tree was showing at the final turn was 33,951–39,404 tokens in every run, 13%–31% *above* the 30,000 threshold, while `traceChars/4`'s estimate of that same growing trace stayed below it for the entire run (confirmed by the monotonically-increasing per-turn context tables in `reports/metrics/context-growth.md` — no run ever shows the flattening a genuine gate-crossing would produce). This is not a threshold picked too high for the task; it is undercounting, and the codebase's own `v6.4` comment at `eval/src/loop.ts:936-938` already names the mechanism: chars/4 does not charge for punctuation runs the way a real tokenizer does, and these are code-editing tasks. The repo already has the pieces to fix this without inventing anything: `TurnRecord.usage` (`eval/src/types.ts:52-56`) carries the provider's real per-turn token totals, already free, already used by `eval/scripts/ct-growth.mjs:44` to build exactly the chart the roadmap item wants flattened. The recommended fix is to gate on that number instead of a character count — a ~4-line change at the exact site the codebase already flags as sensitive ("the v6.5 gate lineage is mid-flight and must not be perturbed," `eval/fixtures/transplant/JUDGE-VERDICT.md:34`), which argues for the smallest diff that touches nothing else.

---

## 1. What the report already established (read first)

`reports/metrics/context-growth.md` (interim note to loop 8, dated 2026-09-01) plots per-turn context size (`usage.input + usage.cacheRead + usage.cacheWrite`, its own definition at §1) for `native` vs `context-tree` on `sw-5-dozen` and `sw-6-ripple`, three replicates per arm, `claude-sonnet-5`, one epoch (`long-v6x` batch). §3's finding: the tree carries roughly **2× the baseline's context per turn** in this regime — final-turn medians 39,201 vs 19,157 (sw-5, ×2.05) and 36,601 vs 20,191 (sw-6, ×1.81) — because "the lazy threshold that would have switched the tree out of devolved mode never fired... it estimates trace size as characters divided by four and the real tokenizer charges more than that for code-dense text." §4 item 1 states the criterion this report answers against:

> "Replace the characters÷4 lazy gate with a real token count, then re-run and re-chart sw-5 and sw-6. Success: the tree's curve flattens at the crossing instead of tracking the trace, and its final-turn context falls below the baseline's on at least one of the two scenarios."

`loop8-interim.md:166` names the exact configuration these numbers came from: *"v6.x = deterministic root + no schema text + fetch-as-events + lazy threshold 30k."* `EVAL_LAZY_TOKENS=30000` is the number in force for every run cited below.

---

## 2. The gate, read from the code

`eval/src/loop.ts`, inside `runTreeArm`:

```
763:    let traceChars = args.scenario.task.length;
764:    const belowLazyBudget = (): boolean => lazyTokens > 0 && traceChars / 4 < lazyTokens;
```

`lazyTokens` (`loop.ts:761`) is `Number.parseInt(process.env.EVAL_LAZY_TOKENS ?? '0', 10) || 0` — **the gate compares against `EVAL_LAZY_TOKENS`, an absolute env-configured value, not the model's context window `W` directly.** (A window-derived version of this same number exists, but only inside the *transplant* harness — see §6.) `traceChars` accumulates only specific raw string lengths as events are appended:

```
977:      traceChars += result.text.length;
993:            traceChars += nudge.length;
1031:          traceChars += (outcome.postContent?.length ?? 0) + outcome.output.length + JSON.stringify(call.input).length;
1061:            traceChars += text.length + JSON.stringify(call.input).length;
```

`belowLazyBudget()` is read once per turn, right before assembly (`loop.ts:915-917`):

```
915:      const belowLazyK = (lazyK > 0 && branchCount() < lazyK) || belowLazyBudget();
916:      const activeNodeId = belowLazyK
917:        ? rootIdForZoneC
```

— when true, `activeNodeId` is the root (Zone C = the whole trace) and `zoneCBudget` is set to `Infinity` (`loop.ts:938`), which is exactly "devolved mode" as `context-growth.md` describes it. `traceChars` is **monotonically non-decreasing** (every update adds a `.length`, never subtracts), so `belowLazyBudget()`'s truth value can only go true→false once per run, never back — if it had ever flipped, the run's later turns would show materially different (bounded/flattening) growth, the way Figure 1's tree line does in the marathon harness. None of the six `long-v6x` tree runs show that shape (§4 below), which is itself evidence the gate never fired, independent of not having `traceChars` logged directly.

Zone budgets more generally are counted through `packages/core/src/contracts/tokens.ts`'s `Tokenizer` interface and `packages/core/src/assemble/format.ts`/`assembler.ts`, using `HeuristicTokenizer` (`packages/core/src/tokens/index.ts:56`, the default for both `packages/core`'s §17 offline assertions and this eval loop's `ZoneAssembler` at `loop.ts:~715`). `HeuristicTokenizer` is a deliberately-offline approximation by design (its own file header: "deliberately NOT tiktoken or any provider vocabulary... just an arithmetic function of the string"), used to size Zone B/C so §17's cache-assertion harness stays reproducible offline. **The lazy gate at `loop.ts:764` does not even use `HeuristicTokenizer`** — it uses a cruder `chars/4` estimate computed independently, which is the first thing worth noticing: fixing the gate to use `HeuristicTokenizer` would still not be "a real token count" in the sense the roadmap item asks for, since `HeuristicTokenizer` is itself an approximation of a real BPE tokenizer (see the ratio in §3).

---

## 3. What "exact" tooling already exists in the repo

`eval/scripts/transplant.mjs` (a separate, offline literal-recall harness under `eval/fixtures/transplant/` — **not** what ran `sw-5`/`sw-6`) already contains both pieces the task asked me to look for:

```
199:const heuristic = new HeuristicTokenizer();
...
80:import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
201:export const exact = new ExactTokenizer('cl100k_base/gpt-tokenizer', (text) => countTokens(text));
...
595:function measureRatio(scenario) {
596:  const sample = l0Sample(scenario.blobs, scenario.paths.blobs);
597:  return exact.count(sample) / heuristic.count(sample);
598:}
```

and, run against the loop-9 substrate, the measured ratio is recorded in `docs/IMPLEMENTATION_PLAN.md:71` (D19): *"cl100k / heuristic = 0.851 over all 697 L2 blobs"* — i.e. `HeuristicTokenizer` **over**-counts relative to real OpenAI-family BPE by about 1/0.851 ≈ 1.18×. `gpt-tokenizer` is already a devDependency of `eval/` (`eval/package.json:20`). `packages/core/src/tokens/index.ts:104` (`ExactTokenizer`) is the generic wrapper this uses — a thin `{id, counter}` pair, provider-agnostic by construction.

Two caveats on reusing this directly for the `sw-5`/`sw-6` gate:
- `cl100k_base` is OpenAI's tokenizer family. The `long-v6x` runs used `claude-sonnet-5` (confirmed below), whose real tokenizer is not cl100k — so `exact.count()` would still be an *approximation* for this specific gate, just a better one than chars/4.
- The 0.851 ratio was measured on the transplant harness's own fixture corpus (697 L2 blobs from its own scenario), not on `sw-5`/`sw-6`'s trace content — reusing it as a correction factor here would be a second-hand approximation layered on a first one.

---

## 4. FINDINGS — computed from the actual `long-v6x` result files

Source: `eval/results/long-v6x/long-v6x-rep{1,2,3}/results.json` (confirmed identical to the tables already published in `context-growth.md` — I recomputed `usage.input + usage.cacheRead + usage.cacheWrite` per turn independently and it matches every cell).

**Finding 1 (confirmed).** All six tree runs are `claude-sonnet-5`, `benchmark: "deepswe-agents-last-exam"`, run through `eval/src/loop.ts`'s `runTreeArm` (not the transplant harness). Final-turn context per run:

| Scenario | Rep | Final turn | Final ctx (real, billed tokens) | minus fixed contract (2,442) |
|---|---|---:|---:|---:|
| sw-5-dozen | r1 | 12 | 39,201 | 36,759 |
| sw-5-dozen | r2 | 9  | 37,958 | 35,516 |
| sw-5-dozen | r3 | 16 | 41,846 | 39,404 |
| sw-6-ripple | r1 | 15 | 36,601 | 34,159 |
| sw-6-ripple | r2 | 12 | 37,648 | 35,206 |
| sw-6-ripple | r3 | 9  | 36,393 | 33,951 |

(2,442 is `context-growth.md`'s own reported fixed-contract cost, and it's independently reproducible from the data: turn-1 tree ctx minus turn-1 native ctx is exactly 4,013 − 1,571 = 2,442 on sw-5 and 3,992 − 1,550 = 2,442 on sw-6, in every rep.)

**Finding 2 (confirmed).** Every one of those six "trace-only" figures (33,951–39,404 real tokens) is **above** `EVAL_LAZY_TOKENS=30000` — by 13.2% (sw-6 r3) to 31.3% (sw-5 r3), mean ≈ 19.5%. Yet `belowLazyBudget()` stayed true (gate never fired) for the whole run in all six cases — proven by the per-turn tables in `context-growth.md` §3, which climb monotonically to these final values with no flattening at any point (e.g. sw-5 tree r1: 4,013 → 4,173 → 4,314 → 5,502 → 5,996 → 13,544 → 14,206 → 21,604 → 37,987 → 38,230 → 38,509 → 39,201 — strictly increasing, turn over turn, all 12 turns). Since `traceChars` only grows, a mid-run crossing would show up as exactly this kind of flattening (compare Figure 1's tree line in the same report, which goes flat the moment folding engages) and none does.

**This directly answers the question of undercount vs. threshold-too-low: it is undercounting, not a threshold set above the trace's actual size.** The real trace was already 13–31% past the nominal cutoff by the time these runs ended, and `chars/4` reported it as still under budget the entire time.

**Finding 3 (confirmed, from code comments — corroborating mechanism).** `loop.ts:936-938` (a v6.4-era comment already in the file, about a related but distinct defect) names the same root cause in the maintainers' own words: *"devolved mode promises the WHOLE trace, but the fixed 30k Zone C budget silently contradicted that once the real tokenizer (which charges punctuation runs the chars/4 lazy gate does not) pushed a code-heavy trace over it."* `sw-5`/`sw-6` are code-editing tasks (twelve buggy modules; an interface migration across ten files) — exactly the punctuation/symbol-dense content `HeuristicTokenizer`'s own design doc (`packages/core/src/tokens/index.ts:1-30`) singles out for different treatment from prose.

**Finding 4 (confirmed).** `EVAL_LAZY_TOKENS` is set directly as an env var per invocation for the `loop.ts` harness (no code path derives it from a window `W`). A **separate**, already-adjudicated proposal (`docs/IMPLEMENTATION_PLAN.md` D19; `eval/fixtures/transplant/JUDGE-VERDICT.md:34,62,81`) derives `EVAL_LAZY_TOKENS = floor(0.35·W/ratio)` for the *transplant* harness specifically, and its own judge ruling explicitly forbids editing `eval/src/loop.ts` for that purpose ("the v6.5 gate lineage is mid-flight and must not be perturbed"), instead having the transplant harness export the derived value as an env var into the unchanged `loop.ts` gate. That ruling is about *what number* `EVAL_LAZY_TOKENS` should hold (a function of window `W`); it says nothing about *how trace size is estimated* against that number, which is what `traceChars/4` at `loop.ts:764` does and is the actual subject of this roadmap item. The two fixes are orthogonal and this report's diff (§6) only touches the second.

---

## HYPOTHESES (not directly evidenced here)

- H1: Fixing only the gate (without also addressing the §3.2/v6.4-style truncation-cap churn already patched for a different reason) is sufficient — i.e. once devolved mode correctly exits, Zone B/C truncation under the *real* budget won't reintroduce a similar cache-churn problem. The v6.4 fix already addressed the specific mechanism reported (shared per-block truncation cap moving every turn); this hypothesis is that it generalizes to whatever budget the corrected gate hands off to, which the rerun in §7 is designed to check for, not assumed here.
- H2: Claude's real tokenizer's chars-per-token ratio for this code-dense corpus is close enough to `cl100k`'s that reusing `gpt-tokenizer` (option b, §5) would track it within a few percent. I have no exact-Claude-tokenizer measurement in this repo to confirm or refute this; it is plausible but unverified.

---

## 5. What "real token count" should mean here

Three options, per the task brief, and a recommendation.

**(a) Provider's reported prompt tokens from the previous turn** — `TurnRecord.usage.input + .cacheRead + .cacheWrite`, already computed and returned by every completion call, zero incremental cost, exact for whatever model is actually running. Lags one turn (the decision at the top of turn *n* reflects what was billed at the end of turn *n−1*, missing whatever was appended in between — bounded by one tool exchange's worth of content).

**(b) Local BPE count via `gpt-tokenizer`'s `cl100k_base`** (already a devDependency, already wired up in `transplant.mjs`) — reusable with an import, but approximate for the actual model in these runs (`claude-sonnet-5` is not tokenized with `cl100k`), and re-tokenizing the whole accumulated trace on every turn is O(trace length) per turn, cumulative O(n²) over a run (not a dollar cost, a latency one).

**(c) `HeuristicTokenizer` × the measured 0.851 heuristic→BPE ratio** — cheapest to compute (`HeuristicTokenizer` is already imported into `loop.ts` for the assembler), but the ratio was measured against `cl100k` on a *different* corpus (transplant's own fixture, not `sw-5`/`sw-6`), so this is an approximation of an approximation, twice removed from the model actually being billed.

**Recommendation: (a).** The rest of this exact harness already treats provider-reported usage as ground truth — `ct-growth.mjs:44` and every number in `context-growth.md` §3 *is* `usage.input + usage.cacheRead + usage.cacheWrite`. Gating on anything else (a heuristic, or a different provider's BPE table) means the switch-out-of-devolved-mode decision is made on a different definition of "size" than the one the report itself charts and than what the provider actually bills — reintroducing exactly the mismatch this roadmap item exists to remove, just with a smaller error bar. (a) is also the only option requiring zero new dependency and zero re-tokenization cost; its one-turn lag is small and directional-neutral (it does not systematically undercount the way chars/4 does — Finding 2/3 show a systematic ~20-30% miss, not run-to-run noise), and it degrades gracefully (turn 1 has no prior usage; falls back to "stay devolved," which is always correct for a fresh trace regardless of gate quality).

**What the gate should compare against:** keep comparing to `lazyTokens` (`EVAL_LAZY_TOKENS`), unchanged in source and semantics — this report's fix corrects the left-hand side of the comparison only, not the right-hand side (whether `EVAL_LAZY_TOKENS` itself should be `W`-derived is D19's separate, already-adjudicated question, scoped to the transplant harness — see Finding 4).

---

## 6. Minimal diff

`eval/src/loop.ts`, inside `runTreeArm`:

```diff
@@ line 763
-    let traceChars = args.scenario.task.length;
-    const belowLazyBudget = (): boolean => lazyTokens > 0 && traceChars / 4 < lazyTokens;
+    // Real tokens from the last completed turn — free (already returned by the
+    // API), exact for whatever model is running, no chars/4 approximation.
+    // 0 at turn 0: a fresh trace is always small enough to stay devolved.
+    let lastPromptTokens = 0;
+    const belowLazyBudget = (): boolean => lazyTokens > 0 && lastPromptTokens < lazyTokens;
```

```diff
@@ line 968 (right after the model call inside the per-turn loop)
       args.turns.push(record);
       Object.assign(args.usage, addTotals(args.usage, result.usage));
+      lastPromptTokens = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;
+      if (belowLazyK && !belowLazyBudget()) {
+        process.stderr.write(`[eval] lazy gate crossed at turn ${turnIndex}: ${lastPromptTokens} >= ${lazyTokens}\n`);
+      }
```

(`belowLazyK` is already in scope at that point, computed at `loop.ts:915` earlier in the same iteration — the stderr line is the one addition beyond the strict minimum, added because the §7 rerun's success check needs to know *which* turn the crossing happened on, and every other one-time state transition in this file already gets exactly this kind of stderr breadcrumb, e.g. `loop.ts:770-771`'s root-fold message.)

Everything else — `belowLazyK`'s use at `loop.ts:915-917`, the `zoneCBudget: Infinity` branch at `loop.ts:938`, `EVAL_LAZY_TOKENS` parsing at `loop.ts:761` — is untouched, in keeping with the "gate lineage... must not be perturbed" caution already on record for this code (§4, Finding 4). This is also why the removed `traceChars` accumulation lines (977, 993, 1031, 1061) should be left in place rather than deleted in the same diff: they may still be read elsewhere (e.g. debugging output) and deleting them is scope this fix doesn't need.

**Caveat to flag before merging:** the JUDGE-VERDICT ruling that named this code "mid-flight" was about a *different* proposed edit (replacing `EVAL_LAZY_TOKENS` with `EVAL_LAZY_FRACTION`+`EVAL_WINDOW`) and does not literally cover this smaller, orthogonal change — but the same lineage sensitivity applies. Check whether the v6.5 gate work has landed or is still in flight before touching this file.

### Tests that encode WHY (would fail if the gate reverts to chars/4)

`eval/test/loop.test.ts` already has the exact scaffolding needed — `describe('v6.0 gate (EVAL_LAZY_TOKENS)', ...)` at line 607 uses a `ScriptedProvider` whose mocked `usage` is fully independent of the mocked tool-call text/content, which is precisely what's needed to prove the gate reads real usage and not character count:

```ts
it('gates on the REAL reported prompt tokens, not chars/4 — cheap-looking text with expensive real tokens still crosses', async () => {
  vi.stubEnv('EVAL_SUMMARIZE_ON_CLOSE', '1');
  vi.stubEnv('EVAL_LAZY_TOKENS', '150');
  // Every turn's appended trace text is a handful of characters (`content: 'x'`)
  // — chars/4 of that never approaches 150 no matter how many turns run, so
  // a reverted (chars/4) gate would report ZERO summarizer calls here. The
  // mocked usage says the model was actually billed 500 tokens/turn, which
  // crosses a 150-token budget on turn 1. Only a real-token gate can tell
  // these two traces apart; that's the whole point of the fix.
  const replies: CompletionResult[] = [
    ...['write_file', 'read_file', 'write_file', 'read_file'].map((name, i) => ({
      text: '',
      model: 'test-model',
      usage: { input: 500, output: 10, cacheRead: 0, cacheWrite: 0 },
      toolCalls: [
        name === 'write_file'
          ? { id: `t${i}`, name, input: { path: `f${i}.txt`, content: 'x' } }
          : { id: `t${i}`, name, input: { path: `f${i - 1}.txt` } },
      ],
      stopReason: 'tool_use' as const,
    })),
    { text: 'done', model: 'test-model', usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], stopReason: 'end_turn' as const },
  ];
  const summarizer = new MockProvider({ responder: summaryResponder });
  const { result } = await runScenario({
    runId: 'r1', scenario, arm: 'context-tree',
    agentProvider: new ScriptedProvider(replies),
    summarizerProvider: summarizer,
    options: { ...options, maxTurns: 8 },
    sink: disabledSink(),
  });
  expect(result.status).toBe('completed');
  expect(summarizer.requests.length).toBeGreaterThan(0); // 0 under chars/4; >0 under real-usage gating
});
```

The business logic this encodes: the lazy gate exists to decide "would summarizing buy anything right now," and that question can only be answered against what the model is actually being charged — a test that only varies mocked *text length* would not catch a chars/4 regression (both implementations would agree on tiny text); varying the *mocked usage* independently of text length is what makes the test able to fail specifically when someone reverts to counting characters.

---

## 7. Rerun plan

**Scenarios:** `sw-5-dozen`, `sw-6-ripple` (unchanged fixtures — the fix touches only the harness's gate, not the tasks).

**Arms to actually run:** **`context-tree` only.** The lazy gate lives entirely inside `runTreeArm` (§2); `native`'s code path (`loop.ts:268-336`, roughly) never reads `belowLazyBudget` at all. This diff cannot change `native`'s behavior.

**n per arm:** 3 replicates × 2 scenarios = **6 new tree runs**, matching the existing `long-v6x`/`long-v64` batch size so the comparison stays equal-n (3 vs 3 per scenario) without paying for `native` again.

**Baseline reuse — same-epoch, explicitly:** Reuse the existing `native` results from `eval/results/long-v6x/long-v6x-rep{1,2,3}/results.json` (already the source of `context-growth.md`'s baseline numbers) rather than rerunning `native`. This is **not** literally same-epoch (different wall-clock date than the new tree runs) — the caveat worth stating plainly is that `claude-sonnet-5` could in principle answer slightly differently between the two dates even with `native`'s code unchanged (provider-side model drift, if any). It is same-*code*-path, which is the relevant control for isolating this specific fix: `native` has no lazy gate to regress. If strict same-epoch matters more than that argument to the reader, the cheap insurance is one confirmatory `native` rerun per scenario (2 extra runs, ~$0.35–$0.60 by the existing per-run costs below) rather than the full 6.

**Model:** `claude-sonnet-5` — confirmed from `results.json`'s `model` field on every `long-v6x`/`long-v64` run. This repo has no separate "cost-tiering" policy on record for the *agent* model in eval runs (only D2's cheap-leaf/strong-root split for the *summarizer*, `docs/IMPLEMENTATION_PLAN.md:54`); the only model actually used for `sw-5`/`sw-6` to date is `claude-sonnet-5`. Switching the agent model for this rerun would break the `native` reuse above outright (the whole comparison the report makes is `native` vs `tree`, same model, same task — reusing a `claude-sonnet-5` baseline against a differently-modeled tree run answers nothing), so the model must stay `claude-sonnet-5` here regardless of any general cheap-model preference for volume runs.

**Expected cost:** using `long-v64` (post-cache-fix, the more representative baseline for what a rerun's code path looks like) per-run tree averages — $0.204/run, 222,282 tokens/run, both averaged over `eval/results/long-v64/*/results.json` (6 runs) — 6 new tree runs project to roughly **$1.20 and 1.33M tokens** as a floor. Once the gate correctly fires mid-run, expect *some* increase from new summarizer calls (cheap leaf model + occasional root compose, per D2) partly offset by *reduced* Zone C token volume in later turns (the whole point of the fix) — net direction is ambiguous by design, so budget **~$1.50–$2.50 total** as a working estimate, comfortably under this repo's own per-batch caps used elsewhere (`transplant.mjs`'s `CAP_USD_TOTAL = 6.0`, `CAP_USD_PER_MODEL = 3.0`, `transplant.mjs:114-118`, cited only as an order-of-magnitude reference, not a limit that applies to this harness).

**Exact success check, computable from `turns[]`:**

```js
const contextSize = (turns) => turns.map(t => t.usage.input + t.usage.cacheRead + t.usage.cacheWrite);
const median = (xs) => { const s=[...xs].sort((a,b)=>a-b); return s.length%2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2; };

for (const scenarioId of ['sw-5-dozen', 'sw-6-ripple']) {
  const treeFinals   = treeRuns(scenarioId).map(r => contextSize(r.turns).at(-1));
  const nativeFinals = nativeRuns(scenarioId).map(r => contextSize(r.turns).at(-1)); // reused long-v6x rows
  const finalBelowBaseline = median(treeFinals) < median(nativeFinals);
  console.log(scenarioId, 'median tree final', median(treeFinals), 'median native final', median(nativeFinals), finalBelowBaseline);
}
// PASS if finalBelowBaseline is true for at least one of the two scenarios (report's own bar).
```

For the "flattens at the crossing" half of the criterion, the `[eval] lazy gate crossed at turn N: ...` stderr line added in §6 gives the crossing turn directly per run; re-run `eval/scripts/ct-growth.mjs` against the new results directory (it already computes `slope` — the least-squares slope of per-turn context vs. turn index, §1 header of that script) and check that a tree run's slope *after* its logged crossing turn is materially flatter than its slope before — this reuses existing tooling rather than adding a new metric. Re-plot both scenarios with the same chart pipeline that produced `context-growth.md` Figures 2/3, over the new results directory.

---

## Open questions

1. Whether the v6.5 gate lineage referenced in `JUDGE-VERDICT.md:34` has landed yet — this diff should not go in while that work is genuinely mid-flight; I could not determine its current status from files on disk (no dated changelog entry found for it).
2. Whether Claude's actual tokenizer's chars-per-token ratio for this corpus differs meaningfully from `cl100k`'s (H2) — irrelevant to the recommended fix (option a sidesteps needing to know), but relevant if a future need arises for an *offline*, no-live-call estimate of Claude token counts specifically.
3. Whether reduced Zone C volume once the gate fires will reproduce the same shared-truncation-cap cache-churn defect the v6.4 fix addressed for a different budget path — flagged as H1, and exactly what the rerun's cache-write numbers (already collected by the existing harness, `metrics.tokens` in `results.json`) will show.
