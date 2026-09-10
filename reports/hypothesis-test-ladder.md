# Test the untested hypotheses — one at a time, cheapest instrument first

> **Standing plan.** Companion report: `reports/metrics/harness-deletion-and-hypothesis-register-report.md`.
> Register confirmed complete by the operator 2026-09-09. Supersedes `docs/IMPLEMENTATION_PLAN.md`
> §15 (evaluation) per D20.

> **THIS FILE CARRIES NO RESULTS, BY RULE.** It states what to test, how, and what would falsify
> each claim. Every prior measurement lives in the companion report and in the artifacts under
> `reports/metrics/`. Where a past finding constrains a design, this plan names the *constraint* and
> cites where the number lives — it does not reproduce the number, and it never states an expected
> value. **Do not add results here.** A plan that tells you what you are going to find has
> pre-decided the experiment; put your numbers in a report under `reports/metrics/<name>/`.

## START HERE — running this cold

You need no context from any prior session. Read this file, then §0 before anything else — §0 lists
the traps that cost two days.

```sh
cd /Users/danielbyrne/GitHub/rpm/context-tree
pnpm install && pnpm run typecheck && pnpm vitest run   # record the pass/skip counts as your baseline

# Rung 0 needs no provider and no budget. Recover the question sets (one path per command —
# there is no `questions-.json`, so do not use brace expansion here):
mkdir -p /tmp/ct-questions
for q in questions questions-deep questions-overflow literals literals-overflow; do
  git show 7d459f9^:eval/fixtures/transplant/s1/e1b289c32f40/$q.json > /tmp/ct-questions/$q.json
done

# Rebuild a store from the committed real session:
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

- **Target window at W = 131,072. Avoid at W = 32k–65k, never at 16k.** §0/S1 for the reasons, which differ
  per cell.
- **Never put experiment code in `packages/`.** Scripts live beside their report under `reports/`.
- **Re-read every number from its raw artifact before quoting it** (standing provenance rule). Do
  not quote a number from a journal, a summary, or this plan.
- **A probe whose number you will quote must write its output under `reports/metrics/` before you
  use it.** §0/S5.
- **Name and version every artifact, and write a manifest beside the results.** A unique run id; an
  **arm id carrying a version** (`prefix-retrieval@v2`, never bare `prefix-retrieval`); W; model;
  judge; commit SHA; date; and the falsification condition, recorded before the run. §0/S11 for what
  the absence has already cost.
- **One variable per test.** §10/Q2.
- **Quantify every failure before drawing a conclusion from it.** Context compression demonstrably
  preserves task continuity, so a failing arm is a bug to be localised, not proof the approach
  cannot work. At minimum report the arm's window occupancy and what it admitted at the point of
  failure. "The arm failed every replicate" is not a finding on its own.
- **Fix each falsification condition before the run, and do not renegotiate it afterwards.**
- Graft's index may be stale after the harness deletion — if it names a path that is not on disk,
  `graft grep` the symbol instead of chasing the path.

## Context

Two days produced no tested hypothesis. Two causes, both recorded in the companion report: a
bespoke harness whose `ChatMessage` could not represent a tool call, which voided every arm
comparison (§0/S4); and before that, passes that ran at window sizes where the thing being measured
was not the thing intended (§0/S1).

The operator's constraints on this work, stated directly:

- **"Small, short tests that test that specific hypothesis under test is what we need. Then we can
  intelligently combine the techniques."** Testing twelve mechanisms at once yields one number and
  no attribution. One variable per test; combine afterwards, informed by which carried an effect.
- **"It is more important to err on more context than less context. That is the idea behind top-k
  relevance, DSA, ie the idea behind this whole experiment."** Eviction is conservative by
  construction; the ejection trigger is topic shift, not budget pressure.
- **"We need results."**

What makes this tractable now: opencode exposes `experimental.chat.messages.transform` — a mutable
`output.messages` — verified present in the shipped 1.18.27 binary. That is control of the prompt
with none of the tool-calling risk, because opencode owns that representation on both sides of the
hook. And several hypotheses need no provider at all.

**The intended outcome of the first session of work is a number, not a plan.** Several tests below
run at zero model cost.

---

## FOR THE NEXT AGENT — read this first (2026-09-09)

**Everything here is in development. Nothing is "shipped." The old Zone A/B/C tree is being replaced,
not defended — do not treat it as an authoritative baseline to protect.**

**DIRECTION.** The algorithm is being restructured as a pipeline (`reports/algorithm.md` →
"Pipeline (TENTATIVE)"): an **ensemble classifier** (topic-shift `z(lexical)+z(semantic)`) and an
**ensemble retriever** (RRF over BM25/vector/graft on one shared corpus) feed a **cache
assembler/ejector** (flex buffer: Zone A = system + steering + all user prompts, append-only; a
creation-order buffer of sticky representations — ref | summary | raw — to a soft target, with a
secondary cache breakpoint so it caches). Every stage has offline support; **none is live-validated.**

**DO NEXT (live).** Build the opencode plugin (see "The instrument for rungs 2–3" below) and test
**this** pipeline live — the flex-buffer assembler + the ensemble retriever/classifier. Order:
gate 0 (F1 mutation-visibility unit test) → gate 1 (tool-call fidelity) → a short live task graded by
outcome. The point is a real result on the NEW design, not a re-run of the old one.

**DO NOT RUN — rejected / obsolete (do not spend a session on these):**
- **Re-running the prior arms** (old `context-tree` Zone A/B/C, `native`, `prefix-retrieval` — the
  former "Rung 2z"). The operator rejected re-testing the prior failed design. Test the new pipeline.
- **Zone B as a fixed index band** (former Rung 1a / HZ) — dissolved: a summary is now one
  representation in the flex buffer, not a zone.
- **Excerpt anchor-tuning** (D-a) and **retrieval-constant tuning** (Rung 0c) — the retrieval unit is
  off-the-shelf now; don't tune the bespoke one.
- **Occupancy audit of the old harness traces** (Rung 0d) — dead retrospective; build on real sessions.
- **Confidence-gated fusion** (margin gate) — refuted. Plus the §0/S3 refuted-repairs list.

**TESTED already (offline — read the report, don't re-run):**
`reports/metrics/{excerpt-window-0a, rung-0e-retrievers, rung-0b-topic-shift, assembler-zone-io,
assembler-flex-buffer}/`. The one-line conclusions are in the PROGRESS table just below.

**OPEN (needs a model or a live run):** the **sufficiency** signal (needs a labelled set); the **soft
target on an overflowing session** (the cache sim only reached ~44% occupancy); and the headline
live question — **does the pipeline save tokens without losing the task.**

The §0 settled facts (S1–S12) and the instrument facts (F1–F4) below are still the "traps to avoid."
Everything after the ladder is reference; a fresh agent needs only this block plus the instrument
section to start.

---

## HOW WE TEST — one idea, one small test, one short report

This is the working loop the 2026-09-09 rungs followed; keep to it. The templates are the existing
runs under `experiments/` and `reports/metrics/` (e.g. `experiments/rung-0e-retrievers/`, which shares
a `lib.mjs` so its scripts can't drift).

1. **Isolate one variable.** One hypothesis per test. If you must combine (e.g. a whole-pipeline arm),
   say so and hold everything else fixed. Testing twelve things at once yields one number and no
   attribution.
2. **Cheapest instrument first.** Prefer *offline + deterministic* (seeded, no model) → a *cheap local
   model* (MiniLM, a small classifier) → a *cheap hosted model* → *live*. Most retrieval/classifier/cache
   questions are answerable offline; spend a live run only on what only a live run can settle.
3. **Pre-register the falsification condition** — write "this fails if …" *before* running, and do not
   renegotiate it after seeing the result. If it fails on a technicality (e.g. a sign error), report the
   failure as written, then add the corrected reading separately. Fail loud.
4. **Write a small, self-contained, rerunnable script** under `experiments/<name>/`. It recovers its own
   fixtures (e.g. `git show`), is deterministic (seed any RNG), imports offline primitives from
   `@context-tree/core`'s built `dist/`, and **never lives in `packages/`** (the product ships no
   experiment code). A header comment states what it tests, the falsification, and how to rerun.
5. **Write output under `reports/metrics/<name>/` before quoting any number.** `results.json` carries the
   manifest — run id, arm id + version, commit SHA, date, model/judge, the falsification, caveats — plus
   the raw cells. Never quote a number that isn't in a committed artifact.
6. **Run it; get a result.** Quantify failures — a null is a bug to localise, not proof the idea can't
   work. Report window occupancy / what was admitted at the point of failure, not just "it failed."
7. **Write a SHORT report** (`report.md`): the question, the result *as conclusions + pointers* (numbers
   stay in `results.json`, not in this plan), honest caveats (small-n, proxy objective, scope), and an
   explicit **tested vs. open** line. Know the proxy's limit: offline proxies rank *large* differences,
   not *small* marginals or task quality — say so.
8. **Close the loop.** Report the result in chat; update this plan's status (PROGRESS table + the rung's
   STATUS line, or mark it REJECTED with a one-line reason); commit **by experiment run** (script +
   its reports together).

The whole point: a session should end with a *number and a short honest report*, not a longer plan.

---

## PROGRESS — as of 2026-09-09 (what is TESTED, what REMAINS)

Status only; numbers live in the cited `reports/metrics/<dir>/` reports, never here.

| item | status | one-line result / what remains | reports dir |
| --- | --- | --- | --- |
| **0a** excerpt/retrieval unit | **TESTED (offline)** | Retrieval unit is a solved off-the-shelf problem — retire `excerptAround` + D-a anchor-tuning; use a standard chunker + BM25. General-web rerank hurt on code. | `excerpt-window-0a/` |
| **0b** topic-shift classifier | **TESTED (offline); classifier CLOSED** | Signal is real/cheap; classifier = `z(lexical)+z(semantic)` (kNN ≈ embedding, interchangeable; merged = robust). **Sufficiency half OPEN** (needs labels). | `rung-0b-topic-shift/` |
| **0c** retrieval constants | **SUPERSEDED by 0a** | Off-the-shelf chunker replaces constant-tuning. Residual: provider-interface integration only. | (see 0a) |
| **0d** occupancy audit | **NOT RUN — deprioritised** | A retrospective audit whose answer S9 already gives (old traces ~10× too short; real sessions reach 37–56%). Build assembler on real sessions instead. | — |
| **0e** retriever isolation + combination | **TESTED (offline)** | Coverage-overlap sets fusion's sign (refines S3); default RRF; graft strongest single + best span-precision; vector owns semantics but shallow spans. | `rung-0e-retrievers/` |
| **Assembler zone I/O** | **TESTED (offline mechanics)** | Zone A cache-stable; **Zone B capped/non-adaptive**, tail protected, large-W under-fill (headroom-fill is not in the library). "Should we have Zone B?" — negative prior, overflow role untested. | `assembler-zone-io/` |
| **Assembler flex-buffer redesign** | **TESTED (cache mechanics offline)** | Cache economics CLOSE: `flex-append-sticky` (Zone A = system+steering+all user prompts append-only; creation-order buffer; secondary breakpoint; soft target) beats current zones; free re-mix is cache-death. **OPEN: task quality (live); soft target on an overflowing session.** | `assembler-flex-buffer/` |
| **Rung 1** (HZ, HR1) | **NOT STARTED** (cheap live) | — | — |
| **Rung 2** (2z, H1, H3, H6, D-b, HU/priority) | **NOT STARTED** (live) | The umbrella (HU) and every named hypothesis remain untested live. | — |
| **Rung 3** (HA soft target, score hypothesis) | **NOT STARTED** (live) | The endpoints that vindicate the programme. | — |

**One-line meta-finding across the offline rungs:** the proxies rank *large* differences (retriever
families, layouts, cache mechanics) but cannot settle *task quality* or resolve *small* marginals — those
need labels or the live outcome. The live path (opencode plugin, Rung 2z) is the standing next step.

## THE LADDER — ordered by information gained per unit of cost

Each rung: one hypothesis, one variable, a falsification condition fixed before the run.

### Rung 0 — runnable immediately, ZERO or near-zero model calls

Everything these need survived the harness deletion.

| asset | path |
| --- | --- |
| real local Claude Code sessions (the long-session corpus) | `/Users/danielbyrne/.claude/projects/**/*.jsonl` |
| real 645-call session, 4.6 MB (committed) | `packages/cli/test/fixtures/claude-code-session.jsonl` |
| question sets — `answer_literals` / `answer_regexes`, and `source_context` / `wide_context` payload text inline on the `questions*` files, so 0a and 0c run from `git show` with no store rebuild. The `literals*` files carry answers but no inline payload and need the store. **Count the entries and report the count**; do not trust a count quoted anywhere. | `git show 7d459f9^:eval/fixtures/transplant/s1/e1b289c32f40/<name>.json` for `questions`, `questions-deep`, `questions-overflow`, `literals`, `literals-overflow` |
| fingerprints, excerpting, signals, topic index | `packages/core/src/retrieve/{lexical,excerpt}.ts`, `packages/core/src/attention/{signals,topic-index}.ts` |
| store rebuild | `context-tree import <transcript> --from-claude-code` |

**Two facts about the corpus that change what is cheap** — both are availability facts, not results:

- **The overflow regime is reachable from the real-session corpus.** The record listed "no trace in
  the repo has ever reached the overflow regime" as an open item; the local session corpus contains
  sessions far longer than anything the old harness produced, and
  `packages/cli/src/claude-code.ts` is the shipped importer for exactly that format, so any of them
  becomes an L0/L2 store today. **Measure the distribution yourself and report it** — session count,
  tool calls, estimated content tokens — rather than reusing a figure.
- **The s1 store is gone but its queries are not.** `trace.src.jsonl` and the derived store were
  never committed and died with `eval/` at `7d459f9`. The question rows survive in git with their
  payload text inline, so D-a's sweep runs from `git show` alone.

**0a. D-a — the excerpt window (hand-off item 1's first named defect).**
> **STATUS: TESTED 2026-09-09 (offline).** Retrieval unit is off-the-shelf — retire `excerptAround` +
> anchor-tuning. Bespoke sweep and off-the-shelf chunk/retrieve/rank/rerank in `reports/metrics/excerpt-window-0a/`.
Claim under test: a correctly ranked event can be selected and still not contain the answer,
because the excerpt window is too narrow and anchored at the wrong place. If so the retrieval unit's
excerpt is the defect, not the ranking.
Sweep, offline: every recovered query × `excerptChars` ∈ {500, 1000, 2000, 4000} × anchor ∈
{first, rarest-matched-term, matched-line-span}. Metric: **fraction of queries whose
`answer_literals` appear inside the excerpt**, against total tokens returned.
*Falsifies if:* the literal-present rate at the shipped setting (`excerptChars=1000`,
`anchor=first`) is already ≥90% — then the excerpt window is not the defect and hand-off item 1a is
closed.
*Trap this must avoid:* a prior version of this sweep returned a **degenerate null** because every
payload it was handed had empty fingerprint `terms`, so no anchor could differ from any other.
**Report the count of queries with non-empty terms alongside every cell.** A sweep over empty terms
measures nothing, and it will look like a clean negative.

**0b. HR3 / H4 — the model's own signals. BUILD THE DETECTOR THE DESIGN ALREADY SPECIFIED.**
> **STATUS: topic-shift half TESTED 2026-09-09 (offline); classifier CLOSED.** Signal is real and cheap;
> classifier = `z(lexical)+z(semantic)` (kNN ≈ embedding-drift, interchangeable; merged = robust). The
> **sufficiency half remains OPEN** (needs the labelled set + κ≥0.6 gate below). `reports/metrics/rung-0b-topic-shift/`.

**Do not sweep a bigger regex list. A lexical matcher cannot work here in principle.** An LLM is
probabilistic, not deterministic; every model phrases sufficiency differently; and "I have what I
need" is a *semantic* state, not a string. Any regex list is a sample of one author's guesses about
phrasing.

**The shipped `detectAttentionSignals` is a deviation from the design, so measuring it is not a test
of H4.** §14 specified the instrument
(`reports/metrics/window-regime-and-retrieval-unit-report.md:655-659`):

> "Detect them (**a small classifier over assistant text is enough to start**; log the phrases
> first, zero live tokens, from the recorded runs) … detect topic shift the same way (**a turn whose
> content words share little with the previous n turns**)"

"Log the phrases first" was a **preliminary look at the corpus**, not the detector. What shipped was
four regexes — the preliminary step mistaken for the instrument. Any fire-rate number for those
regexes therefore reports on a mis-implementation, not on the hypothesis. (One such number was
measured; it is in the companion report solely as evidence that the shipped code cannot fire. It is
not evidence about H4, and it must not be used to set an expectation for the instrument you build.)

**The two sub-signals have different right instruments, and only one needs a model.**

- **Topic shift — deterministic, no model.** §14 already gives the measure: a turn whose content
  words share little with the previous *n* turns. Compute fingerprint Jaccard (`extractFingerprints`)
  between turn *t*'s tool inputs and turns *t−n…t−1*, and flag a drop against that session's own
  baseline. Validate against a **within-session permutation null**.
  *Falsifies if:* flagged boundaries show a forward-overlap drop < 0.5 SD below session baseline —
  i.e. the measure does not separate a real shift from an arbitrary turn boundary.
- **Sufficiency — needs semantic judgment, so a model.** A small adjacent classifier reads the
  assistant turn and answers one question: *does this turn assert it has what it needs to proceed?*
  Cheapest first: a cheap-model call per turn over a sampled subset, or a local NLI-style classifier
  if per-turn cost matters at corpus scale. Ground truth is a hand-labelled sample of real turns,
  never a phrase list.

  **THE STOPPING RULE — fix it before building the instrument, and do not renegotiate it after
  seeing the result.** "The detector failed" always admits a stronger detector: a regex fails → try
  a classifier; the classifier fails → try a bigger model. Without a pre-committed threshold H4 can
  absorb unlimited null results and never be wrong, which is how a null on four regexes came to look
  like a result about a hypothesis. So: **one cheap-model binary judgment per assistant turn,
  prompted with §14's own definition, scored against 200 hand-labelled turns sampled from the real
  session corpus. If it cannot reach κ ≥ 0.6 against those labels, the sufficiency half of H4/HR3 is
  RETIRED, not iterated** — the conclusion being that the signal is not reliably present in
  assistant text, not that a better detector is owed. Retiring it does not touch the topic-shift
  half, which stands or falls on its own condition above.

**Standing constraint, unchanged:** a sufficiency signal is evidence for **reassessment**, never
permission, and never an irrelevance label. The instrument must not encode it as one.

**Cost.** Topic-shift half: zero model calls. Sufficiency half: a hand-labelled sample plus cheap
classifier calls over that sample — far below any live agentic batch. **A live test of H4/HR3 is
wasted until a detector clears its falsification condition above.**

**0c. Retrieval-unit constants — `eventHits`, `excerptChars`, `retrieval.limit`.**
> **STATUS: SUPERSEDED by 0a 2026-09-09.** Tuning these magic numbers is the bespoke work 0a showed is
> unnecessary — a standard off-the-shelf chunker + BM25 behind the provider interface replaces the whole
> "derive the constants" exercise. Residual is provider-interface integration, not a constant sweep. See
> `reports/metrics/excerpt-window-0a/`.

All three shipped as values copied from a published interface and were never validated here. Same
sweep harness as 0a. Metric: answer-present rate vs total tokens returned, per (hits × chars ×
limit).
*Produces:* a derivation — hits and chars as functions of headroom and event size — replacing three
magic numbers.
*Direction to test:* **shrinking** the hit list. Enriching it is on the do-not-retry list (§0/S3).

**0d. Occupancy across the whole record — was any arm, ever, near its window?**
> **STATUS: NOT RUN — deprioritised 2026-09-09.** This is a retrospective audit of the *old* record, and
> S9 already answers it: the old harness traces are ~10× too short and real operator sessions do reach a
> meaningful window fraction. So the forward move is to build assembler work on the real-session corpus,
> not to audit the dead traces. Left here for completeness, not as a gate.

Zero model calls. For every `results*.json` under `reports/metrics/`, compute context actually seen
per turn (`input + cacheRead`) against that run's W, and report peak and final occupancy per run,
grouped by arm and scenario.
*Why it matters:* window-management hypotheses assume pressure against the window. If no arm in the
record ever approached its window, then every occupancy-related result to date is a fact about the
instrument rather than about the policy, and HA cannot be tested on those traces at all.
*Metric:* peak occupancy as a fraction of W, per run; and the correlation between occupancy and
success across runs.
*Falsifies the "arms were window-constrained" premise if:* peak occupancy is far below W across the
record. *Falsifies the reverse if:* arms routinely run near W, in which case eviction pressure is
real and the failure analyses that assume headroom need revisiting.
*Provenance caveat:* most artifacts **do not record their own W** — recover each cell's window from
its report prose and **record which values you had to infer, and from where.** Do not silently
assume 131,072.
*Then extend it:* where an arm failed, compare its occupancy against the arm that succeeded on the
same scenario. Equal volume with opposite outcomes localises the defect to content selection; that
distinction is the difference between a bug report and folklore about the technique.

**0e. Retriever isolation, then combination — which single retriever, and does combining beat it?**
Zero live model cost (local retrievers; local embeddings). Runs on the same pooled-slice corpus and
harness as 0a (`experiments/rung-0a-excerpt-window/offtheshelf-sweep.mjs`). Two phases, in order —
the second is meaningless without the first.

*Phase 1 — each retriever ALONE (one variable per arm).* Same corpus, same chunker, same top-k
budget; vary only the retriever. Text-applicable retrievers: BM25 (done, 0a off-the-shelf), dense
vector (isolate; the embedding model is itself a sub-sweep — MiniLM / bge-small / gte-small /
e5-small), grep/exact-substring, the repo's own TF-IDF beam (`lexicalScore`), and fuzzy. Metric:
answer-present rate vs tokens returned, per retriever. *Produces:* the **best single index** — the bar
every combination must clear.
*Structural retrievers (graft/tree-sitter, Serena/LSP) are OUT of this rung:* they retrieve from a
parseable code repo, not from conversation-trace text slices, so "same transcript" is not
apples-to-apples. That is HR1 / Rung 1b, on a code-repo corpus.

*Phase 2 — combination arms, one variable each, all at the SAME total top-k as the best single
(token-neutral by construction — retrieval is local, only admitted content costs tokens):*

- **best-single-index** — the bar (from Phase 1).
- **RRF over same-index rankers** (e.g. BM25 + vector over the one chunk index). Predicted to help:
  fusion is the right combinator for multiple rankers over the *same* index (hybrid grep+beam already
  did, `ds-star-search-ranking-report`), the wrong one across *disjoint* indexes.
- **round-robin / position interleave** across retrievers — reserves one slot per source, so it
  cannot demote the right source's top hit the way score-fusion does. This is the operator's variant
  and is NOT the refuted RRF-across-indexes arm.
- **interleave + source labels** — each block prefixed "content from the {tool} retriever," to isolate
  whether the label earns its tokens. Prior caution: added display text has twice moved tokens
  without moving selection (§0/S3).
*Falsifies the combination case if:* no combination arm beats best-single-index on answer-present rate
at equal top-k. *The mechanism to respect (identified, not folklore):* rank-only RRF across
disjoint-coverage indexes demotes already-found answers (rank 3→12, 7→26, measured in
`reports/metrics/ds-star-multi-index-report.md` §8) because it cannot tell "rank 1 in the index that
matters" from "rank 1 in an irrelevant one." Routing beat fusion there 9/17 vs 6/17 — so a **router**
(turn-type → best retriever) is the standing alternative any combination arm is also measured against.

**STATUS — 0e RUN 2026-09-09. Numbers in `reports/metrics/rung-0e-retrievers/` (five reports); read
them there, not here. Directional (small n) but internally consistent. Settled conclusions, as design
guidance:**

- **The retrieval unit is a solved, off-the-shelf problem** (Rung 0a companion): retire the bespoke
  `excerptAround` + D-a anchor-tuning; a standard chunker (recursive/token) + BM25 behind the
  `RetrievalProvider` interface matches it. General-web cross-encoder rerank HURT on code (out of
  domain). `report-offtheshelf.md`.
- **Coverage overlap is the variable that sets fusion's sign — this REFINES §0/S3, does not overturn
  it.** Multiple retrievers over ONE corpus with overlapping coverage → **RRF wins** (beats best-single
  and routing on mixed traffic). One-retriever-covers queries (e.g. paraphrase-only semantics) → RRF
  *demotes* the sole covering hit and **loses to that retriever alone** — the S3 disjoint-index
  mechanism, reproduced within a stratum. S3's "fusion refuted" is scoped to *disjoint indexes*; it is
  not a blanket rule. `report-repo-benchmark.md`, `report-semantic-hardening.md`.
- **Default combinator = plain RRF; confidence-gated fusion is REFUTED here** (a top-1→top-2 margin gate
  hurt at every setting); a feature router works (17/20) but does not beat RRF on mixed traffic. Route
  only when the workload is single-coverage-dominant. `report-combinators.md`.
- **Per-style specialisation is real and sharp** (so HR1/H2 stand): graft/structural owns
  structure and typos and is the **best single retriever and best span precision** on code; vector owns
  paraphrase semantics but returns **shallow spans** (finds the file, not the answer line);
  lexical owns exact literals. `report-repo-benchmark.md`, `report-span-scoring.md`.
- **File-level scoring overstates quality; judge at span level.** On code, structural (graft) returns
  symbol spans so file-hit ≈ span-hit; chunk retrievers (esp. dense) need a span-refinement stage —
  which is exactly the Rung 0a chunker, now shown necessary. `report-span-scoring.md`.
- **SCOPE CAVEAT that governs transfer:** Phase 2–2d ran on the **code repo** as corpus. Those results
  bind the *structural* retriever (HR1/HR2) and general fusion/routing, but their transfer to
  *conversation-trace event* retrieval (what shipped `context_search` does) is a hypothesis, not
  established — the two corpora differ. The coverage-overlap rule is corpus-agnostic; the graft/span
  numbers are code-scoped.
- **Not yet done:** the embedding-model sub-sweep (bge/gte/e5 vs MiniLM); source-label arm; a
  calibrated-confidence fuser (the margin gate that failed is not the last word); and any *live* run.

### Rung 1 — single-turn probes, cheap live

**1a. HZ — Zone B as an index. DISSOLVED 2026-09-09, do not run as written.** The rung asked whether a
fixed Zone B summary band raises retrieval success. The flex-buffer redesign **removes the fixed band**:
a summary is now one representation option a unit can take in the buffer, chosen by value, not a zone.
So "does the Zone B band help" is a question about a component being replaced. The surviving, reframed
question — *do summaries-as-a-representation earn their tokens vs a raw or ref representation* — is a
knob inside the flex buffer and is tested there, live, not as a standalone Zone B probe.
`reports/metrics/assembler-zone-io/` records why the fixed band was capped and inert.

**1b. HR1 — is the retrieval unit wrong for structural turns?**
> **STATUS: partial offline evidence 2026-09-09; live probe still UNRUN.** The 0e repo benchmark (real
> graft CLI, code corpus) supports HR1's premise: per-style specialisation is real — structural (graft)
> is the strongest single retriever and best at span precision, while chunk/dense retrievers find the
> file but not the answer span. So a structural unit plausibly helps structural turns. But the *specific*
> excerpt-unit-vs-whole-structural-payload ablation, and the transfer to conversation-trace retrieval
> (this was a code corpus), remain untested. `reports/metrics/rung-0e-retrievers/`.

The register's competing explanation for the retrieval arm's failures on the multi-module scenario:
the tool returns a handful of best-matching *events* with a short excerpt each, tuned for "find the
literal", when a multi-step task needs file/tree structure, module layout and API surfaces — so the
model probes with `run_command` instead. The record pursued only the ledger explanation (D-b).
**These two must be ablated separately**; both predict the same failure.
Probe: structural questions ("which files implement X and how do they connect") vs fact questions,
against excerpt-unit vs whole-structural-payload retrieval.
*Falsifies if:* structural questions do no better with whole-payload retrieval than with the
excerpt unit.

### Rung 2 — short live tasks, ~10–40 turns, W = 131,072

Needs the opencode plugin (below). One hypothesis per arm, each against the same control.

**2z. REJECTED 2026-09-09 — do NOT re-run the prior arms.** The former plan was to re-run the void
step8-sonnet head-to-head (`native` / old `context-tree` Zone A/B/C / `prefix-retrieval`) as the first
live result. The operator has rejected re-testing the prior failed design. **The first live run tests
the NEW pipeline instead** (ensemble retriever/classifier → flex-buffer assembler; see FOR THE NEXT
AGENT at the top). Keep these protocol rules for that new run: **run blind** (define the cell before
seeing any prior numbers), **a non-completed run scores `null`, never 0**, report **cost per run**, and
**one variable per arm** except the whole-pipeline arm, which is legitimately combined.

- **H1** — needs the three-phase non-monotonic scenario §15 specified and nobody built: edit an API
  → do unrelated work → need the API again. *Falsifies if* evicting the dormant phase costs success.
  *(Offline 2026-09-09: 0b confirmed the topic-shift **trigger** H1's eviction keys on is real and cheap
  — `reports/metrics/rung-0b-topic-shift/`. H1's own premise, "do real sessions revisit dormant topics"
  (the kNN return-rate), is specced but UNRUN, and H1 itself is live-untested.)*
- **H3** — pin the plan artifact vs not; measure whether the model re-derives steps.
- **H6** — anchor n ∈ {exchange, subtask, all}, at equal n.
- **D-b** — the completed-steps ledger, ablated against **HR1**, since both explain the same failure.
- **evictRederivable** — its offline mechanism-fire gate has passed (see report §7 pointer table).
- **HU / priority** — requires query fingerprints to be present in the live path, or the arm
  measures nothing: the priority channel's parameters are inert in the zero-relevance limit. Gate it
  with §0/S10 before the batch.

**Cadence is an arm parameter, not a constant.** Eviction that rewrites a cached prefix has a
break-even in turns (§0/S7). Choose the cadence you are testing deliberately, state it, and report
cost at that cadence — per-turn and every-n-turns are different experiments.

### Rung 3 — long live tasks, only where genuinely required

- **HA — soft target.** Reinterpreted per the operator: `f` is a **floor below which we never
  evict**, not a level to hold. Requires a session that exceeds the floor, so it needs the
  real-session corpus rather than the old harness traces (§0/S9).
  > **STATUS: partial offline evidence 2026-09-09; efficacy UNTESTED (live).** The flex-buffer redesign
  > exercised the soft target on the *cache* axis: a loose target (0.4–0.5) is cache-competitive, and a
  > tighter one trades occupancy for a little cache churn — so `f` is a viable knob mechanically. Its real
  > payoff (bounding token *volume* on an overflowing session) and its task-quality effect are both unrun;
  > the sim peaked at ~44% occupancy so the floor barely bound. `reports/metrics/assembler-flex-buffer/`.
- **HU end-to-end**, and **the score hypothesis** — that a shorter, better-curated context makes the
  model *reason better*. No lens ever refuted it; no experiment ever tested it. This is the endpoint
  that can vindicate the programme, and every measurement so far argued cost instead.
- Corpus: the surviving LHTB clone's zero-LFS `continue_until_timeout` tasks at ≥240 expert-minutes
  (pristine/reference gates already passed — see report). `vector-db-iterative-build` and
  `duckdb-optimizer-closure` are the strongest candidates: iterative, code-heavy, no multimodal
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

### Four seam facts, read from the shipped 1.18.27 binary — get these wrong and the batch is void

These are facts about the host, not results of any experiment.

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
steering, or skills — is structurally impossible through this seam.** So pin-protection for those
categories needs no code; only the task statement and plan artifacts (which *are* messages) need
explicit pinning.

**F3. opencode's own compaction must be disabled AND recorded as disabled in every live arm.**
`SessionCompaction` defaults `preserve_recent_tokens ?? min(…, floor(context * 0.25))` and its
`prune` mutates `state.time.compacted` on tool parts. Left on, a live arm measures opencode's
policy, not ours — and that `0.25` is a **direct confound for HA**, whose whole subject is the
occupancy fraction. Set `experimental.compaction.autocontinue` → false, disable prune, and record
both in the run manifest.

**F4. `Model.limit.output` and `Model.limit.context` are host-declared** and reachable in
`experimental.chat.system.transform`'s input — which **retires the reply-fraction sweep by fact**:
the reserve is `limit.output`, not a fitted fraction of W. The residual testable question is whether
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
   non-zero. An arm byte-identical to its control must never be written up as a failed hypothesis.
   **And the inverse trap: a mechanism-can-fire gate must be fed the inputs the live path builds**
   — a gate starved of its inputs reports "inert" about itself, not about the mechanism (§0/S10).
5. **W = 131,072.** Never 32k–65k, never 16k. The plugin is the window enforcer, so W is an arm
   parameter and every arm shares one budget-enforcement code path — removing a confound the old
   arms had.
6. **Non-completed run scores `null`, never 0.** A token win with any success regression is a
   **regression**, not a tradeoff.
7. **Source-side hygiene is in the control, not in the treatment** (§0/S8).

---

## Verification

- **Rung 0** — a table of numbers per sweep cell, committed under `reports/metrics/`. No provider
  touched. Each cell's falsification condition evaluated explicitly, including the ones that pass.
- **Rung 1–3** — `opencode export <sessionID>` gives per-assistant-message
  `tokens: {input, output, reasoning, cache:{read,write}}`, so token accounting needs no
  instrumentation. Task success from the LHTB verifier (separate container, artifacts-list
  contract — no git-commit requirement, so an external agent grades cleanly).
- **Every reported score** re-read from its raw artifact before being quoted, per the standing
  provenance rule.
- **Report what the run showed, including when it contradicts the design.** A refutation reached by
  a working instrument is the point of the exercise, not a setback to be explained away.

---

# REFERENCE — the complete untested-hypothesis register

The operator confirmed this list complete. It is the source for every rung above.

---

## 0. Settled facts — a new agent must NOT re-derive or re-run these

Each is a constraint on design, with a pointer to where its evidence lives. **The numbers are
deliberately not repeated here** — read them from the cited artifact if you need them, and never
carry one into a falsification condition as an expected value.

**S1. Do not sweep small windows — and the small-window cells failed for *different* reasons, so do
not collapse them into one story.** Three distinct cells, and only the first is an experimental
artifact:

- **W=16,384** — Zone A + Zone B + one search exceeds the window. A dead cell; nothing about context
  policy can be measured there. (`minimum-window-boundary` memory.)
- **W=32,768–65,536** — the tree lost to the tail arm on **Haiku 4.5** (partly Sonnet 5), and the
  recorded cause was **tool overhead**: each search/fetch turn costs tokens the tail arm spends on
  raw content instead. **This is a real negative, not an artifact**, and the design still owes it an
  answer. Read `live-verification-findings.md:11-16` before touching this — it names the model and
  the mechanism. **Do not relabel it as starvation**: the starvation arithmetic is about a
  Fable-class system prompt, and these runs never used one.
- **A Fable-class system prompt at W=65,536** — the prompt alone consumes most of the window. True,
  but it describes a *deployment*, not any experiment that produced the numbers above.

The realistic-host cell is **W = 131,072** (a 200k host minus a large system prompt). W=200k is not
an overflow test on the s1 store, because most of its answers sit in the tail. **The reason not to
re-sweep 32–65K is that the tail already covers the answers there** — not that the cell is invalid.

**S2. At small W the wrong things were being evicted** — portions of the system prompt, steering
files (CLAUDE.md), plan files and skills, which are precisely the always-pinned category. A policy
that evicts them is not being tested; it is broken. F2 makes this structurally impossible through
the opencode seam.

**S3. Refuted repairs — do not retry these.** Each was measured and closed; the numbers are in the
companion report and the metrics artifacts.

- Recency-only eviction (keep-last-n): breaks a large share of the run's `edit_file` calls, because
  the longest-lived units are the earliest and smallest.
- Zone B prose enrichment (`tree-hit-keywords`): more input tokens, no change in selection.
- Multi-index RRF fusion: worse than routing to the best single index.
- Compact coordinate display: made the correct branch illegible.
- Showing the model *more* Zone B prose.

**S4. Every live arm comparison from the deleted harness is void.** `ChatMessage` had no
`tool_calls` field and no `'tool'` role, so the harness stripped the model's own tool calls from its
history and replayed results as user text. Offline analyses (occupancy, re-send multipliers, cache
economics) survive; anything that ran the loop does not.

**S5. Instrument defects to fix before any batch.** One question (`qo05`) has a non-unique referent;
provider empty-turn failures were kept in denominators; `provenance-audit` did not read the search
channel; per-run transcripts were not persisted. **Standing rule from the last of these:** a probe
whose number will be quoted must write its output under `reports/metrics/` *before* the number is
used — several figures in the companion report are unverifiable for exactly this reason.

**S6. A head-to-head comparison already exists and it is void.** Do not write "we have never
compared the arms." `reports/metrics/window-regime-and-retrieval-unit/step8-sonnet/` holds 18 runs
on real Sonnet 5 across `native` / `context-tree` / `prefix-retrieval`. It ran on the deleted
harness, so S4 voids it. The companion report argues the defect was **asymmetric** — that under the
stripping a tail arm keeps prior work as raw text while a retrieval arm loses both the call and the
content it replaced. **That argument is untested; Rung 2z is what tests it.** Treat the recorded
numbers as a prior run to be reproduced blind, not as a target.

**S7. Prefix invalidation has a break-even, so cadence is a design variable.** On Anthropic pricing
`cacheRead = 0.1×` and `cacheWrite = 1.25×` input (`packages/core/src/models/cost.ts:45-48` — a
property of the published price table, not a measurement). Evicting to save a `keep` fraction of a
cached prefix breaks even only after `turns = w·keep / (r·(1−keep))`, and the cost is re-paid every
time the eviction fires. **Compute this for your provider and cadence before designing an arm, and
report cost at the cadence you actually ran.** Corollary: a provider that publishes `cacheWrite: 0`
charges nothing for the dominant term, so token-side results measured there do not transfer to
Anthropic.

**S8. Source-side hygiene belongs in the control.** Dropping the write echo and capping tool-result
bodies changes what *enters* the prefix rather than rewriting it, so it reduces prompt volume with
no cache invalidation at all (`reports/metrics/attention-policy-continuation/journal.md:732,801`).
It is a cheaper intervention of the same kind, so an attention policy measured only against naive
full history is measured against the wrong baseline. **Put hygiene in the control arm and let the
comparison decide** — do not assume in advance which wins.

**S9. Use the real-session corpus for occupancy work, not the old harness traces.** The harness
corpus never reached a meaningful fraction of a real window from task demand, which is why HA was
recorded untestable; real operator sessions do reach it (`reports/algorithm.md:88-89`). That was an
instrument limitation, not evidence about HA. Do not re-derive "nothing reaches the soft target"
from the old corpus.

**S10. A mechanism-can-fire gate is a claim about the gate until its inputs are checked.** One gate
reported an arm inert because the gate itself supplied no reference edges, so the parameters under
test could not have changed anything. Feed every gate the inputs the live path builds, and record
what you fed it.

**S11. Artifacts are under-identified, so provenance must be reconstructed before any comparison.**
The existing result files record run id, benchmark, scenario, arm, model, status, success, judge,
metrics and turns — **but not the window size, the arm's implementation version, or the code
commit.** One consequence is already on the record: a published cell's `W` survives only in a
paragraph of report prose, and two differently implemented arms (`prefix-retrieval` and
`prefix-plus-retrieval`) are distinguishable only by name. **Before comparing any new run to an old
one, reconstruct and write down the old cell's parameters**, and mark which you had to infer. Going
forward, the manifest rule in START HERE is mandatory.

**S12. A failing arm is a defect to localise, not a verdict on the approach.** Context compression
demonstrably preserves task continuity — the sessions that produced these reports were themselves
compacted mid-task and continued. So an arm that scores zero is telling you *something specific went
wrong*, and the record's habit has been to note the score and move on. The companion report shows
how much is recoverable offline from per-turn usage alone. **Quantify before concluding**, and prefer
the explanation that names a mechanism over the one that names the technique.

---

## 1. THE UMBRELLA HYPOTHESIS

**HU. Attention over history.** Prioritisation of history is a metric parallel to contextual
relevance, and priorities change. If we limit context growth by ejecting inconsequential contextual
data, we save tokens without losing task success. Cumulative consumption is quadratic in turn count
(every turn re-sends the prefix), so the saving compounds on long sessions.
**Status: NEVER TESTED.** Its stated premise ("growth is exponential") was mis-refuted in an earlier
pass by fitting *per-turn prompt length* (linear) against a claim about *cumulative consumption*
(quadratic). Nothing was refuted; the premise stands as stated.

Encoded (§15) as **two channels per unit per turn**:

- **relevance** — query-dependent; the turn's fingerprints against the unit's. This is what
  `context_search` already scores (the query·key term).
- **priority** — query-independent state carried across turns: how much the unit has mattered and is
  likely to again (the bias term). Derived from L0 only: +boost on fetch/edit, decay with turns
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

All six: **NEVER TESTED.** The recorded blocker for every one was `eligible: false, status:
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

**H4 detector status:** `detectAttentionSignals` is implemented and has been run over a real corpus;
its fire rate is in the companion report. That number is a result about **four regexes**, not about
H4 — see Rung 0b, which replaces the instrument. The operator's framing is explicit that a
sufficiency phrase is **evidence for reassessment, never permission or an irrelevance label.**

---

## 3. THE OPERATOR'S HYPOTHESES FROM THIS CONVERSATION THAT WERE DROPPED

These are first-class, not addenda.

**HR1. The retrieval tool is optimised for FACT retrieval, not structural context — and that, not a
missing ledger, may be why multi-step tasks starved.**
`context_search` returns the best-matching *events* with a short excerpt each, which is tuned for
"find the literal." A multi-step coding task needs **broader contextual data — file and tree
structure, module layout, API surfaces** — which a short event excerpt cannot carry. So the
retrieval arm's failures on the multi-module scenario (run-command loops with plenty of headroom)
have at least two competing explanations, and the record pursued only one:

- (a) no ledger of completed steps → the model re-investigates
- (b) **the retrieval unit is wrong for the turn type** → the model never gets structure, so it
  probes with `run_command` instead

These must be **ablated separately.** An earlier pass asserted (a) as *the* defect; that was
unjustified. **Status: NEVER TESTED.** Note this is H2 ("breadth follows the horizon") instantiated
concretely — a planning/edit turn needs a different retrieval unit than a fact turn.

**HR2. Keep the FULL results of context-retrieval tool calls in context.**
For structural tools (graft, tree/file listings, `context_search` results), preserve the **whole
payload** rather than an excerpt. Rationale: excerpting a structural result destroys the structure,
which is the thing being retrieved. Distinct from `selectPayload`'s whole-vs-excerpt on *file
reads* — this is about retrieval/structural results specifically.
**Status: NEVER TESTED live.** Offline, whole-vs-excerpt on file payloads is the one payload
intervention that measured a difference; structural selection reported `unsupported_structure` on
every payload it was offered, i.e. **no verified structural partition exists yet** — build one
before treating this as testable.

**HR2-INVARIANT (not a hypothesis — a design rule; operator-set 2026-09-09). Do NOT re-retrieve a
tool result.** When the *model* calls a retrieval-shaped tool (graft, Serena/LSP, tree/file listings,
`context_search`), that tool has already run search→retrieve→rank and returned a minimal, ordered,
structure-preserving payload — it *is* a retriever. Interception of that result is for **retention**
(admit / evict the whole unit across turns, topic-scoped per HR3), **never for re-retrieval**. Running
a curated tool output back through our own chunker + grep/vector + ranker is damaging and can only lose
information: (1) it re-ranks with a weaker surface signal on top of graft's code-graph ranking; (2) it
fragments coherent structural units (a char chunker splits a function mid-body); (3) it can demote the
very content the model explicitly fetched out of the window (the §8 demotion mechanism, now applied to
a deliberate fetch); (4) it is a redundant second retrieval over an already-retrieved result (data-
processing inequality — post-processing adds no signal). This is the same principle as HR2 ("excerpting
a structural result destroys the structure") and the D15 ingestion boundary ("ingestion produces
coordinates, retrieval answers questions"): a live tool result is captured to L0 **verbatim** and its
*lifetime* is managed, not its *content*.
*Where each stage applies:* our chunk/rank pipeline runs only on **retrieval we initiate** from history
(`context_fetch`/`context_search` over L0), never on inbound live tool results. In opencode-plugin
terms: `tool.execute.after` = capture + provenance-tag + (if it overflows) size-bound **by the source's
own ranking**, never re-rank with a competing retriever; `experimental.chat.messages.transform` =
admit/evict the whole unit. *Corollary for the interleave/fusion arms (Rung 0e Phase 2):* fusion is for
candidates from retrievers **we** run and assemble; a single tool the model invoked is already one
retriever's curated result — retain or evict it whole, do not dilute it by fusing or re-ranking.
*The one legitimate reduction* of a huge tool result is truncation that preserves the source's order
(keep graft's top-N units, drop the tail it already ranked last) — a structure-preserving cut, not a
re-rank.

**HR3. Model-signal-keyed retention (the operator's own framing of H4).**
When a model researches and then says *"I have enough data to continue"*, that is a signal we can
key off — both to stop adding exploratory context and to decide what to RETAIN. Also its inverse: a
topic shift is a signal to release dormant history.
**Status: NEVER TESTED.** See H4 and Rung 0b: the shipped detector is the wrong instrument, so it
has never run against a corpus where it could fire.

---

## 4. THE SOFT OCCUPANCY TARGET

**HA. Soft target window.** Operate at a soft target of **25–50% of W_max**, with overruns allowed
per turn and eviction back to target once results are seen. `f` to be **measured, not set**.
**Status: NEVER TESTED. Not withdrawn and not rejected** — the operator clarified it is not a hard
requirement, which is not the same as withdrawing it. `algorithm.md` recorded it as "withdrawn by
the user"; that was a mischaracterisation, and the standing status is the one stated here.
Notes:

- Expressed as a fraction of the **window** it was untestable on the traces then available.
  Expressed as a fraction of **measured demand** it is the right axis. §0/S9: use the real-session
  corpus.
- Related unmeasured half: *filling* unused space up to the target, and *pruning* early history to
  hold it, are both testable arms, not rules.
- The `prefix-plus-retrieval` design already operates at a low occupancy fraction and grows only
  when a turn needs it — i.e. something close to the soft target is an already-existing arm's
  emergent behaviour, and it has never been isolated as a variable. Isolating it is the test.

---

## 5. THE HAND-OFF QUEUE (§13) — ordered, and where the loop was supposed to start

1. **`prefix-plus-retrieval`** — the Q&A leader on the retrieval question set and the operator's own
   design. Two named open defects:
   - **D-a. Excerpt window.** An answer literal can sit outside the excerpt of a correctly ranked
     event. Iterate: excerpt centred on the **rarest matched term**, or on the **matched line
     span**. *(A prior offline check of first-vs-rarest anchoring was degenerate — the payloads it
     was handed had no query fingerprints, so no anchor could differ. Rung 0a fixes that and reports
     the term counts.)*
   - **D-b. No ledger of completed steps.** The arm stalled in consecutive `run_command` turns with
     ample headroom on the multi-module scenario. Iterate: a running "done so far" ledger inside the
     recency slice (branch summaries are the obvious source).
     **See HR1 — (b) is a competing explanation for the same failure and must be ablated separately.**
   - Then the soft target `f` of §12.
2. **Per-turn window management** (eviction shipped in core) — "the mechanism any design runs on."
   Iterate: the soft target; and **layout R** — tail rendered **newest-first** so eviction is a
   suffix cut and write-free. *(Layout R: NEVER TESTED.)* Note §0/S7 on cadence.
3. **Event-hit `context_search`** (shipped) — the unit. `retrieval.eventHits` and
   `retrieval.excerptChars` are host values from the published interface, unvalidated here.
   Iterate: sweep both offline on the recovered queries (Rung 0c), then **derive them from headroom
   and event size** rather than fixing them.
4. **Zone B** — demoted from retrieval to two candidate roles, **both unmeasured**: (i) a **task
   ledger** on multi-step work, (ii) **cache-shape** on long sessions. "Do not tune its ranking
   further; the deep set cannot see it."

---

## 6. ZONE B, RE-SPECIFIED BY THE OPERATOR

**HZ. Zone B is an INDEX, not content.** A summary's only job is to tell the model it once worked on
X so it can go find X with `context_search`. It is a pointer; it must never be expected to answer
from itself.

- This **reinterprets** the existing measurement rather than contradicting it: a Zone B that
  measures inert on *literal recall* is behaving correctly as an index, and was previously read as a
  failure.
- Therefore the endpoint changes: **does Zone B raise the rate of successful retrieval**, not can
  the model answer from Zone B. Rung 1a.
- Implemented as `buildTopicIndex`/`renderTopicIndex`. Its token cost is measured (report §7 pointer
  table). **Efficacy NEVER measured.**
- Related: headlines as **keyword fingerprints** (file paths, identifiers), not prose. Offline
  ranking improved with event-keyword enrichment and headline-only rendering is far smaller than
  full prose; **efficacy of keyword-list headlines never measured live.**

---

## 7. IMPLEMENTED BUT NEVER MEASURED LIVE

Each has a mechanism-can-fire gate on record and **zero production callers** —
`packages/core/src/attention/*` and `ZoneAssembler` are orphaned because their consumer (the
harness) was deleted. Gate outputs are in the companion report; what matters here is the gate's
*standing*, because a gate that was starved of inputs has not actually cleared (§0/S10).

| Mechanism | Gate standing | Live status |
| --- | --- | --- |
| `evictRederivable` (dependency-tracking) | **Passed** on a real trace; fires at every cadence tested | NEVER |
| `isRederivable` | **Passed** — deterministic from tool name; unknown tool → `undefined` → kept, never dropped | NEVER |
| `selectAttention` priority channel | **Passed** on admission with real edit-provenance edges, but `boost`/`halfLifeTurns` were **inert in the zero-relevance limit** — the gate cannot discriminate them without query fingerprints. **Re-gate with fingerprints present before any live arm.** | NEVER |
| `selectPayload` whole/excerpt/structural | **Partial** — whole-vs-excerpt fires on file payloads; **structural reported `unsupported_structure` on every payload**, so that path has no verified partition | NEVER |
| `buildTopicIndex` | **Passed** — cost measured | NEVER |
| `detectAttentionSignals` | **Wrong instrument** (Rung 0b), not a failed gate | NEVER (never fired) |
| `ZoneAssembler` window enforcement + delivery receipts | **Passed** — unit-tested; elastic tail replayed offline with no overflows | NEVER in production |

---

## 8. OTHER UNMEASURED ITEMS ON THE RECORD

- **Reply fraction** `0.05·W` — **retired as a sweep by F4**: the reserve is the host-declared
  `Model.limit.output`, not a fitted fraction of W. Residual question in F4.
- **`retrieval.limit`** — unvalidated. The untested direction is **shrinking** the hit list, not
  enriching it (enriching is on the do-not-retry list, §0/S3). Rung 0c.
- **Mode B / D14** — "Zone A stays frozen and small (3–4 tool schemas instead of the host's full
  toolbox) → larger stable cache prefix" and "eviction/offload centralised". **Never measured**;
  §19 Q5 makes the Mode B default conditional on exactly this evidence.
- **D5** — "prefix-keyed caches: middle edits invalidate suffix; caching rewards stable layout, not
  minimal payload." Asserted. The §17 cache assertion harness is the named instrument and it
  survives in `packages/core/test/`.
- **D1** — that tool-type-transition segmentation is as good as content clustering. Asserted.
- **The quadratic-savings value claim** — that savings compound on large windows. Unmeasured.
- **The overflow regime itself** — the tree's value hypothesis is sessions ≫ window. No trace *from
  the old harness* ever reached it; the real-session corpus does (§0/S9, Rung 0 assets).
- **The score hypothesis** — *that a shorter, better-curated context makes the model reason better.*
  **No lens ever refuted it and no experiment ever tested it.** External motivation: needle-style
  retrieval benchmarks saturate near ceiling while RULER-style and realistic long-document QA
  degrade badly at length. This is the endpoint that can vindicate the whole programme, and every
  measurement so far argued cost/latency instead.

---

## 9. WHAT MAKES ALL OF THIS TESTABLE NOW

opencode exposes the seams, **verified in the shipped 1.18.27 binary** (not just in type
declarations). Read F1–F4 above before using any of them — two of these rows are wrong without F1.

| hook | gives us |
| --- | --- |
| `experimental.chat.messages.transform(input, output)` — the array is mutable **in place** (F1) | rewrite the message array before it reaches the LLM — eviction, admission, soft target, Zone B substitution, ledger injection, layout R |
| `experimental.chat.system.transform` — `output.system: string[]` | Zone A. Note F2: Zone A is assembled *after* the message transform, so it is already out of that hook's reach |
| `tool.execute.after` | shape tool results — HR2 (whole retrieval payloads), D-a (excerpt centring), H5 (demand expansion) |
| `chat.message` | observe the model's own text → H4/HR3 sufficiency and topic-shift signals |
| `experimental.session.compacting` / `.compaction.autocontinue` | replace or disable opencode's own compaction so it is not a confound (F3) |
| `tool.definition` | Zone A tool-schema size (Mode B's claim) |
| PluginOptions `plugin: [[name, {…}]]` | **each arm is one options object on one plugin** |

Four properties that make this safer than what failed:

1. **opencode owns the tool-call representation on both sides of the hook.** We receive its faithful
   `{info, parts}` and return the same shape. S4's bug is structurally impossible.
2. **The gate that would have caught S4 becomes a unit test:** assert no transform ever drops a
   `ToolPart` while keeping the assistant text that announced it.
3. **Measurement needs no instrumentation** — opencode records
   `tokens: {input, output, reasoning, cache:{read,write}}` per assistant message, readable via
   `opencode export`.
4. **The plugin is the window enforcer**, so W is an arm parameter and every arm shares one
   budget-enforcement code path — removing a confound the old arms had.

**Corpus available:** the LHTB clone survived with its full task set (pristine/reference gates
passed — see report). Its zero-LFS `continue_until_timeout` tasks at ≥240 expert-minutes are long
enough to reach the overflow regime at W=131,072.

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
