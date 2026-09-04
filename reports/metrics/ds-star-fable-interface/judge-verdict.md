# Judge verdict: Fable-interface pass

DS-STAR judge. September 4, 2026. Zero live LLM calls.

## Abstract

The three plans address the same bottleneck -- headroom starvation at W=65,536
made delivery mechanically impossible -- but differ in how much they build before
measuring. Plan B (regime-first) wins because it runs the cheapest honest test
of the starvation hypothesis using arms that already exist, before writing any
new code. Plan A (published-alternative) builds a full Fable interface port
whose intermediate ablation rungs may produce null results (the contract text
and tool surface are entangled), and Plan C (null-hypothesis) arrives at the
same first batch as B but orders B before A, which is B with one fewer arm.
The verdict grafts C's 2x2 factorial framing and A's snippet-survival gate
onto B's queue.

---

## 1. SCORES

| Criterion | Plan A (published-alternative) | Plan B (regime-first) | Plan C (null-hypothesis) |
|---|:---:|:---:|:---:|
| Information gained per token | 6 | 9 | 8 |
| One-variable discipline | 5 | 8 | 7 |
| Portability per algorithm.md rules 1-7 | 6 | 9 | 8 |
| Instrument validity | 7 | 8 | 8 |
| Cost | 5 | 8 | 7 |
| **Total** | **29** | **42** | **38** |

**Scoring notes.**

*Information per token.* B's first batch (75 rows, ~$1.78) answers the
starvation hypothesis with three arms that already exist. A's first batch
(50 rows, ~$0.99) answers the same question with one arm that already exists
plus one new arm (tree-k5) that requires ~5 lines of code. C's first batch
(25 rows, ~$0.40) answers a narrower question (compact search at W=65k alone).
B provides the widest answer at the lowest cost per bit.

*One-variable discipline.* A proposes a 5-arm ablation ladder where arms 2-4
(flag variations of tree-tail-v2 with context-tree contract text but Fable-like
parameters) change the fetch/search parameters while keeping a contract that
references different tool names. A4 identifies this risk: "arms 2-4 may measure
nothing, and only arm 5 (full composite) has ecological validity." B changes one
thing per batch (window, then hit count, then behavioral cap). C changes window
and compact-search simultaneously in its second batch but labels the design
as a 2x2 factorial, which is a valid two-variable design with interaction
measurement.

*Portability.* A introduces `--search-k`, `--hit-snippet-chars`,
`--read-events` as new harness flags (3 constants). `search-k 5` derives from
Fable's interface (rule 3: setting from the model's limits). `hit-snippet-chars
200` is unvalidated (rule 2 defect). `read-events 20` is Fable's default, not
derived from W or measured (rule 2 defect). B introduces zero constants; its
only parameter is `--window 130000`, which is derived from `200000 - 70000`
(both externally measured). C introduces zero constants.

*Instrument validity.* All three plans correctly identify the question-set
validity constraint. A does not run its own validity gate (it asserts
"effective W = 130,000" and refers to A2's table). B runs KG-1 explicitly.
C runs a validity gate. A's cost estimates assume 4 turns for tree arms at
W=130k, extrapolated from W=65k where turns were higher (4-5 median) partly
because the model was thrashing against empty headroom; at W=130k turns may
be lower. All three use the same extrapolation, so this is a shared risk.

*Cost.* B: $1.78 (first batch) + $0.75 (conditional) + $0.40 (conditional)
= $2.93 max. A: $2.97 (all three batches). C: $2.38. B's conditional
structure means it spends $1.78 before deciding whether to continue; A and C
commit to their full spend from the start.

---

## 2. WINNER

**Plan B (regime-first)**, with grafts from A and C.

B wins because cheapest-honest beats most-elegant. The starvation hypothesis
is the load-bearing claim: at W=65,536 the tree enters tool use with 7,886-7,919
tokens of headroom, search consumes 77-92% of it, and 77/88 fetches delivered
zero bytes. Before building a Fable interface port or sweeping hit counts, the
first honest question is: does tree-search-coordinates (8 offline gates passed,
0 live rows) score above zero when given enough headroom? B asks exactly that,
with existing arms, for $1.78.

**Grafts from losers:**

- **From C: 2x2 factorial framing.** B's batch 1 includes tree-tail-v2 but
  not the cross with W=65k compact search. Add C's candidate B
  (tree-search-coordinates at W=65,536, 25 rows, ~$0.40) as a fourth arm in
  B's batch 1. This gives the 2x2 {compact, standard} x {65k, 130k} design
  with the existing tree-tail-v2 W=65k cell as the fourth corner. Cost: +$0.40.
  Reason: if compact search alone (without wider window) scores >0, the
  starvation fix is cheaper than a window regime change.

- **From A: snippet-survival gate (KG-4 / K4).** If B's C2 (hit count 5)
  runs, A's offline gate asserting that a 200-char snippet survives the strip
  at transplant.mjs:4045-4052 for a future arm is worth running as a zero-cost
  preparatory check. It does not gate C2 (C2 does not use snippets) but it
  gates the eventual snippet arm. Reason: the strip is unconditional and will
  silently eat any snippet a new arm returns.

- **From A: qo03 rank-7 pre-registration.** A's C2 pre-registers that qo03
  ranks 7th and is an expected loss at k=5. B's C2 should carry the same
  pre-registration. Reason: without it, a C2 score of 4/25 (losing only qo03)
  and 3/25 (losing qo03 plus one other) are indistinguishable in
  interpretation.

---

## 3. EXPERIMENT QUEUE

### Q1. Regime shift + compact search 2x2 (epoch-shifting)

**The single change (batch-level):** Window from 65,536 to 130,000.

**Flag/arm names:**
- `truncate-tail` at W=130,000 (new baseline)
- `tree-tail-v2` at W=130,000 (bridges to existing W=65k cell: 1/25)
- `tree-search-coordinates` at W=130,000 (compact search, wider window)
- `tree-search-coordinates` at W=65,536 (compact search, existing window; grafted from C)

**Command lines:**
```bash
# Batch 1a: three arms at W=130,000
node eval/scripts/transplant.mjs \
  --phase run --window 130000 \
  --arms truncate-tail,tree-tail-v2,tree-search-coordinates \
  --questions-file questions-deep.json --reps 5 \
  --model z-ai/glm-5.3-flash

# Batch 1b: compact search at W=65,536
node eval/scripts/transplant.mjs \
  --phase run --window 65536 \
  --arms tree-search-coordinates \
  --questions-file questions-deep.json --reps 5 \
  --model z-ai/glm-5.3-flash
```

**n and model:** n=5 per question, 5 questions, glm-5.3-flash.

**KILL GATES (zero-live-token, ordered):**

KG-1. **Question validity at W=130,000.** Compute `truncationBoundarySeq` at
K=122,209 and assert all 5 deep-set seqs (18, 151, 193, 218, 264) fall below
the boundary (~358). Script: `a2-regime.mjs` (existing,
`reports/metrics/ds-star-fable-interface/a2-regime.mjs`). Verified this session:
PASS.

KG-2. **Headroom adequacy.** Assert headroom at eff-W=130k (18,339 cl100k)
exceeds compact-search max (1,402) + minimum useful fetch band (3,000 tokens).
Script: `a2-regime.mjs` (existing). Verified: PASS (18,339 > 4,402).

KG-3. **Compact search offline gates.** Run `search-coordinate-killgate.mjs`
(existing, `eval/scripts/search-coordinate-killgate.mjs`). Verified this session:
8/8 PASS. NC23 tokens min=1194, median=1274, max=1402.

KG-4. **Provenance audit.** Run `provenance-audit.mjs` (existing,
`eval/scripts/provenance-audit.mjs`) on the completed cell. Verified this session:
0 unearned.

KG-5. **Truncate-tail zero at W=130k (deep set).** After batch 1a completes,
assert truncate-tail scored 0/25 on the deep set at W=130k. If it scores >0,
the deep set does not test overflow at this window and the cell is invalid.
Script: inline JSON parse of the result file (no new script needed).

**Pre-registered win criterion per stratum:**

- **Primary (deep set, overflow):** tree-search-coordinates at W=130k scores
  > truncate-tail at W=130k by >= 2 questions (same criterion as B's C1).
- **Secondary (2x2 interaction):** tree-search-coordinates at W=130k scores
  > tree-search-coordinates at W=65k (window effect on compact search).
- **Tertiary (standard search, window effect):** tree-tail-v2 at W=130k
  scores > tree-tail-v2 at W=65k (1/25 baseline). Exploratory.

**Escalation rule:** If tree-search-coordinates at W=130k scores 0/25, the
compact search arm is retired at this window and C2 is skipped. Proceed
directly to investigating why delivery failed despite adequate headroom
(extraction becomes the new binding constraint per B's mechanism section).

**Exploratory strata:** The tree-tail-v2 at W=130k comparison to its W=65k
baseline (1/25) is exploratory -- its purpose is to decompose the 2x2 factorial,
not to gate anything.

**Token estimate:** Batch 1a: 75 rows. Tree arms: 50 runs x 4 turns x 105k
= 21M input. Truncate-tail: 25 runs x 1 turn x 104k = 2.6M. Total 1a: ~23.6M
input, ~25k output. Cost: ~$1.78. Batch 1b: 25 runs x 4 turns x 53k = 5.3M
input, ~5k output. Cost: ~$0.40. **Total Q1: ~$2.18.**

---

### Q2. Hit count 5 at W=130,000 (conditional on Q1)

**Condition:** Q1 tree-search-coordinates at W=130k scores >= 1/25.

**The single change:** Search result limit from 20 (default) to 5.

**Flag/arm names:**
- `tree-search-coordinates-k5` (tree-search-coordinates with limit override)
- Same-epoch truncate-tail reused from Q1 (no re-run).

**Command line:**
```bash
node eval/scripts/transplant.mjs \
  --phase run --window 130000 \
  --arms tree-search-coordinates \
  --questions-file questions-deep.json --reps 5 \
  --model z-ai/glm-5.3-flash \
  --search-k 5
```

Note: `--search-k` requires ~5 lines of plumbing in transplant.mjs to thread
through to `ctx.config.retrieval.limit` at line 1596. See implementation spec
below.

**n and model:** n=5, 5 questions, glm-5.3-flash.

**KILL GATES:**

KG-6. **5-hit coordinate token count.** Offline: run the existing search
handler with limit=5 on all 5 deep-set queries against the frozen store.
Assert total response < 600 tokens per query. Script: adapt
`search-coordinate-killgate.mjs` to accept a `--limit` parameter (or write a
~30-line variant). File anchor: `eval/scripts/search-coordinate-killgate.mjs`.

KG-7. **Rank-5 coverage pre-registration.** From the readiness JSON NC21:
live ranks are [1, 2, 7, 1, 1]. At k=5, qo03 (rank 7) is excluded.
Pre-register: qo03 expected to score 0/5 on this arm. The arm can score
at most 4/5 questions (20/25 ceiling). If a success on qo03 appears, it is
anomalous (the rank-7 branch was not in the returned hits).

**Pre-registered win criterion:**

- tree-search-coordinates-k5 score >= tree-search-coordinates (k=20, from Q1)
  minus 1 question (non-inferiority allowing the qo03 loss).
- AND total input tokens < 90% of tree-search-coordinates (k=20) total input.
- AND mean delivered bytes per fetch > tree-search-coordinates (k=20). This is
  the headroom-freed-for-delivery hypothesis.

**Escalation rule:** If k5 scores strictly lower than k20 minus 1 on non-qo03
questions, the hit-count reduction damaged selection. Stop and investigate
before proceeding.

**Exploratory:** Per-question delivered-bytes comparison (which questions gain
delivery from the extra headroom).

**Token estimate:** 25 runs x 4 turns x 105k = 10.5M input, ~5k output.
Cost: ~$0.79. Same-epoch truncate-tail from Q1; no re-run. **Total Q2: ~$0.79.**

---

### Q3. Behavioral opens cap (conditional on Q1)

**Condition:** Q1 tree-search-coordinates at W=130k has median turns > 3
(thrashing persists at wider headroom).

**The single change:** One sentence added to the system contract: "Search once
per question; if the first result does not settle it, fetch the top-ranked
branch and answer from what arrives. Do not reformulate."

**Flag/arm names:**
- `tree-search-coordinates-capped` (tree-search-coordinates with contract
  addendum)
- Same-epoch baseline from Q1.

**Command line:**
```bash
node eval/scripts/transplant.mjs \
  --phase run --window 130000 \
  --arms tree-search-coordinates \
  --questions-file questions-deep.json --reps 5 \
  --model z-ai/glm-5.3-flash \
  --contract-addendum "Search once per question; if the first result does not settle it, fetch the top-ranked branch and answer from what arrives. Do not reformulate."
```

Note: `--contract-addendum` requires ~15 lines of plumbing to append to
TREE_SYSTEM. See implementation spec below.

**n and model:** n=5, 5 questions, glm-5.3-flash.

**KILL GATES:**

KG-8. **Contract size delta.** Offline: the addendum is 28 tokens (measured by
cl100k). Assert delta < 50 tokens. Trivially passes.

**Pre-registered win criterion:**

- Mean turns < 3.0 (vs observed 4-5 at W=65k, unknown at W=130k).
- AND score >= Q1 tree-search-coordinates minus 1 (non-inferiority).

**Escalation rule:** If mean turns is already < 3.0 on Q1's
tree-search-coordinates arm (i.e., the thrashing resolved itself with wider
headroom), skip Q3 entirely. The behavioral cap is not needed.

**Exploratory:** Search-call count per run.

**Token estimate:** 25 runs x 3 turns (expected, if cap works) x 105k = 7.9M
input. Cost: ~$0.59. **Total Q3: ~$0.59.**

---

**Queue total: $2.18 (Q1) + $0.79 (Q2, conditional) + $0.59 (Q3, conditional)
= $3.56 max, $2.18 minimum.**

---

## 4. IMPLEMENTATION SPEC

### Q1: no implementation needed

All three arms (truncate-tail, tree-tail-v2, tree-search-coordinates) already
exist in transplant.mjs ARM_IDS (lines 203-260). The `--window` parameter is
already parsed by `parseArgs` (line 4648) and threaded to `deriveBudgets`
(line 454). The compact-search coordinate projection is `coordinateSearchData`
(line 1547). The only action is to run the command lines above.

**Telemetry fields already present per row:**
- `turns[].promptTokens` -- total prompt size per turn
- `turns[].usage.input` -- provider-reported input tokens
- `turns[].toolCalls[].afterChars` -- chars in tool result after cap
- `turns[].toolCalls[].droppedChars` -- chars removed by cap
- `turns[].toolCalls[].beforeTokens` / `afterTokens` -- tokens before/after cap
- `peakRequestTokens` -- max prompt across all turns
- `status` -- completed / stalled / model_call_error
- `score` -- exact match (0 or 1)

These are sufficient to distinguish "mechanism never fired" (afterChars = 0 on
all fetches, meaning delivery failed) from "null result" (afterChars > 0 but
score = 0, meaning the content arrived but did not contain the answer).

**Tests to run:** `pnpm vitest run` (all 38 files, 970 tests). No new tests
needed for Q1.

**algorithm.md changes if Q1 lands:** None. W is host-supplied (algorithm.md
Tier 2 bottom paragraph). The finding updates the boundary-conditions table:
"Tail covers the answerable content" row gets a measured threshold.

### Q2: `--search-k` plumbing

**Ordered steps:**

1. **transplant.mjs:4648 (parseArgs):** No change needed; `parseArgs` already
   parses arbitrary `--key value` pairs into `options`.

2. **transplant.mjs:4156-4175 (runArms):** After `const options = ...`, read
   `options.searchK` and thread it into the arm configuration. Add after the
   existing option reads (~line 4175):
   ```js
   const searchK = options.searchK ? Number(options.searchK) : null;
   ```

3. **transplant.mjs:3722 (buildArm):** In the tree-arm branch, pass `searchK`
   into the scenario config override:
   ```js
   if (searchK) scenario.config.retrieval.limit = searchK;
   ```
   File anchor: transplant.mjs:3722, inside the `buildArm` function where
   `scenario.config` is read. The config is already read at line 1596
   (`ctx.config.retrieval.limit`), so overriding it before building the arm
   is sufficient.

4. **transplant.mjs:4263-4276 (identity):** Add `searchK` to
   `identity.invocation` so two runs at the same W with different k are
   distinguishable:
   ```js
   invocation: { window, arms, reps, ..., searchK: searchK ?? null },
   ```

5. **Result file naming:** The `identityTag` at line 4278 includes `codeKey`
   (a hash of transplant.mjs), which changes when the code changes. No
   additional naming is needed; the `searchK` in identity makes the cell
   unique.

**Telemetry for Q2 (already present):**
- `turns[].toolCalls[].afterTokens` on search calls -- will show ~350 vs ~1300.
- `turns[].toolCalls[].afterChars` on fetch calls -- the delivery measure.
- The hit count is inferable from the search result JSON but is not recorded as
  a top-level field. To distinguish "mechanism fired" from "mechanism never
  fired," the existing `afterTokens` on the search call suffices (< 600 = k5
  fired; > 1000 = k20).

**New telemetry field (recommended but not blocking):** Add
`searchHitCount` to the `toolCalls.push` block at transplant.mjs:4075-4105.
One line:
```js
searchHitCount: call.name === CONTEXT_SEARCH ? outcome.data?.hits?.length : undefined,
```

**Tests to add:** One test in `eval/test/transplant.test.ts` asserting that
when `scenario.config.retrieval.limit = 5`, the search handler returns at most
5 hits. Pattern: existing tests in that file call `handlersForArm` and invoke
the handler directly. ~10 lines.

**Tests to run:** `pnpm vitest run eval/test/transplant.test.ts` (targeted),
then `pnpm vitest run` (full suite).

**algorithm.md changes if Q2 lands:** Tier 2 row "search result limit" changes
from "unvalidated, and there are TWO defaults" to "5 (measured at W=130k on
glm-5.3-flash; derives from Fable 5.1 interface comparison)." The "TWO
defaults" note (config 20 vs retriever 8) becomes "resolved to 5." Does not
add a Tier 1 line (the `search` stanza already says "return coordinates" and
the limit is a Tier 2 parameter).

### Q3: `--contract-addendum` plumbing

**Ordered steps:**

1. **transplant.mjs:4156-4175 (runArms):** Read `options.contractAddendum` as a
   string.

2. **transplant.mjs:1423 (TREE_SYSTEM):** The system text is built by
   `treeSystemTextFor(arm)` which calls `systemContract(version) + QA_ADDENDUM`.
   Instead of modifying the constant, pass the addendum into `buildArm` and
   append it to the system text there:
   ```js
   const system = TREE_SYSTEM + (contractAddendum ? '\n' + contractAddendum : '');
   ```
   File anchor: transplant.mjs:3722 (buildArm), where `TREE_SYSTEM` is used.

3. **transplant.mjs:4263-4276 (identity):** Add a hash of the addendum to
   `identity.invocation`:
   ```js
   contractAddendumSha: contractAddendum ? sha256(contractAddendum).slice(0, 12) : null,
   ```

**Telemetry for Q3 (already present):**
- `turns` array length = turn count per run.
- `turns[].toolCalls` array length = tool calls per turn.
- `status` -- completed vs stalled.

A "mechanism fired" marker: completed runs with turns <= 3 and search-call
count <= 1. A "null result" marker: turns <= 3 and score = 0 (the model
stopped searching early but did not find the answer).

**Tests to run:** `pnpm vitest run` (full suite). No new tests strictly
needed; the addendum is a string append and does not change any handler logic.

**algorithm.md changes if Q3 lands:** A new behavioral line under the
`retrieve on demand` stanza, after the `search:` block:
```
  behavioral: search once; fetch the top-ranked branch; answer from what arrives
```
This replaces no existing line (the contract currently has no opens cap). Tier 2
gets a new row: "opens-per-question cap" with state "measured at W=130k."

---

## 5. WHAT THE QUEUE DOES NOT TEST

1. **Pad content effect.** All runs model the Fable system prompt as a W
   reduction (`--window 130000`), not as actual text in the system prompt.
   Whether the Fable prompt's content (tool instructions, personality, safety)
   interacts with model behavior differently per arm is unmeasured. Testing it
   requires ~43 lines of harness code (A4 Kind 1) and a second batch.

2. **Page-token addressing.** The strongest delta for qo04 (0/30 delivery at
   W=65k because no query centered the band on seq 218). At W=130k with 17k
   headroom, the centering band can cover ~17k tokens of the 57k branch --
   30% instead of 0%. If qo04 still scores 0 at W=130k, page-token is the
   next candidate. Deferred: architectural change (~80 lines in handlers,
   A4 Kind 2).

3. **The full Fable interface composite.** Plan A's 5-arm ablation ladder is
   deferred until the regime shift and hit-count experiments have landed. If
   Q1+Q2 reach a score plateau, the remaining Fable interface variables
   (snippet, fixed-event read, behavioral contract) become the next candidates.

4. **Overflow question set at W=130k.** Only 2/5 overflow-set questions are
   valid at this window (A2 section 1: boundary ~358, overflow seqs 402, 469,
   507 are decayed). The overflow set needs re-cutting via
   `--phase prep-overflow --window 130000` (zero live tokens) before it can
   serve as a second stratum. Not blocking Q1-Q3 (they use the deep set only).

5. **Longer traces.** The s1 trace (196k cl100k) is adequate at eff-W=130k
   (48% outside the tail). A true large-window experiment (W >= 400k) needs
   a 400k+ trace; freezing one costs ~$30-50 live tokens (A2 section 7).

6. **Non-flash models.** Headroom starvation is arithmetic, not
   model-specific. But whether the model exploits the freed headroom (fetches
   the right content, extracts the answer) may differ. A cross-model batch
   after the starvation hypothesis is confirmed is the valid next step, not
   a simultaneous run.

7. **Query construction guidance.** A1 rates this low-to-medium. Offline
   ranking is 5/5 top-3 on the deep set. Deferred until ranking becomes the
   binding constraint.

---

## 6. CORRECTIONS TO PRIOR REPORTS

The A3 audit (analyzer-a3-prior-audit.md) requires the following corrections.
The main loop should apply them as text edits to the cited files.

1. **Status label terminology.** `ds-star-search-centering-and-payload-report.md`
   uses "provider error" in table headers; the JSON field is `model_call_error`.
   Change "provider error" to "model_call_error" in all table headers and prose.
   Counts are correct; only the label is wrong.

2. **Per-question success concentration.** The executive summary of
   `ds-star-search-centering-and-payload-report.md` should note that all 5
   successes across both tree arms occurred on qo03 (branch size 813 tokens,
   small enough to fit through residual headroom). The current summary reports
   scores without noting the concentration. Add one sentence: "All tree-arm
   successes occurred on qo03, whose 813-token answer branch fits through
   residual headroom; the other four questions scored 0 across all 50 tree
   runs."

3. **Stall mechanism.** The three tree-tail-v2 stalls (all qo03) are described
   in the telemetry report but not in the main centering report. Add a
   cross-reference: "Three tree-tail-v2 stalls on qo03 are documented in
   analyzer-iteration2-telemetry.md."

4. **Partial cell tree-search-coordinates count.** The centering report marks
   the partial cell as invalid but does not state that tree-search-coordinates
   has exactly 0 rows. Make this explicit: "The partial cell contains 0
   tree-search-coordinates rows (25 truncate-tail + 2 tree-center-filename)."

5. **naive-full at W=200k reliability.** A2 section 4 correctly notes that
   naive-full at W=200k exceeds the nominal budget (196k + overhead + reply >
   200k). The existing result (25/25) succeeded because the provider accepted
   the overrun (peakRequestTokens 196,575-196,804, usage.input 200,759). Add a
   note to the measurement-hazards section of algorithm.md: "naive-full at
   W=200k runs above budget; the score depends on provider tolerance of
   overruns."
