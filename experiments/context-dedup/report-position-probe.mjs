/**
 * Report generator for the POSITION PROBE (both stages).
 *
 * Stage 1 (easy, 0 distractors, <=26k real tokens)  -> results-position-probe-easy.json
 * Stage 2 (hard, 7 distractors, <=156k real tokens) -> results-position-probe.json
 *
 * Emits report-position-probe.{md,html}. The HTML is self-contained (inline CSS +
 * hand-built SVG); no CDN, renders offline.
 *
 * Rerun: node experiments/context-dedup/report-position-probe.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports', 'metrics', 'context-dedup');
const load = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'));
const easy = load('results-position-probe-easy.json');
const hard = load('results-position-probe.json');

/** One-sided 95% upper bound on the failure rate given n trials and zero failures. */
const ruleOut = (n) => 1 - Math.pow(0.05, 1 / n);
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;

/**
 * The slices the null is quoted over. Every n is DERIVED from the data — an earlier
 * revision hardcoded the both-stages-per-depth slice as 30 when it is 36
 * (18 per depth per stage), which understated the null by 1.5pp.
 */
const perDepth = (d) => d.rows.length / d.depths.length;
const SLICES = [
  { label: 'one cell', n: hard.needles_per_cell },
  { label: 'one depth, hard stage', n: perDepth(hard) },
  { label: 'one depth, both stages', n: perDepth(hard) + perDepth(easy) },
  { label: 'hard probe pooled', n: hard.rows.length },
  { label: 'both stages pooled', n: hard.rows.length + easy.rows.length },
];

/** Per (length, depth) cell: hits/total and the real prompt-token count actually sent. */
function cells(d) {
  return d.lengths.map((len) => {
    const byDepth = d.depths.map((dep) => {
      const c = d.rows.filter((x) => x.len === len && x.depth === dep);
      return { depth: dep, hits: c.filter((x) => x.hit).length, n: c.length };
    });
    const all = d.rows.filter((x) => x.len === len);
    const toks = all.map((x) => x.prompt_tokens).filter(Boolean);
    const secs = all.map((x) => x.seconds).sort((a, b) => a - b);
    return {
      len, byDepth,
      realTok: toks.length ? Math.max(...toks) : null,
      medSec: secs.length ? secs[Math.floor(secs.length / 2)] : null,
      distractors: d.distractors ?? 0,
      hits: all.filter((x) => x.hit).length, n: all.length,
    };
  });
}
const rowsE = cells(easy), rowsH = cells(hard);
const all = [...rowsE, ...rowsH];
const totalN = all.reduce((a, r) => a + r.n, 0);
const totalHits = all.reduce((a, r) => a + r.hits, 0);

// ---------------------------------------------------------------- charts ----
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Chart 1 — accuracy grid. Every cell is 6/6, and the point of the chart is that uniformity. */
function svgGrid() {
  const depths = hard.depths;
  const cw = 104, ch = 44, x0 = 200, y0 = 54;
  const w = x0 + depths.length * cw + 24, h = y0 + all.length * ch + 40;
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="retrieval accuracy by needle depth and context length">`;
  s += `<text x="12" y="24" class="ct">Retrieval accuracy by needle depth &times; context length</text>`;
  depths.forEach((d, i) => {
    s += `<text x="${x0 + i * cw + cw / 2}" y="${y0 - 10}" class="ax mid">${(d * 100).toFixed(0)}%</text>`;
  });
  s += `<text x="${x0 + (depths.length * cw) / 2}" y="${h - 8}" class="ax mid">needle depth (0% = start of context, 100% = end)</text>`;
  all.forEach((r, ri) => {
    const y = y0 + ri * ch;
    const label = `${(r.realTok / 1000).toFixed(0)}k tok  ·  ${r.distractors} distr.`;
    s += `<text x="${x0 - 12}" y="${y + 27}" class="ax end">${esc(label)}</text>`;
    r.byDepth.forEach((c, ci) => {
      const ok = c.hits === c.n;
      const x = x0 + ci * cw;
      s += `<rect x="${x + 2}" y="${y + 2}" width="${cw - 6}" height="${ch - 6}" rx="4" fill="${ok ? '#1b7f4b' : '#b3261e'}"/>`;
      s += `<text x="${x + cw / 2 - 2}" y="${y + 27}" class="cell mid">${c.hits}/${c.n}</text>`;
    });
  });
  return s + '</svg>';
}

/** Chart 2 — what a null of this size can and cannot rule out. */
function svgPower() {
  const bars = SLICES.map((s) => ({ k: `${s.label} (n=${s.n})`, n: s.n }));
  const x0 = 250, bw = 460, bh = 30, gap = 14, y0 = 52;
  const h = y0 + bars.length * (bh + gap) + 40, w = x0 + bw + 70;
  const max = 0.45;
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="largest failure rate consistent with zero observed failures">`;
  s += `<text x="12" y="24" class="ct">Largest true failure rate still consistent with 0 observed failures (95% one-sided)</text>`;
  bars.forEach((b, i) => {
    const v = ruleOut(b.n), y = y0 + i * (bh + gap);
    s += `<text x="${x0 - 12}" y="${y + 20}" class="ax end">${esc(b.k)}</text>`;
    s += `<rect x="${x0}" y="${y}" width="${bw}" height="${bh}" fill="#eceff1" rx="3"/>`;
    s += `<rect x="${x0}" y="${y}" width="${(v / max) * bw}" height="${bh}" fill="#37618e" rx="3"/>`;
    s += `<text x="${x0 + (v / max) * bw + 8}" y="${y + 20}" class="val">${pct(v)}</text>`;
  });
  s += `<text x="${x0 + bw / 2}" y="${h - 10}" class="ax mid">a smaller bar = a tighter null. Only the pooled rows exclude a small deficit.</text>`;
  return s + '</svg>';
}

/** Chart 3 — the one dose-response that IS present: prefill latency. */
function svgLatency() {
  const pts = all.filter((r) => r.realTok && r.medSec != null).sort((a, b) => a.realTok - b.realTok);
  const x0 = 70, y0 = 48, pw = 600, ph = 230;
  const w = x0 + pw + 40, h = y0 + ph + 56;
  const mx = Math.max(...pts.map((p) => p.realTok)), my = Math.max(...pts.map((p) => p.medSec));
  const px = (v) => x0 + (v / mx) * pw, py = (v) => y0 + ph - (v / my) * ph;
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="median latency versus real prompt tokens">`;
  s += `<text x="12" y="24" class="ct">Median call latency vs real prompt tokens (prefill, not degradation)</text>`;
  s += `<line x1="${x0}" y1="${y0 + ph}" x2="${x0 + pw}" y2="${y0 + ph}" stroke="#9aa0a6"/>`;
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + ph}" stroke="#9aa0a6"/>`;
  s += `<polyline fill="none" stroke="#37618e" stroke-width="2" points="${pts.map((p) => `${px(p.realTok)},${py(p.medSec)}`).join(' ')}"/>`;
  for (const p of pts) {
    s += `<circle cx="${px(p.realTok)}" cy="${py(p.medSec)}" r="4.5" fill="#37618e"/>`;
    s += `<text x="${px(p.realTok)}" y="${py(p.medSec) - 10}" class="val mid">${p.medSec}s</text>`;
    s += `<text x="${px(p.realTok)}" y="${y0 + ph + 18}" class="ax mid">${(p.realTok / 1000).toFixed(0)}k</text>`;
  }
  s += `<text x="${x0 + pw / 2}" y="${h - 12}" class="ax mid">real prompt tokens</text>`;
  return s + '</svg>';
}

// ------------------------------------------------------------- markdown ----
const gridTable = (rows, d) => {
  const head = `| real prompt tok | ${d.depths.map((x) => `depth ${(x * 100).toFixed(0)}%`).join(' | ')} |`;
  const sep = `|---|${d.depths.map(() => '---').join('|')}|`;
  const body = rows.map((r) => `| ${r.realTok.toLocaleString()} | ${r.byDepth.map((c) => `${c.hits}/${c.n}`).join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
};

const MD = `# Position probe — does retrieval depend on WHERE a fact sits?

**Finding: no. ${totalHits}/${totalN} across both stages, at every depth, out to 155,773 real prompt
tokens with 7 competing distractors. The null is clean, and it kills position-aware assembly as a lever
for this model at these lengths.**

## Why this was run

Our eviction policies decide only **presence** — which units survive — never **position**. Survivors keep
creation order. If retrieval quality depended on where a fact sat, two policies that keep the same units
and leave them in the same band would be indistinguishable to the metric while differing in reality, and
we would be blind to a whole axis of the design space. The A/B window sweep saw exactly that shape:
idle vs positional recency, pooled \`p = 1.000\` (backlog item 8).

So the question is prior to any policy: **does the lever exist at all on this model?** Two mechanisms
predict it should — RoPE's long-term decay (attenuation with relative distance) and the "lost in the
middle" U-shape reported for long-context LLMs.

## Method

Classic needle-in-a-haystack, single-turn, \`temperature = 0\`, deterministic PRNG, so the whole probe
reruns identically.

- **Haystack** — non-repetitive synthetic records (each line distinct, so no pattern-match escape).
- **Needle** — \`IMPORTANT RECORD: the access code for sector <NAME> is <NNNN>.\` inserted at depth *d*.
- **Question** — appended at the very end; graded by exact match on the 4-digit code.
- **Grid** — 3 context lengths × 5 depths × 6 distinct needles per cell.

**Stage 1 (easy)** ran with **0 distractors**. It hit 90/90 — but that result is weak by construction: the
needle was the only 4-digit number near the question's wording, so the model could pattern-match rather
than discriminate. A ceiling reached that way proves little.

**Stage 2 (hard)** is the one that counts. It adds **7 distractors** — competing \`IMPORTANT RECORD: the
access code for sector X is NNNN\` lines for *other* sectors, scattered at deterministic positions through
the haystack. Every distractor carries the identical framing, so neither the marker phrase nor "the only
4-digit number here" is a usable shortcut: the model must discriminate on the sector name among 8
candidates. Stage 2 also pushes the lengths up ~6×, to **155,773 real prompt tokens** — 59% of the 27B's
262,144-token window.

- Model: \`${hard.model}\`, local, \`temp 0\`, \`max_tokens 32\`.
- Rerun: \`CT_PROBE_LENGTHS=20000,60000,120000 CT_PROBE_DISTRACTORS=7 node experiments/context-dedup/position-probe.mjs\`
- Commit: \`${hard.commit}\`, ${hard.date.slice(0, 10)}.

## Results

### Stage 2 — hard (7 distractors)

${gridTable(rowsH, hard)}

### Stage 1 — easy (0 distractors)

${gridTable(rowsE, easy)}

### Pooled

| stage | distractors | max real tok | trials | hits | accuracy |
|---|---|---|---|---|---|
| easy | 0 | ${rowsE[rowsE.length - 1].realTok.toLocaleString()} | ${rowsE.reduce((a, r) => a + r.n, 0)} | ${rowsE.reduce((a, r) => a + r.hits, 0)} | 100% |
| hard | 7 | ${rowsH[rowsH.length - 1].realTok.toLocaleString()} | ${rowsH.reduce((a, r) => a + r.n, 0)} | ${rowsH.reduce((a, r) => a + r.hits, 0)} | 100% |
| **both** | | | **${totalN}** | **${totalHits}** | **100%** |

Zero errors, zero refusals, zero off-format answers across all ${totalN} calls.

## What this null does and does not cover

A null is only as strong as its detection floor. With zero observed failures, the 95% one-sided upper
bound on the true failure rate is:

| slice | n | largest deficit still consistent with the data |
|---|---|---|
${SLICES.map((s) => `| ${s.label} | ${s.n} | ${pct(ruleOut(s.n))} |`).join('\n')}

So the honest claim is: **no position-dependent failure rate above ~${pct(ruleOut(hard.rows.length), 0)}
exists on this task at these lengths.** A claim about one *depth* is much weaker — a single depth could
carry a ${pct(ruleOut(perDepth(hard)), 0)} deficit and this design would likely miss it, and a single
*cell* weaker still (${pct(ruleOut(hard.needles_per_cell), 0)}). What is ruled out is a *large* effect,
which is what the design space cared about.

## The one real dose-response

Accuracy is flat; **latency is not**. Median call time scales ~linearly with prompt length
(${rowsH.map((r) => `${r.medSec}s @ ${(r.realTok / 1000).toFixed(0)}k`).join(', ')}). That is prefill
compute, not retrieval degradation — the model is doing more work per call, not doing it worse. Worth
noting because it means "just use a bigger window" is not free even when quality says it is: on this host
a 156k-token turn costs ~10× the wall-clock of a 26k-token turn.

## Conclusions

1. **The RoPE-attenuation hypothesis is not supported at these lengths on this model.** No decay with
   depth, and no U-shape: depth 50% is identical to depth 0% and depth 100%. Whatever MRoPE's long-term
   decay does to attention weights, it does not produce measurable retrieval loss out to 59% of the window.
2. **Position-aware assembly is dead as a lever here.** Our policies' inability to express position costs
   us nothing on this model at these sizes. That is a *relief* for the design, not a loss — it means the
   presence-only policy class is not leaving a known effect on the table.
3. **It removes an alternative explanation for the window-cap results.** The failures in the W-sweep were
   not "the fact was present but buried too deep to retrieve." Presence is sufficient. The failures were
   eviction removing content outright, which makes the eviction-cadence finding load-bearing rather than
   possibly-confounded by a positional artifact.

## Caveats

- **Single-turn retrieval of a lexically distinct sentence.** The needle is a copy target, not something
  the model must reason over. Real agent context is heterogeneous and the needed fact is rarely this
  distinct. A null here does not prove position is irrelevant inside a multi-turn agent loop.
- **A ceiling cannot rank policies.** 100% can only refute a claimed deficit. It cannot tell us which
  ordering is better, because every ordering is perfect.
- **One model** (\`${hard.model}\`), one host, one quantization. Positional effects are known to be
  architecture- and length-dependent; this says nothing about a different model or about 250k+ contexts.
- **Lengths are estimated (chars/4) for construction**; real \`prompt_tokens\` from the provider ran ~30%
  above the estimate and is what is reported in every table here.
- Stage 1's 90/90 is a weak ceiling (no distractors) and is reported only as the pre-registered stage that
  motivated the hard variant.

---
*Data: \`results-position-probe.json\` (hard), \`results-position-probe-easy.json\` (easy).
Charts in the HTML twin: \`report-position-probe.html\`.*
`;

writeFileSync(join(OUT, 'report-position-probe.md'), MD);

// ------------------------------------------------------------------ html ----
const mdTableToHtml = (block) => {
  const lines = block.trim().split('\n').filter((l) => l.trim().startsWith('|'));
  const cellsOf = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const body = lines.filter((l) => !/^\|[\s|:-]+\|$/.test(l.trim()));
  const [h, ...rest] = body;
  const bold = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return `<table><thead><tr>${cellsOf(h).map((c) => `<th>${bold(c)}</th>`).join('')}</tr></thead><tbody>${
    rest.map((r) => `<tr>${cellsOf(r).map((c) => `<td>${bold(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
};

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Position probe — context-tree</title><style>
:root{--fg:#1b1c1e;--mut:#5f6368;--line:#dadce0;--bg:#fff;--accent:#37618e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:28px;line-height:1.25;margin:0 0 6px}
h2{font-size:20px;margin:40px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:16px;margin:24px 0 8px;color:var(--mut)}
code{background:#f1f3f4;padding:1px 5px;border-radius:3px;font-size:13px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;white-space:nowrap}
th{background:#f8f9fa;font-weight:600}
.lede{font-size:17px;background:#e8f0f8;border-left:4px solid var(--accent);padding:14px 18px;border-radius:0 6px 6px 0;margin:18px 0 28px}
figure{margin:20px 0;border:1px solid var(--line);border-radius:8px;padding:12px;background:#fcfcfd}
figcaption{font-size:13px;color:var(--mut);margin-top:8px}
.ct{font:600 14px sans-serif;fill:#1b1c1e}
.ax{font:12px sans-serif;fill:#5f6368}
.val{font:600 12px sans-serif;fill:#1b1c1e}
.cell{font:700 14px sans-serif;fill:#fff}
.mid{text-anchor:middle}.end{text-anchor:end}
ul{padding-left:22px}li{margin:6px 0}
.note{font-size:14px;color:var(--mut);border-top:1px solid var(--line);margin-top:40px;padding-top:12px}
</style></head><body><main>

<h1>Position probe — does retrieval depend on <em>where</em> a fact sits?</h1>
<p class="lede"><strong>No. ${totalHits}/${totalN} across both stages, at every depth, out to 155,773 real
prompt tokens with 7 competing distractors.</strong> The null is clean, and it removes position-aware
assembly from the design space for this model at these lengths.</p>

<h2>Why this was run</h2>
<p>Our eviction policies decide only <strong>presence</strong> — which units survive — never
<strong>position</strong>. Survivors keep creation order. If retrieval quality depended on where a fact
sat, two policies keeping the same units in the same band would look identical to the metric while
differing in reality. The A/B window sweep showed exactly that shape (idle vs positional recency, pooled
<code>p = 1.000</code>). Two mechanisms predict the lever should exist: RoPE long-term decay, and the
"lost in the middle" U-shape.</p>

<h2>Method</h2>
<p>Needle-in-a-haystack, single-turn, <code>temperature = 0</code>, deterministic PRNG. Haystack lines are
all distinct; the needle is <code>IMPORTANT RECORD: the access code for sector &lt;NAME&gt; is
&lt;NNNN&gt;.</code>; the question is appended at the end and graded by exact match. Grid: 3 lengths × 5
depths × 6 needles.</p>
<p><strong>Stage 1 (easy, 0 distractors)</strong> hit 90/90, but weakly — the needle was the only 4-digit
number near the question's wording. <strong>Stage 2 (hard, 7 distractors)</strong> is the real test: every
distractor uses the identical framing for a different sector, so the model must discriminate on the sector
name among 8 candidates, and the lengths rise ~6× to <strong>155,773 real prompt tokens</strong> (59% of
the 262,144-token window).</p>
<p>Model <code>${esc(hard.model)}</code>. Rerun:
<code>CT_PROBE_LENGTHS=20000,60000,120000 CT_PROBE_DISTRACTORS=7 node experiments/context-dedup/position-probe.mjs</code></p>

<h2>Results</h2>
<figure>${svgGrid()}<figcaption>Every cell is 6/6. Rows are ordered by real prompt tokens; the bottom three
are the hard stage, with 7 distractors each.</figcaption></figure>

<h3>Stage 2 — hard (7 distractors)</h3>
${mdTableToHtml(gridTable(rowsH, hard))}
<h3>Stage 1 — easy (0 distractors)</h3>
${mdTableToHtml(gridTable(rowsE, easy))}

<h2>What this null does and does not cover</h2>
<p>A null is only as strong as its detection floor. With zero observed failures, the 95% one-sided upper
bound on the true failure rate is:</p>
<figure>${svgPower()}<figcaption>The honest claim is the pooled one: no position-dependent failure rate
above ~${pct(ruleOut(hard.rows.length), 0)} exists on this task at these lengths. A single depth could
still hide a ${pct(ruleOut(perDepth(hard)), 0)} deficit, and a single cell
${pct(ruleOut(hard.needles_per_cell), 0)}.</figcaption></figure>

<h2>The one real dose–response</h2>
<figure>${svgLatency()}<figcaption>Accuracy is flat; latency is not. This is prefill compute, not retrieval
degradation — the model does more work per call, not worse work. A 156k-token turn costs ~10× the
wall-clock of a 26k-token one on this host.</figcaption></figure>

<h2>Conclusions</h2>
<ul>
<li><strong>The RoPE-attenuation hypothesis is not supported</strong> at these lengths on this model. No
decay with depth and no U-shape: depth 50% equals depth 0% equals depth 100%.</li>
<li><strong>Position-aware assembly is dead as a lever here.</strong> The presence-only policy class is not
leaving a known effect on the table — a relief for the design, not a loss.</li>
<li><strong>It removes an alternative explanation for the window-cap results.</strong> W-sweep failures
were not "present but buried too deep to retrieve"; presence is sufficient. Eviction removed content
outright, which makes the cadence finding load-bearing rather than possibly confounded.</li>
</ul>

<h2>Caveats</h2>
<ul>
<li><strong>Single-turn retrieval of a lexically distinct sentence.</strong> A copy target, not something
the model must reason over. A null here does not prove position is irrelevant in a multi-turn agent loop.</li>
<li><strong>A ceiling cannot rank policies</strong> — 100% can only refute a claimed deficit.</li>
<li><strong>One model, one host, one quantization.</strong> Positional effects are architecture- and
length-dependent; this says nothing about 250k+ contexts or a different model.</li>
<li>Lengths are estimated (chars/4) for construction; real <code>prompt_tokens</code> ran ~30% above the
estimate and is what every table reports.</li>
<li>Stage 1's 90/90 is a weak ceiling and is reported only as the stage that motivated the hard variant.</li>
</ul>

<p class="note">Data: <code>results-position-probe.json</code> (hard),
<code>results-position-probe-easy.json</code> (easy). Markdown twin:
<code>report-position-probe.md</code>. Generated by
<code>experiments/context-dedup/report-position-probe.mjs</code> at commit <code>${esc(hard.commit)}</code>.</p>
</main></body></html>`;

writeFileSync(join(OUT, 'report-position-probe.html'), HTML);
console.log(`wrote report-position-probe.{md,html} -> ${OUT}`);
console.log(`pooled ${totalHits}/${totalN}; rule-out @n=90 = ${pct(ruleOut(90))}`);
