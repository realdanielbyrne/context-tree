# Plan B: regime first

The realistic-host regime must land before any interface variable is measurable.
Prior scores (0-4/25) were recorded where headroom starvation made delivery
mechanically impossible.

## 1. CANDIDATES

### C1. Regime shift to effective W = 130,000

**Change.** `--window 130000`. No code. Models a 200k host with ~70k operator
prompt (Fable 5.1: 60,903 cl100k measured). `deriveBudgets` derives from
`--window` alone (transplant.mjs:461), so `--window (W - P)` is exact.

**Bucket.** Delivery. Today: 77/88 fetches delivered zero bytes at W=65,536.
At effective 130k headroom is ~18,339 cl100k (A2 S2); coordinate search costs
~1,300, leaving ~17,000 for fetch.

**Arms.** {truncate-tail, tree-tail-v2, tree-search-coordinates} x 5 deep
questions x n=5 = 75 rows. tree-tail-v2 bridges to W=65k baselines;
tree-search-coordinates has zero live evidence.

**Kill gates (zero live tokens).**
KG-1 Question validity: boundary ~358 at K=122,209. All five deep-set seqs
(18, 151, 193, 218, 264) fall below. Verified this session. PASS.
KG-2 Headroom: 18,339 > 1,402 (search max) + 6,000 (min fetch band). PASS.
KG-3 Dead cell: effective 130k > 0; Zone A+B fit (A2 S6). PASS.

**Win.** tree-search-coordinates exact-match > truncate-tail by >= 2 questions
on the deep set.

### C2. Hit count 5 at the new regime

**Change.** `--search-k 5` threaded into `ctx.config.retrieval.limit`
(transplant.mjs:1596). ~5 lines.

**Bucket.** Tokens. 20 coordinate hits: 1,194-1,402 tokens. 5 hits: ~350.
Saves ~1,000 per search, compounding across median 4 turns.

**Arms.** tree-search-coordinates (k=20, from C1) vs tree-search-coordinates-k5
(k=5), effective W=130k, 5 questions x n=5 = 50 rows.

**Kill gate.**
KG-4 Rank-5 coverage: live ranks [1, 2, 7, 1, 1] (A3 S6). qo03 ranks 7th --
pre-registered expected loss on that question.

**Win.** k5 score >= k20 minus 1 (non-inferiority on 4/5 where correct branch
is top-5) AND total input tokens < 90% of k20.

### C3. Behavioral opens cap (conditional on C1)

**Change.** One sentence in the contract: "Search once per question; if the
first result does not settle it, fetch the top-ranked branch and answer from
what arrives. Do not reformulate." ~20 tokens.

**Bucket.** Turns. Prior: 5-8 identical reformulated searches per question.

**Arms.** tree-search-coordinates-capped vs tree-search-coordinates, effective
W=130k, 5 questions x n=5 = 50 rows.

**Kill gate.** KG-5 Contract size delta < 50 tokens.

**Win.** Mean turns < 3.0 AND score >= uncapped minus 1.

**Condition.** Run only if C1 median turns > 3.

## 2. ORDER

**C1 first.** Every prior score was recorded where delivery was impossible. C1
answers the starvation hypothesis at ~$1.78. Information per dollar is maximal:
it opens or closes the line of investigation.

**C2 second.** One integer, clean isolation, ~$0.75 incremental. KG-4
pre-registers the qo03 loss so the result is interpretable either way. The
Fable interface uses k=5; measuring it here avoids confounding a later
composite arm.

**C3 third, conditional.** Only if thrashing persists at W=130k. Defers ~$0.40
that may be unnecessary.

## 3. MECHANISM

**C1.** `deriveBudgets(130000, 0.851)` yields K=122,209 heuristic. Zone B
~30,556 heuristic + tail ~77,153 heuristic. Headroom ~18,339 cl100k at turn 1.
Coordinate search ~1,300 tokens; fetch handler reads
`ctx._liveHeadroomHeuristic` (transplant.mjs:1756), centers on query's matching
events, grows band to ~17k tokens -- 20-25% of a 57k branch. **Row records
mechanism fired:** `resultTokensTruncated` = false AND
`answerLiteralPresentAfterCap` = true. If both true and score = 0, extraction
is the new binding constraint.

**C2.** Override `limit` at 1596. Row records: `afterTokens < 500`, hit count
= 5.

**C3.** Contract enters Zone A. Row records: `turns <= 3` for completed runs
AND search-call count <= 1.

## 4. COST

glm-5.3-flash ($0.075/M in, $0.25/M out). From A2 S5 at eff W=130k:

| Batch | Rows | Input tokens | Cost |
|-------|------|-------------|------|
| C1 | 75 | ~28.5M | ~$1.78 |
| C2 (incremental) | 25 | ~10.5M | ~$0.75 |
| C3 (conditional) | 25 | ~5.3M | ~$0.40 |
| **C1+C2** | **100** | **~39M** | **~$2.53** |

C1's tree-search-coordinates rows are the k=20 baseline for C2.

## 5. WHAT THIS PLAN DOES NOT TEST

- **Pad content effect.** C1 reduces W arithmetically; the Fable prompt is not
  prepended. Behavioral interaction (two tool schemas in one context) unmeasured.
  ~43 lines harness code + second batch.
- **Fable composite arm.** Snippets + page-token + turn-reads + Fable contract
  (~230 lines). Deferred until C1 confirms measurable scores.
- **Overflow set at W=130k.** Only 2/5 valid; needs re-cut via
  `--phase prep-overflow --window 130000` (zero live tokens).
- **Page-token addressing.** Strongest delta for qo04 (0/30 delivery).
  Architectural; deferred until C1 shows whether centering still fails at 17k
  headroom.
- **Multi-window sweep.** One point (130k). A {65k, 130k, 200k} sweep maps the
  curve but triples cost.
- **Non-flash models.** Starvation is a budget constraint; model-independence
  unconfirmed.
