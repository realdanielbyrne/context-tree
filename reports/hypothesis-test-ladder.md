# Test the untested hypotheses — one at a time, cheapest instrument first

> **Standing plan.** Companion report: `reports/metrics/harness-deletion-and-hypothesis-register-report.md`.
> Register confirmed complete by the operator 2026-09-09. Supersedes `docs/IMPLEMENTATION_PLAN.md`
> §15 (evaluation) per D20.

## START HERE — running this cold

You need no context from any prior session. Read this file, then §0 (settled facts) before
anything else — it lists the traps that cost two days.

```sh
cd /Users/danielbyrne/GitHub/rpm/context-tree
pnpm install && pnpm run typecheck && pnpm vitest run     # baseline: 692 passed | 9 skipped (701 total), 28 files

# Rung 0 needs no provider and no budget. Recover the question sets:
mkdir -p /tmp/ct-questions
for q in deep overflow; do
  git show 7d459f9^:eval/fixtures/transplant/s1/e1b289c32f40/questions-$q.json \
    > /tmp/ct-questions/questions-$q.json
done

# Rebuild the frozen store from the committed real session (4.6 MB, 645 model calls):
pnpm exec context-tree import packages/cli/test/fixtures/claude-code-session.jsonl \
  --from-claude-code --root /tmp/ct-store
```

**Then run Rung 0a.** Write the sweep as a script under `reports/metrics/<name>/` (not in
`packages/`; the product ships no experiment code — that is why the old `eval/` tree was deleted,
see D20). Import the offline primitives from `@context-tree/core`:
`extractFingerprints` and `summaryDocument` (`packages/core/src/retrieve/lexical.ts`),
`excerptAround` (`retrieve/excerpt.ts`), `detectAttentionSignals` (`attention/signals.ts`),
`buildTopicIndex`/`renderTopicIndex` (`attention/topic-index.ts`), `selectPayload`
(`attention/payload.ts`), `isRederivable` (`attention/rederive.ts`), `selectAttention`
(`attention/policy.ts`).

**Rules that are not negotiable:**
- **Never run at W = 32k–65k.** W = 131,072. §0/S1 for why — note the reason is that the tail
  covers the answers there, not that the cell is invalid; W=16k is the starvation cell.
- **Never put experiment code in `packages/`.** Scripts live beside their report under `reports/`.
- **Re-read every number from its raw artifact before quoting it** (standing provenance rule).
- **One variable per test.** §10/Q2.
- Graft's index may be stale after the harness deletion — if it names a path that is not on disk,
  `graft grep` the symbol instead of chasing the path.

## Context

Two days produced no tested hypothesis. The causes are known and recorded: a bespoke harness whose
`ChatMessage` could not represent tool calls (so every arm comparison was void), and before that,
three passes that measured inside a **starvation cell** — W=32k–65k, where a modern system prompt
alone is ~61k tokens — while believing they were measuring context policy.

The operator's constraints on this work, stated directly:
- **"Small, short tests that test that specific hypothesis under test is what we need. Then we can
  intelligently combine the techniques."** Testing twelve mechanisms at once yields one number and
  no attribution. One variable per test; combine afterwards, informed by which carried an effect.
- **"It is more important to err on more context than less context. That is the idea behind top-k
  relevance, DSA, ie the idea behind this whole experiment."** Eviction is conservative by
  construction; the ejection trigger is topic shift, not budget pressure.
- **"We need results."**

What makes this tractable now: opencode exposes `experimental.chat.messages.transform` — a mutable
`output.messages` — verified present in the shipped 1.18.27 binary. That is full control of the
prompt with none of the tool-calling risk, because opencode owns that representation on both sides
of the hook. And several hypotheses need no provider at all.

**The intended outcome of the FIRST session of work is a number, not a plan.** Several tests below
run at zero model cost.

**This file is a PLAN. It carries no results.** Measurements live in the companion report. Where a
prior measurement constrains a test's design, it appears only in §0 (settled facts) as a
constraint — never as a finding of this plan.

---

## THE LADDER — ordered by information gained per unit of cost

Each rung: one hypothesis, one variable, a falsification condition fixed before the run.

### Rung 0 — runnable immediately, ZERO or near-zero model calls

Everything these need survived the harness deletion.

| asset | path |
| --- | --- |
| **1,073 real Claude Code sessions, 1.0 GB** — 109 with ≥100 tool calls | `/Users/danielbyrne/.claude/projects/**/*.jsonl` |
| real 645-call session, 4.6 MB (committed) | `packages/cli/test/fixtures/claude-code-session.jsonl` |
| **22-query corpus** — `questions.json` 12 + `questions-deep.json` 5 + `questions-overflow.json` 5, and **all 22 carry `answer_literals`/`answer_regexes` AND `source_context`/`wide_context` payload text inline**, so 0a and 0c run from `git show` with no store rebuild. A further 17 entries (`literals.json` 9, `literals-overflow.json` 8) carry answers but **no** inline payload — those need the store. | `git show 7d459f9^:eval/fixtures/transplant/s1/e1b289c32f40/questions.json` (then `questions-deep.json`, `questions-overflow.json`, `literals.json`, `literals-overflow.json` — one path per command; **do not** use `questions-{,deep,overflow}.json`, whose brace expansion yields the nonexistent `questions-.json`) |
| fingerprints, excerpting, signals, topic index | `packages/core/src/retrieve/{lexical,excerpt}.ts`, `packages/core/src/attention/{signals,topic-index}.ts` |
| store rebuild | `context-tree import <transcript> --from-claude-code` |

**Two corpus facts that change what is cheap.**
- **The overflow regime corpus now exists.** §8 listed "the overflow regime itself — no trace in the
  repo has ever reached it" as an open item. **That item is retired.** Of the 1,073 real sessions:
  **109 have ≥100 tool calls**, 55 exceed 131,072 estimated content tokens, 18 exceed 262,144, and
  2 exceed 1,048,576 (max ≈4.38M estimated tokens over 788 tool calls). `packages/cli/src/claude-code.ts`
  is the shipped importer for exactly this format, so any of them becomes an L0/L2 store today.
- **The s1 store is gone but its queries are not.** `trace.src.jsonl` and the derived store were
  never committed and died with `eval/` at `7d459f9`. The question rows survive in git **with their
  payload text inline**, so **D-a's sweep runs from `git show` alone, no store rebuild.**

**0a. D-a — the excerpt window (hand-off item 1's first named defect).**
Claim: qo02's answer literal sits outside 1,000 characters of a correctly ranked event, so the
retrieval unit's excerpt is the defect — not the ranking.
Sweep, offline: every recorded query × `excerptChars` ∈ {500, 1000, 2000, 4000} × anchor ∈
{first, rarest-matched-term, matched-line-span}. Metric: **fraction of queries whose
`answer_literals` appear inside the excerpt.**
*Falsifies if:* literal-present rate at `excerptChars=1000, anchor=first` is already ≥90% — then
the excerpt window is not the defect and hand-off item 1a is closed.
*Note the trap this avoids:* yesterday's version of this sweep reported "rarest changed 0 of 15
selections" — but all 15 payloads had `terms: []`, no query fingerprints at all. That null was
degenerate. These question files carry the terms.

**0b. HR3 / H4 — the model's own signals. BUILD THE DETECTOR THE DESIGN ALREADY SPECIFIED.**

**Do not sweep a bigger regex list. A lexical matcher cannot work here in principle.** An LLM is
probabilistic, not deterministic; every model phrases sufficiency differently; and "I have what I
need" is a *semantic* state, not a string. Any regex list is a sample of one author's guesses about
phrasing.

**The shipped `detectAttentionSignals` is a deviation from the design, and measuring it is not a
test of H4.** §14 specified the instrument
(`reports/metrics/window-regime-and-retrieval-unit-report.md:655-659`):

> "Detect them (**a small classifier over assistant text is enough to start**; log the phrases
> first, zero live tokens, from the recorded runs) … detect topic shift the same way (**a turn whose
> content words share little with the previous n turns**)"

"Log the phrases first" was a **preliminary look at the corpus**, not the detector. What shipped
was four regexes — the preliminary step mistaken for the instrument. So any fire-rate number for
those regexes reports on a mis-implementation, not on the hypothesis. (One such number was measured
and is recorded in the companion report solely as evidence that the shipped code cannot fire, so
nothing downstream of it could ever have worked. It is not evidence about H4.)

**The two sub-signals have different right instruments, and only one needs a model.**

- **Topic shift — deterministic, no model.** §14 already gives the measure: a turn whose content
  words share little with the previous *n* turns. Compute fingerprint Jaccard (`extractFingerprints`)
  between turn *t*'s tool inputs and turns *t−n…t−1*, and flag a drop against that session's own
  baseline. Validate against a **within-session permutation null**.
  *Falsifies if:* flagged boundaries show a forward-overlap drop < 0.5 SD below session baseline —
  i.e. the measure does not separate a real shift from an arbitrary turn boundary.
- **Sufficiency — needs semantic judgment, so a model.** A small adjacent classifier reads the
  assistant turn and answers one question: *does this turn assert it has what it needs to proceed?*
  Cheapest first: a cheap-model call per turn on a sampled subset, or a local sentiment/NLI-style
  classifier if per-turn cost matters at corpus scale. Ground truth comes from a hand-labelled
  sample of real turns, not from a phrase list.
  *Falsifies if:* the classifier cannot beat a majority-class baseline on held-out hand-labelled
  turns — then sufficiency is not reliably detectable from assistant text and H4's sufficiency half
  is dead as a signal.

  **THE STOPPING RULE — fix this before building the instrument, and do not renegotiate it after
  seeing the result.** "The detector failed" always admits a stronger detector: a regex fails → try
  a classifier; the classifier fails → try a bigger model. Without a pre-committed threshold H4 can
  absorb unlimited null results and never be wrong, which is exactly how four regexes came to look
  like a result about a hypothesis. So: **one cheap-model binary judgment per assistant turn,
  prompted with §14's own definition, scored against 200 hand-labelled turns sampled from the
  1,073-session corpus. If it cannot reach κ ≥ 0.6 against those labels, the sufficiency half of
  H4/HR3 is RETIRED, not iterated** — the conclusion being that the signal is not reliably present
  in assistant text, not that a better detector is owed. Retiring it does not touch the topic-shift
  half, which is deterministic and stands or falls on its own condition above.

**Standing constraint, unchanged:** a sufficiency signal is evidence for **reassessment**, never
permission, and never an irrelevance label. The instrument must not encode it as one.

**Cost.** Topic-shift half: zero model calls. Sufficiency half: a hand-labelled sample plus cheap
classifier calls over that sample — still far below any live agentic batch. **A live test of
H4/HR3 is wasted until a detector clears its falsification condition above.**

**0c. Retrieval-unit constants — `eventHits=5`, `excerptChars=1000`, `retrieval.limit=20`.**
All three are unvalidated values copied from a published interface. Same sweep harness as 0a.
Metric: answer-present rate vs total tokens returned, per (hits × chars × limit).
*Produces:* a derivation — hits and chars as functions of headroom and event size — replacing three
magic numbers. Also tests the recorded untested direction: **shrinking** the hit list, not enriching
it (enriching is refuted: +32% tokens, no selection change).

### Rung 1 — single-turn probes, cheap live

**1a. HZ — Zone B as an index, endpoint = retrieval success rate.**
The reframe: a summary's job is to tell the model it once worked on X so it can go find X. Zone B
measuring inert on literal recall (15/25 vs 16/25) is *correct behaviour for an index* and was
misread as failure. Cost already measured: 142 tokens indexes a 645-call session, 56× cheaper than
the 8,000-token Zone B budget. Efficacy never measured.
Probe: give the model the topic index and a question whose answer is NOT in the index. Measure
whether it issues a search naming the right identifiers. Control: same question, no index.
*Metric:* correct-search rate, not answer rate.

**1b. HR1 — is the retrieval unit wrong for structural turns?**
The register's competing explanation for `prefix-retrieval`'s **0/3 on sw-2**: the tool returns 5
events × 1,000-char excerpts, tuned for literal lookup, when a multi-step task needs file/tree
structure and API surfaces — so the model probes with `run_command` instead. The record pursued
only the ledger explanation (D-b). **These must be ablated separately.**
Probe: structural questions ("which files implement X and how do they connect") vs fact questions,
against excerpt-unit vs whole-structural-payload retrieval.

### Rung 2 — short live tasks, ~10–40 turns, W = 131,072

Needs the opencode plugin (below). One hypothesis per arm, each against the same control.

**2z. RUN THIS FIRST — re-run step8-sonnet on opencode.** It is the *only* existing head-to-head and
it is void for a known reason (S4/S6), so it is the cheapest live result available and it settles
whether the programme has a cost case at all.
Design: replicate the recorded cell exactly — arms `native` / `context-tree` / `prefix-retrieval`,
scenarios `sw-1-jsonc` and `sw-2-multimod`, n=3 each, **18 runs**, real Sonnet 5, graded by the same
test suite. The artifacts to reproduce are
`reports/metrics/window-regime-and-retrieval-unit/step8-sonnet/results-r{1,2,3}.json`.
Recorded (void) values to beat: `native` **6/6** at $0.1863/run mean; `context-tree` **6/6** at
$0.5751/run; `prefix-retrieval` **3/6** at $0.3480/run, with all three `sw-2` losses stalling in
consecutive `run_command` tails.
*Falsifies the cost case if:* on a working harness `native` still matches on success while costing
materially less. **That is a real refutation and must be accepted as one, not re-explained.**
*Falsifies the void-ness claim if:* `prefix-retrieval` reproduces 3/6 with the same stall
signature — meaning the tool-call eviction was never the cause and the retrieval unit itself is.
Note this is the one place a *combined* arm is legitimate: `context-tree` is the shipped product, not
a single mechanism. Every other rung keeps one variable.

- **H1** — needs the three-phase non-monotonic scenario §15 specified and nobody built: edit an API
  → do unrelated work → need the API again. Falsifies if evicting the dormant phase costs success.
- **H3** — pin the plan artifact vs not; measure whether the model re-derives steps.
- **H6** — anchor n ∈ {exchange, subtask, all}.
- **D-b** — the completed-steps ledger, ablated against **HR1**, since both explain the same 0/3.
- **evictRederivable** — gate already passed offline: 63.7% of trace tokens eligible, 36.3%
  structurally protected; fires at every cadence.
- **HU / priority** — needs reference edges to exist; offline gate showed priority replaces 26 of
  45 admitted units, and that `boost`/`halfLifeTurns` are **inert in the zero-relevance limit**, so
  this arm requires query fingerprints to be present or it measures nothing.

### Rung 3 — long live tasks, only where genuinely required

- **HA — soft target.** Reinterpreted per the operator: `f` is a **floor below which we never
  evict**, not a level to hold. Requires a session that exceeds the floor.
- **HU end-to-end**, and **the score hypothesis** — that a shorter, better-curated context makes
  the model *reason better*. No lens ever refuted it; no experiment ever tested it. This is the
  endpoint that can vindicate the programme, and every measurement so far argued cost instead.
- Corpus: **23 zero-LFS `continue_until_timeout` LHTB tasks at ≥240 expert-minutes** (gates already
  passed: pristine 0.0 / reference 1.0). `vector-db-iterative-build` (360 min) and
  `duckdb-optimizer-closure` (300 min) are the strongest — iterative, code-heavy, no multimodal
  dependency.

---

## The instrument for rungs 2–3: an opencode plugin

Not a fork. Verified in the shipped 1.18.27 binary.

| hook | used for |
| --- | --- |
| `experimental.chat.messages.transform` (`output.messages` mutable) | the prompt: admission, eviction, ledger injection, Zone B substitution, layout R |
| `experimental.chat.system.transform` (`output.system: string[]`) | Zone A — and **protecting** it |
| `tool.execute.after` | retrieval payloads: HR1, HR2, D-a, H5 |
| `chat.message` | observe assistant text → H4/HR3 signals |
| `experimental.session.compacting` / `.compaction.autocontinue` | disable opencode's own compaction so it is not a confound |
| `tool.definition` | Zone A tool-schema size (Mode B's claim) |

Arms are `PluginOptions` objects on one plugin: `plugin: [["@context-tree/opencode", {…}]]`.
Consumes the orphaned `packages/core/src/attention/*` and `ZoneAssembler`, which currently have
zero production callers.

### Two seam facts, read from the shipped 1.18.27 binary — get these wrong and the batch is void

`SessionPrompt.run`, verbatim:
```js
yield* d.trigger("experimental.chat.messages.transform", {}, { messages: C });
let [ae,Fe,Ue,ko,is] = yield* s.all([z.skills(Y), z.environment(Z), K.system(), z.mcp(…), …]);
```

**F1. The trigger's return value is DISCARDED. Only IN-PLACE mutation of the array is observable.**
`output.messages = [...]` rebinds a property on a throwaway object and **silently no-ops** — and an
arm that no-ops reads as a null result, which is exactly the S4 failure class recurring through a
new seam. Mutate with `splice`/`length`, and **assert with a unit test that a mutation inside the
hook is visible to the caller.** This is gate 0.

**F2. Zone A is assembled AFTER the transform**, so `z.skills` / `z.environment` / `K.system` /
`z.mcp` are out of the message hook's reach. **S2's failure mode — evicting the system prompt,
steering, or skills — is structurally impossible through this seam.** That is good news and it means
pin-protection for those categories needs no code; only task statement and plan artifacts (which
*are* messages) need explicit pinning.

**F3. opencode's own compaction must be disabled AND recorded as disabled in every live arm.**
`SessionCompaction` defaults `preserve_recent_tokens ?? min(…, floor(context * 0.25))` and its
`prune` mutates `state.time.compacted` on tool parts. Left on, a live arm measures opencode's
policy, not ours — and that 0.25 is a **direct confound for HA**, whose whole subject is the
occupancy fraction. Set `experimental.compaction.autocontinue` → false, disable prune, and record
both in the run manifest.

**F4. `Model.limit.output` and `Model.limit.context` are host-declared** and reachable in
`experimental.chat.system.transform`'s input — which **retires the reply-fraction sweep by fact**:
the reserve is `limit.output`, not a fitted `0.05·W`. The residual testable question is whether
`output + reasoning` ever exceeds `limit.output` (reasoning tokens are charged on top), measurable
offline from the corpus's `output_tokens_details.thinking_tokens`.

**Mandatory gates before any live batch.**
0. **Mutation visibility (F1).** A unit test proving an in-place edit inside
   `experimental.chat.messages.transform` reaches the provider call. Without this, every arm may be
   silently inert.
1. **Tool-call fidelity.** Assert no transform drops a `ToolPart` while keeping the assistant text
   that announced it, and never orphans a result from its call. This is the exact bug that voided
   two days; it becomes a unit test.
2. **Pin protection.** Task statement and plan artifacts pinned explicitly. System prompt, steering
   and skills need no guard — F2 puts them out of reach.
3. **Compaction off and recorded (F3).**
4. **Mechanism fires.** Offline, on a recorded trace: confirm the arm's mechanism does something
   non-zero. An arm byte-identical to its control must never be written up as a failed hypothesis —
   and note the inverse trap: yesterday a gate reported an arm "inert" because the gate itself
   supplied no reference edges. **A mechanism-can-fire gate must be fed the inputs the live path
   builds.**
5. **W = 131,072.** Never 32k–65k. The plugin is the window enforcer, so W is an arm parameter and
   every arm shares one budget-enforcement code path — removing a confound the old arms had.
6. **Non-completed run scores `null`, never 0.** A token win with any success regression is a
   **regression**, not a tradeoff.

---

## Verification

- **Rung 0** — a table of numbers per sweep cell, committed under `reports/metrics/`. No provider
  touched. Each cell's falsification condition evaluated explicitly.
- **Rung 1–3** — `opencode export <sessionID>` gives per-assistant-message
  `tokens: {input, output, reasoning, cache:{read,write}}`, so token accounting needs no
  instrumentation. Task success from the LHTB verifier (separate container, artifacts-list
  contract — no git-commit requirement, so an external agent grades cleanly).
- **Every reported score** re-read from the raw artifact before being quoted, per the standing
  provenance rule.

---

# REFERENCE — the complete untested-hypothesis register

The operator confirmed this list complete. It is the source for every rung above.

---

## 0. Settled facts — a new agent must NOT re-derive or re-run these

These are the traps I walked into today. Each is measured and closed.

**S1. Do not sweep small windows — but the three small-window cells failed for three different
reasons, and only one is an artifact.** Claude Fable 5.1's production system prompt is **274,608
chars = 60,903 cl100k tokens**, so at W=65k there is effectively no room for anything else. That
arithmetic is right; applying it to every recorded small-window negative was not.

| Cell | What happened | Status |
| --- | --- | --- |
| **W=16,384** (`minimum-window-boundary`) | Zone A + Zone B + one search exceeds W; 57/60 stalls | **Artifact.** A dead cell. |
| **W=32,768–65,536** (`live-verification-findings`) | truncate-tail 11/60 vs tree-tail-v2 2–4/60, on **Haiku 4.5** (partly Sonnet 5), *not* Fable. Recorded cause: **tool overhead** — each search/fetch turn adds ~5–10K tokens the tail arm spends on raw events. "Showing more raw content beats navigating to it at these window sizes." | **A real negative.** Not starvation. The design still has to answer it. |
| **Fable at W=65,536** | Prompt alone is 60,903 tokens | **True but hypothetical** — describes a deployment, not any experiment above. |

*The valid realistic-host cell is W = 131,072* (a 200k host minus a Fable-sized prompt). W=200k is
NOT an overflow test on the s1 store (4/5 answers sit in the tail).
→ **The reason not to re-sweep 32–65K is that the tail already covers the answers there**, so a
sweep re-measures a known negative. It is *not* that the cell is invalid. Read
`live-verification-findings.md:11-16` before touching this — it names the model and the mechanism,
and an earlier draft of this plan reclassified it away on arithmetic about a model it never ran.

**S2. What was being evicted at small W was the wrong thing.** Portions of the system prompt, the
agent steering files (CLAUDE.md), plan files, and skills were being evicted. Those are precisely
the always-pinned category. A policy that evicts them is not being tested — it is being broken.

**S3. Refuted repairs — do not retry.**
- Recency-only eviction: keep-last-1 breaks **62%** of the run's `edit_file` calls; keep-last-10
  still breaks 21%. The longest-lived units are the *earliest and smallest*.
- Zone B prose enrichment (`tree-hit-keywords`): **+32% input tokens, no change in selection**,
  2× stalls. Fired on 25/25 runs, so a real refutation.
- Multi-index RRF fusion: **6/17** against **9/17** for routing to the best single index.
- Compact coordinate display: retired — made the rank-7 correct branch illegible, distractor
  fetched 5/5.
- Showing the model *more* Zone B prose.

**S4. Every live arm comparison from the deleted harness is void.** `ChatMessage` had no
`tool_calls` field and no `'tool'` role, so the harness stripped the model's own tool calls from its
history. Measured: 13-message request carried **0** assistant messages with `tool_calls` and **0**
`role: 'tool'` messages. Offline analyses (occupancy, re-send multipliers, cache economics) survive;
anything that ran the loop does not.

**S5. Instrument defects to fix before any batch.** qo05 has a non-unique referent (distractor
decay — 14/15 tree runs answer it without searching); GLM empty-turn provider failures (11/50, 4/25,
4/25) were kept in denominators; `provenance-audit` did not read the search channel; per-run
transcripts were not persisted. **Add one rule:** a probe whose number will be quoted must write its
output under `reports/metrics/` *before* the number is used — six figures in the companion report
are unverifiable for exactly this reason.

**S6. A head-to-head comparison already exists, it is void, and it favoured doing nothing.** Do not
write "we have never compared the arms." `reports/metrics/window-regime-and-retrieval-unit/step8-sonnet/`
holds 18 runs on real Sonnet 5: `native` **6/6** at $0.1863/run, `context-tree` **6/6** at
$0.5751/run, `prefix-retrieval` **3/6** at $0.3480/run. It ran on the deleted harness, so S4 voids
it — and not evenly: under the stripping, the tail arm keeps prior work as raw text while the
retrieval arm loses both the call and the content it replaced, which is why the stalls cluster there.
**Rung 2z re-runs it and it is the first live test to spend money on.** Treat the recorded numbers as
the target to beat, not as a result.

**S7. Ejection cannot pay for itself per turn on Anthropic.** `cacheRead = 0.1×` and
`cacheWrite = 1.25×` input (`packages/core/src/models/cost.ts:45-48` — a property of the price table,
not a measurement), so invalidating a cached prefix to save a `keep` fraction breaks even only after
`turns = w·keep / (r·(1−keep))`: **12.5 turns at keep=0.5**, 29 at 0.7, 112 at 0.9 — re-paid every
time the eviction fires. **The per-turn forms of H1, H2, H5 and the per-turn admission loop are dead
as cost propositions**; they survive as *success* propositions, or at cadences of tens of turns.
Corollary: every OpenRouter number in the record flatters ejection, because a provider publishing
`cacheWrite: 0` charges nothing for the dominant term.

**S8. The honest baseline is source-side hygiene, not naive full history.** Dropping the write echo
and capping tool-result bodies at 2,000 tokens cuts prompt volume **−31%** with **zero cache
invalidation**, because it changes what enters the prefix rather than rewriting it
(`reports/metrics/attention-policy-continuation/journal.md:732,801`). That is the same order as what
the attention policies are meant to deliver, at none of the cache cost. **An arm that beats naive
history but not hygiene has not earned its complexity** — so hygiene belongs in the control, not the
comparison.

**S9. The soft target's mechanism fires in real use; the corpus was the defect.** Operator
`/context` on Opus 5 (1M window): **37% occupancy after one prompt, 56% after two**
(`reports/algorithm.md:88-89`, 2026-09-08), against a median 1.25% of window across the harness
corpus. HA was recorded untestable on the strength of that corpus, which was ~10× too short. Do not
re-derive "nothing reaches 25% of a window" from the old corpus.

---

## 1. THE UMBRELLA HYPOTHESIS

**HU. Attention over history.** Prioritisation of history is a metric parallel to contextual
relevance, and priorities change. If we limit context growth by ejecting inconsequential
contextual data, we save tokens without losing task success. Cumulative consumption is quadratic in
turn count (every turn re-sends the prefix), so the saving compounds on long sessions.
**Status: NEVER TESTED.** Its stated premise ("growth is exponential") was mis-refuted by me — I
fitted per-turn prompt length (linear) against a claim about cumulative consumption (quadratic).
Nothing was refuted.

Encoded (§15) as **two channels per unit per turn**:
- **relevance** — query-dependent; the turn's fingerprints against the unit's. This is what
  `context_search` already scores (the query·key term).
- **priority** — query-independent state carried across turns: how much the unit has mattered and
  is likely to again (the bias term). Derived from L0 only: +boost on fetch/edit, decay with turns
  since last reference, 0 on `superseded_by`, dormant reset on topic shift.
- Admission ranks by relevance + priority, admits until a target is reached; **pinned units (task,
  plan, steering) admitted before ranking.**
- Categories as coarse prior: **pinned** {task, plan, steering} · **active** (current phase) ·
  **dormant-but-recurring** (the earlier API edit during UI work) · **unrelated** (evicted).
- **Breadth by relevance MASS, not count** (nucleus-style p), bounded by the target. `p` replaces
  every `k`.
- **Audit trail**: one appended row per turn per unit — relevance, priority, category, admitted.

---

## 2. THE SIX NAMED HYPOTHESES (§14, set by the operator 2026-09-05)

All six: **NEVER TESTED.** Recorded blocker for every one was `eligible: false, status:
missing_labels`.

| ID | Claim | Recorded blocker (verbatim) |
| --- | --- | --- |
| **H1** | Attend only to what bears on the turn. Dropping history that does not bear on the current turn should not cost task success and should save the tokens tail arms spend re-reading it. Relevance over a long horizon is **non-monotonic**: an early API edit is irrelevant during UI work and relevant again during unit tests. | "current-turn grounded irrelevance labels"; "independently judged recurring evidence after exclusion" |
| **H2** | **Breadth follows the horizon.** A fact-finding turn should retrieve one event; a planning turn an overview of the whole task; a multi-file edit the files, APIs and instructions it touches. Size the retrieval fill per turn type instead of one k for every turn. | "complete candidate relevance mass"; "known exposed positive and negative useful-evidence labels"; "held-out session/scenario split" |
| **H3** | **The plan artifact is always in context.** A plan written before implementation belongs in every turn of that implementation, like the task statement and the operator's steering. | "typed source-linked active plan artifact"; "same-epoch plan-only ablation" |
| **H4** | **The model's own signals gate retrieval.** Statements like *"I have enough information to implement X"* and *"now let's look at Y"* are already how the model paces its discovery. Detect them and use them to stop adding exploratory context and to move the top-k breakpoint; detect topic shift the same way and use it to evict dormant history. | "labeled true/false sufficiency and topic-shift examples"; "causal usefulness labels; identifier overlap is observational" |
| **H5** | **Dynamic top-k under headroom.** When headroom exists the breakpoint moves: retrieval widens toward the target rather than stopping at a fixed k, and narrows back once the turn's results are seen. | "explicit demand/envelope labels"; "H2 setting frozen before demand-only comparison" |
| **H6** | **The last n turns are the anchor.** Whatever else is evicted, the model's most recent exchanges stay; n must cover the whole current sub-task, not only the last exchange. | "source-linked current-subtask boundaries"; "exchange/subtask/all ablations at equal n" |

**Critical note on those blockers.** They conflate two different questions:
- *"Is the policy's relevance judgment correct?"* — needs ground-truth labels. Hard.
- *"Does the policy help?"* — needs only the policy to RUN and the outcome measured. **No labels.**
The hypotheses are the second question. The previous pass blocked itself by insisting on validating
the intermediate signal before ever measuring the outcome. `selectAttention` refuses to infer labels
by design ("No live host inference invents missing relevance, plan, or reference labels") — which is
correct for the product and fatal for the experiment unless the experiment measures outcomes.

**H4 detector status:** `detectAttentionSignals` is implemented and fired **0 times across 19 real
agent responses** on two public tasks. That is a null result for *that phrase list on that corpus*,
not for the hypothesis. The operator's framing is explicit that a sufficiency phrase is **evidence
for reassessment, never permission or an irrelevance label.**

---

## 3. THE OPERATOR'S HYPOTHESES FROM THIS CONVERSATION THAT I DROPPED

I skipped these. They are first-class, not addenda.

**HR1. The retrieval tool is optimised for FACT retrieval, not structural context — and that, not
a missing ledger, may be why multi-step tasks starved.**
`context_search` returns the 5 best-matching *events* with a **1,000-character excerpt** each. That
is tuned for "find the literal." A multi-step coding task needs **broader contextual data — file
and tree structure, module layout, API surfaces** — which a 1,000-char event excerpt cannot carry.
So `prefix-retrieval`'s **0/3 on sw-2** (run-command loops with 90–100k tokens of headroom) has at
least two competing explanations and the record only pursued one:
- (a) no ledger of completed steps → the model re-investigates
- (b) **the retrieval unit is wrong for the turn type** → the model never gets structure, so it
  probes with `run_command` instead
These must be **ablated separately.** I asserted (a) as *the* defect; that was unjustified.
**Status: NEVER TESTED.** Note this is H2 ("breadth follows the horizon") instantiated concretely —
a planning/edit turn needs a different retrieval unit than a fact turn.

**HR2. Keep the FULL results of context-retrieval tool calls in context.**
For structural tools (graft, tree/file listings, `context_search` results), preserve the **whole
payload** rather than an excerpt. Rationale: excerpting a structural result destroys the structure,
which is the thing being retrieved. This is distinct from `selectPayload`'s whole-vs-excerpt on
*file reads* — it is about retrieval/structural results specifically.
**Status: NEVER TESTED live.** Offline: whole vs excerpt is the one measurable payload intervention
found (15 file payloads, whole = 24,577 tok vs 1,000-char excerpt = 3,597 tok, **14.6%**);
structural selection was `unsupported_structure` on 15/15 (no verified partition exists).

**HR3. Model-signal-keyed retention (the operator's own framing of H4).**
When a model researches and then says *"I have enough data to continue"*, that is a signal we can
key off — both to stop adding exploratory context and to decide what to RETAIN. Also its inverse:
a topic shift is a signal to release dormant history.
**Status: NEVER TESTED.** See H4 above; the detector exists and has never run against a corpus
where it fires.

---

## 4. THE SOFT OCCUPANCY TARGET

**HA. Soft target window.** Operate at a soft target of **25–50% of W_max**, with overruns allowed
per turn and eviction back to target once results are seen. `f` to be **measured, not set**.
**Status: NEVER TESTED. Not withdrawn and not rejected** — the operator clarified it is not a hard
requirement, which is not the same as withdrawing it. I recorded it as "withdrawn by the user" in
`algorithm.md` and the report; that was a mischaracterisation and is corrected.
Notes:
- Expressed as a fraction of the **window** it was untestable on every trace available (nothing
  reached 25% of a real window from task demand). Expressed as a fraction of **measured demand** it
  is the right axis.
- Related unmeasured half: *filling* unused space up to the target, and *pruning* early history to
  hold it, are both testable arms, not rules.
- The design that scored **25/25** (`prefix-plus-retrieval`) already runs at **15–30% of W** and
  grows only when a turn needs it — i.e. the soft target is close to an already-winning arm's
  emergent behaviour, which has never been isolated as a variable.

---

## 5. THE HAND-OFF QUEUE (§13) — ordered, and where the loop was supposed to start

1. **`prefix-plus-retrieval`** — the Q&A leader (**25/25**, median 1 turn, 20/25 with no tool call,
   zero provider empty-turn failures) and the operator's own design. Two named open defects:
   - **D-a. Excerpt window.** qo02's literal sits **outside 1,000 characters** of a correctly
     ranked event. Iterate: excerpt centred on the **rarest matched term**, or on the **matched
     line span**. *(Offline: first-vs-rarest anchoring changed 0 of 15 selections — but every one
     of those 15 payloads had `terms: []`, i.e. no query fingerprints, so that null is DEGENERATE,
     not a refutation.)*
   - **D-b. No ledger of completed steps.** sw-2 **0/3**, stalling in 4–6 consecutive
     `run_command` turns with 90–100k tokens of headroom. Iterate: a running "done so far" ledger
     inside the recency slice (branch summaries are the obvious source).
     **See HR1 — (b) is a competing explanation for the same failure and must be ablated.**
   - Then the soft target `f` of §12.
2. **Per-turn window management** (eviction shipped in core) — "the mechanism any design runs on."
   Iterate: the soft target; and **layout R** — tail rendered **newest-first** so eviction is a
   suffix cut and write-free. *(Layout R: NEVER TESTED.)*
3. **Event-hit `context_search`** (shipped) — the unit. **`retrieval.eventHits = 5` and
   `retrieval.excerptChars = 1000` are host values from the published interface, unvalidated here.**
   Iterate: sweep both offline on the 22 payload-carrying queries, then **derive them from headroom and
   event size** rather than fixing them.
4. **Zone B** — demoted from retrieval to two candidate roles, **both unmeasured**: (i) a **task
   ledger** on multi-step work, (ii) **cache-shape** on long sessions. "Do not tune its ranking
   further; the deep set cannot see it."

---

## 6. ZONE B, RE-SPECIFIED BY THE OPERATOR

**HZ. Zone B is an INDEX, not content.** A summary's only job is to tell the model it once worked on
X so it can go find X with `context_search`. It is a pointer; it must never be expected to answer
from itself.
- This **reinterprets** the existing result rather than contradicting it: Zone B measuring **inert**
  on literal recall (`flat-events` 15/25 vs 16/25 with Zone B present) is *correct behaviour for an
  index*, and was previously read as a failure.
- Therefore the endpoint changes: **does Zone B raise the rate of successful retrieval**, not can
  the model answer from Zone B.
- Implemented as `buildTopicIndex`/`renderTopicIndex`. **Cost measured: 142 tokens indexes a whole
  49-turn session, 56× cheaper than the 8,000-token Zone B budget, 0.19% of that run's peak
  context. Efficacy NEVER measured.**
- Related: headlines as **keyword fingerprints** (file paths, identifiers), not prose. Offline
  ranking 2/12 → 5/12 top-3 with event-keyword enrichment; full prose ~4,400 tok vs headline-only
  ~900 tok (80% reduction). Efficacy of keyword-list headlines never measured live.

---

## 7. IMPLEMENTED BUT NEVER MEASURED LIVE

Each has passed a mechanism-can-fire gate and has **zero production callers** — `packages/core/src/attention/*`
and `ZoneAssembler` are orphaned because their consumer (the harness) was deleted.

| Mechanism | Gate result | Live status |
| --- | --- | --- |
| `evictRederivable` (dependency-tracking) | On a real 49-turn trace: **63.7%** of tokens re-derivable/eligible, **36.3%** transient/structurally protected. Fires at every cadence (c=5: 7 evictions, 44,748 tok peak; c=12: 3, 12,330). | NEVER |
| `isRederivable` | Deterministic from tool name; unknown tool → `undefined` → kept, never dropped | NEVER |
| `selectAttention` priority channel | With 265 real edit-provenance edges: **replaces 26 of 45** admitted units. NOTE: `boost` and `halfLifeTurns` are **inert in the zero-relevance limit** — all four settings identical when no query fingerprints exist | NEVER |
| `selectPayload` whole/excerpt/structural | whole 24,577 tok vs excerpt 3,597 (14.6%); **structural `unsupported_structure` 15/15** | NEVER |
| `buildTopicIndex` | 142 tok for a whole session | NEVER |
| `detectAttentionSignals` | **Fired 0 times in 19 real responses** | NEVER (never fired) |
| `ZoneAssembler` window enforcement + delivery receipts | Unit-tested; elastic tail replayed offline over 118 runs (0 overflows) | NEVER in production |

---

## 8. OTHER UNMEASURED ITEMS ON THE RECORD

- **Reply fraction** `0.05·W` — **unvalidated.** At W=32,768 that is 1,638 tokens; fine when
  simulated W ≪ the model's real window (all prior experiments), too tight for a reasoning model
  where W = the actual window. Needs a sweep (.05/.10/.15/.20) where W approximates the real window.
- **`retrieval.limit = 20`** — unvalidated. The untested direction is **shrinking** the hit list,
  not enriching it (enriching is refuted, S3). The oracle's one-hit result selected perfectly.
- **Mode B / D14** — "Zone A stays frozen and small (3–4 tool schemas instead of the host's full
  toolbox) → larger stable cache prefix" and "eviction/offload centralised". **Never measured**;
  §19 Q5 makes the Mode B default conditional on exactly this evidence.
- **D5** — "prefix-keyed caches: middle edits invalidate suffix; caching rewards stable layout, not
  minimal payload." Asserted. The §17 cache assertion harness is the named instrument and it
  survives in `packages/core/test/`.
- **D1** — that tool-type-transition segmentation is as good as content clustering. Asserted.
- **The quadratic-savings value claim** — that savings compound on large windows. Unmeasured.
- **The overflow regime itself** — the tree's value hypothesis is sessions ≫ window, and **no trace
  in the repo has ever reached it** (all prior attempts were starvation cells, S1).
- **The score hypothesis** — *that a shorter, better-curated context makes the model reason better.*
  **No lens ever refuted it and no experiment ever tested it.** External support: NIAH ≈100% while
  RULER and a cited enterprise trial show ~59% on realistic long-document QA. This is the endpoint
  that can vindicate the whole programme, and every measurement so far argued cost/latency instead.

---

## 9. WHAT MAKES ALL OF THIS TESTABLE NOW

opencode exposes the seams, **verified in the shipped 1.18.27 binary** (not just in type
declarations):

| hook | gives us |
| --- | --- |
| `experimental.chat.messages.transform(input, output)` — `output.messages` is mutable | **rewrite the entire message array before it reaches the LLM** — eviction, admission, soft target, Zone B substitution, ledger injection, layout R |
| `experimental.chat.system.transform` — `output.system: string[]` | Zone A — and the ability to *protect* it, which S2 says was being violated |
| `tool.execute.after` | shape tool results — HR2 (whole retrieval payloads), D-a (excerpt centring), H5 (demand expansion) |
| `chat.message` | observe the model's own text → H4/HR3 sufficiency and topic-shift signals |
| `experimental.session.compacting` / `.compaction.autocontinue` | replace or disable opencode's own compaction so it is not a confound |
| `tool.definition` | Zone A tool-schema size (Mode B's claim) |
| PluginOptions `plugin: [[name, {…}]]` | **each arm is one options object on one plugin** |

Three properties that make this safer than what failed:
1. **opencode owns the tool-call representation on both sides of the hook.** We receive its
   faithful `{info, parts}` and return the same shape. S4's bug is structurally impossible.
2. **The gate that would have caught S4 becomes a unit test:** assert no transform ever drops a
   `ToolPart` while keeping the assistant text that announced it.
3. **Measurement needs no instrumentation** — opencode records
   `tokens: {input, output, reasoning, cache:{read,write}}` per assistant message, readable via
   `opencode export`.
4. **The plugin is the window enforcer**, so W is an arm parameter and every arm shares one
   budget-enforcement code path — removing a confound the old arms had.

**Corpus available:** the LHTB clone survived with 47 tasks (gates passed: pristine 0.0 / reference
1.0). **23 are zero-LFS `continue_until_timeout` at ≥240 expert-minutes** — long enough to reach the
overflow regime at W=131,072 without a starvation cell.

---

## 10. OPERATOR DECISIONS ON THE RECORD (answered 2026-09-09 — not open)

**Q1. Is the register complete?** — **Yes.** "That looks complete." Treat §1–§8 as the closed set.
A new hypothesis needs an operator decision, not an inference from the code.

**Q2. Does the order of the ladder matter?** — **No.** "Order doesn't matter. We need results. The
likely end result is combining two or more of these techniques."
Two consequences, and they pull in opposite directions, so hold both:
- The ladder is ordered by *information per unit of cost*, not by dependency. Any rung may be run
  first. Rung 0 is at the top only because it costs nothing.
- **But do NOT test the combination first.** "If we test 12 things at once then how do we know
  which technique worked or which hurt the overall ensemble? Small, short tests that test that
  specific hypothesis under test is what we need. Then we can intelligently combine the
  techniques." One variable per test. The combination is the *destination*, arrived at by knowing
  which parts carried an effect — never the first experiment.

**Q3. Does HR2 mean never excerpt a structural result?** — **Not a rule; it is the hypothesis, and
data decides.** Operator, verbatim:

> "HR3 is a hypothesis which by definition means data can change our perspective. Without evidence
> it seems like tool call results are only applicable when their results apply to the current
> topic. For instance if a feature requires editing across 5 files then maybe those 5 files
> excerpts from graft are applicable or maybe the context only needs information for one file at a
> time — also maybe when the model shifts to writing a report or updating the task list he can
> eject the context of those 5 files. **It is more important to err on more context then less
> context.** That is the idea behind top-k relevance, DSA, ie the idea behind this whole
> experiment."

This fixes three things in the design:
1. **Retention is topic-scoped.** A tool result is live while its topic is live. The five files'
   graft excerpts are applicable *together* during the cross-file edit — and become ejectable when
   the model shifts to writing a report or updating the task list.
2. **The ejection trigger is TOPIC SHIFT, not budget pressure.** This is what makes it
   attention-over-history rather than compaction.
3. **Err toward MORE context.** Eviction must be conservative by construction — require multiple
   simultaneous conditions before dropping anything, and prefer keeping. A policy that is wrong in
   the "kept too much" direction costs tokens; wrong in the "dropped too much" direction costs the
   task. These are not symmetric.
   → **This reinterprets HA:** the soft-target `f` is a **floor below which we never evict at
   all**, not a level to maintain. Whether one file at a time beats five is an open sub-question of
   HR1/H2, to be measured, not assumed.
