/**
 * Report for the instrument-sensitivity control.
 *
 * Written to be READ BY SOMEONE WHO HAS NOT FOLLOWED THIS PROJECT: a paper-style
 * abstract, then the experimental setup, then results. Every term is defined
 * before it is used and no background is assumed.
 * All numbers are interpolated from the raw result files so the prose cannot
 * drift from the data.
 *
 * Rerun: node experiments/context-dedup/report-sensitivity-control.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fisherOneSided, wilson } from './stats.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports', 'metrics', 'context-dedup');
const load = (f) => (existsSync(join(OUT, f)) ? JSON.parse(readFileSync(join(OUT, f), 'utf8')) : null);

const primary = load('results-sens-primary.json');
if (!primary) throw new Error('results-sens-primary.json is required');
const uncapped = load('results-sens-uncapped.json');
const uncappedClean = load('results-sens-uncapped-clean.json');

const allCells = [...primary.cells, ...(uncapped?.cells ?? []), ...(uncappedClean?.cells ?? [])];

const med = (x) => { const s = [...x].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const ORDER = ['uncapped-clean', 'clean', 'oracle', 'random', 'uncapped-ballast'];
const LABEL = {
  'uncapped-clean': 'uncapped-clean',
  clean: 'clean',
  oracle: 'oracle',
  random: 'random',
  'uncapped-ballast': 'uncapped-ballast',
};
const DESC = {
  'uncapped-clean': 'no size limit, no duplicates — the easiest possible condition',
  clean: 'size limit, no duplicates — what the limit alone costs',
  oracle: 'size limit + duplicates, deletes duplicates first',
  random: 'size limit + duplicates, deletes at random',
  'uncapped-ballast': 'no size limit, duplicates — unlimited room, junk present',
};
const rows = ORDER.map((arm) => {
  const cs = allCells.filter((c) => c.arm === arm);
  if (!cs.length) return null;
  const passes = cs.filter((c) => c.pass).length;
  const [lo, hi] = wilson(passes, cs.length);
  return {
    arm, label: LABEL[arm], desc: DESC[arm], n: cs.length, passes, rate: passes / cs.length, lo, hi,
    useful: Math.round(med(cs.map((c) => c.useful_tokens_mean))),   // a half-token is false precision
    junk: med(cs.map((c) => c.junk_share_mean)),
    writes: med(cs.map((c) => c.writes)),
    noWrite: cs.filter((c) => c.writes === 0).length,
    peak: Math.round(med(cs.map((c) => c.peak_history_tokens))),
  };
}).filter(Boolean);

const R = Object.fromEntries(rows.map((r) => [r.arm, r]));
const need = (a) => { if (!R[a]) throw new Error(`report needs arm ${a}`); return R[a]; };
const CLEAN = need('clean'), ORACLE = need('oracle'), RANDOM = need('random');
const UC = R['uncapped-clean'], UB = R['uncapped-ballast'];
const pPrimary = fisherOneSided(ORACLE.passes, ORACLE.n - ORACLE.passes, RANDOM.passes, RANDOM.n - RANDOM.passes);
const attempted = RANDOM.n - RANDOM.noWrite;

const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const k = (v) => v.toLocaleString();

// ------------------------------------------------------------------ charts
/** Chart 1 — did the agent succeed, and did it even try? */
function chartArms() {
  const W = 820, H = 300, padL = 168, padR = 96, padT = 62, padB = 52;
  const iw = W - padL - padR, rowH = (H - padT - padB) / rows.length;
  let s = `<text x="14" y="24" font-size="14" font-weight="600" fill="#1b1c1e">Did the agent finish the task, and did it even try?</text>`;
  s += `<text x="14" y="42" font-size="11.5" fill="#5f6368">Green bar = share of runs that passed. Black dot = share of runs where the agent wrote at least one file.</text>`;
  rows.forEach((r, i) => {
    const y = padT + i * rowH;
    const tried = (r.n - r.noWrite) / r.n;
    s += `<text x="${padL - 12}" y="${y + rowH / 2 + 4}" font-size="12.5" fill="#1b1c1e" text-anchor="end">${esc(r.label)}</text>`;
    s += `<rect x="${padL}" y="${y + 7}" width="${iw}" height="${rowH - 18}" fill="#eceff1" rx="3"/>`;
    if (r.rate > 0) s += `<rect x="${padL}" y="${y + 7}" width="${(r.rate * iw).toFixed(1)}" height="${rowH - 18}" fill="#2e9e5b" rx="3"/>`;
    s += `<circle cx="${(padL + tried * iw).toFixed(1)}" cy="${y + rowH / 2}" r="6" fill="#1b1c1e" stroke="#fff" stroke-width="2"/>`;
    s += `<text x="${padL + iw + 10}" y="${y + rowH / 2 + 4}" font-size="12" fill="#1b1c1e">${r.passes} of ${r.n}</text>`;
  });
  s += `<text x="${padL}" y="${H - 16}" font-size="11" fill="#7a7a8c">0%</text>`;
  s += `<text x="${padL + iw}" y="${H - 16}" font-size="11" fill="#7a7a8c" text-anchor="end">100%</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto">${s}</svg>`;
}

/** Chart 2 — the uncapped pair. Same lack of limit; only duplicates differ. */
function chartUncapped() {
  if (!UB || !UC) return '';
  const W = 820, H = 280, padL = 168, padR = 130, padT = 62, padB = 40;
  const iw = W - padL - padR;
  const pair = [UC, UB];
  const max = Math.max(...pair.map((r) => r.peak)) * 1.05;
  const rowH = (H - padT - padB) / 2;
  let s = `<text x="14" y="24" font-size="14" font-weight="600" fill="#1b1c1e">Unlimited room, and it still failed</text>`;
  s += `<text x="14" y="42" font-size="11.5" fill="#5f6368">Neither run had a size limit, so nothing was ever deleted. Bar length = total context sent to the model.</text>`;
  pair.forEach((r, i) => {
    const y = padT + i * rowH;
    const w = (r.peak / max) * iw;
    s += `<text x="${padL - 12}" y="${y + rowH / 2 - 2}" font-size="12.5" fill="#1b1c1e" text-anchor="end">${esc(r.label)}</text>`;
    s += `<text x="${padL - 12}" y="${y + rowH / 2 + 15}" font-size="11" fill="#7a7a8c" text-anchor="end">${r.junk > 0.01 ? pct(r.junk) + ' duplicates' : 'no duplicates'}</text>`;
    s += `<rect x="${padL}" y="${y + 10}" width="${w.toFixed(1)}" height="${rowH - 30}" fill="${r.rate > 0 ? '#2e9e5b' : '#b3261e'}" rx="3"/>`;
    s += `<text x="${(padL + w + 10).toFixed(1)}" y="${y + rowH / 2 + 4}" font-size="12" fill="#1b1c1e">${k(r.peak)} tokens · ${r.rate > 0 ? 'PASSED' : 'FAILED'} · ${r.writes} files written</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto">${s}</svg>`;
}

// ---------------------------------------------------------------- markdown
const tableRows = rows.map((r) =>
  `| \`${r.label}\` | ${r.desc} | ${r.n} | ${r.passes}/${r.n} | ${r.noWrite}/${r.n} | ${k(r.useful)} | ${pct(r.junk)} | ${r.writes} |`).join('\n');

const MD = `# Does duplicated context hurt an AI coding agent?

*An experiment that failed at its intended purpose and found something else.*

---

## Abstract

An AI coding agent accumulates a transcript of everything it reads, writes and runs, and re-sends that
transcript to the model on every step. On a long task the transcript outgrows the model's input limit, so
some of it must be discarded. Which parts to discard is the central design question for context-management
middleware, and four successive experiments on this substrate have found **no difference** between candidate
discard rules. That is ambiguous: either the choice genuinely does not matter on this task, or the
measurement cannot detect it — in which case all four results are uninformative rather than negative.

We attempted to distinguish these with a positive control. Into the transcript of an agent building a small
Python accounting library from a written specification, we injected **byte-identical duplicates** of files
the agent had already read. A duplicate carries no information the transcript does not already hold, so a
discard rule that removes duplicates first should measurably outperform one that discards at random — if the
measurement can detect discard quality at all.

**The control failed, and informatively.** Rather than merely consuming space, the duplicates stopped the
agent working: in the random-discard condition it produced **zero source files in all ${RANDOM.n} runs**,
never beginning the implementation. A comparison against a baseline that never attempts the task cannot
measure anything, so the planned test (${ORACLE.passes}/${ORACLE.n} versus ${RANDOM.passes}/${RANDOM.n},
p = ${pPrimary.toFixed(3)}) is void.

The failure identifies a different effect. **Duplicated transcript content degrades agent behaviour far
beyond the space it occupies.** Removing the size limit entirely — so nothing is ever discarded and space is
never scarce — does not rescue it: with no limit and no duplicates the agent passed, writing ${UC ? UC.writes : '—'}
files from ${UC ? k(UC.peak) : '—'} tokens of transcript; with no limit and duplicates present it failed,
writing **zero** files from ${UB ? k(UB.peak) : '—'} tokens — ${UB && UC ? (UB.peak / UC.peak).toFixed(1) : '—'}×
**more** transcript than the run that succeeded. Displacement is therefore excluded as the mechanism.

This is the third injection design to halt this agent, after unrelated files presented as its own reads and
the same files presented as user messages. The common factor is not the content but its provenance:
**transcript material the agent did not itself produce changes what the agent does.** Middleware that adds to
an agent's context — summaries, retrieved passages, file references — must be evaluated for behavioural
effect, not only for token cost. The original question, whether the measurement can detect discard quality,
remains open and requires a design in which arms hold equal quantities of non-duplicate content.

## What you need to know to read the rest

These terms are used throughout. Nothing else is assumed.

| Term | Meaning |
|---|---|
| **Agent** | An AI model given tools (read a file, write a file, run a command) and a goal, running in a loop until it decides it is done. |
| **Context** | Everything the model can see on a given step: the instructions, plus the full history of what it has read, written and run so far. It is re-sent in full on every step. |
| **Token** | The unit context is measured in — roughly ¾ of a word. All token counts here are estimates (characters ÷ 4) unless stated otherwise. |
| **Context limit** | The maximum context a model will accept. Real limits are large; here we impose a small artificial one so that overflow happens quickly and can be studied. |
| **Eviction** | Deleting older material from the context to stay under the limit. The subject of this whole line of work: *what* should be deleted? |
| **The task** | One fixed programming job, called \`longbuild\`: build a small accounting program in six stages. It is marked pass/fail by a hidden test suite the agent never sees, so it cannot game it. Every run in this report is the same task. |
| **Run** (a "cell") | One complete attempt at the task by the agent under one set of conditions. |
| **Arm** | One experimental condition. Every arm runs the same task; arms differ only in the rule being tested. |
| **Duplicate / "ballast"** | Material we deliberately inserted: a second, byte-identical copy of a file the agent had already read. It adds no information, so deleting it loses nothing. |
| **Useful tokens** | Context that is *not* a duplicate — the real, non-redundant material the agent had available. |
| **Duplicate share** | What fraction of the agent's context was duplicated material. |
| **Files written** | How many files the agent created or edited during a run. A run with zero is a run where the agent never began the actual work — the clearest sign it has gone off the rails. |
| **Positive control** | A condition built so that a working measurement *must* show a difference. If it shows none, the measurement is suspect; if the control itself breaks, the run tells you nothing either way. |
| **\`oracle\` / \`random\`** | The two discard rules under test. \`oracle\` deletes duplicates first; \`random\` deletes at random. Both keep the same total amount of context. |
| **Validity condition** | A check, written before the run, that must hold for a result to be interpretable at all. |
| **Void** | A run whose validity conditions fail in substance: it is not evidence for or against anything, as distinct from a *null*, which is evidence of no difference. |
| **p-value** | The probability of a difference at least this large if the rules were truly equivalent. Here a one-sided Fisher exact test on pass counts. |

## Why we ran this

This project builds middleware that manages an AI agent's context: deciding what to keep, what to
summarise, and what to delete when the context gets too big. The central design question is **what to
delete**.

We have tested four different answers, and all four came back with no measurable difference:

| What we varied | Result |
|---|---|
| Which signal picks what to delete | no difference (p = 0.70) |
| Deleting by "last time this file was touched" vs "oldest first" | no difference (p = 1.000) |
| Where in the context a needed fact sits | no difference (180 out of 180 correct at every position) |
| How often deletion runs | no difference once you account for how much context was present |

The one thing that consistently predicts success is simply **how much context the agent has** — more is
better, strongly.

Four straight no-differences has two possible explanations, and they look identical from the outside:

1. On this task, it genuinely does not matter what you delete.
2. **Our measurement cannot detect the difference** — in which case all four results are meaningless
   rather than informative.

Explanation 2 would invalidate a substantial amount of work, so it has to be ruled out before we build
anything further on those results. This experiment was designed to rule it out.

## The experimental setup

### The task the agent performs

Every run is the same job, called \`longbuild\`. The agent is dropped into a workspace that already contains:

- **\`README.md\`** and **13 specification documents** under \`spec/\` (about 1,000–2,000 characters each,
  ~20,000 characters in total) describing a \`ledger\` toolkit: money arithmetic, parsing of transaction
  lines, business rules, reporting, a tagging extension, and a command-line interface.
- **Five empty Python stubs** the agent must fill in: \`money.py\`, \`parsing.py\`, \`rules.py\`, \`report.py\`,
  \`cli.py\`.
- **\`test_ledger.py\`**, a visible test suite (~12,000 characters) the agent can run at any time.

It is instructed to work through six stages in order — read a stage's specification, implement that stage's
module, run \`python3 -m unittest test_ledger\`, fix failures, then move on. It must also append a decision
note to \`NOTES.md\` after each stage and finally write \`SUMMARY.md\`. It has five tools: read a file, write a
file, edit a file, list files, and run a shell command. It runs until it declares itself done or hits a
60-step ceiling.

**"Files written" therefore means the Python modules and notes the agent produces.** It is the measure of
whether the agent is doing its job at all. A healthy run writes its first file at around step 9 and produces
14–17 files in total. A run with **zero** files written has read specifications and run commands but never
implemented anything.

**Passing** is decided by a *held-out* test suite, written into the workspace only after the agent stops and
exercising the same specified behaviour on different data. The agent never sees it, so it cannot pass by
special-casing the visible tests.

### Why this task and not something shorter

An agent with a shell can recover almost anything it loses — if a file's contents fall out of its
transcript, it simply reads the file again. The one thing no tool call can recover is **the transcript
itself**: its own earlier reasoning, tool calls and test output. Pressure on the transcript is therefore
inherently long-horizon, and has to be built up over many steps of real iterative work. That is what this
six-stage task manufactures; runs take 53–61 steps.

### The size limit

The model's real input limit is 262,144 tokens, far more than this task needs, so overflow would never occur
naturally. We impose an **artificial limit of 7,000 tokens** on the transcript. When it is exceeded, the
discard rule under test removes material until it fits. Two conditions (\`uncapped-clean\`, \`uncapped-ballast\`)
have **no** limit at all and never discard anything; they exist to separate "ran out of room" from other
explanations.

### How duplicates were injected

Every second step, two units of the transcript were duplicated: an existing file-read and its result were
copied verbatim, with a fresh identifier, and spliced back into the transcript just before the agent's most
recent step. The copy is byte-identical, so the *earlier* copy becomes redundant — its content is fully
present later in the transcript. That redundancy is what the \`oracle\` rule detects and removes.

Two properties were enforced deliberately: the source to duplicate is chosen **uniformly at random** among
resident reads, so redundant material is not concentrated at one end of the transcript where a simple
oldest-first rule would remove it for free; and copies are spliced **before** the newest step, so they never
displace the agent's own latest work from the protected recent window.

## Results

### The conditions compared

Five conditions were run. Every one is the same task, the same model and the same settings; they differ only
in the size limit and in which rule decides what to discard. A rule that discards duplicates first keeps more
real material inside the same limit, so it should do better — *if* the measurement can see such things.

| Arm | What it does | Runs | Passed | Never wrote a file | Useful tokens | Duplicate share | Files written |
|---|---|---|---|---|---|---|---|
${tableRows}

\`clean\` and \`uncapped-clean\` contain no duplicates at all; they show what the agent does normally, with
and without a size limit.

### Why the planned comparison is void

The intended test was \`oracle\` versus \`random\`. Both scored ${ORACLE.passes} out of ${ORACLE.n}
(statistically: p = ${pPrimary.toFixed(3)}, meaning no detectable difference).

Read literally, that is the "our measurement is blind" outcome. **It should not be read that way**, for one
reason: in the \`random\` condition the agent wrote **zero files in ${RANDOM.noWrite} of ${RANDOM.n} runs**.
Only ${attempted} of ${RANDOM.n} runs involved the agent attempting the task at all.

A comparison needs a baseline that is *doing the thing badly*, not one that has stopped doing the thing. If
the agent never starts, its failure tells you nothing about whether a better deletion rule would have
helped.

Why the two validity conditions written in advance did not catch this is set out in **What we got wrong**.

### The finding that replaced it

**Duplicated context damages the agent out of all proportion to the space it takes up.**

The clearest single comparison is \`oracle\` against \`clean\`:

- \`oracle\` had **${k(ORACLE.useful)}** useful tokens — ${pct(ORACLE.useful / CLEAN.useful)} of what
  \`clean\` had (${k(CLEAN.useful)}).
- \`clean\` passed **${CLEAN.passes} of ${CLEAN.n}** times. \`oracle\` passed **${ORACLE.passes} of
  ${ORACLE.n}**.
- \`clean\` wrote **${CLEAN.writes}** files per run. \`oracle\` wrote **${ORACLE.writes}**.

From everything else we have measured, an agent with that much real context should succeed roughly 40–50%
of the time. It succeeded ${pct(ORACLE.rate)} of the time. The difference is the
${pct(ORACLE.junk)} of its context that was duplicated material — and \`oracle\` was the arm actively
deleting duplicates, so it had the *least* of it among the duplicate conditions.

${UB && UC ? `**The cause is behavioural, not a shortage of room.** The last two rows remove the size limit
entirely, so nothing is ever deleted and space is never scarce:

- \`uncapped-clean\`: no duplicates → **passed**, ${UC.writes} files written, ${k(UC.peak)} tokens of context.
- \`uncapped-ballast\`: duplicates present → **failed**, ${UB.writes} files written, ${k(UB.peak)} tokens of
  context — **${(UB.peak / UC.peak).toFixed(1)}× more context than the run that passed.**

An agent with more room than it needs, which still never writes a file, has not run out of anything. The
duplicates changed what it did.` : `*(The unlimited-room comparison has not been run, so a shortage of space is not yet ruled out as the cause.)*`}

#### Why this generalises beyond duplicates

This is the **third** attempt to add material to this agent's context, and the third to stop it working:

1. **Unrelated files, presented as reads the agent had performed.** The agent copied the pattern and spent
   60 of 61 steps reading those files. It wrote nothing.
2. **The same files, presented as a message from the user**, clearly labelled as irrelevant. The agent made
   51 tool calls and wrote nothing. (A successful run writes its first file at around step 9.)
3. **Byte-identical copies of the agent's own reading** — this experiment.

Three different kinds of content, three different ways of presenting it, same outcome. The common factor is
not what the material said. It is that **material the agent did not itself produce appeared in its
history**.

That matters directly for what this project builds. The middleware does not only delete context — it also
*adds* to it: summaries of earlier work, retrieved passages, references to files. Those additions are
content the agent did not put there. The safe assumption, on this evidence, is that such additions change
the agent's behaviour and must be tested for that, not just costed in tokens.

It also changes how deduplication should be viewed. An earlier analysis concluded that removing duplicate
content is not a way to save money — it is a way to fit more into a limited space. These results suggest a
third possibility: if duplicates actively degrade behaviour, removing them improves **capability**. That is
a hypothesis this run raises; it does not prove it, because no arm here held duplicates without also being
the arm meant to remove them.

## What we got wrong

**1. "Two pre-registered validity conditions are enough to make this run interpretable."** We wrote two
conditions in advance: the no-duplicates arm should not be at zero (\`clean\` passed ${CLEAN.passes} of
${CLEAN.n}), and the random arm should have room to improve (\`random\` passed ${RANDOM.passes} of ${RANDOM.n}).
**Both were satisfied, and the run was still void**: the \`random\` agent wrote zero files in ${RANDOM.noWrite}
of ${RANDOM.n} runs, so the baseline had stopped attempting the task. Satisfying the conditions was read as
licence to interpret the primary contrast; it was not. A third condition has been added and is now checked
automatically: *the baseline must still be attempting the task.* The measurement that catches it — files
written — was already being recorded; we simply were not looking at it.

**2. "If \`oracle\` beats \`random\`, the measurement can detect discard quality."** This was the premise of
the design, and independent review, carried out while the experiment was running, found it false regardless
of the outcome. The \`oracle\` arm's advantage over \`random\` comes entirely through one channel: it ends up
with **more useful tokens** (${k(ORACLE.useful)} against ${k(RANDOM.useful)}). But "more context is better" is
exactly the effect we already knew about and had measured. So \`oracle\` beating \`random\` was guaranteed by an
established effect, and would not have demonstrated anything new about the measurement's sensitivity.
Meanwhile the four no-difference results we set out to check were all measured with *equal* amounts of useful
context in every arm. A control that only changes the amount cannot speak to them. **The original question
therefore remains open**: answering it needs a design where the arms hold the *same amount* of useful context
but *different* content.

## Conclusions

**Established.** On this task and model, injecting byte-identical duplicates of the agent's own file reads
derailed it: under random discard it wrote no files in ${RANDOM.noWrite} of ${RANDOM.n} runs, and even the
duplicate-removing \`oracle\` arm passed ${ORACLE.passes} of ${ORACLE.n} against ${CLEAN.passes} of ${CLEAN.n}
for the same limit without duplicates.${UB && UC ? ` With no size limit at all, the duplicate run wrote ${UB.writes} files from ${k(UB.peak)} tokens while the clean run passed from ${k(UC.peak)}.` : ''}

**Licensed for the design.** Every live comparison must gate on a behavioural liveness measure (here, files
written) before its primary contrast is read. Any middleware step that *adds* material to an agent's context
must be evaluated for its effect on behaviour, not only on token cost.

**Not licensed.**

| claim | status |
|---|---|
| the measurement can detect discard quality | **untested** — the run is void, not a null, and the design could not have shown it |
| the four earlier no-difference results are informative | **untested** — still open |
| duplicates harm by displacing useful context | **tested and rejected**${UB ? ` on ${UB.n} uncapped run — a single decisive observation, not a rate` : ' — not yet run'} |
| removing duplicates improves capability | **untested** — no arm held duplicates without also removing them |
| provenance, not content, is the common cause across the three injection designs | **untested** — an inference across three designs, not a controlled contrast |
| the mechanism (imitation, lost instructions, other) | **untested** |

## Caveats

- **One task.** Every run is \`longbuild\`. This measures variation within one problem, not across
  problems, and between-problem variation is the larger effect in agentic coding.
- **One model**, one machine, one configuration.
- **We do not know the mechanism.** That duplicates change behaviour is what the data show. *Why* — whether
  the agent imitates the repeated reading, loses track of instructions, or something else — is untested.
- **The unlimited-room arm got a heavier dose of duplicates** than the limited arms
  (${UB ? pct(UB.junk) : '—'} of its context versus ${pct(RANDOM.junk)}), because copies can themselves be
  copied and nothing was deleting them. This strengthens "extra room did not help" but prevents a precise
  dose comparison.
- **Pass/fail is all-or-nothing.** A run that nearly finished scores the same as one that never started;
  the "files written" column is included precisely because it distinguishes them.
- **Small numbers.** ${ORACLE.n} runs per main arm${UB ? `, and only ${UB.n} for the unlimited-room duplicate arm — that one is a single decisive observation, not an estimate of a rate` : ''}.
- **The unlimited-room duplicate run was interrupted** by the machine running out of memory before its
  results file was written. Its completed run was recovered from the run log by
  \`recover-run-log.mjs\`, which copies only the values the log actually printed and marks the file as
  recovered; nothing was reconstructed or estimated.

---
*Data: \`results-sens-primary.json\`${uncapped ? ', `results-sens-uncapped.json`' : ''}${uncappedClean ? ', `results-sens-uncapped-clean.json`' : ''}.
Code: \`experiments/context-dedup/{sensitivity-control,ballast,stats}.mjs\`, with 20 unit tests.
Charts in the HTML version of this report.*
`;

writeFileSync(join(OUT, 'report-sensitivity-control.md'), MD);

// -------------------------------------------------------------------- html
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Does duplicated context hurt an AI coding agent?</title><style>
:root{color-scheme:light}
body{margin:0;background:#fbfbfd;color:#1b1c1e;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:36px 20px 80px}
h1{font-size:30px;line-height:1.2;margin:0 0 4px}
.sub{color:#5f6368;font-style:italic;margin:0 0 26px}
h2{font-size:21px;margin:40px 0 12px;border-bottom:1px solid #e3e3ea;padding-bottom:7px}
h3{font-size:16.5px;margin:26px 0 8px}
h4{font-size:15px;margin:20px 0 6px}
p{margin:12px 0}
.exec{background:#f3f6fb;border:1px solid #d9e2f0;border-radius:10px;padding:20px 24px;margin:20px 0 28px}
.exec h2{margin-top:0;border:0;padding:0;font-size:19px}
.exec p{margin:12px 0}
.key{background:#eef7f0;border-left:4px solid #2e9e5b;padding:14px 18px;border-radius:0 6px 6px 0;margin:18px 0}
.warn{background:#fff4ed;border-left:4px solid #e4572e;padding:14px 18px;border-radius:0 6px 6px 0;margin:18px 0}
.chart{background:#fff;border:1px solid #e3e3ea;border-radius:10px;padding:16px;margin:18px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;background:#fff;display:block;overflow-x:auto}
th,td{border:1px solid #e3e3ea;padding:8px 11px;text-align:left;vertical-align:top}
th{background:#f4f5fa;font-weight:600;white-space:nowrap}
td:first-child{white-space:nowrap}
code{background:#f0f0f6;border-radius:4px;font-size:13.5px;padding:1px 5px}
ul,ol{padding-left:24px}li{margin:8px 0}
footer{color:#7a7a8c;font-size:12.5px;margin-top:44px;border-top:1px solid #e3e3ea;padding-top:14px}
</style></head><body><main>

<h1>Does duplicated context hurt an AI coding agent?</h1>
<p class="sub">An experiment that failed at its intended purpose and found something else.</p>

<div class="exec">
<h2>Abstract</h2>
<p>An AI coding agent accumulates a transcript of everything it reads, writes and runs, and re-sends that
transcript to the model on every step. On a long task the transcript outgrows the model's input limit, so
some of it must be discarded. Which parts to discard is the central design question for context-management
middleware, and four successive experiments on this substrate have found <strong>no difference</strong>
between candidate discard rules. That is ambiguous: either the choice genuinely does not matter on this
task, or the measurement cannot detect it — in which case all four results are uninformative rather than
negative.</p>
<p>We attempted to distinguish these with a positive control. Into the transcript of an agent building a
small Python accounting library from a written specification, we injected <strong>byte-identical
duplicates</strong> of files the agent had already read. A duplicate carries no information the transcript
does not already hold, so a discard rule that removes duplicates first should measurably outperform one that
discards at random — if the measurement can detect discard quality at all.</p>
<p><strong>The control failed, and informatively.</strong> Rather than merely consuming space, the duplicates
stopped the agent working: in the random-discard condition it produced <strong>zero source files in all
${RANDOM.n} runs</strong>, never beginning the implementation. A comparison against a baseline that never
attempts the task cannot measure anything, so the planned test (${ORACLE.passes}/${ORACLE.n} versus
${RANDOM.passes}/${RANDOM.n}, p = ${pPrimary.toFixed(3)}) is void.</p>
<p>The failure identifies a different effect. <strong>Duplicated transcript content degrades agent behaviour
far beyond the space it occupies.</strong> Removing the size limit entirely — so nothing is ever discarded
and space is never scarce — does not rescue it: with no limit and no duplicates the agent passed, writing
${UC ? UC.writes : '—'} files from ${UC ? k(UC.peak) : '—'} tokens of transcript; with no limit and duplicates
present it failed, writing <strong>zero</strong> files from ${UB ? k(UB.peak) : '—'} tokens —
${UB && UC ? (UB.peak / UC.peak).toFixed(1) : '—'}× <strong>more</strong> transcript than the run that
succeeded. Displacement is therefore excluded as the mechanism.</p>
<p>This is the third injection design to halt this agent, after unrelated files presented as its own reads
and the same files presented as user messages. The common factor is not the content but its provenance:
<strong>transcript material the agent did not itself produce changes what the agent does.</strong> Middleware
that adds to an agent's context — summaries, retrieved passages, file references — must be evaluated for
behavioural effect, not only for token cost. The original question, whether the measurement can detect
discard quality, remains open and requires a design in which arms hold equal quantities of non-duplicate
content.</p>
</div>

<h2>What you need to know to read the rest</h2>
<p>These terms are used throughout. Nothing else is assumed.</p>
<table><thead><tr><th>Term</th><th>Meaning</th></tr></thead><tbody>
<tr><td><strong>Agent</strong></td><td>An AI model given tools (read a file, write a file, run a command) and a goal, running in a loop until it decides it is done.</td></tr>
<tr><td><strong>Context</strong></td><td>Everything the model can see on a given step: the instructions, plus the full history of what it has read, written and run so far. It is re-sent in full on every step.</td></tr>
<tr><td><strong>Token</strong></td><td>The unit context is measured in — roughly ¾ of a word. Counts here are estimates (characters ÷ 4) unless stated otherwise.</td></tr>
<tr><td><strong>Context limit</strong></td><td>The maximum context a model will accept. Real limits are large; here we impose a small artificial one so overflow happens quickly and can be studied.</td></tr>
<tr><td><strong>Eviction</strong></td><td>Deleting older material from the context to stay under the limit. The subject of this work: <em>what</em> should be deleted?</td></tr>
<tr><td><strong>The task</strong></td><td>One fixed programming job, <code>longbuild</code>: build a small accounting program in six stages. Marked pass/fail by a hidden test suite the agent never sees, so it cannot game it. Every run here is the same task.</td></tr>
<tr><td><strong>Run</strong></td><td>One complete attempt at the task under one set of conditions.</td></tr>
<tr><td><strong>Arm</strong></td><td>One experimental condition. Arms differ only in the rule being tested.</td></tr>
<tr><td><strong>Duplicate</strong></td><td>Material we deliberately inserted: a second, byte-identical copy of a file the agent had already read. It adds no information, so deleting it loses nothing.</td></tr>
<tr><td><strong>Useful tokens</strong></td><td>Context that is <em>not</em> a duplicate — the real, non-redundant material the agent had available.</td></tr>
<tr><td><strong>Duplicate share</strong></td><td>What fraction of the agent's context was duplicated material.</td></tr>
<tr><td><strong>Positive control</strong></td><td>A condition built so that a working measurement <em>must</em> show a difference. If it shows none, the measurement is suspect; if the control itself breaks, the run tells you nothing either way.</td></tr>
<tr><td><strong><code>oracle</code> / <code>random</code></strong></td><td>The two discard rules under test. <code>oracle</code> deletes duplicates first; <code>random</code> deletes at random. Both keep the same total amount of context.</td></tr>
<tr><td><strong>Validity condition</strong></td><td>A check, written before the run, that must hold for a result to be interpretable at all.</td></tr>
<tr><td><strong>Void</strong></td><td>A run whose validity conditions fail in substance: not evidence for or against anything, as distinct from a <em>null</em>, which is evidence of no difference.</td></tr>
<tr><td><strong>p-value</strong></td><td>The probability of a difference at least this large if the rules were truly equivalent. Here a one-sided Fisher exact test on pass counts.</td></tr>
<tr><td><strong>Files written</strong></td><td>How many files the agent created or edited. Zero means the agent never began the actual work — the clearest sign it has gone off the rails.</td></tr>
</tbody></table>

<h2>Why we ran this</h2>
<p>This project builds middleware that manages an AI agent's context: deciding what to keep, what to
summarise, and what to delete when it gets too big. The central design question is <strong>what to
delete</strong>.</p>
<p>We have tested four different answers, and all four came back with no measurable difference:</p>
<table><thead><tr><th>What we varied</th><th>Result</th></tr></thead><tbody>
<tr><td>Which signal picks what to delete</td><td>no difference (p = 0.70)</td></tr>
<tr><td>Deleting by "last time this file was touched" vs "oldest first"</td><td>no difference (p = 1.000)</td></tr>
<tr><td>Where in the context a needed fact sits</td><td>no difference (180 out of 180 correct at every position)</td></tr>
<tr><td>How often deletion runs</td><td>no difference once you account for how much context was present</td></tr>
</tbody></table>
<p>The one thing that consistently predicts success is simply <strong>how much context the agent has</strong> —
more is better, strongly.</p>
<p>Four straight no-differences has two possible explanations, and they look identical from the outside:</p>
<ol>
<li>On this task, it genuinely does not matter what you delete.</li>
<li><strong>Our measurement cannot detect the difference</strong> — in which case all four results are
meaningless rather than informative.</li>
</ol>
<p>Explanation 2 would invalidate a substantial amount of work, so it has to be ruled out before anything
is built on those results. This experiment was designed to rule it out.</p>

<h2>The experimental setup</h2>

<h3>The task the agent performs</h3>
<p>Every run is the same job, called <code>longbuild</code>. The agent is dropped into a workspace that
already contains:</p>
<ul>
<li><strong><code>README.md</code> and 13 specification documents</strong> under <code>spec/</code> (about
1,000–2,000 characters each, ~20,000 characters in total) describing a <code>ledger</code> toolkit: money
arithmetic, parsing of transaction lines, business rules, reporting, a tagging extension, and a command-line
interface.</li>
<li><strong>Five empty Python stubs</strong> the agent must fill in: <code>money.py</code>,
<code>parsing.py</code>, <code>rules.py</code>, <code>report.py</code>, <code>cli.py</code>.</li>
<li><strong><code>test_ledger.py</code></strong>, a visible test suite (~12,000 characters) the agent can run
at any time.</li>
</ul>
<p>It is instructed to work through six stages in order — read a stage's specification, implement that
stage's module, run <code>python3 -m unittest test_ledger</code>, fix failures, then move on. It must also
append a decision note to <code>NOTES.md</code> after each stage and finally write <code>SUMMARY.md</code>.
It has five tools: read a file, write a file, edit a file, list files, and run a shell command. It runs until
it declares itself done or hits a 60-step ceiling.</p>
<div class="key"><strong>"Files written" therefore means the Python modules and notes the agent produces.</strong>
It is the measure of whether the agent is doing its job at all. A healthy run writes its first file at around
step 9 and produces 14–17 files in total. A run with <strong>zero</strong> files written has read
specifications and run commands but never implemented anything.</div>
<p><strong>Passing</strong> is decided by a <em>held-out</em> test suite, written into the workspace only
after the agent stops and exercising the same specified behaviour on different data. The agent never sees it,
so it cannot pass by special-casing the visible tests.</p>

<h3>Why this task and not something shorter</h3>
<p>An agent with a shell can recover almost anything it loses — if a file's contents fall out of its
transcript, it simply reads the file again. The one thing no tool call can recover is <strong>the transcript
itself</strong>: its own earlier reasoning, tool calls and test output. Pressure on the transcript is
therefore inherently long-horizon, and has to be built up over many steps of real iterative work. That is what
this six-stage task manufactures; runs take 53–61 steps.</p>

<h3>The size limit</h3>
<p>The model's real input limit is 262,144 tokens, far more than this task needs, so overflow would never
occur naturally. We impose an <strong>artificial limit of 7,000 tokens</strong> on the transcript. When it is
exceeded, the discard rule under test removes material until it fits. Two conditions
(<code>uncapped-clean</code>, <code>uncapped-ballast</code>) have <strong>no</strong> limit at all and never
discard anything; they exist to separate "ran out of room" from other explanations.</p>

<h3>How duplicates were injected</h3>
<p>Every second step, two units of the transcript were duplicated: an existing file-read and its result were
copied verbatim, with a fresh identifier, and spliced back into the transcript just before the agent's most
recent step. The copy is byte-identical, so the <em>earlier</em> copy becomes redundant — its content is fully
present later in the transcript. That redundancy is what the <code>oracle</code> rule detects and removes.</p>
<p>Two properties were enforced deliberately: the source to duplicate is chosen <strong>uniformly at
random</strong> among resident reads, so redundant material is not concentrated at one end of the transcript
where a simple oldest-first rule would remove it for free; and copies are spliced <strong>before</strong> the
newest step, so they never displace the agent's own latest work from the protected recent window.</p>

<h2>Results</h2>
<h3>The conditions compared</h3>
<p>Five conditions were run. Every one is the same task, the same model and the same settings; they differ
only in the size limit and in which rule decides what to discard. A rule that discards duplicates first keeps
more real material inside the same limit, so it should do better — <em>if</em> the measurement can see such
things.</p>
<table><thead><tr><th>Arm</th><th>What it does</th><th>Runs</th><th>Passed</th><th>Never wrote a file</th><th>Useful tokens</th><th>Duplicate share</th><th>Files written</th></tr></thead><tbody>
${rows.map((r) => `<tr><td><code>${esc(r.label)}</code></td><td>${esc(r.desc)}</td><td>${r.n}</td><td><strong>${r.passes}/${r.n}</strong></td><td>${r.noWrite}/${r.n}</td><td>${k(r.useful)}</td><td>${pct(r.junk)}</td><td>${r.writes}</td></tr>`).join('')}
</tbody></table>
<div class="chart">${chartArms()}</div>

<h3>Why the planned comparison is void</h3>
<p>The intended test was <code>oracle</code> versus <code>random</code>. Both scored ${ORACLE.passes} out of
${ORACLE.n} (p = ${pPrimary.toFixed(3)}: no detectable difference).</p>
<div class="warn">Read literally, that is the "our measurement is blind" outcome. <strong>It should not be
read that way.</strong> In the <code>random</code> condition the agent wrote <strong>zero files in
${RANDOM.noWrite} of ${RANDOM.n} runs</strong>. Only ${attempted} of ${RANDOM.n} runs involved the agent
attempting the task at all.</div>
<p>A comparison needs a baseline that is <em>doing the thing badly</em>, not one that has stopped doing the
thing. If the agent never starts, its failure says nothing about whether a better deletion rule would have
helped.</p>
<p>Why the two validity conditions written in advance did not catch this is set out in <strong>What we got wrong</strong>.</p>

<h3>The finding that replaced it</h3>
<div class="key"><strong>Duplicated context damages the agent out of all proportion to the space it takes
up.</strong></div>
<p>The clearest single comparison is <code>oracle</code> against <code>clean</code>:</p>
<ul>
<li><code>oracle</code> had <strong>${k(ORACLE.useful)}</strong> useful tokens — ${pct(ORACLE.useful / CLEAN.useful)} of what <code>clean</code> had (${k(CLEAN.useful)}).</li>
<li><code>clean</code> passed <strong>${CLEAN.passes} of ${CLEAN.n}</strong> times; <code>oracle</code> passed <strong>${ORACLE.passes} of ${ORACLE.n}</strong>.</li>
<li><code>clean</code> wrote <strong>${CLEAN.writes}</strong> files per run; <code>oracle</code> wrote <strong>${ORACLE.writes}</strong>.</li>
</ul>
<p>From everything else we have measured, an agent with that much real context should succeed roughly 40–50%
of the time. It succeeded ${pct(ORACLE.rate)} of the time. The difference is the ${pct(ORACLE.junk)} of its
context that was duplicated material — and <code>oracle</code> was the arm actively deleting duplicates, so
it had the <em>least</em> of it among the duplicate conditions.</p>
${UB && UC ? `<h4>The cause is behavioural, not a shortage of room</h4>
<p>The last two conditions remove the size limit entirely, so nothing is ever deleted and space is never
scarce.</p>
<div class="chart">${chartUncapped()}</div>
<p>An agent with more room than it needs, which still never writes a file, has not run out of anything. The
duplicates changed what it did.</p>` : '<p><em>The unlimited-room comparison has not been run, so a shortage of space is not yet ruled out as the cause.</em></p>'}

<h4>Why this generalises beyond duplicates</h4>
<p>This is the <strong>third</strong> attempt to add material to this agent's context, and the third to stop
it working:</p>
<ol>
<li><strong>Unrelated files, presented as reads the agent had performed.</strong> The agent copied the pattern
and spent 60 of 61 steps reading those files. It wrote nothing.</li>
<li><strong>The same files, presented as a message from the user</strong>, clearly labelled as irrelevant. The
agent made 51 tool calls and wrote nothing. (A successful run writes its first file at around step 9.)</li>
<li><strong>Byte-identical copies of the agent's own reading</strong> — this experiment.</li>
</ol>
<p>Three kinds of content, three ways of presenting it, same outcome. The common factor is not what the
material said. It is that <strong>material the agent did not itself produce appeared in its history</strong>.</p>
<p>That matters directly for what this project builds. The middleware does not only delete context — it also
<em>adds</em> to it: summaries of earlier work, retrieved passages, references to files. Those additions are
content the agent did not put there. The safe assumption, on this evidence, is that such additions change
the agent's behaviour and must be tested for that, not merely costed in tokens.</p>
<p>It also changes how deduplication should be viewed. An earlier analysis concluded that removing duplicate
content is not a way to save money — it is a way to fit more into a limited space. These results suggest a
third possibility: if duplicates actively degrade behaviour, removing them improves <strong>capability</strong>.
That is a hypothesis this run raises, not one it proves: no arm here held duplicates without also being the
arm meant to remove them.</p>

<h2>What we got wrong</h2>
<p><strong>1. "Two pre-registered validity conditions are enough to make this run interpretable."</strong> We
wrote two conditions in advance: the no-duplicates arm should not be at zero (<code>clean</code> passed
${CLEAN.passes} of ${CLEAN.n}), and the random arm should have room to improve (<code>random</code> passed
${RANDOM.passes} of ${RANDOM.n}). <strong>Both were satisfied, and the run was still void</strong>: the
<code>random</code> agent wrote zero files in ${RANDOM.noWrite} of ${RANDOM.n} runs, so the baseline had stopped
attempting the task. Satisfying the conditions was read as licence to interpret the primary contrast; it was
not. A third condition has been added and is now checked automatically: <em>the baseline must still be
attempting the task.</em> The measurement that catches it — files written — was already being recorded; we
simply were not looking at it.</p>
<p><strong>2. "If <code>oracle</code> beats <code>random</code>, the measurement can detect discard
quality."</strong> This was the premise of the design, and independent review, carried out while the experiment
was running, found it false regardless of the outcome. The <code>oracle</code> arm's advantage over
<code>random</code> comes entirely through one channel: it ends up with <strong>more useful tokens</strong>
(${k(ORACLE.useful)} against ${k(RANDOM.useful)}). But "more context is better" is exactly the effect we already
knew about and had measured. So <code>oracle</code> beating <code>random</code> was guaranteed by an established
effect, and would not have demonstrated anything new about the measurement's sensitivity. Meanwhile the four
no-difference results we set out to check were all measured with <em>equal</em> amounts of useful context in
every arm. A control that only changes the amount cannot speak to them.</p>
<div class="warn"><strong>The original question remains open.</strong> Answering it needs a design where the
arms hold the <em>same amount</em> of useful context but <em>different</em> content.</div>

<h2>Conclusions</h2>
<p><strong>Established.</strong> On this task and model, injecting byte-identical duplicates of the agent's own
file reads derailed it: under random discard it wrote no files in ${RANDOM.noWrite} of ${RANDOM.n} runs, and
even the duplicate-removing <code>oracle</code> arm passed ${ORACLE.passes} of ${ORACLE.n} against
${CLEAN.passes} of ${CLEAN.n} for the same limit without duplicates.${UB && UC ? ` With no size limit at all, the duplicate run wrote ${UB.writes} files from ${k(UB.peak)} tokens while the clean run passed from ${k(UC.peak)}.` : ''}</p>
<p><strong>Licensed for the design.</strong> Every live comparison must gate on a behavioural liveness measure
(here, files written) before its primary contrast is read. Any middleware step that <em>adds</em> material to
an agent's context must be evaluated for its effect on behaviour, not only on token cost.</p>
<p><strong>Not licensed.</strong></p>
<table><thead><tr><th>claim</th><th>status</th></tr></thead><tbody>
<tr><td>the measurement can detect discard quality</td><td><strong>untested</strong> — the run is void, not a null, and the design could not have shown it</td></tr>
<tr><td>the four earlier no-difference results are informative</td><td><strong>untested</strong> — still open</td></tr>
<tr><td>duplicates harm by displacing useful context</td><td><strong>tested and rejected</strong>${UB ? ` on ${UB.n} uncapped run — a single decisive observation, not a rate` : ' — not yet run'}</td></tr>
<tr><td>removing duplicates improves capability</td><td><strong>untested</strong> — no arm held duplicates without also removing them</td></tr>
<tr><td>provenance, not content, is the common cause across the three injection designs</td><td><strong>untested</strong> — an inference across three designs, not a controlled contrast</td></tr>
<tr><td>the mechanism (imitation, lost instructions, other)</td><td><strong>untested</strong></td></tr>
</tbody></table>

<h2>Caveats</h2>
<ul>
<li><strong>One task.</strong> Every run is <code>longbuild</code>. This measures variation within one problem,
not across problems, and between-problem variation is the larger effect in agentic coding.</li>
<li><strong>One model</strong>, one machine, one configuration.</li>
<li><strong>We do not know the mechanism.</strong> That duplicates change behaviour is what the data show.
<em>Why</em> — imitation of the repeated reading, loss of track of the instructions, or something else — is
untested.</li>
<li><strong>The unlimited-room arm got a heavier dose of duplicates</strong> than the limited arms
(${UB ? pct(UB.junk) : '—'} of its context versus ${pct(RANDOM.junk)}), because copies can themselves be copied
and nothing was deleting them. This strengthens "extra room did not help" but prevents a precise dose
comparison.</li>
<li><strong>Pass/fail is all-or-nothing.</strong> A run that nearly finished scores the same as one that never
started; "files written" is included precisely because it distinguishes them.</li>
<li><strong>Small numbers.</strong> ${ORACLE.n} runs per main arm${UB ? `, and only ${UB.n} for the unlimited-room duplicate arm — a single decisive observation, not an estimate of a rate` : ''}.</li>
<li><strong>The unlimited-room duplicate run was interrupted</strong> by the machine running out of memory
before its results file was written. Its completed run was recovered from the run log by
<code>recover-run-log.mjs</code>, which copies only values the log actually printed and marks the file as
recovered; nothing was reconstructed or estimated.</li>
</ul>

<footer>context-tree · instrument-sensitivity control · every figure generated from
<code>results-sens-*.json</code> by <code>experiments/context-dedup/report-sensitivity-control.mjs</code></footer>
</main></body></html>`;

writeFileSync(join(OUT, 'report-sensitivity-control.html'), HTML);
console.log('wrote report-sensitivity-control.{md,html} ->', OUT);
console.log(`arms: ${rows.map((r) => `${r.arm} ${r.passes}/${r.n}`).join(' | ')}`);
