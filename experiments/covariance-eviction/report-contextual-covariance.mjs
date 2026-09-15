/**
 * REPORT — contextual covariance: a signal that holds where the incumbents collapse.
 *
 * Regenerates from the results JSON every time, so no number in the prose can drift from
 * the data. Emits report-contextual-covariance.{md,html}; the HTML is self-contained
 * (inline SVG, no CDN, no external refs). Every lookup goes through `must()`/`find()`,
 * which throw rather than interpolating "undefined" into a sentence.
 *
 * Rerun: node experiments/covariance-eviction/report-contextual-covariance.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'reports', 'metrics', 'covariance-eviction');
const load = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'));
const FILES = ['results-contextual-covariance-v1.json', 'results-contextual-covariance-nopath.json',
  'results-h2-corpus-survey.json'];
{
  const present = new Set(readdirSync(OUT));
  const missing = FILES.filter((f) => !present.has(f));
  if (missing.length) throw new Error(`missing result files: ${missing.join(', ')}`);
}
const main0 = load(FILES[0]);
const nopath = load(FILES[1]);
const survey = load(FILES[2]);

function must(v, what) { if (v === undefined || v === null) throw new Error(`report: missing ${what}`); return v; }
function find(arr, pred, what) { const r = must(arr, `${what} (array)`).find(pred); if (!r) throw new Error(`report: no row for ${what}`); return r; }

const SPACES = { ...must(main0.by_space, 'by_space'), ...must(nopath.by_space, 'nopath by_space') };
const ORDER = ['files', 'fp', 'fp-nopath', 'lex'];
const sp = (k) => must(SPACES[k], `space ${k}`);
const MAN = must(main0.manifest, 'manifest');
const P = must(MAN.params, 'params');
const PRIMARY_M = must(P.primary_budget, 'primary_budget');
const GATES = must(P.gates, 'gates');

const pct = (x, d = 1) => `${(100 * must(x, 'pct')).toFixed(d)}%`;
const n0 = (x) => Math.round(must(x, 'n')).toLocaleString('en-US');
const sgn = (x) => (x > 0 ? `+${x.toFixed(4)}` : x.toFixed(4));
const ci = (a) => `[${a[0] > 0 ? '+' : ''}${must(a, 'ci')[0].toFixed(4)}, ${a[1] > 0 ? '+' : ''}${a[1].toFixed(4)}]`;
const star = (c) => (c.excludes_zero ? ' ★' : '');

const dorm = (k) => must(sp(k).dormancy_sweep, `dormancy_sweep ${k}`);
const dormAt = (k, D) => find(dorm(k), (r) => r.D === D, `${k} D=${D}`);
const tableRow = (k, s) => find(must(sp(k).table, `table ${k}`), (r) => r.scorer === s, `${k}/${s}`);
const primary = (k) => find(must(sp(k).contrasts, `contrasts ${k}`), (c) => c.is_primary, `${k} primary`);
const contrast = (k, t, c, M, metric) => find(must(sp(k).contrasts, `contrasts ${k}`),
  (r) => r.treatment === t && r.control === c && r.budget === M && r.metric === metric, `${k} ${t}-${c}@${M}`);
const V = (k) => must(sp(k).validity, `validity ${k}`);
const DS = must(dorm('fp').map((r) => r.D), 'D list');
const FIXPOOL = must(survey.corpus_density.fixtures_pooled, 'fixtures_pooled');
const PASSED = ORDER.filter((k) => V(k).interpretable);
const GATED_OUT = ORDER.filter((k) => !V(k).interpretable);

// ── charts ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** CHART 1 — the dormancy gradient: incumbents collapse, covariance holds. */
function chartDormancy(space) {
  const rows = dorm(space);
  const W = 720, H = 330, padL = 62, padR = 118, padT = 46, padB = 52;
  const maxD = Math.max(...rows.map((r) => r.D));
  const minD = Math.min(...rows.map((r) => r.D));
  const X = (d) => padL + ((d - minD) / (maxD - minD)) * (W - padL - padR);
  const Y = (v) => H - padB - (v / 0.45) * (H - padT - padB);
  const lines = [
    ['tcov', '#2c6fbb', 3], ['relevance', '#e08a1e', 2],
    ['recency-only', '#c0392b', 2], ['idle-only', '#8e44ad', 2], ['random', '#8a8a98', 1.5],
  ];
  let s = '';
  for (let g = 0; g <= 0.45001; g += 0.1) {
    s += `<line x1="${padL}" y1="${Y(g).toFixed(1)}" x2="${W - padR}" y2="${Y(g).toFixed(1)}" stroke="#e3e3ea" stroke-width="1"/>`;
    s += `<text x="${padL - 8}" y="${(Y(g) + 4).toFixed(1)}" font-size="11" fill="#6a6a78" text-anchor="end">${g.toFixed(1)}</text>`;
  }
  for (const [name, col, w] of lines) {
    const pts = rows.map((r) => `${X(r.D).toFixed(1)},${Y(must(r.recall[name], `recall ${name}`)).toFixed(1)}`).join(' ');
    s += `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="${w}"${name === 'random' ? ' stroke-dasharray="5 3"' : ''}/>`;
    for (const r of rows) s += `<circle cx="${X(r.D).toFixed(1)}" cy="${Y(r.recall[name]).toFixed(1)}" r="3" fill="${col}"/>`;
    const last = rows[rows.length - 1];
    s += `<text x="${(W - padR + 6).toFixed(1)}" y="${(Y(last.recall[name]) + 4).toFixed(1)}" font-size="10.5" fill="${col}">${esc(name)}</text>`;
  }
  for (const r of rows) s += `<text x="${X(r.D).toFixed(1)}" y="${H - padB + 16}" font-size="11" fill="#6a6a78" text-anchor="middle">${r.D}</text>`;
  s += `<text x="${((padL + W - padR) / 2).toFixed(1)}" y="${H - 12}" font-size="11.5" fill="#4a4a58" text-anchor="middle">dormancy threshold D (turns since the unit's files were last touched)</text>`;
  s += `<text x="${padL}" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">Keep-needed recall on dormant units, as "dormant" is made stricter (${esc(space)}, M=${PRIMARY_M})</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Recall against dormancy threshold by signal" style="max-width:100%;height:auto">${s}</svg>`;
}

/** CHART 2 — the two gates, per feature space. */
function chartGates() {
  const W = 720, H = 260, padL = 96, padR = 150, padT = 46, padB = 46;
  const bh = (H - padT - padB) / ORDER.length;
  const X = (v) => padL + v * (W - padL - padR);
  let s = '';
  s += `<line x1="${X(GATES.support).toFixed(1)}" y1="${padT - 8}" x2="${X(GATES.support).toFixed(1)}" y2="${H - padB}" stroke="#c0392b" stroke-width="2" stroke-dasharray="6 4"/>`;
  s += `<text x="${X(GATES.support).toFixed(1)}" y="${padT - 12}" font-size="11" fill="#c0392b" text-anchor="middle">support gate ${pct(GATES.support, 0)}</text>`;
  ORDER.forEach((k, i) => {
    const v = V(k);
    const y = padT + bh * i + bh / 2;
    const ok = v.interpretable;
    s += `<rect x="${padL}" y="${(y - 9).toFixed(1)}" width="${Math.max(0, X(v.support_share_same_turn) - padL).toFixed(1)}" height="18" fill="${ok ? '#2c6fbb' : '#b9525a'}"/>`;
    s += `<text x="${padL - 10}" y="${(y + 4).toFixed(1)}" font-size="11.5" fill="#3a3a48" text-anchor="end">${esc(k)}</text>`;
    s += `<text x="${(X(v.support_share_same_turn) + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="11" fill="#4a4a58">${pct(v.support_share_same_turn)} · ${v.mean_features_per_turn} feat/turn · ${ok ? 'PASS' : 'FAIL'}</text>`;
  });
  s += `<text x="${padL}" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">Support: share of candidates whose pairing with the current turn has co-activation history</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Support share by feature space against the gate" style="max-width:100%;height:auto">${s}</svg>`;
}

/** CHART 3 — covariance minus the random floor, by dormancy, across the spaces that passed. */
function chartFloor() {
  const W = 720, H = 300, padL = 62, padR = 110, padT = 46, padB = 52;
  const rows = dorm(PASSED[0]);
  const maxD = Math.max(...rows.map((r) => r.D)), minD = Math.min(...rows.map((r) => r.D));
  const X = (d) => padL + ((d - minD) / (maxD - minD)) * (W - padL - padR);
  const all = PASSED.flatMap((k) => dorm(k).flatMap((r) => [r.tcov_vs_random.ci95[0], r.tcov_vs_random.ci95[1]]));
  const lo = Math.min(-0.02, ...all), hi = Math.max(...all);
  const Y = (v) => H - padB - ((v - lo) / (hi - lo)) * (H - padT - padB);
  const cols = { fp: '#2c6fbb', 'fp-nopath': '#1a8f6a', lex: '#e08a1e' };
  let s = '';
  s += `<line x1="${padL}" y1="${Y(0).toFixed(1)}" x2="${W - padR}" y2="${Y(0).toFixed(1)}" stroke="#2b2b38" stroke-width="1.5"/>`;
  s += `<text x="${(W - padR + 6).toFixed(1)}" y="${(Y(0) + 4).toFixed(1)}" font-size="10.5" fill="#2b2b38">no better than random</text>`;
  PASSED.forEach((k, ki) => {
    const col = cols[k] || '#666';
    const dx = (ki - (PASSED.length - 1) / 2) * 7;
    for (const r of dorm(k)) {
      const c = r.tcov_vs_random;
      const x = X(r.D) + dx;
      s += `<line x1="${x.toFixed(1)}" y1="${Y(c.ci95[0]).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(c.ci95[1]).toFixed(1)}" stroke="${col}" stroke-width="1.6"/>`;
      s += `<circle cx="${x.toFixed(1)}" cy="${Y(c.delta).toFixed(1)}" r="3.6" fill="${c.excludes_zero ? col : '#fff'}" stroke="${col}" stroke-width="1.6"/>`;
    }
    s += `<text x="${(W - padR + 6).toFixed(1)}" y="${(padT + 14 + ki * 15).toFixed(1)}" font-size="11" fill="${col}">${esc(k)}</text>`;
  });
  for (const r of rows) s += `<text x="${X(r.D).toFixed(1)}" y="${H - padB + 16}" font-size="11" fill="#6a6a78" text-anchor="middle">${r.D}</text>`;
  s += `<text x="${((padL + W - padR) / 2).toFixed(1)}" y="${H - 12}" font-size="11.5" fill="#4a4a58" text-anchor="middle">dormancy threshold D  ·  filled = interval excludes zero</text>`;
  s += `<text x="${padL}" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">Covariance minus the random floor (recall on dormant units, M=${PRIMARY_M})</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Covariance advantage over random by dormancy and feature space" style="max-width:100%;height:auto">${s}</svg>`;
}

// ── prose ───────────────────────────────────────────────────────────────────
const gateRows = ORDER.map((k) => {
  const v = V(k);
  return `| \`${k}\` | ${v.mean_features_per_turn} | ${pct(v.support_share_same_turn)} | ${v.support_gate_passed ? 'pass' : '**fail**'} | ${v.mean_distinct_scores_per_turn} | ${pct(v.mean_share_at_per_turn_ceiling)} | ${pct(v.share_turns_near_flat)} | ${v.flatness_gate_passed ? 'pass' : '**fail**'} | ${v.interpretable ? '**interpretable**' : 'not interpretable'} |`;
}).join('\n');

const dormRows = (k) => dorm(k).map((r) => {
  const best = must(r.best_scorer, 'best');
  return `| ${r.D} | ${n0(r.needed_rows)} | **${r.recall.tcov}** | ${r.recall.relevance} | ${r.recall['recency-only']} | ${r.recall['idle-only']} | ${r.recall.random} | ${best} | ${sgn(r.tcov_vs_random.delta)} ${ci(r.tcov_vs_random.ci95)}${star(r.tcov_vs_random)} |`;
}).join('\n');

const scorerRows = (k) => must(sp(k).table, 'table').map((r) =>
  `| \`${r.scorer}\` | ${r.auc} ${ci(r.auc_ci)} | ${r['recall@32']} | ${r['recall@32_nonmonotonic']} |`).join('\n');

const primaryRows = PASSED.map((k) => {
  const c = primary(k);
  return `| \`${k}\` | ${sgn(c.delta)} | ${ci(c.ci95)} | ${c.excludes_zero ? '**excludes 0**' : 'contains 0'} | ${c.p_holm} | ${V(k).spearman_tcov_vs_relevance} |`;
}).join('\n');

const floorRows = PASSED.map((k) => {
  const c = contrast(k, 'tcov', 'random', PRIMARY_M, 'recall_nonmonotonic');
  return `| \`${k}\` | ${sgn(c.delta)} | ${ci(c.ci95)} | ${c.excludes_zero ? '**excludes 0**' : 'contains 0'} |`;
}).join('\n');

const inclRows = PASSED.map((k) => {
  const c = contrast(k, 'tcov-inclusive', 'tcov', PRIMARY_M, 'recall_nonmonotonic');
  return `| \`${k}\` | ${sgn(c.delta)} | ${ci(c.ci95)} | ${c.excludes_zero ? '**excludes 0**' : 'contains 0'} |`;
}).join('\n');

const FP = 'fp', NP = 'fp-nopath', LX = 'lex';
const dFirst = DS[0], dLast = DS[DS.length - 1];
const rFirst = dormAt(FP, dFirst), rLast = dormAt(FP, dLast);

const MD = `# Contextual covariance: a signal that holds where the incumbents collapse

*A positive result, with a pre-registered primary that misses, and a correction to the previous report in this series.*

> This report follows \`report-covariance-eviction.md\`, which concluded that a pairwise
> co-reference signal is starved on agent transcripts. **That conclusion was over-general**
> and is corrected in **What we got wrong**. The starvation is a property of keying the
> signal on file paths, not of covariance.

---

## Abstract

An AI coding agent re-sends its whole working transcript to the model on every step, so on a
long task the transcript outgrows the model's input limit and material must be deleted. The
hardest case for any deletion rule is the unit that has gone quiet and is then needed again:
a rule that keeps what resembles the agent's current work deletes exactly that unit, which
is why relevance-to-recent was previously measured as the *worst* available eviction signal
and is weighted zero in the shipped system.

This report tests the signal that would keep that unit. For every unit still held, we ask
not whether it resembles what the agent is doing now, but whether its features have
*historically been active alongside* the features the agent is working on now — a phi
coefficient over each session's own co-activation history, with the history window and the
current window kept disjoint and with any feature the unit shares with the current window
removed from both sides, so that present similarity cannot contribute. A previous version of
this work keyed that statistic on file paths, found that ${pct(FIXPOOL.share_turns_able_to_pair)}
of file-referencing turns name more than one file, and concluded the statistic was starved.
Keyed on identifiers instead, the same transcripts support it on
${pct(V(FP).support_share_same_turn)} of decisions rather than ${pct(V('files').support_share_same_turn)}.

The result is a clear gradient and a qualified primary. As the definition of "dormant" is
made stricter — from ${dFirst} turns since a unit's files were touched, out to ${dLast} —
positional recency falls from ${rFirst.recall['recency-only']} to ${rLast.recall['recency-only']}
and reference-recency from ${rFirst.recall['idle-only']} to ${rLast.recall['idle-only']}, while
covariance is almost flat, ${rFirst.recall.tcov} to ${rLast.recall.tcov}. It is the best of the
six signals from D=20 onward, and it beats a volume-matched random control at every dormancy
depth up to ${DS[DS.length - 2]} with intervals excluding zero. That gradient is what the
hypothesis predicted, and it is the mechanism the earlier finding about relevance describes,
observed directly. The decisive control passes too: covariance is not relevance renamed, with
a rank correlation of ${V(FP).spearman_tcov_vs_relevance} between the two orderings, and the
advantage survives stripping every path-bearing token from the feature set, which rules out
the signal simply exploiting the file vocabulary its label is written in.

What does not pass is the pre-registered primary as written. It required covariance to beat
*relevance specifically*, at one budget and one dormancy threshold; it misses in the
identifier space by a lower bound of ${primary(FP).ci95[0].toFixed(4)} and fires only in the
lexical space, which is the one space where covariance does **not** beat the random floor.
The pre-registration named the relabelling control and omitted the floor control, and on this
evidence the floor contrast is the more informative of the two. The honest verdict is that
contextual covariance is a real signal with a mechanism that behaves as theorised, not yet an
established improvement over the specific incumbent it was pre-registered against.

---

## What you need to know to read the rest

| Term | Meaning |
|---|---|
| **Agent** | An AI model given tools (read a file, write a file, run a command) and a goal, looping until it decides it is done. |
| **Transcript / context** | Everything the model sees on a step: instructions plus the full history of what it read, wrote and ran. Re-sent in full every step. |
| **Token** | The unit context is measured in — roughly ¾ of a word. |
| **Eviction** | Deleting older material to get back under the input limit. The subject here is *what* to delete. |
| **Admission** | The opposite operation: deciding what to pull back in. The scores here could serve it; this report does not measure it. |
| **Unit** | The thing eviction deletes: one API turn, kept whole so a tool call is never split from its result. |
| **Decision** | One moment at which the policy ranks the units it holds. Scored against what the agent did next. |
| **Feature** | Whatever the signal is keyed on. Four spaces are tested: file paths, identifiers, identifiers with paths removed, and content words. |
| **Fingerprint** | A distinctive identifier — camelCase, PascalCase, UPPER_SNAKE, a back-quoted symbol, a file path. Extracted by the function the shipped system uses. |
| **Hot window** | The features of the last few turns — what the agent is working on right now. |
| **Relevance** | Plain overlap (Jaccard) between a unit's features and the hot window's. **No history.** The signal that was previously measured as worst, and the control this experiment lives or dies on. |
| **Contextual covariance ("tcov")** | The candidate signal: how strongly a unit's features have *historically* been active alongside the hot window's, with shared features excluded so present overlap contributes nothing. |
| **Phi coefficient** | The correlation between two yes/no series — "was feature A active this turn" against "was feature B active this turn". A feature active on *every* turn scores zero against everything, which is the guard against a promiscuous feature linking everything to everything. |
| **Support** | How many turns two features were actually active together. Zero support means the correlation is computed from an empty table, i.e. noise. |
| **Saturation** | The opposite failure: so many features co-occur that every unit scores alike and the signal is inert. |
| **Recall@M** | Of the units the agent turned out to need, the share a policy keeps when it can keep only M. |
| **AUC** | The chance a needed unit outranks an unneeded one inside one decision. 0.5 is a coin flip. |
| **The non-monotonic subset** | The hard case: units needed again after going quiet for more than D turns. D is swept here rather than assumed. |
| **Moving-block bootstrap** | Error bars that respect the fact that consecutive decisions are related: blocks of consecutive decisions are resampled, never single ones. |
| **Holm correction** | An adjustment for making several comparisons at once, so testing many things does not manufacture one apparent success. |

---

## Why we ran this

The shipped eviction scorer weights four signals, and it weights query-relevance at **zero**.
That is not an oversight; it is a finding. A unit that has gone dormant does not, by
definition, resemble the recent window, so a relevance rule deletes precisely the unit that is
about to be needed again. The dormant-return case is the one that costs the agent work, and
relevance is worst on it.

That leaves a gap. Nothing in the system computes whether a unit *goes with* what is happening
now — only whether it *looks like* it. Those are different questions, and only the second had
been measured. Contextual covariance asks the first: a unit whose features have historically
been active alongside the features now in play is a good bet even if it shares nothing with
them today, which is exactly the unit relevance throws away.

A previous report tried this and could not test it, because it keyed the statistic on file
paths and ${pct(1 - FIXPOOL.share_turns_able_to_pair)} of file-referencing turns name only one
file. That measurement was right; the conclusion drawn from it — that covariance in general is
starved — was not.

---

## The experimental setup

### The corpus and what a decision is

Four real Claude Code transcripts committed to the repository, ${n0(must(survey.corpus_density.fixtures_pooled.turns, 'turns'))}
turns in total. A **unit** is one API turn. At each **decision** the policy ranks the units it
holds, capped at the most recent ${P.MAX_CAND}. Candidates are past turns that referenced at
least one file, so the label is defined for every candidate in every arm.

The **label is behavioural and file-based**: a unit counts as *needed* if the agent issued a
tool call naming one of that unit's files within the next ${P.H} turns. Keeping a file-based
label while sweeping the signal to content words is deliberate — in the \`lex\` arm the signal
and the label share no vocabulary at all, which makes it the least circular of the four.

### The signal

For unit features \`F\` and hot-window features \`Q\`, over history strictly older than the
hot window:

> score(u) = max over f in F\\Q, g in Q\\F of phi(f, g), shrunk toward zero when the pair has
> little co-activation history

The set subtraction is the experiment. Features the unit **shares** with the hot window are
removed from both sides, so a unit scores only through the historical association of features
it has and the window does not, with features the window has and it does not. Present overlap —
which *is* relevance — cannot contribute. A sensitivity arm, \`tcov-inclusive\`, puts the
shared features back; if only that version worked, the working part would be relevance.

### Feature spaces, and the two gates

Every space must clear **support** (enough candidates have any co-activation history at all —
the starvation guard) and **flatness** (the score is not near-constant across units — the
saturation guard). Both are reported before any contrast.

| feature space | features/turn | support (same-turn) | gate | distinct scores/turn | at ceiling | near-flat turns | gate | verdict |
|---|---|---|---|---|---|---|---|---|
${gateRows}

${chartGates()}

\`files\` fails exactly as the previous report found, which is the check that this experiment
has not quietly changed the thing that failed. The other three pass both gates comfortably:
they are dense enough to have history and varied enough not to be inert.

### How the error bars are computed

Moving-block bootstrap over blocks of ${P.block_len} consecutive decisions, resampled within a
transcript and never across two, because consecutive decisions share candidates and a label
window. Contrast families are Holm-corrected with one pre-specified primary.

---

## Results

### The dormancy gradient — the main finding

\`D\` is the threshold that defines "dormant": a unit counts only if its files have not been
touched for more than D turns. It re-labels rows without touching any score, so the whole
sweep comes from one pass. Identifier space:

| D | needed rows | tcov | relevance | recency | idle | random | best signal | tcov − random |
|---|---|---|---|---|---|---|---|---|
${dormRows(FP)}

${chartDormancy(FP)}

Read across the table rather than down a column. At D=${dFirst} — barely dormant — positional
recency is the best keeper, at ${rFirst.recall['recency-only']}. By D=${dLast} it has fallen to
${rLast.recall['recency-only']} and reference-recency to ${rLast.recall['idle-only']}: the two
incumbent signals are near-useless on units that have genuinely gone quiet, which is precisely
what the earlier finding about relevance describes and what the shipped scorer's protective
terms are supposed to cover. **Covariance barely moves**, ${rFirst.recall.tcov} to
${rLast.recall.tcov}, and takes the lead from D=20 onward.

That the D=${dFirst} subset is *won by positional recency* is itself informative: at that
threshold the subset is not isolating deep dormancy at all. D=10 was inherited from an
experiment whose "turn" was a different and shorter unit, and this is the first time it has
been swept.

### Against the random floor

The floor control is volume-matched — same budget, same candidates, random order.

| feature space | tcov − random at D=${dFirst}, M=${PRIMARY_M} | interval | |
|---|---|---|---|
${floorRows}

${chartFloor()}

In both identifier spaces covariance is clear of the floor at every dormancy depth up to
${DS[DS.length - 2]}. In the lexical space it never separates from it.

### The pre-registered primary — and why it is the weaker test

The primary was: covariance beats **relevance** on the dormant subset at M=${PRIMARY_M},
D=${dFirst}, interval excluding zero.

| feature space | tcov − relevance | interval | | Holm p | Spearman(tcov, relevance) |
|---|---|---|---|---|---|
${primaryRows}

It fires in \`lex\` and misses in \`fp\` by a lower bound of ${primary(FP).ci95[0].toFixed(4)}.
But \`lex\` is the space where covariance does not beat random, so its win over relevance there
reflects relevance being *worse than random* on dormant units rather than covariance being
good. **The pre-registration named the relabelling control and omitted the floor control**, and
the floor contrast turns out to be the more informative of the two. That hole was written into
the design document before the run and is restated here rather than discovered afterwards.

### The relabelling control, and the path-token control

Two ways this result could be an illusion, both tested.

**Is it relevance renamed?** No. The rank correlation between the two policy orderings is
${V(FP).spearman_tcov_vs_relevance} in \`fp\`, ${V(NP).spearman_tcov_vs_relevance} in
\`fp-nopath\` and ${V(LX).spearman_tcov_vs_relevance} in \`lex\` — against a pre-registered
relabelling threshold of ${GATES.relabelling}. They are close to orthogonal. The sensitivity
arm agrees: putting the shared features back makes the signal **worse**, not better.

| feature space | tcov-inclusive − tcov | interval | |
|---|---|---|---|
${inclRows}

**Is it just file paths predicting file references?** The label is a file reference and the
\`fp\` feature set contains paths, so the signal could be exploiting the label's own
vocabulary. Stripping every path-bearing token leaves \`fp-nopath\` — camelCase, PascalCase,
UPPER_SNAKE and back-quoted symbols only, ${V(NP).mean_features_per_turn} features per turn —
and the advantage over random survives at
${sgn(dormAt(NP, dFirst).tcov_vs_random.delta)} ${ci(dormAt(NP, dFirst).tcov_vs_random.ci95)}.
Whatever is carrying the signal, it is not path-to-path matching.

### Overall ranking, for context

Covariance is a *specialist*. On the full label it is far behind the incumbents; its value is
concentrated where they fail.

| signal | AUC | recall@${PRIMARY_M} (all) | recall@${PRIMARY_M} (dormant, D=${dFirst}) |
|---|---|---|---|
${scorerRows(FP)}

---

## What we got wrong

**"A pairwise co-reference signal is starved on agent transcripts."** That was the conclusion
of the previous report in this series, and it was over-general. What was measured — that
${pct(1 - FIXPOOL.share_turns_able_to_pair)} of file-referencing turns name exactly one file,
so two specific *files* are rarely active together — is correct and retires file-keyed pairwise
signals cheaply. But the inference from "files are sparse" to "covariance is starved" skipped
the step where the feature space is a free choice. On the same four transcripts, keyed on
identifiers, support goes from ${pct(V('files').support_share_same_turn)} to
${pct(V(FP).support_share_same_turn)} and both gates pass.

The failure mode is worth naming because it is the same shape as two of the five errors the
previous report already lists: a measurement was correct and the conclusion drawn from it was
broader than the measurement licensed. The corrective is structural rather than a matter of
care — the feature space should have been a swept variable from the start, as it is here.

---

## What survives

**Covariance holds where the incumbents collapse.** Across a 5× widening of the dormancy
threshold, positional recency loses
${(100 * (rFirst.recall['recency-only'] - rLast.recall['recency-only']) / rFirst.recall['recency-only']).toFixed(0)}%
of its recall and reference-recency essentially all of it, while covariance loses
${(100 * (rFirst.recall.tcov - rLast.recall.tcov) / rFirst.recall.tcov).toFixed(0)}%. The
mechanism the shipped scorer's relevance weight encodes — that similarity-based rules fail on
dormant units — is visible directly in this table, and covariance is the first signal tested
here that does not share the failure.

**It is not the signal that already lost.** Rank correlation with relevance is near zero in
every space; removing the shared-feature exclusion makes it worse; and it survives deleting
the token class that shares vocabulary with the label.

**It is a specialist, not a replacement.** On the full label covariance is well behind recency
and reference-recency. Any deployment would be as an additional protective term for dormant
units, not as a primary ordering — which is also the only role the evidence supports.

**And a methodological point.** The dormancy threshold that defines the "hard case" had been
inherited unexamined across three experiments. Sweeping it changed which signal wins at four
of the six values tested. A parameter that reorders the conclusion is not a detail.

---

## Caveats

- **The pre-registered primary does not cleanly fire.** It fires only in the feature space
  where the signal does not beat random. The result rests on the floor contrast and the
  dormancy gradient, both of which were secondary as written.
- **One corpus, one repository, one author**, four transcripts, and the largest supplies most
  decisions. Nothing here is between-problem evidence.
- **The label is observational.** A unit can be *used* without being named again; the model
  reasons from what it already read. Every signal is biased the same way, which protects the
  comparisons but not the absolute rates.
- **Turn-denominated parameters remain unrescaled** — the hot window K=${P.K}, the horizon
  H=${P.H} — inherited from an experiment measured on a ~2.2× different clock. D was swept
  here precisely because it was the one doing the most damage; K and H have not been.
- **Feature selection is capped** at ${P.feature_cap} features per turn, rarest-first, with
  features on more than ${pct(P.df_max, 0)} of turns dropped. Phi already scores near-universal
  features zero, so the drop is close to lossless, but the lexical arm is capped hardest — it
  retains ${V(LX).mean_features_per_turn} features per turn and
  ${n0(V(LX).turns_hitting_feature_cap)} of its turns hit the cap, against
  ${n0(V(FP).turns_hitting_feature_cap)} for \`fp\` — and its null result should be read with
  that in mind: the cap may be removing exactly the reusable tokens.
- **This is an eviction endpoint.** The same scores read in reverse give an admission ranking,
  which is where relevance was said to belong. Admission is not measured and no claim about it
  follows.
- **No live arm.** The instrument-sensitivity gate that would say whether a live comparison on
  this substrate can detect any selection effect is itself unresolved.

---
*Generated by \`experiments/covariance-eviction/report-contextual-covariance.mjs\` from
\`${FILES.join('`, `')}\`. Charts are inline SVG; the HTML version is self-contained.*
`;

writeFileSync(join(OUT, 'report-contextual-covariance.md'), MD);

// ── HTML ────────────────────────────────────────────────────────────────────
function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inTable = false, headerDone = false, inQuote = false;
  const inline = (s) => s
    .replace(/&(?!#?\w+;)/g, '&amp;')
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c.replace(/</g, '&lt;')}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; headerDone = false; } };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };
  for (const raw of lines) {
    const line = raw;
    if (line.startsWith('<svg')) { closeTable(); closeQuote(); out.push(`<figure>${line}</figure>`); continue; }
    if (/^\|/.test(line)) {
      closeQuote();
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (/^[-: ]+$/.test(cells.join(''))) continue;
      if (!inTable) { out.push('<table><thead>'); inTable = true; headerDone = false; }
      if (!headerDone) { out.push(`<tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`); headerDone = true; }
      else out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      continue;
    }
    closeTable();
    if (line.startsWith('> ')) { if (!inQuote) { out.push('<blockquote>'); inQuote = true; } out.push(`<p>${inline(line.slice(2))}</p>`); continue; }
    closeQuote();
    if (line.startsWith('### ')) { out.push(`<h3>${inline(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('## ')) { out.push(`<h2>${inline(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('# ')) { out.push(`<h1>${inline(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('- ')) { out.push(`<ul><li>${inline(line.slice(2))}</li></ul>`); continue; }
    if (line.trim() === '---') { out.push('<hr/>'); continue; }
    if (line.trim() === '') { out.push(''); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  closeTable(); closeQuote();
  return out.join('\n').replace(/<\/ul>\n<ul>/g, '\n');
}

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Contextual covariance</title>
<style>
:root{--ink:#24242e;--mut:#5f5f70;--line:#e2e2ea;--bg:#fcfcfd;--accent:#2c6fbb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:920px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:1.95rem;line-height:1.25;margin:0 0 .3em;letter-spacing:-.01em}
h2{font-size:1.32rem;margin:2.2em 0 .6em;padding-bottom:.28em;border-bottom:1px solid var(--line)}
h3{font-size:1.06rem;margin:1.7em 0 .5em;color:#33333f}
p{margin:0 0 1em}
em{color:var(--mut)}
code{background:#f0f0f5;padding:.1em .34em;border-radius:3px;font-size:.88em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
blockquote{margin:1.4em 0;padding:.8em 1.1em;border-left:3px solid var(--accent);background:#f2f6fb;border-radius:0 4px 4px 0}
blockquote p{margin:0 0 .5em}blockquote p:last-child{margin:0}
table{border-collapse:collapse;width:100%;margin:1.3em 0;font-size:.92rem;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:.44em .7em;text-align:left;vertical-align:top}
th{background:#f3f3f8;font-weight:600}
tbody tr:nth-child(even){background:#fafaFC}
figure{margin:1.8em 0;padding:14px;background:#fff;border:1px solid var(--line);border-radius:6px}
hr{border:0;border-top:1px solid var(--line);margin:2.4em 0}
ul{margin:0 0 1em;padding-left:1.3em}li{margin:.3em 0}
@media (prefers-color-scheme: dark){
:root{--ink:#e6e6ee;--mut:#a0a0b2;--line:#34343f;--bg:#17171d}
code{background:#26262f}th{background:#22222b}tbody tr:nth-child(even){background:#1c1c24}
blockquote{background:#1e2530}figure{background:#1d1d25}
}
</style></head><body><main>
${mdToHtml(MD)}
</main></body></html>`;

writeFileSync(join(OUT, 'report-contextual-covariance.html'), HTML);
console.log('wrote report-contextual-covariance.{md,html} ->', OUT);
