---
name: experiment-report
description: "Write the report for a completed experiment in this research repo. Enforces a fixed structure (Abstract, glossary, Experimental setup, Results, What we got wrong, Conclusions, Caveats), data-generated numbers, and the validity checks this project has learned the hard way. Use after ANY experiment finishes — offline replay, live sweep, pilot, probe, ablation, or re-analysis — and before reporting a result to the user or committing it. Triggers on: experiment finished, run complete, write the report, report the results, report-*.md, results-*.json."
---

# Writing an experiment report

This is a **research repo targeting a paper**, not a product. An experiment that has run but has
no report has not produced a result. This skill defines what a report must contain and what must
be true before one is written.

Every rule below exists because it was violated and cost something. The parenthetical is the
incident.

## 1. Before writing anything: is there a result to report?

Answer these in order. A "no" stops the report and you say so plainly.

1. **Did the pre-registered falsification condition actually fire?** Compare the measured number
   to the written bar, literally. (*A gate specified at ">50% of turns" was declared to have
   "fired" at 31.7%, and escalated into a recommendation to change shipped defaults.*)
2. **Are the validity conditions met?** Every experiment must state, before running, what makes a
   run interpretable. Check each one. If a validity condition fails, the run is an
   operating-point miss, **not evidence** — report it as void and say what to change.
   (*oracle 0/10 vs random 0/10 read as a null, when the control arm had written zero files in
   10/10 runs: it had stopped attempting the task, so the contrast measured nothing.*)
3. **Is a control arm still doing the task?** A baseline that has collapsed is not a floor.
   Record a behavioural liveness metric (files written, tools called, progress made) and gate on it.
4. **Are the arms matched on what matters?** Volume matching is necessary and *not sufficient*.
   Also report unit count and fragmentation/splice count. (*Arms matched to 0.2% on tokens
   diverged 1.7× in unit count and 5.5× in splice count.*)
5. **Is the treatment arm actually varying?** A signal that is near-constant across candidates
   makes the arm a silent no-op. Report its dispersion. (*A fingerprint shared by every Python
   module pinned a signal near zero and made an entire arm inert.*)
6. **Is the "new" signal a relabelling of an old one?** Report its rank correlation with every
   incumbent, and against a pre-registered threshold.
7. **Is the comparison like-for-like?** If you claim a replication or a non-replication,
   reconstruct every difference in unit of analysis, candidate pool, corpus, metric and budget
   first. (*A "did not replicate" was a different measurement entirely; on the original's own
   corpus and budget it was a null.*)

## 2. Required structure

Exactly these sections, in this order. No "Executive summary" — it is an **Abstract**.

### Abstract
A research-paper abstract: **the problem, the experiment, the conclusion.** Prose paragraphs,
no bullet lists. A reader who stops here must come away with the finding and its main limit.
State a negative or void outcome as plainly as a positive one.

### What you need to know to read the rest
A glossary table. **Define every term before it is used** — including ones that feel obvious
inside the project: agent, transcript/context, token, unit, eviction, arm, run/cell, the task,
and every metric and statistic named later (odds ratio, p-value, AUC, recall@M, the bootstrap,
any Greek letter). Assume the reader has not followed this project.

### Why we ran this
The motivation and the prior state of the question. What was already known, what was ambiguous,
and what this run was supposed to settle.

### The experimental setup
Concrete enough to picture without opening the code:
- **The task** — what the agent is actually asked to do, what files it writes, how it is graded,
  and whether the grader is held out. (*A report said "the agent wrote zero files" without ever
  saying what files it was supposed to write.*)
- **The corpus or substrate** — which transcripts/instances, how many distinct sessions or
  problems (not just repeats), how many turns and candidate rows.
- **What was varied**, and what was held fixed.
- **What was recorded** per run, including the validity metrics from §1.
- **Why this substrate** — and what it cannot show.

### Results
Tables and charts. Report **all** pre-registered cells, not the most favourable one. Give
intervals, and say what the resampling unit is. Separate pre-registered results from post-hoc
exploration and label the latter as such.

### What we got wrong
Every claim withdrawn or corrected since the work began, in plain language, with what the
corrected analysis says instead. **This section is mandatory and is never omitted for being
unflattering.** If nothing was withdrawn, write "Nothing was withdrawn."

### Conclusions
What is now established, what it licenses, and — precisely — what it does not. Distinguish
"tested and rejected" from "untested": they are not the same and this repo treats the confusion
as a defect.

### Caveats
The limits that survive. Always state: how many *problems* (not repeats), which model, whether
the measurement vehicle is the deployment vehicle, and any confound left open.

## 3. Rules for the numbers

- **Generate the report from the results file.** Write `report-<name>.mjs` (or `.py`) that
  interpolates every number from `results-*.json`. Hand-typed numbers drift from the data.
- **Lookups must throw, never render.** Optional chaining silently produces prose like "sent
  prompts of undefined tokens". Make missing data a hard failure.
- **Pin inputs explicitly.** A directory glob silently folds a new batch into every statistic
  while the prose keeps quoting the old cells.
- **Round medians.** A median over an even-sized group lands on a half-token; that is false
  precision, not data.
- **Verify the report renders**: both `.md` and `.html`; HTML self-contained with inline SVG
  (no CDN, no external refs) and every SVG must parse as XML; zero occurrences of `undefined`
  or `NaN`; the section list must match between the two formats.
- **Cross-check any statistic you implement** against a reference (`scipy`, `statsmodels`) and
  say in the report that you did.
- **Name the resampling unit.** (*An i.i.d. resample of autocorrelated turns was documented as a
  block bootstrap; every interval was 1.3–1.6× too narrow.*)

## 4. Rules for the claims

- **Effect size and direction, not just significance.** Report the measured magnitude against the
  measurement floor. If an effect is within the floor, that is the finding — say so.
- **Adjust for what is unbalanced.** If an arm or condition appears only in some cells, it is
  confounded with whatever varies across them; adjust and report both figures.
  (*Omitting a control that appeared only at one setting inflated an odds ratio by 25%.*)
- **Distinguish the estimand from its proxy.** State what the outcome measure actually is and what
  it stands in for. (*"Next-token likelihood of a recorded continuation" is not "the agent can
  still do the task".*)
- **Beware definitional wins.** If the subset was selected on a property, a signal keyed on that
  property will lose on it by construction. Contrast against a signal-free floor instead.
- **A ceiling cannot rank policies.** If everything passes, the measurement refutes a claimed
  deficit and nothing more.
- **Withdraw cleanly.** When a number changes, state the old claim, the new one, and why —
  in the report, not only in conversation.

## 5. Finishing

1. Run the generator; validate per §3.
2. Re-read the Abstract against the Results. They must agree.
3. Update `reports/session-handoff.md`: the backlog item's status, and any constraint (C-numbered)
   the result changes.
4. If the result changes a D-numbered decision in `docs/IMPLEMENTATION_PLAN.md` or a rule in
   `reports/algorithm.md`, say so and update the decision row — never silently diverge.
5. Report to the user in plain language: what was asked, what was found, what is still open.
   Lead with the finding, not the methodology.
