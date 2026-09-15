# DV4 — Anchor-dedup: does replacing resident tool-result bytes with a referential anchor save tokens?

*Offline, deterministic, cache-priced. Four real Claude Code sessions.*
Artifact: `results-dv4-anchor-dedup.json` · Rerun: `node experiments/context-dedup/dv4-anchor-dedup.mjs`
Code: `experiments/context-dedup/{anchor-index,dv4-anchor-dedup}.mjs` · Tests: `anchor-index.test.mjs` (15/15 pass)

> **v2, after adversarial review.** v1 carried four defects that changed reported values, and one
> claim that was simply false. They are enumerated in *Defects corrected* at the foot of this
> report rather than quietly patched. The direction of the conclusion is unchanged; several
> magnitudes are not.

## Abstract

Transformer attention discounts tokens that are temporally distant and rarely referenced, and
logged agent sessions show a matching behaviour: an agent that needs content already in its
context re-reads the file instead of attending to the resident copy. The proposed intervention
intercepts such a request and returns a short referential **anchor**
(`Remember our earlier conversation about X`) instead of the bytes. Unlike eviction it is
strictly append-only — it declines to append rather than rewriting the cached prefix — so it
escapes the prefix-rewrite penalty (caveat C2) that makes most context reduction lose money
under prompt caching.

This report measures the **opportunity** only: an upper bound on what the policy could save,
with no model in the loop. Against the simulated prompt stream the policy saves **1.61%** of
cache-adjusted effective cost; rescaled onto what the four sessions **actually sent**, per their
own `message.usage` counters, the same absolute saving is **0.22%**. The pre-registered threshold
was 10%, so **F1's falsification condition is met and the token-savings claim is rejected** under
every denominator computed. The mechanism itself behaves exactly as predicted — the saving is
invariant across both cache write tiers, the signature of an operator that never mutates a
prefix. The prize is simply small, and it is small for a structural reason: the motivating
statistic is a *path* statistic that does not survive translation to content. Of 69 repeat reads
of an already-read path, 80% request a different slice and 51% follow an edit, leaving 8 (5.8% of
all reads) whose bytes an honest anchor could replace. The behavioural claim — whether a model
*accepts* an anchor — is a separate question, is not addressed here, and is not gated by this result.

## Definitions

### The two anchor policies

**`anchor-strict`** — substitute the anchor **only** where the resident copy is byte-truthful
*and* the file has not been edited since the matched block was captured. Formally, fire iff
`(content_exact ∨ content_contained) ∧ ¬edited_since_matched_block ∧ resident_verified`. This is
the provably-honest policy: everything the anchor asserts is true of the context as it stands.
It fires 43 times across the corpus.

**`anchor-diff`** — additionally substitute where the file *was* edited since capture, replacing
the content with the anchor **plus the model's own edit hunks**, which are themselves resident in
earlier tool-call arguments. The model is asked to reconstruct current state from
`resident read + resident edits`. Strictly more aggressive; covers the majority (edited) case at
the cost of requiring reconstruction rather than recall. It fires 56 times.

The distinction matters because a stale anchor is a **lie the context contradicts**, which is the
failure mode recorded in `report-readloop.md` ("Fix #1 — Nudge: FAILED… it fired 33× and the agent
ignored it") — that nudge ran under eviction, where the content was genuinely gone.
`anchor-strict` cannot reproduce that failure by construction. `anchor-diff` avoids it only if
reconstruction-from-diffs actually works, which is **untested**, and it is not a safe default: in
6 of its 56 fires the substitution is **larger** than the content it replaces, by up to 9.5×,
because `anchorDiffText` emits one unbounded hunk line per accumulated edit.

### The pre-registered falsification conditions

Set before any measurement, per house rule 5 (`reports/hypothesis-test-ladder.md:159`). F1 is
offline and is the only one this report can decide; F2–F5 need a model in the loop.

| # | Claim under test | Its falsification condition | Status |
|---|---|---|---|
| **F1** | **The prize is large enough to pursue.** Suppressing resident bytes materially cuts cost. | Pooled suppressible content is **< 10%** of total prompt tokens under cache-adjusted accounting. | **Condition MET → F1 rejected.** |
| **F2** | **The model accepts the anchor** rather than re-requesting the content. | Arm `anchor` "proceeded without re-requesting" is **< 70%**. Below that the anchor costs an extra turn *plus* the content anyway, and loses to baseline. | Not run. |
| **F3** | **Anchoring, not withholding, is the mechanism.** The *referential* content of the anchor is what does the work. | Arm `anchor` does not beat the length-matched non-referential `placebo` by **≥ 15pp** on acceptance or correctness. Then the effect is "withholding works", the summary machinery is unnecessary, and the *attention-anchoring* framing is retired. | Not run. |
| F4 | It saves tokens end-to-end in a live agent loop. | `total_prompt_tokens` reduction is inside the baseline arm's run-to-run noise band. | Not run. |
| F5 | It is safe. | Correctness on content-dependent actions drops **> 10pp** below baseline in any stratum. | Not run. |

F2 and F3 are the scientifically load-bearing pair: F2 asks whether the intervention works at all,
F3 whether it works *for the stated reason*. **F1 gates the cost argument only.** A policy can be
rejected by F1 (too little to save) and still pass F2/F3 (models do attend when anchored) — that
combination would be a real finding about attention with no deployment case.

**Which quantity was tested.** F1's wording ("suppressible content as a fraction of total prompt
tokens") admits three readings. All three are reported, and all three clear the bar by a wide
margin, so the verdict does not depend on the choice:

| reading | value |
|---|---|
| suppressed tokens ÷ simulated total prompt tokens | 0.0043% |
| suppressed tokens ÷ appended content tokens | 1.22% |
| effective-cost reduction ÷ simulated effective cost (**the headline**) | 1.61% |
| effective-cost reduction ÷ **logged** effective cost | **0.22%** |

## Method

Four **independent** fixtures: `claude-code-session{,-2,-3,-5}.jsonl`. `claude-code-session-4.jsonl`
is **excluded** — its 307 `message.id`s are 307/307 contained in session-5, so counting both
double-counts a third of the corpus.

Events are extracted on the `message.id` clock (not the JSONL line clock, which inflates 2.0–2.4×);
paths are keyed on the tail after `context-tree/` (fixtures were recorded on two machines). Each arm
replays the stream through `ProviderCacheSimulator` with `ANTHROPIC_PROFILE`, a `chars/4` tokenizer,
and Anthropic input multipliers `read 0.1×`, `fresh 1.0×`, `write 1.25×` (5-min tier) / `2.0×`
(1-hour tier). **Every arm is append-only**, so arms differ only in the size of blocks appended,
never in prefix shape — no arm pays a rewrite. All three arms share one classifier
(`anchor-index.mjs`), so they cannot diverge.

## Results

### 1. Cost — F1's condition is met

| arm | fires / would-fire | saved tokens | eff. cost (5-min) | (1-hour) | saving |
|---|---|---|---|---|---|
| `append-all` (baseline) | 0 / 56 | 0 | 28,027,311 | 28,721,825 | — |
| `anchor-strict` | 43 / 56 | 11,716 | 27,576,330 | 28,262,054 | **1.61% / 1.60%** |
| `anchor-diff` | 56 / 56 | 12,027 | 27,526,920 | 28,212,412 | **1.79% / 1.77%** |

The saving is essentially identical at both write tiers (1.61% vs 1.60%) — the signature of an
append-only operator, since there is no rewrite whose price could move with the tier. **The cache
reasoning behind the proposal is confirmed.** It does not rescue the magnitude.

**Do not rank the arms on the `anchor-diff` margin.** The +0.18pp is a position artefact, not
dominance: effective cost is position-weighted, so where a fire lands matters more than how much
it removes. On session-2, `anchor-diff` nets only 131 tokens removed against `anchor-strict`'s
1,369 and ends with a *larger* context, yet prices *cheaper*. The `chars/4` tokenizer cannot
resolve 0.18pp in any case.

**This result is not replicated across the corpus.** Per-session `anchor-strict` saving:

| session | saving | fires | saved tokens | share of pooled denominator |
|---|---|---|---|---|
| `claude-code-session.jsonl` | **0.00%** | 0 | 0 | 2.9% |
| `claude-code-session-2.jsonl` | 0.96% | 2 | 1,369 | 8.1% |
| `claude-code-session-3.jsonl` | **0.00%** | 0 | 0 | 0.1% |
| `claude-code-session-5.jsonl` | 1.74% | 8 | 10,065 | **88.9%** |

**Two of four sessions save nothing, and session-5 supplies 88% of the pooled saving.** The pooled
figure is a mean dominated by one unit — the failure mode caveat C0 warns about. Further, of the
truthfully-anchorable reads, four are the same file (`reports/hypothesis-test-ladder.md`): the
corpus is this project's own agent re-reading this project's planning markdown.

### 2. The simulated denominator is 7.4× too small — the real saving is ~0.22%

The fixtures record what the sessions actually sent, in `message.usage`:

| | simulated | logged in the fixtures | ratio |
|---|---|---|---|
| effective cost, 5-min tier | 28,027,311 | **206,197,748** | simulated = **0.136×** logged |

The simulator submits only on assistant *text* blocks and its prefix omits the system prompt, tool
schemas, user turns, thinking blocks, system-reminders and image payloads. Rescaling the **same
absolute saving** onto the logged accounting gives **0.22%**, not 1.61%. The headline should be
read as *"≈0.2% in reality, 1.6% against a reconstruction that is 7× too small."*

**No cache TTL is modelled** — the mechanism caveat C2 names as the one most likely to invert a
cache headline. The 1.61% arises from each saved token being re-charged on ~400 later submissions;
a TTL expiry that forces a full prefix re-write destroys that compounding.

### 3. Path statistic vs content statistic — the finding

Over 139 `Read` calls in the four independent sessions:

| | count | share |
|---|---|---|
| Read calls | 139 | — |
| first-read of a path | 70 | 50.4% of reads |
| **path-repeat** (path read before) | **69** | **49.6% of reads** |
| ── **ranged** (`offset`/`limit` present on the call) | 55 | 79.7% of repeats |
| ── **edited since the matched block** (resident copy stale) | 35 | 50.7% |
| ── content **exactly** matches a resident block | 6 | 8.7% |
| ── content **contained in** a resident block, same path | 13 | 18.8% |
| ── anchorable, no size floor | 9 | 13.0% |
| ── **truthfully anchorable** (≥200 chars, the policy's floor) | **8** | **11.6% of repeats · 5.8% of reads** |

`ranged` and `edited_since` overlap freely with everything. `exact` and `contained` are **disjoint
by construction** (`contained` is coded `!exact && …`), which is why 6 + 13 = 19 reconciles.

**This is the result.** Agents re-read *paths*, not *bytes*. Half of all reads are path-repeats —
close to the 59.2% that motivated this work — but half of those follow an edit that invalidates
the resident copy, and most of the rest are below the size at which anchoring pays. Only 5.8% of
reads carry bytes an honest anchor could replace.

**What `ranged` does and does not show.** `ranged` records that the *call* carried an
`offset`/`limit`, not that the *bytes* are new — a ranged re-read of an already-resident region is
exactly the `partial-overlap` case the policy is built to catch, and 6 of the 8 truthfully
anchorable reads are themselves ranged. Ranged-ness is **not** the mechanism by which the
opportunity dissolves. The real discriminators are **staleness** (35 of 69) and **size** (below the
floor, the ~190-char anchor costs more than the content it replaces).

### 4. Where the tokens are, and how far a ceiling claim can be pushed

Composition of appended content, and the duplicated share of each source under a block-granular
exact-plus-containment matcher at a 200-char floor:

| source | tokens | share of appended | duplicated | dup % |
|---|---|---|---|---|
| tool-call arguments (Write/Edit payloads) | 325,203 | 33.9% | 27,021 | 8.3% |
| other tool results (Bash, Grep, …) | 260,612 | 27.2% | 2,821 | 1.1% |
| assistant text | 197,178 | 20.5% | 0 | 0.0% |
| **read results** | 176,703 | **18.4%** | 19,276 | **10.9%** |
| **TOTAL** | **959,696** | 100% | **49,118** | **5.1%** |

A policy that dedups file reads is optimising the **fourth-largest** category.

**5.1% is one matcher's yield, not a bound.** Sensitivity over the same corpus:

| matcher | duplicated share |
|---|---|
| block-granular, exact + containment, ≥200 chars (the table above) | **5.1%** |
| same, no size floor | 6.6% |
| **line-granular** (suppress any line ≥20 chars seen anywhere in the session) | **19.0%** |

A line-granular referential encoder — an ordinary dedup design — reaches **19.0%, above the 10% F1
threshold**. v1 of this report claimed "no dedup policy of any design can exceed 5.1%"; that was
false and is withdrawn.

**A ceiling in these units cannot bound the headline anyway.** 5.1% is *duplicated content bytes ÷
appended content bytes*, a one-shot count; 1.61% is *cost reduction ÷ effective cost*, a cumulative
position-weighted count over ~400 re-submissions. A token removed early is un-charged on every
later submission, so the two are not commensurable — `anchor-strict` already removes 1.22% of
appended content while realising 1.61% of cost, an amplification of 1.3×.

## Conclusions

1. **F1's falsification condition is met; the token-savings claim is rejected.** The saving is
   1.61% against the simulated stream and **0.22%** against what the sessions actually sent. Under
   every denominator computed it is far below the 10% decision threshold. "Dramatically reduce
   token consumption" is not supported.

2. **The rejection is structural, not a tuning failure — but it is specific to this policy
   *shape*.** Block-granular referential dedup cannot get far on this corpus because the duplicated
   bytes are not there to take. A *line-granular* encoder reaches 19.0% and would clear the
   threshold, so the negative result should not be read as "no dedup design can work here"; it
   should be read as "*this* design cannot". Whether a line-granular scheme is safe to hand a model
   is an entirely separate and much harder question, and nothing here speaks to it.

3. **The cache argument was correct and is worth keeping.** Anchor-dedup is the one context
   reduction operator that never mutates the cached prefix, and the measurement confirms it: the
   saving is tier-invariant. Any future reduction operator should be built append-only for this
   reason. The reasoning survives even though this application of it does not.

4. **The motivating statistic was a path statistic.** "59.2% of reads are re-reads" measures path
   repetition; the content-level equivalent here is 5.8% of reads. Any future proposal resting on
   re-read frequency must state which it means. `duplicate-read-analysis.md` is already
   banner-marked superseded for arithmetic defects; this adds that its *framing* overstates the
   opportunity independently of those defects.

5. **The interesting question is untouched.** Whether a model attends to resident content when
   handed a referential anchor (F2), and whether the reference rather than the withholding does the
   work (F3), is a claim about attention, not cost. It is not decided here and is not gated by F1.
   Deciding it needs a model in the loop and a *synthesised* trigger, because only 8 natural ones exist.

6. **Compute the achievable maximum before setting a decision threshold.** Not because 10% was
   unreachable — it was not; the line-granular ceiling is 19.0% — but because the sensitivity spread
   (5.1% / 6.6% / 19.0%) should have been in hand before a single number was treated as decisive.

## Tested vs open

**Tested:** the size of the opportunity for block-granular referential dedup — offline,
cache-priced, four real sessions, deterministic (payload-identical across two runs excluding the
manifest's `run_id`/`date` timestamps).
**Open:** every behavioural claim (F2–F5); whether line-granular dedup is safe; whether any of this
survives a modelled cache TTL.

## Caveats

- **Four independent sessions, and effectively one.** `claude-code-session-4.jsonl` excluded
  (307/307 overlap with session-5). Of the four that remain, two save 0% and session-5 supplies 88%
  of the pooled result. This is n≈1 on the thing being measured — caveat C0 applies in full.
- **Corpus is self-referential.** Four of the truthfully-anchorable reads are the same file, this
  project's own `reports/hypothesis-test-ladder.md`.
- **The simulated denominator is 0.136× the logged one.** Percentages against it overstate the
  saving ~7×; `realism_check` in the artifact carries both.
- **No cache TTL is modelled** — C2's named inverter.
- **`chars/4` tokenizer**, not a real tokenizer. Ranks large differences; the 1.61-vs-1.79 gap is
  below what it resolves.
- **SIMULATED cache accounting**, not live provider counters. Same provenance class as C2/C3.
- **`resultText` drops image blocks.** Session-3 sent 23 PDF-page images (~4.7M base64 chars) that
  the composition table records as zero; counting them would lower the pooled ceiling further.
- **Corpus-specific.** Claude Code clips and manages tool output and its `Read` supports ranged
  access — which is *why* 80% of repeats are ranged. A harness without ranged reads would show a
  larger duplicate share. This does not generalise to all agent harnesses.
- **Upper bound on opportunity only.** It assumes every fire is accepted by the model at no cost.
  A deployment where anchors are sometimes rejected saves *less*, never more.
- **`residency_false_count = 0` is not evidence here.** Under an append-only replay the check
  cannot fail. The counter is designed for a live eviction harness; in this experiment it is
  tautological and should not be read as a passed test.
- `anchor-diff` assumes a model can reconstruct current file state from a resident read plus
  resident edit hunks. **Untested**, and it expands rather than shrinks the payload in 6 of 56 fires.

## Defects corrected since v1

| # | v1 claim | Defect | v2 |
|---|---|---|---|
| 1 | "edited since last read 37 (53.6%)"; "anchorable 7 (5.0% of reads)" | `corpusStats` pushed every `Write` into the edit set while *also* matching reads against that same `Write` payload — a file was marked stale by the very block making it fresh. Staleness also measured from the last read rather than the matched block. | 35 (50.7%); **8 (5.8% of reads)** |
| 2 | "the policy tests every tool result against all resident content"; "7 write-then-read fires are first reads" | Both false. Non-Read tool results bypassed the reducer entirely, making `bashReadTargets` dead code; and 5 of the 7 write-then-read fires were path-repeats. The "different bases" explanation papered over defect 1. | Non-Read results now routed through the index (would-fire 23 → 56); explanation withdrawn |
| 3 | "No dedup policy of any design can exceed 5.1%" | False. One matcher's yield presented as a bound. Line-granular reaches 19.0%, above the F1 threshold; the no-floor variant reaches 6.6%. | Sensitivity table published; claim withdrawn; conclusion 2 rewritten |
| 4 | "1.6–1.8% of cache-adjusted effective cost" | Denominator was a reconstruction 7.4× smaller than the sessions' own logged counters. | **0.22% vs logged**, 1.61% vs simulated; both reported |
| 5 | "across four independent sessions the policy saves 1.6–1.8%" | That was the spread across *arms and tiers*, not sessions. Two of four sessions save 0%; one supplies 88%. | Per-session table added |
| 6 | "four fifths ask for a different slice" (as the reason the opportunity dissolves) | Non-sequitur — `ranged` describes the call, not the bytes; 6 of 8 anchorables are themselves ranged. | Causal reading removed; staleness and size named as the real discriminators |
| 7 | "`anchor-diff` … nearly as large as the content it replaces" | Euphemism: it *expands* in 6 of 56 fires, up to 9.5×, via unbounded per-edit hunk lines. | Stated plainly; arms no longer ranked on the 0.18pp margin |
| 8 | "attributes, not a partition, and overlap" | False for `exact`/`contained`, which are disjoint by construction — the pair a reader would try to reconcile. | Corrected |
| 9 | Conclusion 6: threshold "above the theoretical ceiling … unfalsifiable in the wrong direction" | Premise false (19.0% > 10%) and the logic inverted — such a threshold is maximally falsifiable, not unfalsifiable. Also self-serving. | Rewritten as a point about computing sensitivity first |
| 10 | "F1 is met: the claim is falsified" | "F1 is met" asserts the claim holds — the opposite of the intent. | "F1's falsification condition is met; F1 is rejected" |
| 11 | `saved_tokens` compared normalized length to raw log contents | Latent off-by-a-few; benign only because these fixtures carry no line gutter. | Raw-to-raw |
| 12 | One "anchorable" read was a 101-char PDF status line (`docs/WA900.pdf`), whose real payload is megabytes of differing JPEG | `corpusStats` had no size floor, unlike the policy. | 200-char floor applied; both figures reported |
