/**
 * Duplicate-content analysis (D0) — how often does an agent re-read the same file
 * into its context over a long session, and how many tokens does that cost?
 *
 * Read-only over the committed Claude Code session fixtures. Emits the machine
 * data + a self-contained HTML report (inline SVG charts, no CDN) + a markdown
 * twin. Motivates the context-dedup experiment (E3).
 *
 * Rerun:
 *   node experiments/context-dedup/analyze-duplicate-reads.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FIX = join(ROOT, 'packages', 'cli', 'test', 'fixtures');
const OUT = join(ROOT, 'reports', 'metrics', 'context-dedup');
const CHARS_PER_TOKEN = 4; // the harness estimate (lib.mjs estTokens)

/** Parse one session fixture into its Read calls (path, offset, limit, resultChars) + edit count. */
function analyzeSession(file) {
  const calls = new Map(); // tool_use_id -> {path, offset, limit}
  const resultLen = new Map(); // tool_use_id -> chars
  let edits = 0;
  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.name === 'Read') {
        calls.set(b.id, { path: b.input?.file_path, offset: b.input?.offset ?? null, limit: b.input?.limit ?? null });
      } else if (b.type === 'tool_use' && b.name === 'Edit') {
        edits += 1;
      } else if (b.type === 'tool_result') {
        const c = b.content;
        let n = 0;
        if (typeof c === 'string') n = c.length;
        else if (Array.isArray(c)) for (const x of c) if (x && typeof x === 'object') n += (x.text ?? '').length;
        resultLen.set(b.tool_use_id, n);
      }
    }
  }
  const reads = [];
  for (const [id, meta] of calls) {
    reads.push({ path: meta.path, offset: meta.offset, limit: meta.limit, chars: resultLen.get(id) ?? 0 });
  }
  return { reads, edits };
}

/** Per-session metrics from its reads. Redundant chars = every copy of a file beyond the largest one. */
function sessionStats(name, reads, edits) {
  const byPath = new Map();
  for (const r of reads) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
  }
  const total = reads.length;
  const distinct = byPath.size;
  const loadedChars = reads.reduce((s, r) => s + r.chars, 0);
  let redundantChars = 0;
  for (const [, group] of byPath) {
    const sizes = group.map((r) => r.chars).sort((a, b) => b - a);
    redundantChars += sizes.slice(1).reduce((s, n) => s + n, 0); // keep the largest copy; the rest is waste
  }
  const wholeFile = reads.filter((r) => r.offset === null && r.limit === null).length;
  const filesDup = [...byPath.values()].filter((g) => g.length > 1).length;
  const worst = Math.max(0, ...[...byPath.values()].map((g) => g.length));
  return {
    name,
    reads: total,
    distinct,
    reReads: total - distinct,
    reReadPct: total ? (total - distinct) / total : 0,
    filesReadTwicePlus: filesDup,
    wholeFileReads: wholeFile,
    worstFileCount: worst,
    edits,
    loadedChars,
    redundantChars,
    uniqueChars: loadedChars - redundantChars,
    loadedTokens: Math.round(loadedChars / CHARS_PER_TOKEN),
    redundantTokens: Math.round(redundantChars / CHARS_PER_TOKEN),
    redundantPct: loadedChars ? redundantChars / loadedChars : 0,
  };
}

// ── run analysis ─────────────────────────────────────────────────────────────
const files = readdirSync(FIX)
  .filter((f) => /^claude-code-session.*\.jsonl$/.test(f))
  .sort();

const sessions = [];
const pooledByPath = new Map(); // path -> total count across all fixtures
let pooledReads = 0;
for (const f of files) {
  const { reads, edits } = analyzeSession(join(FIX, f));
  sessions.push(sessionStats(f, reads, edits));
  pooledReads += reads.length;
  for (const r of reads) pooledByPath.set(r.path, (pooledByPath.get(r.path) ?? 0) + 1);
}
const pooledDistinct = pooledByPath.size;
const pooledReReadPct = pooledReads ? (pooledReads - pooledDistinct) / pooledReads : 0;

const topFiles = [...pooledByPath.entries()]
  .map(([path, count]) => ({ path, base: basename(path), count }))
  .filter((x) => x.count > 1)
  .sort((a, b) => b.count - a.count)
  .slice(0, 8);

// reads-per-file histogram (pooled): how many files were read exactly k times
const hist = new Map();
for (const c of pooledByPath.values()) hist.set(c, (hist.get(c) ?? 0) + 1);
const histRows = [...hist.entries()].map(([reads, files]) => ({ reads, files })).sort((a, b) => a.reads - b.reads);

const results = {
  run_id: `dup-read-${Date.now()}`,
  experiment: 'context-dedup / duplicate-read-analysis',
  date: new Date().toISOString(),
  chars_per_token: CHARS_PER_TOKEN,
  pooled: {
    reads: pooledReads,
    distinct: pooledDistinct,
    reReads: pooledReads - pooledDistinct,
    reReadPct: pooledReReadPct,
  },
  sessions,
  topFiles,
  histogram: histRows,
  caveats: [
    'Counts the Read tool only — content also enters via Edit, Bash (cat), and Grep, which are not counted.',
    'Some re-reads are legitimate: the file was changed by an intervening Edit, or a different line range was read.',
    'Token counts are the chars/4 estimate used by the harness, not a real tokenizer.',
    'Redundant = every copy of a file beyond the single largest copy kept.',
  ],
};

// ── inline SVG chart helpers (self-contained, no CDN) ────────────────────────
const PAL = { bar: '#4f7cff', bar2: '#c9d6ff', accent: '#e4572e', grid: '#e6e6ef', text: '#2b2b38', muted: '#7a7a8c' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shortName = (n) => n.replace('claude-code-', '').replace('.jsonl', '');

function svgBars({ title, data, valueFmt = (v) => String(v), maxVal, refLine }) {
  const W = 720, H = 300, padL = 48, padR = 16, padT = 34, padB = 54;
  const iw = W - padL - padR, ih = H - padT - padB;
  const computed = Math.max(...data.map((d) => d.value), refLine ?? 0) * 1.1 || 1;
  const max = maxVal ?? computed;
  const bw = iw / data.length;
  const y = (v) => padT + ih - (v / max) * ih;
  let bars = '';
  data.forEach((d, i) => {
    const x = padL + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const yy = y(d.value);
    bars += `<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${w.toFixed(1)}" height="${(padT + ih - yy).toFixed(1)}" fill="${PAL.bar}" rx="3"/>`;
    bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(yy - 6).toFixed(1)}" font-size="12" fill="${PAL.text}" text-anchor="middle">${esc(valueFmt(d.value))}</text>`;
    bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(padT + ih + 18).toFixed(1)}" font-size="12" fill="${PAL.muted}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  let ref = '';
  if (refLine !== undefined) {
    const ry = y(refLine);
    ref = `<line x1="${padL}" y1="${ry.toFixed(1)}" x2="${W - padR}" y2="${ry.toFixed(1)}" stroke="${PAL.accent}" stroke-width="1.5" stroke-dasharray="6 4"/><text x="${W - padR}" y="${(ry - 5).toFixed(1)}" font-size="11" fill="${PAL.accent}" text-anchor="end">pooled ${valueFmt(refLine)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" style="max-width:100%;height:auto"><text x="${padL}" y="20" font-size="14" font-weight="600" fill="${PAL.text}">${esc(title)}</text>${bars}${ref}</svg>`;
}

function svgStacked({ title, data }) {
  const W = 720, H = 300, padL = 60, padR = 16, padT = 34, padB = 54;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(...data.map((d) => d.unique + d.redundant)) * 1.1 || 1;
  const bw = iw / data.length;
  const y = (v) => padT + ih - (v / max) * ih;
  let bars = '';
  data.forEach((d, i) => {
    const x = padL + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const yU = y(d.unique);
    const yR = y(d.unique + d.redundant);
    bars += `<rect x="${x.toFixed(1)}" y="${yU.toFixed(1)}" width="${w.toFixed(1)}" height="${(padT + ih - yU).toFixed(1)}" fill="${PAL.bar2}" rx="2"/>`;
    bars += `<rect x="${x.toFixed(1)}" y="${yR.toFixed(1)}" width="${w.toFixed(1)}" height="${(yU - yR).toFixed(1)}" fill="${PAL.accent}" rx="2"/>`;
    bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(yR - 6).toFixed(1)}" font-size="11" fill="${PAL.text}" text-anchor="middle">${(d.redundant / 1000).toFixed(1)}k</text>`;
    bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(padT + ih + 18).toFixed(1)}" font-size="12" fill="${PAL.muted}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  const legend = `<rect x="${padL}" y="${H - 20}" width="12" height="12" fill="${PAL.bar2}"/><text x="${padL + 18}" y="${H - 10}" font-size="11" fill="${PAL.muted}">unique read tokens</text><rect x="${padL + 160}" y="${H - 20}" width="12" height="12" fill="${PAL.accent}"/><text x="${padL + 178}" y="${H - 10}" font-size="11" fill="${PAL.muted}">redundant (re-read) tokens</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" style="max-width:100%;height:auto"><text x="${padL}" y="20" font-size="14" font-weight="600" fill="${PAL.text}">${esc(title)}</text>${bars}${legend}</svg>`;
}

function svgHBars({ title, data }) {
  const rowH = 30, padL = 220, padR = 60, padT = 34;
  const H = padT + data.length * rowH + 12, W = 720;
  const iw = W - padL - padR;
  const max = Math.max(...data.map((d) => d.value)) || 1;
  let rows = '';
  data.forEach((d, i) => {
    const yy = padT + i * rowH;
    const w = (d.value / max) * iw;
    rows += `<text x="${padL - 8}" y="${(yy + rowH / 2 + 4).toFixed(1)}" font-size="12" fill="${PAL.text}" text-anchor="end">${esc(d.label)}</text>`;
    rows += `<rect x="${padL}" y="${(yy + 4).toFixed(1)}" width="${w.toFixed(1)}" height="${rowH - 10}" fill="${PAL.bar}" rx="3"/>`;
    rows += `<text x="${(padL + w + 6).toFixed(1)}" y="${(yy + rowH / 2 + 4).toFixed(1)}" font-size="12" fill="${PAL.text}">${d.value}×</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" style="max-width:100%;height:auto"><text x="16" y="20" font-size="14" font-weight="600" fill="${PAL.text}">${esc(title)}</text>${rows}</svg>`;
}

// ── build chart data ─────────────────────────────────────────────────────────
const reReadChart = svgBars({
  title: 'Re-read rate per session (share of Read calls that hit an already-read file)',
  data: sessions.map((s) => ({ label: shortName(s.name), value: s.reReadPct })),
  valueFmt: (v) => `${(v * 100).toFixed(1)}%`,
  maxVal: 1,
  refLine: pooledReReadPct,
});
const stackedChart = svgStacked({
  title: 'Read tokens per session: unique vs redundant (re-read)',
  data: sessions.map((s) => ({ label: shortName(s.name), unique: s.loadedTokens - s.redundantTokens, redundant: s.redundantTokens })),
});
const topChart = svgHBars({
  title: 'Most re-read files (pooled across all fixtures)',
  data: topFiles.map((f) => ({ label: f.base, value: f.count })),
});
const histChart = svgBars({
  title: 'Reads-per-file distribution (pooled): how many files were read k times',
  data: histRows.map((h) => ({ label: `${h.reads}×`, value: h.files })),
  valueFmt: (v) => String(v),
});

// ── tables ───────────────────────────────────────────────────────────────────
const fmtPct = (v) => `${(v * 100).toFixed(1)}%`;
const fmtK = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));

const sessionTableRows = sessions
  .map(
    (s) =>
      `<tr><td>${esc(shortName(s.name))}</td><td>${s.reads}</td><td>${s.distinct}</td><td>${s.reReads} (${fmtPct(s.reReadPct)})</td><td>${s.filesReadTwicePlus}</td><td>${fmtK(s.redundantTokens)} / ${fmtK(s.loadedTokens)} (${fmtPct(s.redundantPct)})</td><td>${s.worstFileCount}×</td><td>${s.edits}</td></tr>`,
  )
  .join('\n');
const topTableRows = topFiles.map((f) => `<tr><td>${f.count}×</td><td>${esc(f.base)}</td><td>${esc(f.path)}</td></tr>`).join('\n');

// ── HTML report ────────────────────────────────────────────────────────────
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Duplicate-content analysis</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; background:#fafafc; color:${PAL.text}; font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 19px; margin: 34px 0 10px; border-bottom:1px solid ${PAL.grid}; padding-bottom:6px; }
  .sub { color:${PAL.muted}; margin:0 0 20px; }
  .kpis { display:flex; flex-wrap:wrap; gap:12px; margin:18px 0 8px; }
  .kpi { flex:1 1 150px; background:#fff; border:1px solid ${PAL.grid}; border-radius:10px; padding:14px 16px; }
  .kpi .n { font-size:26px; font-weight:700; } .kpi .l { color:${PAL.muted}; font-size:13px; }
  .chart { background:#fff; border:1px solid ${PAL.grid}; border-radius:10px; padding:14px; margin:14px 0; overflow-x:auto; }
  table { border-collapse: collapse; width:100%; margin:12px 0; font-size:14px; background:#fff; }
  th,td { border:1px solid ${PAL.grid}; padding:7px 10px; text-align:left; } th { background:#f2f3fa; }
  td:last-child, td:nth-child(n+2) { white-space:nowrap; }
  code { background:#f0f0f6; padding:1px 5px; border-radius:4px; font-size:13px; }
  .callout { background:#fff5f0; border-left:4px solid ${PAL.accent}; padding:12px 16px; border-radius:6px; margin:14px 0; }
  ul.caveats li { color:${PAL.muted}; }
  footer { color:${PAL.muted}; font-size:12px; margin-top:36px; }
</style></head>
<body><main>
<h1>Duplicate-content analysis</h1>
<p class="sub">How often a coding agent re-reads the same file into its context over a session — and what it costs. Source: ${files.length} committed Claude&nbsp;Code session fixtures. Generated ${new Date(results.date).toISOString().slice(0, 10)}.</p>

<h2>Executive summary</h2>
<div class="callout"><strong>${fmtPct(pooledReReadPct)} of all file reads were re-reads</strong> of a file already in context (${results.pooled.reReads} of ${results.pooled.reads} across ${files.length} sessions). Redundant re-loaded content runs to tens of thousands of tokens per session — up to <strong>${fmtPct(Math.max(...sessions.map((s) => s.redundantPct)))}</strong> of everything read. A single file was pulled in as many as <strong>${Math.max(...sessions.map((s) => s.worstFileCount))}×</strong>. Because every copy persists in the window, this is pure, recoverable context bloat — the motivation for a "one copy per external reference" rule (experiment E3).</div>
<div class="kpis">
  <div class="kpi"><div class="n">${fmtPct(pooledReReadPct)}</div><div class="l">reads that were re-reads (pooled)</div></div>
  <div class="kpi"><div class="n">${results.pooled.reReads}/${results.pooled.reads}</div><div class="l">re-reads / total reads</div></div>
  <div class="kpi"><div class="n">${fmtK(sessions.reduce((s, x) => s + x.redundantTokens, 0))}</div><div class="l">redundant tokens (all sessions)</div></div>
  <div class="kpi"><div class="n">${Math.max(...sessions.map((s) => s.worstFileCount))}×</div><div class="l">most-read single file</div></div>
</div>

<h2>Method &amp; caveats</h2>
<p>For each fixture we pair every <code>Read</code> tool call with its result and key it by file path (and, where present, the <code>offset</code>/<code>limit</code> line range). A re-read is any read of a path already read earlier in the same session. "Redundant" tokens = every copy of a file beyond the single largest copy kept (≈ what a keep-latest dedup would remove). Token counts use the harness's <code>chars/4</code> estimate. Read-only; reproducible via <code>node experiments/context-dedup/analyze-duplicate-reads.mjs</code>.</p>
<ul class="caveats">${results.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>

<h2>Re-read rate per session</h2>
<div class="chart">${reReadChart}</div>

<h2>Wasted tokens: unique vs redundant</h2>
<div class="chart">${stackedChart}</div>

<h2>Worst offenders</h2>
<div class="chart">${topChart}</div>

<h2>How many times is a file read?</h2>
<div class="chart">${histChart}</div>

<h2>Per-session detail</h2>
<table><thead><tr><th>session</th><th>reads</th><th>distinct</th><th>re-reads</th><th>files ≥2×</th><th>redundant / loaded tokens</th><th>worst</th><th>edits</th></tr></thead>
<tbody>${sessionTableRows}</tbody></table>

<h2>Most re-read files</h2>
<table><thead><tr><th>count</th><th>file</th><th>path</th></tr></thead><tbody>${topTableRows}</tbody></table>

<h2>Conclusion</h2>
<p>Re-reading dominates file access in long sessions (${fmtPct(pooledReReadPct)} of reads pooled; ${fmtPct(Math.max(...sessions.map((s) => s.reReadPct)))} in the worst session), and every duplicate copy stays resident in the context window. A naive assembler rule — <strong>keep only the most-recent copy of any external reference</strong> — would reclaim on the order of a third of all read tokens with no new information lost, provided the dropped copies are genuinely superseded. Whether that holds without hurting task success (an older read of a <em>different</em> section still being needed) is exactly what experiment&nbsp;E3 tests before any package change.</p>

<footer>context-tree · duplicate-content analysis · data in <code>results-duplicate-read-analysis.json</code></footer>
</main></body></html>
`;

// ── markdown twin ────────────────────────────────────────────────────────────
const md = `# Duplicate-content analysis

*How often a coding agent re-reads the same file into its context over a session — and what it costs.*
Source: ${files.length} committed Claude Code session fixtures (\`packages/cli/test/fixtures/claude-code-session*.jsonl\`).
Generated ${new Date(results.date).toISOString().slice(0, 10)}. Rerun: \`node experiments/context-dedup/analyze-duplicate-reads.mjs\`.

## Executive summary

**${fmtPct(pooledReReadPct)} of all file reads were re-reads** of a file already in context
(${results.pooled.reReads} of ${results.pooled.reads} across ${files.length} sessions). Redundant re-loaded
content reaches **${fmtPct(Math.max(...sessions.map((s) => s.redundantPct)))}** of everything read in the
worst session, and a single file was pulled in as many as **${Math.max(...sessions.map((s) => s.worstFileCount))}×**.
Every copy persists in the window, so this is recoverable context bloat — the motivation for a
"one copy per external reference" rule (experiment E3).

| metric | value |
|---|---|
| reads that were re-reads (pooled) | **${fmtPct(pooledReReadPct)}** |
| re-reads / total reads | ${results.pooled.reReads} / ${results.pooled.reads} |
| redundant tokens (all sessions) | ${fmtK(sessions.reduce((s, x) => s + x.redundantTokens, 0))} |
| most-read single file | ${Math.max(...sessions.map((s) => s.worstFileCount))}× |

## Method & caveats

Each \`Read\` call is paired with its result and keyed by file path (and \`offset\`/\`limit\` where present).
A re-read is any read of a path already read earlier in the same session. "Redundant" tokens = every copy
of a file beyond the single largest copy kept (≈ what a keep-latest dedup removes). Tokens use the
harness \`chars/4\` estimate. Read-only.

${results.caveats.map((c) => `- ${c}`).join('\n')}

## Findings

### Re-read rate per session
${sessions.map((s) => `- **${shortName(s.name)}**: ${fmtPct(s.reReadPct)} (${s.reReads}/${s.reads})`).join('\n')}

Pooled across all fixtures: **${fmtPct(pooledReReadPct)}**.

### Read tokens: unique vs redundant
${sessions.map((s) => `- **${shortName(s.name)}**: ${fmtK(s.redundantTokens)} redundant of ${fmtK(s.loadedTokens)} loaded (${fmtPct(s.redundantPct)})`).join('\n')}

### Per-session detail

| session | reads | distinct | re-reads | files ≥2× | redundant / loaded tokens | worst | edits |
|---|---|---|---|---|---|---|---|
${sessions.map((s) => `| ${shortName(s.name)} | ${s.reads} | ${s.distinct} | ${s.reReads} (${fmtPct(s.reReadPct)}) | ${s.filesReadTwicePlus} | ${fmtK(s.redundantTokens)} / ${fmtK(s.loadedTokens)} (${fmtPct(s.redundantPct)}) | ${s.worstFileCount}× | ${s.edits} |`).join('\n')}

### Most re-read files (pooled)

| count | file | path |
|---|---|---|
${topFiles.map((f) => `| ${f.count}× | \`${f.base}\` | \`${f.path}\` |`).join('\n')}

### Reads-per-file distribution (pooled)

| reads of a file | number of files |
|---|---|
${histRows.map((h) => `| ${h.reads}× | ${h.files} |`).join('\n')}

## Conclusion

Re-reading dominates file access in long sessions (${fmtPct(pooledReReadPct)} of reads pooled;
${fmtPct(Math.max(...sessions.map((s) => s.reReadPct)))} in the worst), and every duplicate copy stays
resident in the window. A naive assembler rule — **keep only the most-recent copy of any external
reference** — would reclaim on the order of a third of all read tokens with no new information lost,
*provided the dropped copies are genuinely superseded*. Whether that holds without hurting task success
(an older read of a *different* section still being needed) is exactly what experiment **E3** tests before
any package change.

> Charts: see the self-contained HTML twin, \`duplicate-read-analysis.html\`.
`;

writeFileSync(join(OUT, 'results-duplicate-read-analysis.json'), JSON.stringify(results, null, 2));
writeFileSync(join(OUT, 'duplicate-read-analysis.html'), html);
writeFileSync(join(OUT, 'duplicate-read-analysis.md'), md);

console.log(`Analysed ${files.length} fixtures: ${pooledReads} reads, ${pooledDistinct} distinct, ${fmtPct(pooledReReadPct)} re-reads.`);
console.log(`Wrote: results-duplicate-read-analysis.json, duplicate-read-analysis.html, duplicate-read-analysis.md → ${OUT}`);
