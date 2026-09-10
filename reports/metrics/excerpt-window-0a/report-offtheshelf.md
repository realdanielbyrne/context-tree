# Rung 0a (off-the-shelf) — chunk · retrieve · rank · rerank

**Run:** `offtheshelf-chunk-retrieve-rank@v1` · offline · commit `d6a7f2c` · fixtures `7d459f9^`
**Script:** `experiments/rung-0a-excerpt-window/offtheshelf-sweep.mjs` · **Raw:** `results-offtheshelf.json`
**Baseline (bespoke `excerptAround`):** `report.md` in this dir.

## Question

Passage extraction is a commodity problem — should the retrieval unit **borrow** off-the-shelf code
instead of the hand-rolled `excerptAround`? This run replaces the bespoke unit with open-source
components and sweeps their parameters. The original Rung 0a tests **chunking only** (it was handed the
correct document); this run adds **retrieval + ranking + reranking** by pooling the 21 recovered
`wide_context` slices into one corpus, so the pipeline must also *find* the answer-bearing chunk.

## Stack (all open source, all offline)

- **Chunkers:** LangChain `RecursiveCharacterTextSplitter`, `TokenTextSplitter`; semantic
  percentile-breakpoint (MiniLM sentence embeddings); sentence-window / parent-document.
- **Retrieval (1st-stage rank):** BM25 (`wink-bm25-text-search`); dense vector (MiniLM cosine).
- **Rerank (2nd-stage):** cross-encoder `ms-marco-MiniLM-L-6-v2` over the first-stage top-20.
- Swept: chunk size, overlap, semantic percentile, window, top-k ∈ {1,3,5}. Judge: all
  `answer_literals` in the union of the top-k returned chunks.

**Caveat.** Corpus = pooled answer-windowed slices (≤~2.1 KB); the real s1 event store died with `eval/`.
Absolute rates are shaped by a small, near-homogeneous corpus. The **relative** comparison is the result.

## Findings

1. **The rung is fully replaceable by off-the-shelf code.** With retrieval isolated out (oracle = rank
   within the correct doc, apples-to-apples with the bespoke sweep), off-the-shelf chunking hits **100%
   at 287 est. tokens** (vector, k=3, `TokenTextSplitter` 256/0) — matching the bespoke unit's 100%
   (which needed `excerptChars=2000`) at lower cost. The hand-rolled `excerptAround` has no advantage.

2. **BM25 is the strongest ranker here; reranking HURT.** Mean present-rate by ranker: **bm25 63.6%**,
   bm25+rerank 57.7%, vector+rerank 56.5%, vector 55.0%. The MS-MARCO cross-encoder is trained on
   web-prose Q&A; on identifier-heavy code/test text it demotes the lexically-correct chunk BM25 ranked
   first. **A code-domain reranker is the fair test before concluding reranking can't help** — this
   refutes only the general-web reranker, not reranking in principle. Prior work also refuted RRF fusion
   vs the best single index (S3), so route to the best single ranker, don't fuse.

3. **Full-pipeline (with retrieval) Pareto:** best raw **81% @ 753 t** (vector, k=5, recursive 1024/0);
   best efficiency **71% @ 167 t** (bm25, k=1, recursive 1024/0). The ~19 pp gap to the oracle ceiling
   (100%) is retrieval/ranking error among 21 near-duplicate slices — a corpus artifact, not chunking.

4. **Chunker families:** recursive ≈ semantic > token > sentence-window on ceiling; sentence-window is
   best at tiny token budgets and is the natural fix for the bespoke sweep's one real failure (multi-
   literal *spanning* answers).

## Recommendation

- **Retire `excerptAround` and D-a anchor-tuning / D-b-as-excerpt from the ladder.** Put a standard
  splitter (recursive/token 256–1024) + **BM25** behind the existing `RetrievalProvider` interface
  (CLAUDE.md §9.1); tune top-k to the token budget. Keep a dense arm behind a capability probe; skip
  general-web reranking (retest only with a code-domain reranker).
- **Off-the-shelf does not cover the project's core layer** — cross-turn history management (eviction,
  topic-shift retention, cache-stable layout, the score hypothesis). That is where the budget belongs
  (Rungs 2–3).
