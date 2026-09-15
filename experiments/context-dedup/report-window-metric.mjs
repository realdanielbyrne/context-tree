/**
 * Report for the WINDOW metric (W) used across the A/B sweeps: what it measures,
 * how it is enforced, and the dose–response it produces for the incumbent rule.
 * Self-contained HTML (inline SVG, no CDN) + markdown twin with the same sections.
 *
 * Rerun: node experiments/context-dedup/report-window-metric.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCappedCells, peakRegression, CADENCE_FILES } from './peak-regression.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'reports', 'metrics', 'context-dedup');
const load = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'));
// Every batch run at CADENCE=1. The cadence sweeps are deliberately EXCLUDED from the curve: raising
// cadence lets the context overshoot W between eviction events, so those cells are not at the W they
// are labelled with. See report-cadence-confound.{md,html}.
const SOURCES = ['results-ab-longbuild-v2-n3.json', 'results-ab-longbuild-v2.json',
  'results-ab-longbuild-winwA.json', 'results-ab-longbuild-winwB.json'];
// ONE ARM ONLY. Pooling arms made the levels incomparable: W=4,700 and W=9,500 carry
// idle+random+truncate-tail while every interior level is truncate-tail alone, so the
// endpoints were dragged down by the deliberately signal-free `random` control and the
// curve compared unlike things. `truncate-tail` is the incumbent (what real harnesses
// do) and is the only arm present at every level.
const CURVE_ARM = 'truncate-tail';
const MODEL_WINDOW = 262144;
const batches = SOURCES.map((f) => ({ f, d: load(f) })).filter(({ d }) => (d.manifest.cadence ?? 1) === 1);
if (batches.length !== SOURCES.length) throw new Error('a pinned window-metric batch is not at cadence 1');
const allArmCells = batches.flatMap(({ d }) => d.cells);
const cells = allArmCells.filter((c) => c.arm === CURVE_ARM || c.arm === 'uncapped');
const MODELS = [...new Set(batches.map(({ d }) => d.manifest.model))];
const MAX_TURNS = [...new Set(batches.map(({ d }) => d.manifest.max_turns))];
if (MODELS.length !== 1 || MAX_TURNS.length !== 1) throw new Error('pinned batches disagree on model or max_turns');
const task = (await import(join(HERE, 'ab-tasks', 'longbuild.mjs'))).default;
const est = (s) => Math.ceil(s.length / 4);
const HEAD = est(task.system) + est(task.task);
const RESERVE = 512;

const med = (x) => { const s = [...x].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const LEVELS = [...new Set(cells.filter((c) => c.window !== null).map((c) => c.window))].sort((a, b) => a - b);
LEVELS.push('uncapped');
const G = {};
for (const L of LEVELS) {
  const g = cells.filter((c) => (L === 'uncapped' ? c.window === null : c.window === L));
  const pass = g.filter((c) => c.pass).length;
  G[L] = { n: g.length, pass, rate: pass / g.length, peak: Math.round(med(g.map((c) => c.peak_history_tokens))),
    tokens: Math.round(med(g.map((c) => c.total_prompt_tokens))), turns: Math.round(med(g.map((c) => c.turns))),
    evict: Math.round(med(g.map((c) => c.evictions))) };
}
/** Level lookup that throws rather than rendering "undefined". */
const lv = (L) => { if (!G[L]) throw new Error(`report needs level W=${L} and it is not in the data`); return G[L]; };
const CAPPED = LEVELS.filter((L) => L !== 'uncapped');
const LO = CAPPED[0], HI = CAPPED[CAPPED.length - 1];

/** Wilson 95% interval — honest about n=3 cells. */
function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// ---- derived figures
const pct = (v) => `${(v * 100).toFixed(0)}%`;
const k = (v) => v.toLocaleString();
const lbl = (L) => (L === 'uncapped' ? '∞' : L.toLocaleString());
const tax = (C) => (HEAD + RESERVE) / C;
const usable = (C) => C - HEAD - RESERVE;
const CAP_VIOLATIONS = allArmCells.reduce((a, c) => { if (typeof c.cap_violations !== 'number') throw new Error('cap_violations missing'); return a + c.cap_violations; }, 0);
const UNDER = CAPPED.map((L) => L - lv(L).peak);
const TURN_RANGE = (() => { const t = cells.map((c) => c.turns).filter((v) => typeof v === 'number'); return [Math.min(...t), Math.max(...t)]; })();
// The cliff: the lowest cap from which every higher cap passed every run, and the best-passing cap below it.
const CLIFF_HI = CAPPED.find((L, i) => CAPPED.slice(i).every((M) => lv(M).rate === 1));
if (CLIFF_HI === undefined) throw new Error('no cap reaches 100% — the cliff prose does not apply');
const CLIFF_LO = CAPPED.filter((L) => L < CLIFF_HI).reduce((a, L) => (lv(L).rate > lv(a).rate ? L : a), LO);
const NONMONO = CAPPED.slice(1).map((L, i) => [CAPPED[i], L]).find(([a, b]) => b < CLIFF_HI && lv(b).rate < lv(a).rate);
const INTERIOR_N = [...new Set(CAPPED.slice(1, -1).map((L) => lv(L).n))];
const RUNS = cells.length;
// Linear R² of total prompt tokens on W across the capped curve runs — replaces an unsourced caption figure.
const R2 = (() => {
  const cs = cells.filter((c) => c.window !== null);
  const x = cs.map((c) => c.window), y = cs.map((c) => c.total_prompt_tokens);
  const mx = x.reduce((a, b) => a + b) / x.length, my = y.reduce((a, b) => a + b) / y.length;
  let sxy = 0, sxx = 0, syy = 0;
  x.forEach((v, i) => { sxy += (v - mx) * (y[i] - my); sxx += (v - mx) ** 2; syy += (y[i] - my) ** 2; });
  return { r2: (sxy * sxy) / (sxx * syy), n: cs.length };
})();
// What the withdrawn pooled-arm curve showed at the two levels that carried every arm.
const pooled = (L) => { const g = allArmCells.filter((c) => c.window === L); const p = g.filter((c) => c.pass).length;
  if (!g.length) throw new Error(`no pooled cells at W=${L}`); return { n: g.length, pass: p, rate: p / g.length,
    arms: [...new Set(g.map((c) => c.arm))].sort().join(', ') }; };
const POOL_LO = pooled(LO), POOL_HI = pooled(HI);
// Arm-adjusted regression over every capped run (all arms, all cadences), shared with the cadence report.
const REG_CELLS = loadCappedCells(OUT, CADENCE_FILES);
const { tCad, tW, tPeak, orPeak } = peakRegression(REG_CELLS);
const f2 = (v) => v.toFixed(2), f3 = (v) => v.toFixed(3), f4 = (v) => v.toFixed(4);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PAL = { grid: '#e6e6ef', text: '#2b2b38', muted: '#7a7a8c', head: '#e4572e', res: '#f0a08c', use: '#4f7cff', ok: '#2e9e5b' };

/** Dose–response: pass rate vs W, with Wilson CIs. */
function chartDose() {
  const W = 760, H = 330, padL = 62, padR = 18, padT = 40, padB = 68;
  const iw = W - padL - padR, ih = H - padT - padB;
  const y = (v) => padT + ih - v * ih;
  let out = '';
  [0, .25, .5, .75, 1].forEach((g) => { out += `<line x1="${padL}" y1="${y(g)}" x2="${W - padR}" y2="${y(g)}" stroke="${PAL.grid}"/><text x="${padL - 8}" y="${y(g) + 4}" font-size="11" fill="${PAL.muted}" text-anchor="end">${g * 100}%</text>`; });
  const bw = iw / LEVELS.length;
  LEVELS.forEach((L, i) => {
    const d = G[L], [lo, hi] = wilson(d.pass, d.n);
    const x = padL + i * bw + bw * 0.3, w = bw * 0.4, cx = x + w / 2;
    out += `<rect x="${x.toFixed(1)}" y="${y(d.rate).toFixed(1)}" width="${w.toFixed(1)}" height="${(y(0) - y(d.rate)).toFixed(1)}" fill="${L === 'uncapped' ? PAL.ok : PAL.use}" rx="3"/>`;
    out += `<line x1="${cx}" y1="${y(hi)}" x2="${cx}" y2="${y(lo)}" stroke="${PAL.text}" stroke-width="1.5"/><line x1="${cx - 7}" y1="${y(hi)}" x2="${cx + 7}" y2="${y(hi)}" stroke="${PAL.text}" stroke-width="1.5"/><line x1="${cx - 7}" y1="${y(lo)}" x2="${cx + 7}" y2="${y(lo)}" stroke="${PAL.text}" stroke-width="1.5"/>`;
    out += `<text x="${cx}" y="${(y(hi) - 8).toFixed(1)}" font-size="12" font-weight="600" fill="${PAL.text}" text-anchor="middle">${pct(d.rate)}</text>`;
    out += `<text x="${cx}" y="${(y(0) + 20).toFixed(1)}" font-size="12" fill="${PAL.muted}" text-anchor="middle">W = ${lbl(L)}</text>`;
    out += `<text x="${cx}" y="${(y(0) + 36).toFixed(1)}" font-size="10.5" fill="${PAL.muted}" text-anchor="middle">${d.pass}/${d.n} runs</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><text x="${padL}" y="22" font-size="14" font-weight="600" fill="${PAL.text}">Task success vs window cap (bars = pass rate, whiskers = Wilson 95%)</text>${out}</svg>`;
}

/** Where the budget goes: head + reserve + usable, with achieved peak marked. */
function chartBudget() {
  const W = 760, H = 300, padL = 62, padR = 120, padT = 40;
  const iw = W - padL - padR;
  const caps = [LO, HI];
  const max = HI * 1.05;
  const x = (v) => padL + (v / max) * iw;
  const rowH = 54;
  let out = '';
  caps.forEach((C, i) => {
    const yy = padT + i * (rowH + 30);
    out += `<rect x="${x(0)}" y="${yy}" width="${(x(HEAD) - x(0)).toFixed(1)}" height="${rowH}" fill="${PAL.head}"/>`;
    out += `<rect x="${x(HEAD)}" y="${yy}" width="${(x(HEAD + RESERVE) - x(HEAD)).toFixed(1)}" height="${rowH}" fill="${PAL.res}"/>`;
    out += `<rect x="${x(HEAD + RESERVE)}" y="${yy}" width="${(x(C) - x(HEAD + RESERVE)).toFixed(1)}" height="${rowH}" fill="${PAL.use}"/>`;
    out += `<text x="${x(C) + 8}" y="${yy + rowH / 2 + 4}" font-size="12" fill="${PAL.text}">W = ${k(C)}</text>`;
    const pk = lv(C).peak;
    out += `<line x1="${x(pk)}" y1="${yy - 6}" x2="${x(pk)}" y2="${yy + rowH + 6}" stroke="${PAL.text}" stroke-width="2" stroke-dasharray="4 3"/>`;
    out += `<text x="${x(pk)}" y="${yy - 10}" font-size="10.5" fill="${PAL.text}" text-anchor="middle">achieved peak ${k(pk)}</text>`;
    out += `<text x="${x(HEAD + RESERVE) + 6}" y="${yy + rowH / 2 + 4}" font-size="11" fill="#fff">usable for units: ${k(usable(C))} (${pct(usable(C) / C)})</text>`;
  });
  const lg = `<rect x="${padL}" y="${H - 24}" width="11" height="11" fill="${PAL.head}"/><text x="${padL + 16}" y="${H - 14}" font-size="11" fill="${PAL.muted}">frozen head ${HEAD} (never evicted)</text>`
    + `<rect x="${padL + 250}" y="${H - 24}" width="11" height="11" fill="${PAL.res}"/><text x="${padL + 266}" y="${H - 14}" font-size="11" fill="${PAL.muted}">reply reserve ${RESERVE}</text>`
    + `<rect x="${padL + 420}" y="${H - 24}" width="11" height="11" fill="${PAL.use}"/><text x="${padL + 436}" y="${H - 14}" font-size="11" fill="${PAL.muted}">usable for context units</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><text x="${padL}" y="22" font-size="14" font-weight="600" fill="${PAL.text}">What the cap actually buys: W = head + reserve + usable</text>${out}${lg}</svg>`;
}

/** Cost and effort vs window. */
function chartCost() {
  const W = 760, H = 300, padL = 70, padR = 18, padT = 40, padB = 60;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(...LEVELS.map((L) => G[L].tokens)) * 1.15;
  const bw = iw / LEVELS.length;
  let out = '';
  LEVELS.forEach((L, i) => {
    const d = G[L];
    const x = padL + i * bw + bw * 0.28, w = bw * 0.44;
    const y = padT + ih - (d.tokens / max) * ih;
    out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${(padT + ih - y).toFixed(1)}" fill="${L === 'uncapped' ? PAL.ok : PAL.use}" rx="3"/>`;
    out += `<text x="${(x + w / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="12" fill="${PAL.text}" text-anchor="middle">${(d.tokens / 1000).toFixed(0)}k</text>`;
    out += `<text x="${(x + w / 2).toFixed(1)}" y="${(padT + ih + 19).toFixed(1)}" font-size="12" fill="${PAL.muted}" text-anchor="middle">W = ${lbl(L)}</text>`;
    out += `<text x="${(x + w / 2).toFixed(1)}" y="${(padT + ih + 35).toFixed(1)}" font-size="10.5" fill="${PAL.muted}" text-anchor="middle">${d.turns} turns · ${d.evict} evictions</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><text x="${padL}" y="22" font-size="14" font-weight="600" fill="${PAL.text}">Total prompt tokens over the session (median); linear R² on W = ${f2(R2.r2)} over ${R2.n} capped runs</text>${out}</svg>`;
}

// ---- shared prose pieces
const GLOSS = [
  ['Agent', 'An AI model given tools (read a file, write a file, run a command) and a goal, running in a loop until it decides it is done.'],
  ['Transcript / context', 'Everything the model sees on a step: the instructions plus the full history of what it has read, written and run. It is re-sent in full every step.'],
  ['Token', 'The unit context is measured in, roughly ¾ of a word. W and achieved peak use an estimate (characters ÷ 4); total prompt tokens is the provider\'s real count.'],
  ['The task', 'One fixed programming job, longbuild, described under The experimental setup. Every run in this report is the same task.'],
  ['Run (cell)', 'One complete attempt at the task under one setting.'],
  ['Pass', 'The task was completed correctly, judged by a held-out test suite the agent never sees.'],
  ['The artificial cap W', `A per-step ceiling on the assembled prompt, enforced before each request. It is not the model's context window, which stays at ${k(MODEL_WINDOW)} tokens; W simulates a smaller deployment window so that overflow happens within one task.`],
  ['Frozen head / reply reserve', 'The system prompt and task statement (never evicted) and the tokens held back for the model\'s answer. Both come out of W before any history does.'],
  ['Eviction', 'Deleting older material from the transcript to get back under W.'],
  ['Arm', 'The rule that chooses what to evict. This report uses one arm, truncate-tail (oldest material goes first), plus an uncapped reference that never evicts.'],
  ['Achieved peak', 'The largest transcript actually sent to the model during a run. It is the quantity that predicts success, and it can differ from W.'],
  ['Cadence', 'How often eviction runs: every step, or every N-th step. Every run here is at every step.'],
  ['Wilson interval', 'A 95% confidence interval for a pass rate that stays sensible at very small n.'],
  ['Odds ratio (per e-fold)', 'How much the odds of passing multiply when achieved peak is multiplied by e ≈ 2.7.'],
  ['Likelihood-ratio test, χ², p-value', 'Fit a model with and without a variable; χ² measures how much the fit improves and p is the probability of an improvement that large if the variable carried no information.'],
];
const glossMd = GLOSS.map(([t, m]) => `| **${t}** | ${m} |`).join('\n');
const glossHtml = GLOSS.map(([t, m]) => `<tr><td><strong>${esc(t)}</strong></td><td>${esc(m)}</td></tr>`).join('');

const doseLine = LEVELS.map((L) => `${lbl(L)} → ${pct(G[L].rate)} (${G[L].pass}/${G[L].n})`).join(' · ');
const rowsMd = LEVELS.map((L) => { const d = G[L]; const [lo, hi] = wilson(d.pass, d.n);
  return `| ${L === 'uncapped' ? '∞ (uncapped)' : k(L)} | ${d.n} | ${d.pass}/${d.n} (${pct(d.rate)}) | ${pct(lo)}–${pct(hi)} | ${k(d.peak)} | ${k(d.tokens)} | ${d.turns} | ${d.evict} |`; }).join('\n');
const rowsHtml = LEVELS.map((L) => { const d = G[L]; const [lo, hi] = wilson(d.pass, d.n);
  return `<tr><td>${L === 'uncapped' ? '∞ (uncapped)' : k(L)}</td><td>${d.n}</td><td>${d.pass}/${d.n} (${pct(d.rate)})</td><td>${pct(lo)}–${pct(hi)}</td><td>${k(d.peak)}</td><td>${k(d.tokens)}</td><td>${d.turns}</td><td>${d.evict}</td></tr>`; }).join('');
const nonmonoMd = NONMONO ? `W=${k(NONMONO[1])} (${lv(NONMONO[1]).pass}/${lv(NONMONO[1]).n}) sits below W=${k(NONMONO[0])} (${lv(NONMONO[0]).pass}/${lv(NONMONO[0]).n}).` : 'Pass rate never falls from one cap to the next below the cliff.';

const MD = `# The window metric \`W\` — what it measures, and the dose–response

## Abstract

An AI coding agent re-sends its whole transcript to the model on every step, so a long task eventually outgrows
the space available and older material must be evicted. Every experiment in this line of work studies that by
imposing an artificial cap \`W\` on the prompt, far below the model's real ${k(MODEL_WINDOW)}-token window, and
reports results "at W". Those results cannot be read without knowing what \`W\` actually constrains, whether it
was enforced, and how task success responds to it.

We measured this on ${RUNS} runs of one fixed, ${MAX_TURNS[0]}-step-bounded Python programming task, using only the incumbent
eviction rule (\`${CURVE_ARM}\`) so that every level is comparable, at caps from ${k(LO)} to ${k(HI)} tokens and
with no cap at all. \`W\` is enforced exactly (zero cap violations), but a fixed head and reply reserve consume
${pct(tax(LO))} of it at W=${k(LO)} and ${pct(tax(HI))} at W=${k(HI)}.

Success responds steeply: ${pct(lv(LO).rate)} of runs passed at W=${k(LO)}, and every run passed from
W=${k(CLIFF_HI)} upward, while total prompt tokens rose from ${k(lv(LO).tokens)} to ${k(lv('uncapped').tokens)}
across the same span. Capping is cheaper and worse; the operating point is a trade. \`W\` itself is only a proxy:
across all ${REG_CELLS.length} capped runs in this line of work, once the transcript size actually sent is known,
nominal \`W\` adds nothing (p = ${f4(tW.p)}). The main limits are that this is a single task, and that with
${INTERIOR_N.join('/')} runs at interior caps the cliff is located only to between ${k(CLIFF_LO)} and ${k(CLIFF_HI)}.

## What you need to know to read the rest

| Term | Meaning |
|---|---|
${glossMd}

## Why we ran this

Every A/B comparison of eviction rules in this project is run and reported at a nominal \`W\`. Before a
between-rule difference at some \`W\` can be interpreted, three things have to be known: what fraction of \`W\`
is actually available to the history the rules fight over; whether the cap was enforced as labelled; and where
on the success curve that \`W\` sits — a comparison run at a cap where everything passes, or where nothing
does, cannot separate rules. This report establishes those for the incumbent rule, so that other results can be
placed on the curve.

## The experimental setup

### The task

Every run is the same job, called \`longbuild\`. The agent starts in a workspace holding a README, 13
specification documents (~20,000 characters in total) describing a small Python accounting library, five
empty Python stubs to fill in (\`money.py\`, \`parsing.py\`, \`rules.py\`, \`report.py\`, \`cli.py\`), and a visible
test suite it may run at any time. It works through six stages — read a stage's specification, implement it,
run the tests, fix failures, move on — until it declares itself done or hits a ${MAX_TURNS[0]}-step ceiling.
Runs in this report took ${TURN_RANGE[0]} to ${TURN_RANGE[1]} steps.

**Passing** is decided by a *held-out* test suite written into the workspace only after the agent stops,
exercising the same specified behaviour on different data. The agent never sees it, so it cannot pass by
special-casing the tests it can read. Model: \`${MODELS[0]}\`.

### What \`W\` is and how it is enforced

\`W\` is an **artificial per-turn cap on the assembled prompt**, enforced by the assembler *before* the
request is sent. It is deliberately **not** the model's context window — that stays fixed at
**${k(MODEL_WINDOW)} tokens** in every arm, so the provider never rejects anything and no result is an artifact
of a model limit. \`W\` simulates a *deployment* window.

**How it is enforced** (\`policies.mjs → evictToBudget\`):

\`\`\`
avail = W − head(${HEAD}) − reserve(${RESERVE})
keep  = anchors (last A=4 units, never evicted)
        + units in rank order while they still fit avail
\`\`\`

So three things come out of the same budget, and only the third is negotiable:

| component | size | evictable? |
|---|---|---|
| frozen head (system ${est(task.system)} + task ${est(task.task)}) | **${HEAD} tok** | never |
| reply reserve | **${RESERVE} tok** | never (held back for the answer) |
| context units | W − ${HEAD + RESERVE} | yes — this is what eviction fights over |

That fixed tax is why the cap bites harder than it looks: at W=${k(LO)} the head+reserve consume
**${pct(tax(LO))}** of the budget, leaving ${k(usable(LO))} tokens for actual context; at W=${k(HI)} the same
tax is only **${pct(tax(HI))}**, leaving ${k(usable(HI))}.

**Units:** \`W\` is counted with the harness's \`estTokens\` = **characters ÷ 4** heuristic, not the
provider's tokenizer. So \`W\` and the \`peak\` column are in estimated tokens, while
\`total_prompt_tokens\` is the provider's real count. They are consistent within an experiment but not
interchangeable.

### What was varied

- **\`W\`** — ${CAPPED.map(k).join(', ')} tokens, plus an uncapped reference.
- **Arm** — \`${CURVE_ARM}\` only, at every cap. Other arms present in the same batches are excluded (see
  **What we got wrong**).
- **Cadence** — eviction runs every step in every run here. Batches run at other cadences are excluded, because
  there the transcript overshoots \`W\` between evictions.

${RUNS} runs from ${SOURCES.length} batches.

### What was recorded

For each run: pass or fail, the achieved peak, total prompt tokens billed over the run, steps taken, number of
evictions, and cap violations (steps on which the sent prompt exceeded \`W\`).

## Results

### Enforcement check

Cap violations across every run in these batches: **${CAP_VIOLATIONS}**. Achieved peak lands
${Math.min(...UNDER)}–${Math.max(...UNDER)} tokens under \`W\` at the capped levels — the reply reserve of
${RESERVE} being held back, the small remainder being unit sizes that cannot fill the budget exactly. The cap
does what it says.

### Measurements

| W | runs | pass | 95% CI (Wilson) | achieved peak | total prompt tok (med) | turns (med) | evictions (med) |
|---|---|---|---|---|---|---|---|
${rowsMd}

### Reading the curve

- **Dose–response is steep.** Pass rate by cap, \`${CURVE_ARM}\` only: ${doseLine}.
- **Cost moves the opposite way.** ${k(lv(LO).tokens)} → ${k(lv('uncapped').tokens)} median prompt tokens across
  the same span; across the ${R2.n} capped runs, \`W\` explains ${pct(R2.r2)} of the variance in total prompt
  tokens (linear R²).
- **The curve is not monotone point-to-point.** ${nonmonoMd} With n=${INTERIOR_N.join('/')} at the interior
  levels this is within noise, so the data locate the cliff no better than **${k(CLIFF_LO)}–${k(CLIFF_HI)}**.
- **\`W\` is a stand-in for achieved peak.** In a logistic regression over all ${REG_CELLS.length} capped runs
  of this task (every arm and cadence, adjusted for arm), the odds of passing multiply by **${f2(orPeak)}× per
  e-fold** of achieved peak (p = ${f4(tPeak.p)} given cadence). Given achieved peak, nominal \`W\` adds nothing
  (χ²(1) = ${f3(tW.stat)}, p = ${f4(tW.p)}) and neither does eviction cadence (χ²(1) = ${f3(tCad.stat)},
  p = ${f4(tCad.p)}). Full analysis: \`report-cadence-confound.md\`.

## What we got wrong

**1. The first dose–response curve pooled every eviction rule.** Levels were not balanced by rule: W=${k(LO)}
and W=${k(HI)} carried ${POOL_LO.arms}, while every interior level was \`${CURVE_ARM}\` alone. The pooled curve
therefore showed W=${k(LO)} at ${POOL_LO.pass}/${POOL_LO.n} (${pct(POOL_LO.rate)}) and W=${k(HI)} at
${POOL_HI.pass}/${POOL_HI.n} (${pct(POOL_HI.rate)}), with the endpoints dragged down by the deliberately
signal-free \`random\` control relative to the middle. Restricted to the one rule present at every level, those
levels are ${lv(LO).pass}/${lv(LO).n} (${pct(lv(LO).rate)}) and ${lv(HI).pass}/${lv(HI).n} (${pct(lv(HI).rate)}).

**2. Cadence cells were once read at their labelled \`W\`.** At cadence above 1 nothing enforced the cap between
evictions, so those runs sent more than their label. They are excluded from this curve; the correction is
\`report-cadence-confound.md\`.

**3. The two versions of this report quoted different test statistics.** The HTML version stated that, given
achieved peak, nominal \`W\` adds nothing with "LR χ²(1)=0.010, p=0.92" and cadence with "p=0.97", while the
Markdown version stated χ²(1)=0.19, p=0.66 and χ²(1)=0.37, p=0.54. Both were typed by hand. The HTML figures
did not match the arm-adjusted fit. Both versions now compute the statistics from the data: nominal \`W\`
χ²(1) = ${f3(tW.stat)}, p = ${f4(tW.p)}; cadence χ²(1) = ${f3(tCad.stat)}, p = ${f4(tCad.p)}. The conclusion —
neither adds anything — is unchanged.

**4. An unsourced variance figure.** The cost chart was captioned "window explains 88% of the variance", with
no computation behind it. Computed on the runs the chart shows, the linear R² of total prompt tokens on \`W\`
is ${f2(R2.r2)}.

## Conclusions

**Established, for this task and model.** \`W\` is enforced as labelled when eviction runs every step. A fixed
${HEAD + RESERVE}-token tax comes out of it first, so usable history shrinks faster than \`W\`. Under the
incumbent rule, success rises steeply with \`W\` and reaches 100% by W=${k(CLIFF_HI)}, while cost rises
throughout. What predicts success is the transcript size actually sent, not the label.

**Licensed.** Between-rule comparisons should be run at a cap where the incumbent neither always passes nor
always fails — on this task, below ${k(CLIFF_HI)} — and should report achieved peak alongside \`W\`. Budget
targets should be expressed in what is actually sent, net of the fixed head and reserve.

**Not licensed.**

| claim | status |
|---|---|
| success on this task rises with the size of the transcript sent | **tested, supported** |
| nominal \`W\` matters beyond the size actually sent | **tested and rejected** (p = ${f4(tW.p)}) |
| the exact location of the cliff within ${k(CLIFF_LO)}–${k(CLIFF_HI)} | **not resolved** — ${INTERIOR_N.join('/')} runs per interior level |
| the curve has the same shape for other eviction rules | **untested** in this report — only \`${CURVE_ARM}\` is plotted |
| the threshold is a fixed token count rather than a share of the task's demand | **untested** — one task cannot separate them |
| any of this transfers to another task, model, or a real deployment window | **untested** |

## Caveats

- **One task.** All ${RUNS} runs are \`longbuild\`; this is variation within one problem, not across problems.
- **One model**, \`${MODELS[0]}\`, on one host.
- **Small numbers at interior caps** — ${INTERIOR_N.join('/')} runs per level, so individual percentages are
  noisy and the intervals are wide.
- **The regression is observational and pooled.** Achieved peak is a consequence of the settings rather than
  something set directly, and the fit draws on ${REG_CELLS.length} runs across every arm and cadence, not only the
  ${RUNS} plotted here.
- **Token counts for \`W\` and achieved peak are estimates** (characters ÷ 4); only total prompt tokens is the
  provider's count, so \`W\` is not directly a provider-token budget.
- **\`W\` is a simulated deployment window**, not the model's real limit; effects of a genuinely binding model
  limit are not measured.

---
*Generated by \`experiments/context-dedup/report-window-metric.mjs\` from ${SOURCES.map((f) => `\`${f}\``).join(', ')}
(curve) and ${CADENCE_FILES.map((f) => `\`${f}\``).join(', ')} (regression). Charts in the HTML version.*
`;

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The window metric W</title><style>
:root{color-scheme:light}body{margin:0;background:#fafafc;color:${PAL.text};font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:880px;margin:0 auto;padding:32px 20px 64px}h1{font-size:26px;margin:0 0 6px}h2{font-size:19px;margin:32px 0 10px;border-bottom:1px solid ${PAL.grid};padding-bottom:6px}
h3{font-size:16px;margin:22px 0 8px}
.chart{background:#fff;border:1px solid ${PAL.grid};border-radius:10px;padding:14px;margin:14px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px;background:#fff;display:block;overflow-x:auto}th,td{border:1px solid ${PAL.grid};padding:7px 10px;text-align:left;vertical-align:top}th{background:#f2f3fa}
code,pre{background:#f0f0f6;border-radius:4px;font-size:13px}pre{padding:10px 12px;overflow-x:auto}
.exec{background:#eef3ff;border-left:4px solid ${PAL.use};padding:6px 18px;border-radius:6px;margin:14px 0}
footer{color:${PAL.muted};font-size:12px;margin-top:36px}
</style></head><body><main>
<h1>The window metric <code>W</code> — what it measures, and the dose–response</h1>

<div class="exec">
<h2>Abstract</h2>
<p>An AI coding agent re-sends its whole transcript to the model on every step, so a long task eventually
outgrows the space available and older material must be evicted. Every experiment in this line of work studies
that by imposing an artificial cap <code>W</code> on the prompt, far below the model's real
${k(MODEL_WINDOW)}-token window, and reports results "at W". Those results cannot be read without knowing what
<code>W</code> actually constrains, whether it was enforced, and how task success responds to it.</p>
<p>We measured this on ${RUNS} runs of one fixed, ${MAX_TURNS[0]}-step-bounded Python programming task, using only the
incumbent eviction rule (<code>${CURVE_ARM}</code>) so that every level is comparable, at caps from ${k(LO)} to
${k(HI)} tokens and with no cap at all. <code>W</code> is enforced exactly (zero cap violations), but a fixed
head and reply reserve consume ${pct(tax(LO))} of it at W=${k(LO)} and ${pct(tax(HI))} at W=${k(HI)}.</p>
<p>Success responds steeply: ${pct(lv(LO).rate)} of runs passed at W=${k(LO)}, and every run passed from
W=${k(CLIFF_HI)} upward, while total prompt tokens rose from ${k(lv(LO).tokens)} to
${k(lv('uncapped').tokens)} across the same span. Capping is cheaper and worse; the operating point is a trade.
<code>W</code> itself is only a proxy: across all ${REG_CELLS.length} capped runs in this line of work, once the
transcript size actually sent is known, nominal <code>W</code> adds nothing (p = ${f4(tW.p)}). The main limits
are that this is a single task, and that with ${INTERIOR_N.join('/')} runs at interior caps the cliff is located
only to between ${k(CLIFF_LO)} and ${k(CLIFF_HI)}.</p>
</div>

<h2>What you need to know to read the rest</h2>
<table><thead><tr><th>Term</th><th>Meaning</th></tr></thead><tbody>${glossHtml}</tbody></table>

<h2>Why we ran this</h2>
<p>Every A/B comparison of eviction rules in this project is run and reported at a nominal <code>W</code>.
Before a between-rule difference at some <code>W</code> can be interpreted, three things have to be known: what
fraction of <code>W</code> is actually available to the history the rules fight over; whether the cap was
enforced as labelled; and where on the success curve that <code>W</code> sits — a comparison run at a cap where
everything passes, or where nothing does, cannot separate rules. This report establishes those for the
incumbent rule, so that other results can be placed on the curve.</p>

<h2>The experimental setup</h2>
<h3>The task</h3>
<p>Every run is the same job, called <code>longbuild</code>. The agent starts in a workspace holding a README,
13 specification documents (~20,000 characters in total) describing a small Python accounting library, five
empty Python stubs to fill in (<code>money.py</code>, <code>parsing.py</code>, <code>rules.py</code>,
<code>report.py</code>, <code>cli.py</code>), and a visible test suite it may run at any time. It works through
six stages — read a stage's specification, implement it, run the tests, fix failures, move on — until it
declares itself done or hits a ${MAX_TURNS[0]}-step ceiling. Runs in this report took ${TURN_RANGE[0]} to
${TURN_RANGE[1]} steps.</p>
<p><strong>Passing</strong> is decided by a <em>held-out</em> test suite written into the workspace only after
the agent stops, exercising the same specified behaviour on different data. The agent never sees it, so it
cannot pass by special-casing the tests it can read. Model: <code>${esc(MODELS[0])}</code>.</p>
<h3>What <code>W</code> is and how it is enforced</h3>
<p><code>W</code> is an <strong>artificial per-turn cap on the assembled prompt</strong>, enforced by the
assembler <em>before</em> the request is sent. The model's real context window stays at
<strong>${k(MODEL_WINDOW)} tokens</strong> in every arm, so the provider never rejects anything and no result is
an artifact of a model limit. <code>W</code> simulates a <em>deployment</em> window.</p>
<p>How it is enforced (<code>policies.mjs → evictToBudget</code>):</p>
<pre>avail = W − head(${HEAD}) − reserve(${RESERVE})
keep  = anchors (last A=4 units, never evicted)
        + units in rank order while they still fit avail</pre>
<table><thead><tr><th>component</th><th>size</th><th>evictable?</th></tr></thead><tbody>
<tr><td>frozen head (system ${est(task.system)} + task ${est(task.task)})</td><td><strong>${HEAD} tok</strong></td><td>never</td></tr>
<tr><td>reply reserve</td><td><strong>${RESERVE} tok</strong></td><td>never — held back for the answer</td></tr>
<tr><td>context units</td><td>W − ${HEAD + RESERVE}</td><td><strong>yes</strong> — what eviction fights over</td></tr>
</tbody></table>
<div class="chart">${chartBudget()}</div>
<p>That fixed tax is why a tight cap bites harder than it looks: at W=${k(LO)} head+reserve consume
<strong>${pct(tax(LO))}</strong> of the budget, leaving <strong>${k(usable(LO))}</strong> tokens of actual
context; at W=${k(HI)} the same tax is only <strong>${pct(tax(HI))}</strong>, leaving
<strong>${k(usable(HI))}</strong>. Cutting the cap from ${k(HI)} to ${k(LO)} cut usable context by
<strong>${pct(1 - usable(LO) / usable(HI))}</strong>, not by ${pct(1 - LO / HI)}.</p>
<p><strong>Units:</strong> <code>W</code> and the achieved peak are counted with the harness estimator
<code>estTokens = characters ÷ 4</code>, <strong>not</strong> the provider's tokenizer.
<code>total_prompt_tokens</code> is the provider's real count. They are consistent within an experiment but are
<strong>not interchangeable</strong>.</p>
<h3>What was varied</h3>
<ul>
<li><strong><code>W</code></strong> — ${CAPPED.map(k).join(', ')} tokens, plus an uncapped reference.</li>
<li><strong>Arm</strong> — <code>${CURVE_ARM}</code> only, at every cap. Other arms present in the same batches
are excluded (see <strong>What we got wrong</strong>).</li>
<li><strong>Cadence</strong> — eviction runs every step in every run here. Batches run at other cadences are
excluded, because there the transcript overshoots <code>W</code> between evictions.</li>
</ul>
<p>${RUNS} runs from ${SOURCES.length} batches.</p>
<h3>What was recorded</h3>
<p>For each run: pass or fail, the achieved peak, total prompt tokens billed over the run, steps taken, number
of evictions, and cap violations (steps on which the sent prompt exceeded <code>W</code>).</p>

<h2>Results</h2>
<h3>Enforcement check</h3>
<p>Cap violations across every run in these batches: <strong>${CAP_VIOLATIONS}</strong>. Achieved peak lands
${Math.min(...UNDER)}–${Math.max(...UNDER)} tokens under <code>W</code> at the capped levels — the reply reserve
of ${RESERVE} being held back, the small remainder being unit sizes that cannot fill the budget exactly. The cap
does what it says.</p>
<h3>Measurements</h3>
<div class="chart">${chartDose()}</div>
<table><thead><tr><th>W</th><th>runs</th><th>pass</th><th>95% CI (Wilson)</th><th>achieved peak</th><th>total prompt tok (med)</th><th>turns (med)</th><th>evictions (med)</th></tr></thead><tbody>
${rowsHtml}
</tbody></table>
<div class="chart">${chartCost()}</div>
<h3>Reading the curve</h3>
<ul>
<li><strong>Dose–response is steep.</strong> Pass rate by cap, <code>${CURVE_ARM}</code> only: ${esc(doseLine)}.</li>
<li><strong>Cost moves the opposite way.</strong> ${k(lv(LO).tokens)} → ${k(lv('uncapped').tokens)} median
prompt tokens across the same span; across the ${R2.n} capped runs, <code>W</code> explains ${pct(R2.r2)} of the
variance in total prompt tokens (linear R²).</li>
<li><strong>The curve is not monotone point-to-point.</strong> ${esc(nonmonoMd)} With n=${INTERIOR_N.join('/')}
at the interior levels this is within noise, so the data locate the cliff no better than
<strong>${k(CLIFF_LO)}–${k(CLIFF_HI)}</strong>.</li>
<li><strong><code>W</code> is a stand-in for achieved peak.</strong> In a logistic regression over all
${REG_CELLS.length} capped runs of this task (every arm and cadence, adjusted for arm), the odds of passing
multiply by <strong>${f2(orPeak)}× per e-fold</strong> of achieved peak (p = ${f4(tPeak.p)} given cadence).
Given achieved peak, nominal <code>W</code> adds nothing (χ²(1) = ${f3(tW.stat)}, p = ${f4(tW.p)}) and neither
does eviction cadence (χ²(1) = ${f3(tCad.stat)}, p = ${f4(tCad.p)}). Full analysis:
<code>report-cadence-confound.md</code>.</li>
</ul>

<h2>What we got wrong</h2>
<p><strong>1. The first dose–response curve pooled every eviction rule.</strong> Levels were not balanced by
rule: W=${k(LO)} and W=${k(HI)} carried ${esc(POOL_LO.arms)}, while every interior level was
<code>${CURVE_ARM}</code> alone. The pooled curve therefore showed W=${k(LO)} at ${POOL_LO.pass}/${POOL_LO.n}
(${pct(POOL_LO.rate)}) and W=${k(HI)} at ${POOL_HI.pass}/${POOL_HI.n} (${pct(POOL_HI.rate)}), with the endpoints
dragged down by the deliberately signal-free <code>random</code> control relative to the middle. Restricted to
the one rule present at every level, those levels are ${lv(LO).pass}/${lv(LO).n} (${pct(lv(LO).rate)}) and
${lv(HI).pass}/${lv(HI).n} (${pct(lv(HI).rate)}).</p>
<p><strong>2. Cadence cells were once read at their labelled <code>W</code>.</strong> At cadence above 1 nothing
enforced the cap between evictions, so those runs sent more than their label. They are excluded from this curve;
the correction is <code>report-cadence-confound.md</code>.</p>
<p><strong>3. The two versions of this report quoted different test statistics.</strong> The HTML version stated
that, given achieved peak, nominal <code>W</code> adds nothing with "LR χ²(1)=0.010, p=0.92" and cadence with
"p=0.97", while the Markdown version stated χ²(1)=0.19, p=0.66 and χ²(1)=0.37, p=0.54. Both were typed by
hand. The HTML figures did not match the arm-adjusted fit. Both versions now compute the statistics from the
data: nominal <code>W</code> χ²(1) = ${f3(tW.stat)}, p = ${f4(tW.p)}; cadence χ²(1) = ${f3(tCad.stat)},
p = ${f4(tCad.p)}. The conclusion — neither adds anything — is unchanged.</p>
<p><strong>4. An unsourced variance figure.</strong> The cost chart was captioned "window explains 88% of the
variance", with no computation behind it. Computed on the runs the chart shows, the linear R² of total prompt
tokens on <code>W</code> is ${f2(R2.r2)}.</p>

<h2>Conclusions</h2>
<p><strong>Established, for this task and model.</strong> <code>W</code> is enforced as labelled when eviction
runs every step. A fixed ${HEAD + RESERVE}-token tax comes out of it first, so usable history shrinks faster than
<code>W</code>. Under the incumbent rule, success rises steeply with <code>W</code> and reaches 100% by
W=${k(CLIFF_HI)}, while cost rises throughout. What predicts success is the transcript size actually sent, not
the label.</p>
<p><strong>Licensed.</strong> Between-rule comparisons should be run at a cap where the incumbent neither always
passes nor always fails — on this task, below ${k(CLIFF_HI)} — and should report achieved peak alongside
<code>W</code>. Budget targets should be expressed in what is actually sent, net of the fixed head and
reserve.</p>
<p><strong>Not licensed.</strong></p>
<table><thead><tr><th>claim</th><th>status</th></tr></thead><tbody>
<tr><td>success on this task rises with the size of the transcript sent</td><td><strong>tested, supported</strong></td></tr>
<tr><td>nominal <code>W</code> matters beyond the size actually sent</td><td><strong>tested and rejected</strong> (p = ${f4(tW.p)})</td></tr>
<tr><td>the exact location of the cliff within ${k(CLIFF_LO)}–${k(CLIFF_HI)}</td><td><strong>not resolved</strong> — ${INTERIOR_N.join('/')} runs per interior level</td></tr>
<tr><td>the curve has the same shape for other eviction rules</td><td><strong>untested</strong> in this report — only <code>${CURVE_ARM}</code> is plotted</td></tr>
<tr><td>the threshold is a fixed token count rather than a share of the task's demand</td><td><strong>untested</strong> — one task cannot separate them</td></tr>
<tr><td>any of this transfers to another task, model, or a real deployment window</td><td><strong>untested</strong></td></tr>
</tbody></table>

<h2>Caveats</h2>
<ul>
<li><strong>One task.</strong> All ${RUNS} runs are <code>longbuild</code>; this is variation within one problem,
not across problems.</li>
<li><strong>One model</strong>, <code>${esc(MODELS[0])}</code>, on one host.</li>
<li><strong>Small numbers at interior caps</strong> — ${INTERIOR_N.join('/')} runs per level, so individual
percentages are noisy and the intervals are wide.</li>
<li><strong>The regression is observational and pooled.</strong> Achieved peak is a consequence of the settings
rather than something set directly, and the fit draws on ${REG_CELLS.length} runs across every arm and cadence,
not only the ${RUNS} plotted here.</li>
<li><strong>Token counts for <code>W</code> and achieved peak are estimates</strong> (characters ÷ 4); only
total prompt tokens is the provider's count, so <code>W</code> is not directly a provider-token budget.</li>
<li><strong><code>W</code> is a simulated deployment window</strong>, not the model's real limit; effects of a
genuinely binding model limit are not measured.</li>
</ul>
<footer>context-tree · window metric · generated by experiments/context-dedup/report-window-metric.mjs from ${esc(SOURCES.join(', '))} (curve) and ${esc(CADENCE_FILES.join(', '))} (regression)</footer>
</main></body></html>`;

writeFileSync(join(OUT, 'report-window-metric.md'), MD);
writeFileSync(join(OUT, 'report-window-metric.html'), HTML);
console.log('wrote report-window-metric.{md,html} ->', OUT);
console.log(`runs=${RUNS} levels=${CAPPED.join(',')} cliff=${CLIFF_LO}-${CLIFF_HI} R2=${f2(R2.r2)} capViolations=${CAP_VIOLATIONS} W|peak p=${f4(tW.p)}`);
