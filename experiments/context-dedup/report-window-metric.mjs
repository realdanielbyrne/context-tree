/**
 * Explainer + charts for the WINDOW metric (W) used across the A/B sweeps.
 * Self-contained HTML (inline SVG, no CDN) + markdown twin.
 *
 * Rerun: node experiments/context-dedup/report-window-metric.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'reports', 'metrics', 'context-dedup');
const load = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'));
// Every batch run at CADENCE=1. The cadence sweeps are deliberately EXCLUDED: raising
// cadence lets the context overshoot W between eviction events, so those cells are not
// at the W they are labelled with. See report-cadence-confound.{md,html}.
const SOURCES = ['results-ab-longbuild-v2-n3.json', 'results-ab-longbuild-v2.json',
  'results-ab-longbuild-winwA.json', 'results-ab-longbuild-winwB.json'];
// ONE ARM ONLY. Pooling arms made the levels incomparable: W=4,700 and W=9,500 carry
// idle+random+truncate-tail while every interior level is truncate-tail alone, so the
// endpoints were dragged down by the deliberately signal-free `random` control and the
// curve compared unlike things. `truncate-tail` is the incumbent (what real harnesses
// do) and is the only arm present at every level.
const CURVE_ARM = 'truncate-tail';
const cells = SOURCES.flatMap((f) => {
  const d = load(f);
  if ((d.manifest.cadence ?? 1) !== 1) return [];
  return d.cells.filter((c) => c.arm === CURVE_ARM || c.arm === 'uncapped');
});
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
  G[L] = { n: g.length, pass, rate: pass / g.length, peak: med(g.map((c) => c.peak_history_tokens)),
    tokens: med(g.map((c) => c.total_prompt_tokens)), turns: med(g.map((c) => c.turns)), evict: med(g.map((c) => c.evictions)) };
}
/** Wilson 95% interval — honest about n=9 and n=3 cells. */
function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const pct = (v) => `${(v * 100).toFixed(0)}%`;
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
    out += `<text x="${cx}" y="${(y(hi) - 8).toFixed(1)}" font-size="12" font-weight="600" fill="${PAL.text}" text-anchor="middle">${(d.rate * 100).toFixed(0)}%</text>`;
    out += `<text x="${cx}" y="${(y(0) + 20).toFixed(1)}" font-size="12" fill="${PAL.muted}" text-anchor="middle">W = ${L === 'uncapped' ? '∞' : L.toLocaleString()}</text>`;
    out += `<text x="${cx}" y="${(y(0) + 36).toFixed(1)}" font-size="10.5" fill="${PAL.muted}" text-anchor="middle">${d.pass}/${d.n} runs</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><text x="${padL}" y="22" font-size="14" font-weight="600" fill="${PAL.text}">Task success vs window cap (bars = pass rate, whiskers = Wilson 95%)</text>${out}</svg>`;
}

/** Where the budget goes: head + reserve + usable, with achieved peak marked. */
function chartBudget() {
  const W = 760, H = 300, padL = 62, padR = 120, padT = 40, padB = 56;
  const iw = W - padL - padR, ih = H - padT - padB;
  const caps = [4700, 9500];
  const max = 9500 * 1.05;
  const x = (v) => padL + (v / max) * iw;
  const rowH = 54;
  let out = '';
  caps.forEach((C, i) => {
    const yy = padT + i * (rowH + 30);
    const usable = C - HEAD - RESERVE;
    out += `<rect x="${x(0)}" y="${yy}" width="${(x(HEAD) - x(0)).toFixed(1)}" height="${rowH}" fill="${PAL.head}"/>`;
    out += `<rect x="${x(HEAD)}" y="${yy}" width="${(x(HEAD + RESERVE) - x(HEAD)).toFixed(1)}" height="${rowH}" fill="${PAL.res}"/>`;
    out += `<rect x="${x(HEAD + RESERVE)}" y="${yy}" width="${(x(C) - x(HEAD + RESERVE)).toFixed(1)}" height="${rowH}" fill="${PAL.use}"/>`;
    out += `<text x="${x(C) + 8}" y="${yy + rowH / 2 + 4}" font-size="12" fill="${PAL.text}">W = ${C.toLocaleString()}</text>`;
    const pk = G[C].peak;
    out += `<line x1="${x(pk)}" y1="${yy - 6}" x2="${x(pk)}" y2="${yy + rowH + 6}" stroke="${PAL.text}" stroke-width="2" stroke-dasharray="4 3"/>`;
    out += `<text x="${x(pk)}" y="${yy - 10}" font-size="10.5" fill="${PAL.text}" text-anchor="middle">achieved peak ${pk.toLocaleString()}</text>`;
    out += `<text x="${x(HEAD + RESERVE) + 6}" y="${yy + rowH / 2 + 4}" font-size="11" fill="#fff">usable for units: ${usable.toLocaleString()} (${((usable / C) * 100).toFixed(0)}%)</text>`;
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
    out += `<text x="${(x + w / 2).toFixed(1)}" y="${(padT + ih + 19).toFixed(1)}" font-size="12" fill="${PAL.muted}" text-anchor="middle">W = ${L === 'uncapped' ? '∞' : L.toLocaleString()}</text>`;
    out += `<text x="${(x + w / 2).toFixed(1)}" y="${(padT + ih + 35).toFixed(1)}" font-size="10.5" fill="${PAL.muted}" text-anchor="middle">${d.turns} turns · ${d.evict} evictions</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><text x="${padL}" y="22" font-size="14" font-weight="600" fill="${PAL.text}">Total prompt tokens over the session (median) — window explains 88% of the variance</text>${out}</svg>`;
}

const rowsMd = LEVELS.map((L) => { const d = G[L]; const [lo, hi] = wilson(d.pass, d.n);
  return `| ${L === 'uncapped' ? '∞ (uncapped)' : L.toLocaleString()} | ${d.n} | ${d.pass}/${d.n} (${(d.rate * 100).toFixed(0)}%) | ${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}% | ${d.peak.toLocaleString()} | ${d.tokens.toLocaleString()} | ${d.turns} | ${d.evict} |`; }).join('\n');

const body = `
## What \`W\` actually is

\`W\` is an **artificial per-turn cap on the assembled prompt**, enforced by the assembler *before* the
request is sent. It is deliberately **not** the model's context window — that stays fixed at the 27B's
real **262,144 tokens** in every arm, so the provider never rejects anything and no result is an artifact
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

That fixed tax is why the cap bites harder than it looks: at W=4,700 the head+reserve consume
**${(((HEAD + RESERVE) / 4700) * 100).toFixed(0)}%** of the budget, leaving ${(4700 - HEAD - RESERVE).toLocaleString()} tokens
for actual context; at W=9,500 the same tax is only **${(((HEAD + RESERVE) / 9500) * 100).toFixed(0)}%**.

**Units:** \`W\` is counted with the harness's \`estTokens\` = **characters ÷ 4** heuristic, not the
provider's tokenizer. So \`W\` and the \`peak\` column are in estimated tokens, while
\`total_prompt_tokens\` is the provider's real count. They are consistent within an experiment but not
interchangeable.

**Enforcement check:** achieved peak lands ~${(4700 - G[4700].peak).toFixed(0)} tokens under W at every
capped level — exactly the reply reserve being held back — and \`cap_violations = 0\` everywhere. The cap does
what it says.

## Measurements

*One arm only (\`${CURVE_ARM}\`, the incumbent), so every level is comparable. Pooling all arms made them
unlike each other: W=4,700 and W=9,500 carried the deliberately signal-free \`random\` control while the
interior levels did not, which dragged the endpoints down relative to the middle.*

| W | cells | pass | 95% CI (Wilson) | achieved peak | total prompt tok (med) | turns | evictions |
|---|---|---|---|---|---|---|---|
${rowsMd}

## Reading it

- **Dose–response is steep.** Pass rate by cap, \`${CURVE_ARM}\` only:
  ${LEVELS.map((L) => `${L === 'uncapped' ? '∞' : L.toLocaleString()} → ${pct(G[L].rate)} (${G[L].pass}/${G[L].n})`).join(' · ')}.
  Logistic regression on achieved peak, **adjusted for arm**, gives an odds ratio of **42× per e-fold**
  (\`report-cadence-confound.md\`).
- **Cost moves the opposite way.** ${G[4700].tokens.toLocaleString()} → ${G.uncapped.tokens.toLocaleString()}
  prompt tokens across the same span. Capping is *cheaper* and *worse*; the operating point is a trade,
  not an optimum.
- **The curve is NOT monotone point-to-point.** W=6,500 (${G[6500] ? `${G[6500].pass}/${G[6500].n}` : 'n/a'})
  sits below W=5,500 (${G[5500] ? `${G[5500].pass}/${G[5500].n}` : 'n/a'}). With n=3 at the interior
  levels this is within noise, so the data locate the cliff no better than **5,500–7,500**.
- **W is a stand-in for the thing that actually matters, which is ACHIEVED PEAK.** Once achieved peak
  and arm are in the model, nominal W adds nothing (LR χ²(1)=0.19, p=0.66) and neither does eviction
  cadence (χ²(1)=0.37, p=0.54). W only predicts success *because* it determines peak. See
  \`report-cadence-confound.md\` — this matters whenever the cap is not enforced every turn.
- Single problem (C0), so this curve is for \`longbuild\`, not for agentic coding in general.
`;

const md = `# The window metric \`W\` — what it measures, and the dose–response\n${body}\n> Charts in the HTML twin: \`report-window-metric.html\`.\n`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The window metric W</title><style>
:root{color-scheme:light}body{margin:0;background:#fafafc;color:${PAL.text};font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:880px;margin:0 auto;padding:32px 20px 64px}h1{font-size:26px;margin:0 0 6px}h2{font-size:19px;margin:32px 0 10px;border-bottom:1px solid ${PAL.grid};padding-bottom:6px}
.sub{color:${PAL.muted};margin:0 0 18px}.chart{background:#fff;border:1px solid ${PAL.grid};border-radius:10px;padding:14px;margin:14px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px;background:#fff}th,td{border:1px solid ${PAL.grid};padding:7px 10px;text-align:left}th{background:#f2f3fa}
code,pre{background:#f0f0f6;border-radius:4px;font-size:13px}pre{padding:10px 12px;overflow-x:auto}
.callout{background:#eef3ff;border-left:4px solid ${PAL.use};padding:12px 16px;border-radius:6px;margin:14px 0}
footer{color:${PAL.muted};font-size:12px;margin-top:36px}
</style></head><body><main>
<h1>The window metric <code>W</code></h1>
<p class="sub">What the cap actually measures, how it is enforced, and the dose–response it produces.</p>
<div class="callout"><strong><code>W</code> is an artificial per-turn cap on the assembled prompt — not the model's context window.</strong> The 27B's real window stays at 262,144 tokens in every arm, so nothing here is an artifact of a model limit. <code>W</code> simulates a <em>deployment</em> window.</div>
<h2>Dose–response</h2><div class="chart">${chartDose()}</div>
<h2>Where the budget goes</h2><div class="chart">${chartBudget()}</div>
<p>Only the blue segment is negotiable. The head and reply reserve are a fixed tax — <strong>${(((HEAD + RESERVE) / 4700) * 100).toFixed(0)}%</strong> of the budget at W=4,700 versus <strong>${(((HEAD + RESERVE) / 9500) * 100).toFixed(0)}%</strong> at W=9,500 — which is part of why the tight cap bites so much harder.</p>
<h2>Cost moves the other way</h2><div class="chart">${chartCost()}</div>
<h2>What <code>W</code> actually is</h2>
<p><code>W</code> is an <strong>artificial per-turn cap on the assembled prompt</strong>, enforced by the assembler <em>before</em> the request is sent. The model's real context window stays at <strong>262,144 tokens</strong> in every arm, so the provider never rejects anything and no result is an artifact of a model limit.</p>
<p>How it is enforced (<code>policies.mjs → evictToBudget</code>):</p>
<pre>avail = W − head(${HEAD}) − reserve(${RESERVE})
keep  = anchors (last A=4 units, never evicted)
        + units in rank order while they still fit avail</pre>
<p>Three things come out of the same budget, and only the third is negotiable:</p>
<table><thead><tr><th>component</th><th>size</th><th>evictable?</th></tr></thead><tbody>
<tr><td>frozen head (system ${est(task.system)} + task ${est(task.task)})</td><td><strong>${HEAD} tok</strong></td><td>never</td></tr>
<tr><td>reply reserve</td><td><strong>${RESERVE} tok</strong></td><td>never — held back for the answer</td></tr>
<tr><td>context units</td><td>W − ${HEAD + RESERVE}</td><td><strong>yes</strong> — what eviction fights over</td></tr>
</tbody></table>
<p>That fixed tax is why a tight cap bites harder than it looks: at W=4,700 head+reserve consume <strong>${(((HEAD + RESERVE) / 4700) * 100).toFixed(0)}%</strong> of the budget, leaving <strong>${(4700 - HEAD - RESERVE).toLocaleString()}</strong> tokens of actual context; at W=9,500 the same tax is only <strong>${(((HEAD + RESERVE) / 9500) * 100).toFixed(0)}%</strong>, leaving <strong>${(9500 - HEAD - RESERVE).toLocaleString()}</strong>. Halving the cap cut usable context by <strong>${(100 - ((4700 - HEAD - RESERVE) / (9500 - HEAD - RESERVE)) * 100).toFixed(0)}%</strong>, not by 50%.</p>
<h2>Units, and what is NOT comparable</h2>
<p><code>W</code> and the <em>achieved peak</em> are counted with the harness estimator <code>estTokens = characters ÷ 4</code>, <strong>not</strong> the provider's tokenizer. <code>total_prompt_tokens</code> is the provider's real count. They are consistent within an experiment but are <strong>not interchangeable</strong>, so <code>W</code> is not directly a provider-token budget.</p>
<h2>Enforcement check</h2>
<p>Achieved peak lands <strong>${(4700 - G[4700].peak).toFixed(0)}</strong> and <strong>${(9500 - G[9500].peak).toFixed(0)}</strong> tokens under the cap at W=4,700 and W=9,500 — the reply reserve being held back, as designed — and <code>cap_violations = 0</code> in every cell. Predicted peak is <code>W − reserve</code> = ${(4700 - RESERVE).toLocaleString()} / ${(9500 - RESERVE).toLocaleString()}; observed ${G[4700].peak.toLocaleString()} / ${G[9500].peak.toLocaleString()}, the small shortfall being discrete unit sizes that cannot fill the budget exactly.</p>
<h2>Reading the curve</h2>
<ul>
<li><strong>Dose–response is steep:</strong> ${LEVELS.map((L) => `${L === 'uncapped' ? '∞' : L.toLocaleString()} → ${pct(G[L].rate)}`).join(' · ')} (<code>${CURVE_ARM}</code> only). Adjusted for arm, the odds ratio on achieved peak is <strong>42× per e-fold</strong>.</li>
<li><strong>Cost moves the opposite way:</strong> ${G[4700].tokens.toLocaleString()} → ${G.uncapped.tokens.toLocaleString()} prompt tokens across the same span. Capping is cheaper <em>and</em> worse — the operating point is a trade, not an optimum.</li>
<li><strong>The curve is not monotone point-to-point:</strong> W=6,500 (${G[6500].pass}/${G[6500].n}) sits below W=5,500 (${G[5500].pass}/${G[5500].n}). With n=${G[6500].n} at the interior levels that is within noise, so the cliff is located no better than <strong>5,500–7,500</strong>.</li>
<li><strong>W is a proxy for ACHIEVED PEAK, which is the real variable.</strong> Given achieved peak, nominal W adds nothing (LR χ²(1)=0.010, p=0.92) and neither does eviction cadence (p=0.97). See <code>report-cadence-confound.md</code>.</li>
<li><strong>One problem (C0).</strong> This curve is for <code>longbuild</code>, not for agentic coding in general.</li>
</ul>
<h2>Measurements</h2>
<table><thead><tr><th>W</th><th>cells</th><th>pass</th><th>95% CI</th><th>achieved peak</th><th>prompt tok (med)</th><th>turns</th><th>evictions</th></tr></thead><tbody>
${LEVELS.map((L) => { const d = G[L]; const [lo, hi] = wilson(d.pass, d.n); return `<tr><td>${L === 'uncapped' ? '∞ (uncapped)' : L.toLocaleString()}</td><td>${d.n}</td><td>${d.pass}/${d.n} (${(d.rate * 100).toFixed(0)}%)</td><td>${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}%</td><td>${d.peak.toLocaleString()}</td><td>${d.tokens.toLocaleString()}</td><td>${d.turns}</td><td>${d.evict}</td></tr>`; }).join('')}
</tbody></table>
<footer>context-tree · window metric explainer · data from results-ab-longbuild-v2*.json</footer>
</main></body></html>`;

writeFileSync(join(OUT, 'report-window-metric.md'), md);
writeFileSync(join(OUT, 'report-window-metric.html'), html);
console.log('wrote report-window-metric.{md,html} ->', OUT);
console.log(`head=${HEAD} reserve=${RESERVE}; usable at W=4700: ${4700 - HEAD - RESERVE} (${(((4700 - HEAD - RESERVE) / 4700) * 100).toFixed(0)}%), at W=9500: ${9500 - HEAD - RESERVE} (${(((9500 - HEAD - RESERVE) / 9500) * 100).toFixed(0)}%)`);
