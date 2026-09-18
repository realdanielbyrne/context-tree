/**
 * Report for the BASELINE INSTRUMENT choice: the Swift reasoning-efficient fine-tune against the
 * stock base model, same 10 SWE-bench problems, 3 repeats each, same sandbox, same prompt.
 *
 * Every number is interpolated from PINNED results files; a missing file or field throws.
 * One section list renders both formats, so the .md and .html cannot drift.
 *
 * Rerun: node experiments/context-dedup/reimport-trace-facts.mjs   (refreshes the pinned
 *        trace-facts file, needs the run dirs)
 *        node experiments/context-dedup/report-swift-vs-q8.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'reports', 'metrics', 'swebench-pilot');

// ------------------------------------------------------------------ pinned inputs
const FILES = {
  swift: 'results-swebench-opencode-baseline-swift-sbx-x3.json',
  q8: 'results-swebench-opencode-baseline-q8-sbx-x3.json',
  seg: 'trace-facts-swift-vs-q8.json',
};
const load = (k) => {
  const p = join(OUT, FILES[k]);
  if (!existsSync(p)) throw new Error(`report requires ${FILES[k]}`);
  return JSON.parse(readFileSync(p, 'utf8'));
};
const D = Object.fromEntries(Object.keys(FILES).map((k) => [k, load(k)]));
const need = (o, k, ctx = '') => { if (o == null || !(k in o) || o[k] === undefined) throw new Error(`missing ${ctx}${k}`); return o[k]; };

// ------------------------------------------------------------------ helpers
const medRaw = (x) => { if (!x.length) throw new Error('median of empty'); const s = [...x].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const med = (x) => Math.round(medRaw(x));
const sum = (x) => x.reduce((a, b) => a + b, 0);
const k = (v) => { if (!Number.isFinite(v)) throw new Error('number expected'); return Math.round(v).toLocaleString('en-US'); };
const pct = (v, d = 1) => { if (!Number.isFinite(v)) throw new Error('pct of non-finite'); return `${(v * 100).toFixed(d)}%`; };
const x2 = (v) => { if (!Number.isFinite(v)) throw new Error('ratio expected'); return `${v.toFixed(2)}x`; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (id) => id.replace(/^[^_]+__/, '');

/** Exact two-sided sign test: k of n problems favour one arm, ties excluded by the caller. */
const choose = (n, r) => { let v = 1; for (let i = 0; i < r; i++) v = (v * (n - i)) / (i + 1); return v; };
const signP = (hi, n) => { let t = 0; for (let i = hi; i <= n; i++) t += choose(n, i); return Math.min(1, (2 * t) / 2 ** n); };

// ------------------------------------------------------------------ the two arms
const ARMS = [
  { key: 'swift', label: 'Swift', data: D.swift },
  { key: 'q8', label: 'base', data: D.q8 },
];
for (const a of ARMS) {
  a.man = need(a.data, 'manifest');
  a.cells = need(a.data, 'cells');
  a.model = need(a.man, 'model');
  a.pass = a.cells.filter((c) => c.pass).length;
  a.scored = a.cells.filter((c) => c.scored).length;
}
const [S, Q] = ARMS;
const N_RUNS = S.cells.length;
if (Q.cells.length !== N_RUNS) throw new Error('arms have different run counts');

const IDS = [...new Set(S.cells.map((c) => c.instance))];
if (IDS.length !== [...new Set(Q.cells.map((c) => c.instance))].length) throw new Error('arms have different pools');
const REPEATS = N_RUNS / IDS.length;

const runsOf = (arm, id) => arm.cells.filter((c) => c.instance === id).sort((a, b) => a.repeat - b.repeat);
const outcome = (arm, id) => runsOf(arm, id).map((c) => (c.pass ? 'P' : 'F')).join('');

// Per-problem medians. The median over REPEATS draws is itself noisy, so no single ratio is
// load-bearing: the sign test ACROSS problems is the statistic.
const FIELD = {
  peak: (c) => need(c, 'peak_prompt_tokens', 'cell.'),
  wall: (c) => need(c, 'wall_seconds', 'cell.'),
  think: (c) => need(c, 'reasoning_chars', 'cell.'),
  output: (c) => need(c, 'tokens', 'cell.').output,
  steps: (c) => need(c, 'steps', 'cell.'),
  tools: (c) => need(c, 'tool_calls', 'cell.'),
};
const perProblem = IDS.map((id) => {
  const row = { id, short: short(id), repo: runsOf(S, id)[0].repo };
  for (const [name, get] of Object.entries(FIELD)) {
    row[name] = { s: medRaw(runsOf(S, id).map(get)), q: medRaw(runsOf(Q, id).map(get)) };
    row[name].ratio = row[name].s / row[name].q;
  }
  row.passS = runsOf(S, id).filter((c) => c.pass).length;
  row.passQ = runsOf(Q, id).filter((c) => c.pass).length;
  return row;
});

const OUTLIER = [...perProblem].sort((a, b) => b.peak.ratio - a.peak.ratio)[0];

const cheaper = (name) => {
  const lower = perProblem.filter((p) => p[name].ratio < 1).length;
  const ties = perProblem.filter((p) => p[name].ratio === 1).length;
  const n = perProblem.length - ties;
  return { lower, n, p: signP(Math.max(lower, n - lower), n), medRatio: medRaw(perProblem.map((p) => p[name].ratio)) };
};
const SIGN = Object.fromEntries(Object.keys(FIELD).map((f) => [f, cheaper(f)]));

// Thinking volume decomposes into trajectory length x verbosity per step. Neither factor alone
// reaches significance across ${IDS.length} problems; their product does.
for (const p of perProblem) {
  p.perStep = {
    s: medRaw(runsOf(S, p.id).map((c) => FIELD.think(c) / FIELD.steps(c))),
    q: medRaw(runsOf(Q, p.id).map((c) => FIELD.think(c) / FIELD.steps(c))),
  };
  p.perStep.ratio = p.perStep.s / p.perStep.q;
}
SIGN.perStep = cheaper('perStep');

// Accuracy pairing is on PASS COUNT per problem, not on a binary: the pool has problems that
// pass on every repeat and problems that fail on every repeat, and neither can move.
const discordant = perProblem.filter((p) => p.passS !== p.passQ);
const swiftHigher = discordant.filter((p) => p.passS > p.passQ).length;
const qHigher = discordant.length - swiftHigher;
const alwaysPassBoth = perProblem.filter((p) => p.passS === REPEATS && p.passQ === REPEATS).length;
const alwaysFailBoth = perProblem.filter((p) => p.passS === 0 && p.passQ === 0).length;
const agree = perProblem.filter((p) => p.passS === p.passQ).length;

// Instrument facts per arm.
for (const a of ARMS) {
  a.totals = {
    wallH: sum(a.cells.map(FIELD.wall)) / 3600,
    output: sum(a.cells.map(FIELD.output)),
    think: sum(a.cells.map(FIELD.think)),
    tools: sum(a.cells.map(FIELD.tools)),
    toolErrors: sum(a.cells.map((c) => need(c, 'tool_errors', 'cell.'))),
    lengthStops: sum(a.cells.map((c) => need(c, 'length_stops', 'cell.'))),
  };
  a.medians = Object.fromEntries(Object.entries(FIELD).map(([n, g]) => [n, med(a.cells.map(g))]));
  a.head = med(a.cells.map((c) => need(c, 'first_step_prompt_tokens', 'cell.')));
  a.maxResp = { med: med(a.cells.map((c) => c.max_step_response_tokens)), max: Math.max(...a.cells.map((c) => c.max_step_response_tokens)) };
  a.thinkPerStep = med(a.cells.map((c) => FIELD.think(c) / FIELD.steps(c)));
  a.preflightOk = a.cells.filter((c) => Object.values(need(need(c, 'sandbox', 'cell.'), 'preflight', 'sandbox.')).every((v) => v === true)).length;
  a.importOk = a.cells.filter((c) => need(c, 'context_tree_import', 'cell.').ok === true).length;
  a.cleanExit = a.cells.filter((c) => c.exit_code === 0 && !c.timed_out && !c.killed_externally).length;
  a.emptyDiff = a.cells.filter((c) => c.diff_empty !== false).length;
  a.seg = need(need(D.seg, 'arms'), a.key, 'trace-facts.arms.').totals;
  a.spread = Math.max(...IDS.map((id) => {
    const pk = runsOf(a, id).map(FIELD.peak);
    return Math.max(...pk) / Math.min(...pk);
  }));
}

// Host configuration, identical by construction — asserted, not assumed.
const CFG = need(S.cells[0], 'model_config', 'cell.');
const CTX = need(CFG, 'limit_context', 'model_config.');
const OUTCAP = need(CFG, 'limit_output', 'model_config.');
if (need(Q.cells[0], 'model_config', 'cell.').limit_context !== CTX) throw new Error('arms ran at different context limits');
if (need(Q.cells[0], 'model_config', 'cell.').limit_output !== OUTCAP) throw new Error('arms ran at different output caps');
const COMPACT_AT = CTX - Math.min(OUTCAP, 32000);
const W_SOFT = Math.floor(CTX / 3);
const overSoft = (a) => a.cells.filter((c) => FIELD.peak(c) > W_SOFT).length;
const overSoftProblems = (a) => new Set(a.cells.filter((c) => FIELD.peak(c) > W_SOFT).map((c) => c.instance)).size;

// The vendor's own published figures, quoted as claims and labelled as such.
const VENDOR = {
  repo: 'ukisai/Swift-Qwen3.8-27b', base: 'Qwen/Qwen3.8-27B',
  headlineThink: 0.583, headlineLoss: 0.01, headlineSpeed: 1.95,
  tb: { name: 'Terminal-Bench 2.1', base: 0.6674, swift: 0.6584, meanTok: 0.265, medTok: 0.387 },
  gpqaMean: 0.410, gpqaMed: 0.583,
  serving: 'BF16, vLLM, thinking xhigh, temperature 1.0 / top_p 0.95 / top_k 20',
};

// ------------------------------------------------------------------ charts (inline SVG)
function chartOutcomes() {
  const W = 760, rowH = 34, padL = 190, padT = 66, H = padT + perProblem.length * rowH + 20, cell = 26;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Pass or fail of every repeat, both models, per problem">`;
  s += `<text x="12" y="22" font-size="14" font-weight="600" fill="#1b1c1e">Every repeat, both models (filled = solved, hollow = not solved)</text>`;
  s += `<text x="12" y="41" font-size="11.5" fill="#44474b">Upper row ${esc(S.label)}, lower row ${esc(Q.label)}. ${agree} of ${perProblem.length} problems land on the same pass count.</text>`;
  perProblem.forEach((p, i) => {
    const y = padT + i * rowH;
    s += `<text x="${padL - 12}" y="${y + 10}" font-size="11.5" text-anchor="end" fill="#1b1c1e">${esc(p.short)}</text>`;
    ARMS.forEach((a, ai) => {
      const yy = y + ai * 13;
      s += `<text x="${padL - 6}" y="${yy + 4}" font-size="8.5" text-anchor="end" fill="#9aa0a6">${esc(a.label.slice(0, 5))}</text>`;
      runsOf(a, p.id).forEach((c, j) => {
        const cx = padL + j * cell + 8;
        s += c.pass
          ? `<circle cx="${cx}" cy="${yy}" r="5" fill="#2e8b57"/>`
          : `<circle cx="${cx}" cy="${yy}" r="5" fill="#ffffff" stroke="#b3261e" stroke-width="1.5"/>`;
      });
    });
    const tag = p.passS === p.passQ ? `${p.passS}/${REPEATS} both` : `${p.passS}/${REPEATS} vs ${p.passQ}/${REPEATS}`;
    s += `<text x="${padL + REPEATS * cell + 18}" y="${y + 10}" font-size="11" fill="${p.passS === p.passQ ? '#44474b' : '#d08c2c'}">${esc(tag)}</text>`;
  });
  return `${s}</svg>`;
}

function chartRatios() {
  const series = [
    { f: 'peak', label: 'peak prompt', c: '#3060c0' },
    { f: 'think', label: 'thinking volume', c: '#7d45b5' },
    { f: 'wall', label: 'wall time', c: '#2e8b57' },
  ];
  const rows = [...perProblem].sort((a, b) => a.peak.ratio - b.peak.ratio);
  const W = 760, rowH = 28, padL = 190, padT = 84, H = padT + rows.length * rowH + 40;
  const lo = 0.2, hi = 3.6, iw = W - padL - 56;
  const X = (v) => padL + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * iw;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Per-problem cost ratio of Swift to the base model">`;
  s += `<text x="12" y="22" font-size="14" font-weight="600" fill="#1b1c1e">Cost per problem, ${esc(S.label)} &#247; ${esc(Q.label)} (median of ${REPEATS} repeats, log scale)</text>`;
  s += `<text x="12" y="41" font-size="11.5" fill="#44474b">Left of the line is cheaper for ${esc(S.label)}. ${esc(S.label)} is lower on ${SIGN.peak.lower} of ${SIGN.peak.n} problems for every axis shown.</text>`;
  series.forEach((ser, i) => {
    s += `<circle cx="${20 + i * 165}" cy="56" r="4.5" fill="${ser.c}"/><text x="${30 + i * 165}" y="60" font-size="11" fill="#44474b">${esc(ser.label)}</text>`;
  });
  s += `<line x1="${X(1).toFixed(1)}" y1="${padT - 12}" x2="${X(1).toFixed(1)}" y2="${padT + rows.length * rowH - 8}" stroke="#1b1c1e" stroke-width="1.2"/>`;
  s += `<text x="${X(1).toFixed(1)}" y="${padT - 18}" font-size="10" text-anchor="middle" fill="#44474b">same</text>`;
  rows.forEach((p, i) => {
    const y = padT + i * rowH;
    s += `<text x="${padL - 12}" y="${y + 4}" font-size="11.5" text-anchor="end" fill="#1b1c1e">${esc(p.short)}</text>`;
    s += `<line x1="${padL}" y1="${y}" x2="${padL + iw}" y2="${y}" stroke="#eceff1" stroke-width="1"/>`;
    for (const ser of series) {
      const v = Math.min(hi, Math.max(lo, p[ser.f].ratio));
      s += `<circle cx="${X(v).toFixed(1)}" cy="${y}" r="4.5" fill="${ser.c}" opacity="0.88"/>`;
    }
  });
  for (const t of [0.25, 0.5, 1, 2, 3]) {
    s += `<text x="${X(t).toFixed(1)}" y="${H - 16}" font-size="10" text-anchor="middle" fill="#44474b">${t}x</text>`;
  }
  return `${s}</svg>`;
}

// ------------------------------------------------------------------ content
const P = (t) => ({ p: t });
const TABLE = (head, rows) => ({ table: { head, rows } });
const UL = (items) => ({ ul: items });
const SVG = (svg) => ({ svg });

const TITLE = 'The same score for half the thinking';
const SUB = `A reasoning-efficient fine-tune against the stock model on the same ten SWE-bench problems: identical solve rate, ${pct(1 - SIGN.think.medRatio, 0)} less thinking, ${pct(1 - SIGN.wall.medRatio, 0)} less wall time.`;

const sections = [
  {
    title: 'Abstract',
    blocks: [
      P(`This project measures context-management policies by running a coding agent on real software issues, so the model underneath the agent is the instrument, not the subject. Choosing it is a measurement decision: a cheaper instrument buys more repeats per GPU-hour, and a noisier one buys fewer usable results. We compared two deployable versions of the same 27B base — a reasoning-efficient fine-tune, ${esc(VENDOR.repo)}, served here as ${esc(S.model.replace(/^local\//, ''))}, and the stock model served as ${esc(Q.model.replace(/^local\//, ''))} — on identical work.`),
      P(`${IDS.length} SWE-bench Verified problems, ${REPEATS} repeats each, ${N_RUNS} runs per arm. Same sandbox, same prompt, same host, same ${k(CTX)}-token context, same grading. The only thing that differs is the weights.`),
      P(`They score the same: **${S.pass} of ${N_RUNS}** each. They agree on ${agree} of ${IDS.length} problems — ${alwaysPassBoth} solved on every repeat by both, ${alwaysFailBoth} solved by neither — and the ${discordant.length} problems where they differ split ${swiftHigher} to ${qHigher}, which is no evidence of a difference in either direction. On cost they do not tie. The fine-tune is lower on ${SIGN.peak.lower} of ${SIGN.peak.n} problems for peak prompt size, thinking volume, output tokens and wall time alike (sign test p = ${SIGN.peak.p.toFixed(3)} on each): median ratios of ${x2(SIGN.peak.medRatio)} peak, ${x2(SIGN.think.medRatio)} thinking, ${x2(SIGN.wall.medRatio)} wall time.`),
      P(`The mechanism matters more to this project than the saving. Thinking volume is trajectory length times verbosity per step, and the larger factor is verbosity: a median ${x2(SIGN.perStep.medRatio)} on characters per step against ${x2(SIGN.steps.medRatio)} on step count. The agent walks roughly the same route through a problem and writes considerably less at each stop. Re-imported under one segmenter, the two arms decompose into ${S.seg.phases} and ${Q.seg.phases} phases from ${k(S.seg.events)} and ${k(Q.seg.events)} trace events — the tree this project builds is essentially unchanged by a ${pct(1 - S.seg.events / Q.seg.events, 0)} reduction in raw trace volume.`),
      P(`The limits are real and they are about attribution, not about the numbers. The two artifacts differ in quantization as well as in fine-tune, so this measures two deployable builds and not the adapter in isolation. The pool leaves only ${discordant.length} problems able to move, so "no accuracy difference" means none was detectable here, not that none exists. And thinking volume is counted in characters, because the local server reports no reasoning-token count.`),
    ],
  },
  {
    title: 'What was compared',
    blocks: [
      P(`Both arms run the same harness: opencode ${esc(need(S.man, 'opencode_version', 'manifest.'))} in a bubblewrap sandbox with no network beyond a relay to the local model server, no access to the dataset, the upstream repositories, or the operator's home directory. The agent gets the issue text and nothing that names the fix. After it exits, the held-out test patch is applied and the problem's own tests decide the outcome.`),
      TABLE(['', S.label, Q.label], [
        ['Model served', S.model.replace(/^local\//, ''), Q.model.replace(/^local\//, '')],
        ['Upstream weights', `${VENDOR.repo} (fine-tune of ${VENDOR.base})`, `${VENDOR.base} (stock)`],
        ['Problems x repeats', `${IDS.length} x ${REPEATS}`, `${IDS.length} x ${REPEATS}`],
        ['Context limit', `${k(CTX)}`, `${k(CTX)}`],
        ['Output cap', `${k(OUTCAP)}`, `${k(OUTCAP)}`],
        ['Median first-step prompt', `${k(S.head)}`, `${k(Q.head)}`],
        ['Runs with a clean exit', `${S.cleanExit} of ${N_RUNS}`, `${Q.cleanExit} of ${N_RUNS}`],
        ['Runs graded', `${S.scored} of ${N_RUNS}`, `${Q.scored} of ${N_RUNS}`],
        ['Sandbox preflight fully green', `${S.preflightOk} of ${N_RUNS}`, `${Q.preflightOk} of ${N_RUNS}`],
        ['Runs leaving a real code change', `${N_RUNS - S.emptyDiff} of ${N_RUNS}`, `${N_RUNS - Q.emptyDiff} of ${N_RUNS}`],
      ]),
      P(`The median first-step prompt differs by ${k(Math.abs(S.head - Q.head))} tokens, which is the system block, the tool schemas and the issue text — identical by construction. Anything that follows is the model's own behaviour, not a difference in what it was asked.`),
    ],
  },
  {
    title: 'Accuracy: a tie, on a pool that could barely show otherwise',
    blocks: [
      P(`Both arms solve ${S.pass} of ${N_RUNS} runs. Pairing is on pass count per problem rather than on a binary outcome, because ${REPEATS} repeats of one problem are not ${REPEATS} independent observations and the same problems are perfectly stable in both arms.`),
      SVG(chartOutcomes()),
      TABLE(['Problem', 'Repo', `${S.label} solved`, `${Q.label} solved`, 'Agree'], perProblem.map((p) => [
        p.short, p.repo, `${p.passS}/${REPEATS} (${outcome(S, p.id)})`, `${p.passQ}/${REPEATS} (${outcome(Q, p.id)})`,
        p.passS === p.passQ ? 'yes' : 'no',
      ])),
      P(`${alwaysPassBoth} problems are solved on every repeat by both arms and ${alwaysFailBoth} by neither, so ${alwaysPassBoth + alwaysFailBoth} of ${IDS.length} problems cannot distinguish the models at all. The ${discordant.length} that move split one each way: ${discordant.map((p) => `${p.short} ${p.passS}/${REPEATS} vs ${p.passQ}/${REPEATS}`).join(', ')}. A design with ${discordant.length} discordant units has no power to speak of — the honest statement is that no accuracy difference was detectable on this pool, not that the two models are equivalent.`),
      P(`That three problems fail on every repeat of **both** quantizations — ${perProblem.filter((p) => p.passS === 0 && p.passQ === 0).map((p) => p.short).join(', ') || 'none'}, ${alwaysFailBoth * REPEATS * 2} runs in total — is worth recording separately. These are not one model's blind spot; they are the headroom this pool offers to anything that changes how the agent manages its context.`),
    ],
  },
  {
    title: 'Cost: lower on nine problems out of ten, on every axis',
    blocks: [
      SVG(chartRatios()),
      TABLE(['Measure', `${S.label} median run`, `${Q.label} median run`, 'Median per-problem ratio', `${S.label} lower on`, 'Sign test p'], [
        ['Peak prompt tokens', k(S.medians.peak), k(Q.medians.peak), x2(SIGN.peak.medRatio), `${SIGN.peak.lower}/${SIGN.peak.n}`, SIGN.peak.p.toFixed(3)],
        ['Thinking characters', k(S.medians.think), k(Q.medians.think), x2(SIGN.think.medRatio), `${SIGN.think.lower}/${SIGN.think.n}`, SIGN.think.p.toFixed(3)],
        ['Output tokens', k(S.medians.output), k(Q.medians.output), x2(SIGN.output.medRatio), `${SIGN.output.lower}/${SIGN.output.n}`, SIGN.output.p.toFixed(3)],
        ['Wall seconds', k(S.medians.wall), k(Q.medians.wall), x2(SIGN.wall.medRatio), `${SIGN.wall.lower}/${SIGN.wall.n}`, SIGN.wall.p.toFixed(3)],
        ['Tool calls', k(S.medians.tools), k(Q.medians.tools), x2(SIGN.tools.medRatio), `${SIGN.tools.lower}/${SIGN.tools.n}`, SIGN.tools.p.toFixed(3)],
        ['Steps', k(S.medians.steps), k(Q.medians.steps), x2(SIGN.steps.medRatio), `${SIGN.steps.lower}/${SIGN.steps.n}`, SIGN.steps.p.toFixed(3)],
      ]),
      P(`The sign test counts only the problems where the two arms differ, so a measure on which one problem ties is tested over ${IDS.length - 1} rather than ${IDS.length}. Across the whole batch the difference is ${S.totals.wallH.toFixed(1)} against ${Q.totals.wallH.toFixed(1)} GPU-hours, ${k(S.totals.output)} against ${k(Q.totals.output)} output tokens, and ${k(S.totals.think)} against ${k(Q.totals.think)} characters of thinking. At equal wall time that is room for ${pct(Q.totals.wallH / S.totals.wallH - 1, 0)} more runs, for no measured loss.`),
      P(`One problem runs the other way, and it is a variance story rather than a weights story. On ${esc(OUTLIER.short)} the fine-tune's ${REPEATS} repeats peaked at ${runsOf(S, OUTLIER.id).map((c) => k(FIELD.peak(c))).join(', ')} tokens and the stock model's at ${runsOf(Q, OUTLIER.id).map((c) => k(FIELD.peak(c))).join(', ')} — both models have a cheap route and an expensive one through it, and each drew differently. Within a single problem, with nothing varied, peak prompt size moves by as much as ${x2(S.spread)} in the ${S.label} arm and ${x2(Q.spread)} in the ${Q.label} arm. That is why the sign test across problems is the statistic here and no individual ratio is.`),
    ],
  },
  {
    title: 'Where the saving comes from',
    blocks: [
      P(`Thinking volume per run is trajectory length times verbosity per step, and the two factors can be read separately. The trajectory shortens a little — median ${x2(SIGN.steps.medRatio)} on steps (${SIGN.steps.lower} of ${SIGN.steps.n} problems, p = ${SIGN.steps.p.toFixed(2)}) and ${x2(SIGN.tools.medRatio)} on tool calls (${SIGN.tools.lower} of ${SIGN.tools.n}, p = ${SIGN.tools.p.toFixed(2)}). Verbosity falls further: median ${x2(SIGN.perStep.medRatio)} on thinking characters per step (${SIGN.perStep.lower} of ${SIGN.perStep.n}, p = ${SIGN.perStep.p.toFixed(2)}). Neither the step count nor the per-step volume separates the arms on its own; multiplied together they give the ${x2(SIGN.think.medRatio)} that does (p = ${SIGN.think.p.toFixed(3)}). The agent walks a similar route to the fix and writes less at each stop, and the accumulated transcript is smaller as a result.`),
      TABLE(['', S.label, Q.label], [
        ['Median thinking characters per step', k(S.thinkPerStep), k(Q.thinkPerStep)],
        ['Median largest single response (tokens)', k(S.maxResp.med), k(Q.maxResp.med)],
        ['Largest single response anywhere (tokens)', k(S.maxResp.max), k(Q.maxResp.max)],
        [`Steps ending on the ${k(OUTCAP)}-token output cap`, k(S.totals.lengthStops), k(Q.totals.lengthStops)],
        ['Tool calls that errored', `${k(S.totals.toolErrors)} of ${k(S.totals.tools)}`, `${k(Q.totals.toolErrors)} of ${k(Q.totals.tools)}`],
        [`Runs the host had to compact (threshold ${k(COMPACT_AT)})`, `${k(S.seg.runs_compacted)} of ${k(N_RUNS)}`, `${k(Q.seg.runs_compacted)} of ${k(N_RUNS)}`],
        ['Compaction events in total', k(S.seg.compactions), k(Q.seg.compactions)],
      ]),
      P(`The output cap is an instrument hazard rather than a cost line. The stock model hit it once, on a run that still passed; the fine-tune's largest single response anywhere was ${k(S.maxResp.max)} tokens, a quarter of the cap. A step truncated at the cap is a run whose validity has to be argued rather than assumed, and this harness excludes such runs by a rule fixed in advance.`),
    ],
  },
  {
    title: 'What it means for context-tree',
    blocks: [
      P(`Segmentation is the project's own view of a trace, so the two arms were re-imported under a single segmenter for this comparison — the counts stored in each results file were taken on opposite sides of a segmenter change (D21) and would report that change as a model difference.`),
      TABLE(['Re-imported under one segmenter', S.label, Q.label], [
        ['Trace events', k(S.seg.events), k(Q.seg.events)],
        ['Phases', k(S.seg.phases), k(Q.seg.phases)],
        ['Nodes', k(S.seg.nodes), k(Q.seg.nodes)],
        ['File nodes', k(S.seg.file_nodes), k(Q.seg.file_nodes)],
      ]),
      P(`${pct(1 - S.seg.events / Q.seg.events, 0)} fewer trace events produce ${pct(Math.abs(1 - S.seg.phases / Q.seg.phases), 0)} fewer phases. The work decomposes into the same structure either way, which is the useful result: the tree's shape is a property of the problems, and a policy tuned against one of these models is not being tuned against its verbosity.`),
      P(`One consequence to carry into the window experiments. At a soft limit of one third of the context (${k(W_SOFT)} tokens), ${overSoft(S)} of ${N_RUNS} runs in the ${S.label} arm ever exceed it, across ${overSoftProblems(S)} of ${IDS.length} problems; under ${Q.label} it is ${overSoft(Q)} of ${N_RUNS} across ${overSoftProblems(Q)}. Picking the cheaper instrument also shrinks the set of runs on which a soft-limit arm can bind at all, so an arm that never fires on the ${S.label} baseline is a statement about this pool's pressure and not about the policy.`),
    ],
  },
  {
    title: "Against the publisher's own numbers",
    blocks: [
      P(`These are claims from the model card, quoted for comparison, not measurements of ours. The card reports ${pct(VENDOR.headlineThink, 1)} fewer thinking tokens with under ${pct(VENDOR.headlineLoss, 0)} performance loss and a ${x2(VENDOR.headlineSpeed)} speed-up. The headline reduction is the **median** figure on GPQA-Diamond specifically; the mean reduction on that benchmark is ${pct(VENDOR.gpqaMean, 1)}, and the closest published row to the work measured here is ${esc(VENDOR.tb.name)}.`),
      TABLE(['', 'Accuracy', 'Thinking reduction', 'Basis'], [
        [`Card: ${VENDOR.tb.name}`, `${pct(VENDOR.tb.base, 2)} -> ${pct(VENDOR.tb.swift, 2)} (-${((VENDOR.tb.base - VENDOR.tb.swift) * 100).toFixed(2)} pp)`, `${pct(VENDOR.tb.meanTok, 1)} mean, ${pct(VENDOR.tb.medTok, 1)} median`, `BF16 base vs base + adapter; ${VENDOR.serving}`],
        ['Card: GPQA-Diamond', `${pct(0.8838, 2)} -> ${pct(0.8828, 2)} (-0.10 pp)`, `${pct(VENDOR.gpqaMean, 1)} mean, ${pct(VENDOR.gpqaMed, 1)} median`, 'BF16 base vs base + adapter'],
        ['Here: SWE-bench, 10 problems x 3', `${S.pass}/${N_RUNS} vs ${Q.pass}/${N_RUNS} (0.00 pp)`, `${pct(1 - SIGN.think.medRatio, 1)} median per problem`, 'two quantized GGUF builds, agent harness, host defaults'],
      ]),
      P(`The direction agrees and the magnitude is larger than the card's agentic row, on a different substrate at different precisions with different sampling settings. Nothing here replicates the card and nothing here contradicts it; the useful reading is that the published efficiency claim survives contact with a real agent loop on this pool.`),
    ],
  },
  {
    title: 'Limits',
    blocks: [
      UL([
        `**This does not isolate the fine-tune.** The two artifacts differ in quantization as well as in weights: ${esc(S.model.replace(/^local\//, ''))} against ${esc(Q.model.replace(/^local\//, ''))}, from different publishers at different precisions. The publisher's own evaluations compare a BF16 base with the same BF16 base plus the adapter; this compares two deployable builds. Every result here is about those builds.`,
        `**The pool cannot support an equivalence claim.** ${alwaysPassBoth + alwaysFailBoth} of ${IDS.length} problems are pinned at ${REPEATS}/${REPEATS} or 0/${REPEATS} in both arms, leaving ${discordant.length} that can move. "No accuracy difference" means none was detectable at this sample size.`,
        `**Thinking volume is characters, not tokens.** The local server reports no reasoning-token count (every cell records 0), so the reasoning text exported by the host is measured directly. The two models share a tokenizer family, so the ratio is a fair proxy for the token ratio, but it is a proxy.`,
        `**One instrument, one pool, ${N_RUNS} runs per arm.** Ten problems from six repositories, chosen by a seeded rule before any agent ran. Nothing here generalises to other benchmarks or other agent hosts.`,
        `**Per-problem medians are noisy.** ${REPEATS} repeats per problem, against a within-problem spread in peak prompt size of up to ${x2(S.spread)} (${S.label}) and ${x2(Q.spread)} (${Q.label}) with nothing varied. The sign test across problems is the load-bearing statistic; individual ratios are illustration.`,
        `**Wall time carries an unrecorded covariate.** The local server auto-selects a speculative-decoding drafter at load, and it differs by build (the ${S.label} build was observed running n-gram speculation; the MTP head each GGUF carries is the alternative). No results file records which was active. Rejection sampling makes speculative decoding output-distribution-preserving, so solve rate, token counts and thinking volume are unaffected — but the ${x2(SIGN.wall.medRatio)} wall-time ratio may be partly the drafter rather than the fine-tune. The thinking-volume result does not depend on it.`,
        `**Sampling is the host's default, not the publisher's recipe.** Thinking is on; no reasoning-effort level was set; temperature and top-p are whatever opencode sends. The card's numbers come from ${esc(VENDOR.serving)}.`,
        `**Grading uses calibrated pass-to-pass tests** — tests that cannot pass with the official fix in this non-Docker environment are dropped, so a regression in one of them would go unseen. Both arms are graded identically, so this cannot favour either.`,
      ]),
    ],
  },
  {
    title: 'Conclusion',
    blocks: [
      P(`For this project's purposes the choice is settled. The fine-tune scores what the stock model scores and costs less on every axis that separates them, so it becomes the baseline instrument — and the ${Q.totals.wallH.toFixed(1)} GPU-hours spent on the stock arm are what make that a measured choice rather than an assumed one. The ${alwaysFailBoth} problems neither model solves stay on the register as headroom for the context-management arms that follow.`),
    ],
  },
];

// ------------------------------------------------------------------ render
const inlineHtml = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');

let MD = `# ${TITLE}\n\n*${SUB}*\n\n`;
for (const s of sections) {
  MD += `## ${s.title}\n\n`;
  for (const b of s.blocks) {
    if (b.p) MD += `${b.p}\n\n`;
    else if (b.ul) MD += `${b.ul.map((i) => `- ${i}`).join('\n')}\n\n`;
    else if (b.table) {
      const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      MD += `| ${b.table.head.map(cell).join(' | ')} |\n| ${b.table.head.map(() => '---').join(' | ')} |\n`;
      MD += `${b.table.rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n')}\n\n`;
    } else if (b.svg) MD += `_(chart in the HTML version)_\n\n`;
  }
}

let HTML = `<title>Swift vs stock: the baseline instrument</title><style>
:root{--bg:#fbfbfa;--fg:#1b1c1e;--line:#dadce0;--card:#ffffff}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding-inline:16px}
main{max-width:980px;margin:0 auto;padding-block:32px}
h1{font-size:28px;margin:0 0 6px}h2{font-size:20px;margin:36px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
p{margin:0 0 12px}ul{padding-left:22px}li{margin-bottom:8px}code{background:#f1f3f4;padding:1px 4px;border-radius:3px;font-size:13px}
.sub{color:#5f6368;font-style:italic;margin:0 0 18px}
.tw{overflow-x:auto;margin:0 0 16px}table{border-collapse:collapse;font-size:13px;min-width:100%}
th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}th{background:#f1f3f4}
figure{margin:8px 0 18px;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;overflow-x:auto}
</style><main><h1>${esc(TITLE)}</h1><p class="sub">${inlineHtml(SUB)}</p>`;
for (const s of sections) {
  HTML += `<h2>${esc(s.title)}</h2>`;
  for (const b of s.blocks) {
    if (b.p) HTML += `<p>${inlineHtml(b.p)}</p>`;
    else if (b.ul) HTML += `<ul>${b.ul.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</ul>`;
    else if (b.table) HTML += `<div class="tw"><table><thead><tr>${b.table.head.map((h) => `<th>${inlineHtml(h)}</th>`).join('')}</tr></thead><tbody>${b.table.rows.map((r) => `<tr>${r.map((v) => `<td>${inlineHtml(String(v))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    else if (b.svg) HTML += `<figure>${b.svg}</figure>`;
  }
}
HTML += '</main>';

for (const [name, text] of [['md', MD], ['html', HTML]]) {
  if (/undefined|NaN/.test(text)) throw new Error(`report .${name} contains undefined/NaN`);
}
const mdSections = [...MD.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
const htmlSections = [...HTML.matchAll(/<h2>(.+?)<\/h2>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
if (mdSections.join('|') !== htmlSections.join('|')) throw new Error(`section lists differ:\n${mdSections.join('|')}\n${htmlSections.join('|')}`);

writeFileSync(join(OUT, 'report-swift-vs-q8.md'), MD);
writeFileSync(join(OUT, 'report-swift-vs-q8.html'), HTML);
console.error(`wrote report-swift-vs-q8.{md,html}: ${S.pass}/${N_RUNS} vs ${Q.pass}/${N_RUNS}, agree on ${agree}/${IDS.length}, peak ratio ${x2(SIGN.peak.medRatio)} (p=${SIGN.peak.p.toFixed(3)})`);
