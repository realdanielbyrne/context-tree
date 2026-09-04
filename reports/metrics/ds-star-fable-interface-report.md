# The retrieval unit, not the ranking: porting Claude's chat-search interface into context-tree

DS-STAR pass, context-tree retrieval · September 4, 2026 · GLM 5.3 Flash on the frozen `s1` store

## Abstract

context-tree turns an agent's long conversation trace into a summary-headed tree so that a
resumed session sees branch summaries instead of raw history and pulls detail back through two
tools, a search that ranks branches and a fetch that returns a branch's raw events. This pass
asked whether the windows the tree had been evaluated at (32,768 and 65,536 tokens) were
measuring the algorithm or starving the model, and what could be learned from Anthropic's own
production chat-search interface, leaked with the Claude Fable 5.1 system prompt and sampled live
on the user's claude.ai account. That prompt is 60,903 tokens by itself, so the small windows
were starvation cells. At W = 131,072, the effective window of a 200,000-token host carrying such
a prompt, the shipped stack went from 1/25 to 5/25 on the five-question deep set with the raw-tail
baseline at 0/25 (GLM 5.3 Flash, n = 5, provenance-audited). An ablation confirmed bare-filename
centering (qo04 0 → 3-5 of 5) and retired the compact coordinate hit list (qo03 5 → 0 of 5).
Porting Anthropic's unit, five best-matching events with a 1,000-character excerpt each in place
of branch pointers, scored 15/25 against 6/25 in the same batch, every success with zero fetches,
median 2 turns, and 54% less uncached input over completed runs (59% over all rows). The main
limitations are one store, one model, one
window, n = 5, two constants taken from the published interface and never swept, and a library
that still ships the old unit.

## 1 What the system is, and what this pass asked

context-tree reorganizes an agent's linear conversation trace into a summary-headed tree so that
a long or resumed session sees branch summaries (Zone B) and the active branch's detail (Zone C)
instead of raw history, and pulls detail back on demand through two MCP tools: `context_search`
ranks branches and returns their coordinates, `context_fetch` returns a branch's raw events
narrowed to the space left in the window. The evaluation harness (`eval/scripts/transplant.mjs`)
freezes one real 754-event Claude Code session (196,385 cl100k tokens), replays it to a small
model at a chosen window W, and asks literal-answer questions whose sources lie outside the
window's raw tail. A question scores 1 only if the model's final answer contains an exact string
from the trace that no fluent model could synthesize.

Two facts prompted this pass. First, the production system prompt of Claude Fable 5.1, as leaked
in the CL4R1T4S repository, is 274,608 characters, which is 60,903 cl100k tokens (counted with the harness's own
tokenizer package: `node --input-type=module -e "import {countTokens} from
'./eval/node_modules/gpt-tokenizer/esm/main.js'; ..."` over the fetched markdown body); every prior
batch ran at W = 32,768 or 65,536, windows a realistic host has already spent on its operator
prompt before the conversation begins. Second, that same prompt defines Anthropic's own
past-conversation retrieval: `conversation_search` (5 hits by default, each a snippet with a
position token), `read_conversation` (opens at the hit, returns 20 turns by default) and
`recent_chats`, plus behavioral rules for the model. It is a shipped, production instance of the
problem context-tree is solving, and its interface differs from ours in ways our previous three
passes had been circling.

The pass therefore had two objectives: test whether the small-window regime had been starving
the model rather than measuring the algorithm, and port Anthropic's interface as a
published-alternative arm to see which of its choices matter on our substrate.

## 2 Method

DS-STAR Mode 1 (improvement loop). Four fresh-context analyzers (interface delta, regime
arithmetic, audit of the prior pass, harness feasibility), three planners (published
alternative, regime first, null hypothesis) and one judge ran as a Workflow, every role on
`claude-opus-4-6[1m]`, reading the artifacts themselves; their reports are the
`reports/metrics/ds-star-fable-interface/analyzer-*.md`, `plan-*.md` and `judge-verdict.md`
files. The main loop then ran three iterations, each pre-registered in
`reports/metrics/ds-star-fable-interface/journal.md` before its batch started, all on
`z-ai/glm-5.3-flash` ($0.075 per million input tokens) at n = 5 replicates per question on the
five-question deep set, with `truncate-tail` (the practitioner's default: keep the newest raw
events that fit) as the equal-n, same-epoch baseline in iteration 1 and the previous
iteration's best arm as the baseline afterwards. Every score below was passed through
`eval/scripts/provenance-audit.mjs`, which nulls a success the run could not have earned from
what it was served.

Conventions. Scores are unconditional: provider failures and stalls stay in the denominator
(n = 25 per arm). Medians of turns and tokens are over completed runs only; token totals are
over all rows. "Uncached input" is the provider's `usage.input`, the tokens not served from the
prefix cache; cache-read tokens are reported separately. The first request of every arm pays the
whole prompt as uncached input while it writes the cache, so each arm has one row whose uncached
input is an order of magnitude above its median.

Terms. **Window (W)**: the token budget the harness pretends the model has; budgets for every
zone derive from it. **Headroom**: the tokens left for tool results after the prompt and the
reply allowance, measured per call. **Delivered**: an answer literal was present in a tool
result after the harness capped it to the headroom. **Selection**: the model's first fetch
targeted the branch that holds the answer. **Overflow question**: a question whose source event
lies before the truncate-tail boundary at the window under test, so the tail alone cannot
answer it.

## 3 Anthropic's interface, and what could be observed of it

The leaked contract and the three tool schemas are quoted verbatim in
`reports/metrics/ds-star-fable-interface/fable-5.1-past-chats-tools.md`. The tools are
claude.ai server-side; they cannot be called from this repository and their ranking is not
observable. Their interface is, and the user's suggestion to test it on one of their own
claude.ai chats made a live sample possible through the Chrome extension. The chat was an
8-turn conversation about pricing a RAM kit; five literal questions were written from its text
before any probe, and each was asked in a fresh claude.ai chat (Sonnet 5, "Medium"). The raw
`<chat>` payload is not rendered in the UI and the model declines to paste it verbatim, so
per-hit structure is the model's own description of its tool result, obtained by a follow-up
question; final answers and the "Relevant chats" chip are observed. The full log is
`claude-ai-probe-answer-key.md`.

| probe | answer literal | where in chat | correct? | tool calls |
|---|---|---|---|---|
| p1 model number | `F5-5600S4040A16GX2-RS` | turn 1 | yes | 1 search, 0 reads |
| p2 Newegg list price | `$489` | turn 3 (user) | yes | 1 search, 0 reads |
| p3 cause of the wrong price | `WD_BLACK` | turn 3 (assistant) | **no** | 1 search, 0 reads |
| p4 cheapest price and store | `$300`, Walmart | turn 4 (user) | yes | 1 search, 0 reads |
| p5 final recommended price | `$260` | turn 4 (assistant) | yes | 1 search, 0 reads |

Four of five in one turn, one search each, no read. The structure reported for every search was
the same: exactly 5 hits, one or two of them `kind="summary"` (a whole-chat digest of about
180-230 words carrying identifiers such as the model number, no position token) and three or
four `kind="conversation"` (contiguous multi-turn chunks of about 200-360 words that start and
stop mid-turn, each with a `page_token`), with the target chat appearing as several chunks and
the rest from unrelated chats. The payload was about 800-1,000 words, roughly 1.1-1.4k tokens.
The single failure, p3, is the failure our own passes documented: the answer-bearing chunk was
not among the five, the summary paraphrased it ("page rendering error"), and the model answered
from the summary without reading. Asked to "open the chat at the point where...", the model
recovered the literal, but with a scoped re-search
(`conversation_search(query', within_conversation_id=...)`, 3 chunks, ~550 words), not a page
read. `read_conversation` was called only when named explicitly (turns 2-7 of 8, ~650 words,
opened at the matching turn with a `prev_page_token`).

Three things follow for our design. The retrieval unit is a ~250-word chunk and the hit is the
payload, so most questions need no second stage. Summaries are a second index over whole
conversations and carry identifiers. The behavioral rules in the prompt (content-noun queries,
open one or two, read once) are what stops the model from thrashing, not a mechanism in the
tool.

## 4 The instrument: which windows test retrieval at all

The deep question set (`questions-deep.json`) was cut so that its five answers lie outside
truncate-tail's tail at W = 131,072. That property decays as W grows, because the tail boundary
moves toward the start of the trace. Computed exactly on the frozen store with
`truncationBoundarySeq` (journal, kill gate KG-1):

| effective W | tail boundary seq | deep answers still outside the tail |
|---|---|---|
| 65,536 | 523 | 5/5 |
| 131,072 | 268 | 5/5 |
| 163,840 | 244 | 4/5 |
| 200,000 | 108 | 1/5 |
| 270,000 | 1 | 0/5 |

So the prior report's proposed next experiment, "run at W = 200,000", would not have tested
retrieval: four of the five answers would have sat in the plain tail. The realistic-host cell is
W = 131,072, which models a 200,000-token host carrying a Fable-sized (about 69,000-token)
system prompt. There the deep set is fully valid and the tree's first tool turn has about 18,300
tokens of headroom (analyzer A2 §2) against 7,886-7,919 measured at W = 65,536 in the prior pass.
The harness cannot express a system-prompt pad as bytes; reducing W is arithmetically exact for
every derived budget (`deriveBudgets`, `transplant.mjs:454`), but it leaves the pad's content
effect untested (§10).

The audit of the prior pass (analyzer A3) recomputed every load-bearing figure in
`ds-star-search-centering-and-payload-report.md` from its result files and found all of them
reproduce; five wording corrections were applied to that report and are listed at its foot.

## 5 Iteration 1: the regime shift

No code changed. Arms `truncate-tail`, `tree-tail-v2` (the full shipped stack: keyword
headlines, fingerprint search with grep re-ranking, raw fetch narrowed to headroom, legacy
centering) and `tree-search-coordinates` (the prior pass's untested candidate: the same stack
with a compact all-rank hit list and bare-filename centering) at W = 131,072, n = 5, deep set.
Pre-registered: truncate-tail must stay at 0/25 (precondition); tree-tail-v2 ≥ 5/25 supports
the starvation hypothesis (its score at 65,536 was 1/25; +4 is the threshold the prior pass
used); coordinates − tree-tail-v2 ≥ +4 credits the compact list.

Result file
`eval/fixtures/transplant/s1/e1b289c32f40/results/run-W131072-truncate-tail+tree-tail-v2+tree-search-coordinates-questions-deep-q9ebc3150-cbb15b5961243-n5-z-ai_glm-5.3-flash.json`,
75 rows; 1,751,898 uncached input tokens plus 17,418,240 cache-read tokens and 114,064 output
tokens, $0.458; provenance audit 10/10 successes earned, none answerable without retrieval.

| arm | exact match | completed / provider error / stalled | qo01 qo02 qo03 qo04 qo05 | median turns (completed) | median uncached input per completed run |
|---|---|---|---|---|---|
| truncate-tail | 0/25 | 22 / 0 / 0 (+3 turn cap) | 0 0 0 0 0 | 1 | 4,188 |
| tree-tail-v2 | 5/25 (1/25 at W=65,536) | 19 / 6 / 0 | 0 0 5 0 0 | 3 | 31,508 |
| tree-search-coordinates | 5/25 (no prior live rows) | 18 / 5 / 2 | 1 0 0 4 0 | 3 | 23,430 |

The precondition held and the starvation hypothesis met its threshold exactly. The compact list
added nothing on the headline but moved everything underneath, and because that arm differs from
tree-tail-v2 in two ways at once (the hit list and the centering extractor) the headline could
not be attributed without the ablation in §6. Reading the per-call telemetry (`toolCalls[]`):

- **qo04, a 57,891-character branch.** tree-tail-v2 centered its band at seq 55, 93, 115 or 121 and
  the literal at seq 218 was absent after the cap in every fetch. The bare-filename extractor
  centered at 218 in 4 of 4 fetches, the band arrived at about 49,700 characters (roughly 12,000
  tokens) with the literal present, and 4 of 5 runs scored. At W = 65,536 the same centering
  delivered nothing (prior pass), so the mechanism is centering multiplied by headroom: the
  correct center is necessary and the window makes it sufficient.
- **qo03, the branch ranked 7th.** With full-surface hits the model fetched the correct branch
  first in 5 of 5 runs and scored 5 of 5 from a 10,515-character result. With compact
  coordinates, which drop the `meta.files` and `meta.symbols` pointers, a distractor was fetched
  first in 5 of 5 runs, the headroom was spent on it, and later fetches of the correct branch
  returned zero bytes; two runs stalled. The prior pass showed that adding keyword evidence to a
  hit does not help selection; this shows that removing the pointer metadata hurts it. The hit
  list is a display problem in both directions.
- **qo05: an instrument defect.** In 9 of 10 tree runs the model never called a tool and
  answered "Build, test, and check suite status" from seq 329, a later near-duplicate of the
  question's pnpm-build-then-vitest command that sits inside the raw tail at this window
  (boundary 268) but outside it at 65,536 (boundary 523). The question set's uniqueness gate
  checks the answer string, not the question's referent; a competing referent entered the tail
  as the window widened. Call this distractor decay; it is a second form of the question-set
  decay already in the measurement-hazards table.
- **Provider failures.** 11 of 50 tree rows ended in `model_call_error`: OpenRouter returned a
  completion with reasoning tokens but no content and no tool call at prompts of 105,000 to
  125,000 tokens, all on qo01 and qo02. They stay in the denominator. Conditional on
  completion the tree arms are 5/19 and 5/18.

Route: split verdict, so an ablation with one variable toggled.

## 6 Iteration 2: the ablation

One arm, `tree-center-filename`, at the same window, epoch and n: full-surface hits (title,
`meta.files`, `meta.symbols`) with bare-filename centering. Against tree-tail-v2 it toggles only
the centering extractor; against tree-search-coordinates it toggles only the hit display.
Pre-registered: ≥ 8/25 with qo03 ≥ 4/5 and qo04 ≥ 3/5 confirms both attributions.

Result file `results/run-W131072-tree-center-filename-questions-deep-q9ebc3150-cbb15b5961243-n5-z-ai_glm-5.3-flash.json`,
25 rows, $0.211. Raw 9/25; the provenance audit nulled one success (qo02 rep 5 produced
`timeCapMs` although no fetch carried it), leaving **8/25 earned**: qo03 5/5, qo04 3/5, the
rest 0. Both pre-registered conditions met, at the threshold.

| arm (W = 131,072, deep set, n = 5, same epoch) | earned | qo01 qo02 qo03 qo04 qo05 | provider errors |
|---|---|---|---|---|
| truncate-tail | 0/25 | 0 0 0 0 0 | 0 |
| tree-tail-v2: full hits, legacy centering | 5/25 | 0 0 5 0 0 | 6 |
| tree-search-coordinates: compact hits, bare-filename centering | 5/25 | 1 0 0 4 0 | 5 |
| tree-center-filename: full hits, bare-filename centering | 8/25 | 0 0 5 3 0 | 4 |

The two toggles separate cleanly. Centering is worth qo04 (0 → 3-4 of 5) whichever display is
used; the display is worth qo03 (0 ↔ 5 of 5) whichever centering is used. The compact list was
the prior pass's candidate for freeing headroom; it does free about 5,000 tokens per search, and
it costs the one question the model could otherwise select. It is retired as a default. The
bare-filename centering, which the prior pass could not credit because its batch was capped away
at W = 65,536, is confirmed and kept.

The two qo04 misses show the residual constraint. One run's query carried no filename and
centered at seq 55. The other centered at 218 but had spent its headroom on a second search: the
band arrived at 8,688 characters with 4,444 cut and the literal gone. qo01 is the same constraint
in full: after two full-surface searches at about 6,000-7,000 tokens each, the exact headroom was
already negative at turn 3 (−10, −85, −115 tokens on successive calls), and the model had also
narrowed its fetch with a `file` path that has no file node under the branch, so every fetch
appended zero characters. Full-surface hits buy selection and spend the headroom the fetch
needs; compact hits do the reverse. Neither display is right, which is what Anthropic's design
suggested from the start: the hit should carry the content, and there should be few of them.

## 7 Iteration 3: the published alternative's unit

The candidate `tree-snippet-hits` changes one thing against `tree-center-filename`: what a
search hit is. The ranker still ranks the same 20 branches. For each ranked branch the
retriever's own relevance scorer (`findRelevantCenter`, the function that already centers a
narrowed fetch) scores that branch's events for the query; the 5 best-scoring events across all
branches become the hits, each carrying its `seq` and a 1,000-character excerpt of its own
rendered text, centered on the first matched term. Branches whose events match nothing fill the
remaining slots as bare coordinates. The tool description tells the model that if an excerpt
shows the literal it needs it may answer from it, and otherwise to fetch the hit's branch with
`from`/`to` around the `seq`. Both constants come from the observed claude.ai interface (5 hits;
200-360-word chunks) and are unvalidated on this host. Code: `snippetHitsFor` and
`excerptAround` in `eval/scripts/transplant.mjs`; the library's `context_search` is unchanged.

Before the batch, `eval/scripts/snippet-hits-killgate.mjs` replayed the 56 distinct queries the
model had issued in iteration 1 through the new handler at zero live cost: the excerpt list
carried the answer literal on 48 of 56 queries, showed the answer event on 53 of 56, and cost a
median 1,693 tokens (maximum 1,926) against the 18,300-token headroom. The two questions it
predicted would not be served were qo02, whose literal sits outside the 1,000-character window
of an otherwise correctly ranked event, and qo05, whose failure happens before any search.
Pre-registered: snippet-hits − center-filename ≥ +4/25 in the same batch; mechanism fields
`answerLiteralInExcerpts`, turns, fetches per run.

Result file `results/run-W131072-tree-center-filename+tree-snippet-hits-questions-deep-q9ebc3150-cd956c49f5ef4-n5-z-ai_glm-5.3-flash.json`,
50 rows, $0.299. The baseline re-ran because the harness edit changed the code fingerprint.

| arm (W = 131,072, deep set, n = 5, one batch) | earned | qo01 qo02 qo03 qo04 qo05 | completed / provider error / stalled | median turns (completed) | fetches per completed run | uncached input, all rows (completed) | cache-read input, all rows | output, all rows |
|---|---|---|---|---|---|---|---|---|
| tree-center-filename | 6/25 | 0 0 5 1 0 | 19 / 4 / 2 | 3 | 1.42 | 768,123 (698,680) | 8,381,952 | 55,688 |
| **tree-snippet-hits** | **15/25** | **5** 0 **5** **5** 0 | 21 / 4 / 0 | **2** | **0.05** | **318,449 (318,449)** | **4,372,992** | **15,192** |

The pre-registered threshold was met by +9. Every one of the 15 successes was answered without a
single fetch: on 12 the first search's excerpts contained the literal
(`answerLiteralInExcerpts = true`), on the other 3 (all qo04) the first query matched no event
and a reformulated later search did (the second in two runs, the third in one). Median turns fell from 3 to 2, fetches per run from 1.42
to 0.05; uncached input fell 54% over completed runs (318,449 vs 698,680) and 59% over all rows
(318,449 vs 768,123), cache-read input 48% (4,372,992 vs 8,381,952), output 73%. The kill gate had
also shown the answer branch visible in the hit list on 49 of 56 recorded queries. The provenance audit had to be
extended before this number could be read: it credited literals served by the prompt or by a
fetched branch, so it marked all 15 as unverifiable; a new `earned-search` verdict reads the
recorded per-call `answerLiteralPresentAfterCap` on search calls, after which the arm is 15/25
earned and no other arm's audited score moved.

The two zeros are not the arm's. qo02 had 4 provider failures out of 5, and the one completed run
was served excerpts without the literal, as the gate predicted. qo05 was never searched in any of
the 5 runs (distractor decay, §5). The baseline's own drop from 8/25 in iteration 2 to 6/25 here
(qo04 3/5 → 1/5, two stalls) on an unchanged code path is the n = 5 noise of a question whose
delivery sits at the cap edge; it does not touch the comparison, which was made inside one batch.

This is the claude.ai probe reproduced on our substrate. There, 4 of 5 literal questions were
answered from the hit list with no read; here, 3 of 5 questions were answered 5/5 from the hit
list with no fetch, and the other two failed upstream of the mechanism. The unit is what changed:
a hit that is a ~250-word chunk of the matching event is a payload, and a payload needs no
second stage, so the token cost of the retrieval, the turn count and the exposure to the append
cap all fall together.

## 8 What changed in the algorithm reference

`reports/algorithm.md`, change-log entry 2026-09-04 11:20. Nothing under `packages/` changed;
the arm is harness-only and Tier 1 still describes what ships, with the measured variant added as
a marked line under `search`. Tier 2 gains three rows: the two host constants of the snippet arm
(from the published interface, unvalidated here) and the boundary that a window below the host's
own system prompt is a cell no real host occupies. The `search result limit` row records the
compact display's retirement with its number. The boundary table gains the measured decay curve
of the deep set, the headroom figures at both windows, and the label-versus-payload finding.
The measurement-hazards table gains distractor decay, audit channel blindness, the provider's
empty turns and the exact boundaries. Candidates: coordinates retired, bare-filename centering
confirmed, event-snippet hits measured and not yet default.

## 9 What the pass did not test

- **One store, one model, one window.** Every live number is GLM 5.3 Flash on the s1 trace at
  W = 131,072 with n = 5. The claude.ai probe was Sonnet 5 on one 8-turn chat with n = 1 per
  question. Nothing here is proven on a second trace, a second model, or a second window.
- **The library, live.** `packages/mcp`'s `context_search` was ported to event hits after the
  pass closed (open item 5); it reproduces the arm on the offline gate but has not been run live.
- **The constants.** 5 hits and 1,000 characters were never swept; qo02 shows the excerpt window
  can miss a literal in a correctly ranked event.
- **The system prompt as bytes.** The realistic host was modeled by reducing W, which is exact
  for every derived budget but silent on how 60,000 tokens of operator instructions change a
  model's tool use.
- **A true large-window overflow regime.** The s1 trace is 196,385 tokens; at W ≥ 200,000 it
  no longer overflows. A 400,000+ token trace is needed and does not exist (analyzer A2 §7).
- **The overflow question set** (`questions-overflow.json`): 1 of 5 valid at this window; not run.
- **Anthropic's ranking, chunking and summary generation**, which are unobservable, and their
  behavioral rules (content-noun queries, open one or two, read once), which were not ported.
- **The judge's queue items Q2 and Q3** (hit count 5 on the coordinate arm; a behavioral
  opens cap): superseded by the snippet arm's result, not measured.

## 10 What was learned, apart from what was decided

Domain. The tree's losses at W ≤ 65,536 were never about the algorithm: a realistic host has
already spent that window on its prompt, and on this store the same shipped stack goes from 1/25
to 5/25 the moment it has 18,000 tokens of headroom instead of 8,000. Ranking was not the deep
set's constraint at any point; selection is decided by what the hit displays, in both directions,
and delivery by whether the band is centered on the right event and whether the search list left
room for it. Anthropic's design dissolves that trade by making the hit the payload; on our
substrate the same move removed the fetch from 15 of 15 successful runs.

Instruments. Three defects were found by reading artifacts rather than scores. A question set
decays in two ways as W grows: its answers enter the tail, and competing referents enter the tail
(qo05). A provenance audit is blind to any payload channel it was not written for, and a new arm
that opens one looks like fabrication until the audit is extended. A provider that ends a turn on
reasoning alone is a fifth of the rows at 105,000-125,000-token prompts and is not a budget cut.

Methodology, proposed for the DS-STAR skill. First, the instrument audit must include the
*regime*, not only the strata: compute what a realistic host's fixed cost leaves of the window
before choosing W, or the whole pass measures starvation. Second, when a published alternative
exists, sample it live before designing the port; two hours of probes on one chat fixed the unit,
the k, the payload size and the model's actual second-hop behavior, none of which the leaked
schema alone settles. Third, add "does the audit read every channel the candidate uses?" to the
pre-mortem of any win; here it would have nulled a real result. Fourth, a window ladder or any
other harness enumeration is part of the instrument's validity range; state it in the
preregistration.

## 11 Open items and recommendations

Ordered by information gained per unit of effort.

1. **Sweep the two host constants offline** (zero live tokens, ~1 hour). Re-run
   `snippet-hits-killgate.mjs` over k ∈ {3, 5, 8} and excerpt ∈ {500, 1,000, 2,000} on the 56
   recorded queries; report literal-in-excerpt rate and payload tokens per cell. The excerpt size
   that recovers qo02 without exceeding a quarter of the headroom replaces the magic 1,000; a k
   derived from headroom ÷ excerpt cost replaces the magic 5 (algorithm.md rule 2).
2. **Re-cut the deep set for the referent, not the string** (zero live tokens). Add a gate that
   greps the tail at the claim window for events sharing the question's tool name and ≥ 60% of
   its argument n-grams; drop or rewrite qo05. Also re-cut `questions-overflow.json` at
   W = 131,072 (`--phase prep-overflow --window 131072`) so a second stratum exists.
3. **Retry once on the provider's empty turn** and persist the raw choice
   (`packages/core/src/models/openrouter.ts:187`). Epoch-shifting: land it, then re-run the
   iteration-3 pair once (50 rows, ~$0.30) so both arms are measured with the same denominator.
4. **Second model, same cell** (~$1-3): `deepseek/deepseek-v4-flash` and one Anthropic model
   on {tree-center-filename, tree-snippet-hits} at W = 131,072, n = 5. The claim "the hit should
   be the payload" is a claim about models reading excerpts; one flash model is not evidence of it.
5. **Port the unit into the library — DONE 2026-09-04 14:35 at the user's request, ahead of
   items 1 and 4.** `TreeRetriever.searchEvents` and `context_search` now return event hits;
   the two constants moved to `retrieval.eventHits` / `retrieval.excerptChars` (config, still
   host values). The port surfaced two defects the harness arm had hidden: shared events must be
   attributed to their most specific branch but ordered by the best containing rank, and pointer
   meta on an event hit re-inflates the payload (three queries reached 4,666-6,136 tokens until it
   was removed). The offline gate reproduces the arm (48/56, 53/56). Owed: one same-batch live
   confirmation of the shipped library at W = 131,072 (~$0.30) before quoting 15/25 for it.
6. **The system prompt as bytes** (~43 lines in the harness per analyzer A4, one batch ~$0.5):
   prepend a realistic operator prompt and raise W by its size; the control arm is the same
   size of inert text. This is the only way to learn whether the pad's content, not just its
   size, changes tool use.
7. **A longer trace** (~$30-50 to freeze per A2 §7) for W ≥ 200,000 in a real overflow regime.
   Without it every claim here is "proven at one 196k-token trace and one window".

Standing rules that governed this pass and bind the next: subagent roles run on
`claude-opus-4-6[1m]` (Workflow `agent()` with `model`, or the `ds-star-role` agent type after a
restart); experiments on GLM 5.3 Flash unless the variable is model-specific; run
`provenance-audit.mjs` before quoting any score; windows must be on the manifest ladder; the
user's simplicity rules in `reports/algorithm.md` (rules 1-7) apply to every constant introduced.
