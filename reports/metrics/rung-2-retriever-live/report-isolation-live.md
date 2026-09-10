# Retriever isolation + ensemble, on a real model (live RAG)

**Question.** Rung-0e measured retrievers offline by "is the gold file in top-k."
This promotes it end-to-end: hand each retriever's top-k passages to the **local
model**, have it answer, grade deterministically. What does each retriever — and an
RRF ensemble — actually deliver to a model on a **code corpus**?

**Setup.** Corpus = `packages/<pkg>/src` (110 files → 1063 chunks, recursive 800/100).
20 questions, mixed strata (structural/literal/semantic/fuzzy), each with a verified
ground-truth file + authored answer regex. Retrievers: bm25 · vector (MiniLM) · grep ·
fuzzy · **graft** (CLI) · **ensemble** = RRF over per-retriever file lists, best passage
per fused file. Model `unsloth/Qwen3.8-27B-GGUF`, **thinking ON** (held constant — the
retriever is the only variable), k=5, temp 0. Grader: regex over the model's answer.
Numbers + cells: `results-isolation-live.json`. Rerun: `node experiments/rung-2-retriever-live/retriever-isolation-live.mjs`.

## Result

| arm | structural | literal | fuzzy | semantic | ALL | gt-file@k | tok |
|---|---|---|---|---|---|---|---|
| bm25 | 4/4 | 1/4 | 0/4 | 1/8 | 6/20 (.30) | .40 | 904 |
| vector | 3/4 | 1/4 | 1/4 | 4/8 | 9/20 (.45) | .50 | 1072 |
| grep | 4/4 | **4/4** | 0/4 | 0/8 | 8/20 (.40) | .35 | 901 |
| fuzzy | 3/4 | 1/4 | **4/4** | 1/8 | 9/20 (.45) | .45 | 863 |
| graft | 3/4 | 1/4 | **4/4** | 0/8 | 8/20 (.40) | **.55** | 1160 |
| **ensemble (RRF)** | 4/4 | 1/4 | 4/4 | 4/8 | **13/20 (.65)** | **.80** | 1253 |

## Conclusions

- **RRF ensemble wins overall (0.65 vs 0.45 best single) — the overlapping-coverage
  case.** F_ensemble PASS. On one shared corpus, scale-free rank-interleaving reinforces
  the specialist that covers each stratum. The ensemble also has the highest file-location
  rate (gt-file@k = 0.80).
- **RRF demotes the sole coverer on disjoint coverage — reproduced live.** On **literal**
  questions grep alone covers (4/4), but the ensemble drops to **1/4**: the three
  non-covering retrievers' rank noise outvotes grep's genuine hits. This is the §8
  demotion mechanism (`ds-star-multi-index-report.md`, rank 3→12), at stratum granularity.
  RRF's failure here is **coverage/voting, not scale** — RRF is rank-based and never
  normalizes scores. A **coverage-aware router** (literal-shaped → grep, fuse the rest)
  would recover literal to ~4/4 (~16/20).
- **Per-style specialization is sharp** (matches rung-0e, now live + extraction-graded):
  grep owns **literals** (4/4), vector owns **paraphrase/semantic** (4/8, others ≤1/8),
  fuzzy + graft own **typos** (4/4, exact matchers 0/4), structural is broadly covered.
- **graft: best at finding the file, mid-pack at end-to-end here.** Highest gt-file@k
  (0.55) but accuracy 0.40 — capped because the harness uses `graft ask` uniformly (wrong
  interface for a call-graph question and for reading a literal *value*) and graft scores
  0/8 on paraphrase (structural, not semantic). A routed graft arm (`graft callers` for
  call-graph turns) is the fair test; graft's structural/file-location strength stands.

## Tested vs. open

- **Tested (live, code corpus):** end-to-end retriever accuracy + the RRF overlap-win /
  disjoint-demote mechanism, on real model extraction.
- **Open:** the coverage-aware **router** arm (predicted ~16/20); a **routed graft** arm;
  and — the big one — **transfer to a conversation-trace corpus** (this is a code repo;
  graft applies to the live *repo*, not the transcript, and BM25/vector own transcript prose).

**Caveats.** n=20, directional. For file-answer questions the passage header carries the
path, so accuracy blends "retrieval surfaced the file" with "model named it"; literal
questions are true value-extraction. k=5 held constant (not token-neutral). Thinking ON.
