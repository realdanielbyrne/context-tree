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
const cells = [...load('results-ab-longbuild-v2-n3.json').cells, ...load('results-ab-longbuild-v2.json').cells];
const task = (await import(join(HERE, 'ab-tasks', 'longbuild.mjs'))).default;
const est = (s) => Math.ceil(s.length / 4);
const HEAD = est(task.system) + est(task.task);
const RESERVE = 512;

const med = (x) => { const s = [...x].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const LEVELS = [4700, 9500, 'uncapped'];
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

**Enforcement check:** achieved peak lands ~${(4700 - G[4700].peak).toFixed(0)} tokens under W at both
levels — exactly the reply reserve being held back — and \`cap_violations = 0\` everywhere. The cap does
what it says.

## Measurements

| W | cells | pass | 95% CI (Wilson) | achieved peak | total prompt tok (med) | turns | evictions |
|---|---|---|---|---|---|---|---|
${rowsMd}

## Reading it

- **Dose–response is steep.** 38% → 89% → 100% as the cap goes 4,700 → 9,500 → ∞. This is the effect the
  regression picks up as odds ratio 72× per log-unit of W.
- **Cost moves the opposite way.** 275k → 478k → 632k prompt tokens. Capping is *cheaper* and *worse*;
  the operating point is a trade, not an optimum.
- **Only two capped levels exist**, with 39 and 9 cells. "Bigger is much better" is solid; the *shape* of
  the curve between them is unmeasured — the quality cliff could be anywhere in 4,700–9,500. That gap is
  exactly what the next short experiment should fill.
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
<li><strong>Dose–response is steep:</strong> 38% → 89% → 100% pass as the cap goes 4,700 → 9,500 → ∞. This is what the regression reports as odds ratio <strong>72×</strong> per log-unit of W.</li>
<li><strong>Cost moves the opposite way:</strong> 275k → 478k → 632k prompt tokens. Capping is cheaper <em>and</em> worse — the operating point is a trade, not an optimum.</li>
<li><strong>Only two capped levels exist</strong> (39 cells at 4,700; 9 at 9,500). "Bigger is much better" is solid; the <em>shape</em> between them is unmeasured, so the quality cliff could sit anywhere in 4,700–9,500.</li>
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
