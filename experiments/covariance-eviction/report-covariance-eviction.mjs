/**
 * REPORT — two covariance hypotheses for context eviction: one answered, one not testable.
 *
 * Regenerates from the results JSON every time, so no number in the prose can drift from
 * the data. Emits report-covariance-eviction.{md,html}; the HTML is self-contained
 * (inline SVG, no CDN, no external refs).
 *
 * EVERY lookup goes through `must()`, which THROWS when a row is missing. An earlier
 * report in this project interpolated the string "undefined" into a results table; a
 * generator that cannot find its data should fail loudly rather than publish a sentence
 * that reads as a finding.
 *
 * Rerun: node experiments/covariance-eviction/report-covariance-eviction.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'reports', 'metrics', 'covariance-eviction');
const load = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'));

// PINNED, not globbed: a glob would silently fold a re-tagged sweep into the prose.
const FILES = ['results-offline-v1.json', 'results-replicate-assembler-weighting.json',
  'results-h2-corpus-survey.json'];
{
  const present = new Set(readdirSync(OUT));
  const missing = FILES.filter((f) => !present.has(f));
  if (missing.length) throw new Error(`missing result files: ${missing.join(', ')}`);
}
const offline = load(FILES[0]);
const replic = load(FILES[1]);
const survey = load(FILES[2]);

/** Lookup that throws instead of yielding `undefined` into a sentence. */
function must(value, what) {
  if (value === undefined || value === null) throw new Error(`report: missing ${what}`);
  return value;
}
function find(arr, pred, what) {
  const r = must(arr, `${what} (array)`).find(pred);
  if (!r) throw new Error(`report: no row for ${what}`);
  return r;
}

// The H2 payload is deliberately renamed when its gate fires, so a reader cannot quote
// it as a finding. The report has to look under both names and SAY which it found.
const H2KEY = offline.h2 ? 'h2' : 'h2_UNINTERPRETABLE_INSUFFICIENT_SUPPORT';
const h2 = must(offline[H2KEY], 'h2 payload');
const H2_INTERPRETABLE = h2.interpretable === true;

const pct = (x, d = 1) => `${(100 * must(x, 'pct value')).toFixed(d)}%`;
const n0 = (x) => Math.round(must(x, 'number')).toLocaleString('en-US');
const sgn = (x) => (x > 0 ? `+${x.toFixed(4)}` : x.toFixed(4));
const ci = (a) => `[${must(a, 'ci')[0] > 0 ? '+' : ''}${a[0].toFixed(4)}, ${a[1] > 0 ? '+' : ''}${a[1].toFixed(4)}]`;

// ── extracted facts ─────────────────────────────────────────────────────────
const V = must(offline.validity, 'validity');
const CORPUS = must(offline.manifest.corpus, 'manifest.corpus');
const SAT = must(offline.h1.saturation, 'h1.saturation');
const SAT_FP = must(SAT.recurrence_on_identifier_fingerprints_AS_SHIPPED, 'saturation fp row');
const SAT_TRUE = must(SAT.shipped_priority_after_decay_and_normalization, 'saturation shipped-true row');
const SAT_PATH = must(SAT.recurrence_on_file_paths_full_pool, 'saturation file-path row');
const CEIL = must(survey.support_ceiling, 'support_ceiling');
const CEIL_BEST = CEIL.reduce((a, b) => (b.supported_share > a.supported_share ? b : a), CEIL[0]);
const FIXPOOL = must(survey.corpus_density.fixtures_pooled, 'fixtures_pooled');
const GATE = must(survey.verdict.gate, 'gate');
const S1_GATE = 0.50;                                      // DESIGN-H1 §5
const CLOCK = must(replic.clock_effect, 'clock_effect');
const tableRow = (s) => find(must(h2.table, 'h2.table'), (r) => r.scorer === s, `scorer ${s}`);
const SHIPPED_TRUE = tableRow('shipped-priority-true');
const IDLE = tableRow('idle-only');
const RECENCY = tableRow('recency-only');
const SPLIT2 = tableRow('split-priority-rho2');
const TCOV = tableRow('tcov');
const RC = must(h2.rank_correlation, 'rank_correlation');
const SHIP_IDLE_R = must(RC['idle-only vs shipped-priority-true'], 'spearman idle vs shipped-true');
const TCOV_REC_R = must(RC['recency-only vs tcov'], 'spearman recency vs tcov');
const TCOV_IDLE_R = must(RC['idle-only vs tcov'], 'spearman idle vs tcov');
const FILTERED = must(h2.rank_correlation_score_space_FILTERED['recency-only vs tcov'], 'filtered spearman');
const INCR = must(h2.incremental_value, 'incremental_value');
const nmContrast = (b, c) => find(must(h2.contrasts, 'h2.contrasts'),
  (r) => r.metric === 'recall_nonmonotonic' && r.budget === b && r.control === c, `nonmono@${b} vs ${c}`);
const ratioContrast = (label, directed, rho) => find(must(offline.h1.ratio_contrasts, 'ratio_contrasts'),
  (r) => r.label === label && r.directed === directed && r.rho === rho, `rho ${rho} ${label}`);
const ratioSweep = (label, directed, rho) => find(must(offline.h1.ratio_sweep, 'ratio_sweep'),
  (r) => r.label === label && r.directed === directed && r.rho === rho, `sweep rho ${rho}`);
const origRow = (M, t) => find(must(offline.h1.original_corpus_only, 'original_corpus_only'),
  (r) => r.budget === M && r.treatment === t, `original corpus M=${M} ${t}`);
const clockRow = (s, M) => find(CLOCK, (r) => r.session === s && r.M === M, `clock s${s} M=${M}`);
const totalTurns = CORPUS.reduce((a, c) => a + c.turns, 0);
const totalLines = CORPUS.reduce((a, c) => a + c.assistant_lines, 0);
const totalRefs = CORPUS.reduce((a, c) => a + c.refs, 0);
const bashRefs = CORPUS.reduce((a, c) => a + c.bash_refs, 0);
const maxLag = Math.max(...must(h2.contrasts, 'contrasts').map((c) => c.lag1_autocorr ?? 0));
const minLag = Math.min(...must(h2.contrasts, 'contrasts').filter((c) => c.lag1_autocorr).map((c) => c.lag1_autocorr));
const BLOCK = must(nmContrast(32, 'recency-only').block_len, 'block_len');
// Micro vs macro: count the cells where the two averagings disagree on SIGN, per clock.
// An earlier draft asserted "all 16"; on the corrected clock some cells agree, so the
// number is computed. `replic.contrasts` carries both averagings for every (session, clock, M).
const SIGN = must(replic.contrasts, 'replic.contrasts').map((c) => ({
  ...c, disagree: Math.sign(must(c.micro_delta, 'micro')) !== Math.sign(must(c.macro_delta, 'macro')),
}));
const SIGN_TOTAL = SIGN.length;
const SIGN_DISAGREE = SIGN.filter((c) => c.disagree).length;
const SIGN_LINE = SIGN.filter((c) => c.clock === 'line');
const SIGN_LINE_DISAGREE = SIGN_LINE.filter((c) => c.disagree).length;
// Which H2 cells lost their "excludes zero" flag to the resampling correction.
const NM_FLIPPED = [nmContrast(16, 'recency-only'), nmContrast(32, 'idle-only')];
const NM_HELD = nmContrast(16, 'idle-only');

// ── charts (inline SVG, self-contained, XML-parseable) ──────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** CHART 1 — the H2 support ceiling against the gate. */
function chartSupport() {
  const W = 720, H = 300, padL = 64, padR = 24, padT = 44, padB = 52;
  const xs = CEIL.map((c) => c.L);
  const maxL = Math.max(...xs);
  const X = (l) => padL + (Math.log(l) / Math.log(maxL)) * (W - padL - padR);
  const Y = (v) => H - padB - v * (H - padT - padB);
  let s = '';
  for (let g = 0; g <= 1.0001; g += 0.25) {
    s += `<line x1="${padL}" y1="${Y(g).toFixed(1)}" x2="${W - padR}" y2="${Y(g).toFixed(1)}" stroke="#e3e3ea" stroke-width="1"/>`;
    s += `<text x="${padL - 8}" y="${(Y(g) + 4).toFixed(1)}" font-size="11" fill="#6a6a78" text-anchor="end">${(g * 100).toFixed(0)}%</text>`;
  }
  s += `<line x1="${padL}" y1="${Y(GATE).toFixed(1)}" x2="${W - padR}" y2="${Y(GATE).toFixed(1)}" stroke="#c0392b" stroke-width="2" stroke-dasharray="6 4"/>`;
  s += `<text x="${W - padR}" y="${(Y(GATE) - 8).toFixed(1)}" font-size="11" fill="#c0392b" text-anchor="end">support gate ${(GATE * 100).toFixed(0)}% — never reached</text>`;
  const pts = CEIL.map((c) => `${X(c.L).toFixed(1)},${Y(c.supported_share).toFixed(1)}`).join(' ');
  s += `<polyline points="${pts}" fill="none" stroke="#2c6fbb" stroke-width="2.5"/>`;
  for (const c of CEIL) {
    s += `<circle cx="${X(c.L).toFixed(1)}" cy="${Y(c.supported_share).toFixed(1)}" r="4.5" fill="#2c6fbb"/>`;
    s += `<text x="${X(c.L).toFixed(1)}" y="${(Y(c.supported_share) - 11).toFixed(1)}" font-size="10.5" fill="#2c6fbb" text-anchor="middle">${(c.supported_share * 100).toFixed(1)}</text>`;
    s += `<text x="${X(c.L).toFixed(1)}" y="${H - padB + 16}" font-size="11" fill="#6a6a78" text-anchor="middle">${c.L}</text>`;
  }
  s += `<text x="${(padL + (W - padR)) / 2}" y="${H - 10}" font-size="11.5" fill="#4a4a58" text-anchor="middle">episode window L (turns, log scale)</text>`;
  s += `<text x="${padL}" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">Share of candidates whose pair with a hot file has ANY co-activation history</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Support share against dilation window, never reaching the gate" style="max-width:100%;height:auto">${s}</svg>`;
}

/** CHART 2 — the S0 clock-fix contrast, per session and budget, against the +0.03 margin. */
function chartClock() {
  const W = 720, H = 320, padL = 64, padR = 24, padT = 46, padB = 56;
  const rows = CLOCK.filter((r) => r.M >= 16);
  const maxV = Math.max(0.05, ...rows.flatMap((r) => [r.line_micro_ci[1], r.api_micro_ci[1]]));
  const Y = (v) => H - padB - (v / maxV) * (H - padT - padB);
  const groupW = (W - padL - padR) / rows.length;
  let s = '';
  for (let g = 0; g <= maxV + 1e-9; g += 0.05) {
    s += `<line x1="${padL}" y1="${Y(g).toFixed(1)}" x2="${W - padR}" y2="${Y(g).toFixed(1)}" stroke="#e3e3ea" stroke-width="1"/>`;
    s += `<text x="${padL - 8}" y="${(Y(g) + 4).toFixed(1)}" font-size="11" fill="#6a6a78" text-anchor="end">${g.toFixed(2)}</text>`;
  }
  s += `<line x1="${padL}" y1="${Y(0.03).toFixed(1)}" x2="${W - padR}" y2="${Y(0.03).toFixed(1)}" stroke="#c0392b" stroke-width="2" stroke-dasharray="6 4"/>`;
  s += `<text x="${W - padR}" y="${(Y(0.03) - 7).toFixed(1)}" font-size="11" fill="#c0392b" text-anchor="end">+0.03 margin the original pre-registered</text>`;
  rows.forEach((r, i) => {
    const cx = padL + groupW * (i + 0.5);
    const bars = [{ v: r.line_micro, lo: r.line_micro_ci[0], hi: r.line_micro_ci[1], c: '#9aa0b5', dx: -13 },
      { v: r.api_micro, lo: r.api_micro_ci[0], hi: r.api_micro_ci[1], c: '#2c6fbb', dx: 13 }];
    for (const b of bars) {
      const x = cx + b.dx;
      s += `<rect x="${(x - 9).toFixed(1)}" y="${Y(b.v).toFixed(1)}" width="18" height="${Math.max(0, H - padB - Y(b.v)).toFixed(1)}" fill="${b.c}"/>`;
      s += `<line x1="${x.toFixed(1)}" y1="${Y(b.lo).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(b.hi).toFixed(1)}" stroke="#2b2b38" stroke-width="1.4"/>`;
      s += `<line x1="${(x - 4).toFixed(1)}" y1="${Y(b.hi).toFixed(1)}" x2="${(x + 4).toFixed(1)}" y2="${Y(b.hi).toFixed(1)}" stroke="#2b2b38" stroke-width="1.4"/>`;
      s += `<line x1="${(x - 4).toFixed(1)}" y1="${Y(b.lo).toFixed(1)}" x2="${(x + 4).toFixed(1)}" y2="${Y(b.lo).toFixed(1)}" stroke="#2b2b38" stroke-width="1.4"/>`;
    }
    s += `<text x="${cx.toFixed(1)}" y="${H - padB + 17}" font-size="11" fill="#4a4a58" text-anchor="middle">s${r.session} M=${r.M}</text>`;
  });
  s += `<line x1="${padL}" y1="${(H - padB).toFixed(1)}" x2="${W - padR}" y2="${(H - padB).toFixed(1)}" stroke="#9a9aa8" stroke-width="1"/>`;
  s += `<rect x="${padL}" y="${H - 22}" width="12" height="11" fill="#9aa0b5"/><text x="${padL + 17}" y="${H - 12}" font-size="11" fill="#4a4a58">JSONL-line clock (as published)</text>`;
  s += `<rect x="${padL + 216}" y="${H - 22}" width="12" height="11" fill="#2c6fbb"/><text x="${padL + 233}" y="${H - 12}" font-size="11" fill="#4a4a58">API-turn clock (corrected)</text>`;
  s += `<text x="${padL}" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">Recurrence minus recency (micro-averaged recall), before and after the turn-clock fix</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Recurrence advantage under both turn clocks with confidence intervals" style="max-width:100%;height:auto">${s}</svg>`;
}

/** CHART 3 — what the eviction signals actually rank by (AUC with intervals). */
function chartAuc() {
  const W = 720, H = 300, padL = 176, padR = 60, padT = 44, padB = 40;
  const rows = [IDLE, SHIPPED_TRUE, RECENCY, TCOV, SPLIT2, tableRow('recurrence-undirected'), tableRow('recurrence-directed')]
    .map((r) => ({ name: r.scorer, auc: must(r.auc, 'auc'), ci: must(r.auc_ci, 'auc_ci') }))
    .sort((a, b) => b.auc - a.auc);
  const X = (v) => padL + ((v - 0.45) / (0.95 - 0.45)) * (W - padL - padR);
  const bh = (H - padT - padB) / rows.length;
  let s = '';
  for (const g of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    s += `<line x1="${X(g).toFixed(1)}" y1="${padT - 6}" x2="${X(g).toFixed(1)}" y2="${H - padB}" stroke="#e3e3ea" stroke-width="1"/>`;
    s += `<text x="${X(g).toFixed(1)}" y="${H - padB + 15}" font-size="11" fill="#6a6a78" text-anchor="middle">${g.toFixed(1)}</text>`;
  }
  s += `<line x1="${X(0.5).toFixed(1)}" y1="${padT - 6}" x2="${X(0.5).toFixed(1)}" y2="${H - padB}" stroke="#c0392b" stroke-width="1.5" stroke-dasharray="5 3"/>`;
  rows.forEach((r, i) => {
    const y = padT + bh * i + bh / 2;
    const col = r.name === 'shipped-priority-true' ? '#e08a1e' : r.name === 'tcov' ? '#2c6fbb' : '#7a8196';
    s += `<rect x="${X(0.5).toFixed(1)}" y="${(y - 8).toFixed(1)}" width="${Math.max(0, X(r.auc) - X(0.5)).toFixed(1)}" height="16" fill="${col}"/>`;
    s += `<line x1="${X(r.ci[0]).toFixed(1)}" y1="${y.toFixed(1)}" x2="${X(r.ci[1]).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2b2b38" stroke-width="1.4"/>`;
    s += `<text x="${padL - 10}" y="${(y + 4).toFixed(1)}" font-size="11.5" fill="#3a3a48" text-anchor="end">${esc(r.name)}</text>`;
    s += `<text x="${(X(r.ci[1]) + 7).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="11" fill="#4a4a58">${r.auc.toFixed(3)}</text>`;
  });
  s += `<text x="${padL}" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">How well each signal orders one turn's buffer (AUC; 0.5 = chance, dashed)</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="AUC by eviction signal with confidence intervals" style="max-width:100%;height:auto">${s}</svg>`;
}

// ── prose ───────────────────────────────────────────────────────────────────
const corpusRows = CORPUS.map((c) => `| \`${c.session}\` | ${n0(c.turns)} | ${n0(c.assistant_lines)} | ${(c.assistant_lines / c.turns).toFixed(2)}× | ${n0(c.refs)} | ${n0(c.bash_refs)} | ${n0(c.decision_turns)} |`).join('\n');

const clockRows = CLOCK.filter((r) => r.M >= 16).map((r) =>
  `| ${r.session} | ${r.M} | ${sgn(r.line_micro)} ${ci(r.line_micro_ci)} | ${sgn(r.api_micro)} ${ci(r.api_micro_ci)} | ${r.survives_clock_fix ? '**survives**' : r.line_micro_clears ? 'lost to the fix' : 'never cleared +0.03'} |`).join('\n');

const satRows = [['recurrence over file paths', SAT_PATH], ['recurrence over the shipped fingerprints', SAT_FP],
  ['**the shipped term, after decay and normalization**', SAT_TRUE]]
  .map(([n, r]) => `| ${n} | ${n0(r.sampled_turns)} | ${r.mean_distinct_values_per_turn} | ${r.mean_cv} | ${pct(r.share_turns_fully_flat)} | ${pct(r.share_turns_near_flat)} [${pct(r.share_turns_near_flat_ci95[0])}, ${pct(r.share_turns_near_flat_ci95[1])}] |`).join('\n');

const rhoRows = [0, 0.25, 0.5, 0.75, 1].map((rho) => {
  const sw = ratioSweep('file-reference', false, rho);
  const c = ratioContrast('file-reference', false, rho);
  return `| ${rho} | ${pct(sw.ordering_identity_vs_rho2)} | ${sw.recall_at_32} | ${sgn(c.delta)} ${ci(c.ci95)} | ${c.clears_pre_registered_0p03 ? 'yes' : 'no'} |`;
}).join('\n');

const ceilRows = CEIL.map((c) => `| ${c.L} | ${pct(c.supported_share)} | ${c.clears_gate ? 'clears' : 'below gate'} |`).join('\n');
const recRows = must(CEIL[0].by_candidate_recurrence, 'by_candidate_recurrence')
  .map((b) => `| ${b.prior_refs_of_candidate_file} | ${n0(b.rows)} (${pct(b.share_of_all_rows)}) | ${pct(b.supported_share)} |`).join('\n');

const incrRows = INCR.map((i) => `| \`${i.held_out_session}\` | ${n0(i.test_turns)} | ${i.auc_base} | ${i.auc_plus_tcov} | ${sgn(i.delta_auc)} ${ci(i.ci95)} |`).join('\n');

const fpt = must(FIXPOOL.files_per_turn_histogram, 'files_per_turn_histogram');

const MD = `# Two covariance hypotheses for context eviction: one answered, one not testable

*A result, a non-result, and five corrections to an earlier version of this analysis.*

> This report supersedes the first version of \`experiments/covariance-eviction/\`, whose
> headline claims were overturned by adversarial review. The five withdrawn claims are
> listed in **What we got wrong**, not removed.

---

## Abstract

An AI coding agent re-sends its entire working transcript to the model on every step, so on
a long task the transcript outgrows the model's input limit and material must be deleted.
Which material to delete is the central design question for context-management middleware.
The system under study scores each candidate for deletion on four signals, of which the
heaviest is *priority* — a term combining "this unit edited a file" with "this unit's
identifiers recur elsewhere in the buffer". The recurrence half won an earlier offline
sweep and is the reason the term carries the largest weight.

We asked two questions. First, whether the recurrence term that ships is the term that was
tested: the shipped code forms its two halves into a sum *before* any weight is applied, so
no coefficient can move one half relative to the other, and its internal 2:1 ratio is a
constant no experiment had varied. Second, whether a signal that has never been computed
anywhere in the system — the tendency of two units to be *referenced together across
turns* — predicts which dormant material will be needed again. The second question matters
because relevance-to-recent was previously measured as the *worst* available eviction
signal, for the specific reason that it discards the dormant unit that later returns;
temporal covariance is the signal that would keep exactly that unit.

On the first question the answer is largely reassuring and partly surprising. Re-running
the original experiment on its own corpus with its own metric, changing only the definition
of a "turn" — the earlier analysis counted one turn per line of transcript file, inflating
the clock ${(totalLines / totalTurns).toFixed(2)}× — the recurrence advantage replicates
and survives, at ${sgn(clockRow('1', 64).line_micro)} → ${sgn(clockRow('1', 64).api_micro)}
on one session and ${sgn(clockRow('2', 64).line_micro)} → ${sgn(clockRow('2', 64).api_micro)}
on the other. Sweeping the ratio the shipped code cannot express, no value beats the shipped
one: the hardcoded constant is vindicated as a default. But measuring what the shipped term
actually ranks by, rather than the simplification an earlier version of this analysis
measured, produced an unplanned finding: the shipped priority term correlates
${SHIP_IDLE_R.toFixed(3)} with reference-recency, above the threshold this project uses to
call one signal a relabelling of another. The four-signal scorer may be counting
reference-recency twice under two names.

On the second question we could not obtain an answer, and the reason is structural rather
than a shortage of data. A pairwise statistic needs two units to have been active together;
in these transcripts ${pct(FIXPOOL.share_turns_able_to_pair)} of turns that reference a file
reference two or more, so co-activation is rare by construction. Across every corpus
available — the committed transcripts and every session on the machine — and across episode
windows from ${CEIL[0].L} to ${CEIL[CEIL.length - 1].L} turns, the share of candidates with
any co-activation history peaks at ${pct(CEIL_BEST.supported_share)} against a
pre-registered requirement of ${pct(GATE)}, and the median candidate pair has never been
co-active at any setting. The hypothesis is therefore recorded as untested, not as refuted.
That distinction is the point: the earlier version of this analysis reported contrasts from
this corpus as though they were evidence, and one of them did not survive a correction to
the resampling scheme.

---

## What you need to know to read the rest

Nothing beyond this table is assumed.

| Term | Meaning |
|---|---|
| **Agent** | An AI model given tools (read a file, write a file, run a command) and a goal, running in a loop until it decides it is done. |
| **Transcript / context** | Everything the model sees on a given step: the instructions plus the full history of what it has read, written and run. It is re-sent in full every step. |
| **Token** | The unit context is measured in — roughly ¾ of a word. |
| **Eviction** | Deleting older material from the transcript to get back under the input limit. The subject of this report is *what* to delete. |
| **Unit** | The thing eviction deletes: one turn of the transcript, kept whole so a tool call is never separated from its result. |
| **Decision** | One moment at which the policy must rank the units currently held. Each decision is scored against what the agent did next. |
| **Fingerprint** | A distinctive token extracted from a unit's text — a file path, a CamelCase name, a back-quoted symbol — used as a cheap proxy for "what this unit is about". |
| **Recurrence** | How many *other* units share at least one fingerprint with this one. The signal whose weight is under test. |
| **Reference-recency ("idle")** | How many turns since this unit's files were last touched. Low idle = touched recently. |
| **Temporal covariance** | The proposed new signal: how strongly this unit's files have *historically been active in the same episodes* as the files the agent is working on right now. |
| **Phi coefficient** | The correlation between two yes/no series — here, "was file A active this turn" against "was file B active this turn". Chosen over a plain co-occurrence count because a file touched on *every* turn scores zero against everything, instead of appearing to co-occur with all of them. |
| **Support** | How many turns two specific files were actually active together. Support of zero means the correlation above is computed from an empty table, i.e. it is noise. |
| **Recall@M** | Of the units the agent turned out to need, the share a policy would have kept if it could keep only M of them. Higher is better. |
| **AUC** | The chance that a needed unit is ranked above an unneeded one, within a single decision. 0.5 is a coin flip, 1.0 is perfect. |
| **The non-monotonic subset** | The hard case: units that had gone quiet for a long time and were then needed again. The case relevance-to-recent fails, and the case temporal covariance was proposed to fix. |
| **Micro- vs macro-averaging** | Two ways to average recall over decisions. *Micro* pools every needed unit, so a busy decision counts for more. *Macro* averages the per-decision rates, so every decision counts once. They disagree here — sometimes on sign — so every number states which it is. |
| **Moving-block bootstrap** | A way of putting error bars on a number when consecutive measurements are related. Chunks of consecutive decisions are resampled rather than individual ones; resampling individually would make the error bars too narrow. |
| **Holm correction** | An adjustment applied when several comparisons are made at once, so that testing five things does not manufacture one apparent success. |

---

## Why we ran this

The eviction scorer weights four signals. Three are cheap positional facts; the fourth,
*priority*, is the one with a research result behind it, and it is weighted highest because
of that result. Two things about it had never been checked.

**The shipped term is not obviously the tested term.** The code computes
\`((wrote ? 2 : 0) + coOccurrence) * decay\` and only then normalizes and weights the
result. Because the sum is formed first, every coefficient in the system scales both halves
together: the 2:1 ratio between "this unit edited something" and "this unit's identifiers
recur" is unreachable, and no experiment had varied it. The project's own rule forbids
undefended constants; this was one that could not even be reached.

**Nothing computes whether two units go together.** Every signal in the system is a
per-unit scalar. None is pairwise. That gap matters because of a specific earlier finding:
relevance-to-recent — keeping what resembles what the agent is doing now — was measured as
the *worst* eviction signal available, and the mechanism was understood. A unit that has
gone dormant does not resemble the recent window, by definition, so a relevance rule deletes
exactly the unit that is about to be needed again. Temporal covariance is the principled
repair: it keeps a dormant unit precisely when that unit has historically been worked on
*alongside* whatever is hot now. Same target case, opposite sign.

---

## The experimental setup

### The corpus

Four real Claude Code transcripts committed to the repository, from one developer working
on this project. They are not synthetic and not scripted; they are a record of ordinary
work.

| transcript | turns | transcript lines | clock inflation | file references | of which from shell commands | decisions scored |
|---|---|---|---|---|---|---|
${corpusRows}

Pooled: **${n0(totalTurns)} turns**, ${n0(totalRefs)} file references
(${n0(bashRefs)} of them named on shell command lines), **${n0(V.decision_turns)} decisions**
and **${n0(V.candidate_rows)} (decision × candidate) rows**.

### What a unit, a decision and the label are

A **unit** is one API turn. At each **decision** — every turn after a burn-in, where the
buffer holds at least eight candidates — the policy ranks the units it is holding, capped at
the most recent 200. The **label** is behavioural: a unit counts as *needed* if the agent
issued a tool call naming one of that unit's files within the next three turns. On this
corpus ${pct(V.label_base_rate, 1)} of rows are needed, and
${n0(V.nonmonotonic_rows)} rows fall in the non-monotonic subset.

The cap has to actually bind for a "keep only M" comparison to mean anything; it does, on
${pct(must(offline.binding_share['M=16'], 'binding 16').binding_share)},
${pct(must(offline.binding_share['M=32'], 'binding 32').binding_share)} and
${pct(must(offline.binding_share['M=64'], 'binding 64').binding_share)} of decisions at
M = 16, 32 and 64.

### The turn clock

A Claude transcript file stores one line per *content block*, not one per model turn: a
single turn that thinks, calls two tools and gets two results occupies five lines. The
earlier analysis counted lines. Across these four transcripts that inflates the clock by
**${(totalLines / totalTurns).toFixed(2)}× on average** (${CORPUS.map((c) => (c.assistant_lines / c.turns).toFixed(2)).join('×, ')}×
per transcript), and every setting measured in turns — how far back "recent" reaches, how
long "dormant" is — rides on it. This analysis advances the clock on a change of message
identifier instead.

### How the error bars are computed

Consecutive decisions share candidates, a working context and an overlapping label window.
Measured here, the correlation between one decision's score and the next is
**+${minLag.toFixed(2)} to +${maxLag.toFixed(2)}**. Error bars are therefore a moving-block
bootstrap over blocks of ${BLOCK} consecutive decisions, resampled within a transcript and
never across two. Resampling decisions independently — which an earlier version of this
analysis did, while calling it a block bootstrap — makes every interval about a third too
narrow.

---

## Results

### Question 1: is the shipped recurrence term the tested one?

#### The original result replicates, and survives the clock correction

Re-running the published experiment on its own two transcripts, with its own signals, its
own fingerprints, its own micro-averaged metric and its own budget, changing **only** the
definition of a turn. The line-clock column reproduces the published numbers to two decimal
places, which is the check that the re-implementation is faithful.

| transcript | M | JSONL-line clock (as published) | API-turn clock (corrected) | verdict |
|---|---|---|---|---|
${clockRows}

${chartClock()}

The advantage is real, is concentrated at the larger budgets the original quoted, and is not
an artefact of the inflated clock. It *shrinks* on the second transcript — roughly halving —
which is worth carrying as a caveat rather than treating as a refutation.

#### The term is not saturated, and its real form is not what an earlier analysis measured

A term that takes the same value for every candidate cannot be tuned, only removed. So: how
much does it vary?

| term measured | decisions sampled | distinct values per decision | coefficient of variation | never varies | ≤ 2 distinct values |
|---|---|---|---|---|---|
${satRows}

The pre-registered threshold was "≤ 2 distinct values on more than ${pct(S1_GATE, 0)} of
decisions". The measurement is ${pct(SAT_FP.share_turns_near_flat)}, so **the threshold is
not met** — the term is not saturated.

The last row is the one that settles the mechanism. The shipped scorer ranks by the
*product* \`(edit boost + recurrence) × decay\`, normalized afterwards — and that quantity
takes **${SAT_TRUE.mean_distinct_values_per_turn} distinct values per decision** and is never
flat. Even on the ${pct(SAT_FP.share_turns_fully_flat)} of decisions where recurrence itself
is constant, the term does not switch off: it becomes *constant × decay*, which for units
that edited nothing is a live ranking signal that would be **absent** if recurrence were
zero.

#### No ratio beats the shipped one

Sweeping the edit-to-recurrence ratio the shipped code cannot express. The second column is
the share of decisions on which a given ratio produces *literally the same ordering* as the
shipped one — because the edit indicator is binary, any ratio above 1 is mathematically
identical to the shipped setting and is not an independent arm at all.

| ratio ρ | identical ordering to shipped | recall@32 | paired difference vs shipped | clears +0.03? |
|---|---|---|---|---|
${rhoRows}

No ratio clears the margin anywhere, and under the identifier-overlap label every ratio
below 1 is *worse*. **The hardcoded 2:1 constant is vindicated as a default.** It remains
underived, but it is no longer unmeasured.

### Question 2: does temporal covariance predict dormant returns?

#### The corpus cannot answer, and we can say exactly why

The statistic needs two files to have been active together. They rarely are:

| files referenced in one turn | 1 | 2 | 3–4 | 5+ |
|---|---|---|---|---|
| turns | ${n0(fpt['1'])} | ${n0(fpt['2'])} | ${n0(fpt['3-4'])} | ${n0(fpt['5+'])} |

Only **${pct(FIXPOOL.share_turns_able_to_pair)}** of file-referencing turns name two or more
files, so most turns cannot produce a co-activation pair at all. Widening the episode window
raises the number mechanically; it never reaches the bar.

| episode window L (turns) | candidates with any co-activation history | verdict |
|---|---|---|
${ceilRows}

${chartSupport()}

Restricting to the units for which covariance is even plausibly defined does not rescue it
either — even candidates whose file has already been referenced ten or more times reach only
${pct(find(CEIL[0].by_candidate_recurrence, (b) => b.prior_refs_of_candidate_file === '10+', 'bucket 10+').supported_share)}
support at L=${CEIL[0].L}:

| prior references to the candidate's file | rows | with co-activation history |
|---|---|---|
${recRows}

Across every other corpus on the machine — ${survey.corpus_density.local_projects.length} further
projects' Claude Code sessions, surveyed in aggregate only — none is materially denser:
references per distinct file run
${survey.corpus_density.local_projects.map((p) => p.refs_per_file).join(', ')} against
${FIXPOOL.refs_per_file} for the committed transcripts. ${must(survey.verdict.conclusion, 'verdict')}

#### What that means for the numbers we did compute

${H2_INTERPRETABLE ? 'The gate is cleared and the contrasts below stand.' : `Because the gate is not met, the contrasts below are **not a null result about temporal covariance**. They are mostly a correlation computed from an empty table. The results file records this on the payload itself — the key is \`${H2KEY}\` and every row carries \`interpretable: false\` — so a later reader cannot quote them as a finding.`}

They are reported for one reason only: to show what the corrected error bars do to the one
cell an earlier version of this analysis presented as supportive. At the pre-specified
primary budget the signal is behind; the favourable cell was at a different budget and no
longer excludes zero.

| contrast (non-monotonic recall) | difference | interval |
|---|---|---|
| vs reference-recency, M=16 | ${sgn(nmContrast(16, 'idle-only').delta)} | ${ci(nmContrast(16, 'idle-only').ci95)} |
| vs positional recency, M=16 | ${sgn(nmContrast(16, 'recency-only').delta)} | ${ci(nmContrast(16, 'recency-only').ci95)} |
| **vs positional recency, M=32 (pre-specified primary)** | ${sgn(nmContrast(32, 'recency-only').delta)} | ${ci(nmContrast(32, 'recency-only').ci95)} |
| vs positional recency, M=64 | ${sgn(nmContrast(64, 'recency-only').delta)} | ${ci(nmContrast(64, 'recency-only').ci95)} |

The decisive endpoint — whether the signal adds anything on top of the four the system
already has, trained on one transcript and tested on the others — is flat:

| held out | decisions tested | AUC without | AUC with | difference |
|---|---|---|---|---|
${incrRows}

#### It is, at least, a different signal

Whatever else is true, temporal covariance is not a rename of something already present. The
correlation between the ordering it produces and the ordering positional recency produces is
**${TCOV_REC_R.toFixed(3)}**, and against reference-recency **${TCOV_IDLE_R.toFixed(3)}** —
far from the 0.8 this project treats as a relabelling, and negative, meaning it orders the
buffer close to opposite to recency.

---

## What we got wrong

Five claims in the first version of this analysis were false or unsupported. They are listed
because the pattern in them is the useful artefact: four of the five read in the direction
that made the work look more conclusive.

**1. "The saturation gate fires."** The pre-registered threshold was "≤ 2 distinct values on
more than ${pct(S1_GATE, 0)} of decisions". The measurement was
${pct(SAT_FP.share_turns_near_flat)}. The first version nonetheless opened its results with
"S1 fires", made it the headline, and escalated it into a recommendation about the shipped
weight. **A null was read as a win on the one finding it said was worth acting on.**

**2. "A flat recurrence term is deleted by normalization."** False. Normalization is applied
to the product of the sum and the decay factor, not to the recurrence term. With recurrence
constant the term does not vanish — it becomes *constant × decay*, a live ranking signal. The
corrected measurement is in the results above, and a unit test now fails if the decay factor
is dropped.

**3. "The original result does not replicate."** Withdrawn. That claim came from a
re-measurement that differed from the original in six ways at once — the definition of a
unit, the size of the candidate pool, the fingerprint patterns, the text fed to them, the
transcripts used, and the budget quoted — and was read at the budget where the effect is
smallest, on a corpus mostly composed of a transcript the original never used. Holding all
six fixed and varying only the clock, **it replicates and survives**.

**4. "The ratio dial saturates above 1."** It does not saturate; it is an algebraic
identity. The edit indicator is binary after normalization, so any ratio above 1 orders the
buffer identically — four of the original eight sweep points were provably the same arm. The
first version presented their identical scores as an empirical finding about diminishing
returns.

**5. "Turn-level block bootstrap."** The function drew decisions independently, with no
block, while three source files and both design documents named it a block bootstrap.
Correcting it widened every interval by roughly a third and overturned two of the three
non-monotonic cells that had excluded zero — covariance against positional recency at M=16
became ${ci(NM_FLIPPED[0].ci95)} and against reference-recency at M=32 became
${ci(NM_FLIPPED[1].ci95)}, where the uncorrected version reported both as excluding zero.
Only ${ci(NM_HELD.ci95)}, at M=16 against reference-recency, survived. The favourable cell
the first version led with is among those that did not.

Two further corrections carried no headline: the scorer labelled "shipped-priority" was a
simplified form the shipped code cannot express and has been renamed, with the real one
added alongside; and a fingerprint story was attributed to the shipped extractor, which does
not in fact match the token class it was blamed for.

---

## Conclusions

### What survives

**The recurrence result is sound and the clock fix does not break it.** It replicates on its
own corpus under its own estimand, survives the corrected clock, and is concentrated at the
budgets the original quoted.

**The hardcoded 2:1 ratio is vindicated as a default.** No setting in the informative range
beats it, and the range above it is mathematically identical to it. The constant is still
underived, but it is no longer unmeasured, and this particular objection to it is closed.

**A new finding that nobody was looking for: the scorer may be counting reference-recency
twice.** Measuring the shipped priority term as the code actually computes it — rather than
the simplification the first version of this analysis used — it is a *strong* signal, AUC
${SHIPPED_TRUE.auc.toFixed(3)} ${ci(SHIPPED_TRUE.auc_ci)}, second only to reference-recency
at ${IDLE.auc.toFixed(3)}. But its ordering correlates **${SHIP_IDLE_R.toFixed(3)}** with
reference-recency, above the 0.8 this project uses to call one signal a relabelling of
another. The decay factor dominates the sum it multiplies, so much of what "priority"
contributes may be reference-recency arriving under a second name — in a four-signal scorer
that also carries reference-recency explicitly. That is a cheap, purely offline experiment
and it is the most valuable thing this work turned up.

${chartAuc()}

**A methodological finding worth more than either hypothesis.** Micro- and macro-averaging
of recall disagree on the *sign* of the recurrence contrast at
**${n0(SIGN_DISAGREE)} of the ${n0(SIGN_TOTAL)} cells** measured — including
**${n0(SIGN_LINE_DISAGREE)} of ${n0(SIGN_LINE.length)}** under the clock the published
result used, i.e. every one of them. Weighting each decision equally makes recurrence lose
to recency; weighting each needed unit equally makes it win, because the decisions with many
needed units are exactly where recurrence does well. Neither is wrong; only one is the
estimand the published result refers to. No report in this project had previously stated
which it used.

**And a structural one.** A pairwise co-reference signal may be undeployable on agent
transcripts in general, not merely on this corpus: agents name files one at a time, so two
specific files are rarely active together, and no volume of additional transcripts changes
that. Any future pairwise signal should be checked against this property before it is built.

### What this licenses, and what it does not

**Established.** The recurrence advantage replicates on its original two transcripts under
their original estimand and survives the corrected turn clock at M=64
(${sgn(clockRow('1', 64).api_micro)} and ${sgn(clockRow('2', 64).api_micro)}). No
edit-to-recurrence ratio in the informative range beats the shipped 2:1. The shipped
priority term is not saturated (${pct(SAT_FP.share_turns_near_flat)} of decisions near-flat
against a ${pct(S1_GATE, 0)} gate).

**Licensed for the design.** Keep the shipped priority term and its 2:1 constant as they are;
this work gives no reason to re-weight or re-split them. Treat the
${SHIP_IDLE_R.toFixed(3)} rank correlation between priority and reference-recency as an open
redundancy question to be settled offline before any weight in the four-signal scorer is
tuned. Require every future recall figure to state whether it is micro- or macro-averaged.

**Not licensed.** Nothing here licenses adding temporal covariance to the scorer, and nothing
here licenses removing it from consideration. The two must be kept apart:

| claim | status |
|---|---|
| the shipped recurrence term helps, at the budgets the original quoted | **tested, supported** |
| some other edit-to-recurrence ratio is better than 2:1 | **tested and rejected** (no ratio clears +0.03) |
| the shipped priority term is saturated | **tested and rejected** (gate not met) |
| priority is reference-recency counted twice | **untested** — a rank correlation raises it; no ablation has been run |
| file-keyed temporal covariance predicts dormant returns | **untested** — support peaks at ${pct(CEIL_BEST.supported_share)} against a ${pct(GATE)} gate, so the contrasts are uninterpretable, not null |
| covariance keyed on anything other than file paths | **not measured in this report** |

The recurrence result is also offline and single-corpus: it licenses a default, not a claim
that the term improves task success for a live agent.

---

## Caveats

- **One corpus, one developer, one repository.** Four transcripts, and the largest of them
  supplies ${pct(find(CORPUS, (c) => c.session === 'session-5', 'session-5').decision_turns / V.decision_turns)}
  of all decisions — which is why every headline is also reported per transcript.
- **Micro- and macro-averaging disagree on sign** at ${n0(SIGN_DISAGREE)} of
  ${n0(SIGN_TOTAL)} cells, and at every cell under the published clock. Numbers in this
  report state which averaging they use; numbers in other reports in this project mostly do
  not.
- **The turn-denominated settings are owed a rescale.** They are numerically the original
  experiment's, but that experiment's "turn" is ${(totalLines / totalTurns).toFixed(2)}×
  shorter, so copying the numerals across halves every window rather than preserving intent.
  The contrast is known to be sensitive to this, and the sweep has not been run.
- **Question 2's verdict is corpus-dependent in one direction only.** A denser corpus could
  make temporal covariance testable; no corpus can make the present numbers into evidence.
- **The label is observational.** A unit can be *used* without being named again — the model
  reasons from what it already read. Every signal is biased the same way, which protects the
  comparisons but not the absolute rates.
- **Shell-command file extraction is a regex** over a command string, and shell commands
  supply ${pct(bashRefs / totalRefs)} of all references here. It is the least trustworthy
  input in the pipeline, and excluding it is not neutral either.
- **No live arm was run.** The harness exists and is gated shut: the instrument-sensitivity
  check that would say whether a live comparison on this substrate can detect *any*
  selection effect is itself unresolved, and five previous live comparisons returned null or
  void.

---
*Generated by \`experiments/covariance-eviction/report-covariance-eviction.mjs\` from
\`${FILES.join('`, `')}\`. Charts are inline SVG; the HTML version is self-contained.*
`;

writeFileSync(join(OUT, 'report-covariance-eviction.md'), MD);

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
    if (line.startsWith('#### ')) { out.push(`<h4>${inline(line.slice(5))}</h4>`); continue; }
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
<title>Two covariance hypotheses for context eviction</title>
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

writeFileSync(join(OUT, 'report-covariance-eviction.html'), HTML);
console.log('wrote report-covariance-eviction.{md,html} ->', OUT);
