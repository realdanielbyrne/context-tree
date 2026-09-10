# Rung 0e Phase 2c — coverage-aware combinators

**Run:** `coverage-aware-combinators@v1` · offline · commit `d6a7f2c` · graft CLI 0.8.2 · MiniLM
**Script:** `experiments/rung-0e-retrievers/combinators.mjs` · **Raw:** `results-combinators.json`
**Test set:** mixed **n=20** — structural 4, literal 4, fuzzy 4 (from the repo benchmark) + **8
paraphrase-pure hardened-semantic** — so both coverage regimes are present. **Judge:** ground-truth
file in top-k.

## Why

Phase 2 + 2b showed RRF wins on multi-coverage traffic but loses on single-coverage (hard semantic),
governed by coverage overlap. So the combinator should be coverage-aware. Two candidates, tested
individually: a **feature router** (route by the query's surface form) and **confidence-gated RRF**
(a retriever joins the fusion only if it returned a hit AND its top-1→top-2 margin ≥ gate; gate swept).

## Result — overall file-in-top-k

| arm | @1 | @3 | @5 |
| --- | :-: | :-: | :-: |
| best-single | 25% | 50% | 55% |
| **rrf** (= gated@0) | 30% | **75%** | **80%** |
| router-oracle (route by true stratum) | 25% | 55% | 80% |
| **router-feature** (17/20 routing acc.) | 30% | 55% | 80% |
| gated-rrf@0.1 | 25% | 70% | 70% |
| gated-rrf@0.25 | 35% | 60% | 60% |
| gated-rrf@0.5 | 25% | 65% | 70% |

Per-stratum @5 (count of that stratum's questions):

| arm | struct/4 | literal/4 | **semantic/8** | fuzzy/4 |
| --- | :-: | :-: | :-: | :-: |
| rrf | **4** | 4 | **4** | 4 |
| router-feature | 3 | 4 | **5** | 4 |
| best-single | 3 | 4 | 5 | 4 |

## Findings

1. **Plain RRF is the best simple combinator on mixed traffic — it ties or beats routing at every k**
   (75% vs 55% at k=3; 80% = 80% at k=5) and beats best-single (80% vs 55%). The Phase-2 mixed-traffic
   RRF win holds up against both routing and gating.

2. **Confidence-gated fusion FAILED — a clean negative.** Every gate > 0 scored *below* plain RRF
   (gate 0.1→70%, 0.25→60%, 0.5→70% vs 80%). The top-1→top-2 **margin is not a reliable coverage
   signal**: raising the gate excludes covering retrievers as often as noisy ones. This particular
   coverage-aware mechanism does not work; report it as refuted, not iterated.

3. **The feature router works (17/20 surface-form routing accuracy) but does not beat RRF.** Its win on
   semantic (5/8, routes to vector) is exactly offset by its loss on structural (3/4 — graft misses one
   that fusion recovers) and worse k=3 ranking. Routing ≈ RRF at k=5, worse at k=3.

4. **The demotion effect is real but bounded by workload mix.** RRF's only weakness is semantic (4/8),
   and on a set where semantic is 8/20 that loss is outweighed by its structural strength and higher
   ranking. Demotion only *dominates* when the workload is predominantly single-coverage — the pure
   hardened-semantic run, where RRF (50%) lost to vector (63%).

## Recommendation

- **Default combinator = plain RRF.** Simplest, and the winner on mixed traffic. No gating, no router.
- **Route only if the workload is known to be single-coverage-dominant** (e.g. a semantics-heavy
  surface). Then route that class to its owner (semantic→vector) and fuse the rest.
- **Do not pursue margin-gated fusion** — refuted here. If a coverage-aware fuser is revisited, the gate
  needs a calibrated per-retriever confidence (absolute cosine for dense, term-coverage for sparse),
  not a scale-free margin — and it must clear plain RRF (80% @5) to earn its complexity.

## Caveats

- **n=20 (semantic=8, others=4)** — directional; the mix ratio itself moves the overall numbers, so read
  the per-stratum row, not just the total.
- **File-level judge** (span-level is Phase 2d).
- router-feature is a hand-built heuristic; its 17/20 is on this set's phrasings and would need a held-out
  set to generalise.
