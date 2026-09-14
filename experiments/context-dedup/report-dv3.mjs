/**
 * DV3 report generator — eviction cadence + cache TTL -> self-contained HTML + markdown.
 * Charts are hand-built inline SVG (no CDN, renders offline from the repo).
 *
 * Rerun: node experiments/context-dedup/dv3-cadence-ttl.mjs && node experiments/context-dedup/report-dv3.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports', 'metrics', 'context-dedup');
const R = JSON.parse(readFileSync(join(OUT, 'results-dv3-cadence-ttl.json'), 'utf8'));
const rows = R.rows;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PAL = { grid: '#e6e6ef', text: '#2b2b38', muted: '#7a7a8c', pos: '#2e9e5b', neg: '#e4572e', read: '#c9d6ff', write: '#e4572e' };
const M = (v) => `${(v / 1e6).toFixed(2)}M`;
const pc = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;

const scenarios = [...new Set(rows.map((r) => `${r.tier} / ${r.scenario}`))];
const cadOf = (arm) => { const m = /every (\d+)/.exec(arm); return m ? +m[1] : null; };
const CADS = [...new Set(rows.map((r) => cadOf(r.arm)).filter(Boolean))].sort((a, b) => a - b);
const get = (scen, cad) => rows.find((r) => `${r.tier} / ${r.scenario}` === scen && cadOf(r.arm) === cad);
const baseOf = (scen) => rows.find((r) => `${r.tier} / ${r.scenario}` === scen && cadOf(r.arm) === null);

/** Grouped bars around a ZERO line (values may be negative). */
function svgSavings() {
  const W = 820, H = 380, padL = 62, padR = 14, padT = 40, padB = 86;
  const iw = W - padL - padR, ih = H - padT - padB;
  const vals = scenarios.flatMap((s) => CADS.map((c) => get(s, c)?.vsBase ?? 0));
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
  const pad = (hi - lo) * 0.12 || 0.1;
  const y0 = hi + pad, y1 = lo - pad;
  const y = (v) => padT + ((y0 - v) / (y0 - y1)) * ih;
  const gw = iw / CADS.length;
  const colors = ['#4f7cff', '#8aa7ff', '#e4572e', '#f0a08c'];
  let out = `<line x1="${padL}" y1="${y(0).toFixed(1)}" x2="${W - padR}" y2="${y(0).toFixed(1)}" stroke="${PAL.text}" stroke-width="1.2"/>`;
  out += `<text x="${padL - 6}" y="${(y(0) + 4).toFixed(1)}" font-size="11" fill="${PAL.muted}" text-anchor="end">0</text>`;
  CADS.forEach((c, ci) => {
    const bw = (gw * 0.76) / scenarios.length;
    scenarios.forEach((s, si) => {
      const v = get(s, c)?.vsBase ?? 0;
      const x = padL + ci * gw + gw * 0.12 + si * bw;
      const yv = y(v), yz = y(0);
      out += `<rect x="${x.toFixed(1)}" y="${Math.min(yv, yz).toFixed(1)}" width="${(bw * 0.86).toFixed(1)}" height="${Math.abs(yz - yv).toFixed(1)}" fill="${colors[si]}" rx="2"/>`;
      if (Math.abs(v) > 0.03) out += `<text x="${(x + bw * 0.43).toFixed(1)}" y="${(v >= 0 ? yv - 4 : yv + 12).toFixed(1)}" font-size="9.5" fill="${PAL.text}" text-anchor="middle">${pc(v)}</text>`;
    });
    out += `<text x="${(padL + ci * gw + gw / 2).toFixed(1)}" y="${(padT + ih + 20).toFixed(1)}" font-size="12" fill="${PAL.muted}" text-anchor="middle">every ${c}</text>`;
  });
  const legend = scenarios.map((s, i) => `<rect x="${padL + (i % 2) * 300}" y="${H - 40 + Math.floor(i / 2) * 16}" width="11" height="11" fill="${colors[i]}"/><text x="${padL + (i % 2) * 300 + 16}" y="${H - 30 + Math.floor(i / 2) * 16}" font-size="11" fill="${PAL.muted}">${esc(s)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><text x="${padL}" y="22" font-size="14" font-weight="600" fill="${PAL.text}">Savings vs append-only, by eviction cadence (above 0 = CHEAPER)</text>${out}${legend}</svg>`;
}

/** Stacked read/write cost decomposition for one scenario. */
function svgDecomp(scen) {
  const W = 820, H = 320, padL = 62, padR = 14, padT = 40, padB = 64;
  const iw = W - padL - padR, ih = H - padT - padB;
  const base = baseOf(scen);
  const tier = R.params.tiers.includes('1-hour TTL') && scen.startsWith('1-hour') ? 2.0 : 1.25;
  const items = [{ name: 'append-only', r: base.cacheRead * 0.1, w: base.cacheWrite * tier },
    ...CADS.map((c) => { const x = get(scen, c); return { name: `every ${c}`, r: x.cacheRead * 0.1, w: x.cacheWrite * tier }; })];
  const max = Math.max(...items.map((i) => i.r + i.w)) * 1.15 || 1;
  const gw = iw / items.length;
  let out = '';
  items.forEach((it, i) => {
    const x = padL + i * gw + gw * 0.25, bw = gw * 0.5;
    const hR = (it.r / max) * ih, hW = (it.w / max) * ih;
    const yR = padT + ih - hR, yW = yR - hW;
    out += `<rect x="${x.toFixed(1)}" y="${yR.toFixed(1)}" width="${bw.toFixed(1)}" height="${hR.toFixed(1)}" fill="${PAL.read}" rx="2"/>`;
    out += `<rect x="${x.toFixed(1)}" y="${yW.toFixed(1)}" width="${bw.toFixed(1)}" height="${hW.toFixed(1)}" fill="${PAL.write}" rx="2"/>`;
    out += `<text x="${(x + bw / 2).toFixed(1)}" y="${(yW - 5).toFixed(1)}" font-size="10.5" fill="${PAL.text}" text-anchor="middle">${M(it.r + it.w)}</text>`;
    out += `<text x="${(x + bw / 2).toFixed(1)}" y="${(padT + ih + 18).toFixed(1)}" font-size="11" fill="${PAL.muted}" text-anchor="middle">${esc(it.name)}</text>`;
  });
  const lg = `<rect x="${padL}" y="${H - 22}" width="11" height="11" fill="${PAL.read}"/><text x="${padL + 16}" y="${H - 12}" font-size="11" fill="${PAL.muted}">cache-read cost (0.1x)</text><rect x="${padL + 210}" y="${H - 22}" width="11" height="11" fill="${PAL.write}"/><text x="${padL + 226}" y="${H - 12}" font-size="11" fill="${PAL.muted}">cache-write cost</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><text x="${padL}" y="22" font-size="14" font-weight="600" fill="${PAL.text}">Cost decomposition — ${esc(scen)} (the mechanism: writes dominate at N=1, reads at N=50)</text>${out}${lg}</svg>`;
}

/** Resumption penalty: append-only vs best capped, continuous vs resumed. */
function svgResume() {
  const W = 820, H = 300, padL = 62, padR = 14, padT = 40, padB = 62;
  const iw = W - padL - padR, ih = H - padT - padB;
  const tiers = [...new Set(rows.map((r) => r.tier))];
  const groups = tiers.map((t) => {
    const cont = `${t} / continuous`, res = `${t} / resumed x3`;
    const bestC = CADS.map((c) => get(cont, c)).reduce((a, b) => (a.eff < b.eff ? a : b));
    const bestR = CADS.map((c) => get(res, c)).reduce((a, b) => (a.eff < b.eff ? a : b));
    return { name: t, values: [
      { label: 'append-only, continuous', v: baseOf(cont).eff, c: '#9aa0ad' },
      { label: 'append-only, resumed x3', v: baseOf(res).eff, c: '#5b616e' },
      { label: 'best capped, continuous', v: bestC.eff, c: '#8aa7ff' },
      { label: 'best capped, resumed x3', v: bestR.eff, c: '#4f7cff' },
    ] };
  });
  const max = Math.max(...groups.flatMap((g) => g.values.map((v) => v.v))) * 1.18 || 1;
  const gw = iw / groups.length;
  let out = '';
  groups.forEach((g, gi) => {
    const bw = (gw * 0.72) / g.values.length;
    g.values.forEach((v, vi) => {
      const x = padL + gi * gw + gw * 0.14 + vi * bw;
      const y = padT + ih - (v.v / max) * ih;
      out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.86).toFixed(1)}" height="${(padT + ih - y).toFixed(1)}" fill="${v.c}" rx="2"/>`;
      out += `<text x="${(x + bw * 0.43).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="10" fill="${PAL.text}" text-anchor="middle">${M(v.v)}</text>`;
    });
    out += `<text x="${(padL + gi * gw + gw / 2).toFixed(1)}" y="${(padT + ih + 18).toFixed(1)}" font-size="12" fill="${PAL.muted}" text-anchor="middle">${esc(g.name)}</text>`;
  });
  const lg = groups[0].values.map((v, i) => `<rect x="${padL + (i % 2) * 300}" y="${H - 38 + Math.floor(i / 2) * 15}" width="10" height="10" fill="${v.c}"/><text x="${padL + (i % 2) * 300 + 15}" y="${H - 29 + Math.floor(i / 2) * 15}" font-size="10.5" fill="${PAL.muted}">${esc(v.label)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><text x="${padL}" y="22" font-size="14" font-weight="600" fill="${PAL.text}">Resumption penalty falls on the BIG context (lower is better)</text>${out}${lg}</svg>`;
}

const tableFor = (scen) => {
  const b = baseOf(scen);
  return [`| arm | eff cost | cache-read | cache-write | evictions | vs append-only |`, `|---|---|---|---|---|---|`,
    `| append-only (uncapped) | ${M(b.eff)} | ${M(b.cacheRead)} | ${M(b.cacheWrite)} | 0 | — |`,
    ...CADS.map((c) => { const x = get(scen, c); return `| cap ${R.params.cap}, evict every ${c} | ${M(x.eff)} | ${M(x.cacheRead)} | ${M(x.cacheWrite)} | ${x.evictions} | **${pc(x.vsBase)}** |`; })].join('\n');
};
const best = Object.entries(R.cheapest).map(([k, v]) => `| ${k} | ${v.arm} | ${M(v.eff)} | ${pc(v.vsBase)} |`).join('\n');

const md = `# DV3 — eviction cadence and cache TTL: a small window DOES pay for its own re-caching

**Finding.** There is an **interior optimum eviction cadence**. Evicting on *every* turn is by far the
worst policy (−183%), but evicting every ~25 turns makes a capped window **33.5% cheaper** than
append-only. A previous conclusion ("append-only is cache-optimal below the window") was an artifact of
DV2 testing only cadence N=1 — the worst case — and generalising from it.

**Why:** cache-write is charged **per mutation**, the cache-read discount accrues **per turn**. Evicting
every \`N\` turns amortises one write across \`N\` cheaper turns, so the crossover is
\`N·r·(C_large − C_small) > w·S\`.

**Setup.** Simulated with the repo's \`ProviderCacheSimulator\` (Anthropic profile). Synthetic session:
${R.params.turns} turns, frozen head ${R.params.head} tok ("always keep": system + steering + prompts),
${R.params.unit} tok added per turn, cap ${R.params.cap}. Effective cost = cacheRead·r + cacheWrite·w + fresh.
Rerun: \`node experiments/context-dedup/dv3-cadence-ttl.mjs && node experiments/context-dedup/report-dv3.mjs\`

## Results by scenario

${scenarios.map((s) => `### ${s}\n\n${tableFor(s)}`).join('\n\n')}

## Cheapest arm per scenario

| scenario | cheapest | eff cost | vs append-only |
|---|---|---|---|
${best}

## Three consequences

1. **The optimum is interior.** Neither N=1 (mutate constantly) nor N=∞ (never evict) is right; ~25 wins
   here. **Cadence is a tunable the assembler does not currently expose.**
2. **Resumption amplifies the small window's advantage.** With 3 TTL cold starts, append-only's cost rises
   ${M(baseOf(`${R.params.tiers[0]} / continuous`).eff)} → ${M(baseOf(`${R.params.tiers[0]} / resumed x3`).eff)}
   (its cache-write nearly triples, because it has the largest prefix to re-cache) while capped arms barely
   move — the best capped arm improves from **+26.3% to +39.4%**. A cold cache punishes whoever is holding
   the most context, and that is append-only. This is the regime long sessions actually live in.
3. **\`g* = w/r\` is tier-dependent, not the constant 12.5.** At the 1-hour write tier (2.0×), cadence-5
   flips from **+5.2% cheaper to −23.5% more expensive**; the optimum stays ~25. Re-derive per tier.

## What this does NOT establish

- **SIMULATED, not live.** No model was run. It is the current best cost model, not a measurement.
- **Cost says nothing about task success.** The cheapest cadence may evict content the task needs; only the
  live A/B can price that. Pair before promoting.
- **Synthetic uniform session** (constant head, constant tokens/turn) — real sessions are bursty.
- **Eviction drops the OLDEST units**, which is the *maximally cache-destructive* choice: it invalidates the
  entire prefix after the head. Dropping late-position units would be cheaper, but those are the most
  recent and most relevant. That tension is real and unexamined — likely where the next gain is.
`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DV3 — eviction cadence &amp; cache TTL</title><style>
:root{color-scheme:light}body{margin:0;background:#fafafc;color:${PAL.text};font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:900px;margin:0 auto;padding:32px 20px 64px}h1{font-size:26px;margin:0 0 6px}h2{font-size:19px;margin:34px 0 10px;border-bottom:1px solid ${PAL.grid};padding-bottom:6px}h3{font-size:15px;margin:20px 0 6px}
.sub{color:${PAL.muted};margin:0 0 18px}.kpis{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}
.kpi{flex:1 1 180px;background:#fff;border:1px solid ${PAL.grid};border-radius:10px;padding:14px 16px}.kpi .n{font-size:24px;font-weight:700}.kpi .l{color:${PAL.muted};font-size:13px}
.chart{background:#fff;border:1px solid ${PAL.grid};border-radius:10px;padding:14px;margin:14px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13.5px;background:#fff}th,td{border:1px solid ${PAL.grid};padding:6px 9px;text-align:left}th{background:#f2f3fa}
code{background:#f0f0f6;padding:1px 5px;border-radius:4px;font-size:13px}
.callout{background:#f0f7f2;border-left:4px solid ${PAL.pos};padding:12px 16px;border-radius:6px;margin:14px 0}
.warn{background:#fff5f0;border-left:4px solid ${PAL.neg};padding:12px 16px;border-radius:6px;margin:14px 0}
ul.caveats li{color:${PAL.muted}}footer{color:${PAL.muted};font-size:12px;margin-top:36px}
</style></head><body><main>
<h1>DV3 — eviction cadence &amp; cache TTL</h1>
<p class="sub">A small window <em>does</em> pay for its own re-caching — if you evict infrequently. Simulated with the repo's <code>ProviderCacheSimulator</code>. Generated ${new Date().toISOString().slice(0, 10)}.</p>
<div class="callout"><strong>There is an interior optimum eviction cadence.</strong> Evicting every turn is the worst policy (−183%); evicting every ~25 turns makes a capped window <strong>33.5% cheaper</strong> than append-only. The earlier conclusion that "append-only is cache-optimal below the window" was an artifact of testing only cadence&nbsp;N=1 and generalising from it.</div>
<div class="kpis">
<div class="kpi"><div class="n" style="color:${PAL.pos}">+33.5%</div><div class="l">cheapest cadence (every 25) vs append-only</div></div>
<div class="kpi"><div class="n" style="color:${PAL.neg}">−183%</div><div class="l">cadence N=1 — the only one DV2 tested</div></div>
<div class="kpi"><div class="n" style="color:${PAL.pos}">+39.4%</div><div class="l">best capped arm once resumption is modelled</div></div>
</div>
<h2>Savings by cadence</h2><div class="chart">${svgSavings()}</div>
<p>Mutation is charged <strong>per mutation</strong>; the read discount accrues <strong>per turn</strong>. Evicting every <code>N</code> turns amortises one write across <code>N</code> cheaper turns — crossover at <code>N·r·(C_large − C_small) &gt; w·S</code>.</p>
<h2>The mechanism</h2><div class="chart">${svgDecomp(scenarios[0])}</div>
<p>At N=1 the bar is almost entirely cache-<em>write</em>; by N=50 it is almost entirely cache-<em>read</em>. The optimum sits where the two trade off.</p>
<h2>Resumption</h2><div class="chart">${svgResume()}</div>
<p>A cold cache punishes whoever holds the most context — which is append-only. Its cache-write nearly triples across the resumption boundaries while the capped arms barely move, so the small window's advantage <em>grows</em> from +26.3% to +39.4%. This is the regime long sessions actually live in.</p>
<h2>Results</h2>
${scenarios.map((s) => { const b = baseOf(s); return `<h3>${esc(s)}</h3><table><thead><tr><th>arm</th><th>eff cost</th><th>cache-read</th><th>cache-write</th><th>evictions</th><th>vs append-only</th></tr></thead><tbody>
<tr><td>append-only (uncapped)</td><td>${M(b.eff)}</td><td>${M(b.cacheRead)}</td><td>${M(b.cacheWrite)}</td><td>0</td><td>—</td></tr>
${CADS.map((c) => { const x = get(s, c); return `<tr><td>cap ${R.params.cap}, evict every ${c}</td><td>${M(x.eff)}</td><td>${M(x.cacheRead)}</td><td>${M(x.cacheWrite)}</td><td>${x.evictions}</td><td style="color:${x.vsBase >= 0 ? PAL.pos : PAL.neg}"><strong>${pc(x.vsBase)}</strong></td></tr>`; }).join('')}
</tbody></table>`; }).join('')}
<h2>Tier dependence</h2>
<p><code>g* = w/r</code> is <strong>not</strong> the constant 12.5. At the 1-hour write tier (2.0×), cadence-5 flips from <strong>+5.2% cheaper to −23.5% more expensive</strong> — pricier writes mean you must evict less often. The optimum stays ~25. Re-derive per tier rather than hardcoding.</p>
<h2>What this does NOT establish</h2>
<div class="warn"><strong>Simulated, not live.</strong> No model was run — this is the current best cost model, not a measurement. And <strong>cost says nothing about task success</strong>: the cheapest cadence may evict content the task needs. Pair with the live arm before promoting anything.</div>
<ul class="caveats">
<li>Synthetic uniform session (constant head, constant tokens/turn); real sessions are bursty.</li>
<li>Eviction drops the <strong>oldest</strong> units — the maximally cache-destructive choice, since it invalidates the entire prefix after the head. Dropping late-position units would be cheaper but those are the most relevant. Unexamined, and likely where the next gain is.</li>
<li>TTL is modelled as a hard cold start at the resumption turns, which is what an expired cache does to the next request.</li>
</ul>
<footer>context-tree · DV3 · data in <code>results-dv3-cadence-ttl.json</code></footer>
</main></body></html>`;

writeFileSync(join(OUT, 'report-dv3-cadence-ttl.md'), md);
writeFileSync(join(OUT, 'report-dv3-cadence-ttl.html'), html);
console.log('wrote report-dv3-cadence-ttl.{md,html} ->', OUT);
