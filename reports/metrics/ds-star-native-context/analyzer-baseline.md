## Evidence checked

- Report handoff and constraints: [ds-star-delivery-pass-report.md:623](/Users/danielbyrne/GitHub/rpm/context-tree/reports/metrics/ds-star-delivery-pass-report.md:623).
- Algorithm goals and boundary conditions: [algorithm.md:1](/Users/danielbyrne/GitHub/rpm/context-tree/reports/algorithm.md:1), [algorithm.md:192](/Users/danielbyrne/GitHub/rpm/context-tree/reports/algorithm.md:192).
- Arm construction and execution: [transplant.mjs:3650](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3650), [transplant.mjs:4020](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4020), [transplant.mjs:4339](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4339).
- Actual native end-to-end arm: [loop.ts:344](/Users/danielbyrne/GitHub/rpm/context-tree/eval/src/loop.ts:344).
- Deep fixture: [questions-deep.json:1](/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/e1b289c32f40/questions-deep.json:1).
- All deep/overflow result JSONs; offline audits rerun without live tokens:
  - provenance: 200 → 195 successes; five unearned;
  - rank: original 10/12 pass, overflow 3/5 fail, deep 5/5 pass;
  - delivery: 115/145, with qo04 0/30.
- Current code is clean at `4e5d22296573`; current fingerprints are retriever `6cb5ea39ebea`, transplant `f5bacc9694c4`.

## Baseline definition

For this delivery-pass benchmark, “native context” must mean `truncate-tail`: the newest raw events fitting the same W, flat system prompt, no retrieval tools, one-turn answer. That is how the report defines it ([delivery report:31](/Users/danielbyrne/GitHub/rpm/context-tree/reports/metrics/ds-star-delivery-pass-report.md:31)) and how `buildArm` implements it ([transplant.mjs:3655](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3655)).

`naive-full` is not the native baseline. It sends the entire ~196K-token trace without enforcing the tested W ([transplant.mjs:3652](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3652)); below 200K it is deliberately reduced to one precondition run, while at 200K it is ground truth ([transplant.mjs:4131](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4131)).

Scope the eventual claim as “better overflow recall than the raw-tail native proxy.” The repo’s real end-to-end `native` arm is stronger: a growing transcript, normal harness tools, and native prefix caching ([loop.ts:344](/Users/danielbyrne/GitHub/rpm/context-tree/eval/src/loop.ts:344)). A transplant-only win cannot support the broader statement “better than native context” without a later end-to-end native/context-tree validation.

The primary metric should be provenance-audited exact-match task success, expressed as successful scheduled attempts divided by all scheduled attempts, per question and overall. Selection and delivery are mechanism metrics, not the user goal. Counting only non-null graded rows would reward tree stalls; report both completion/stall rate and conditional grading separately.

## Same-epoch status

No existing artifact establishes the requested actual-tree-versus-native claim on the clean deep fixture.

- W=65,536 deep has `tree-tail-v2` but no `truncate-tail`.
- W=131,072 deep pairs `truncate-tail` with `tree-oracle`, which cheats and is explicitly not a scored arm.
- W=200,000 deep contains only the full-transcript ceiling.
- W=65,536 overflow pairs the real arms, but the rank gate fails 3/5, and provenance auditing collapses its raw 4/25 native score to 0/25.
- Existing paired files have no `code` fingerprint. The fingerprinted deep tree files are stale relative to current HEAD: artifact git `9a44f9db91ae`, transplant `4d81e190d7c4` or `663b5a451c69`; current git `4e5d22296573`, transplant `f5bacc9694c4`.

The substrate is also not fully frozen. `assertFrozen` checks trace/store/config/root hashes only ([transplant.mjs:1050](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:1050)). The manifest freezes only `questions.json` SHA `1fbd2a…`; it does not freeze `questions-deep.json` SHA `9ebc315…` or `questions-overflow.json` SHA `e4a04b…`. Result headers likewise omit the selected question-file hash. The local frozen store is gitignored and unavailable to a fresh clone ([delivery report:669](/Users/danielbyrne/GitHub/rpm/context-tree/reports/metrics/ds-star-delivery-pass-report.md:669)).

Two more instrument hazards:

- `runArms` executes complete arm blocks sequentially, not interleaved ([transplant.mjs:4108](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4108)), contrary to the documented “arms interleaved” claim.
- `runVerdict` reads every result JSON and groups only by model/window/arm/stratum, ignoring question set and code epoch ([transplant.mjs:4343](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4343)). It can silently pool incompatible cells, and it does not treat `tree-tail-v2` as the primary `tree` arm.

## Gap decomposition

Raw deep artifacts:

- Full-transcript ceiling, W=200K: `naive-full` 25/25, 25 completed, 25 turns.
- Actual tree, W=65,536: `tree-tail-v2` 7/25, 24 gradable, one stall, 111 turns, 561,937 fresh input, 62,823 output, 6,292,224 cache-read tokens.
- Second tree epoch: again 7/25, but 23 gradable, two stalls, 106 turns, 460,389 fresh input.
- Raw-tail control, W=131,072: `truncate-tail` 0/25, 21 gradable, four turn caps, 25 turns.
- Oracle, W=131,072: 10/25, one stall; diagnostic only.

Against the 25/25 ceiling, current tree leaves 18 points. The verified decomposition is 13 failures at/before delivery (`25 − 12 delivered`) and five after delivery (`12 − 7 scored`); selection was 16/25 but is not nested with delivery. qo04 is the clearest fixable bucket: selected 5/5, delivered 0/5; across all recorded queries it remains 0/30 delivered.

The only actual same-file native/tree cell, overflow W=65,536, shows no win after audit:

- Raw: tree 0/25, truncate-tail 4/25.
- Provenance-audited: tree 0/25, truncate-tail 0/25.
- Tree: 7 stalls, 121 turns, 613,982 fresh input, 6,890,496 cache-read tokens.
- Native: 0 stalls, 25 turns, 733,636 fresh input, 662,464 cache-read tokens.
- Including fresh input, output, and cache reads, tree processed 7,566,581 tokens versus native’s 1,421,479—5.32× as much.

Fixture validity:

- `questions-deep.json` is valid for W≤131,072: ref boundary seq 268, while all five answers are at seq 18–264.
- `questions-overflow.json` is valid only through W=65,536. At W=98,304 and 131,072 it has decayed: 10/23 and 20/22 oracle successes respectively needed no retrieval.
- `naive-full` at 200K is a ceiling, not an overflow comparison.
- The overflow set’s 3/5 rank gate failure makes it unsuitable for diagnosing a delivery-only candidate.

## Required pre-registration

Before any live tokens:

1. Freeze the exact selected question file in the manifest and result header, alongside trace/store/config/root and current code fingerprints.
2. Add output naming that includes candidate flag/config; current naming overwrites parameter sweeps ([transplant.mjs:4103](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4103)).
3. Recompute at the exact claim W that every deep answer is outside the `truncate-tail` payload.
4. Require deep rank gate ≥4/5; current result is 5/5.
5. Require the delivery mechanism gate first: qo04 from 0/N to at least 5/6 of N, no other question’s delivered count lower.
6. Run three arms in one invocation/current epoch: `truncate-tail` native proxy, unchanged `tree-tail-v2` incumbent, and one-change candidate. Equal n≥5 per question and identical model/W/question/store.
7. Primary routing criterion: unconditional provenance-audited success. Preserve the report’s intended improvement magnitude as a same-cell delta: candidate must beat incumbent by ≥4/25, rather than quoting a stale absolute 7→11.
8. User-goal criterion: candidate must also exceed same-cell `truncate-tail`; report absolute percentage-point delta, not relative percentage because native may be zero.
9. Report per-question success, stalls/completion, fresh input, cache read, output, and turns. A qo04 delivery win with no score gain is bucket-win/headline-inert, not goal completion.
10. Do not use `runVerdict` until it keys cells by question-set hash and code epoch.

## Quantified claim

The strongest honest current statement is:

> On one five-question deep-overflow fixture, GLM 5.3 Flash with `tree-tail-v2` answered 7/25 attempts at W=65,536; a separately run raw-tail control answered 0/25 at W=131,072, while the full transcript answered 25/25 at W=200,000. The tree’s 18-point residual splits into 13 failures at/before payload delivery and five after delivery.

That is internal diagnostic evidence only. It does not establish “context-tree beats native context” because the actual tree and native proxy were not measured in the same epoch at the same W, the deep question file is not frozen by the manifest, and the only equal-arm paired cell audits to a 0/25–0/25 tie.
