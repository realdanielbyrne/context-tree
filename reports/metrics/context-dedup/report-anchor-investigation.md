# Can you make a model use what it already has, by reminding it that it has it?

*A three-study investigation of "attention anchors". Self-contained: every term is defined below.*

Artifacts: `results-dv4-anchor-dedup.json`, `results-anchor-replay-v2.json`
Code: `experiments/context-dedup/{anchor-index,dv4-anchor-dedup,anchor-replay}.mjs`
Companion reports: `report-dv4-anchor-dedup.md` (cost study), `report-anchor-replay.md` (behavioural study)

---

## Abstract

A transformer gives less weight to tokens that are far back in its context and rarely mentioned
since. Agent transcripts show a matching behaviour: an agent that needs a file it already read will
often read it again rather than use the copy sitting in its own context. Every such re-read appends
a duplicate, and the duplicate is then re-transmitted on every subsequent turn.

The proposed fix is a small one. When a tool is about to return content the model already has,
return a short sentence pointing at the existing copy instead — *"Remember our earlier conversation
about X"* — on the theory that a fresh mention of an old topic raises the weight the model places on
those older tokens.

We tested three things, in order, each with a pass/fail line drawn in advance. **Is the saving worth
having?** No: 0.22% of real token cost, against a 10% bar. **Does the model accept the reminder
instead of re-reading?** Not reliably: it proceeds 41.7% of the time, against a 70% bar. **Is it the
*reminder* that works, or would any refusal to hand over the file do just as well?** Here the idea
holds: the reminder beats a refusal of identical length by 27.8 percentage points (p=0.0063), and a
question answerable only from the distant original copy is answered just as accurately as when the
file is handed over in full (86.1% vs 83.3%, p=1.0) while using about a tenth of the tokens.

The overall picture is a real result about attention with no deployment case attached. The model
*can* reach back and use what it already has, and naming the topic measurably helps it do so — but
it prefers to re-fetch anyway when nothing stops it, and the duplicated bytes in real sessions are
too few for suppressing them to matter.

---

## 1. What the idea is, and what the words mean

### The intervention

When a tool call would return content that is **already resident** — already present somewhere
earlier in the conversation the model is being sent — substitute a short referential sentence for
the content:

> `[Remember our earlier conversation about reports/algorithm.md — "# The assembly algorithm" —`
> `which you read at turn 12. It is above in this conversation, unchanged; use it rather than`
> `re-reading.]`

That is an **anchor**. It is ~247 characters where the content it replaces is ~2,694 — about eleven
times smaller.

### Why this is worth trying at all

Most schemes for shrinking an agent's context lose money under **prompt caching**. Providers charge
a discount for tokens that match a previously-cached prefix (about 0.1× normal) but a premium to
write a new one (1.25–2.0×). Anything that *rewrites* the conversation — dropping old turns,
reordering, compressing in place — invalidates the cache from the edit point onward and pays that
premium on everything after it.

An anchor does not rewrite anything. It simply declines to append. The conversation stays
append-only and the cached prefix is never touched, so the saving is not repaid as cache writes.
That reasoning was confirmed (§4.1) even though the saving turned out to be small.

### The arms being compared

| name | what the tool returns | why it exists |
|---|---|---|
| **baseline** | the real file content | what happens today; the behaviour to match |
| **anchor** | the referential sentence above | the proposal |
| **placebo** | neutral filler padded to **exactly** the anchor's length, containing no path, no topic, and no reference to anything earlier | the control that makes the claim testable |

The placebo is the crux of the design. Without it, an anchor that "works" could be explained
trivially: any refusal to hand over a file might push a model to look at what it already has. Making
the placebo identical in length — **0 characters of difference on every single event** — means any
gap between anchor and placebo is attributable to *what the sentence says*, not to how much was
withheld.

Two variants of the policy were priced in the cost study:

- **anchor-strict** — substitute only when the resident copy is byte-for-byte trustworthy *and* the
  file has not been edited since. Provably honest: everything the anchor asserts is true.
- **anchor-diff** — also substitute for files edited since, supplying the model's own edit hunks so
  it can reconstruct the current state. Covers more cases, but asks for reconstruction rather than
  recall.

### The two things measured on the model

- **Acceptance** — the model is given the arm's output and takes one turn. If it fetches the same
  file again (by a read call, or `cat`/`head`/`sed` in a shell), that is a rejection. Otherwise it
  *proceeded*. Acceptance is the percentage that proceeded.
- **Needle recall** — the model is asked to quote the line of the file containing a given cue, where
  the answer token appears **exactly once in the entire conversation**, inside the original copy. It
  therefore cannot be guessed and cannot be found anywhere but the resident original. This measures
  whether the model can actually *use* distant content, as distinct from whether it chooses to.

### The three pass/fail lines, fixed in advance

This repository's house rules require writing down, before running anything, the result that would
kill the idea — otherwise a disappointing number can always be reinterpreted afterwards. Those
written-down conditions are numbered **F1, F2, F3** ("falsification condition 1, 2, 3"). Named for
what they test:

| | short name | the claim it tests | the claim dies if | outcome |
|---|---|---|---|---|
| **F1** | **the Cost condition** | Suppressing resident bytes saves enough to be worth doing. | suppressible content is **< 10%** of prompt tokens, cache-adjusted | **FAILED — claim rejected** |
| **F2** | **the Acceptance condition** | The model accepts the anchor rather than re-fetching. | acceptance **< 70%** | **FAILED — claim rejected** |
| **F3** | **the Mechanism condition** | It is the *reference* doing the work, not the withholding. | anchor beats placebo by **< 15 points** on acceptance or recall | **PASSED — claim survives** |

F1 is a cost question and was settled offline with no model involved. F2 and F3 are behavioural and
required running a model. **F1 does not gate F2 and F3**: a policy can be not worth deploying and
still tell us something true about how attention works.

---

## 2. Method

### Corpus

Four real Claude Code sessions (`claude-code-session{,-2,-3,-5}.jsonl`). A fifth file,
`claude-code-session-4.jsonl`, is **excluded**: all 307 of its message identifiers appear in
session-5, which is a resumed superset of it. Counting both would double-count a third of the
corpus — a defect in every earlier analysis in this directory that said "five fixtures".

### The cost study (F1)

Each arm replays the event stream through the repository's own provider-cache simulator and prices
it with Anthropic's input multipliers at both the 5-minute and 1-hour cache-write tiers. All arms
are append-only, so they differ only in how large the appended blocks are, never in the shape of the
prefix — no arm pays a rewrite penalty.

### The behavioural study (F2, F3)

Only **8** genuinely anchorable re-reads exist in the whole corpus (§4.2), which cannot support a
percentage. So the *trigger* is synthesised while the *context* stays real: take a real transcript
prefix in which file F was genuinely read, append a synthetic read call for F, substitute the arm's
output for the result, and let the model take one turn. The prefix, the resident copy and the file
are all real; only the re-read is manufactured.

36 events, 17 distinct files, prefixes from 1.2k to 189k tokens (median 81k), capped at 3 events per
file so no single heavily-re-read file dominates. Model: Qwen3-27B, temperature 0, thinking
disabled.

**Paired.** All three arms see the identical prefix and the identical needle question, so how hard a
given event is cancels out. The statistic is an exact two-sided McNemar test on discordant pairs —
the events where two arms disagreed.

**A structural guard.** This repository previously deleted an evaluation harness because its message
type could not represent a tool call, so it replayed tool results as ordinary user text and silently
invalidated every comparison it had produced. To prevent a repeat, an integrity check asserts that
every tool call has a matching result and that no result is ever emitted as user text — and it
throws rather than warns. It earned its place: during a trial run it caught a real defect where
truncating a prefix at one tool result orphaned sibling calls from the same message.

---

## 3. Results

### 3.1 The Cost condition (F1) — failed

| arm | fires | effective cost, 5-min tier | 1-hour tier | saving |
|---|---|---|---|---|
| baseline | 0 | 28,027,311 | 28,721,825 | — |
| anchor-strict | 43 | 27,576,330 | 28,262,054 | **1.61% / 1.60%** |
| anchor-diff | 56 | 27,526,920 | 28,212,412 | 1.79% / 1.77% |

Measured against what the four sessions **actually sent**, per their own logged token counters, the
same absolute saving is **0.22%**. The simulated prompt stream is 7.4× smaller than reality, so the
1.61% figure flatters the result; both are reported.

Against a 10% bar, the Cost condition fails under every denominator.

### 3.2 Why the saving is small — the motivating statistic does not survive translation

The work was motivated by a measured "59.2% of file reads are re-reads". That is a statistic about
**paths**, and an anchor can only act on **bytes**. Over 139 read calls:

| | count | share |
|---|---|---|
| first read of a path | 70 | 50.4% of reads |
| **repeat read of an already-read path** | **69** | **49.6% of reads** |
| ── asking for a **different slice** (`offset`/`limit`) | 55 | 79.7% of repeats |
| ── the file was **edited since**, so the resident copy is stale | 35 | 50.7% |
| ── bytes exactly match a resident copy | 6 | 8.7% |
| ── bytes contained in a resident copy | 13 | 18.8% |
| ── **truthfully replaceable by an anchor** | **8** | **5.8% of all reads** |

Agents re-read *paths*, not *bytes*. Half of the repeats follow an edit that invalidates the copy,
and most of the rest are too small for a ~247-character anchor to be worth substituting.

It is also the wrong place to look. Read results are only **18.4%** of appended content; tool-call
arguments (the model's own file writes and edits) are **33.9%**, other tool output **27.2%**, and
assistant prose **20.5%**.

**How far could any such policy go?** Not a fixed number — it depends entirely on the matcher:

| matcher | duplicated share of appended content |
|---|---|
| block-level, exact + containment, ≥200 characters | 5.1% |
| the same with no size floor | 6.6% |
| **line-level** (suppress any line ≥20 chars seen anywhere before) | **19.0%** |

A line-level encoder would clear the 10% bar. So the negative result is about *this shape* of
policy, not about deduplication in general. Whether a line-level scheme is safe to hand a model is a
separate and much harder question that nothing here addresses.

### 3.3 The Acceptance condition (F2) — failed; and the Mechanism condition (F3) — passed

| arm | proceeded | re-fetched | errored | **acceptance** | **needle recall** |
|---|---|---|---|---|---|
| baseline (file handed over) | 21 | 9 | 2 | **58.3%** | **83.3%** |
| **anchor** | 15 | 21 | 0 | **41.7%** | **86.1%** |
| placebo (same length, no reference) | 5 | 30 | 1 | **13.9%** | **77.8%** |

Paired comparisons, exact two-sided McNemar, n=36:

| comparison | measure | difference | p |
|---|---|---|---|
| **anchor vs placebo** | acceptance | **+27.8 points** | **0.0063** |
| anchor vs placebo | needle recall | +8.3 points | 0.453 |
| anchor vs baseline | acceptance | −16.7 points | 0.109 |
| anchor vs baseline | needle recall | +2.8 points | 1.000 |

Three readings:

**The reference does real work.** Anchor beats placebo by 27.8 points at p=0.0063. The two strings
are the same length to the character, so this is not a volume effect. The competing explanation —
that withholding alone makes a model look back — is refuted: the placebo collapses to 13.9%.

**But acceptance is too low to deploy.** 41.7%, against a 70% bar. It is not statistically worse
than handing over the file (p=0.109), but it is not good enough to build a policy on.

**Recall is unharmed.** On a question answerable only from the distant original, the anchor scores
86.1% against the baseline's 83.3% — indistinguishable (p=1.0) — while supplying about a tenth of
the tokens.

This combination is the informative one. The model **is** able to reach back and use content it
already has; the anchor does not damage that at all. What it does not do is reliably stop the model
re-fetching when nothing prevents it.

Two supporting observations. Acceptance is **flat across distance** — 38% for prefixes under 20k
tokens, 39% for those over — so this is not distance-driven forgetting. And every re-fetch is a
*targeted range read* (`sed -n '150,230p'`), never a wholesale re-read: the model has not forgotten
it has the file, it is choosing to re-verify a specific region.

---

## 4. Conclusions

1. **The central hypothesis survives its own test.** Referencing earlier content measurably changes
   behaviour, and the effect is attributable to the reference rather than to the withholding: +27.8
   points over a character-identical non-referential control, p=0.0063. This is the one claim of the
   three that was genuinely about attention, and it held.

2. **The failure is behavioural, not attentional.** Content recall with an anchor is statistically
   identical to having the file handed over, at a tenth of the tokens. The resident copy is
   reachable and is used correctly when the model is asked about it. The model simply prefers to
   re-fetch when free to do so — and when it does, it fetches a specific range, not the whole file.

3. **There is no cost case.** The saving is 0.22% of real token spend. Duplicated file content is
   only 5.8% of reads and read results are only 18.4% of context, so there is very little to take.

4. **The negative result is narrower than it first appears.** A line-level matcher reaches 19.0% on
   the same corpus. What is rejected is block-level referential substitution, not deduplication.

5. **The motivating statistic was about paths, not content.** "59.2% of reads are re-reads" is path
   repetition; the content equivalent is 5.8%. Any future proposal resting on re-read frequency must
   say which of the two it means.

6. **Two thresholds were set badly, in the same way, twice.** The 10% cost bar was chosen before
   computing what was achievable; the 70% acceptance bar was chosen before learning that handing the
   file over achieves only 58.3%, which made it unreachable. The first report noted this error in its
   own conclusions and the second one then repeated it. The lesson is to measure the ceiling before
   drawing the line — and the paired anchor-vs-baseline comparison, not an absolute rate, is what
   should have been pre-registered for acceptance.

---

## 5. What is tested, and what is still open

**Tested.** The size of the opportunity for block-level referential substitution, offline and
cache-priced on four real sessions, deterministically. That a referential anchor beats a
length-matched non-referential control on acceptance (p=0.0063) and costs nothing in content recall
(p=1.0), on one model, on a synthesised trigger over real context.

**Open.** Whether any of this transfers to a frontier model — the behaviour that motivated the work
was observed on one, and the model tested here has no measurable difficulty recalling distant
content in the first place. Whether a stronger anchor, naming the specific region rather than the
file, raises acceptance. Whether a line-level scheme is both large enough and safe. Whether
acceptance matters at all, given the cost case is already gone.

---

## 6. Caveats

- **The trigger is synthesised.** The model did not itself ask to re-read; the call was inserted.
  Prefix, resident copy and file are real; the re-read is not.
- **Cross-model replay.** Transcripts were produced by a frontier Claude model and continued by
  Qwen3-27B. The *paired* comparisons between arms are sound; the *absolute* rates are not an
  estimate of what the original model would have done.
- **One model**, and one with no measured distal-recall deficit — it scored 90/90 on a
  needle-in-haystack probe and 6/6 at 60k tokens. A model that genuinely loses distant content might
  benefit more from an anchor, or might be unable to use one at all.
- **Small samples throughout.** The behavioural result rests on 36 paired events and 12 discordant
  pairs. The needle comparisons (p=0.45, p=1.0) are underpowered and support no claim. On the cost
  side, two of the four sessions save nothing and one supplies 88% of the total — effectively n=1.
- **Self-referential corpus.** This is the project's own agent reading the project's own source and
  planning documents.
- **Simulated cache accounting**, not live provider counters, and **no cache expiry is modelled** —
  the mechanism most likely to overturn a caching result, since the saving depends on each removed
  token being re-charged on hundreds of later turns.
- **A `chars/4` token estimate**, not a real tokenizer. It ranks large differences; the gap between
  anchor-strict and anchor-diff is below what it can resolve.
- **The needle is verbatim line-quoting**, which is more brittle than the task-relevant use of
  content. The anchor arm's four wrong answers are confident near-misses — a real but different line
  — not invention, but they are stated without hedging.
- **Corpus-specific.** Claude Code clips tool output and supports ranged reads, which is *why* 80% of
  repeats ask for a different slice. A harness without ranged reads would show more duplication.
- **Thinking blocks in the fixtures are redacted**, so the replayed prefix shows the prior model
  acting with no visible reasoning.
- **The first version of the cost report contained four blocking errors**, found by adversarial
  review and listed in `report-dv4-anchor-dedup.md`. Most notably it claimed no deduplication design
  could exceed 5.1%, which is false. The direction of its conclusion survived; several magnitudes
  did not.
