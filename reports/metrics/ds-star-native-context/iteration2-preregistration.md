# Iteration 2 preregistration: all-rank search coordinates

Recorded before implementation and before any iteration-2 live token on
2026-09-04. This is DS-STAR Mode 1, iteration 2, scoped to the frozen `s1`
deep-overflow fixture at W=65,536 and `z-ai/glm-5.3-flash`.

## Hypothesis and one change

Iteration 1 showed that bare-filename centring finds the correct qo04 event,
but the 20-hit search response consumes 77--92% of the append headroom. The
correct fetch is consequently truncated to zero. The candidate
`tree-search-coordinates` keeps the full incumbent ranking and filename
centring, but replaces the two overlapping model-visible search-result views
with one all-rank coordinate view:

`{node_id, kind, title, phase_type, path, score}`

It returns every upstream hit in the same order and returns no duplicate tree
`candidates`. Ranking, the configured 20-result pool, query parsing, scores,
prompt, tools, fetch, centring, budgets, append cap, and reply policy remain
unchanged. Candidate key:
`search-result-view:all-rank-coordinates@center-bare-filename`.

This is an experimental harness arm. No production-package change is in scope
until the experiment passes.

## Frozen parent epoch

- Parent commit: `16902c34bf723931dff60b477e32355e6cfe953d`.
- Question SHA-256: `9ebc3150d54dadf0c31bdbce1990cb66d4653a6688d0bccf1befd6662ef85abc`.
- Parent harness SHA-256: `d29afdd043815b3858b78e974f3bcfbd25b0b43bbe74bd949011d18628b3b7b6`.
- Retriever SHA-256: `8cf1bccf888f9cadb586552f23b74f02029ac811413ef305640d9ca2015695ca`.
- Iteration-1 live artifact: `run-W65536-truncate-tail+tree-tail-v2+tree-center-filename-questions-deep-q9ebc3150-cb2b5adc512bc-n5-z-ai_glm-5.3-flash.json`.
- Correct first-search ranks from its ordered telemetry are `[1,2,7,1,1]`.

The implementation commit and compiled/runtime fingerprints will be recorded
by the machine-readable readiness artifact; changing them after readiness
cancels the batch.

## Zero-token authorization gates

All `NC20`--`NC27` gates in `judge-iteration2.md` must PASS before live use.
In particular, the candidate must preserve all 20 IDs/order/scores, keep qo03
at rank 7, serialize every representative response inside its recorded
headroom, and replay all four observable qo04 sequences to a positive-headroom
fetch centered at 218 with the answer literal delivered. The complete tests,
deep-rank gate, G7 telemetry gate, and provenance audit must also pass.

## Live batch and win criteria

Run one collision-proof invocation with arms
`truncate-tail,tree-center-filename,tree-search-coordinates`, five replicates
per question, 75 scheduled attempts. Do not pool historical rows. Stalls and
provider errors remain in the unconditional denominator.

The candidate wins only if all are true:

1. qo04 exposes rank 1, fetches with positive headroom, centers at 218, and
   delivers the answer literal in 5/5 scheduled attempts.
2. Provenance-audited exact-match success is at least +4/25 over the
   same-invocation `tree-center-filename` and strictly above `truncate-tail`.
3. Delivery on qo01, qo02, qo03, and qo05 is no lower than the incumbent; qo03
   remains visible at rank 7 on every nonempty first search.
4. Search-result append truncation is zero and every counted success has
   post-cap payload provenance.
5. Underlying rank/order/scores, centring, fetch spans, prompts, tools, budgets,
   and reply policy match the incumbent.

One equal-n escalation is allowed only when every mechanism, parity,
provenance, and protection gate passes and the candidate delta is +1..+3/25.
At 50 attempts per arm require +8/50, qo04 delivery 10/10, strict superiority
to the proxy, and no protected delivery regression. Otherwise do not escalate.

Passing establishes superiority only to the same-window raw-tail native proxy
on this frozen cell. It does not yet establish superiority to the repository's
end-to-end native arm.
