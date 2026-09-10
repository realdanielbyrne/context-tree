# Rung 0e Phase 2b — hardened semantic stratum

**Run:** `semantic-hardening@v1` · offline · commit `d6a7f2c` · graft CLI 0.8.2 · MiniLM vector
**Script:** `experiments/rung-0e-retrievers/semantic-hardening.mjs` · **Raw:** `results-semantic-hardening.json`
**Corpus:** context-tree repo, 110 `src` files → 1063 chunks (recursive 800/100).

## Why

In the repo benchmark the "semantic" stratum was lexically contaminated — the questions reused words
present in the target file (code *and* comments), so BM25/grep matched them and vector never separated.
This run replaces them with **8 paraphrase-pure** questions that describe each file's behaviour in
vocabulary the file avoids, and verifies hardness objectively: `overlap` = how many of a question's
content words actually occur in the target file. The headline is computed on the **hard subset**
(overlap ≤ median) so a lexically-easy question cannot inflate vector — questions are **not** selected
for vector wins.

## Result — once the lexical shortcut is removed, dense separates cleanly

file-in-top-k (ground-truth file in top-k retrieved files):

| retriever | ALL (n=8) @1/@3/@5 | HARD (n=5) @1/@3/@5 |
| --- | --- | --- |
| **vector (MiniLM)** | 13 / 38 / **63%** | 20 / 40 / **60%** |
| fuzzy | 0 / 25 / 25% | 0 / 20 / 20% |
| bm25 | 0 / 0 / 13% | 0 / 0 / 20% |
| grep | 0 / 0 / 13% | 0 / 0 / 0% |
| **graft (real CLI)** | 0 / 0 / **0%** | 0 / 0 / 0% |
| rrf (fuse all 5) | 13 / 38 / 50% | 20 / 20 / 40% |

## Findings

1. **Vector wins semantics decisively (63% vs ≤13% for every sparse retriever).** The earlier tie was
   purely the contamination artifact — confirmed. This is the "vector wins semantic" result the
   contaminated stratum could not produce.

2. **graft collapses to 0% on conceptual paraphrases.** The structural retriever — strongest on
   structural/literal/fuzzy in the main benchmark — is the *worst* here: graft matches lexically under
   the hood, so a paraphrase with no shared identifier gives it nothing. Per-style specialisation is now
   sharp in *both* directions: graft owns structure/typos, vector owns concepts.

3. **RRF fusion now HURTS: 50% vs vector's 63%.** This is the crucial cross-cutting result. On this
   stratum only *one* retriever (vector) has coverage; the other four contribute noise at comparable
   fusion weight and **demote vector's correct hit** — the exact S3 disjoint-coverage mechanism, now
   reproduced *within* a single stratum.

## The unifying rule (reconciles both RRF results, S3, and the interleave idea)

The sign of fusion is governed by **coverage overlap**, and this session measured both sides of it:
- **Mixed workload, overlapping coverage** (the 4-stratum benchmark): the answer file appears in several
  retrievers' lists → RRF *boosts* it → **RRF wins (93% vs 75% best-single)**.
- **Single-coverage query** (hard semantics — only vector can answer): the four non-covering retrievers
  → RRF *demotes* the one correct hit → **RRF loses (50% vs 63% vector)**.

So the right combinator is **coverage-aware**, not blind RRF: fuse where coverage overlaps, route (or
down-weight non-covering sources) where it does not. Naive RRF is a *good default on mixed traffic* and a
*liability on single-style queries* — which is precisely why S3 saw it lose on disjoint facet indexes and
the mixed benchmark saw it win. Same variable, opposite sign.

## Caveats

- **n=8 (hard subset n=5)** — directional. The vector-vs-sparse gap is large and consistent across k,
  which is the robust part; the exact percentages are not powered.
- **`overlap` is an imperfect hardness proxy** (common words inflate it — e.g. h1 overlap 7 yet nobody
  ranked it top-5). It is reported per question so the reader can judge each; the hard subset is the
  conservative cut.
- **File-level judge**, not span.

## Implication for the plan (Rung 0e Phase 2)

Replace "does fusion beat best-single?" with the sharper question the data now poses: **a coverage/
confidence-weighted combinator vs naive RRF vs a turn-type router.** The evidence says fuse on mixed
traffic, route on single-style queries — a router or a confidence-gated fusion, not blind RRF, is the
arm most likely to dominate both regimes.
