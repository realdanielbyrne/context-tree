# Rung 0e — retriever styles, combination, and span precision (summary + algorithm updates)

**Session:** 2026-09-09 · offline · commit `d6a7f2c` · graft CLI 0.8.2 · MiniLM vector.
**Shared code:** `experiments/rung-0e-retrievers/lib.mjs`. **All numbers:** the five phase reports and
`results-*.json` in this directory. This file summarises and, per the operator's request, recommends
changes to `reports/algorithm.md`.

## The five phases

| phase | question | headline | report |
| --- | --- | --- | --- |
| 0a (companion) | is the retrieval unit bespoke-worthy? | No — off-the-shelf chunker + BM25 matches it; rerank hurt on code | `report-offtheshelf.md` |
| 0e-1 | each retriever alone | lexical finds the doc, dense ranks within it — a split | `report-isolation.md` |
| 0e-2 | style-tailored, real graft | no single retriever wins all strata; **RRF wins mixed (93% vs 75%)** | `report-repo-benchmark.md` |
| 0e-2b | hardened semantics | vector dominates (63% vs ≤13%); **RRF now LOSES (50%)** | `report-semantic-hardening.md` |
| 0e-2c | coverage-aware combinators | **plain RRF best; gating refuted; router ties, not beats** | `report-combinators.md` |
| 0e-2d | span-level judge | **graft best span precision (71%); vector shallow (25%)** | `report-span-scoring.md` |

## The three durable conclusions

1. **Coverage overlap sets fusion's sign.** Overlapping coverage (mixed traffic) → RRF *boosts* the
   agreed answer and wins. Disjoint / single-coverage → RRF *demotes* the sole covering hit and loses.
   This unifies the Phase-2 win, the Phase-2b loss, and §0/S3 in one variable. **Default to plain RRF;**
   route only when a workload is single-coverage-dominant. Confidence-gated fusion (margin gate) is
   refuted; a *calibrated* confidence fuser is still open.
2. **Per-style specialisation is real:** structural (graft) owns structure/typos/span-precision; dense
   (vector) owns paraphrase semantics but returns shallow spans; sparse (BM25/grep) owns exact literals.
3. **File-level scoring overstates quality; judge spans.** Chunk retrievers need a span-refinement stage
   (the Rung 0a chunker); structural retrieval returns symbol spans and sidesteps it.

**Scope caveat that governs transfer:** Phases 2–2d ran on the **code repo** as corpus. They bind the
*structural* retriever (HR1/HR2) and the *general* fusion/routing question. Transfer to
*conversation-trace event* retrieval (what shipped `context_search` does) is a hypothesis — the corpora
differ. The coverage-overlap rule is corpus-agnostic; the graft/span numbers are code-scoped. All n are
small (9–24); treat as directional.

---

## Recommended `reports/algorithm.md` updates

Proposed, not applied — each cites the line it touches and the evidence. Numbers stay in the reports.

**U1 — Refine the fusion boundary condition (algorithm.md:287, "Fusing indexes with disjoint
coverage").** Current text says fusion is harmful and to route across indexes. Sharpen it to the
*coverage-overlap* rule, because the sign flips with coverage:
> *Multi-retriever fusion (RRF): the sign is set by coverage overlap. Over ONE corpus with overlapping
> coverage, RRF beats best-single and routing (measured on the repo benchmark). Across DISJOINT indexes,
> or on single-coverage queries, RRF demotes the sole covering hit and loses to it (facet indexes 6/17
> vs 9/17; hardened-semantics 50% vs 63%). Default: fuse where coverage overlaps, route where it does
> not. Refuted repair: a top-1→top-2 margin gate on the fusion (`report-combinators.md`).*

**U2 — Downgrade the `tree-route` candidate's priority (algorithm.md:179-181, 383-ff).** The plan
positions multi-index *routing* as the next combinator to build. The combinator run shows routing does
**not** beat plain RRF on mixed traffic (17/20 routing accuracy, still ≤ RRF). Recommend: **build plain
multi-retriever RRF before `tree-route`**, and gate `tree-route` on a workload shown to be
single-coverage-dominant. Keep it a candidate; move RRF-over-retrievers ahead of it.

**U3 — Replace the fixed-window excerpt with an off-the-shelf chunk unit (algorithm.md:155-157 and the
param rows 226-227 `excerptChars`, 225 `eventHits`).** The retrieve block returns "an excerpt of its own
text"; the param table already flags `excerptChars`/`eventHits` as unvalidated host values that "should
derive." 0a shows the derivation is unnecessary bespoke work — a standard chunker (recursive/token) +
BM25 matches the bespoke `excerptAround`, and re-anchoring it (the D-a repair) is inert. Recommend:
mark `excerptAround` for retirement behind the `RetrievalProvider` interface, and record that
general-web cross-encoder rerank is refuted on code.

**U4 — Add a span-precision boundary condition (new row near algorithm.md:280-289).** File-hit ≠
answer-hit. Recommend adding:
> *A file-hit is not a span-hit. Chunk retrievers (esp. dense) find the right file but the returned
> chunk holds the answer line only sometimes (vector 25% span|file); structural retrieval returns symbol
> spans, so file-hit ≈ span-hit (graft 71%). On code, prefer a structural unit or add a span-refinement
> stage; do not score retrieval at file granularity.*

**U5 — Record the HR2-INVARIANT where the retrieve block meets tool results (note near algorithm.md:150
or the `append a result` stanza).** A retrieval-shaped tool the *model* called returns an already-ranked,
structure-preserving payload; it is retained/evicted whole, never re-chunked or re-ranked. The chunk/rank
pipeline applies only to retrieval the system itself initiates from L0. (Already added to
`hypothesis-test-ladder.md` under HR2; algorithm.md should carry a one-line pointer so a porting host
does not re-retrieve tool results.)

**Not recommended as changes yet (evidence too thin / out of scope):** promoting graft into the live
`context_search` path for *trace-event* retrieval (code-scoped evidence only); any embedding-model
choice (sub-sweep unrun); a calibrated-confidence fuser (unbuilt). These are candidates, not settled.
