# Dimension 4 — how caching is handled

DS-STAR pass, dimension 4 of the four named in `reports/algorithm.md`'s "What
the DS-STAR loop is for" (visible branch count, branch depth, summary timing,
caching). Zero live model calls; every number below is either read from
committed source, computed offline from a committed test/fixture, or quoted
from an already-published measurement in `reports/metrics/`. Tokens, turns and
graded score are primary; a dollar figure appears only beside the baseline it
is relative to, at `claude-sonnet-5`'s published per-token rates
(`packages/core/src/models/cost.ts:60`: input $2.00, output $10.00, cache-read
$0.20, cache-write $2.50, all per 1M tokens — cache-read is 0.1× input and
cache-write is 1.25×, `cost.ts:47-49`).

**Terms**, defined once here since the rest of the repo assumes them. A
**breakpoint** is a `cache_control` marker a request places after some content;
a provider's cache stores the byte-prefix up to a breakpoint and, on a later
request, returns the longest previously-cached prefix that still matches
byte-for-byte, charging the matched part at the cache-**read** rate and any new
content up to the next breakpoint at the cache-**write** rate; content after
the last breakpoint is **fresh** input, billed at the plain input rate. A
**prefix invalidation** is any edit that stops a later request's bytes from
matching an earlier cached prefix at or before some breakpoint — it does not
delete the cache, it just stops the read from reaching that far.

## (a) Breakpoints: available, used, wasted

Anthropic's Messages API honors at most **4** `cache_control` breakpoints per
request. This is not inferred — it is asserted three separate places in this
repository: `ANTHROPIC_PROFILE.maxBreakpoints = 4` with a comment naming it
explicitly (`packages/core/src/cache/simulator.ts:68-76`), a code comment on
the native arm's own cache logic ("mutating history would accumulate markers
past the provider's 4-breakpoint limit", `eval/src/loop.ts:352-353`), and a
test titled exactly for it (`eval/test/loop.test.ts:252-258`, below).

Two different request builders exist in this repository, and they use a
different number of the 4 available breakpoints:

| Builder | Where | Breakpoints emitted | Zone C caching |
|---|---|---|---|
| `toCompletionRequest` | `packages/core/src/assemble/assembler.ts:410-430` (§10 rule 5, `IMPLEMENTATION_PLAN.md:419-421`) | **2** — Zone A/B (`systemCacheBreakpoint`) and Zone B/C (last Zone B block) | None. Zone C ships as one message (`toMessages`, `assembler.ts:374-387`); with no marker on it, none of its content is ever read from cache on a later turn — it is fresh input every single turn, by construction. |
| `toZoneCCachedRequest` | `eval/src/loop.ts:638-678`, gated by `EVAL_ZONEC_CACHE=1` | **3** — system, Zone B's end, and the last non-`C:map` Zone C block | Zone C ships as one message per block with a moving breakpoint on the last cacheable one; the `C:map` block and the tail ride after it, uncached, because both churn every turn (comment at `loop.ts:653-657`; confirmed by a test that counts exactly 3 markers, `eval/test/loop.test.ts:252-258`). |

**The shipped library wastes 2 of 4.** `toCompletionRequest` is what
`@context-tree/core` actually exports and what `IMPLEMENTATION_PLAN.md` §10
rule 5 documents ("Emit cache-control breakpoints at the Zone A/B and B/C
boundaries" — no third rule, no fourth). The 3-breakpoint builder that reaches
native-equivalent economics within a phase (measured: fresh input fell from
2.4–7.6k to 36–892 tokens/turn once it landed, `reports/metrics/tree-vs-transcript.md:46`)
lives only in `eval/src/loop.ts`, gated behind an env flag with no default,
and has never been lifted into `packages/core`. This is the same shape of
defect the portability audit already names for the D19 budget derivations
(`eval/plans/portability-audit/03-transplant.md:329-334`: "sound but landlocked
in an eval script") — here it costs a specific, already-measured saving rather
than a hypothetical one. Compounding it: `ZoneAssembler` (the only thing that
can emit even the 2-breakpoint version) is never constructed inside
`packages/mcp` at all (`eval/plans/portability-audit/01-core.md:60`), so a host
running `@context-tree/mcp` today gets **zero** breakpoints from the shipped
server, not two.

**The 4th is not simply "wasted" — nothing left is stable enough to mark.**
With `EVAL_FETCH_EVENTS=1` on (one of the seven flags `reports/algorithm.md`
calls the shipped algorithm), context-tool results and the completion nudge
become ordinary L0 events inside Zone C rather than a separate ephemeral tail
(`eval/src/loop.ts:1117` area), so what is left after the 3rd breakpoint is
just the descendant map (`C:map`), which the code's own comment says must stay
uncached because "it grows with every edit" and marking it would rewrite the
whole zone at the 1.25× write rate for content that changes again next turn
(`loop.ts:653-657`; this is exactly the FM-7 mechanism below). So the accurate
statement is: **2 of 4 wasted in the shipped path (landlocked-in-eval defect,
fixable by porting `toZoneCCachedRequest`), 1 of 4 legitimately unused in the
best path that exists today (nothing left to cache).**

OpenRouter never reports a cache-write count at all —
`fromOpenRouterResponse` hard-codes `cacheWrite: 0`
(`packages/core/src/models/openrouter.ts:208`), with the honesty rationale
recorded in the file's own header comment: "there is no upstream cache-write
counter... an unknown reported as zero is honest; a fabricated number is not"
(`openrouter.ts:9-10`). `cost.ts:63-67` repeats the caveat for the price table.
**Every dollar figure and every "prefix rewritten N times" claim below is
therefore Anthropic-specific** — none of it can be checked, and none of the
mechanisms below can even be observed, on the OpenRouter-routed rows in this
repository's own fixtures (`qwen/qwen-2.5-72b-instruct`, `openai/gpt-3.5-turbo`,
etc., per `eval/fixtures/transplant/`). `eval/scripts/transplant.mjs` confirms
this independently: it contains zero references to `cache_control`,
`cacheBreakpoint`, or a cache-write field anywhere (grep, this pass) — the
cross-model transplant harness does not model provider caching at all, so its
token comparisons are cache-agnostic by construction, not by finding caching
irrelevant.

## (b) Events that invalidate the prefix, ranked by measured cost

Six distinct invalidating mechanisms are on record, four already fixed and
two still open. Ranked by the actual dollar or token delta measured for each,
not by a guess at severity:

| Rank | Mechanism | Measured cost | Status |
|---|---|---|---|
| 1 | **Unlatched switch point** — after the real-token lazy gate crossed, the trace fell back under budget the very next turn (Zone C now held only the active branch), so the tree re-expanded to whole-trace mode and crossed again, oscillating | One observed replicate: run finished at 223,917 tokens / $0.42, "about twice the loop-8 tree cost on sw-5-dozen" (`eval/plans/loop9-item1-lazy-gate.md:79-87`) | **Fixed** same day — the crossing latches one-way (`lazyCrossed`) |
| 2 | **Devolved-mode truncation-cap churn** — below the (mis-measured, chars/4) lazy threshold the trace still hit the 30k Zone C cap; each new tool result shifted the shared water-fill cap by a token or two, which rewrote every already-truncated block at once | Cache-write 161,938 → 33,000 tokens on sw-6-ripple (a ~33k-token prefix rewritten ≈4.9×); run cost $0.52 → $0.22 (`reports/metrics/tree-vs-transcript.md:80`, `:11`) | **Fixed** (loop 8): budget removed in devolved mode |
| 3 | **Zone B volatile seq-range headings (FM-2)** — branch headings embedded `(seq X–Y)`, so the newest branch's own heading mutated every turn, which meant Zone B's cache breakpoint was never actually reached | Cache-write 54k → 6.3k tokens/run (`reports/metrics/tree-vs-transcript.md:40,321,375`); read pinned flat at 4,788 for 19 straight turns before the fix | **Fixed** (v5.1, iter6) |
| 4 | **Descendant-map churn ahead of the Zone C breakpoint (FM-7)** — the map block sat *before* the moving breakpoint and grows on every file edit, so one changed block ahead of the marker rewrote the whole zone at 1.25× | cacheRead pinned at 6,568 while cacheWrite climbed 10.8k → 16.3k tokens/turn across edit turns (`tree-vs-transcript.md:349-355`) | **Fixed** (v5.6): map relocated behind the breakpoint |
| 5 | **Mid-branch/root summary rewrite (D3/D4 cascade)** — a new summary version replaces a Zone B block in place; everything from that block to the end of Zone B stops matching the previous cached prefix | Structural, not yet billed live: `packages/core/test/cache.test.ts:325-374` proves the cascade invalidates from the rewritten block through the rest of Zone B (and, once it reaches the root, the *entire* Zone B) even though only one block's *text* changed | Documented cost of D3 (never overwrite summaries); not a bug, no live $ measured |
| 6 | **sw-3-refactor's still-open re-read tax** — more turns on the tree arm than native, each turn re-billing the (larger, because Zone A carries 8 tool schemas) stable prefix as a fresh cache read | See §(c) below — token-large, dollar-tiny | **Open**, see §(c) |

Ranks 1–4 are the expensive class: each is a **rewrite** event, billed at the
1.25× rate, and each was worth tens of cents to single-digit dollars per run
once diagnosed. Rank 5 is real but unquantified live. Rank 6 is, as the next
section shows, the cheapest of the six in dollars despite being the largest in
raw tokens — which is the headline finding of this pass.

One structural point the ranking doesn't show on its own: **every fixed
mechanism (1–4) is a write bug; the one open mechanism (6) is a read-volume
problem.** The two are not the same kind of cost and do not respond to the
same fix — narrowing the fix search for item 6 to "read less" (fewer
branches, a shorter contract) rather than "write less" (nothing here is being
wastefully rewritten) is itself a testable implication of this table, not
asserted independently of it.

## (c) A cached prefix re-read every turn vs. a smaller one partly rewritten — computed, not reasoned about

The two published rates settle this without a model: cache-write costs
**12.5×** cache-read, per token, on Anthropic (`$2.50 / $0.20`,
`cost.ts:60,47-49`). That ratio, not prefix size, is what decides the
question, and the sw-6-ripple bug (rank 2 above) is a real, measured instance
of exactly this trade firing the wrong way:

- **Before the fix**: the same ≈33,000-token prefix was rewritten roughly
  4.9 times over the run (161,938 ÷ 33,000). Cache-write bill alone:
  161,938 × $2.50 / 1e6 ≈ **$0.405** — already most of the reported $0.52 total.
- **After the fix**: that prefix is written once and read on every subsequent
  turn. Cache-write bill alone: 33,000 × $2.50 / 1e6 ≈ **$0.0825**, with the
  remaining turns' reads landing in the residual ≈$0.14 of the reported $0.22
  total (Zone A reads, fresh input, output — shared between both
  configurations, not recomputed here).

Same work, same model, same trace — **2.4× the dollar cost** ($0.52 vs $0.22)
purely from choosing to rewrite instead of read. Generalizing from the rate
ratio alone (this generalization is *derived*, not separately measured): a
stable prefix that is read every turn breaks even against a same-content
prefix that is rewritten every turn only once the rewrite frequency drops
below roughly 1-in-12.5 turns; for the sw-6-ripple case it was rewritten on
essentially every turn (worse than 1-in-1), which is why the fix was an
unambiguous win rather than a close call. Framed the other way, per the
question as posed: **a re-read prefix up to ~12.5× larger than a
constantly-rewritten smaller one still costs the same per turn** — size is not
the lever; rewrite frequency is.

**The remaining open gap (sw-3-refactor) is the read side of this trade, and
it is cheap precisely because it is reads, not writes.** Two decompositions of
this gap exist in this repository and they disagree because they were
measured on different days — stated plainly per the lesson
`eval/plans/loop9-item3-sw3-overhead.md` closes on ("no cross-epoch comparison
enters a headline again"):

- **Cross-day estimate** (tree pooled from `v60-diverse`+`v61-diverse` n=6 vs.
  native from `v57-diverse` n=3, different days —
  `loop9-item3-sw3-overhead.md:9-27`): mean gap 98,006 tokens, **93.5% cache
  reads** (69.5% "re-read tax from extra turns" + 24.0% Zone A carrying 1,957
  tok/turn against native's 375), 6.5% a mixed cacheWrite/input/output bucket.
- **Same-day, corrected verdict** (n=5 per arm, one day,
  `loop9-item3-sw3-overhead.md:245-278`): the gap shrank to 1.71× native (not
  the published 3.4×), a 28,594-token median residual, attributed to two
  measurable-offline mechanisms: Zone A carrying ≈1,582 more tokens/turn than
  native (≈14k over nine turns) and the completion-gate turn re-reading the
  whole prefix once (≈13k) — again, both cache **reads**, not writes.

Pricing either decomposition at the published cache-read rate makes the point
concrete: even the larger, cross-day estimate's 93.5%-cache-read share
(≈91,636 of 98,006 tokens) costs **≈$0.018** at $0.20/M; the corrected,
same-day 27k-token residual costs **≈$0.005**. Compare that to rank 2 above,
where a *write*-side bug of comparable token magnitude (162k tokens) cost
**$0.405** — roughly 20–80× more per token moved, because it was billed at
1.25× instead of 0.1×. **The dimension's single biggest published token gap
(98,006 tokens/run, sw-3) is one of its cheapest in dollars; its
already-fixed write bugs (161,938, 54k, and the FM-7 pair) were each worth
more money while moving comparable or fewer tokens.** This is a measured
consequence of the 12.5× rate asymmetry, not an argument that sw-3's gap
doesn't matter — turns and tokens are still primary metrics per the algorithm
rules, and 1.71× native on tokens is still the open failing criterion
(bar was ≤1.5×, `loop9-item3-sw3-overhead.md:29-31`) — only that a fix aimed at
sw-3's dollar cost would be solving the wrong problem, while a fix aimed at
its turn count (still open, batching-density refuted at this n) is solving
the one that is actually expensive in both tokens and turns.

## (d) The zero-token test that would catch a prefix regression — and whether §17's harness exists

**It exists, in `packages/core`, committed** (`git log`: commit `5b67397`,
"Add the MCP server, the CLI, and the D5 cache assertion harness (M5, M7)") —
`packages/core/src/cache/{index.ts,prefix.ts,simulator.ts}` (612 lines) plus
`packages/core/test/cache.test.ts` (575 lines, ~19 `it` blocks). It matches
`IMPLEMENTATION_PLAN.md` §17's description exactly: "deterministic tokenizer +
provider cache simulator asserting exactly which prefix ranges survive each
event type" (§17 bullet, `docs/IMPLEMENTATION_PLAN.md:593-595`, quoted
verbatim in the simulator's own header comment,
`packages/core/src/cache/simulator.ts:1-3`). It runs offline — no network, no
model call, local tokenizers only (`ExactTokenizer`/`HeuristicTokenizer`) —
and models the real Anthropic constraints precisely: `ANTHROPIC_PROFILE` sets
`maxBreakpoints: 4` and `minCacheableTokens: 1024` (`simulator.ts:72-76`), and
a dedicated test proves prompts below that floor cache nothing even though the
layout is fine (`cache.test.ts:488-508`).

**The specific zero-token test that would catch a dropped-breakpoint
regression** — the exact failure mode `assembler.ts`'s own doc comment warns
about ("a caller that built a request from `toMessages` alone dropped the Zone
A marker silently... pays full price for the frozen prefix on every turn",
`assembler.ts:405-408`) — is
`cache.test.ts:441-461`, `'reports a dropped §10 rule 5 breakpoint as total
loss of cache reads even though every block is byte-identical'`: it takes an
assembled prompt, strips every `cacheBreakpointAfter` flag and the
`cacheBreakpoints` list while leaving every block byte-identical, and asserts
`survivingSegments` goes from whatever it was to `[]` and `cacheRead` to `0`.
A second test in the same file (`cache.test.ts:184-207`) is the positive
control: a byte-identical re-assemble is read from cache, `cacheRead > 0`, and
the running total of read+write+fresh always equals the whole prompt's tokens
(the conservation check that would catch a simulator bug hiding a real one).

**But the harness has a coverage gap that matters for exactly the code this
report is about.** `packages/core/test/cache.test.ts` only ever submits
prompts built by `ZoneAssembler`/`toCompletionRequest` — the 2-breakpoint,
Zone-C-always-fresh path from §(a). `eval/src/loop.ts`'s `toZoneCCachedRequest`
— the 3-breakpoint builder that every measurement cited in §(b) and §(c) above
actually ran through — is **never** passed to `ProviderCacheSimulator`,
`assertPrefixStable`, or `CacheAssertionError` anywhere in the repository
(grep across `eval/src`, `eval/test`, `eval/scripts`: zero hits, this pass).
Its own tests (`eval/test/loop.test.ts:217-276`) check structural properties
by hand — which messages carry `cacheBreakpoint === true`, that the count is
exactly 3, that earlier messages stay byte-identical after an append — which
is real coverage of the same properties, but it is a second, independently
written, less rigorous instrument checking the one request builder that
matters for every live number in this repository, rather than the one that
§17 built and that this repository already trusts enough to call "where D5
regressions will surface and essentially nowhere else"
(`assembler.ts:407-408`, echoed in `simulator.ts:1-3`). Concretely: a future
edit to `toZoneCCachedRequest` that reintroduces the FM-7 map-churn bug (rank
4 in §(b)) inside its own file would need to be caught by hand-rolled
message-content assertions in `eval/test/loop.test.ts`; the general-purpose
harness built to catch exactly that class of regression would not see it,
because nothing routes eval's request builder through it.

## What is measured vs. hypothesis

**Measured** (either a number already published in `reports/metrics/`, or
computed in this pass from committed rates against a committed number): every
figure in §(b)'s table; the two dollar totals and their ratio in §(c)'s
sw-6-ripple example; the corrected vs. cross-day sw-3 decomposition and both
of its dollar translations; the breakpoint counts in §(a); the §17 harness's
existence, location, and the specific test that catches a dropped breakpoint;
the eval-harness coverage gap (a grep result, not an inference).

**Hypothesis** (stated as such, not folded into a headline): the general
12.5×-implies-breakeven-at-~1-in-12.5-turns rule in §(c) is a derivation from
the two published rate constants, not a swept result — no experiment in this
repository varies rewrite frequency independently of prefix size to confirm
it holds under real provider latency/TTL behavior (the simulator itself is
built conservatively single-entry, per its own comment,
`simulator.ts:20-24`: "under-crediting cache reads cannot hide a D5
regression; over-crediting could" — real multi-entry provider caches could in
principle do somewhat better than this harness's numbers, never worse). The
claim that sw-3's turn-count mechanism (not caching) is the correct target for
further work is this pass's synthesis of §(b)/(c)'s numbers, not a new
experiment; `loop9-item3-sw3-overhead.md` itself already reached the same
conclusion by a different route (batching-density refuted, gap decomposes
offline into Zone A + one completion-gate re-read).

## Answering rule 3 for anything this pass would otherwise propose as a number

Rule 3 (`reports/algorithm.md`): "setting a parameter from a model's limits is
fine, guessing it is not." This pass surfaces one candidate parameter —
*how many of the provider's cache breakpoints the assembler should use* — and
the honest answer is that it is not a tunable at all: it is `min(available
stable zone boundaries, provider's maxBreakpoints)`, already a fully
host-derived quantity once `toZoneCCachedRequest`'s logic (3 boundaries: Zone
A/B, Zone B/C, and the last block before whatever in Zone C still churns) is
generalized and read from a provider capability rather than hand-written per
harness. No new hardcoded value is proposed here; the fix implied by §(a) is
porting existing, already-measured logic into `packages/core`, not choosing a
number.

## Sources

`packages/core/src/assemble/assembler.ts`, `packages/core/src/models/{anthropic,openrouter}.ts`,
`packages/core/src/models/cost.ts`, `packages/core/src/cache/{index,prefix,simulator}.ts`,
`packages/core/test/cache.test.ts`, `eval/src/loop.ts`, `eval/test/loop.test.ts`,
`eval/scripts/transplant.mjs` (grepped, not modified), `docs/IMPLEMENTATION_PLAN.md` §10/§17,
`reports/algorithm.md`, `eval/plans/portability-audit/{01-core,03-transplant}.md`,
`reports/metrics/tree-vs-transcript.md`, `reports/metrics/context-tree-long-task-dsa-iterations.md`,
`eval/plans/loop9-item1-lazy-gate.md`, `eval/plans/loop9-item3-sw3-overhead.md`.
