# Search centering and payload delivery: DS-STAR iteration report

Context-tree retrieval · September 4, 2026

## Executive summary

This pass resumed the delivery investigation with two experimental algorithm changes. The
first corrected within-branch centering for bare filenames. The second removed redundant,
oversized search-result data while preserving the full ranking. Neither change has been
promoted to production behavior.

All five tree-arm successes in the completed cell occurred on qo03, whose 813-token answer branch
fits through the residual headroom; the other four questions scored 0 across all 50 tree runs.

The completed live cell showed that search ranking and centering can be correct while the
fetch still delivers zero bytes: a 20-hit search response consumed 77--92% of the space
available for tool results. The compact-search candidate reduces representative responses
from 6.1--7.3k to 1.2--1.4k exact tokens and passes every offline readiness gate. Its live
arm did not run before the user stopped experimentation, so its efficacy remains unproven.

Absolute results at W=65,536 may also be below a viable context floor. The tree reaches its
first tool turn near 62k tokens, leaving only ~7.9k for all search and fetch traffic. The
next valid experiment, if resumed, is a same-epoch comparison between full native context
and the improved tree at W=200,000 or higher.

## 1 Scope and method

This was a DS-STAR Mode 1 pass on the frozen `s1` deep-overflow fixture using
`z-ai/glm-5.3-flash`. Fresh analysis, planning, judging and verification roles separated
measurement from implementation. Candidate behavior and win thresholds were preregistered;
stalls and model_call_errors remained in the unconditional denominator.

The pass followed two failure buckets:

1. The selected branch was correct, but within-branch narrowing centered on an early generic
   match rather than the answer event.
2. Once centering was corrected, search-result payloads exhausted the append budget before
   the answer-bearing fetch could be delivered.

## 2 Iteration 1: bare-filename centering

The old centering extractor reduced the qo04 query to generic `JSONL`, centering the selected
branch on sequence 55 instead of the answer at sequence 218. The experimental
`tree-center-filename` arm recognizes unquoted dotted filenames only during within-branch
centering. Branch ranking remains byte-identical.

Offline replay moved qo04 delivery from 0/5 to 5/5. The completed live cell was collision
proof and contained 75 scheduled rows with `partial:false`:

| arm | unconditional exact match | completed | stalled | model_call_error | delivered literals |
|---|---:|---:|---:|---:|---:|
| `truncate-tail` | 0/25 | 25 | 0 | 0 | 0 |
| `tree-tail-v2` | 1/25 | 21 | 3 | 1 | 1 |
| `tree-center-filename` | 4/25 | 23 | 0 | 2 | 4 |

The +3/25 improvement missed the preregistered +4 threshold, and qo04 remained 0/5. All
four candidate successes occurred on qo03, where the centering change did not fire. The
candidate therefore did not win and was not escalated. The provenance audit left all four
successes earned. The three `tree-tail-v2` stalls (all qo03) are documented in
`reports/metrics/ds-star-native-context/analyzer-iteration2-telemetry.md`.

Completed result:

`eval/fixtures/transplant/s1/e1b289c32f40/results/run-W65536-truncate-tail+tree-tail-v2+tree-center-filename-questions-deep-q9ebc3150-cb2b5adc512bc-n5-z-ai_glm-5.3-flash.json`

## 3 The measured search-delivery defect

In the completed cell, the first 20-hit search consumed 6,094--7,257 of only 7,886--7,919
available tokens. Across the two tree arms, 77/88 fetches began with non-positive headroom;
every one returned zero bytes.

On qo04, the filename candidate selected the correct rank-1 branch and center 218 in all
four observable attempts, but the answer-bearing fetch was capped away. All five delivered
literals in the pair occurred on qo03, and all five scored. This cell therefore contains no
observed extraction failure after literal delivery; its dominant failure is before or at
delivery.

The payload was large for two avoidable reasons:

- tree evidence appeared in both `hits` and `candidates`;
- each supposed pointer could carry dozens of full file-span metadata records.

## 4 Iteration 2: all-rank coordinate search

The obvious fixed top-k response was rejected. Mapping actual live search queries—not the
benchmark question text—to their source branches produced first-search ranks
`[1,2,7,1,1]`. Top-3 would erase qo03, the only bucket that delivered. Reducing the internal
`retrieval.limit` was also not equivalent to display truncation because it changed beam
traversal and produced non-prefix-stable results.

The selected `tree-search-coordinates` candidate keeps the configured 20-result ranked pool,
order and scores, but projects each model-visible hit to:

`{node_id, kind, title, phase_type, path, score}`

It removes the duplicate tree `candidates` view. Representative search responses fall from
6.1--7.3k to 1.2--1.4k exact tokens while retaining all ranks, including qo03 at rank 7.
This implements the classical retrieval separation the old response violated: search
returns compact coordinates; fetch returns content.

The machine-readable readiness artifact records eight PASS gates (`NC20`--`NC27`): frozen
epoch, live-rank audit, one-change parity, serialization, ordered headroom replay,
boundaries, post-cap provenance and live readiness. Ordered replay delivered qo04 in all
4/4 observable prior sequences at center 218 and preserved qo03 delivery. This is mechanism
evidence, not a live score.

## 5 Stopped live batch

The iteration-2 live batch was stopped on request before the improved arm ran. Its artifact
is retained for audit with `partial:true`:

- 27/75 scheduled rows were written;
- `truncate-tail`: 25 rows, 0 successes;
- `tree-center-filename`: 2 rows, 0 successes;
- `tree-search-coordinates`: 0 rows — the partial cell therefore contains no evidence at all for the
  candidate arm (25 truncate-tail + 2 tree-center-filename rows only);
- recorded spend: $0.05677.

It is invalid for comparing arms and contributes no efficacy evidence.

Partial result:

`eval/fixtures/transplant/s1/e1b289c32f40/results/run-W65536-truncate-tail+tree-center-filename+tree-search-coordinates-questions-deep-q9ebc3150-c63c1c243bf7b-n5-z-ai_glm-5.3-flash.json`

## 6 Context-floor limitation

The low absolute scores at W=65,536 do not establish the algorithm's general floor. At this
window the tree enters its first tool turn near 62k tokens and has only ~7.9k left for all
retrieval traffic. The raw-tail proxy's 0/25 result is therefore a constrained-window stress
result, not a fair full-native verdict.

Historical `naive-full` at W=200,000 scored 25/25, but it is not a same-epoch control for
these changes. It also ran above budget: the 196,385-token transcript plus system text and reply
exceeds 200,000, and the score depends on the provider having accepted the overrun
(`peakRequestTokens` 196,575-196,804, `usage.input` 200,759). Superiority to native context remains unproven until both systems run in one
floor-safe, equal-n batch.

## 7 Code and verification state

- `16902c3` — filename-only centering experiment, fetch telemetry and collision-proof result
  identity.
- `a3eb95e` — completed iteration-1 artifact, independent analysis and iteration-2
  preregistration.
- `1aa9ec0` — all-rank coordinate search arm and zero-token readiness gate.
- Full suite: **970 passed, 9 skipped, 0 failed**.
- `G7-tool-call-logging`: PASS with ordered search/fetch and post-cap delivery fields.
- Deep rank gate: 5/5 top-three on benchmark questions; actual live-query ranks are reported
  separately above.
- `pnpm build` still encounters the unrelated pre-existing error at `eval/src/run.ts:104`:
  `HarnessOptions` is missing `timeCapMs`. The core build and all tests pass.

Supporting artifacts:

- `reports/metrics/ds-star-native-context/iteration1-preregistration.md`
- `reports/metrics/ds-star-native-context/analyzer-iteration2-telemetry.md`
- `reports/metrics/ds-star-native-context/plan-iteration2-ir.md`
- `reports/metrics/ds-star-native-context/judge-iteration2.md`
- `reports/metrics/ds-star-native-context/iteration2-preregistration.md`
- `reports/metrics/ds-star-native-context/iteration2-readiness.json`

## 8 Decision and next valid experiment

The search algorithm has a concrete, gated improvement but no completed live evidence. Do
not use the partial file, pool the +3/25 filename result into the compact-search candidate,
or claim superiority to native context.

If experimentation resumes, run `naive-full` and `tree-search-coordinates` together at
W=200,000 or higher using the same frozen questions, code epoch, model and equal scheduled
n. Include `tree-center-filename` only if attribution to compact search is still required.
Pre-register both an absolute performance floor and superiority to same-epoch native, and
report literal delivery separately from exact-match answering. Repeat on a second scenario
before making a general claim.

*Corrected 2026-09-04 by the Fable-interface pass after an adversarial re-derivation of every figure above (`reports/metrics/ds-star-fable-interface/analyzer-a3-prior-audit.md`): status label, success concentration, stall cross-reference, partial-cell row count, and the naive-full budget note. All numeric claims reproduced.*
