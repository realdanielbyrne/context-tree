# Panel B judge verdict — roadmap item 3 (the sw-3 extra-turn mechanism)

**Judge:** panel B. **Designs read verbatim:** `B-framing`, `B-harness` (`B-nogate`),
`B-null`. **Analysis re-read:** `eval/plans/loop9b-analysis/05-sw3-overhead.md` in full.
**Live model calls made producing this document: zero.** Every number below was recomputed
by the judge from `eval/results/**/results.json` and from the working tree as it stands
today; where a design's number disagrees with mine, mine is stated and the discrepancy is
named.

Terms used throughout, defined once:

- **Turn** — one `provider.complete()` call, one row in a run's `turns[]`
  (`eval/src/loop.ts:114-131`). A `TurnRecord` carries `index`, `latencyMs`, `usage`,
  `toolCalls` (tool *names* only), and `stopReason`.
- **Batch / fan-out** — the number of tool calls one turn emits, executed serially by the
  harness in a single loop iteration. Both arms execute a batch identically; only the
  model's choice of how many calls to put in a turn differs.
- **`cacheRead`** — the provider's re-read of the already-cached prompt prefix, billed on
  every turn for the whole prefix. It is 93.5% of the sw-3 gap
  (`05-sw3-overhead.md:93`), which is why a turn added at the *end* of a run is the most
  expensive turn a run has.
- **Completion gate** — a tree-arm-only rule (`eval/src/loop.ts:1003-1033`): the first
  tool-call-free reply after any tool work is answered with a nudge and the run continues;
  only a second consecutive bare reply ends it. The native arm returns on the first such
  reply (`eval/src/loop.ts:339-342`). It is an eval-harness rule introduced in "iter 3",
  not a D-numbered decision.
- **Devolved mode** — the state in which the lazy gate has not been crossed, so nothing is
  summarized, Zone B is empty and Zone C is the whole raw trace. sw-3 has never left it
  (`05-sw3-overhead.md:157-167`).
- **Writes per write-bearing turn** — `write_file` calls ÷ turns containing at least one
  `write_file`. `B-framing`'s proposed mechanism statistic.

---

## 0. Two facts about the repository that all three designs missed

Both change the implementation spec, so they come first.

**(a) Roadmap item 1 has already landed in the working tree.** `eval/src/loop.ts:772-781`
now computes `lastPromptTokens` from real provider usage and latches `lazyCrossed`
one-way, replacing the `traceChars / 4` heuristic. All three designs were written against
the pre-item-1 file, which is why every line anchor they cite is roughly 17 lines stale
(they cite the gate at `:986-1009` / `:993`; it is at `:1003-1033`, with the guarded
condition on **`eval/src/loop.ts:1010`**). Use the anchors in §4 below, not theirs.

**(b) The Zone A trim is already built and flagged.** `packages/core/src/prompts/system-contract.v2.md`
exists on disk (v1 minus the "Two ways this goes wrong" section — verified by `diff`, an
18-line deletion and nothing else), `systemContract(version)` validates and selects it
(`packages/core/src/prompts/index.ts:106-134`), the harness reads
`EVAL_CONTRACT_VERSION` (`eval/src/loop.ts:715-727`), and
`packages/core/test/prompts.test.ts:127-140` already pins the v1/v2 relationship. This
retires two proposals: `B-null`'s hypothetical `EVAL_ZONEA_TRIM=1` flag and `B-framing`'s
proposal to *add* a version parameter to `systemContract()`. It also moots `B-framing`'s
"cross-panel finding" that deleting the "Two ways" section breaks three assertions in
`prompts.test.ts:112-120` — true of an in-place deletion from v1, but the repo took the
version-selector route, so the golden test still reads v1 by default and passes.

---

## 1. Scores

Scored 1–5, 5 best. "Simplicity budget" is the judge's own count of the core-algorithm
pseudo-code after the change (the constraint is ≤12 lines); the count is in §7.

| Criterion | `B-framing` | `B-harness` | `B-null` |
|---|---:|---:|---:|
| Fixes the measured mechanism | 3 | 4 | 4 |
| One-variable attributability | 3 | 5 | 5 |
| Simplicity budget (11 lines after change; ≤12 required) | 5 | 5 | 5 |
| D-compliance | 4 | 5 | 5 |
| Zero-token verifiability | 2 | 5 | 5 |
| Expected information per token spent | 3 | 3 | 5 |
| **Total** | **20** | **27** | **29** |

Notes on the two scores that separate the field.

*Fixes the measured mechanism.* The measured mechanism is extra turns paying a re-read tax
(~69.5% of the gap). The completion gate is exactly one of the ~4.5 extra turns, but it is
the **most expensive one**: mean final-turn cost across the six v6.x replicates is
**13,793 tokens** (recomputed: 11,284 / 18,066 / 14,224 / 15,025 / 11,626 / 12,534), which
is **14.1%** of the 98,006-token mean gap and **4.1×** the pre-planned Zone A deletion's
3,362. `B-framing` aims at a larger share (write serialization, ~2 of the extra turns) but
its causal chain is unestablished — see §3. Expected turns removed: gate ≈ 1.0 at
probability ≈ 1.0; framing ≈ 2.0 at a probability I would not put above 0.4.

*Zero-token verifiability.* The gate's entire mechanism is verifiable offline: it is a
deterministic loop rule, `eval/test/loop.test.ts:39` throws `script exhausted — the loop
over-called the model` the moment the loop asks for one reply more than scripted, and the
committed corpus reproduces the fire/rescue ledger with no model. `B-framing`'s deletion is
verifiable offline; its *mechanism* — whether a model batches writes differently without
one sentence — is not verifiable at zero tokens by any means, which is precisely the
"cheap-and-deterministic beats model-driven" ordering the owner set.

---

## 2. Winner: `B-null`

`B-harness` and `B-null` converge independently on the same one change — delete the
completion gate — and `B-framing` itself schedules that same deletion as its arm 4, calling
it "a measurement defect in the control, not a candidate." All three panelists therefore
agree the gate has to go. The judge's job is which package to execute, and `B-null` wins by
a narrow but real margin over `B-harness`.

The change is right for a reason larger than its 11% token saving: **the gate is a validity
defect in the A/B, not merely a cost.** The tree arm is being run under a stopping rule the
native arm does not have. I replayed every `results.json` under `eval/results` (204
context-tree runs): on `sw-3-refactor` the gate fired in **14 of 14** tree runs and changed
the model's behaviour in **0**; all 14 end with two consecutive tool-call-free turns, and
all **5** native sw-3 runs on disk end with one. That is not a distribution, it is a
constant — which is the observation `B-null` §2.4 correctly identifies as the residue the
null hypothesis cannot absorb. While the gate stands, every turn-count arm measures
`its own effect + 1`, and the headline "tree median 13.5 turns vs native 9" is really
"tree 12.5 + a harness rule vs native 9."

`B-null` beats `B-harness` on four things, each of which I verified:

1. **It corrects the analysis report's premise.** `05-sw3-overhead.md:73,344,398` carries
   the published 3.4× with a "different collection dates" caveat. `B-null` shows the caveat
   is wrong (all twelve `*-diverse` files were written inside one afternoon) and that the
   real confound is *configuration*: `eval/results/v57-diverse/*/results.json` each contain
   **both** arms from one invocation (verified — `run.ts:129-132` interleaves arms per
   scenario). On that genuinely same-epoch pair the tree medians are 75,477 tokens and 10
   turns against native's 35,561 and 9 — **2.12× and 1.11×**, not 3.40× and 1.50×. The
   published gap is partly a v5.7→v6.x regression, and item 3 should be read that way.
2. **It tried rule *replacement* before rule removal**, which is the owner's stated
   ordering, and reported the failure honestly: a predicate firing the nudge only when the
   last tool call was not a `run_command` is silent on 21 of 21 rescues — zero
   discriminative power, and `turns[]` records only tool names, so no richer predicate is
   testable offline. A design that shows why the cheaper option does not exist is worth more
   than one that never looks.
3. **It buys information the batch would otherwise not get, for free.** Arms A and B must
   run anyway; `B-null` §7.2 pre-registers two tests on them — an F-test on turn dispersion
   (native n=3 with turns 8/9/9 carries essentially no dispersion information, so the
   report's bimodality claim at `05-sw3-overhead.md:235` is currently *unfalsifiable, not
   supported*) and an exact Mann–Whitney on batching density with a stated decision rule.
   That converts the open question Lens 5 left dangling into a decidable one at zero
   marginal cost. `B-harness` spends the same dollars and asks no such question.
4. **Its pseudo-code is the shortest and it pre-commits the successor hypothesis** (the
   `renderEvent` rendering asymmetry) without running it, so the "one measurable change per
   candidate" rule holds without the idea being lost.

Where `B-harness` is better, I graft it (§3). Where `B-null` is wrong, I correct it: its
corpus ledger says "152 fires, 21 rescues"; my replay gives **185 fires, 23 rescues** out of
204 tree runs — `B-harness`'s "204 runs / 23 rescues" is the accurate count. Its sw-3 line
(14 fires, 0 rescues) is right in both designs and is the line the decision rests on. It
also says native has 3 sw-3 runs; there are 5 on disk.

---

## 3. Grafts from the losers

**From `B-harness`:**

1. **The harness-asymmetry audit (§3, rows A–J), grafted whole as the record of what was
   ruled out.** Its negative result is the load-bearing part: there is *no* mechanism in
   either loop that makes a parallel batch harder to issue, execute, or render — both arms
   pass the same `tools` array shape, execute every returned call, and feed every result
   back before the next turn. That converts "the tree batches less" from a possible harness
   bug into a model-behaviour or rendering question, which is what licenses spending the
   next candidate on rendering rather than on plumbing. Reason: it is the only systematic
   audit in the panel and it forecloses four hypotheses cheaply.
2. **Its corpus ledger numbers (204 / 23) over `B-null`'s (152 / 21).** Reason: they
   reproduce; `B-null`'s do not.
3. **The `ScriptedProvider` falsifier framing.** "Remove one scripted bare reply; if the
   loop still demands a second one, `eval/test/loop.test.ts:39` throws" is a sharper offline
   gate than `B-null`'s "assert `modelTurns === 2`", because it fails loudly on the exact
   failure mode rather than on a count. Reason: fail-loud beats assert-equal.
4. **The fallback if reliability breaks:** narrow the gate to non-devolved mode
   (`!belowLazyK`) rather than deleting it, where its stated precondition still holds.
   Reason: it preserves the rescue behaviour on `sw-1`/`sw-2` without reopening the sw-3
   tax.

**From `B-framing`:**

5. **The per-action batching decomposition, grafted as a pre-registered observable — not
   as the candidate.** I recomputed its table and it is exactly right: on the six v6.x
   replicates, read fan-out survives in the tree (max parallel `read_file` = 6, 7, 7, 7, 7,
   and 0 in the run that read via `cat`) against native's 8/8/8, while write fan-out
   collapses (writes per write-bearing turn 5.00 / 2.50 / 1.67 / 2.50 / 1.20 / 1.20, mean
   2.35, against native's 5.00 with **zero variance across all three replicates**). This is
   a genuine measurement the analysis report never made, and every arm should log it.
   Reason: it is the sharpest available discriminator for whether a later framing arm
   worked.
6. **The gate's deliverable degradation.** I verified and can strengthen it: in **5 of 12**
   tree sw-3 runs the gate's second reply is a 5-output-token stub replacing a 152–463-token
   substantive reply (`v57-rep1` 366→5, `v57-rep2` 152→5, `v60-rep3` 444→5, `v61-rep2`
   183→5, `v61-rep3` 419→5), and `finalText` is the stub. On sw-3 this costs nothing because
   the judge grades hidden tests on the filesystem (`judge.detail` is a test-catalog exit
   code, not a text grade), so the honest claim is narrower than `B-framing`'s: the gate
   degrades the *deliverable*, not the *score*, on this scenario. Reason: it is a second,
   independent argument for removal, and it must be stated at its true strength.
7. **The idea of naming the successor hypothesis with its rejection reason** — `B-framing`
   §4 rejects `renderEvent` grouping and records it as the next candidate; `B-null` §7.3
   pre-commits the same thing. Grafting the union: `renderEvent` (`packages/core/src/assemble/format.ts:130-166`)
   prints a `### tool_call` block and a separate `### tool_result for seq N` block per call
   and **never prints `parent_seq`**, even though `eval/src/loop.ts:1041` records it — so a
   six-call parallel batch is byte-identical in Zone C to six sequential single-call turns,
   while native keeps a batch's results contiguous behind one assistant message
   (`eval/src/loop.ts:338,342-345`). The data to group by already exists; the follow-up is a
   *replacement* of one render rule by another, not an addition. Reason: it is the strongest
   remaining candidate and it costs nothing to record now.

**Why `B-framing` is not the winner, stated precisely.** Its mechanism statistic is
sample-selected. Over the six v6.x replicates it chose, Spearman ρ between
writes-per-write-turn and turns is **−0.883** (its reported 0.89). Over **all twelve** tree
sw-3 runs on disk — same scenario, same contract text, same `system-contract.v1.md` Rule 1
in every one — ρ falls to **−0.483** (and −0.626 against tokens), while turns↔tokens holds
at **+0.907**. The counterexample is decisive: `v59-diverse/v59-div-rep1` writes all five
files in a single turn (`t5: write_file ×5` — native-equal batching, the exact outcome
`B-framing` predicts its deletion will buy) and still runs **18 turns for 146,615 tokens,
4.12× native's median**, because its extra turns are ten consecutive `run_command` turns
after the write. Write-batching parity is therefore *not sufficient* for turn parity, which
also falsifies `B-framing` §10's ceiling argument (built on `v60-div-rep1` alone). The
candidate may still be right; it is not evidenced well enough to spend the batch's one
attributable variable on before the null test in §5 says there is a framing effect to chase.

---

## 4. Ordered implementation spec

Execute in this order. Steps 1–6 spend zero tokens and must all pass before step 7.

### Step 1 — Confirm the starting tree

Roadmap item 1 (`eval/src/loop.ts:772-781`, real-token lazy gate with the one-way
`lazyCrossed` latch) and item-3 step 1 (`EVAL_CONTRACT_VERSION`, `system-contract.v2.md`)
are present but **uncommitted**. Commit them, or record the exact working-tree hash in the
run manifest, before any arm runs. Every arm below runs on that one epoch.

### Step 2 — The one change: flag the completion gate

**File:** `eval/src/loop.ts`. **Nature:** rule removal (a tree-only rule native never had).
**Arm name:** `no-gate`. **Flag:** `EVAL_NO_COMPLETION_GATE=1`.

*Before* — `eval/src/loop.ts:1010`:

```ts
        if (toolWorkDone && !completionConfirmed) {
```

*After* — `eval/src/loop.ts:1010`, replacing that one line:

```ts
        // loop9b-item3 (EVAL_NO_COMPLETION_GATE=1): the gate is a tree-only
        // stopping rule the native arm never had (native returns on the first
        // bare-text reply, loop.ts:339-342), so while it stands every tree
        // turn-count number is `the arm's effect + 1`. Corpus replay over
        // eval/results: 204 tree runs, 185 fires, 23 rescues; on sw-3-refactor
        // 14 fires and 0 rescues, at a mean 13,793 tokens — the run's most
        // expensive turn, because cacheRead bills the whole prefix and that
        // turn carries the largest prefix the run ever has.
        if (toolWorkDone && !completionConfirmed && process.env.EVAL_NO_COMPLETION_GATE !== '1') {
```

Nothing else changes. `toolWorkDone` / `completionConfirmed` (`eval/src/loop.ts:911-912`)
stay declared so the unflagged path is byte-identical to today's baseline; under the flag
they are inert. Ship form, if the batch passes: delete `eval/src/loop.ts:1010-1026` and the
two declarations, leaving a branch byte-identical to native's at `:339-342`.

### Step 3 — Harness logging to add (all derived, no new capture)

`turns[].toolCalls` already records per-turn tool *names*, so every statistic below is a
pure function of data the harness already writes. Add them to the run's `metrics` object so
they are first-class and no replay script is needed to read a result:

```ts
metrics.batching = {
  trailingBareTurns,           // turns at the tail with zero tool calls
  gateFired,                   // the nudge was emitted at least once
  gateRescued,                 // the turn after the first bare reply issued tool calls
  callsPerToolUsingTurn,       // total calls / turns with >=1 call  (the corrected density)
  callsPerTurn,                // total calls / all turns            (the report's 1.49 vs 2.77)
  writesPerWriteBearingTurn,   // write_file calls / turns containing >=1 write_file
  maxReadBatch, maxWriteBatch, // largest single-turn fan-out per action
  runCommandOnlyTurns,         // turns whose only calls are run_command
};
metrics.lazyCrossed = lazyCrossed;   // item 1's latch; already written to stderr at loop.ts:775
metrics.finalTextChars = finalText.length;
```

`callsPerToolUsingTurn` is `B-null`'s correction and matters: dividing by *all* turns mixes
the batching question with the trailing-empty-turn question this change is about.
`lazyCrossed` is mandatory — it is the only way to know whether arm B is still measuring the
devolved-mode configuration all published sw-3 numbers describe.

### Step 4 — Zero-token gates (all must pass; no live run otherwise)

1. **New case in `eval/test/loop.test.ts`**, sibling to the existing gate test at `:382-397`.
   `vi.stubEnv('EVAL_NO_COMPLETION_GATE','1')`, script `[...agentReplies]` — the trailing
   `confirmReply` (`:375-381`) **removed**. Assert `status === 'completed'` and
   `result.metrics.turns.modelTurns === 2` (the gated run is 3, `:396`). If the loop still
   demands a second bare reply, `ScriptedProvider` throws `script exhausted — the loop
   over-called the model` (`:39`) and the test fails loudly rather than silently passing.
2. **Assert the negative:** with the flag set, the L0 trace contains no `user_message`
   event whose blob matches `you stopped calling tools` (mirror of the existing assertion
   at `:594-597`).
3. **Baseline byte-identity:** the existing test at `:382-397` passes untouched with the
   flag unset. This is what makes arm B a valid same-epoch baseline.
4. **Metrics-derivation unit test:** a synthetic `turns[]` fixture with a known shape
   (e.g. `[1 call, 5 writes, 0, 0]`) asserting each field in `metrics.batching`.
5. **Corpus replay script, committed, read-only, no model:** `eval/scripts/gate-ledger.mjs`
   over `eval/results/**/results.json`, asserting the four numbers this decision rests on —
   204 tree runs, 185 gate fires, 23 rescues; on `sw-3-refactor` 14 fires, 0 rescues, 14/14
   runs with two trailing bare turns and 5/5 native runs with one; mean final-turn total
   across the six v6.x replicates = 13,793. It fails if any of these drift.
6. **Existing suites green:** `pnpm vitest run eval/test/loop.test.ts` and
   `pnpm vitest run packages/core/test/prompts.test.ts` (the latter already pins the v1/v2
   contract relationship used by arm C).

### Step 5 — Arms

Frozen `s1` store; no summaries regenerated mid-scenario. Scenario: `sw-3-refactor` only.
Model: **`claude-sonnet-5`** for every arm — the 121,012 / 35,561 / 13.5 / 9 figures the
criterion is written against are sonnet-5 numbers (`05-sw3-overhead.md:63-64`), and an arm
on another model cannot be compared to them. The true-small-window anchor cell
(`qwen/qwen-2.5-72b-instruct` at W=32768) is deliberately **not** used here: this is a
turn-count measurement against loop 8's own baseline, not a window-pressure measurement.
The prediction for arm D is model-independent (it is a loop rule), so it can be confirmed
for free later by counting trailing bare turns in qwen runs made for other purposes.

| Arm | Config | n | Purpose |
|---|---|---:|---|
| A | `native`, unchanged | 5 | fresh same-epoch baseline; **first measurement of native's turn dispersion** |
| B | `context-tree`, all flags at v6.x defaults | 5 | fresh same-epoch tree baseline on item-1 code |
| C | B + `EVAL_CONTRACT_VERSION=v2` | 5 | prices the already-built Zone A trim |
| D | B + `EVAL_NO_COMPLETION_GATE=1` | 5 | **the candidate** |
| E *(optional, diagnostic, not a candidate)* | `context-tree` in the v5.7 config | 5 | is the published gap partly a v5.7→v6.x regression? |

Arm E is explicitly **multi-variable** (v5.7→v6.x changes four ingredients at once) and is
labelled a reference cell, not an experiment. It is included because the same-epoch v57 pair
puts the v5.7 tree at 2.12× native where v6.x sits at 3.40×, and that question is worth
$0.35. It is the first thing cut if the cap binds.

**Run by replicate, not by arm** — running all of one arm then all of another is exactly the
ordering that produced the v57→v59→v60→v61 artifact `B-null` §2 diagnoses:

```
for rep in 1 2 3 4 5; do
  node dist/run.js --benchmarks deepswe-agents-last-exam --scenarios sw-3-refactor \
    --arms native,context-tree --model claude-sonnet-5 --cost-cap-usd 0.25 \
    --run-id l9b-i3-AB-rep$rep --out eval/results/l9b-item3
  EVAL_CONTRACT_VERSION=v2      node dist/run.js … --arms context-tree --run-id l9b-i3-C-rep$rep …
  EVAL_NO_COMPLETION_GATE=1     node dist/run.js … --arms context-tree --run-id l9b-i3-D-rep$rep …
done
node eval/scripts/ct-stats.mjs --json eval/results/l9b-item3/stats.json eval/results/l9b-item3
```

Arms A and B come from one invocation per replicate, which is how `v57-diverse` got both
arms into one file (`eval/src/run.ts:129-132`).

**No combined C+D arm.** Their interaction is arithmetic, not empirical: C removes ~246
tokens from every turn, D removes the last turn, so the combined saving is
`13,379 + 246 × (T − 1)` ≈ 16,400 at T = 13.5, giving ≈104,600 (2.94× native). If the
combined config is ever run it must land within ±10% of that; spending $0.45 to confirm
arithmetic is not information.

### Step 6 — Cost

Metered `metrics.costUsd` from the existing runs: native mean **$0.0511** (n=3), tree v6.x
mean **$0.0920** (n=6, range $0.065–$0.129), tree v5.7 mean **$0.0699** (n=3). These
already include the judge call, which the cost meter bills.

| Arm | per run | n | subtotal |
|---|---:|---:|---:|
| A native | $0.051 | 5 | $0.26 |
| B tree baseline | $0.092 | 5 | $0.46 |
| C tree − Zone A | $0.089 | 5 | $0.45 |
| D tree − gate | $0.082 | 5 | $0.41 |
| **core total (A–D)** | | **20** | **≈$1.58** |
| E v5.7 reference *(optional)* | $0.070 | 5 | $0.35 |
| **total with E** | | **25** | **≈$1.93** |

**Per-PR cost-meter cap: $2.50.** Per-run hard stop `--cost-cap-usd 0.25` (the right-tail
risk is a 20-turn replicate like `v60-div-rep2` at $0.129). For scale, loop 7 metered
$20.76 across 121 runs.

---

## 5. Pre-registered predictions

Every prediction names the mechanism it rests on and the single result that kills it.
Report in this order: the null test first, then the mechanism statistic, then tokens.

### 5.1 Arm D (the candidate) vs arm B, paired per replicate

| Quantity | Prediction | Mechanism | Falsifier |
|---|---|---|---|
| trailing bare turns in D | exactly **1** in 5/5 runs | `completionConfirmed` is a latch, so the gate adds at most one turn | any D run with 2 ⇒ flag mis-wired (should already have failed §4.1) |
| turns, D vs B | **exactly −1** per paired replicate | the gate is a tail rule; it cannot reach turns before the first bare reply | a median shift ≠ −1.0 ⇒ removing the gate changed the trajectory, not just the tail; re-analyse before shipping |
| tokens, median | **−13,379** ⇒ 121,012 → **≈107,600**, i.e. 3.40× → **3.03×** of native | the removed turn re-reads the full accumulated prefix; measured median final-turn cost across v6.x = 13,379 | median saving **< 8,000** ⇒ the removed turn cost less than the cheapest ever observed (10,489); the decomposition in §2 is wrong |
| batching density | ≈ unchanged (1.49 → ~1.54 calls/turn; `callsPerToolUsingTurn` flat) | the gate only removes a zero-call turn from the denominator | a jump toward native's 2.77 ⇒ the gate was shaping the whole trajectory — a bigger result than predicted; report it, do not absorb it |
| success | **5/5**, unchanged from B | the removed rule has rescued 0 of 14 sw-3 runs | any D failure whose paired B run succeeded ⇒ **hard stop**; fall back to `B-harness`'s narrowing (fire the gate only when `!belowLazyK`) |
| `finalTextChars` | D's final reply is the substantive one (152–463 output tokens historically), not a 5-token stub | the stub is the gate's second reply | D showing stub finals ⇒ the degradation has another cause |

### 5.2 Arm C (Zone A trim), already-built plumbing

Predicted −246 tokens/turn × turns ≈ **−3,321** at the published median, ⇒ ≈117,700
(3.31×), with **turns unchanged**. Mechanism: a byte cut in a prefix billed once per turn.
Falsifier: a turn-count change in either direction means the deleted prose was doing
behavioural work, and the "free and zero-risk" characterization at `05-sw3-overhead.md:290`
is wrong.

### 5.3 Arm B vs the published baseline — the item-1 sanity check

Predicted: `lazyCrossed === false` on 5/5 arm-B runs, and arm B's median within ±20% of
121,012. Mechanism: sw-3's largest observed prompt is ≈18k tokens, below the 30k lazy
threshold, so the real-token gate should keep sw-3 devolved exactly as the `traceChars/4`
heuristic did. Falsifier: any arm-B run with `lazyCrossed === true` means item 1 moved sw-3
into a different configuration and **every cross-loop comparison in this document must be
re-anchored to arm B** before anything is claimed.

### 5.4 The null test (arms A vs B), pre-registered — `B-null` §7.2

Both statistics are computed **after** subtracting D's deterministic gate turn from B, so
the framing question is asked only about the part of the gap the gate does not explain.

1. **Turn dispersion.** `F = s²(turns, tree) / s²(turns, native)`, n=5 vs 5, one-sided,
   `F_crit(4,4; α=.05) = 6.39`. The null (uncontrolled temperature on a common process)
   predicts F ≈ 1; a systematic effect that bifurcates behaviour predicts F ≫ 1. This is the
   statistic the existing data cannot supply: native n=3 (turns 8, 9, 9; s = 0.58) carries
   almost no dispersion information, so the bimodality claim at `05-sw3-overhead.md:235` is
   at present **unfalsifiable rather than supported**.
2. **Batching density.** Exact two-sided Mann–Whitney U on `callsPerToolUsingTurn`, n=5 vs
   5 (minimum attainable p = 2/252 = 0.0079, so n=5 *can* reach significance under complete
   separation), reported with the Hodges–Lehmann median difference and its exact CI.
   - **p < 0.05 and HL difference ≤ −0.5 calls/turn** ⇒ a systematic framing effect is
     established; the pre-committed next candidate is the `renderEvent` grouping
     replacement (§3, graft 7), **not** a prompt-rule edit and **not** a batching nudge.
   - **p ≥ 0.05, or the 95% CI on the tree/native ratio includes 1.0** ⇒ not established.
     Stop spending on batching; the residual is per-turn prefix size (Zone A 1,957 vs 375
     tok/turn) and the Zone A family is the whole remaining lever.
   Prior: the same-epoch v57 ratio is 0.855 (not significant at n=3); the cross-config ratio
   is 0.600.
3. **Secondary observable, reported but not decisive:** `writesPerWriteBearingTurn`
   (`B-framing`'s statistic). Control 2.35, native 5.00 with zero variance. Pre-registered
   with the honest caveat that its correlation to turns is ρ = −0.883 on the six replicates
   `B-framing` selected but only **−0.483 across all twelve** tree sw-3 runs, and that
   `v59-div-rep1` achieves native-equal write batching at 18 turns. At n=5 it resolves only
   near-complete separation; a value between 3.0 and 3.5 is "indeterminate", not a
   direction.

### 5.5 The published criterion

`reports/metrics/loop8-interim.md:151` asks for tree tokens within **1.5×** of native with
no reliability loss. **No arm in this batch reaches it, and the batch should be reported as
a mechanism test rather than a run at the bar.** Predicted best case in this batch is arm D
at ≈3.03×; D plus C is ≈2.94×. Say so up front rather than projecting favourably.

---

## 6. Verification checklist

Zero-token, in order — nothing live runs until all six are green:

- [ ] Item 1 and item-3 step 1 committed (or the working-tree hash recorded in the manifest).
- [ ] `EVAL_NO_COMPLETION_GATE=1` case in `eval/test/loop.test.ts`: `modelTurns === 2`,
      `status === 'completed'`, `ScriptedProvider` does **not** throw.
- [ ] Negative assertion: no `user_message` L0 event matching `you stopped calling tools`
      under the flag.
- [ ] Existing gate test (`eval/test/loop.test.ts:382-397`, `modelTurns === 3`) passes
      untouched with the flag unset.
- [ ] `metrics.batching` derivation unit test green on a synthetic `turns[]` fixture.
- [ ] `eval/scripts/gate-ledger.mjs` reproduces 204 / 185 / 23 corpus-wide and 14 / 0 /
      14-of-14 on sw-3, plus the 13,793 mean final-turn total.
- [ ] `pnpm vitest run eval/test/loop.test.ts` and
      `pnpm vitest run packages/core/test/prompts.test.ts` green.

Live batch, in order:

- [ ] Arms run by replicate (`rep1: A,B → C → D`, then rep2 …), never by arm.
- [ ] `lazyCrossed === false` on 5/5 arm-B runs; if not, re-anchor before interpreting.
- [ ] Success is **5/5 on every arm**. Any failure is a hard stop on that arm's change
      regardless of tokens.
- [ ] D's per-replicate turn count is exactly one below its paired B run.
- [ ] `--cost-cap-usd 0.25` per run honoured; batch total under the $2.50 cap.
- [ ] Report order: null test (§5.4) → mechanism statistics → tokens → the explicit
      statement that 1.5× was not reached.

---

## 7. The core algorithm after the change (11 lines)

The tree arm's loop, counted by the judge. The change **removes** a line rather than adding
one, and line 6 becomes byte-identical in intent to the native arm's `eval/src/loop.ts:339-342`.

```
1  append user_message(task)
2  for turn in 0 .. maxTurns:
3      prompt = assemble(Zone A | Zone B in creation order | Zone C active branch | fetch tail)
4      result = model(prompt, tools)
5      append assistant_message(result.text)
6      if result.toolCalls is empty: return completed(result.text)   # was: nudge once, then return
7      for call in result.toolCalls:
8          outcome = guard(call, execute(call))
9          append tool_call(parent_seq = assistant) ; append tool_result
10     maybeResummarize()
11 return turn_cap
```

**11 lines, within the ≤12 budget, one line shorter than before.** Constraint compliance:

- **§9 MCP surface** — untouched. Four tools, no widened parameters, no fifth tool. The
  change is in `eval/src/loop.ts`, not `packages/mcp`.
- **D5** — untouched and strictly favourable. Zone A text, Zone B creation order, Zone C
  rewriting and the fetch-after-Zone-C tail are unchanged; for every turn that still
  happens the cached prefix is byte-identical to the baseline. The nudge was appended at
  the *end* of Zone C (`eval/src/loop.ts:1017`), so removing it shortens the suffix and can
  never move Zone A or reorder Zone B.
- **D15** — untouched; ingestion gains and loses no network call.
- **Rule-removal beats rule-addition** — this is a deletion, and `B-null` §3.5 documents
  the failed search for a cheaper *replacement* predicate before proposing it.
- **No D-numbered deviation is claimed.** The completion gate exists only in the eval
  harness and is documented in-code as an "iter 3" fix; it appears nowhere in
  `IMPLEMENTATION_PLAN.md` §3.

---

## 8. What this pass does not test

Stated plainly, because each of these will otherwise be read into the result.

1. **It does not reach the 1.5× criterion and cannot.** Best case in this batch is ≈3.03×
   (arm D), ≈2.94× with the Zone A trim. Roughly 78% of the median gap survives.
2. **It does not fix the write-serialization or the `run_command` cadence** — the other
   ~3.5 extra turns, worth roughly 55,000 of the 98,006-token mean gap. `B-framing`'s
   candidate for the first half is deferred pending §5.4's null test; the second half has no
   candidate at all yet. `v59-div-rep1` shows the two are separable: native-equal write
   batching, 18 turns, ten trailing `run_command` turns.
3. **It does not explain the bimodality** (best tree replicate 1.76×, worst 6.09×). The gate
   costs exactly one turn in the 8-turn replicate and in the 19-turn one; the spread lives
   entirely in the serialized middle. §5.4's F-test only establishes whether the spread is
   real, not what causes it.
4. **It does not license removing the gate outside sw-3.** Corpus-wide the gate rescued 23
   of 185 fires, and 21 of those 23 are on `sw-1-jsonc` (11 of 46) and `sw-2-multimod` (10
   of 74). A 5/5 sw-3 pass licenses the change for sw-3/sw-4/sw-5 only; shipping it globally
   requires a confirmation batch on sw-1 and sw-2 with success rate as the sole criterion.
   And `B-null` §3.5 shows no deterministic predicate over the recorded turn features
   (`toolCalls` holds names only) separates rescue from waste, so "keep it only where it
   helps" is not available as a cheap rule.
5. **It does not test whether the tree ever helps on sw-3.** sw-3 has never crossed the lazy
   gate, so Zone B is empty and Zone C is the whole raw trace — the tree arm is
   native-plus-Zone-A by construction on this scenario. Every arm here attacks the tree's
   *overhead when it is not helping*. The 1.5× criterion should be argued on a scenario
   where the gate actually crosses, or restated.
6. **It does not test the `renderEvent` rendering hypothesis** (§3, graft 7), which is the
   pre-committed successor and would be a Zone C content change with real D5 cache
   consequences — a different candidate with a different risk profile, not a rider.
7. **It does not test any of this on the true-small-window anchor cell**
   (`qwen/qwen-2.5-72b-instruct`, W=32768) or on any model other than `claude-sonnet-5`. The
   −1-turn prediction is a loop rule and should transfer; the token totals will not.
8. **It cannot settle the framing hypothesis at n=5.** A null result in §5.4 is "not
   established", never "disproved", and must be reported as such.
