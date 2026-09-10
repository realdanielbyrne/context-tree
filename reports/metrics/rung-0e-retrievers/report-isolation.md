# Rung 0e Phase 1 — retriever isolation (each retriever alone)

**Run:** `retriever-isolation@v1` · offline · commit `d6a7f2c` · fixtures `7d459f9^`
**Script:** `experiments/rung-0e-retrievers/retriever-isolation.mjs` · **Raw:** `results-isolation.json`
**Setup (held constant):** corpus = 21 pooled `wide_context` slices → 69 chunks via
`RecursiveCharacterTextSplitter(512/128)`; one variable = the retriever; top-k ∈ {1,3,5}.

## Question

Establish the per-retriever baseline and the **best single index** — the bar every Rung 0e Phase 2
combination arm must clear (§0/S3: naive RRF across disjoint indexes already lost to routing).

## Result — corpus-wide allPresentRate (oracle in parens), mean tokens

| retriever | k=1 | k=3 | k=5 |
| --- | --- | --- | --- |
| **bm25** | 52% (52%) 98t | 62% (76%) 301t | **71%** (76%) 496t |
| **grep-exact** | 48% (52%) 92t | 62% (71%) 269t | **71%** (76%) 375t |
| tfidf-beam (repo's own) | 43% (52%) 99t | 52% (86%) 316t | 52% (86%) 533t |
| fuzzy (trigram) | 43% (48%) 96t | 62% (86%) 286t | 62% (**95%**) 484t |
| vector (MiniLM) | 48% (52%) 101t | 52% (86%) 274t | 62% (**95%**) 453t |

*Corpus-wide* = must retrieve the right doc among 21 then rank the answer chunk. *Oracle* = ranking
restricted to the correct doc (retrieval error removed; isolates within-doc ranking).

## Findings

1. **Best single index = grep-exact @ k=5 (71.4% corpus-wide, 375 t)** — tied with bm25 on rate but
   cheaper. That is the Phase-2 bar.

2. **The retrievers split by task, and the split is the case for combining them:**
   - **Lexical (bm25, grep) wins cross-doc retrieval** — 71% corpus-wide — but plateaus at **76%
     oracle**: on identifier-heavy code text it finds the right document but doesn't always rank the
     answer chunk highest within it.
   - **Dense/fuzzy (vector, fuzzy) win within-doc ranking** — **95% oracle** at k=5 — but lag
     corpus-wide (62%): once in the right doc they rank the answer chunk best, but they retrieve the
     right doc less reliably.
   This is the classic lexical-vs-dense division of labour, and it predicts a **lexical-first,
   dense-rerank** (or lexical-retrieve → dense-rank) pipeline could beat either alone — a concrete
   Phase-2 combination hypothesis, distinct from the refuted cross-index RRF.

3. **The repo's own tfidf-beam is mid-pack** (52% corpus-wide at k≥3) — it reaches 86% oracle but is
   the weakest at *finding* the right doc among these five. Its grep hybrid (shipped `TreeRetriever`)
   is exactly the same-index fusion that lifted ranking before, and is the natural incumbent to put in
   Phase 2.

## Caveats

- **Small corpus.** 21 docs / 69 chunks; a cell difference is 1–2 queries, so treat rank orderings as
  directional, not significant. The relative lexical/dense split reproduces across k, which is the
  robust part.
- **Answer-windowed slices**, not whole events (the s1 store died with `eval/`); absolute rates are
  optimistic, and cross-doc retrieval is stressed by near-duplicate slices.
- **Structural retrievers (graft/tree-sitter, Serena/LSP) excluded** — they retrieve from a parseable
  code repo, not conversation-trace slices; testing them is HR1 / Rung 1b on a code-repo corpus.

## Next (Rung 0e Phase 2)

Combination arms at equal top-k against the 71.4% bar: best-single (grep) · same-index RRF (bm25+vector)
· round-robin interleave across retrievers · interleave+source-labels · and a **router** (turn-type →
retriever), which the record favours over fusion.
