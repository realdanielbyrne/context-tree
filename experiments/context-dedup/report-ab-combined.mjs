/**
 * Combined A/B window-sweep report (n=3 + n=10) -> self-contained HTML + markdown.
 *
 * Reads the two result batches produced by ab-window-sweep.mjs:
 *   results-ab-longbuild-v2-n3.json   (n=3: uncapped, W=9500, W=4700)
 *   results-ab-longbuild-v2.json      (n=10: W=4700 only, the decisive cells)
 * Both batches ran the SAME code (post-blocker-fix), model, task, caps and turn
 * budget, so the W=4700 cells are poolable; the pooled n is computed, never assumed.
 * Per-batch numbers are reported alongside the pool so the pooling is auditable.
 *
 * GUARD: ab-window-sweep writes results only on COMPLETION, so while an n=10 run is
 * still going the v2 file is still the previous batch. Pooling it with itself would
 * double-count the same runs and manufacture significance; the loader detects that
 * by run_id/repeats and drops the second batch.
 *
 * Charts are hand-built inline SVG: no CDN, renders offline from the repo.
 *
 * Rerun: node experiments/context-dedup/report-ab-combined.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'reports', 'metrics', 'context-dedup');
const N3 = join(OUT, 'results-ab-longbuild-v2-n3.json');
const N10 = join(OUT, 'results-ab-longbuild-v2.json');

const ARMS = ['truncate-tail', 'random', 'idle'];
const LABEL = { 'truncate-tail': 'truncate-tail (positional)', random: 'random (control)', idle: 'idle (reference recency)' };
const COLOR = { 'truncate-tail': '#6b7bd6', random: '#9aa0ad', idle: '#e4572e' };

// ── stats ───────────────────────────────────────────────────────────────────
const logFact = (() => { const c = [0, 0]; return (n) => { for (let i = c.length; i <= n; i++) c[i] = c[i - 1] + Math.log(i); return c[n]; }; })();
const lchoose = (n, k) => (k < 0 || k > n ? -Infinity : logFact(n) - logFact(k) - logFact(n - k));
/** Two-tailed Fisher exact on [[a,b],[c,d]]. */
function fisher(a, b, c, d) {
  const n = a + b + c + d, r1 = a + b, c1 = a + c;
  const p = (x) => Math.exp(lchoose(r1, x) + lchoose(n - r1, c1 - x) - lchoose(n, c1));
  const obs = p(a);
  let tot = 0;
  for (let x = Math.max(0, c1 - (n - r1)); x <= Math.min(r1, c1); x++) { const q = p(x); if (q <= obs * (1 + 1e-9)) tot += q; }
  return Math.min(1, tot);
}
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

// ── load ────────────────────────────────────────────────────────────────────
const load = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const b3 = load(N3);
let b10 = load(N10);
if (!b3) throw new Error(`missing ${N3}`);
// GUARD: the harness writes results only when a run COMPLETES, so while the n=10
// sweep is still running results-ab-longbuild-v2.json is still the n=3 file.
// Pooling it with itself would double-count the same runs and invent significance.
if (b10 && b3.manifest?.run_id === b10.manifest?.run_id) {
  console.error('[guard] n=10 file has the same run_id as n=3 (run not finished yet) — treating n=10 as ABSENT.');
  b10 = null;
} else if (b10 && (b10.manifest?.repeats ?? 0) <= (b3.manifest?.repeats ?? 0)) {
  console.error(`[guard] n=10 file reports repeats=${b10.manifest?.repeats} (<= n=3 batch) — treating as ABSENT.`);
  b10 = null;
}
const cellsOf = (b, arm, W) => (b?.cells ?? []).filter((c) => c.arm === arm && (W === 'inf' ? c.window === null : c.window === W));
const agg = (cs) => cs.length ? {
  n: cs.length, pass: cs.filter((c) => c.pass).length,
  passRate: cs.filter((c) => c.pass).length / cs.length,
  turns: med(cs.map((c) => c.turns ?? 0)), turnsMin: Math.min(...cs.map((c) => c.turns ?? 0)), turnsMax: Math.max(...cs.map((c) => c.turns ?? 0)),
  rereads: med(cs.map((c) => c.rereads)), rereadsMin: Math.min(...cs.map((c) => c.rereads)), rereadsMax: Math.max(...cs.map((c) => c.rereads)),
  evict: med(cs.map((c) => c.evictions)), peak: med(cs.map((c) => c.peak_history_tokens)),
  tokens: med(cs.map((c) => c.total_prompt_tokens)),
  selfTerm: cs.filter((c) => c.stop === 'end_turn').length,
} : null;

// decisive cells @4700: per batch + pooled
const D = {};
for (const a of ARMS) {
  const c3 = cellsOf(b3, a, 4700), c10 = cellsOf(b10, a, 4700);
  D[a] = { n3: agg(c3), n10: agg(c10), pool: agg([...c3, ...c10]) };
}
// context cells from the n=3 batch
const CTX = { uncapped: agg(cellsOf(b3, 'uncapped', 'inf')) };
for (const a of ARMS) CTX[a] = agg(cellsOf(b3, a, 9500));

const ft = (x, y) => (x && y ? fisher(x.pass, x.n - x.pass, y.pass, y.n - y.pass) : NaN);
const stats = {};
for (const k of (b10 ? ['n3','n10','pool'] : ['n3'])) {
  const i = D.idle[k], t = D['truncate-tail'][k], r = D.random[k];
  if (!i || !t || !r) continue;
  stats[k] = {
    n: i.n,
    vsTrunc: ft(i, t), vsRand: ft(i, r),
    vsPooled: i ? fisher(i.pass, i.n - i.pass, t.pass + r.pass, (t.n - t.pass) + (r.n - r.pass)) : NaN,
  };
}

// ── inline SVG helpers ──────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PAL = { grid: '#e6e6ef', text: '#2b2b38', muted: '#7a7a8c' };

/** Grouped bars: series = [{name, values:[{label,value,color}]}] */
function svgGrouped({ title, groups, fmt = (v) => v.toFixed(0), max, yLabel = '' }) {
  const W = 760, H = 320, padL = 56, padR = 16, padT = 38, padB = 62;
  const iw = W - padL - padR, ih = H - padT - padB;
  const computedMax = Math.max(...groups.flatMap((g) => g.values.map((v) => v.value))) * 1.15 || 1;
  const M = max ?? computedMax;
  const gw = iw / groups.length;
  let out = '';
  groups.forEach((g, gi) => {
    const bw = (gw * 0.72) / g.values.length;
    g.values.forEach((v, vi) => {
      const x = padL + gi * gw + gw * 0.14 + vi * bw;
      const y = padT + ih - (v.value / M) * ih;
      out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.86).toFixed(1)}" height="${(padT + ih - y).toFixed(1)}" fill="${v.color}" rx="3"/>`;
      out += `<text x="${(x + bw * 0.43).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="11" fill="${PAL.text}" text-anchor="middle">${esc(fmt(v.value))}</text>`;
    });
    out += `<text x="${(padL + gi * gw + gw / 2).toFixed(1)}" y="${(padT + ih + 18).toFixed(1)}" font-size="12" fill="${PAL.muted}" text-anchor="middle">${esc(g.name)}</text>`;
  });
  const legend = groups[0].values.map((v, i) =>
    `<rect x="${padL + i * 210}" y="${H - 22}" width="11" height="11" fill="${v.color}"/><text x="${padL + i * 210 + 16}" y="${H - 12}" font-size="11" fill="${PAL.muted}">${esc(v.label)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" style="max-width:100%;height:auto"><text x="${padL}" y="22" font-size="14" font-weight="600" fill="${PAL.text}">${esc(title)}</text>${yLabel ? `<text x="12" y="${padT + 10}" font-size="11" fill="${PAL.muted}">${esc(yLabel)}</text>` : ''}${out}${legend}</svg>`;
}

/** Bars with min–max whiskers: rows = [{label, med, min, max, color}] */
function svgWhisker({ title, rows, fmt = (v) => String(v), yLabel = '' }) {
  const W = 760, H = 300, padL = 56, padR = 16, padT = 38, padB = 56;
  const iw = W - padL - padR, ih = H - padT - padB;
  const M = Math.max(...rows.map((r) => r.max)) * 1.2 || 1;
  const bw = iw / rows.length;
  let out = '';
  rows.forEach((r, i) => {
    const x = padL + i * bw + bw * 0.3, w = bw * 0.4;
    const y = padT + ih - (r.med / M) * ih;
    const yMin = padT + ih - (r.min / M) * ih, yMax = padT + ih - (r.max / M) * ih;
    out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${(padT + ih - y).toFixed(1)}" fill="${r.color}" rx="3"/>`;
    const cx = x + w / 2;
    out += `<line x1="${cx}" y1="${yMax}" x2="${cx}" y2="${yMin}" stroke="${PAL.text}" stroke-width="1.5"/>`;
    out += `<line x1="${cx - 8}" y1="${yMax}" x2="${cx + 8}" y2="${yMax}" stroke="${PAL.text}" stroke-width="1.5"/>`;
    out += `<line x1="${cx - 8}" y1="${yMin}" x2="${cx + 8}" y2="${yMin}" stroke="${PAL.text}" stroke-width="1.5"/>`;
    out += `<text x="${cx}" y="${(yMax - 7).toFixed(1)}" font-size="11" fill="${PAL.text}" text-anchor="middle">${esc(fmt(r.med))}</text>`;
    out += `<text x="${cx}" y="${(padT + ih + 18).toFixed(1)}" font-size="11" fill="${PAL.muted}" text-anchor="middle">${esc(r.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" style="max-width:100%;height:auto"><text x="${padL}" y="22" font-size="14" font-weight="600" fill="${PAL.text}">${esc(title)}</text>${yLabel ? `<text x="12" y="${padT + 10}" font-size="11" fill="${PAL.muted}">${esc(yLabel)}</text>` : ''}${out}</svg>`;
}

// ── build charts ────────────────────────────────────────────────────────────
const poolN = (D.idle.pool?.n ?? 0);
const POOL_LABEL = `pooled n=${poolN}`;
const batches = [['n=3','n3'], ['n=10','n10'], [POOL_LABEL,'pool']].filter(([, k]) => D.idle[k] && (k !== 'pool' || b10));
const chartPass = svgGrouped({
  title: 'Pass rate at the tight cap (W=4,700), by batch — higher is better',
  yLabel: '% pass', max: 100,
  fmt: (v) => `${v.toFixed(0)}%`,
  groups: batches.map(([name, k]) => ({ name: `${name}`, values: ARMS.map((a) => ({ label: LABEL[a], value: (D[a][k]?.passRate ?? 0) * 100, color: COLOR[a] })) })),
});
const K = D.idle.n10 ? 'n10' : 'n3';
const chartRereads = svgWhisker({
  title: `Re-reads at W=4,700 (${K === 'n10' ? 'n=10' : 'n=3'}) — median with min–max; the predicted mechanism`,
  yLabel: 're-reads',
  rows: ARMS.map((a) => ({ label: a, med: D[a][K].rereads, min: D[a][K].rereadsMin, max: D[a][K].rereadsMax, color: COLOR[a] })),
});
const chartTurns = svgWhisker({
  title: `Turns to completion at W=4,700 (${K === 'n10' ? 'n=10' : 'n=3'}) — median with min–max (61 = 60-turn budget exhausted)`,
  yLabel: 'turns',
  rows: ARMS.map((a) => ({ label: a, med: D[a][K].turns, min: D[a][K].turnsMin, max: D[a][K].turnsMax, color: COLOR[a] })),
});
const chartVolume = svgGrouped({
  title: 'Volume check at W=4,700 — evictions matched, so differences are SELECTION not volume',
  yLabel: 'median evictions',
  groups: [{ name: 'median evictions', values: ARMS.map((a) => ({ label: LABEL[a], value: D[a][K].evict, color: COLOR[a] })) }],
});
const chartCtx = CTX.uncapped ? svgGrouped({
  title: 'Context held vs tokens spent (n=3 batch): uncapped reference vs W=9,500 arms',
  yLabel: 'tokens',
  fmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)),
  groups: [
    { name: 'peak context held', values: [{ label: 'uncapped', value: CTX.uncapped.peak, color: '#9aa0ad' }, ...ARMS.filter((a) => CTX[a]).map((a) => ({ label: LABEL[a], value: CTX[a].peak, color: COLOR[a] }))] },
    { name: 'total prompt tokens', values: [{ label: 'uncapped', value: CTX.uncapped.tokens, color: '#9aa0ad' }, ...ARMS.filter((a) => CTX[a]).map((a) => ({ label: LABEL[a], value: CTX[a].tokens, color: COLOR[a] }))] },
  ],
}) : '';

// ── tables ──────────────────────────────────────────────────────────────────
const pct = (v) => `${(v * 100).toFixed(0)}%`;
const pfmt = (p) => (Number.isNaN(p) ? 'n/a' : p < 0.001 ? '<0.001' : p.toFixed(3));
const rowsFor = (k) => ARMS.filter((a) => D[a][k]).map((a) => {
  const d = D[a][k];
  return `| ${LABEL[a]} | ${d.n} | ${d.pass}/${d.n} (${pct(d.passRate)}) | ${d.turns} (${d.turnsMin}–${d.turnsMax}) | ${d.rereads} (${d.rereadsMin}–${d.rereadsMax}) | ${d.evict} | ${d.selfTerm}/${d.n} | ${d.tokens.toLocaleString()} |`;
}).join('\n');
const statRows = Object.entries(stats).map(([k, s]) =>
  `| ${k === 'n3' ? 'n=3' : k === 'n10' ? 'n=10' : POOL_LABEL} | ${s.n} | ${pfmt(s.vsTrunc)} | ${pfmt(s.vsRand)} | ${pfmt(s.vsPooled)} |`).join('\n');

const verdict = (() => {
  const s = stats.pool ?? stats.n10 ?? stats.n3;
  if (!s) return 'insufficient data';
  const sig = s.vsPooled < 0.05;
  return sig
    ? `At the pooled sample the difference is statistically significant (Fisher p=${pfmt(s.vsPooled)} vs the other two arms combined).`
    : `Even pooled the difference does NOT reach significance (Fisher p=${pfmt(s.vsPooled)} vs the other two arms combined); it remains an effect size, not an established claim.`;
})();

const H = (s) => s; // passthrough
const md = `# A/B window-cap sweep — combined report (n=3 and n=10)

**Question (one variable — the SELECTION signal):** with a coding agent's context capped, does keeping
units by **reference recency** (time since that file was last touched) complete the task better than
keeping by **positional recency** (the tail), and does either beat a **random control**? All capped arms
fit the same budget with the same anchor and differ ONLY in the order they sacrifice units, so they are
**volume-matched by construction**.

**Setup.** One model (\`unsloth/Qwen3.8-27B-GGUF\`, 262K real window) so the provider never rejects a
prompt; the only synthetic element is the artificial cap. **Full tools kept.** Task: \`longbuild\`, a
six-stage pure-stdlib Python build graded by a **held-out** unittest suite. Two batches of identical
configuration (same post-fix code, model, task, caps, 60-turn budget): **n=3** (uncapped, W=9,500,
W=4,700) and **n=10** (W=4,700 only). The W=4,700 cells pool to **n=13**.

Rerun: \`node experiments/context-dedup/ab-window-sweep.mjs\` then \`node experiments/context-dedup/report-ab-combined.mjs\`

## Decisive cells — W=4,700 (tight cap)

### n=3 batch
| arm | n | pass | turns med (min–max) | re-reads med (min–max) | evictions | self-terminated | tokens |
|---|---|---|---|---|---|---|---|
${rowsFor('n3')}

${D.idle.n10 ? `### n=10 batch
| arm | n | pass | turns med (min–max) | re-reads med (min–max) | evictions | self-terminated | tokens |
|---|---|---|---|---|---|---|---|
${rowsFor('n10')}

### Pooled (n=${poolN})
| arm | n | pass | turns med (min–max) | re-reads med (min–max) | evictions | self-terminated | tokens |
|---|---|---|---|---|---|---|---|
${rowsFor('pool')}
` : '_n=10 batch not present yet._'}

## Significance (Fisher exact, two-tailed)

| batch | n/cell | idle vs truncate-tail | idle vs random | idle vs both pooled |
|---|---|---|---|---|
${statRows}

**${verdict}**

## Charts
See the HTML twin (\`report-ab-combined.html\`) for the rendered SVG charts: pass rate by batch,
re-reads with min–max whiskers, turns to completion, the eviction-volume check, and context-vs-tokens.

## Context cells (n=3 batch)

| cell | pass | turns med (min–max) | re-reads | peak context | tokens | self-terminated |
|---|---|---|---|---|---|---|
${['uncapped', ...ARMS].filter((a) => CTX[a]).map((a) => { const d = CTX[a]; return `| ${a === 'uncapped' ? 'uncapped (reference)' : `${LABEL[a]} @9,500`} | ${d.pass}/${d.n} | ${d.turns} (${d.turnsMin}–${d.turnsMax}) | ${d.rereads} | ${d.peak.toLocaleString()} | ${d.tokens.toLocaleString()} | ${d.selfTerm}/${d.n} |`; }).join('\n')}

## Caveats
- **ONE PROBLEM.** All ${(b3.cells.length + (b10?b10.cells.length:0))} runs used a single task
  (\`${b3.manifest.task}\`). This is n repeats of one problem per arm, **not n problems** — so the
  variance measured is within-problem (model nondeterminism) only, and *no* result here speaks to
  between-problem variance. "p=1.000" means *indistinguishable on this problem*, not *never different*;
  more repeats cannot fix it. The SWE-bench substrate (500 instances / 12 repos, 156 runnable,
  \`swebench_provision.py\`) exists precisely to sample problems instead of re-rolling one.
- Single local model; synthetic task — **not a published benchmark**.
- \`turns = 61\` means the 60-turn budget was exhausted ("did not finish in 60"), not "cannot finish".
- Grading is all-or-nothing, so FAIL cells are not distinguished by how close they came.
- \`total_prompt_tokens\` is raw; the local server's caching behaviour is unknown, so this measures
  context volume, not cached cost.
- temp 0 but not bit-identical on this host — read all differences against the min–max spreads.
- Pooling assumes the two batches are exchangeable: same code, model, task, cap and turn budget. They
  are, but they were run as separate batches; per-batch numbers are shown above so this is auditable.
`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>A/B window-cap sweep — combined</title><style>
:root{color-scheme:light}body{margin:0;background:#fafafc;color:${PAL.text};font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:880px;margin:0 auto;padding:32px 20px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:34px 0 10px;border-bottom:1px solid ${PAL.grid};padding-bottom:6px}h3{font-size:16px;margin:22px 0 8px}
.sub{color:${PAL.muted};margin:0 0 20px}.kpis{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}
.kpi{flex:1 1 170px;background:#fff;border:1px solid ${PAL.grid};border-radius:10px;padding:14px 16px}.kpi .n{font-size:24px;font-weight:700}.kpi .l{color:${PAL.muted};font-size:13px}
.chart{background:#fff;border:1px solid ${PAL.grid};border-radius:10px;padding:14px;margin:14px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;background:#fff}th,td{border:1px solid ${PAL.grid};padding:7px 10px;text-align:left}th{background:#f2f3fa}
code{background:#f0f0f6;padding:1px 5px;border-radius:4px;font-size:13px}
.callout{background:#fff5f0;border-left:4px solid #e4572e;padding:12px 16px;border-radius:6px;margin:14px 0}
ul.caveats li{color:${PAL.muted}}footer{color:${PAL.muted};font-size:12px;margin-top:36px}
</style></head><body><main>
<h1>A/B window-cap sweep — combined (n=3 + n=10)</h1>
<p class="sub">Does eviction by <strong>reference recency</strong> beat <strong>positional recency</strong> and a <strong>random control</strong> when context is capped? Volume-matched arms, full tools, one model. Generated ${new Date().toISOString().slice(0, 10)}.</p>
<div class="callout">${esc(verdict)}</div>
<div class="kpis">
${ARMS.map((a) => { const d = D[a].pool ?? D[a].n3; return `<div class="kpi"><div class="n" style="color:${COLOR[a]}">${pct(d.passRate)}</div><div class="l">${esc(LABEL[a])} pass @W=4,700 (n=${d.n})</div></div>`; }).join('')}
</div>
<h2>Pass rate by batch</h2><div class="chart">${chartPass}</div>
<h2>Mechanism: re-reads</h2><div class="chart">${chartRereads}</div>
<p>Keeping a positionally-old but recently-<em>referenced</em> file is exactly what avoids paying to read it again. This was the <strong>pre-registered</strong> mechanism, not a post-hoc pick.</p>
<h2>Turns to completion</h2><div class="chart">${chartTurns}</div>
<h2>Volume check</h2><div class="chart">${chartVolume}</div>
<p>Evictions are matched across arms, so any difference is <strong>which</strong> units survived, not how many were removed.</p>
${chartCtx ? `<h2>Context held vs tokens spent</h2><div class="chart">${chartCtx}</div>` : ''}
<h2>Tables</h2>
<h3>W=4,700 — n=3</h3><table><thead><tr><th>arm</th><th>n</th><th>pass</th><th>turns med (min–max)</th><th>re-reads</th><th>evictions</th><th>self-term</th><th>tokens</th></tr></thead><tbody>
${ARMS.filter((a) => D[a].n3).map((a) => { const d = D[a].n3; return `<tr><td>${esc(LABEL[a])}</td><td>${d.n}</td><td>${d.pass}/${d.n} (${pct(d.passRate)})</td><td>${d.turns} (${d.turnsMin}–${d.turnsMax})</td><td>${d.rereads}</td><td>${d.evict}</td><td>${d.selfTerm}/${d.n}</td><td>${d.tokens.toLocaleString()}</td></tr>`; }).join('')}
</tbody></table>
${D.idle.n10 ? `<h3>W=4,700 — n=10</h3><table><thead><tr><th>arm</th><th>n</th><th>pass</th><th>turns med (min–max)</th><th>re-reads</th><th>evictions</th><th>self-term</th><th>tokens</th></tr></thead><tbody>
${ARMS.map((a) => { const d = D[a].n10; return `<tr><td>${esc(LABEL[a])}</td><td>${d.n}</td><td>${d.pass}/${d.n} (${pct(d.passRate)})</td><td>${d.turns} (${d.turnsMin}–${d.turnsMax})</td><td>${d.rereads}</td><td>${d.evict}</td><td>${d.selfTerm}/${d.n}</td><td>${d.tokens.toLocaleString()}</td></tr>`; }).join('')}
</tbody></table>
<h3>W=4,700 — pooled (n=${poolN})</h3><table><thead><tr><th>arm</th><th>n</th><th>pass</th><th>turns med (min–max)</th><th>re-reads</th><th>evictions</th><th>self-term</th><th>tokens</th></tr></thead><tbody>
${ARMS.map((a) => { const d = D[a].pool; return `<tr><td>${esc(LABEL[a])}</td><td>${d.n}</td><td>${d.pass}/${d.n} (${pct(d.passRate)})</td><td>${d.turns} (${d.turnsMin}–${d.turnsMax})</td><td>${d.rereads}</td><td>${d.evict}</td><td>${d.selfTerm}/${d.n}</td><td>${d.tokens.toLocaleString()}</td></tr>`; }).join('')}
</tbody></table>` : ''}
<h2>Significance (Fisher exact, two-tailed)</h2>
<table><thead><tr><th>batch</th><th>n/cell</th><th>idle vs truncate-tail</th><th>idle vs random</th><th>idle vs both pooled</th></tr></thead><tbody>
${Object.entries(stats).map(([k, s]) => `<tr><td>${k === 'n3' ? 'n=3' : k === 'n10' ? 'n=10' : POOL_LABEL}</td><td>${s.n}</td><td>${pfmt(s.vsTrunc)}</td><td>${pfmt(s.vsRand)}</td><td>${pfmt(s.vsPooled)}</td></tr>`).join('')}
</tbody></table>
<h2>Caveats</h2><ul class="caveats">
<li>Single local model, single synthetic task — <strong>not a published benchmark</strong>; a non-Docker SWE-bench harness is validated and is the proper next substrate.</li>
<li><code>turns = 61</code> means the 60-turn budget was exhausted, not "cannot finish".</li>
<li>Grading is all-or-nothing; FAIL cells are not distinguished by how close they came.</li>
<li><code>total_prompt_tokens</code> is raw — context volume, not cached cost.</li>
<li>temp 0 but not bit-identical on this host; read differences against the min–max spreads.</li>
<li>Pooling assumes the batches are exchangeable (same code, model, task, cap, turn budget). Per-batch numbers are shown so this is auditable.</li>
</ul>
<footer>context-tree · A/B window-cap sweep · data in <code>results-ab-longbuild-v2*.json</code></footer>
</main></body></html>`;

writeFileSync(join(OUT, 'report-ab-combined.md'), md);
writeFileSync(join(OUT, 'report-ab-combined.html'), html);
console.log('wrote report-ab-combined.{md,html} ->', OUT);
for (const [name, k] of batches) {
  const s = stats[k];
  console.log(`  ${name.padEnd(12)} idle ${D.idle[k].pass}/${D.idle[k].n}  trunc ${D['truncate-tail'][k].pass}/${D['truncate-tail'][k].n}  rand ${D.random[k].pass}/${D.random[k].n}` + (s ? `   p(vs pooled)=${pfmt(s.vsPooled)}` : ''));
}
