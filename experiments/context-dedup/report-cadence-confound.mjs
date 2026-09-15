/**
 * CORRECTION REPORT — the eviction-cadence result was confounded by achieved peak.
 *
 * Regenerates from the raw cells every time, so the numbers in the prose cannot
 * drift from the data. Emits report-cadence-confound.{md,html}; HTML is
 * self-contained (inline SVG, no CDN).
 *
 * Rerun: node experiments/context-dedup/report-cadence-confound.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CADENCE_FILES, loadCappedCells, peakRegression } from './peak-regression.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'reports', 'metrics', 'context-dedup');
const load = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'));

// PINNED, not globbed (see peak-regression.mjs). A directory glob would silently fold a
// new batch into every regression and table while the prose kept quoting old cells.
const FILES = CADENCE_FILES;
const cells = loadCappedCells(OUT, FILES);

const med = (x) => { const s = [...x].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const groups = new Map();
for (const c of cells) {
  const k = `${c.cadence}|${c.W}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(c);
}
const rows = [...groups.entries()].map(([k, cs]) => {
  const [cadence, W] = k.split('|').map(Number);
  return { cadence, W, n: cs.length, passes: cs.filter((c) => c.pass).length,
    rate: cs.filter((c) => c.pass).length / cs.length,
    // rounded: a median over an even-sized group lands on a half-token, which is
    // meaningless as a token count and reads like false precision in the prose
    peak: Math.round(med(cs.map((c) => c.peak))),
    evictions: Math.round(med(cs.map((c) => c.evictions))),
    tokens: Math.round(med(cs.map((c) => c.tokens))) };
}).sort((a, b) => a.peak - b.peak);

// Logistic regression fitted in peak-regression.mjs so the report owns its numbers.
const { tCad, tW, tPeak, orPeak, orPeakUnadj } = peakRegression(cells);

const f2 = (v) => v.toFixed(2), f3 = (v) => v.toFixed(3), f4 = (v) => v.toFixed(4);
const pct = (v) => `${(v * 100).toFixed(0)}%`;

/**
 * Cell lookup that THROWS rather than interpolating the string "undefined" into
 * prose. Optional chaining short-circuits the whole `?.peak.toLocaleString()`
 * chain, so a missing row silently produced sentences like "sent prompts of
 * undefined tokens" — the worst failure mode for a generated report.
 */
function cell(cadence, W) {
  const r = rows.find((x) => x.cadence === cadence && x.W === W);
  if (!r) throw new Error(`report needs the cadence=${cadence} W=${W} cell and it is not in the data`);
  return r;
}

// The UNCAPPED reference: what this task consumes when nothing is ever deleted.
// Needed to express the success threshold as a fraction of the task's own demand
// rather than of the model's (non-binding) hard limit.
const uncappedPeaks = [];
for (const f of FILES) for (const c of load(f).cells) if (c.window === null) uncappedPeaks.push(c.peak_history_tokens);
const UNCAPPED = uncappedPeaks.length ? Math.round(med(uncappedPeaks)) : null;
const MODEL_WINDOW = 262144;
const fracOfTask = (t) => (UNCAPPED ? `${((100 * t) / UNCAPPED).toFixed(0)}%` : 'n/a');
const fracOfModel = (t) => `${((100 * t) / MODEL_WINDOW).toFixed(1)}%`;

const SAW = cell(10, 4700);      // the sawtooth arm the retracted claim was about
const FLAT = cell(1, 7500);      // the flat arm it was compared against

// ------------------------------------------------------------------- charts
function chartByPeak() {
  const W = 760, H = 340, padL = 62, padR = 24, padT = 44, padB = 66;
  const iw = W - padL - padR, ih = H - padT - padB;
  const xs = rows.map((r) => r.peak), maxX = Math.max(...xs) * 1.06, minX = Math.min(...xs) * 0.9;
  const x = (v) => padL + ((v - minX) / (maxX - minX)) * iw;
  const yv = (v) => padT + ih - v * ih;
  const colour = (cad) => (cad === 1 ? '#4f7cff' : '#e4572e');
  let s = '';
  [0, .25, .5, .75, 1].forEach((g) => { s += `<line x1="${padL}" y1="${yv(g)}" x2="${W - padR}" y2="${yv(g)}" stroke="#e6e6ef"/><text x="${padL - 8}" y="${yv(g) + 4}" font-size="11" fill="#7a7a8c" text-anchor="end">${g * 100}%</text>`; });
  for (const r of rows) {
    const cx = x(r.peak), cy = yv(r.rate);
    s += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(4 + Math.sqrt(r.n) * 1.9).toFixed(1)}" fill="${colour(r.cadence)}" fill-opacity="0.82"/>`;
    s += `<text x="${cx.toFixed(1)}" y="${(cy - 12 - Math.sqrt(r.n) * 1.9).toFixed(1)}" font-size="10" fill="#2b2b38" text-anchor="middle">N=${r.cadence} W=${(r.W / 1000).toFixed(1)}k</text>`;
  }
  [4000, 5000, 6000, 7000, 8000, 9000].forEach((t) => {
    if (t < minX || t > maxX) return;
    s += `<text x="${x(t).toFixed(1)}" y="${(padT + ih + 18).toFixed(1)}" font-size="11" fill="#7a7a8c" text-anchor="middle">${(t / 1000).toFixed(0)}k</text>`;
  });
  s += `<text x="${padL + iw / 2}" y="${H - 22}" font-size="12" fill="#7a7a8c" text-anchor="middle">achieved peak context (estimated tokens actually sent)</text>`;
  s += `<circle cx="${padL + 6}" cy="${H - 8}" r="5" fill="#4f7cff"/><text x="${padL + 18}" y="${H - 4}" font-size="11" fill="#7a7a8c">cadence N=1</text>`;
  s += `<circle cx="${padL + 132}" cy="${H - 8}" r="5" fill="#e4572e"/><text x="${padL + 144}" y="${H - 4}" font-size="11" fill="#7a7a8c">cadence N&gt;1 — same curve, no offset</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><text x="${padL}" y="24" font-size="14" font-weight="600" fill="#2b2b38">Pass rate against ACHIEVED PEAK — cadence cells land on the same curve (area ∝ n)</text>${s}</svg>`;
}

function chartNominal() {
  const W = 760, H = 300, padL = 62, padR = 24, padT = 44, padB = 60;
  const iw = W - padL - padR, ih = H - padT - padB;
  const cads = [...new Set(rows.map((r) => r.cadence))].sort((a, b) => a - b);
  const sub = cads.map((c) => rows.filter((r) => r.cadence === c && r.W === 4700)).flat();
  const bw = iw / Math.max(1, sub.length);
  const yv = (v) => padT + ih - v * ih;
  let s = '';
  [0, .25, .5, .75, 1].forEach((g) => { s += `<line x1="${padL}" y1="${yv(g)}" x2="${W - padR}" y2="${yv(g)}" stroke="#e6e6ef"/><text x="${padL - 8}" y="${yv(g) + 4}" font-size="11" fill="#7a7a8c" text-anchor="end">${g * 100}%</text>`; });
  sub.forEach((r, i) => {
    const bx = padL + i * bw + bw * 0.22, w = bw * 0.36;
    s += `<rect x="${bx.toFixed(1)}" y="${yv(r.rate).toFixed(1)}" width="${w.toFixed(1)}" height="${(yv(0) - yv(r.rate)).toFixed(1)}" fill="#4f7cff" rx="3"/>`;
    s += `<text x="${(bx + w / 2).toFixed(1)}" y="${(yv(r.rate) - 6).toFixed(1)}" font-size="12" font-weight="600" fill="#2b2b38" text-anchor="middle">${pct(r.rate)}</text>`;
    const bx2 = bx + w + 4;
    const peakFrac = r.peak / 9000;
    s += `<rect x="${bx2.toFixed(1)}" y="${yv(peakFrac).toFixed(1)}" width="${w.toFixed(1)}" height="${(yv(0) - yv(peakFrac)).toFixed(1)}" fill="#e4572e" rx="3" fill-opacity="0.85"/>`;
    s += `<text x="${(bx2 + w / 2).toFixed(1)}" y="${(yv(peakFrac) - 6).toFixed(1)}" font-size="11" fill="#2b2b38" text-anchor="middle">${(r.peak / 1000).toFixed(1)}k</text>`;
    s += `<text x="${(bx + w + 2).toFixed(1)}" y="${(yv(0) + 18).toFixed(1)}" font-size="12" fill="#7a7a8c" text-anchor="middle">N=${r.cadence}</text>`;
  });
  s += `<text x="${padL + iw / 2}" y="${H - 12}" font-size="12" fill="#7a7a8c" text-anchor="middle">all cells at the SAME nominal cap W=4,700 — raising cadence raises the peak actually sent</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><text x="${padL}" y="24" font-size="14" font-weight="600" fill="#2b2b38">Blue = pass rate · Orange = achieved peak (k tokens, scaled to 9k)</text>${s}</svg>`;
}

const armMix = (cadence, W) => {
  const cs = cells.filter((c) => c.cadence === cadence && c.W === W);
  const by = new Map();
  for (const c of cs) by.set(c.arm, (by.get(c.arm) ?? 0) + 1);
  return [...by.entries()].sort().map(([a, n]) => `${a}\u00d7${n}`).join(', ');
};
const tableMd = rows.map((r) =>
  `| ${r.cadence} | ${r.W.toLocaleString()} | ${r.n} | ${r.passes}/${r.n} (${pct(r.rate)}) | **${r.peak.toLocaleString()}** | ${r.evictions} | ${r.tokens.toLocaleString()} | ${armMix(r.cadence, r.W)} |`).join('\n');

const MD = `# Deleting context less often did not help — it just kept more context

*A correction. A result this project reported two days ago does not survive re-analysis.*

> **This supersedes the claim recorded in commit \`25e3006\`**, which read: *"Sawtooth beats a wider flat
> window: W=4700/N=10 matches W=7500/N=1 at 100% pass with 15% fewer tokens and 6× fewer evictions."*
> The task-success half of that claim is withdrawn. The cost half survives, restated.

---

## Abstract

An AI coding agent re-sends its whole working transcript to the model on every step, so on a long task the
transcript outgrows the model's input limit and material must be deleted. One tunable in such a system is
**how often** the deletion routine runs: every step, or every few steps. Running it less often is cheaper,
because each deletion invalidates the provider's cache of the prompt prefix, but it allows the transcript to
overshoot the limit in between.

We swept deletion frequency over ${cells.length} runs of a fixed programming task and reported that running
it every 10th step raised task success from 38% to 100% at the same nominal size limit — a large,
apparently free win. **That result was confounded.** The deletion routine was gated behind the frequency
counter, so on steps where it did not run, nothing enforced the limit at all. The less frequently it ran,
the more the transcript was allowed to grow, and the runs labelled with a 4,700-token limit were in fact
sending **${SAW.peak.toLocaleString()} tokens** — more than the runs labelled with a 7,500-token limit
(${FLAT.peak.toLocaleString()}).

Re-analysing all ${cells.length} runs against the transcript size **actually sent** rather than the nominal
limit: deletion frequency contributes nothing once actual size is known (p = ${f4(tCad.p)}), the nominal
limit contributes nothing either (p = ${f4(tW.p)}), and actual transcript size is decisive
(p = ${f4(tPeak.p)}; odds of success multiply by **${f2(orPeak)}×** for each e-fold increase). Deletion
frequency predicted success only because it determined transcript size.

**What survives is a cost result, not a quality one.** At comparable transcript size the infrequent-deletion
runs were materially cheaper — ${SAW.tokens.toLocaleString()} tokens billed with ${SAW.evictions} deletions,
against ${FLAT.tokens.toLocaleString()} and ${FLAT.evictions} for the every-step runs. The design implication
changes accordingly: do not tune deletion frequency expecting better task performance. Tune the quantity that
actually predicts it — how much of the transcript is present when the model is called — and then use deletion
frequency to obtain that quantity as cheaply as possible.

---

## What you need to know to read the rest

| Term | Meaning |
|---|---|
| **Agent** | An AI model given tools (read a file, write a file, run a command) and a goal, running in a loop until it decides it is done. |
| **Transcript / context** | Everything the model sees on a given step: the instructions plus the full history of what it has read, written and run. It is re-sent in full every step. |
| **Token** | The unit context is measured in — roughly ¾ of a word. Counts here are estimates (characters ÷ 4) unless stated otherwise. |
| **Size limit (\`W\`)** | An artificial ceiling we impose on the transcript so that overflow happens quickly enough to study. The model's real limit is 262,144 tokens, far more than this task needs. |
| **Eviction** | Deleting older material from the transcript to get back under the limit. |
| **Deletion frequency (\`N\`)** | How often the eviction routine runs: N=1 means every step, N=10 means every tenth step. The variable this experiment swept. |
| **Achieved peak** | The largest transcript actually sent to the model during a run. This turns out to be the quantity that matters, and it is **not** the same as the size limit. |
| **Run** | One complete attempt at the task under one combination of settings. |
| **Pass** | The task was completed correctly, judged by a hidden test suite the agent never sees. |
| **Odds ratio** | How much the odds of passing multiply when a variable increases. "${f2(orPeak)}× per e-fold" means that multiplying transcript size by 2.7 multiplies the odds of success by about ${f2(orPeak)}. |
| **p-value** | The probability of seeing an association this strong if the variable really had no effect. Small means the effect is probably real; large means the data cannot distinguish it from nothing. |

## Why we ran this

Deleting material from the transcript is not free. Providers cache the prompt so that repeated prefixes are
billed at roughly a tenth of the normal rate, but that cache is keyed on the prefix: change any earlier byte
and everything after it must be re-cached at a premium. Deleting from the middle of the transcript therefore
throws away the discount for the rest of the prompt.

That cost is paid **per deletion**, while the discount accrues **per step**. So deleting less often should be
cheaper, and an earlier simulation put the saving at 25–39% versus never deleting at all. The open question
was what infrequent deletion does to *task success*, which the simulation could not measure. This sweep was
the live arm meant to answer it.

## The experimental setup

### The task

Every run is the same job, called \`longbuild\`. The agent starts in a workspace holding a README, 13
specification documents (~20,000 characters in total) describing a small Python accounting library, five
empty Python stubs to fill in (\`money.py\`, \`parsing.py\`, \`rules.py\`, \`report.py\`, \`cli.py\`), and a visible
test suite it may run at any time. It works through six stages — read a stage's specification, implement it,
run the tests, fix failures, move on — until it declares itself done or hits a 60-step ceiling. Runs take
roughly 53 to 61 steps.

**Passing** is decided by a *held-out* test suite written into the workspace only after the agent stops,
exercising the same specified behaviour on different data. The agent never sees it, so it cannot pass by
special-casing the tests it can read.

The task is this long deliberately. An agent with a shell recovers almost anything it loses — if a file falls
out of its transcript it simply reads the file again. The one thing no tool call can recover is the
transcript itself: its own earlier reasoning, tool calls and test output. Pressure on the transcript is
therefore inherently long-horizon and has to be built up over many steps of real work.

### What was varied

Two settings, crossed:

- **Size limit \`W\`** — ${[...new Set(cells.map((c) => c.W))].sort((a, b) => a - b).map((w) => w.toLocaleString()).join(', ')} tokens.
- **Deletion frequency \`N\`** — ${[...new Set(cells.map((c) => c.cadence))].sort((a, b) => a - b).join(', ')} (delete every N-th step).

${cells.length} runs in total, across ${FILES.length} batches.

### The eviction signal, and why it is a third variable

When the limit binds, something has to choose *which* material goes. **Each run used exactly one of three
rules**, and the runs in this dataset are pooled across all three — no run mixes them, but the dataset does.

| Rule | What it keeps | Role |
|---|---|---|
| \`truncate-tail\` | the most recent material that fits — oldest goes first | The incumbent: what ordinary agent harnesses do. |
| \`idle\` | the material whose files were referenced most recently, regardless of position | The candidate: a least-recently-used rule keyed on file references rather than position. |
| \`random\` | a random subset that fits | The control: no signal at all, but the same volume kept, so any difference from the other two is attributable to the *choice* rather than the amount. |

All three fit the same budget and protect the same most-recent items; they differ only in the order they
sacrifice the rest. A separate experiment (13 runs per rule) found **no measurable difference** between
\`truncate-tail\` and \`idle\` (p = 1.000), and a weak advantage for having *any* signal over \`random\`
(p = 0.045).

The rules are **not evenly spread across the settings** — the \`random\` control appears only at the every-step
frequency — so it is entangled with the variable under test. Every statistical model below therefore adjusts
for which rule a run used; the "Rules present" column in the results table shows the mix in each cell.

### What was recorded

For each run: whether it passed, the **achieved peak** (the largest transcript actually sent), how many
deletions occurred, and the total tokens billed across the whole run.

### The bug: the limit was not enforced between deletions

Eviction was gated behind the frequency counter:

\`\`\`js
const fire = (turnNo++ % CADENCE) === 0;   // deletion-frequency gate
const r = fire ? evict(m) : NOOP;
\`\`\`

On steps where the gate does not fire, **nothing checks the size limit**. The transcript simply grows. So at
N > 1 the nominal \`W\` is not a size limit at all — it is a *trigger threshold*: the point at which the next
scheduled deletion will cut back. The transcript actually sent is the peak of the resulting sawtooth.

The instrumentation was never wrong about this. \`peak_history_tokens\` was already being sampled *after* the
(possibly skipped) deletion, so it recorded the true size all along. The error was in the interpretation:
comparing runs by the label \`W\` rather than by what they actually sent.

Concretely, the runs labelled \`W=4,700\` with N=10 sent **${SAW.peak.toLocaleString()} tokens** — larger than
the ${FLAT.peak.toLocaleString()} sent by the runs labelled \`W=7,500\` with N=1. The infrequent-deletion
configuration was never fitting into a smaller window. It was fitting into a slightly larger one.

### How we tested it

We fit a logistic regression — a standard model for a yes/no outcome — predicting whether a run passed, and
asked whether each variable adds anything once the others are known. The comparison is a **likelihood-ratio
test**: fit the model with the variable, fit it without, and ask how much better the fit got. A large
improvement with a small p-value means the variable carries information the others do not.

**Every model adjusts for the deletion rule.** That is not cosmetic: the signal-free random rule contributes
${cells.filter((c) => c.arm === 'random').length} of the ${cells.length} runs and appears **only** at N=1, so
it is entangled with deletion frequency. Leaving it out inflates the headline odds ratio from ${f2(orPeak)}×
to ${f2(orPeakUnadj)}× — a ${((orPeakUnadj / orPeak - 1) * 100).toFixed(0)}% overstatement. The conclusion is
the same either way; the effect size was not.

| Question | Improvement in fit (χ², 1 df) | p | Answer |
|---|---|---|---|
| Does **deletion frequency** add anything once actual transcript size is known? | ${f3(tCad.stat)} | **${f4(tCad.p)}** | No |
| Does the **nominal size limit** add anything once actual transcript size is known? | ${f3(tW.stat)} | **${f4(tW.p)}** | No |
| Does **actual transcript size** add anything once deletion frequency is known? | ${f2(tPeak.stat)} | **${f4(tPeak.p)}** | **Yes** |

Actual transcript size, adjusted for the deletion rule: **odds ratio ${f2(orPeak)}× per e-fold**.

## Results

Ordered by the variable that actually predicts the outcome — not by the label the runs were filed under.

| Deletion frequency N | Nominal limit W | Runs | Passed | **Achieved peak** | Deletions | Tokens billed | Rules present |
|---|---|---|---|---|---|---|---|
${tableMd}

Reading down the achieved-peak column, the pass rate rises as transcript size rises, and the
infrequent-deletion rows sit **on the same curve** as the every-step rows rather than above it. The direct
comparisons:

${rows.filter((r) => r.cadence > 1).map((r) => {
  const near = rows.filter((q) => q.cadence === 1).sort((a, b) => Math.abs(a.peak - r.peak) - Math.abs(b.peak - r.peak))[0];
  return `- **N=${r.cadence}, peak ${r.peak.toLocaleString()} → ${pct(r.rate)}** (${r.n} runs) versus the nearest every-step configuration, **N=1, peak ${near.peak.toLocaleString()} → ${pct(near.rate)}** (${near.n} runs).`;
}).join('\n')}

## What we got wrong

**1. "Deleting less often raises task success at the same size limit."** Commit \`25e3006\` recorded:
*"Sawtooth beats a wider flat window: W=4700/N=10 matches W=7500/N=1 at 100% pass with 15% fewer tokens and
6× fewer evictions."* The task-success half of that is **withdrawn**. The N=10 runs labelled W=4,700 were not
held to 4,700 tokens; they sent ${SAW.peak.toLocaleString()}, more than the ${FLAT.peak.toLocaleString()} sent
by the W=7,500 every-step runs they were compared against. Once achieved peak is in the model, deletion
frequency adds nothing (p = ${f4(tCad.p)}) and neither does the nominal limit (p = ${f4(tW.p)}). The corrected
reading: the infrequent-deletion runs passed because they kept more transcript, not because they deleted less
often. The cost half of the claim survives and is restated in Conclusions.

**2. The effect size of transcript size was overstated by leaving the deletion rule out of the model.** An
earlier fit of pass against achieved peak did not adjust for which rule each run used. Because the signal-free
\`random\` rule contributes ${cells.filter((c) => c.arm === 'random').length} runs, all at N=1, that omission
confounds rule with deletion frequency and gave an odds ratio of **${f2(orPeakUnadj)}× per e-fold**. Adjusted
for rule it is **${f2(orPeak)}×**, a ${((orPeakUnadj / orPeak - 1) * 100).toFixed(0)}% overstatement. The
direction and the significance were unaffected; the magnitude was not.

## Conclusions

### What survives

**Deleting less often is a cost lever, not a quality lever.** At comparable transcript size the
infrequent-deletion configuration was materially cheaper:

| | Tokens billed | Deletions | Achieved peak | Passed |
|---|---|---|---|---|
| Delete every 10th step (N=10, W=4,700) | **${SAW.tokens.toLocaleString()}** | **${SAW.evictions}** | ${SAW.peak.toLocaleString()} | ${SAW.passes}/${SAW.n} |
| Delete every step (N=1, W=7,500) | ${FLAT.tokens.toLocaleString()} | ${FLAT.evictions} | ${FLAT.peak.toLocaleString()} | ${FLAT.passes}/${FLAT.n} |

Fewer tokens and a sixth of the deletions, at a *higher* peak — matching the direction the earlier cost
simulation predicted. That is the half of the original claim worth keeping.

**The design implication changes.** Do not tune deletion frequency expecting better task performance. Tune
the thing that predicts performance — how much of the transcript is present when the model is called — and
use deletion frequency to buy that as cheaply as possible.

### What this licenses, and what it does not

**Established, on this one task.** Task success tracks the transcript size actually sent to the model
(odds ratio ${f2(orPeak)}× per e-fold, p = ${f4(tPeak.p)}, adjusted for deletion rule). Given that size,
deletion frequency and the nominal limit carry no further information.

**Licensed for the design.** Configure and enforce eviction against the transcript actually sent, not against a
threshold that may be overshot between deletions. Treat deletion frequency purely as a cost setting, chosen
after the target size is fixed.

**Not licensed.**

| claim | status |
|---|---|
| deleting less often improves task success | **tested and rejected** — no effect once achieved peak is known (p = ${f4(tCad.p)}) |
| the nominal size limit matters beyond the size actually sent | **tested and rejected** (p = ${f4(tW.p)}) |
| deleting less often is cheaper at matched transcript size | **observed**, in one comparison of ${SAW.n} against ${FLAT.n} runs, with no interval |
| the success threshold is an absolute token count rather than a share of task demand | **untested** — indistinguishable on a single task |
| the *content* of the retained transcript matters, not only its size | **untested** — see the deeper question below |
| any of this holds beyond \`longbuild\` or this model | **untested** |

### What this does not answer: how wide should the window be?

The results identify a threshold — success reaches 100% once about **${FLAT.peak.toLocaleString()} tokens**
of transcript are present — but they cannot say what that number *is*.

Three readings are consistent with everything here:

| Reading | The threshold would be | On this run |
|---|---|---|
| An absolute token count | ~${FLAT.peak.toLocaleString()} tokens, for this task | ${FLAT.peak.toLocaleString()} |
| A fraction of the **model's** context limit | a constant % of 262,144 | ${fracOfModel(FLAT.peak)} |
| A fraction of what **the task itself** demands | a constant % of the uncapped transcript | ${fracOfTask(FLAT.peak)} of ${UNCAPPED ? UNCAPPED.toLocaleString() : '—'} |

**The middle reading is already implausible.** The threshold sits at ${fracOfModel(FLAT.peak)} of the model's
hard limit — the model's own capacity is nowhere near binding, so it cannot be what sets the threshold. What
binds is whether the transcript still holds what the task needs.

**The first and third readings cannot be separated here, and the reason is structural.** Every run in this
dataset is the same task, so the uncapped demand is a constant ${UNCAPPED ? UNCAPPED.toLocaleString() : '—'}
tokens. "${FLAT.peak.toLocaleString()} tokens" and "${fracOfTask(FLAT.peak)} of demand" are the same number
wearing two hats. No amount of extra runs on this task can tell them apart.

#### The experiment that would

Sweep the size limit across **tasks with materially different uncapped demand** — one that needs ~8k, one
~20k (this task), one ~40k — on the same model. Then:

- if the success threshold lands at the **same token count** across all three, the target is absolute and
  should be configured as a token budget;
- if it lands at the **same fraction of each task's uncapped demand**, the target is relative, and a fixed
  token budget will be wrong for every task but one — the assembler would need to estimate demand.

A second, cheaper arm settles the model-capacity question directly: run the same task on a model with a much
smaller hard limit (a 131k-token model is already available) and check that the threshold does not move. The
prediction is that it does not, so long as the limit stays well above the threshold.

#### The deeper question underneath it

This all assumes the only thing that matters is *how much* transcript is present. Everything measured so far
is consistent with that — and with nothing else mattering. But a companion experiment established that the
measurement may be **unable to detect** whether the *content* of the retained transcript matters, so "width
is all that matters" is not yet a finding, only an unrefuted possibility. If relatedness turns out to matter,
the target is not a width at all: it is whatever width happens to be needed to retain the related material,
and the right lever is selection, not size.

## Caveats

- **This is observational, not a randomised comparison.** Achieved peak is a consequence of the settings, not
  something we set directly, so the regression separates cause from consequence only as well as the design
  allows. The stronger evidence is the direct one: infrequent-deletion runs land on the same curve as
  every-step runs at matched size, which agrees with the regression.
- **One task.** All ${cells.length} runs are \`longbuild\`. This measures variation within one problem, not
  across problems, and between-problem variation is the larger effect in agentic coding.
- **Small numbers at the interior settings** — as few as three runs per cell, so individual percentages are
  noisy. The overall trend rests on all ${cells.length} runs.
- **Token counts are estimates** (characters ÷ 4) for the limit and the peak; the billed-token column is the
  provider's real count. Real counts ran about 30% above the estimate, so comparisons hold but absolute
  figures do not transfer.
- **The regression is computed inside this report** by Newton–Raphson, and reproduces the reference
  \`statsmodels\` fit to three decimal places on the same data.

---
*Generated by \`experiments/context-dedup/report-cadence-confound.mjs\` from
${FILES.map((f) => `\`${f}\``).join(', ')}. Charts in the HTML version of this report.*
`;

writeFileSync(join(OUT, 'report-cadence-confound.md'), MD);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deleting context less often did not help</title><style>
:root{color-scheme:light}
body{margin:0;background:#fbfbfd;color:#1b1c1e;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:880px;margin:0 auto;padding:36px 20px 80px}
h1{font-size:29px;line-height:1.2;margin:0 0 4px}
.sub{color:#5f6368;font-style:italic;margin:0 0 20px}
h2{font-size:21px;margin:40px 0 12px;border-bottom:1px solid #e3e3ea;padding-bottom:7px}
h3{font-size:16.5px;margin:26px 0 8px}
h4{font-size:15px;margin:20px 0 6px}
p{margin:12px 0}
.retract{background:#fff4ed;border-left:4px solid #e4572e;padding:14px 18px;border-radius:0 6px 6px 0;margin:18px 0}
.exec{background:#f3f6fb;border:1px solid #d9e2f0;border-radius:10px;padding:20px 24px;margin:20px 0 28px}
.exec h2{margin-top:0;border:0;padding:0;font-size:19px}
.key{background:#eef7f0;border-left:4px solid #2e9e5b;padding:14px 18px;border-radius:0 6px 6px 0;margin:18px 0}
.chart{background:#fff;border:1px solid #e3e3ea;border-radius:10px;padding:16px;margin:18px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;background:#fff;display:block;overflow-x:auto}
th,td{border:1px solid #e3e3ea;padding:8px 11px;text-align:left;vertical-align:top}
th{background:#f4f5fa;font-weight:600;white-space:nowrap}
code,pre{background:#f0f0f6;border-radius:4px;font-size:13.5px}code{padding:1px 5px}pre{padding:11px 13px;overflow-x:auto}
ul,ol{padding-left:24px}li{margin:8px 0}
footer{color:#7a7a8c;font-size:12.5px;margin-top:44px;border-top:1px solid #e3e3ea;padding-top:14px}
</style></head><body><main>

<h1>Deleting context less often did not help — it just kept more context</h1>
<p class="sub">A correction. A result this project reported two days ago does not survive re-analysis.</p>
<div class="retract"><strong>This supersedes the claim recorded in commit <code>25e3006</code></strong>,
which read: <em>"Sawtooth beats a wider flat window: W=4700/N=10 matches W=7500/N=1 at 100% pass with 15%
fewer tokens and 6× fewer evictions."</em> The task-success half of that claim is withdrawn. The cost half
survives, restated.</div>

<div class="exec">
<h2>Abstract</h2>
<p>An AI coding agent re-sends its whole working transcript to the model on every step, so on a long task the
transcript outgrows the model's input limit and material must be deleted. One tunable in such a system is
<strong>how often</strong> the deletion routine runs: every step, or every few steps. Running it less often is
cheaper, because each deletion invalidates the provider's cache of the prompt prefix, but it allows the
transcript to overshoot the limit in between.</p>
<p>We swept deletion frequency over ${cells.length} runs of a fixed programming task and reported that running
it every 10th step raised task success from 38% to 100% at the same nominal size limit — a large, apparently
free win. <strong>That result was confounded.</strong> The deletion routine was gated behind the frequency
counter, so on steps where it did not run, nothing enforced the limit at all. The less frequently it ran, the
more the transcript was allowed to grow, and the runs labelled with a 4,700-token limit were in fact sending
<strong>${SAW.peak.toLocaleString()} tokens</strong> — more than the runs labelled with a 7,500-token limit
(${FLAT.peak.toLocaleString()}).</p>
<p>Re-analysing all ${cells.length} runs against the transcript size <strong>actually sent</strong> rather
than the nominal limit: deletion frequency contributes nothing once actual size is known
(p = ${f4(tCad.p)}), the nominal limit contributes nothing either (p = ${f4(tW.p)}), and actual transcript
size is decisive (p = ${f4(tPeak.p)}; odds of success multiply by <strong>${f2(orPeak)}×</strong> for each
e-fold increase). Deletion frequency predicted success only because it determined transcript size.</p>
<p><strong>What survives is a cost result, not a quality one.</strong> At comparable transcript size the
infrequent-deletion runs were materially cheaper — ${SAW.tokens.toLocaleString()} tokens billed with
${SAW.evictions} deletions, against ${FLAT.tokens.toLocaleString()} and ${FLAT.evictions} for the every-step
runs. The design implication changes accordingly: do not tune deletion frequency expecting better task
performance. Tune the quantity that actually predicts it — how much of the transcript is present when the
model is called — and then use deletion frequency to obtain that quantity as cheaply as possible.</p>
</div>

<h2>What you need to know to read the rest</h2>
<table><thead><tr><th>Term</th><th>Meaning</th></tr></thead><tbody>
<tr><td><strong>Agent</strong></td><td>An AI model given tools (read a file, write a file, run a command) and a goal, running in a loop until it decides it is done.</td></tr>
<tr><td><strong>Transcript / context</strong></td><td>Everything the model sees on a given step: the instructions plus the full history of what it has read, written and run. Re-sent in full every step.</td></tr>
<tr><td><strong>Token</strong></td><td>The unit context is measured in — roughly ¾ of a word. Counts are estimates (characters ÷ 4) unless stated otherwise.</td></tr>
<tr><td><strong>Size limit (<code>W</code>)</strong></td><td>An artificial ceiling we impose on the transcript so overflow happens quickly enough to study. The model's real limit is 262,144 tokens, far more than this task needs.</td></tr>
<tr><td><strong>Eviction</strong></td><td>Deleting older material from the transcript to get back under the limit.</td></tr>
<tr><td><strong>Deletion frequency (<code>N</code>)</strong></td><td>How often the eviction routine runs: N=1 every step, N=10 every tenth step. The variable this experiment swept.</td></tr>
<tr><td><strong>Achieved peak</strong></td><td>The largest transcript actually sent to the model during a run. This turns out to be the quantity that matters, and it is <strong>not</strong> the same as the size limit.</td></tr>
<tr><td><strong>Run</strong></td><td>One complete attempt at the task under one combination of settings.</td></tr>
<tr><td><strong>Pass</strong></td><td>The task was completed correctly, judged by a hidden test suite the agent never sees.</td></tr>
<tr><td><strong>Odds ratio</strong></td><td>How much the odds of passing multiply when a variable increases. "${f2(orPeak)}× per e-fold" means multiplying transcript size by 2.7 multiplies the odds of success by about ${f2(orPeak)}.</td></tr>
<tr><td><strong>p-value</strong></td><td>The probability of seeing an association this strong if the variable really had no effect. Small means probably real; large means indistinguishable from nothing.</td></tr>
</tbody></table>

<h2>Why we ran this</h2>
<p>Deleting material from the transcript is not free. Providers cache the prompt so repeated prefixes are
billed at roughly a tenth of the normal rate, but that cache is keyed on the prefix: change any earlier byte
and everything after it must be re-cached at a premium. Deleting from the middle of the transcript therefore
throws away the discount for the rest of the prompt.</p>
<p>That cost is paid <strong>per deletion</strong>, while the discount accrues <strong>per step</strong>. So
deleting less often should be cheaper, and an earlier simulation put the saving at 25–39% versus never
deleting at all. The open question was what infrequent deletion does to <em>task success</em>, which the
simulation could not measure. This sweep was the live arm meant to answer it.</p>

<h2>The experimental setup</h2>
<h3>The task</h3>
<p>Every run is the same job, called <code>longbuild</code>. The agent starts in a workspace holding a README,
13 specification documents (~20,000 characters in total) describing a small Python accounting library, five
empty Python stubs to fill in (<code>money.py</code>, <code>parsing.py</code>, <code>rules.py</code>,
<code>report.py</code>, <code>cli.py</code>), and a visible test suite it may run at any time. It works through
six stages — read a stage's specification, implement it, run the tests, fix failures, move on — until it
declares itself done or hits a 60-step ceiling. Runs take roughly 53 to 61 steps.</p>
<p><strong>Passing</strong> is decided by a <em>held-out</em> test suite written into the workspace only after
the agent stops, exercising the same specified behaviour on different data. The agent never sees it, so it
cannot pass by special-casing the tests it can read.</p>
<p>The task is this long deliberately. An agent with a shell recovers almost anything it loses — if a file
falls out of its transcript it simply reads the file again. The one thing no tool call can recover is the
transcript itself: its own earlier reasoning, tool calls and test output. Pressure on the transcript is
therefore inherently long-horizon and has to be built up over many steps of real work.</p>
<h3>What was varied</h3>
<ul>
<li><strong>Size limit <code>W</code></strong> — ${[...new Set(cells.map((c) => c.W))].sort((a, b) => a - b).map((w) => w.toLocaleString()).join(', ')} tokens.</li>
<li><strong>Deletion frequency <code>N</code></strong> — ${[...new Set(cells.map((c) => c.cadence))].sort((a, b) => a - b).join(', ')} (delete every N-th step).</li>
</ul>
<p>${cells.length} runs in total, across ${FILES.length} batches.</p>
<h3>The eviction signal, and why it is a third variable</h3>
<p>When the limit binds, something has to choose <em>which</em> material goes. <strong>Each run used exactly
one of three rules</strong>, and the runs in this dataset are pooled across all three — no run mixes them, but
the dataset does.</p>
<table><thead><tr><th>Rule</th><th>What it keeps</th><th>Role</th></tr></thead><tbody>
<tr><td><code>truncate-tail</code></td><td>the most recent material that fits — oldest goes first</td><td>The incumbent: what ordinary agent harnesses do.</td></tr>
<tr><td><code>idle</code></td><td>the material whose files were referenced most recently, regardless of position</td><td>The candidate: a least-recently-used rule keyed on file references rather than position.</td></tr>
<tr><td><code>random</code></td><td>a random subset that fits</td><td>The control: no signal at all, but the same volume kept, so any difference from the other two is attributable to the <em>choice</em> rather than the amount.</td></tr>
</tbody></table>
<p>All three fit the same budget and protect the same most-recent items; they differ only in the order they
sacrifice the rest. A separate experiment (13 runs per rule) found <strong>no measurable difference</strong>
between <code>truncate-tail</code> and <code>idle</code> (p = 1.000), and a weak advantage for having
<em>any</em> signal over <code>random</code> (p = 0.045).</p>
<p>The rules are <strong>not evenly spread across the settings</strong> — the <code>random</code> control
appears only at the every-step frequency — so it is entangled with the variable under test. Every statistical
model below therefore adjusts for which rule a run used; the "Rules present" column in the results table shows
the mix in each cell.</p>
<h3>What was recorded</h3>
<p>For each run: whether it passed, the <strong>achieved peak</strong> (the largest transcript actually sent),
how many deletions occurred, and the total tokens billed across the whole run.</p>

<h3>The bug: the limit was not enforced between deletions</h3>
<p>Eviction was gated behind the frequency counter:</p>
<pre>const fire = (turnNo++ % CADENCE) === 0;   // deletion-frequency gate
const r = fire ? evict(m) : NOOP;</pre>
<p>On steps where the gate does not fire, <strong>nothing checks the size limit</strong>. The transcript simply
grows. So at N &gt; 1 the nominal <code>W</code> is not a size limit at all — it is a <em>trigger
threshold</em>: the point at which the next scheduled deletion will cut back. The transcript actually sent is
the peak of the resulting sawtooth.</p>
<p>The instrumentation was never wrong about this. <code>peak_history_tokens</code> was already being sampled
<em>after</em> the (possibly skipped) deletion, so it recorded the true size all along. The error was in the
interpretation: comparing runs by the label <code>W</code> rather than by what they actually sent.</p>
<div class="retract">The runs labelled <code>W=4,700</code> with N=10 sent
<strong>${SAW.peak.toLocaleString()} tokens</strong> — larger than the ${FLAT.peak.toLocaleString()} sent by
the runs labelled <code>W=7,500</code> with N=1. The infrequent-deletion configuration was never fitting into
a smaller window. It was fitting into a slightly larger one.</div>
<div class="chart">${chartNominal()}</div>

<h3>How we tested it</h3>
<p>We fit a logistic regression — a standard model for a yes/no outcome — predicting whether a run passed, and
asked whether each variable adds anything once the others are known. The comparison is a <strong>likelihood-ratio
test</strong>: fit the model with the variable, fit it without, and ask how much better the fit got. A large
improvement with a small p-value means the variable carries information the others do not.</p>
<p><strong>Every model adjusts for the deletion rule.</strong> That is not cosmetic: the signal-free random
rule contributes ${cells.filter((c) => c.arm === 'random').length} of the ${cells.length} runs and appears
<strong>only</strong> at N=1, so it is entangled with deletion frequency. Leaving it out inflates the headline
odds ratio from ${f2(orPeak)}× to ${f2(orPeakUnadj)}× — a
${((orPeakUnadj / orPeak - 1) * 100).toFixed(0)}% overstatement. The conclusion is the same either way; the
effect size was not.</p>
<table><thead><tr><th>Question</th><th>Improvement in fit (χ², 1 df)</th><th>p</th><th>Answer</th></tr></thead><tbody>
<tr><td>Does <strong>deletion frequency</strong> add anything once actual transcript size is known?</td><td>${f3(tCad.stat)}</td><td><strong>${f4(tCad.p)}</strong></td><td>No</td></tr>
<tr><td>Does the <strong>nominal size limit</strong> add anything once actual transcript size is known?</td><td>${f3(tW.stat)}</td><td><strong>${f4(tW.p)}</strong></td><td>No</td></tr>
<tr><td>Does <strong>actual transcript size</strong> add anything once deletion frequency is known?</td><td>${f2(tPeak.stat)}</td><td><strong>${f4(tPeak.p)}</strong></td><td><strong>Yes</strong></td></tr>
</tbody></table>
<p>Actual transcript size, adjusted for the deletion rule: <strong>odds ratio ${f2(orPeak)}× per e-fold</strong>.</p>

<h2>Results</h2>
<p>Ordered by the variable that actually predicts the outcome — not by the label the runs were filed under.</p>
<table><thead><tr><th>Deletion frequency N</th><th>Nominal limit W</th><th>Runs</th><th>Passed</th><th>Achieved peak</th><th>Deletions</th><th>Tokens billed</th><th>Rules present</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${r.cadence}</td><td>${r.W.toLocaleString()}</td><td>${r.n}</td><td>${r.passes}/${r.n} (${pct(r.rate)})</td><td><strong>${r.peak.toLocaleString()}</strong></td><td>${r.evictions}</td><td>${r.tokens.toLocaleString()}</td><td>${armMix(r.cadence, r.W)}</td></tr>`).join('')}
</tbody></table>
<div class="chart">${chartByPeak()}</div>
<p>Reading down the achieved-peak column, the pass rate rises as transcript size rises, and the
infrequent-deletion rows sit <strong>on the same curve</strong> as the every-step rows rather than above
them.</p>

<h2>What we got wrong</h2>
<p><strong>1. "Deleting less often raises task success at the same size limit."</strong> Commit
<code>25e3006</code> recorded: <em>"Sawtooth beats a wider flat window: W=4700/N=10 matches W=7500/N=1 at 100%
pass with 15% fewer tokens and 6× fewer evictions."</em> The task-success half of that is
<strong>withdrawn</strong>. The N=10 runs labelled W=4,700 were not held to 4,700 tokens; they sent
${SAW.peak.toLocaleString()}, more than the ${FLAT.peak.toLocaleString()} sent by the W=7,500 every-step runs
they were compared against. Once achieved peak is in the model, deletion frequency adds nothing
(p = ${f4(tCad.p)}) and neither does the nominal limit (p = ${f4(tW.p)}). The corrected reading: the
infrequent-deletion runs passed because they kept more transcript, not because they deleted less often. The
cost half of the claim survives and is restated in Conclusions.</p>
<p><strong>2. The effect size of transcript size was overstated by leaving the deletion rule out of the
model.</strong> An earlier fit of pass against achieved peak did not adjust for which rule each run used.
Because the signal-free <code>random</code> rule contributes ${cells.filter((c) => c.arm === 'random').length}
runs, all at N=1, that omission confounds rule with deletion frequency and gave an odds ratio of
<strong>${f2(orPeakUnadj)}× per e-fold</strong>. Adjusted for rule it is <strong>${f2(orPeak)}×</strong>, a
${((orPeakUnadj / orPeak - 1) * 100).toFixed(0)}% overstatement. The direction and the significance were
unaffected; the magnitude was not.</p>

<h2>Conclusions</h2>
<h3>What survives</h3>
<div class="key"><strong>Deleting less often is a cost lever, not a quality lever.</strong></div>
<table><thead><tr><th></th><th>Tokens billed</th><th>Deletions</th><th>Achieved peak</th><th>Passed</th></tr></thead><tbody>
<tr><td>Delete every 10th step (N=10, W=4,700)</td><td><strong>${SAW.tokens.toLocaleString()}</strong></td><td><strong>${SAW.evictions}</strong></td><td>${SAW.peak.toLocaleString()}</td><td>${SAW.passes}/${SAW.n}</td></tr>
<tr><td>Delete every step (N=1, W=7,500)</td><td>${FLAT.tokens.toLocaleString()}</td><td>${FLAT.evictions}</td><td>${FLAT.peak.toLocaleString()}</td><td>${FLAT.passes}/${FLAT.n}</td></tr>
</tbody></table>
<p>Fewer tokens and a sixth of the deletions, at a <em>higher</em> peak — matching the direction the earlier
cost simulation predicted. That is the half of the original claim worth keeping.</p>
<p><strong>The design implication changes.</strong> Do not tune deletion frequency expecting better task
performance. Tune the thing that predicts performance — how much of the transcript is present when the model
is called — and use deletion frequency to buy that as cheaply as possible.</p>

<h3>What this licenses, and what it does not</h3>
<p><strong>Established, on this one task.</strong> Task success tracks the transcript size actually sent to
the model (odds ratio ${f2(orPeak)}× per e-fold, p = ${f4(tPeak.p)}, adjusted for deletion rule). Given that
size, deletion frequency and the nominal limit carry no further information.</p>
<p><strong>Licensed for the design.</strong> Configure and enforce eviction against the transcript actually
sent, not against a threshold that may be overshot between deletions. Treat deletion frequency purely as a cost
setting, chosen after the target size is fixed.</p>
<p><strong>Not licensed.</strong></p>
<table><thead><tr><th>claim</th><th>status</th></tr></thead><tbody>
<tr><td>deleting less often improves task success</td><td><strong>tested and rejected</strong> — no effect once achieved peak is known (p = ${f4(tCad.p)})</td></tr>
<tr><td>the nominal size limit matters beyond the size actually sent</td><td><strong>tested and rejected</strong> (p = ${f4(tW.p)})</td></tr>
<tr><td>deleting less often is cheaper at matched transcript size</td><td><strong>observed</strong>, in one comparison of ${SAW.n} against ${FLAT.n} runs, with no interval</td></tr>
<tr><td>the success threshold is an absolute token count rather than a share of task demand</td><td><strong>untested</strong> — indistinguishable on a single task</td></tr>
<tr><td>the <em>content</em> of the retained transcript matters, not only its size</td><td><strong>untested</strong> — see the deeper question below</td></tr>
<tr><td>any of this holds beyond <code>longbuild</code> or this model</td><td><strong>untested</strong></td></tr>
</tbody></table>

<h3>What this does not answer: how wide should the window be?</h3>
<p>The results identify a threshold — success reaches 100% once about
<strong>${FLAT.peak.toLocaleString()} tokens</strong> of transcript are present — but they cannot say what
that number <em>is</em>.</p>
<table><thead><tr><th>Reading</th><th>The threshold would be</th><th>On this run</th></tr></thead><tbody>
<tr><td>An absolute token count</td><td>~${FLAT.peak.toLocaleString()} tokens, for this task</td><td>${FLAT.peak.toLocaleString()}</td></tr>
<tr><td>A fraction of the <strong>model's</strong> context limit</td><td>a constant % of 262,144</td><td>${fracOfModel(FLAT.peak)}</td></tr>
<tr><td>A fraction of what <strong>the task itself</strong> demands</td><td>a constant % of the uncapped transcript</td><td>${fracOfTask(FLAT.peak)} of ${UNCAPPED ? UNCAPPED.toLocaleString() : '—'}</td></tr>
</tbody></table>
<div class="key"><strong>The middle reading is already implausible.</strong> The threshold sits at
${fracOfModel(FLAT.peak)} of the model's hard limit — the model's own capacity is nowhere near binding, so it
cannot be what sets the threshold. What binds is whether the transcript still holds what the task needs.</div>
<p><strong>The first and third readings cannot be separated here, and the reason is structural.</strong> Every
run in this dataset is the same task, so the uncapped demand is a constant
${UNCAPPED ? UNCAPPED.toLocaleString() : '—'} tokens. "${FLAT.peak.toLocaleString()} tokens" and
"${fracOfTask(FLAT.peak)} of demand" are the same number wearing two hats. No amount of extra runs on this
task can tell them apart.</p>
<h4>The experiment that would</h4>
<p>Sweep the size limit across <strong>tasks with materially different uncapped demand</strong> — one that
needs ~8k, one ~20k (this task), one ~40k — on the same model. Then:</p>
<ul>
<li>if the success threshold lands at the <strong>same token count</strong> across all three, the target is
absolute and should be configured as a token budget;</li>
<li>if it lands at the <strong>same fraction of each task's uncapped demand</strong>, the target is relative,
and a fixed token budget will be wrong for every task but one — the assembler would need to estimate
demand.</li>
</ul>
<p>A second, cheaper arm settles the model-capacity question directly: run the same task on a model with a much
smaller hard limit (a 131k-token model is already available) and check that the threshold does not move. The
prediction is that it does not, so long as the limit stays well above the threshold.</p>
<h4>The deeper question underneath it</h4>
<p>This all assumes the only thing that matters is <em>how much</em> transcript is present. Everything measured
so far is consistent with that — and with nothing else mattering. But a companion experiment established that
the measurement may be <strong>unable to detect</strong> whether the <em>content</em> of the retained
transcript matters, so "width is all that matters" is not yet a finding, only an unrefuted possibility. If
relatedness turns out to matter, the target is not a width at all: it is whatever width happens to be needed
to retain the related material, and the right lever is selection, not size.</p>

<h2>Caveats</h2>
<ul>
<li><strong>Observational, not a randomised comparison.</strong> Achieved peak is a consequence of the
settings, not something we set directly, so the regression separates cause from consequence only as well as
the design allows. The stronger evidence is the direct one: infrequent-deletion runs land on the same curve as
every-step runs at matched size, which agrees with the regression.</li>
<li><strong>One task.</strong> All ${cells.length} runs are <code>longbuild</code> — variation within one
problem, not across problems.</li>
<li><strong>Small numbers at the interior settings</strong> — as few as three runs per cell, so individual
percentages are noisy. The overall trend rests on all ${cells.length} runs.</li>
<li><strong>Token counts are estimates</strong> (characters ÷ 4) for the limit and the peak; the billed-token
column is the provider's real count, which ran about 30% higher.</li>
<li><strong>The regression is computed inside this report</strong> by Newton–Raphson, and reproduces the
reference <code>statsmodels</code> fit to three decimal places on the same data.</li>
</ul>

<footer>context-tree · correction report · every figure generated from
${esc(FILES.join(', '))} by <code>experiments/context-dedup/report-cadence-confound.mjs</code></footer>
</main></body></html>`;

writeFileSync(join(OUT, 'report-cadence-confound.html'), HTML);
console.log('wrote report-cadence-confound.{md,html} ->', OUT);
console.log(`cells=${cells.length} files=${FILES.length}`);
console.log(`LR cadence|peak p=${f4(tCad.p)}  W|peak p=${f4(tW.p)}  peak|cadence p=${f4(tPeak.p)}  OR(peak)=${f2(orPeak)} (unadjusted ${f2(orPeakUnadj)})`);
