# Rung 0b — kNN drift as a classifier signal

**Run:** `topic-shift-knn@v1` · offline · model `Xenova/all-MiniLM-L6-v2` · commit `d6a7f2c`
**Script:** `experiments/rung-0b-topic-shift/topic-shift-knn.mjs` · **Raw:** `results-knn.json`
**Scope:** classification layer only — a third shift signal and how it compares/merges with the other two.

## What was tested

kNN-drift (operator's candidate): each post-boundary turn matched to its **nearest** recent turn, averaged
— `knnSim[t] = mean_{a∈[t,t+n)} max_{b∈[t−n,t)} cos(a,b)`, drop = 1−sim. Distinct from centroid
embedding-drift (which compares window *means*). Two questions: (1) is kNN just embedding-drift? (2) does
adding it to the merge improve robustness (label-free segmentation quality, both spaces, matched K)?

## Result

**(1) kNN ≈ embedding-drift.** Boundary agreement (Jaccard of flagged sets, K=40): **knn~embedding =
0.739** (only 6/40 kNN-unique), knn~lexical = 0.212, embedding~lexical = 0.159. kNN is a *sharper
variant* of the semantic signal, not an independent one.

**(2) Adding kNN does not help the merge.** Segmentation quality, worst-case (min across spaces):

| K | lexical | embedding | knn | merged2 (lex+emb) | merged3 (+knn) |
| --- | --- | --- | --- | --- | --- |
| 20 | **0.040** | 0.015 | 0.035 | 0.023 | 0.037 |
| 40 | 0.033 | 0.030 | 0.043 | **0.054** | 0.048 |
| 60 | 0.049 | 0.065 | 0.065 | **0.087** | 0.087 |

## Findings

1. **kNN is largely embedding-drift (74% boundary overlap)** — a nearest-neighbor flavor of the same
   semantic family, confirming the "is kNN equivalent to embedding shift?" intuition.
2. **As a standalone classifier, kNN is marginally better than centroid embedding-drift** (worst-case
   0.043 vs 0.030 at K=40) — the sharper matching helps.
3. **Adding kNN to the merge is within noise — not a demonstrable help OR hurt.** merged3 vs merged2
   worst-case: better at K=20 (0.037 vs 0.023), worse at K=40 (0.048 vs 0.054), tied at K=60 (0.087).
   Deltas of 0.005–0.014 on one session against a proxy objective are not distinguishable from noise. The
   robust fact is only that kNN duplicates the semantic signal (0.74 overlap), so merged3 adds little
   *new* information — "little new" is not "harmful."

## Conclusion — classifier composition

- **kNN and centroid embedding-drift are near-interchangeable** (0.74 overlap); use one of them as the
  semantic component. kNN is marginally sharper as a standalone.
- **Whether a *second* semantic variant (merged3) helps or hurts is UNDETERMINED offline** — the deltas
  are within noise, and resolving them needs a real labeled dataset or a downstream outcome, not this
  proxy. Do not conclude "two beats three"; conclude "the third is redundant, and its marginal effect is
  unmeasurable here."
- The robust classifier is **`z(lexical) + z(semantic)`**, semantic ∈ {centroid-drift, kNN-drift}; adding
  the other semantic variant is optional and its value is untested.

## Caveats

- One session, directional; segmentation quality is a proxy objective (no shift labels). The redundancy
  finding (kNN~embedding 0.74) is the robust part; the merged2-vs-merged3 quality deltas are within noise
  and must not be read as an ordering.
