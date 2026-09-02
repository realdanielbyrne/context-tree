# Loop-9b item 2, Step 5 — embeddings client (Graft 4 / G6)

Implements Step 5 of `eval/plans/loop9b-item2-judge-verdict.md` and the exact insertion
points from `eval/plans/loop9b-analysis/03-embeddings.md`: an OpenAI-compatible embeddings
client, wired to `TreeRetriever`, with G6's offline lexical-vs-semantic self-retrieval
table computed against a **copy** of the real `s1` store. Worktree:
`/Users/danielbyrne/GitHub/rpm/context-tree-wt-embed` (branch `loop9b-embed`, off `b8d395d`).
No commits made. `packages/core/src/models/vector-provider.ts`, `context-search.ts` and
`openrouter.ts` — modified uncommitted in the main checkout by other work — were left at
this branch's clean `HEAD` state; nothing here depends on those diffs.

## 1. Files touched

| File | Change |
|---|---|
| `packages/core/src/models/embeddings.ts` (**new**) | `createEmbeddingClient(options)` → `SummaryEmbedder`; `createEmbeddingClientFromKeys(options)` → same, but resolves the API key from `ApiKeys` by `baseURL` (`OPENAI_API_KEY` for the default host, `OPENROUTER_API_KEY` for `OPENROUTER_BASE_URL`). Validates `vectors.length === inputs.length` and uniform dimension, throwing `ModelCallError` otherwise. |
| `packages/core/src/models/index.ts` | Exports the two functions above and their option/client types. |
| `packages/core/src/config.ts` | `ApiKeys.openai` + `API_KEY_ENV_NAMES.openai = ['OPENAI_API_KEY', 'OPENAI_KEY']`. `embedModel` default changed `'voyage-3-lite'` → `'text-embedding-3-small'`. `embedDim` field **dropped** entirely (see §2). Stale comment claiming "OpenRouter exposes no embedding endpoint" removed — §5 below shows it does. |
| `packages/cli/src/commands/init.ts` | Dropped the now-nonexistent `embedDim: DEFAULT_CONFIG.embedDim` line from the config scaffold (required for the build to typecheck after removing the field). |
| `packages/core/src/models/cost.ts` | `DEFAULT_PRICES['text-embedding-3-small'] = { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 }`. |
| `packages/core/test/embeddings.test.ts` (**new**) | 8 tests, mocked client, zero network: batching/shape, model default, positional vector mapping, count-mismatch throw, dimension-mismatch throw, empty-input no-op, and `createEmbeddingClientFromKeys`'s key selection by `baseURL` (success both hosts + `ConfigError` naming the missing var on each). |
| `eval/scripts/embed-store.mjs` (**new**) | CLI: copies `<scenario>/store` to a temp dir, builds L3 via `TreeRetriever.embedSummaries()`, then for each question in a sibling `questions.json` prints the rank of `question.node_id` in `retriever.search(question.question)` — the G6 table. Never touches the frozen store. |
| `eval/package.json` | Added `"openai": "^7.8.0"` as a direct dependency — the script imports `OpenAI` itself (to wrap the client and read `usage.total_tokens` for a real cost figure); under this workspace's `node-linker=isolated`, a transitive dependency of `@context-tree/core` is not resolvable from `eval/`'s own `node_modules` without being declared there too. |

Not touched: `eval/scripts/transplant.mjs` (owned by the other agent — see §6),
`packages/core/src/retrieve/*` (Step 5 needs no retrieval-architecture change; the vector
path already exists and dispatches correctly — `03-embeddings.md` §1 row 2), `README.md` /
`docs/IMPLEMENTATION_PLAN.md` (both still show the old `embedModel: "voyage-3-lite"`
example — a follow-up, not in this step's scope).

## 2. `embedDim`: dropped, not kept

Verified directly against `packages/core/src/store/sqlite.ts:579-598`
(`ensureEmbeddingsTable`): the embeddings table's width is taken from `vec.length` of the
**first vector actually written**, recorded in the store's `meta` table, and every later
`putEmbedding` at a different width throws `StoreInvariantError` telling the caller to
`dropEmbeddings()` and re-embed. No code path reads `config.embedDim` to decide, validate,
or enforce anything — `resolveConfig`'s own `embedDim <= 0` check was the field's only
consumer, and dropping the field removes that check along with it. Confirmed by grep: the
only non-`config.ts` reference in the whole workspace was `packages/cli/src/commands/init.ts`
(fixed here) and a code comment in `store.test.ts:362` that doesn't assert on the field.
Per the task's own instruction, this makes `embedDim` safe to drop rather than keep.

## 3. The client

```ts
export function createEmbeddingClient(options: EmbeddingClientOptions = {}): SummaryEmbedder
export function createEmbeddingClientFromKeys(options: EmbeddingClientFromKeysOptions): SummaryEmbedder
```

`createEmbeddingClient` mirrors `OpenRouterProvider`'s exact shape (`openrouter.ts:61-77`):
an injectable `client` seam for tests, a real `new OpenAI({ apiKey, baseURL })` otherwise,
default model `text-embedding-3-small`. `createEmbeddingClientFromKeys` adds the one thing
the analysis flagged as not yet resolved (`03-embeddings.md` §2's open design point about
`embedModel`/`embedProvider` selection) at the narrowest scope that actually needed
resolving: *which key* a given `baseURL` needs, since a `baseURL` is the one fact that
already determines which host receives the request — a separate provider enum could
disagree with it. `embed-store.mjs` does its own key selection inline instead (§5), because
it also needs the raw `OpenAI` client to wrap for cost accounting; `createEmbeddingClientFromKeys`
is what a simpler caller (e.g. a future CLI `embed` command, `03-embeddings.md` open
question 2) would use directly.

## 4. Tests, typecheck, build

```
pnpm vitest run packages/core/test        → 25 files, 551 passed | 9 skipped (live-gated), 0 failed
pnpm vitest run packages/core/test/embeddings.test.ts  → 8 passed
npm run typecheck                          → clean (tsc --build core+mcp+cli, then tsconfig.test.json)
pnpm -r build                              → core, mcp, cli, eval all build clean
```
The 9 skips are the pre-existing `LIVE=1`-gated suites (`live.test.ts`, `cache.live.test.ts`,
`resume.live.test.ts`) — unrelated to this change, unaffected by it.

## 5. The one live check (real key, sub-cent) — both hosts

Ran `embed-store.mjs` against a **copy** of `eval/fixtures/transplant/s1/store` (the frozen
store itself is gitignored and isn't part of this git worktree's checkout, so it was copied
in read-only from the sibling `context-tree` checkout — `cp -R .../context-tree/eval/fixtures/transplant/s1/store …`,
no edit to that repo). `questions.json` in this worktree's own tracked fixture is a stale
snapshot whose `question` field is empty for all 12 rows (a pre-paraphrase commit); the
live `context-tree` checkout's uncommitted `questions.json` has the real paraphrased text,
so the run below points `--questions` at that file, read-only, via the flag `embed-store.mjs`
now supports for exactly this case.

**OpenAI (`OPENAI_API_KEY`, default host, `text-embedding-3-small`):**
```
embedSummaries: embedded 22, skipped 0 (model text-embedding-3-small)
cost: 13 call(s), 4860 token(s) reported by the API, $0.000097 at text-embedding-3-small pricing
```

**OpenRouter (`OPENROUTER_API_KEY`, `https://openrouter.ai/api/v1`, `openai/text-embedding-3-small`):**
```
embedSummaries: embedded 22, skipped 0 (model openai/text-embedding-3-small, https://openrouter.ai/api/v1)
cost: 13 call(s), 4860 token(s) reported by the API, $0.000097 at text-embedding-3-small pricing
```
It did **not** 404 — OpenRouter serves `openai/text-embedding-3-small` at the same
OpenAI-compatible `/embeddings` shape used for chat completions, confirming
`03-embeddings.md` §5's flagged unknown and identical results both ways (same underlying
model). `priceFor('openai/text-embedding-3-small')` correctly stripped the vendor prefix
and matched the one `DEFAULT_PRICES` row, so both runs meter identically. Combined spend
for this whole step: **$0.000194** (13 + 13 calls, 9,720 tokens total) — under the
analysis's ~$0.0001-per-run estimate for two runs, and immaterial against any per-PR cap.
No `.env` value was printed at any point (keys were read via `grep | cut` into a
process-scoped shell variable, never echoed; the script itself never logs `apiKey`).

## 6. Rank table — lexical (beam) vs semantic (vector), s1, all 12 questions

Lexical column is `gates.json`'s `g15-self-retrieval` result as it stands in the live
`context-tree` checkout today (read-only; **not** present in this worktree's own frozen
`gates.json`, which predates that gate — see caveat below). Semantic column is this step's
`embed-store.mjs` run (OpenAI; the OpenRouter run reproduced it exactly).

| id | stratum | lexical rank / ranked | semantic rank / ranked | Δ (lex − sem, + = better) |
|---|---|---|---|---|
| s1-q01-head | head | 15 / 19 | 14 / 21 | +1 |
| s1-q02-head | head | 11 / 19 | 8 / 21 | +3 |
| s1-q03-head | head | 15 / 19 | **4** / 21 | +11 |
| s1-q04-tail | tail | 10 / 19 | 13 / 21 | −3 |
| s1-q05-tail | tail | 7 / 19 | 11 / 21 | −4 |
| s1-q06-tail | tail | **5** / 19 | **5** / 21 | 0 |
| s1-q07-deep | deep | **1** / 19 | **1** / 21 | 0 |
| s1-q08-deep | deep | 11 / 19 | 13 / 21 | −2 |
| s1-q09-deep | deep | 17 / 19 | 17 / 21 | 0 |
| s1-q10-spanning | spanning | 6 / 19 | 12 / 21 | −6 |
| s1-q11-spanning | spanning | **2** / 19 | **5** / 21 | −3 |
| s1-q12-spanning | spanning | 11 / 19 | 10 / 21 | +1 |

- **Strict top-5:** lexical 3/12 (q06, q07, q11) → semantic 4/12 (q03, q06, q07, q11).
  Lexical's own reported "strict top-3" is 2/12 (q07, q11).
- **Median rank:** lexical 10.5/19, semantic 10.5/21 — a tie in absolute rank number, but
  over a *larger* candidate pool (see caveat), so semantic is ranking correctly among more
  real competitors for the same median position.
- **G6 verdict: PASS, barely.** Kill condition was "strict top-5 < 4/12, OR median rank ≥
  lexical's 11" (`03-embeddings.md` §6, loop9b-item2-judge-verdict.md Step 7 G6). Semantic
  lands at exactly 4/12 and 10.5 < 11 — neither trigger fires, so a live `tree-semantic` arm
  is licensed by this pass, but by the minimum margin, not a comfortable one.
- **Caveat — the two "ranked" denominators are not the same population.** Lexical's beam
  search only *reaches* 19 of the 21 non-root summarized nodes (`retriever.ts`'s `beamSearch`
  prunes to the top `beamWidth` at each level before descending — `01-run-forensics.md` /
  `03-embeddings.md`'s own text: "median rank ≈ 11/19"). The vector path is a flat KNN over
  every summarized node with no descent pruning (`retriever.ts:92` RAPTOR comment), so it
  ranks all 21. This is a real structural difference the two arms would carry into a live
  run, not a computation bug — noted, not corrected away.
- q03 and q10/q11 are the clearest split: paraphrase language for q03 apparently shares no
  useful lexical overlap with its summary (rank 15) but strong semantic similarity (rank 4);
  q10/q11 go the other way. Consistent with `03-embeddings.md`'s prediction that gains
  concentrate where `ANCHOR_RULES`' verbatim-quote carve-out doesn't happen to co-occur with
  the summary's own wording — not consistently in one direction per stratum at n=12.

## 7. Two-line change still needed in `eval/scripts/transplant.mjs`

**Not made — that file is the other agent's** (`context-tree-wt-item2`). Line numbers below
are against *this worktree's* `transplant.mjs` at `b8d395d` (`HEAD`), which has exactly one
`new TreeRetriever(...)` call site. `03-embeddings.md` §1 row 8 and the judge spec's Step 5
cite two sites (`:590`, `:2602`) — those numbers belong to whatever version of this file the
item2 worktree is producing (it's actively adding a `--phase gates` g15 self-retrieval check,
which needs its own retriever instance, plus the Step-1 instrumentation shifts every
following line). **Re-locate `new TreeRetriever(` in whatever `transplant.mjs` lands before
applying this** — it is a `grep`, not a line-number bet.

1. **Import** (`transplant.mjs:51-73` in this worktree — the existing multi-line import
   from `@context-tree/core`): add `createEmbeddingClientFromKeys` and `loadApiKeys` to the
   list (alphabetically, next to `loadConfig`/`loadDotEnv`).
2. **Construction** (`transplant.mjs:1989` in this worktree):
   ```diff
   - const retriever = new TreeRetriever({ store: scenario.store, blobs: scenario.blobs, trace: scenario.trace });
   + const embed = arms.includes('tree-semantic')
   +   ? createEmbeddingClientFromKeys({ keys: loadApiKeys() })
   +   : undefined;
   + const retriever = new TreeRetriever({ store: scenario.store, blobs: scenario.blobs, trace: scenario.trace, embed });
   ```
   Gated on `arms.includes('tree-semantic')` (or equivalent) rather than unconditional, so
   every other arm's `TreeRetriever` is byte-for-byte the same construction it is today —
   required by G8's same-epoch rule (`JUDGE-VERDICT.md:118`): adding an embedder must not
   change substrate for arms that never asked for one. `loadDotEnv` is already called
   elsewhere in this file before any provider is constructed, so `loadApiKeys()` here reads
   an already-populated `process.env`.

If the landed version does carry two call sites, both need the same two-line treatment;
neither needs anything else, since `TreeRetriever`'s constructor and `search()` dispatch
already handle `embed: undefined` as "use the beam" with no other code path change
(`retriever.ts:82-84`).

## 8. Config keys, for reference

```jsonc
// context-tree.config.json
{
  "embedModel": "text-embedding-3-small"   // was "voyage-3-lite"; embedDim removed
}
```
```
OPENAI_API_KEY       // new — reads via ApiKeys.openai / API_KEY_ENV_NAMES.openai
OPENAI_KEY           // alias, same precedence pattern as the other three providers
```
`OPENROUTER_API_KEY` was already wired (chat completions); `createEmbeddingClientFromKeys`
reuses it for embeddings when `baseURL === OPENROUTER_BASE_URL` — no new env var needed for
the OpenRouter path.
