# Rung 0e Phase 2 — style-tailored retriever benchmark (repo corpus, real graft)

**Run:** `style-tailored-repo-benchmark@v1` · offline · commit `d6a7f2c` · graft CLI 0.8.2
**Script:** `experiments/rung-0e-retrievers/repo-benchmark.mjs` · **Raw:** `results-repo-benchmark.json`
**Corpus:** context-tree repo — 110 `packages/*/src` files → 1063 chunks (recursive 800/100).
**Question set:** 16 questions, 4 per style-tailored stratum, ground-truth answer FILE verified before
authoring. **Judge:** ground-truth file appears in top-k retrieved files.

## Why this run

The s1 slice corpus was homogeneous, so it could not show per-style strengths — the premise of
interleaving/routing. This uses the repo as corpus (so **graft/structural competes for real**) with
questions built to favour each retriever style: structural, exact-literal, semantic, fuzzy/typo.

## Result 1 — no single retriever wins every stratum (file-in-top-5, count / 4)

| retriever | structural | literal | semantic | fuzzy | overall@5 |
| --- | :-: | :-: | :-: | :-: | :-: |
| **graft** (real CLI) | 3 | 3 | 2 | **4** | **75%** |
| bm25 | 3 | **4** | 3 | 0 | 62% |
| grep | 2 | **4** | 3 | 0 | 56% |
| fuzzy (trigram) | 2 | 3 | 1 | **4** | 62% |
| vector (MiniLM) | 2 | **4** | 3 | 0 | 56% |

- **graft is the strongest single retriever (75%)** and — unexpectedly — swept **fuzzy 4/4** (its
  lexical index tolerates the typo'd symbols) as well as structural.
- **Lexical (bm25/grep) own literal (4/4); fuzzy+graft own typos (4/4, 0/4 for the exact matchers).**
  The per-style specialisation is real and is the case for combining.
- **Honest miss in the design:** vector did *not* dominate semantic (3/4, tied with lexical). The
  "semantic" questions still contained matchable words (`prefix`, `phases`), so lexical caught them —
  the stratum needs harder paraphrase-only questions before "vector wins semantic" is tested.

## Result 2 — fusing retrievers over the SAME corpus wins big (and does NOT contradict S3)

Combination arms, file-in-top-k:

| arm | @1 | @3 | @5 |
| --- | :-: | :-: | :-: |
| **rrf** (reciprocal-rank fusion of all 5) | **50%** | **93%** | **93%** |
| interleave (round-robin by rank — operator's idea) | 37% | 68% | 87% |
| router-oracle (route by TRUE stratum — routing ceiling) | 31% | 62% | 87% |
| best-single (graft) | 37% | 68% | 75% |

- **RRF fusion is the clear winner: 93% @k=3 vs 75% best-single (+4 questions), and it beats even the
  oracle router (87%).** Combining every retriever's signal beats picking the single "right" one,
  because the answer file corroborates across several retrievers and RRF rewards that agreement.
- **This does not contradict S3.** S3 refuted RRF across **disjoint-coverage facet indexes**, where the
  answer sat in one index and the other three demoted it. Here the retrievers share **one corpus with
  overlapping coverage**, so the right file appears in several lists and gets *boosted*, not demoted —
  exactly the case S3 named as fusion's *right* use ("multiple rankers over the same index"). Coverage
  overlap is the deciding variable, and it flips the sign.
- **The operator's round-robin interleave also beats best-single (87% vs 75%)** but trails RRF —
  reserving one slot per source helps, but weighted rank-agreement (RRF) helps more.

## Reading

1. **Combine retrievers over a shared corpus with RRF** — 75%→93%. This is the evidence-backed
   version of the interleave idea, and it is *not* the refuted arm (that was cross-disjoint-index).
2. **graft (real CLI) is a strong general retriever here** (best single, and strong on fuzzy) — the
   structural retriever earns its place in the mix, per HR1.
3. **Refine S3 in the plan:** "RRF fusion refuted" holds only for disjoint indexes; same-corpus
   multi-retriever RRF is a *winner* on this benchmark. The scope qualifier matters.

## Caveats

- **16 questions, 4/stratum** — directional, not powered; a 1-question swing is ~6 pp. The RRF-vs-best
  gap (+4 questions at k=3) is the robust part; the per-stratum single-retriever ranks are noisier.
- **File-level judge**, not span-level. A retriever that surfaces the right file but wrong span scores.
- **Semantic stratum under-designed** (see Result 1) — hardening it may change vector's standing.
- All retrievers here are ones **we run and assemble** (HR2-INVARIANT): the combination arms preserve
  each source's own ranking and never re-score a source.
