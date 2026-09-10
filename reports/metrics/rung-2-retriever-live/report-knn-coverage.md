# Does a distinct kNN (different embedder) improve coverage?

**Question.** kNN retrieval == dense cosine top-k, so a second kNN over the *same*
embeddings is redundant. Can a **different embedding model's** kNN add coverage —
alone or fused? Offline retrieval question, no model calls.

**Setup.** Corpus = `packages/<pkg>/src` (110 files → 1063 chunks). Embedders (Xenova
ONNX, all dim 384): MiniLM `all-MiniLM-L6-v2`, `bge-small-en-v1.5`, `gte-small`. Metric:
`answer_present@k` (gold answer regex in the union of top-k chunk text) and `gt_file@k`
(ground-truth file in top-k), on the shared 20-question set. Numbers: `results-knn-coverage.json`.
Rerun: `node experiments/rung-2-retriever-live/knn-embedder-coverage.mjs`.

## Result (answer_present@5 / gt_file@5)

| embedder | answer_present@5 | gt_file@5 |
|---|---|---|
| MiniLM | 0.30 (6/20) | 0.50 |
| bge-small | 0.30 (6/20) | 0.55 |
| gte-small | 0.30 (6/20) | 0.45 |

**Coverage combination (answer_present@5, single = 6/20):**

| pair | union | RRF | a-only | b-only |
|---|---|---|---|---|
| MiniLM+bge | **8** | 4 | 2 | 2 |
| MiniLM+gte | **8** | 5 | 2 | 2 |
| bge+gte | 6 | 6 | 0 | 0 |

## Conclusions

- **A different-*family* embedder adds modest coverage — but only by UNION/interleave,
  not RRF.** MiniLM vs bge/gte have **partially disjoint misses** (2 queries each way),
  so the union is 8/20 vs 6/20 single (+2). But **RRF of two embedders HURTS** (4–5 < 6):
  it demotes each embedder's sole-coverage hit — the *same disjoint-coverage demotion
  mechanism* seen at the retriever level (`report-isolation-live.md`), now reproduced
  between two dense retrievers. Reserve-a-slot interleave keeps both; RRF buries them.
- **Same-family embedders are redundant.** bge and gte cover **identically** (union 6,
  0 unique either way) — fusing or unioning them gains nothing. Confirms rung-0b's "not
  additive" at the embedder level: pick one bge-class model, a second is wasted.
- **Absolute dense coverage is low on code (0.30 answer_present) but file-location is
  higher (0.45–0.55 gt_file).** Embedders find the right *file* ~half the time but the
  exact answer literal often isn't in the top-k chunk — the rung-0e "vector finds the
  file, shallow spans" result, again. The larger coverage lever is a **lexical** retriever
  (grep/bm25 own literals embedders miss), not a second embedder.

**Verdict:** a distinct kNN improves coverage **weakly and only via interleave with a
different-family embedder** (+2/20); RRF-fusing embedders is counterproductive; a
same-family second embedder is redundant. Net: not worth a second embedder as a headline
retriever — the coverage gains live across *families* (lexical + dense), which the
existing ensemble already spans.

**Caveats.** n=20, directional. CODE corpus — transfer to a transcript corpus untested.
`answer_present` is a retrieval ceiling, not model accuracy (the live run recovers some
via the file-path header).
