# Retrieval is bounded by the size of the indexed unit, not by ranking

Context-tree retrieval · DS-STAR multi-index pass · September 3, 2026

Context-tree reorganizes an agent's linear conversation trace into a summary-headed tree, so a long-running session sees branch summaries instead of raw history and pulls detail back on demand through retrieval tools. A prior pass had improved search ranking from 2 of 12 to 10 of 12 questions with the correct branch in the top three, yet live scores did not move; this pass asked why. Three findings, each measured. First, the tree had never been tested in the regime it exists for: the question set's "head" stratum was cut against the smallest window's truncation boundary, which does not place answers outside a wider window's raw tail. A rebuilt set puts every answer provably out of reach. Second, an oracle probe that hands the model the correct branch on the first call recovers most but not all of the gap, and how much depends entirely on which question set it is measured against: on the set where a real-search baseline also exists, the oracle recovers 19 of the 21 points that baseline loses, leaving about 8% of the loss after retrieval; on a harder set built later it reaches only 13 of 25 against a ground truth of 25 of 25, but no real-search baseline was ever run there, so that gap cannot be split between ranking and extraction. Third, the post-retrieval residual is payload density: a phase replay is 26 KB with the answer on one of its 384 lines, while a command-facet entry averages 24 tokens, so a mediocre rank over cheap entries costs a few hundred tokens where a perfect rank over expensive ones still buries the answer. Multiple indexes raise coverage from 5–6 of 17 questions to 9, but only when a query is routed to one index; fusing indexes by relevance drops it to 6. The main limitation is that all of it rests on one 754-event session and 17 questions, and that six of those questions cannot be served by any single-entry index at all.

## 1 Terms

**L0** is the append-only event log; **L2** the content-addressed payload store; **L1** the tree of nodes that point into L0 by sequence range. **W** is the model's context window. **truncate-tail** is the baseline arm: the most recent raw events that fit W, no tools, answered in one turn. **naive-full** sends the entire trace as raw context and is the ground truth, requiring W at least as large as the trace. **tree-tail-v2** is the full tree arm — keyword-fingerprint headlines in Zone B, hybrid fingerprint-plus-grep search, an optional query rewriter, relevance-centred fetch narrowing, and a system contract instructing the model to search rather than give up. **tree-oracle**, built this pass, is byte-identical to tree-tail-v2 except in its search handler, which returns the question's own source branch and **nothing else** — a one-hit result. That removes three things at once, not one: the ranking error, all nineteen distractors, and the twenty-hit search payload (`config.retrieval.limit` is 20). It is therefore a ceiling probe and never a scored arm, and it is not the one-variable ablation the other arms are; a cleaner version would return the correct branch ranked first *within a full-size hit list*. The **overflow regime** is the condition the tree exists for — the trace exceeds W and the answer lies outside the raw tail. The **frozen store** is a real Claude Code session on this repository: 754 events, approximately 196,000 tokens, 21 phase branches, 24 file branches, one task root.

A **facet index** is a second axis over the same L0: events grouped by an exact key they already carry (tool name, file path, extracted symbol, output line), where each entry is one line rather than one replay.

## 2 The question set did not test the overflow regime

The prior pass's `head` stratum was cut by walking L0 newest-first and charging tokens until the smallest tested window's keep budget was spent (`truncationBoundarySeq`, `transplant.mjs:1114`). The boundary that produces is the *largest* of the boundaries, because a smaller budget reaches less far back. Facts before it are outside the smallest window's tail — and that is the weakest guarantee available, not the strongest: a wider window reaches further back, so a `head` fact can sit comfortably inside the tail at the window actually under test.

Measured on the frozen store, the boundary moves with W:

| W | truncate-tail keep budget K | tail reaches back to seq | head questions still hidden |
|---|---|---|---|
| 32,768 | 30,808 | 702 | — |
| 65,536 | 61,616 | 523 | — |
| 98,304 | 92,424 | 376 | — |
| 131,072 | 123,232 | 268 | — |
| 200,000 | 188,037 | 108 | — |

The original `head` questions sit at seq 175, 558 and 18. At W=65,536 the tail reaches seq 523, so the seq-558 question was inside the baseline's view throughout the prior pass — which is why `truncate-tail` answered it 5 times out of 5 while the tree arm lost it.

A new phase, `--phase prep-overflow`, cuts a separate stratum against the widest tested window instead. Because the boundary is non-increasing in W, a fact below it is below every narrower window's boundary too. It reuses the existing literal extraction, deterministic selection, leakage gate and self-retrieval gate, and writes its own file rather than touching the frozen `questions.json` / `manifest.json` pair. Two sets were produced: `questions-overflow.json` (cut at W=65,536, answers at seq 151–507) and `questions-deep.json` (cut at W=131,072, answers at seq 18–264).

The control confirms the cut. At W=131,072 — the widest window in the sweep — `truncate-tail` scores **0 of 25** on the deep set: 21 scored zeros and 4 rows that returned no text at all (`status: turn_cap`, empty `finalText`, 273–1,568 output tokens spent on hidden reasoning), which are `null` and not counted as answers. Nothing in the baseline's 123,232-token view answers any of those five questions. The four empty completions are the same failure mode §10 records for the paraphrase path, appearing here on a wide window rather than a narrow one — `maxReplyTokens` was 6,553, so it is not simply a tight reply budget.

## 3 How much loss survives perfect retrieval, and why the answer depends on the set

Every cell below is GLM 5.3 Flash, five replicates per question, same frozen store, same epoch. Ground truth is `naive-full` at W=200,000.

| Arm | overflow set (5 questions) | deep set (5 questions) |
|---|---|---|
| naive-full W=200,000 | 23/25 (92%) | **25/25 (100%)** |
| truncate-tail W=32,768 | 0/25 | — |
| truncate-tail W=65,536 | 4/25 — all four artifacts, see §6 | — |
| truncate-tail W=131,072 | — | **0/25** |
| tree-tail-v2 W=32,768 | 1/25 | — |
| tree-tail-v2 W=65,536 | 2/25 | — |
| tree-escalate W=32,768 | 2/25 | — |
| tree-escalate W=65,536 | 4/25 | — |
| **tree-oracle W=65,536** | **21/25 (84%)** | **13/25 (52%)** |
| tree-oracle W=98,304 | 23/25 (92%) | 15/25 (60%) |
| tree-oracle W=131,072 | 22/25 (88%) | 10/25 (40%) |

**A decomposition is only valid within one question set.** The two sets differ in
difficulty and in kind mix, and `tree-tail-v2` was never run on the deep set — no such
result file exists. An earlier draft of this report split the loss using 2/25 from the
overflow set against 13/25 from the deep set and concluded that "roughly half" the loss
survives perfect ranking. That is wrong, and the correction reverses its emphasis.

**Within the overflow set at W=65,536**, where all three arms exist at the same epoch:

| | score | share of the gap |
|---|---|---|
| naive-full (ground truth) | 23/25 | — |
| tree-tail-v2 (real search) | 2/25 | loses 21 points |
| tree-oracle (perfect ranking) | 21/25 | **recovers 19 of those 21 — 90%** |

So on the only set that can answer the question, **ranking-to-selection is the dominant
bucket by an order of magnitude**: 19 of 21 points. Post-retrieval extraction accounts for
the residual 2/25, about 8%.

**Within the deep set**, only two of the three arms exist:

| | score |
|---|---|
| naive-full (ground truth) | 25/25 |
| tree-oracle (perfect ranking) | 13/25 |
| tree-tail-v2 (real search) | **never run** |

Perfect ranking reaches 52% against a perfect ground truth, so 12 of 25 points are lost
*after* retrieval on this harder set — a much larger post-retrieval loss than the overflow
set shows. But without a real-search cell there is no way to know what fraction of the
total gap that represents, and the two sets share only one of five questions, so the
overflow figures cannot be borrowed. **Running `tree-tail-v2` on the deep set is one
25-run cell and is the cheapest way to close this** (item 12.1a).

What is safe to say from both sets together: perfect ranking is worth a great deal (2/25 →
21/25 where measured), and a post-retrieval loss exists and grows with question depth
(2/25 of the gap on the overflow set, 12/25 of ground truth on the deep set). What is not
safe is a single number for how the loss splits.

One further cross-set hazard in the same sentence an earlier draft wrote: the "10 of 12
top-3 offline" figure is measured on the original 12 questions, and `rank-killgate.mjs`
hardcodes that file, so **the ranker's top-3 rate on the overflow and deep sets has never
been measured at all.** Comparing it to a live score on five different questions is not a
comparison. Parameterizing that script costs zero tokens and would say whether bucket 1 is
"the model cannot exploit a good ranker" or "the ranker is bad on these questions" — see
item 12.1b.

Median turns separate the two behaviours cleanly. Successful oracle runs take **3** turns —
search, fetch, answer. Real-search runs take **5**, cycling through reformulated queries.
On the **overflow** set at W=131,072 the oracle median falls to **1** and only 5 of 25 runs
search at all, because those answers are inside the visible tail and the model stops
calling tools; on the **deep** set at the same window the median stays at **3** with 20 of
25 searching, as it should, since every deep answer is below that window's boundary. The
collapse to one turn is a fixture-decay signal, not a model behaviour.

## 4 The window sweep, and why its first reading was wrong

On the overflow set the oracle arm appeared to reach parity at W=98,304: 23 of 25, matching ground truth exactly, and matching it question-for-question — four questions at 5/5 and the same single question that full context also fails. Truncation collapsed at that window, from 17,142 tokens cut at W=65,536 to 753.

That reading does not survive the boundary table. At W=98,304 the tail reaches seq 376, so only two of the five answers remain outside it; at W=131,072 only one does, and median turns falls to 1. The apparent climb from 84% to 92% is mostly the questions falling into the raw tail, not retrieval improving. Scored on the subset still provably unreachable, the oracle arm is 21/25 (84%) at W=65,536 and 8/10 (80%) at W=98,304 — flat.

One result in the sweep resists this explanation and should be recorded rather than
smoothed: on the deep set the oracle arm scores 15/25 at W=98,304 but **10/25 at
W=131,072** — a wider window scoring worse, with no tail-visibility available as a cause,
since every deep answer sits below even the W=131,072 boundary. Candidate explanations are
run-to-run variance at n=5 per question, and the wider window admitting more Zone B
summaries that dilute rather than help. It is unexplained, and it weakens the claim that
the deep set is a strictly cleaner instrument.

This is the pass's methodological lesson about its own instrument: **an overflow question set is only valid up to the window it was cut against.** A parity claim at window X requires a set cut at X or wider. `questions-deep.json` exists for that reason, and on it the oracle arm does not reach parity at any window tested: 52% at 65,536, 60% at 98,304, 40% at 131,072 against 100% ground truth.

## 5 Fixing the double truncation: correct offline, inert live

Two defects were found in the narrowing path and both were real.

The band was sized from `fullRendered.text.length * 0.85` (`retriever.ts:311`) — a heuristic-to-BPE *token* ratio applied to *characters*. The heuristic tokenizer charges roughly one token per four characters (`tokens/index.ts:69`), so this overstated the branch by about 3.4× and, through an average-tokens-per-event divisor, made every band roughly 3.4× narrower than the budget allowed. Nothing then verified that the result fit.

The budget itself was `ctx._headroom / 2` (`transplant.mjs:1431`) — a build-time constant, halved as a hedge against conversation growth. When it over-allocated, the harness's own append cap (`capToolResult`) trimmed the result a second time, keeping the front and discarding the rest (`format.ts:225-229`), with no knowledge of where the answer sat. A band centred on the answer could therefore lose the answer.

Both were replaced. The retriever now takes an injected tokenizer and grows the band outward from the relevance centre, measuring as it goes, until the next event would not fit; the harness computes the real remaining headroom per tool call (`appendHeadroom`, extracted from `capToolResult`) and the fetch narrows to exactly that. A new gate, `eval/scripts/narrowing-killgate.mjs`, measures the two properties that matter across 5 questions × 4 budgets:

| | before | after |
|---|---|---|
| band fits its budget | 19/20 | **20/20** |
| band still contains the answer | 17/20 | **19/20** |

Delivered content widened substantially where it had been starved: question qo03 at a 4,000-token budget went from 796 to 3,934 tokens (4.9×), qo01 at 16,000 from 8,915 to 15,919 (1.8×).

**The pre/post labelling is not evidenced by the artifacts.** Both batches ran against
uncommitted working-tree state — the relevant files were last committed at 19:37, after
both — and no field in the result files discriminates the two: `budgets` and per-turn
`zoneBudgets` are byte-identical across the pair. The labelling rests on run order and the
author's record, not on evidence, and a future reader cannot re-derive it. The fix for next
time is to persist a code fingerprint (a git SHA, or a hash of `retriever.ts` plus
`transplant.mjs`) in each result file's header.

**Worse for the fix's own story, the delivered payloads did not widen live.** The per-turn
input-token deltas — which is where a wider band would show — are flat across the pair:
p90 of 8,053 tokens before against 8,116 after at W=65,536, and 5,351 against 5,386 at
W=32,768, both within 1%. The offline gate measured band width at synthetic budgets of
2,000 to 16,000 tokens; the live per-call headroom at these windows rarely reaches that
range, so the gate passed on an axis the live path does not occupy. "Delivered content
widened substantially" is true of the gate and **not** of the live runs.

**The live score did not move.** At W=32,768, 1/25 before and 1/25 after. At W=65,536, 0/25 before (with seven stalls) and 2/25 after. Worse for the fix's own story, live truncation at W=32,768 barely changed: 50,557 tokens cut before, 49,410 after. At that window the assembled prompt already consumes roughly 31,000 of 32,768 tokens, so the genuine remaining headroom is small no matter how correctly it is computed, and search results are capped alongside fetches. The heuristic-to-BPE conversion in the new path also divides by the measured ratio (0.851), inflating the band budget about 17%; on code-dense branches the real BPE count exceeds `heuristic × 0.851` and the append cap still fires. That refinement is identified and unshipped. A second defect also survives: the fetch
handler still falls back to `Math.floor((ctx._headroom ?? 20000) / 2)` when the live value
is absent, so the halved build-time constant and its 20,000 default are still in the code
path. Under rule 2 of `reports/algorithm.md` that fallback is a defect, and "both were
replaced" overstates what shipped — the primary path was replaced; the fallback was not.

The honest verdict: the fix is correct, removes a magic number, and wins decisively on its own bucket offline, while changing nothing the user would notice, because a different bucket binds.

## 6 The grading instrument is gameable, and it fabricated

Every non-zero score in the first overflow batch — five of them — is an artifact. This was found by checking answers against source content rather than trusting the grader.

Three (question qo03, `truncate-tail`, W=65,536) are **incidental mentions inside a correct refusal**. The model said the session record does not contain the measurement, then suggested a follow-up command using the conventional source-to-dist path mapping — which happened to be the answer string, `packages/core/dist/assemble/format.js`. Exact-match grading cannot distinguish a recalled fact from a declined answer that names the string in passing.

Two are **fabrications**. For question qo06 under `truncate-tail` at W=65,536, the model produced a verbatim-looking transcript quoting `tool_call` and `tool_result` blocks at **seq 755, 756 and 757**. The trace has 754 events. The regex and function signature it "quoted" do not match the real source at seq 507 (real: `function extractJsonObject(raw: string): unknown`; fabricated: `[Record<string, unknown>, string] | null`). Under `tree-tail-v2` at W=32,768 the same question scored by fetching a real branch, `n_1C6D33C0FMZ129RA2R0GXXCRM6`, and then describing content that branch does not contain: its 26,000 characters hold zero occurrences of `extractJsonObject`, `JSON_FENCE`, `parseSummaryReply` or `summarizer.ts`, every term the answer cited.

Two consequences. First, a raw score in this harness cannot be trusted to indicate that retrieval worked; provenance has to be checked. Second, fabrication is a *downstream symptom of absent content*, not a disposition — with the correct branch present, the oracle arm answers correctly 84% of the time on the same questions and model. Hardening the system contract against giving up, which the prior pass did, treats the symptom.

Question kind matters here. Answers that are file paths or identifiers can be reconstructed from naming convention without reading anything; quoted command descriptions cannot. `questions-deep.json` is three-fifths quoted descriptions for that reason.

## 7 Facet economics: the unit dominates the ranking

Four indexes were built from L0 alone — deterministic, no network, no embedder — and measured on all 17 questions (the 5 deep, the 12 original).

| Index | key | entries | whole index |
|---|---|---|---|
| file | `path` | 66 | 2,671 tokens |
| command | `tool` + command head | 311 | 7,525 tokens |
| symbol | extracted fingerprints | 2,316 | 24,905 tokens |
| output line | one non-blank line of tool output | 3,969 | 89,003 tokens (77,096 without the `[seq]` prefixes) |

The command index costs 7,525 tokens for every tool call in the session — under 12% of a
65,536 window, and 24 tokens per entry. Within it, the three command-shaped questions rank
5, 3 and 7 of 311, and a top-10 slice costs **272 to 440 tokens**. Served the current way
those same three questions score **5/5, 0/5 and 2/5** with the oracle handing over the
right branch (and 5/5, 0/5, 5/5 at W=98,304) — so one of the three is already answered
reliably and two are not; an earlier draft quoted only the two failures. The branch-replay
figure they are compared against, 8,000 to 16,000 tokens, is the narrowing gate's budget
rungs rather than a measured live payload for these three questions, and the live p90
delivered payload is nearer 8,000 (§5); treat the upper end as an upper bound, not a
typical value.

That is the pass's central quantitative finding, stated with its limits. Shrinking the
retrieval unit from a phase replay to a facet line saves between **7,600 and 15,600
tokens** per question depending on which replay figure you take (midpoint ~11,000);
perfecting the rank within a cheap index is worth about **200** (measured rank-to-top-10
slice deltas: 222, 294, 61). The ratio is therefore in the range 38:1 to 78:1 — call it
tens-to-one, not a precise 75:1. It explains why two rounds of ranking work produced no
live movement, and it explains the post-retrieval loss directly: on the median phase
branch (25,966 characters, 384 lines, 8,822 heuristic tokens) the answer occupies **one
line in 384 — 0.26% of the payload** — against ~100% for a facet line.

Two caveats this ratio does not carry. It is a **token-cost** ratio, not a score ratio: no
facet index has been placed in front of an answering model (§13), so the accuracy gain from
changing the unit is inferred from the oracle's post-retrieval loss, not measured. And the
saving is per question on this store, whose phase branches are large; a store segmented into
smaller phases would show a smaller gap.

Cheapness is not universal, and the table shows its condition. It requires low cardinality relative to content: `file` at 66 entries and `command` at 311 are cheap; `output line` at 3,969 entries and 77,096 tokens is as expensive as the content it indexes, and there the "return more candidates" move is unavailable and ranking binds again.

## 8 Coverage, not ranking, is the ceiling — and routing beats fusion

A line-granularity gate (`eval/scripts/line-index-killgate.mjs`) pre-registered a win criterion of the answer appearing in the top 10 for at least 10 of 17 questions, top-10 because ten lines cost about 300 tokens and are affordable in every window tested.

| Candidate over output lines | answer in top-10 |
|---|---|
| C1, plain lexical | 2/17 |
| C1′, fingerprints + exact grep + reciprocal-rank fusion | **5/17** |
| absent from the index entirely | **11/17** |

The gate fails, and the shape of the failure is the finding: C1′ places **5 of the 6 questions that are retrievable at all** in the top ten — 83% of the achievable ceiling — dragging ranks 27→3, 15→1 and 62→4. Ranking at line granularity is close to solved. Eleven of seventeen answers are simply not present as a line, and no ranker can retrieve what is not indexed. That retired the embedding candidate **without spending on it**: vector search, k-nearest-neighbour clustering, a learned ranker and an autoencoder latent space all inherit the identical 6/17 ceiling, because the ceiling is coverage.

The absences are structural, not incidental. Command descriptions live in tool-call *arguments* and never appear in output; symbols and counts live in output *lines* and not in arguments. The two sets are disjoint. Three of the seventeen — the spanning questions — require two literals from two places and cannot be one entry in any single-entry index by construction; they need a join.

That argues for several indexes, and the measurement supports it, with one sharp qualification:

| combinator across four indexes | answer in top-10 |
|---|---|
| best single index (route the query) | **9/17** |
| reciprocal-rank fusion of all four | **6/17** |
| absent from every index | 6/17 |

**Fusing indexes with disjoint coverage is worse than choosing one.** Answers already located get demoted: rank 3 → 12, rank 7 → 26, rank 4 → 16 (reproduce with `node eval/scripts/facet-killgate.mjs`, which prints them). For any given question, three of four indexes contribute noise at comparable fusion weight, and a relevance score cannot distinguish "rank 1 in the index that matters" from "rank 1 in an index with no bearing on the question." The combinator must be a router, not a ranker.

Routing is tractable because question shape predicts the index almost deterministically —
a request for a command's description goes to the command index, an identifier or count to
the line index, a path to the file index, two-literal questions to none.

A caution on the plumbing, since an earlier draft got it wrong: `context_search` does
already take a `kind` argument, but it is an **L1 node-kind filter** — `NodeKind` is
`task | phase | file | turn` (`contracts/tree.ts:11`), and the four call sites
(`retriever.ts:188, 194, 258, 511`) all discard nodes whose kind does not match. Passing
`command`, `symbol` or `line` through it filters out everything; only `file` collides by
name, and there it means "an L1 file node", not "a facet keyed on path". A routing arm
must therefore either use a distinct argument name or bypass the retriever's filter in its
own handler. What survives of the original point is narrow but real: the *tool schema*
gains one enum rather than a fifth tool, and Zone A stays at four tools.

(That last clause replaces a claim an earlier draft made — that added Zone A surface is what
consumes the tree's window. The instrumentation contradicts it: `zoneBudgets` records
`zoneA` at a fixed 2,271 tokens at both W=32,768 and W=65,536, 6.9% and 3.5% respectively,
while the peak request reaches 31,547 at the tighter window. What fills the window is the
raw tail fill plus appended tool results, not the contract and schemas.)

## 9 What was rejected, and the number that rejected it

- **Embeddings, KNN, or an autoencoder latent space over lines** — retired unspent. 11/17 answers absent from the line index caps every ranker at 6/17. An autoencoder additionally optimizes reconstruction of *typical* content while the eval grades once-only literals, the rare tail such a model discards; and grading is exact-match, which a latent reconstruction cannot satisfy.
- **Gradient-boosted or decision-tree ranking** — 17 labelled questions is not a training set, fitting it would memorize the eval, and a learned ranker makes L1 non-deterministic, so every retrain becomes a new epoch. Deferred by design (plan §14).
- **Reciprocal-rank fusion across indexes** — 6/17 against 9/17 for routing.
- **`tree-escalate` as a landed default** — 4/25 against 2/25 at W=65,536, roughly one standard error at these rates. The mechanism fires (median 2 searches at W=65,536, 3 at W=32,768) but the conversion is not distinguishable from chance at n=25. Its total truncation is also *higher* than the arm it replaces (8,044 against 2,625 tokens at W=65,536), because admitting up to 2N hits makes lists large enough to be capped.
- **Reading the W=98,304 parity result as parity** — retracted within this pass. Contaminated by tail visibility; on the unreachable subset it is 8/10 against 21/25, flat.
- **Prior-pass candidates confirmed dead**: depth options on `context_fetch` for the tree arm; extended query extraction to short quoted terms (10/12 → 9/12); full-headroom narrowing budget.

## 10 What was learned, as distinct from what was decided

- **The indexed unit dominates the ranking function — by tens to one in token cost on this
  store (38:1 to 78:1 depending on which replay figure is taken).** Every retrieval result
  in this project until now was measured on an index whose unit is two to three orders of
  magnitude larger than the answer: a 25,966-character phase replay against a 17-character
  literal, or 384 lines against one. It is a cost ratio, not a demonstrated score ratio.
- **Fusion is the wrong combinator for indexes with disjoint coverage.** It is the right one for multiple rankers over the *same* index, which is what the prior pass's hybrid grep does and why that worked offline.
- **A facet is cheap only when its key has low cardinality relative to content.** Cardinality, not cleverness, decides whether "return more candidates" is available.
- **An overflow question set decays as W grows** and is valid only up to the window it was cut against. Any parity claim needs a set cut at that window or wider.
- **Exact-match grading is gameable by fabrication.** A fluent model with no access to the answer produced a verbatim-looking transcript citing sequence numbers that do not exist in the trace. Scores in this harness require provenance checks; this applies retroactively to the prior report's numbers, which are unaudited.
- **Fabrication is caused by absent content, not by disposition.** The same model on the same questions answers correctly 84% of the time once the content is present.
- **A correct fix can be inert.** The narrowing repair wins its own bucket decisively offline and changes no live score, because a different bucket binds. Mechanism attribution before headline movement is what kept that legible instead of looking like a failure.
- **A code comment asserting an invariant is not an invariant, and this one was false.**
  `transplant.mjs:1140-1146` still reads "Stratifying on the token boundary rather than an
  event count is what makes `head` mean *provably outside the baseline's view*." That
  guarantee holds only at the K the boundary was computed for, and the whole prior pass was
  aimed by trusting it. The generalizable form: the invariant a stratifier claims must be
  re-tested at every parameter value it is used at, not read off the comment that describes
  it. **The comment is still wrong in the committed tree** and should be corrected before
  the next reader inherits the same error.
- **An instrumentation field that records a request rather than an outcome will read as a
  behavioural finding.** `fetchedDepths` logs `call.input.depth` — what the model *asked
  for* — while the served depth is forced to `full` and the `depth` key is stripped from
  the schema for every raw-fetch arm, so the field is empty or misleading by construction.
  Read literally it says "the model never requested full depth"; the truth is "the model
  was never allowed to". This misdirected the earlier diagnosis of the Haiku failures
  toward a depth problem that did not exist.
- **Two claims in this pass were made and then retracted, both from the same mistake.** The
  W=98,304 parity result (§4) was announced before checking whether the questions were still
  outside the tail at that window, and a `tree-tail-v2` success was called genuine before
  the fetched branch's content was read — it contained none of the terms the answer cited.
  Each check took under two minutes and each would have prevented the claim. The rule is not
  "attribute the mechanism eventually" but "check the cheapest confound before writing the
  sentence."
- **An offline gate must be measured over the budgets the live path actually produces.** The
  narrowing gate swept 2,000–16,000 tokens and passed 20/20; the live per-call headroom at
  the tested windows rarely enters that range, and the delivered payload did not move (§5).
  A gate whose axis does not overlap the live regime can be fully green and predict nothing.
- Two instrument defects were found and fixed en route: `selfRetrieval` was called without its required `topK` in the prep path (a latent crash on any fresh prep run), and an uncaught provider error killed a whole batch when a reasoning model spent its completion budget on hidden reasoning and returned no text.

## 11 State of the code

All paths relative to the repository root. Everything below is committed on `main`.

| Path | What it is |
|---|---|
| `packages/core/src/retrieve/retriever.ts` | Injected `tokenizer` dep; measured centre-out narrowing band replacing the character-ratio estimate |
| `eval/scripts/transplant.mjs` | `--phase prep-overflow` (with `--ref-window`, `--out`); `appendHeadroom`; per-call live headroom on the tool context; `tree-oracle` and `tree-escalate` arms; `--questions-file`; per-replicate search-state reset; `WINDOWS` extended with 98,304 / 131,072 / 163,840 |
| `eval/scripts/narrowing-killgate.mjs` | Offline gate: does a band fit its budget and still carry the answer |
| `eval/scripts/facet-killgate.mjs` | Offline gate: builds all four indexes and is the sole source for every figure in §7-§8 — sizes, per-index ranks, routing against fusion, and the fusion demotions |
| `eval/scripts/line-index-killgate.mjs` | Offline gate: line-granularity ranking, C1 against C1′, with the pre-registered 10/17 criterion |
| `eval/fixtures/.../questions-overflow.json` | 5 questions, answers at seq 151–507, unreachable at W ≤ 65,536 |
| `eval/fixtures/.../questions-deep.json` | 5 questions, answers at seq 18–264, unreachable at W ≤ 131,072 — the clean instrument |
| `eval/fixtures/.../results/run-W*-questions-{overflow,deep}-*.json` | 18 scored cells, ~450 runs |
| `reports/algorithm.md` | Updated: rules 5 and 6, one-cut narrowing, routing-not-fusion, new parameters and boundary conditions |

**Test state, stated honestly.** `pnpm vitest run` is **964 passed, 2 failed, 9 skipped of
975**. An earlier draft of this report claimed "83 tests passing", which was the count of
the two files this pass touched (`transplant.test.ts` 50 + `retrieve.test.ts` 33), not the
suite. The suite is red on `main` and was before this pass: both failures are in
`eval-resumption/harness/harness.test.ts` and both are contract drift this lineage caused
and never reconciled — the advertised `context_fetch` JSON schema lost `from`/`to` relative
to the zod shape it is supposed to mirror (`eval-resumption/harness/arms.ts:92-105`), and a
test asserting summary-depth fetch now receives raw events because `fetchBranch` defaults
to `depth: 'full'` (`retriever.ts`, the landed "raw by default" change). Per the repository's
own rule, "tests pass" is wrong when any fail or are skipped; fixing these is item 12.0.

## 12 Open items and recommendations

**How to run these.** Each item below is a DS-STAR iteration and should be executed
with the `ds-star` skill (`~/.claude/skills/ds-star`) invoked first — `Skill` tool,
`skill: "ds-star"` — not improvised. These are **Mode 1** (improvement loop): there
is a metric and a baseline in every item, so the loop is analyze → quantify the gap
→ plan candidates → implement one → verify against baseline → route. Item 5 is the
exception and is **Mode 2** (design pass): it has no measurement yet and wants the
independent design panel, including the null-hypothesis stance, before anything is
built.

The discipline points that this pass learned the hard way, and that the next one
should not rediscover:

- **Offline gates before live spend, always.** Three gates in this pass
  (`narrowing-killgate.mjs`, `facet-killgate.mjs`, `line-index-killgate.mjs`) cost
  zero tokens and one of them retired a candidate — embeddings over lines — before
  a single dollar was spent on it. Run the gate as a numbered step, not as a risk
  to note.
- **Pre-register the win criterion and the depth it is measured at**, before the
  batch. Each item below states its own; do not soften one afterwards.
- **One measurable change per candidate.** A bundled arm produces an
  unattributable verdict. Every arm added this pass (`tree-oracle`,
  `tree-escalate`) changes exactly one thing against `tree-tail-v2`, and
  `tree-route` should too.
- **Attribute the mechanism before believing the headline.** The narrowing fix
  (§5) won its own bucket offline and moved no live score; that is legible only
  because the buckets were measured separately. A win whose mechanism is unclear
  does not get landed.
- **Check provenance before trusting a score** (§6, and item 2 below). This
  harness has produced fabricated evidence that passed the grader.
- **A pass is bounded at three iterations** and closes with a written report in
  `reports/metrics/`, committed. This pass ran four because the user extended it
  twice; say which of the three stopping reasons ended yours.

Ordered by information gained per unit of effort.

### 12.0 Fix the two failing tests first

`eval-resumption/harness/harness.test.ts` has two failures on `main`, both pre-existing and
both contract drift this lineage caused (§11). Neither is large: the advertised
`context_fetch` JSON schema needs `from`/`to` added to match the zod shape
(`eval-resumption/harness/arms.ts:92-105`), and the arm-D fetch test needs updating for
`depth: 'full'` being the default, which is a landed decision rather than a regression.
They go first because every item below is judged against a suite that currently cannot be
called green, and because the second failure is exactly the class of drift — advertised
contract diverging from enforced contract — that this pass spent a section on (§6).

### 12.1 Build the routing arm, `tree-route`

The one candidate this pass identified and did not test. It changes exactly one
thing against `tree-tail-v2`: `context_search` selects **one** facet index and
returns a top-10 slice of line-sized entries from it, instead of ranking 21 phase
summaries and returning branch coordinates.

**Why it is first, and the contradiction to resolve before starting.** §8 measured routing
at 9/17 against fusion at 6/17 and 5–6/17 for any single index, and §7 measured the payload
at 272–440 tokens against a branch replay an order of magnitude larger. It is the only
untested candidate that attacks both loss buckets at once.

But item 12.2 says no score in this project is trustworthy until provenance is checked, and
this arm's baseline is one of the exposed ones: `tree-tail-v2`'s 2/25 at W=65,536 is
question qo01 once plus **qo06 once**, and qo06 is the exact question §6 shows produced two
confirmed fabrications. Its only W=32,768 success is also qo06. The baseline may well be
0/25 real. Either run 12.2 first — it is free — or start here knowing the baseline is
unaudited and that a win against it may be a win against zero, which would make the
two-proportion test easier to pass than it should be. **Recommended: run 12.2 first.** It
costs nothing and it changes the denominator of this experiment.

**Step 1 — offline gate, zero tokens. Do not skip to the batch.**
`eval/scripts/facet-killgate.mjs` already builds all four indexes over both question sets
and prints per-index ranks, the routing-versus-fusion totals and the demotions. What it does
**not** yet do is *decide* the index from the question text — that is the work: add a
deterministic router (surface features are sufficient — a request for a command's
description routes to `command`, an identifier or number to `line`, a bare path to `file`,
a two-literal question to none), then report routing accuracy and answer-in-top-10 under it. Pre-registered gate: **routing accuracy ≥ 12/17 and answer-in-top-10 ≥ 8/17**, with the
convention stated explicitly because it decides whether the bar is trivial or impossible:
**routing a question to "no index" counts as correct when the answer is genuinely absent
from all four** (6 of 17 questions, §8), and incorrect otherwise. Without that convention,
12/17 is either nearly free (6 gimmes plus 6 of the remaining 11) or unreachable (maximum
11/17). Note also that the answer-in-top-10 bar is *tight*, not loose: against §8's
best-single-index ceiling of 9/17 it permits exactly one routing miss that costs a hit.
Both figures come from `facet-killgate.mjs`, which now prints them.

**Step 2 — wire the arm.** All four facet builders now live in `facet-killgate.mjs`
(`buildIndexes()`). Lift that function into `eval/scripts/transplant.mjs` as
`buildFacetIndexes(scenario)`, along with the per-index hybrid ranker (`order()` in the
same file); keep them in the harness, not in `packages/core`, until the arm wins — an experimental index in core would have to
be migrated or deleted, and L1 is rebuildable precisely so experiments do not
have to touch it. Register `tree-route` at the seven wiring points a new tree arm
needs, all in `transplant.mjs` and all following `tree-oracle` verbatim:

| What | Where |
|---|---|
| `ARM_IDS` | the frozen arm list, with a comment stating the one variable |
| `TREE_ARMS` | so it gets a per-arm root pin |
| `LEGACY_SURFACE_ARMS` | so `handlersForArm` returns custom handlers at all |
| `RAW_NARROWED_FETCH_ARMS` | so it inherits the one-cut fetch and the stripped `depth` schema |
| `toolSchemasForArm` | add a `kind` enum to `context_search` naming the four indexes |
| `handlersForArm` | the router: pick the index from `input.kind`, rank with C1′ (fingerprints + grep + RRF, §8), return the top 10 as `[seq] line` entries |
| `buildArm` | add the case alongside `'tree-oracle'` and to the headline condition |

`context_search` already accepts `kind` in the retriever
(`retriever.ts:188, 194, 258, 511`), so no new tool is added — only an enum widened.
Hits must carry their `seq` so `context_fetch` can still expand around one
(`[seq] line` is the entry format the gates measured).

**Step 3 — smoke it before spending.** `TRANSPLANT_SMOKE=1 node
eval/scripts/transplant.mjs --phase run --scenario s1 --window 65536 --arm
tree-route --model z-ai/glm-5.3-flash --questions-file questions-deep.json`.
Note the smoke path uses a hardcoded probe question and ignores `--questions-file`, so it
proves the wiring (tools advertised, handler reachable, no crash) and **not** routing on a
real question — existing `tree-oracle` smoke rows show `question: "smoke"`, `score: null`,
`fetched: false`. For a real one-question check instead, run the batch command below with
`--reps 1` and read the first row. Either way, `cut>0` means the result list is over the
headroom share and the router is returning too much.

**Step 4 — the batch.**
```
node eval/scripts/transplant.mjs --phase run --scenario s1 --window 65536 \
  --arm tree-route,tree-tail-v2 --model z-ai/glm-5.3-flash --reps 5 \
  --questions-file questions-deep.json
```
Both arms in one invocation so they share an epoch. `tree-oracle` at this cell is
already measured at 13/25 and does not need re-running unless the store or the
question set changes. Estimated cost approximately **$0.35**; the comparable
batches in this pass ran $0.09–$0.15 per 25-run arm.

**Pre-registered win criterion — and an honest note on what n=25 can detect.** An earlier
draft asked for "p<0.05 **and** ≥ 6/25", which is internally impossible: against a 2/25
baseline, 6/25 gives p=0.12 (two-proportion z) or 0.25 (Fisher exact), and the smallest
count clearing p<0.05 is **8/25** by z or **9/25** by Fisher, which is the right test at
these counts. The criterion is therefore **≥ 9/25**, and note that is two-thirds of the
distance to the 13/25 ceiling, not a third.

Worse, the 25 are not 25 independent trials. They are 5 questions × 5 replicates, and
outcomes cluster hard by question — the deep oracle at W=65,536 is `5/5, 1/5, 5/5, 0/5,
2/5`. The effective sample is nearer 5 than 25, any nominal p is anti-conservative, and
only a swing of about four whole questions is detectable. **The fix is more questions, not
more replicates**: before treating any near-miss as signal, extend the deep set to 10–12
questions with `--phase prep-overflow --ref-window 131072 --out questions-deep-12.json`
(costs a paraphrase batch, well under a dollar), rather than raising n on five.

Below 9/25 but visibly above baseline: extend the question set as above and re-run, once.
At or below baseline: revert, and journal that routing does not survive contact with a
model that must choose the index itself — which would point at a deterministic server-side
router, chosen from question features before the model sees anything.

**Route on the result.** A clean win lands the arm and makes the next gap the
6/17 coverage ceiling (item 12.5). A win whose mechanism is unclear — for example
the score rising while `searched` shows the model ignoring `kind` — is not landed;
add telemetry recording the requested `kind` per call and rerun.

### 12.1a Run `tree-tail-v2` on the deep set — one cell, closes §3's gap

The deep set has a ground truth and an oracle but no real-search arm, which is why §3
cannot split the loss on it. One 25-run cell fixes that permanently:
```
node eval/scripts/transplant.mjs --phase run --scenario s1 --window 65536 \
  --arm tree-tail-v2 --model z-ai/glm-5.3-flash --reps 5 --questions-file questions-deep.json
```
Roughly $0.13 by the reverse-engineered token pricing in §12.2's note. Do this before or
alongside 12.1 — it is the difference between "ranking is 90% of the loss" (overflow set)
and an unknown split on the harder set, and it costs less than the routing batch it informs.

### 12.1b Parameterize `rank-killgate.mjs` — zero tokens

It hardcodes `questions.json` (line 33), so the offline top-3 rate has **never** been
measured on the overflow or deep sets, and §3's comparison of "10/12 offline" to a live
score on five different questions is not a comparison. Add a question-file argument and
report top-3 per set. If the deep set's offline top-3 is poor, bucket 1 is "the ranker is
bad on these questions"; if it is good, bucket 1 is "the model cannot exploit a good
ranker". Those imply different fixes, and the experiment is free.

### 12.2 Remaining items
**12.2 Add a provenance check to grading — before any further tuning.** Zero live
tokens; it re-scores the **15** result files (18 arm-cells, since two files carry two arms)
in `eval/fixtures/transplant/s1/e1b289c32f40/results/` matching
`run-W*-questions-{overflow,deep}-*.json`. Write
`eval/scripts/provenance-audit.mjs` asserting three things per scored row: every
sequence number the answer cites exists in the trace (`trace.all()` max seq is
754 on this store — the fabrication in §6 cited 755–757); the answer literal
appears in content the run actually retrieved (`fetchedIds` → replay that branch
via `retriever.fetchBranch(id, {depth:'full'})` and substring-match); and, for
single-turn arms, the literal appears in the assembled prompt. Rows failing all
three are fabrications or artifacts and their score is `null`, never `0` — an
un-earned success is not a wrong answer. It needs a fourth assertion that has nothing to do with provenance and everything to do
with not corrupting the audit: **key every row to its source question set from the
filename.** The two sets reuse the same five question ids (`s1-qo01-overflow` … ) for
different questions, one id is byte-identical in both, and a row carries only `question`
and `stratum: "overflow"` — so any aggregation by id silently merges two different
questions. Report per arm and per set: score before, score after audit, and the artifact
count.

While in this file, persist the cost meter. Every cost figure in this report is
reverse-engineered from `usage{input,output,cacheRead}` against list prices, because no
`usd` field is written to a run header — though the meter already exists
(`providerFor`) and `usd` is already persisted for the compaction artifact. One line makes
every future cost claim auditable instead of plausible. Until this exists no score in this project is
trustworthy, §3's included; the oracle numbers are least exposed, because a
correct answer there coincides with correct content having been fetched, but they
are not immune.

**12.3 Re-audit the prior pass's numbers** with 12.2's script:
`ds-star-live-verification-report.md` and `ds-star-search-ranking-report.md`. Start with the
one claim an earlier draft of *this* report called safe and which is not: the prior pass's
headline "11/12 top-3". `rank-killgate.mjs` returns **10/12** for the shipped deterministic
ranker (q05 at rank 4, q11 at rank 8); 11/12 required an injected query rewriter that was
**mocked**, not a live model — the prior report says so itself. `reports/algorithm.md` has
10/12 correctly in four places. The live scores are also unaudited, and the
prior report's headline — that the tree loses to `truncate-tail` at W=32–65K —
rests on `truncate-tail` cells that this pass showed can score on questions the
baseline provably cannot see (§6: four of four at W=65,536 were artifacts). The
comparison may be closer than recorded, or may not be; it is unmeasured either way.

**12.4 Ship the heuristic-to-BPE refinement.** One line in `transplant.mjs`: the
per-call budget currently divides the live headroom by the measured ratio
(`_liveHeadroomHeuristic = Math.floor(live / budgets.ratio)`), inflating the band
about 17%, and on code-dense branches the real BPE count then exceeds the append
cap and it fires anyway. Pass `live` directly instead — conservative, guarantees
fit, costs roughly 15% of band width. Verify with
`node eval/scripts/narrowing-killgate.mjs` (must stay 20/20 on `fits`) and then
one 25-run cell at W=32,768, where residual truncation is worst (49,410 tokens cut):
success should be measured on **fetch-attributable** truncation, not the run total: at
W=32,768 the prompt already consumes ~31,000 of 32,768 tokens and search results are capped
alongside fetches, so an order-of-magnitude fall in the total may be unreachable by a
fetch-side change. While in that code path, delete the surviving fallback
`?? Math.floor((ctx._headroom ?? 20000) / 2)` — a halved build-time constant with a magic
default, still a rule-2 defect, and the reason `algorithm.md`'s "derived" classification for
this parameter is currently generous.

**12.5 Answer the spanning-question shape — a Mode 2 design pass.** Three of 17
questions (`q10`, `q11`, `q12`) require two literals from two places and cannot be
served by any single-entry index by construction; they are the largest component
of the hard 6/17 ceiling in §8. This has no measurement yet, so it wants the
design panel with three independent stances and a null-hypothesis designer whose
brief is "the smallest honest change, possibly nothing" — a defensible outcome
here is that multi-hop questions are declared out of scope for v1 and the
`spanning` stratum stays exploratory, which is what it is already pre-registered
as. Candidates to put in front of the panel: a join across indexes on shared
`seq` proximity; an explicit second `context_fetch` the contract instructs the
model to make; or `node_links` (already in the L1 schema, currently unused for
this) carrying the relation.

**12.6 Reply-fraction sweep** — unchanged from the prior report and still
unvalidated. `FRACTIONS.reply` is 0.05, reserving 1,638 tokens at W=32,768, which
is tight for a model that reasons before answering; the prior pass recorded
empty completions traceable to exactly this. Sweep 0.05 / 0.10 / 0.15 on `questions-deep.json`, n=5. Two practical notes a cold agent
will otherwise hit: `FRACTIONS` is a frozen module constant with **no CLI flag**, so each
setting means editing `transplant.mjs:105` and re-running — add the flag or accept the edit,
but record which was done. And do not scope this to W=32,768: the four empty completions
found in §2 were on `truncate-tail` at **W=131,072** with `maxReplyTokens` of 6,553, so the
failure is not confined to tight windows. Use two arms, not one: `tree-oracle` isolates the
effect from retrieval noise but returns a one-hit search result, making it the arm least
likely to expose a reply-versus-search headroom conflict; pair it with `tree-tail-v2`.
Win: the setting with the highest score and the fewest `null` rows from empty completions. This is rule 4 in `reports/algorithm.md` — find the
sweet spot, do not pick a bound.

**12.7 Second scenario, when any of the above lands.** Every number in this report
rests on one 754-event session. `eval/scripts/build-*-scenario.py` are six parameterized scenario builders (bughunt, dozen,
jsonc, multimod, refactor, ripple); a second frozen store with its own `prep-overflow` cut
is what turns any finding here from "true on s1" into "true". Target the shape of s1 —
~750 events and ~196,000 BPE tokens — so the overflow regime exists at the windows already
measured. Two things a cold agent needs and this item previously omitted: the artifact
directory is named from the first 12 hex characters of the trace file's sha256 (see
`openScenario`), and **`--phase prep-overflow` will not write a question set without
`--allow-live`**, because the paraphrase step calls `deepseek/deepseek-v4-flash`. Budget a
paraphrase batch (capped at $0.50, and this pass's two sets cost $0.0008 and $0.0006);
none of the estimates above include it. This is the highest-value item for an outward-facing claim and the lowest
for the next iteration's decisions, which is why it is last.

## 13 What this pass did not test

A second scenario or a second store: every number rests on one 754-event session and one repository. Any model other than GLM 5.3 Flash on the new question sets; the prior pass's Haiku 4.5 and Sonnet 5 cells predate the narrowing fix, the oracle arm, and both new question sets. The routing arm itself, which is item 1 and is unbuilt. Facet indexes as *live* retrieval — all facet numbers in §7 and §8 are offline rank-and-payload measurements, never placed in front of an answering model. Sessions long enough to break the cheap-facet property: the command index is 7,525 tokens on this store and grows linearly, so a ten-fold longer session puts it near 75,000 and the whole-index move dies. Whether `tree-escalate` would separate from baseline at larger n; it was left at n=25 after failing to distinguish itself. And the tree's behaviour in an actual resumed session, as opposed to a replayed frozen trace — the transplant harness measures recall over a fixed store, not a live agent extending one.

---

DS-STAR multi-index pass · 4 iterations · ~450 scored runs across 18 cells, 3 arms, 5 windows, 2 new question sets · 3 offline kill gates · 5 candidates rejected, 2 of them unspent · 964/975 tests passing, 2 pre-existing failures · September 3, 2026.
