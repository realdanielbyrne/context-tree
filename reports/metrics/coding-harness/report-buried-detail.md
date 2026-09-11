# Buried detail — summarize is insufficient; chunk+retrieve is the right reducer

**Question.** The read-loop break-out reduces a large tool result's footprint (D-EV6). A reducer
only breaks the loop *without losing the task* if it **preserves what the task needs**. Does it?
Tested directly, isolated from agent-loop dynamics: single-turn QA on the reduced document. One
variable = the **middleware reducer** (the plugin's `tool.execute.after` payload).

**Setup.** A 14-section service spec (~1473 tokens) buries one detail — "the payments API rate limit
is **137** requests per minute" — in the body of §Rate Limits; everything else is filler. Ask the
local model (`unsloth/Qwen3.8-27B-GGUF`, temp 0) the rate-limit question given the **reduced** doc.
Reducers: `none` (full), `summarize` (headings + first lines), `chunk_retrieve` (spans most relevant
to the question, verbatim). Numbers: `results-buried-detail.json`. Rerun:
`node experiments/coding-harness/buried-detail.mjs`.

## Result — hypothesis CONFIRMED

| reducer | answer present in reduced doc | model answer | ctx tokens |
|---|---|---|---|
| none | ✓ | **PASS** (137) | 1473 |
| **summarize** | **✗ — 137 dropped** | **FAIL** (UNKNOWN) | 361 |
| **chunk_retrieve** | **✓ — 137 kept** | **PASS** (137) | **278** |

- **Summarization is insufficient for a buried detail.** The gist keeps headings + first lines and
  drops the specific number, so the model literally cannot answer — and it **correctly abstains
  ("UNKNOWN")** rather than hallucinating (good calibration; the failure is missing info, not a bad guess).
- **Chunk+retrieve is the right reducer for a localized detail, and it DOMINATES summarize on both
  axes** — correct *and* the fewest tokens (278 < 361 < 1473). Summarize wastes its budget on every
  section's heading; chunk keeps only the one relevant span. For a localized query there is no tradeoff.
- **The reducer must be query-aware.** Neither reducer is universally right: gist-sufficient/structural
  need → summarize; localized buried detail → chunk+retrieve; whole-document synthesis → the tree
  (summary as index + on-demand chunk drill-down). The plugin's decision logic is a **router** over these.

## Bonus finding (agent-loop version): a capable agent routes AROUND lossy summarization

Before isolating this single-turn, the agent-loop version ran with a full toolset. There, the
`summarize` arm **passed anyway** — the agent, not finding the number in the gist, issued a `run_bash`
grep of the raw file and recovered it. That is **on-demand retrieval by the model itself** (HR2 /
model-gated retrieval): when the agent has a search tool, lossy summarization is *lossy but not fatal*
— it pays an extra fetch. Restricting the toolset to force the reducer's path re-introduced a read-loop
on the weak 27B (it re-read without committing). **So the reducer matters most under forced window
overflow (no escape hatch) or with weaker agents; a strong agent with search partly self-heals.**

## Implications for the middleware design

- **The reducer is a pure `tool.execute.after` transform** (validated as the plugin seam): it shrinks
  a tool result before it enters context, never touching the agent loop — exactly what bolts onto
  opencode / Claude Code / Cline.
- **D-EV6 refined:** pair eviction with a **query-aware** footprint reducer — a router that picks
  `summarize` (gist-sufficient) vs `chunk_retrieve` (localized detail). This is the summary-headed tree
  with drill-down, expressed as middleware.

## Tested vs. open

- **Tested (live, decisive):** summarize drops a buried detail → task fails (model abstains);
  chunk+retrieve keeps it → succeeds at the lowest token cost; the reducer is a clean middleware transform.
- **Open:** the retriever here is BM25-ish string overlap (a real one is stronger); **whole-document
  synthesis / multi-detail** queries where a single span is insufficient (needs hierarchical
  summary+drill-down); the **router** that chooses the reducer per turn; and the **PDF/vision** version
  (needs an image model — deferred: a weak vision model would confound extraction with the mechanism).

**Caveats.** n=1 per arm, temp 0 (deterministic). Single model, single synthetic doc. The chunk
retriever is a weak lexical proxy. Text-only.
