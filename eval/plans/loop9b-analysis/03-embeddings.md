# Lens 3 — Embeddings: minimal wiring for semantic `context_search`

## Abstract

`context-tree`'s retrieval already has a fully-built semantic path — `TreeRetriever.search()`
branches to a real sqlite-vec KNN query the instant it is handed an `embed` function and the
store's L3 table is non-empty (`packages/core/src/retrieve/retriever.ts:82-84`). Nothing in that
path is missing or stubbed. What is missing is the one thing outside `packages/core`: an actual
embeddings HTTP client. Across the whole repository there is no code that ever constructs an
`embed` function and hands it to a `TreeRetriever` — not in the CLI, not in the eval harness, not
in production wiring. `eval/scripts/transplant.mjs`, the harness this lens is scoped to, says so
explicitly in its own header comment and then does exactly that at both of its two `TreeRetriever`
call sites (`transplant.mjs:15-16`, `:590`, `:2602`): "`TreeRetriever` with no embedder (lexical
beam fallback, always)". The config layer even anticipates an embedding provider — `embedModel`/
`embedDim` fields exist and default to `'voyage-3-lite'` / `512` (`config.ts:79-105`) — but there
is no `VoyageProvider`, no `openai` entry in `ApiKeys`, and `OPENAI_API_KEY` is read by nothing in
this codebase today (confirmed by grep: `API_KEY_ENV_NAMES` lists only `anthropic`, `openrouter`,
`voyage` — `config.ts:224-227`). The `openai` npm package this needs is already a direct
dependency (`packages/core/package.json:34`, version `^7.8.0`), used today only for its chat
completions surface by `OpenRouterProvider` (`openrouter.ts:75`); its `.embeddings.create()`
method is unused. The fix is a small, additive, one-file client plus three call-site edits — no
change to the retrieval architecture itself. Measured against the real s1 fixture store, the cost
to embed it is under a hundredth of a cent, and the current lexical-only `g15` self-retrieval gate
is *empirically* a near-chance, vacuous pass today (median rank ~11 of 19, strict top-3 hit rate
2/12 — see §4), which is the sharpest evidence for why this wiring matters.

---

## 1. Exact insertion points

| # | What | File : line | Current state |
|---|---|---|---|
| 1 | `SummaryEmbedder` type the client must satisfy | `packages/core/src/retrieve/types.ts:17` | `(texts: readonly string[]) => Promise<Float32Array[]>` — already defined, unused by any real client |
| 2 | Where `search()` decides vector vs. beam | `packages/core/src/retrieve/retriever.ts:82-84` | `if (this.embed === undefined) return beamSearch(...)`; `if (store.embeddingDim() === null) return beamSearch(...)`; else `searchSummaries()` (vector). **No code change needed here** — just needs a non-undefined `embed` and a populated L3. |
| 3 | The call that builds L3 for a store | `packages/core/src/retrieve/retriever.ts:274-314` (`embedSummaries`) | Fully implemented: batches every node with `current_summary_version > 0`, builds `summaryDocument(node, summary)` text per node (`lexical.ts:44-54`), calls `this.embed(texts)` once, writes each vector via `store.putEmbedding(nodeId, version, vec)`. Zero missing plumbing. |
| 4 | L3 write / dimension binding | `packages/core/src/store/sqlite.ts:512-598` (`embeddingDim`, `putEmbedding`, `ensureEmbeddingsTable`, `knn`, `dropEmbeddings`) | Works today; dimension is **not hardcoded** — see §2. |
| 5 | **Missing: the embeddings HTTP client** | *(does not exist)* — natural home: `packages/core/src/models/embeddings.ts`, alongside `anthropic.ts`/`openrouter.ts` | Needs to be written. Shape below. |
| 6 | Config key to select embed provider/model | `packages/core/src/config.ts:76-105` (`embedModel: string`, `embedDim: number` already on `ContextTreeConfig`, default `'voyage-3-lite'` / `512`) | Fields exist but are dead — nothing reads them to build an embedder (grep confirms zero non-test, non-`config.ts`/`init.ts` references). Needs either repurposing (change the default value) or a new `embedProvider` selector — flagged as an open design point in §2, not resolved here. |
| 7 | API key plumbing | `packages/core/src/config.ts:213-238` (`ApiKeys` interface, `API_KEY_ENV_NAMES`) | Has `anthropic`, `openrouter`, `voyage`. **Has no `openai` key at all.** `.env`'s new `OPENAI_API_KEY` is read by nothing. Needs one line added to `ApiKeys` and one entry added to `API_KEY_ENV_NAMES` (mirroring the existing `anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_KEY']` pattern at line 225). |
| 8 | Where the eval harness constructs `TreeRetriever` | `eval/scripts/transplant.mjs:590` and `:2602` | Both are `new TreeRetriever({ store, blobs, trace })` — no `embed` key. These are the two lines to add `embed: createEmbedder(...)` to. |
| 9 | Where L3 would actually get built for the s1 store | *(no call site exists)* | `retriever.embedSummaries()` is never invoked outside `packages/core/test/retrieve.test.ts`. A one-off script or a new `--phase embed` step in `transplant.mjs` is needed to populate `eval/fixtures/transplant/s1/store/tree.db`'s `embeddings` table once. |
| 10 | CLI production path (out of this lens's scope, noted for completeness) | `packages/cli/src/commands/rebuild.ts:7,22,44` | `rebuild` *drops* L3 (`dropEmbeddings()`) as part of a full L1 rebuild but never re-populates it. There is no `context-tree embed` command anywhere in `packages/cli/src/commands/` (`init.ts`, `import.ts`, `rebuild.ts`, `render.ts`, `summarize.ts`, `tree.ts`, `eval.ts` — grepped, no `embed` verb). |

### The client itself — minimal shape

Mirroring `OpenRouterProvider`'s existing pattern (`openrouter.ts:66-76`, which already does
"the `openai` client with the base URL overridden" for chat completions), the new file needs
only:

```ts
// packages/core/src/models/embeddings.ts
import OpenAI from 'openai';
import type { SummaryEmbedder } from '../retrieve/types.js';

export interface EmbeddingClientOptions {
  apiKey: string;
  model: string;          // e.g. 'text-embedding-3-small'
  baseURL?: string;       // omit for api.openai.com; OPENROUTER_BASE_URL for OpenRouter
  client?: { embeddings: { create(params: unknown): Promise<{ data: { embedding: number[] }[] }> } };
}

export function createEmbeddingClient(options: EmbeddingClientOptions): SummaryEmbedder {
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
  return async (texts) => {
    const response = await client.embeddings.create({ model: options.model, input: texts as string[] });
    return response.data.map((row) => Float32Array.from(row.embedding));
  };
}
```

This satisfies `SummaryEmbedder` (`types.ts:17`) exactly, needs no new dependency (`openai` is
already in `packages/core/package.json:34`), and the `client` injection point mirrors
`OpenRouterProviderOptions.client` (`openrouter.ts:63-64`) for the same offline-test reason (§5).

---

## 2. Constraints

**sqlite-vec dimension is not fixed in code — it is fixed per-store, lazily, on first write.**
`vec0EmbeddingsDdl(dim)` (`schema.ts:78-85`) takes `dim` as a parameter and is only invoked from
`ensureEmbeddingsTable` (`sqlite.ts:578-585`) the first time `putEmbedding` runs, using
`vec.length` from whatever vector was just produced. The chosen dimension is then persisted in the
`meta` table (`META_EMBEDDING_DIM`) and every subsequent `putEmbedding` at a different width throws
a `StoreInvariantError` telling the caller to `dropEmbeddings()` and re-embed (`sqlite.ts:592-597`).
So there is no global constant to change — the constraint is *consistency within one store*, not a
fixed number across the codebase. Because L3 is declared disposable by design (D8, restated in the
`dropEmbeddings` docstring at `sqlite.ts:539-540` and the `rebuild.ts:7` header), **the model choice
is fully reversible**: switching embedding models later is `dropEmbeddings()` + `embedSummaries()`
again, not a migration.

**Model choice: `text-embedding-3-small` (1536-dim, OpenAI) over a 1024-dim OpenRouter model, for
this wiring pass.** Reasons, weighted by what's actually true of this codebase rather than general
embedding-quality lore:
- `OPENAI_API_KEY` is the fact stated in the task and the only new credential actually present;
  `api.openai.com/v1/embeddings` is the best-documented, most exercised embeddings endpoint that
  exists, and its request/response shape is exactly what the `openai` npm client already speaks
  (same package this repo already imports for `OpenRouterProvider`).
- OpenRouter serving embedding models via the same OpenAI-compatible shape is stated as fact by
  the task but is **not exercised anywhere in this codebase** — `OpenRouterProvider` only ever
  calls `chat.completions.create` (`openrouter.ts:78-84`), never `.embeddings.create()`. Whether
  OpenRouter's embeddings endpoint returns the same `{data:[{embedding}]}` shape, prices per-token
  the same way, and accepts the same batch semantics is unconfirmed here — this is the "flag
  anything that needs a live check" item (see §5's one live check).
- Existing in-repo evidence pulls the same direction: `config.ts:127-130`'s own comment says
  "OpenRouter exposes no embedding endpoint, so `embedModel` there is unusable" — which is now
  stale/contradicted by the task's stated fact that OpenRouter does serve some embedding models,
  but it is evidence the codebase's own prior author did **not** validate an OpenRouter embeddings
  path when this config was written. That gap should be closed with a live check, not assumed away.
- Because L3 is disposable (previous paragraph), this is a **cheap, reversible default** — not a
  permanent architectural commitment. If a 1024-dim OpenRouter model turns out equivalent (or
  needed for provider-parity with the chat-completion side, which already runs OpenRouter for the
  transplant harness's `qwen`/`gpt-3.5-turbo` answerer models per `manifest.json`'s `"answerers"`
  list), swapping is one `dropEmbeddings()` call away.

**Batch size:** a single call. Counted directly against the real s1 store (§4): 22 summaries,
~19,000 characters total, ~4,700 tokens — one request, far under OpenAI's documented
per-request array-input ceiling (thousands of items / hundreds of thousands of tokens). No
batching logic is needed for this fixture; a production store with hundreds of summarized nodes
would still likely fit in one or a handful of calls. `embedSummaries` already batches everything
into one `this.embed(texts)` call per invocation (`retriever.ts:296`) — the client itself needs no
internal chunking for anything this repo currently produces.

**Open design point, not resolved here:** should the new client reuse the existing but dead
`embedModel`/`embedDim` config fields (`config.ts:79-81`, defaulting to `'voyage-3-lite'`/`512`)
by just changing their default value and adding an `openai`-shaped client behind them, or add a
parallel `embedProvider: 'openai' | 'openrouter' | 'none'` selector next to the existing `provider`
field (`config.ts:82`)? The existing `PROVIDER_MODEL_DEFAULTS` pattern (`config.ts:131-146`) shows
the codebase's established idiom for "provider selects which model-id set applies" — the same
shape would fit an embed provider naturally. This is a judgment call for whoever implements this,
not something this analysis pass should silently decide.

---

## 3. Does semantic search REPLACE the lexical beam, or merge with it?

**Within `TreeRetriever` itself: replace, not merge.** `search()`'s dispatch is a strict either/or
(`retriever.ts:82-84`):
```ts
async search(query, options = {}) {
  if (this.embed === undefined) return { ...this.beamSearch(query, options), fallback: 'no-embedder' };
  if (this.store.embeddingDim() === null) return { ...this.beamSearch(query, options), fallback: 'no-embeddings' };
  return this.searchSummaries(query, options);
}
```
Once an embedder is injected and L3 is non-empty, `beamSearch` (the lexical TF-IDF-ish path,
`retriever.ts:127-172`) never runs again for that store. The `TreeSearchResult.path` field records
which one ran (`'vector' | 'beam'`, `types.ts:20`), which is how the eval's own instrumentation
(g15, verdict scoring) can tell which mechanism produced a result set — it is not a hedge that
keeps both alive.

**At the layer above — the MCP `context_search` tool / `RetrievalProvider` fan-out (§9.1) — the
answer is genuinely "merge," but that merge is unaffected by adding an embedder.**
`packages/mcp/src/tools/context-search.ts:142-145` merges the tree's own hits (whatever
`TreeRetriever.search()` returned — vector or beam, doesn't matter to this layer) together with
every other registered `RetrievalProvider` (graft, Serena, Augment, grep) via `mergeCandidates`
(`packages/core/src/providers/merge.ts`), which enforces §9.1's fixed tier order: structural
(graft/Serena) → fuzzy (Augment, and the tree itself) → grep last, except `mode: 'exhaustive'`
where grep leads (`merge.ts:6-13`, `merge.ts:30`). The tree's candidates are *always* tagged
`tier: 'fuzzy'` regardless of which internal mechanism produced them —
`vector-provider.ts:39` in the standalone `createVectorProvider` path, and
`context-search.ts:107` in the harness's own tool handler. So: **adding an embedder changes the
*quality* of the tree's fuzzy-tier candidates (semantic vs. keyword-overlap ranking) but changes
nothing about cross-tier ordering, dedup key `(path, span)`, or the merge algorithm.** One more
detail worth flagging: `merge.ts:48-49`'s `compare()` explicitly does **not** compare scores across
providers ("`Candidate.score` is documented as provider-local, so ranking graft's 0.5 against
augment's 0.9 would be noise dressed up as relevance") — ties within a tier break on provider id,
not score, across providers. Within the tree's own single-provider slice, though, vector cosine
scores are homogeneous and meaningfully comparable to each other, which is exactly what
`searchSummaries` returns (`retriever.ts:113`, `1 - hit.distance`).

`eval/scripts/transplant.mjs` does not exercise this two-provider merge at all in the transplant
harness — its own docstring says the tree runs with "no embedder... always" and no other
`RetrievalProvider` is registered there (no `createVectorProvider`, no `GrepProvider` reference
anywhere in the file — confirmed by direct search of all 2,967 lines). So for this eval's purposes,
"does semantic replace or merge with lexical" reduces entirely to the §3-first-paragraph answer:
inside `TreeRetriever`, it replaces.

---

## 4. Cost to embed the s1 store, and per-query cost (measured, not estimated)

Queried directly against `eval/fixtures/transplant/s1/store/tree.db` (the real store the manifest
at `eval/fixtures/transplant/s1/e1b289c32f40/manifest.json` says holds "summaries": 22, "nodes": 46,
"l0_events": 754):

```
sqlite3 .../tree.db "SELECT count(*) FROM nodes WHERE current_summary_version > 0;"   → 22
```

Reproducing `summaryDocument(node, summary)` (`lexical.ts:44-54`) exactly against every one of
those 22 nodes' current summary (title + path + summary text + file paths/symbols + bare symbols,
joined with `\n`):

| Component | Total chars across 22 docs |
|---|---|
| `summary.text` | 13,468 |
| `node.title` | 312 |
| `meta.path` (file nodes only; these are all `phase`/`task` nodes) | 0 |
| `summary.meta.files[].path`/`symbol` | 4,918 |
| `summary.meta.symbols[]` | 256 |
| **Total** | **~18,954 chars** |

At the standard ~4 chars/token approximation for English prose (this repo's own `HeuristicTokenizer`
uses a similar approximation per `transplant.mjs`'s `g7-bpe-ratio` gate, which measured a real
0.85 heuristic→BPE ratio over this exact trace — see `gates.json`'s `g7-bpe-ratio: PASS ratio =
207395/243737 = 0.850897`): **~4,700 tokens** for the whole store, one batch call.

**Cost at `text-embedding-3-small`'s $0.02 / 1M tokens: ~$0.00009 — under a tenth of a cent to
embed the entire s1 store.** This is not a meaningful cost constraint on any decision here.

**Per-query cost:** the 12 questions in `questions.json` average roughly 100-160 characters each
(sampled directly — e.g. `"In the import block that follows the comment about testing block ids
and token counts instead of prose, which file is imported..."` ≈ 150 chars). At ~4 chars/token
that's ~35-40 tokens per query, or **~$0.0000007 per query** — effectively free; embedding all 12
questions costs about the same order of magnitude as embedding one summary.

**This means cost is not a reason to gate this experiment.** The entire embed-once-and-search-many
workload for this fixture is sub-cent; a per-run cost cap (`costCapUsd`, `config.ts:91`) would
need to be pathologically small to even notice it. Nothing in `DEFAULT_PRICES`
(`packages/core/src/models/cost.ts:56-73`) currently has an embedding-model entry, so if
`embedSummaries` calls are to be routed through `MeteredProvider`/`InMemoryCostMeter` like every
other model call in this repo, one entry would need adding — a one-line, low-risk change given the
price is public and the volumes here are trivial.

---

## 5. Zero-live-token test plan, and the one live check needed

**Offline test pattern already exists and should be reused verbatim.**
`packages/core/test/retrieve.test.ts:104-119` already has a `fakeEmbedder()` — a deterministic,
axis-count-based `Float32Array` generator, injected as `TreeRetriever({ ..., embed: embedder.embed
})` in 9+ existing test cases (`retrieve.test.ts:256, 272, 290, 301, 314, 345, 558, 574, 583, 593`),
including a dedicated `describe('TreeRetriever.embedSummaries — L3 is disposable (D8)')` block
(`retrieve.test.ts:554-596`). A new `createEmbeddingClient` unit test needs only:
1. Inject a fake `client: { embeddings: { create: async () => ({ data: [...] }) } }` (mirroring
   `OpenRouterProviderOptions.client` at `openrouter.ts:63-64`, which is exactly this pattern
   already proven for the chat-completions client) — assert the request shape (`model`, `input`)
   and the response mapping (`data[i].embedding` → `Float32Array`).
2. Run the *existing* `retrieve.test.ts` suite unchanged against a `TreeRetriever` wired with the
   new client behind the same fake-`client` seam — since `SummaryEmbedder`'s contract is already
   fully tested against `fakeEmbedder()`, the new client only needs to prove it correctly adapts
   OpenAI's wire format to that contract; it does not need to re-derive `TreeRetriever`'s own
   correctness.
3. Error-path tests: empty `texts` array, a response with fewer `data` rows than `texts` sent
   (`retriever.ts:311-313` already throws `E_RETRIEVE_EMBED_SHAPE` for this — the client's job is
   just to not swallow it), and a non-200 response (should surface, not retry silently — mirrors
   `withRetry`'s existing use in `openrouter.ts:79-82`, which the embeddings client should also
   wrap).

None of this needs a network call or an API key: `LIVE=1`-gated (per `CLAUDE.md`'s own stated
policy: "Live-model tests are opt-in via `LIVE=1`; CI never hits the network").

**The one live check that cannot be done offline:** an actual call to `api.openai.com/v1/embeddings`
with `OPENAI_API_KEY` for `text-embedding-3-small`, to confirm (a) the response shape matches the
`openai` npm client's typed `Embedding` (`{data: [{embedding: number[], index, object}], model,
usage: {prompt_tokens, total_tokens}}`) exactly as assumed above, and (b) — if an OpenRouter
embedding model is later tried — that `openrouter.ai/api/v1/embeddings` accepts the same
`OpenAI`-client call shape used for chat completions in `openrouter.ts`. Nothing in this repository
currently exercises either endpoint, so this is a genuine unknown, not a formality — flagged
per the task's own instruction rather than assumed to just work.

---

## 6. Pre-registered experiment design: tree-lexical vs. tree-semantic

**Setup.** Same store (`eval/fixtures/transplant/s1/store/tree.db`), same 12 questions
(`e1b289c32f40/questions.json`), two arms differing only in whether `TreeRetriever` is constructed
with `embed` set (after running `embedSummaries()` once to populate L3) or left as today (no
`embed`, beam fallback). Everything else — `TREE_SYSTEM` prompt, `CONTEXT_TOOL_SCHEMAS`, budgets,
answerer models — held fixed, exactly the way `transplant.mjs`'s own docstring insists every arm
get "the same frozen substrate, the same question set, the same epoch."

**Primary pre-registered metric: `g15` self-retrieval rank**, since it is already instrumented,
already computed per-question, and — measured just now against the *current* lexical-beam arm —
is not doing well:

```
gates.json → g15-self-retrieval: PASS
"all 12 question(s) retrieve their own source within top 20
 (ranks: 15, 11, 15, 10, 7, 5, 1, 11, 17, 6, 2, 11; task root excluded)
 | strict top-3: 2/12
 | WARNING: topK=20 >= 19 results returned, so this threshold accepts every
   result the search returns and proves nothing about referent uniqueness"
```

Two things follow directly from this real result, not from general reasoning about search
mechanisms:
- **The gate is currently vacuous.** `SELF_RETRIEVAL_TOP_K = 20` (`transplant.mjs:152`) is ≥ the
  beam search's actual returned candidate count (19, i.e. every non-root branch node in the
  store), so no question can ever fail g15 by the source being *absent* from the ranked list —
  only by not existing at all. The gate's own code says this plainly (`transplant.mjs:1578-1584`,
  the `vacuous` flag and warning string). A `PASS` today certifies only "the source exists
  somewhere in the store," not "the search found it."
- **Where it actually ranks is weak.** Median rank ≈ 11 of 19 (near the middle of an
  effectively-unordered list); mean ≈ 9.75. Strict top-3 hit rate is 2/12 (16.7%). For a search
  mechanism whose whole job is to put the right answer near the top, ranking at the *median* of
  the candidate pool is close to what a random shuffle would produce (expected median rank of a
  uniform-random ordering over 19 items is ~10) — i.e., **on this real evidence, the lexical beam
  is barely distinguishing the right branch from the wrong ones**, even though every question was
  specifically engineered to succeed at it. That engineering is visible in the question-generation
  prompt itself: `ANCHOR_RULES` (`transplant.mjs:1825-1836`) instructs the paraphraser to "QUOTE
  ANCHORS VERBATIM... Do NOT paraphrase the anchor" — a rule that exists *because* lexical search
  needs literal token overlap to find anything. This is the mechanism behind Loop 8's stated
  finding that "the lexical-only search over summary text made hard questions nearly unwritable" —
  it's not a vague impression, it's why the prompt has to forbid paraphrasing the one part of the
  question that actually needs to match text in the store.

**Expected effect of a semantic arm:** rank improvement should be concentrated on questions whose
`ANCHOR_RULES`-mandated verbatim quote doesn't happen to co-occur with the summary's own wording —
which, given `PARAPHRASE_INSTRUCTIONS`'s explicit mandate to "Describe the situation in your own
plain words... Do not copy phrasing wholesale" (`transplant.mjs:1854-1855`), should be most
questions, since paraphrasing is the point and verbatim-anchor quoting is a narrow carve-out
inside it. **Prediction (hypothesis, not yet run):** tree-semantic's `g15` ranks should show a
materially lower median (and a real strict-top-3 rate, since embeddings rank on meaning rather
than token overlap) and the vacuous-topK warning should no longer describe the gate, since a
14-dim smaller effective candidate set won't make the check pass by construction the way lexical's
does today at 19-of-20.

**The risk this lens is asked to evaluate: does semantic search help head/deep questions but not
tail — and is tail a *content* problem rather than a *search* problem?**

This is worth separating into what's evidenced here and what's still open:
- **Evidenced:** the 12 questions split evenly across `head`/`tail`/`deep`/`spanning` (3 each,
  confirmed by direct count against `questions.json`). Under the tree architecture, `tail` in this
  harness's own stratification (`transplant.mjs`'s prep-phase cutting logic, referenced at
  `transplant.mjs:1869-1870`, "Strata are cut against the SMALLEST window's K") means facts that
  fall *inside* the smallest truncation window — i.e., recent enough that even `truncate-tail`
  should see them. Tail questions target the most recently active branch, which under D3/D17's
  root-composition (`rootKeep`, `config.ts:88`) is exactly the branch still *expanded* in Zone C
  rather than folded into a one-line root summary (§10 rule per `CLAUDE.md`'s architecture
  section). If a tail question's source node is one of the few branches still fully present in
  the prompt (not summarized-and-folded), no retrieval mechanism — lexical or semantic — is doing
  the work; the model just reads it directly. That would make "semantic search doesn't move tail"
  a **structural, not a content, explanation**: tail questions may simply not need `context_search`
  at all in this design, independent of retrieval quality.
- **Not yet evidenced (hypothesis):** whether *this particular* store's tail questions are
  actually answerable directly from Zone C without any tool call, versus needing retrieval and
  failing it for a content reason (e.g., the tail branch's summary omits the fine detail the
  question asks about — a summarization-fidelity problem, which is a different lens's territory,
  not this one's). Confirming this needs an actual run: instrument whether each arm's answering
  model called `context_search`/`context_fetch` at all per stratum, and if it did for tail
  questions, whether the rank of the correct source changed between arms. If tail questions are
  answered from Zone C without a tool call in *both* arms, the semantic-vs-lexical choice is
  provably irrelevant to tail, which would directly support the framing that tail's ceiling is a
  content/summarization problem, not a search problem — but that is a claim this analysis can
  motivate from the architecture, not confirm without the run.

**Falsifiable prediction set for the actual experiment:**
1. `g15` median rank (semantic) < `g15` median rank (lexical), by a margin the vacuous-topK
   warning would no longer apply to (i.e., report strict top-K, not just top-20).
2. Answer accuracy on `head`/`deep`/`spanning` strata improves more under tree-semantic than under
   tree-lexical (these are the strata where the answering model is expected to actually need
   `context_search` to find a folded/summarized branch).
3. Answer accuracy on `tail` shows little to no arm difference — and per-question tool-call logs
   should show *why*: either the model answers from Zone C directly in both arms (structural, not
   a content problem — the tail stratum doesn't exercise search-quality at all), or it calls
   `context_search` in both arms and gets similar (low) accuracy despite different ranks (which
   *would* implicate summary content/fidelity as tail's bottleneck, not retrieval). Distinguishing
   these two needs the tool-call trace from an actual run — this report can only lay out the test,
   not its answer.

---

## FINDINGS (evidenced in this pass)

- `TreeRetriever.search()` deterministically prefers vector search over the lexical beam and never
  runs both — confirmed by reading the dispatch logic verbatim (`retriever.ts:82-84`).
- No embeddings HTTP client exists anywhere in this repository; the `openai` npm package is
  already a dependency but only its chat-completions surface is used
  (`openrouter.ts`, `package.json:34`).
- `embedSummaries()` is fully implemented and tested against a mock embedder
  (`retrieve.test.ts:104-119` and 9 call sites) but is never invoked from any CLI command or the
  eval harness — confirmed by exhaustive grep of `packages/cli/src/` and `eval/scripts/`.
- `ApiKeys`/`API_KEY_ENV_NAMES` (`config.ts:213-227`) has no `openai` entry; `.env`'s
  `OPENAI_API_KEY` is read by nothing in this codebase today.
- sqlite-vec's embedding dimension is set dynamically from the first vector's length, not
  hardcoded, and is enforced-consistent per store thereafter (`sqlite.ts:578-598`,
  `schema.ts:78-85`) — so model/dimension choice is fully reversible per D8 (L3 disposability).
- The MCP-layer provider merge (§9.1, `merge.ts`) is unaffected by adding an embedder: the tree's
  candidates are tagged `tier: 'fuzzy'` regardless of which internal mechanism (vector or beam)
  produced them (`vector-provider.ts:39`, `context-search.ts:107`).
- Measured against the real `eval/fixtures/transplant/s1/store/tree.db`: 22 summarized nodes,
  ~18,954 chars of `summaryDocument` text, ~4,700 tokens, costing ~$0.00009 to embed once at
  `text-embedding-3-small` pricing; per-query embedding cost is ~$0.0000007 — cost is not a
  material constraint on this decision.
- The current lexical-beam `g15-self-retrieval` gate is empirically vacuous on this fixture
  (`topK=20 ≥ ranked=19`) and its actual ranks (median ≈11/19, strict top-3 = 2/12) show
  near-chance discrimination, despite every question's anchor phrase being deliberately quoted
  verbatim from source text by the question-generation prompt (`ANCHOR_RULES`,
  `transplant.mjs:1825-1836`) specifically so lexical search could find it at all.

## HYPOTHESES (not yet evidenced — need a live run)

- Switching to a semantic embedder will materially lower `g15` ranks and produce a non-vacuous
  strict top-K pass rate on this same question set.
- Answer accuracy gains from semantic search will concentrate on `head`/`deep`/`spanning` strata
  and be flat on `tail`.
- Tail's flatness, if observed, is more likely a structural artifact (tail questions answerable
  directly from an un-folded Zone C branch, bypassing retrieval entirely) than a summarization-
  content ceiling — but this requires per-question tool-call instrumentation from an actual run to
  distinguish from the alternative (both arms call search, both get poor accuracy, implicating
  summary fidelity instead).
- OpenRouter's `/embeddings` endpoint mirrors OpenAI's wire shape closely enough for the same
  client code to work against both providers unmodified — asserted by the task, unconfirmed by any
  code or test in this repository.

## Open questions

1. Should the new embedder be wired behind the existing (currently dead) `embedModel`/`embedDim`
   config fields, or a new parallel `embedProvider` selector alongside `provider`? (§2)
2. Does `embedSummaries()` get a dedicated CLI verb (`context-tree embed`), get folded into
   `rebuild` (which already drops L3 but never rebuilds it, `rebuild.ts:44`), or stay
   eval-harness-only for now? Out of this lens's scope but blocks "production" wiring beyond the
   transplant store.
3. Should embedding calls be metered through `MeteredProvider`/`InMemoryCostMeter` given every
   other model call in this codebase is (`cost.ts`)? No `DEFAULT_PRICES` entry exists yet for any
   embedding model.
4. Is `text-embedding-3-small` at 1536-dim actually preferable long-term to a 1024-dim OpenRouter
   model once the live check (§5) resolves the OpenRouter-shape unknown, given the chat-completion
   answerer models in this same harness already run on OpenRouter?
