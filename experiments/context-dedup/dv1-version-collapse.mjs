/**
 * DV1 — gross opportunity of a SINGLE-VERSION working set.
 *
 * Question (one variable: assembler retention policy): if the context held at most
 * one copy of each file — the latest version, superseded versions dropped — instead
 * of the current append-all, how much smaller is (a) the final working set and
 * (b) the multi-turn transmitted volume (the stateless API re-sends context every
 * turn)? This is the GROSS ceiling, ignoring prompt caching (that is DV2's job).
 *
 * Read-only over the committed fixtures. Rerun:
 *   node experiments/context-dedup/dv1-version-collapse.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FIX = join(ROOT, 'packages', 'cli', 'test', 'fixtures');
const OUT = join(ROOT, 'reports', 'metrics', 'context-dedup');
const TOK = (chars) => Math.round(chars / 4);

const norm = (p) => {
  if (typeof p !== 'string') return '(unknown)';
  const i = p.lastIndexOf('context-tree/');
  return i >= 0 ? p.slice(i + 'context-tree/'.length) : p;
};

function readContentLen(o, calls, b) {
  const tur = o.toolUseResult;
  if (tur && typeof tur === 'object' && tur.file && typeof tur.file.content === 'string') return tur.file.content.length;
  const c = b.content;
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) return c.reduce((s, x) => s + (x && typeof x === 'object' ? (x.text ?? '').length : 0), 0);
  return 0;
}

function analyze(file) {
  const calls = new Map(); // id -> repo-relative path
  const lines = readFileSync(file, 'utf8').split('\n');
  // pass 1: read tool_use ids
  for (const s of lines) {
    if (!s.trim()) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b?.type === 'tool_use' && b.name === 'Read') calls.set(b.id, norm(b.input?.file_path));
  }
  // pass 2: walk in order; at each assistant model call snapshot context read-bytes under both policies
  let appendRunning = 0;
  const sv = new Map(); // file -> latest read bytes
  let appendSum = 0, svSum = 0, turns = 0;
  for (const s of lines) {
    if (!s.trim()) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.type === 'assistant') { turns += 1; appendSum += appendRunning; svSum += [...sv.values()].reduce((a, b) => a + b, 0); }
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_result' && calls.has(b.tool_use_id)) {
        const f = calls.get(b.tool_use_id);
        const n = readContentLen(o, calls, b);
        appendRunning += n;   // append-all: every read stays
        sv.set(f, n);         // single-version: replace latest per file
      }
    }
  }
  const finalAppend = appendRunning;
  const finalSv = [...sv.values()].reduce((a, b) => a + b, 0);
  return {
    name: basename(file).replace('claude-code-', '').replace('.jsonl', ''),
    turns,
    finalAppendTok: TOK(finalAppend),
    finalSvTok: TOK(finalSv),
    finalReductionPct: finalAppend ? 1 - finalSv / finalAppend : 0,
    multiAppendTok: TOK(appendSum),
    multiSvTok: TOK(svSum),
    multiReductionPct: appendSum ? 1 - svSum / appendSum : 0,
  };
}

const files = readdirSync(FIX).filter((f) => /^claude-code-session.*\.jsonl$/.test(f)).sort();
const sessions = files.map((f) => analyze(join(FIX, f)));
const results = { experiment: 'DV1 / single-version gross opportunity', date: new Date().toISOString(), sessions,
  caveats: [
    'Read-content only (system, tool schemas, assistant turns, edit diffs are equal across policies and excluded).',
    'GROSS: ignores prompt caching — append-all re-sends a cached prefix at ~0.1x, so multi-turn reduction is an upper bound on volume, not on cost. DV2 models the cache-adjusted cost.',
    'Single-version here retains one copy of EVERY file ever read (no eviction) — a conservative floor; relevance-eviction would shrink it further.',
    'chars/4 token estimate.',
  ] };
writeFileSync(join(OUT, 'results-dv1.json'), JSON.stringify(results, null, 2));

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const k = (v) => v.toLocaleString();
const rows = sessions.map((s) =>
  `| ${s.name} | ${s.turns} | ${k(s.finalAppendTok)} → ${k(s.finalSvTok)} | ${pct(s.finalReductionPct)} | ${k(s.multiAppendTok)} → ${k(s.multiSvTok)} | ${pct(s.multiReductionPct)} |`).join('\n');
const md = `# DV1 — single-version working set: the gross opportunity

**Question (one variable — assembler retention):** if context kept only the latest version of each file
(superseded versions dropped) instead of append-all, how much smaller is the working set and the
multi-turn transmitted volume? Rerun: \`node experiments/context-dedup/dv1-version-collapse.mjs\`.

| session | turns | final working set (append → single-ver) | reduction | multi-turn read tokens (append → single-ver) | reduction |
|---|---|---|---|---|---|
${rows}

**Finding.** The working set shrinks ${pct(Math.min(...sessions.map((s) => s.finalReductionPct)))}–${pct(Math.max(...sessions.map((s) => s.finalReductionPct)))}, and because the stateless API re-sends context every turn, the multi-turn read-token volume falls ${pct(Math.min(...sessions.map((s) => s.multiReductionPct)))}–${pct(Math.max(...sessions.map((s) => s.multiReductionPct)))} (millions of tokens on the long sessions). The redundancy is stacked *whole prior versions*, not duplicate lines (those were ~4%).

**These are GROSS numbers — an upper bound, not a cost saving.** Append-all's re-sent prefix is cached at ~0.1×; single-version rewrites the prefix on each version swap (cache write 1.25×). DV2 resolves the cache-adjusted cost.

${results.caveats.map((c) => `- ${c}`).join('\n')}
`;
writeFileSync(join(OUT, 'report-dv1-version-collapse.md'), md);
console.log('DV1 done:');
for (const s of sessions) console.log(`  ${s.name}: working set ${pct(s.finalReductionPct)} smaller, multi-turn ${pct(s.multiReductionPct)} less`);
console.log(`Wrote results-dv1.json, report-dv1-version-collapse.md → ${OUT}`);
