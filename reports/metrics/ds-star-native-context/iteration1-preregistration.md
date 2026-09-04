# Iteration 1 preregistration: centring-only bare filenames

Recorded before the live batch on 2026-09-04. This is DS-STAR Mode 1,
iteration 1. The experiment is scoped to the frozen `s1` deep-overflow
fixture and GLM 5.3 Flash at W=65,536.

## One change

`tree-center-filename` differs from `tree-tail-v2` only in the syntax-derived
terms used to choose a centre inside an already selected branch. It recognizes
bare dotted filenames such as `sw-1-jsonc.jsonl.bak`. Search ranking, prompts,
tools, branch selection, term credit, tie-breaking, band allocation, budgets,
and reply policy remain unchanged. `truncate-tail` is the same-window raw-tail
native proxy; it is not the repository's end-to-end `native` arm.

Candidate key:
`retrieval-center-fingerprint-mode:bare-filename`.

## Frozen inputs and code

- Question SHA-256: `9ebc3150d54dadf0c31bdbce1990cb66d4653a6688d0bccf1befd6662ef85abc`.
- Parent Git commit: `4e5d222965739716474d451cbb66923a402c5e41`.
- Candidate retriever source SHA-256: `8cf1bccf888f9cadb586552f23b74f02029ac811413ef305640d9ca2015695ca`.
- Candidate retriever runtime SHA-256: `e0a2a4b04188ae0bdc5046371629fc63ba1f7fde07139aca2198244155836608`.
- Candidate harness SHA-256: `d29afdd043815b3858b78e974f3bcfbd25b0b43bbe74bd949011d18628b3b7b6`.
- Model: `z-ai/glm-5.3-flash` as resolved by OpenRouter; any provider revision
  exposed by the run is part of the result artifact.
- Arms in one invocation: `truncate-tail,tree-tail-v2,tree-center-filename`.
- Replicates: five per question per arm; 75 scheduled attempts total.

## Zero-token gates

1. Test suite: 968 passed, 9 skipped, 0 failed.
2. `G7-tool-call-logging`: PASS with ordered search/full-fetch/summary-fetch
   records and post-cap literal evidence.
3. Deep rank gate: 5/5 top-three against a 4/5 threshold.
4. `NC2/NC3` scoped replay: qo04 legacy 0/5 versus candidate 5/5 post-cap;
   candidate centre 218 in 5/5; no protected-question delivery regression;
   no served payload exceeds exact headroom. Raw artifact:
   `reports/metrics/ds-star-native-context/iteration1-offline.json`.

A failed or mixed-epoch identity, missing ordered telemetry, provenance failure,
or changed search order cancels the batch.

## Live win criteria

Stalls remain in the denominator. The primary measure is unconditional,
provenance-audited exact-match success.

The candidate wins only if all are true:

1. qo04 `mechanismFired` and post-cap answer delivery are 5/5.
2. No delivery count for qo01, qo02, qo03, or qo05 is below the incumbent.
3. Candidate success is at least four attempts above `tree-tail-v2` out of 25.
4. Candidate success is strictly above `truncate-tail` in the same invocation.
5. Every counted success has payload provenance.

A delivery win without item 3 is a bucket win and headline-inert. A score win
without the mechanism is unattributed and does not land. Resource metrics are
secondary and cannot rescue a quality or mechanism failure.

## One capped escalation

Escalate only if every mechanism/protected-slice gate passes and the initial
candidate delta over the incumbent is +1/25, +2/25, or +3/25. Add exactly five
replicates per question to all three arms in the unchanged epoch. At n=10 per
question, require +8/50 over the incumbent, strict superiority to the proxy,
qo04 delivery 10/10, and no protected-question delivery regression. There is
no second escalation. Zero/negative score delta, mechanism failure, provenance
failure, or protected regression retires the candidate immediately.
