/**
 * TIER 1 (offline, deterministic) — does BACKWARD idle predict FORWARD cold?
 *
 * The eviction rule under test is LRU-at-g*: drop a file reference once it has sat
 * unused for more than g* = w/r turns (12.5 for Anthropic caching). That rule uses
 * a trivially-measurable backward signal (turns since last use) as a proxy for the
 * unknowable forward question (will it be used again soon?). This experiment tests
 * whether the proxy holds on real transcripts — it validates the SIGNAL, not the
 * end-to-end benefit (that is Tier 2, live). If idle does not predict cold, the
 * whole LRU-at-g* idea is dead before any harness is built.
 *
 * Measures, over every resident-but-unused (file, turn):
 *   - reuse-gap distribution: are consecutive-reference gaps mostly ≤ g* or > g*?
 *   - hazard curve: P(referenced again within g* turns | current idle = k), by k.
 *   - classifier quality of "idle > g* ⇒ cold (not reused within g*)": precision,
 *     recall, accuracy — the falsifiable claim.
 *
 * Read-only over the fixtures. Rerun:
 *   node experiments/context-dedup/tier1-idle-predicts-cold.mjs [g*]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FIX = join(ROOT, 'packages', 'cli', 'test', 'fixtures');
const OUT = join(ROOT, 'reports', 'metrics', 'context-dedup');
const G = Number(process.argv[2] ?? 12.5); // break-even horizon w/r
const norm = (p) => {
  if (typeof p !== 'string') return '(unknown)';
  const i = p.lastIndexOf('context-tree/');
  return i >= 0 ? p.slice(i + 'context-tree/'.length) : p;
};

/** Reference turns per file (a "reference" = a Read or Edit of the file), on an assistant-turn clock. */
function referencesByFile(file) {
  const calls = new Map();
  const refs = new Map(); // file -> [turn,...]
  let turn = 0;
  for (const s of readFileSync(file, 'utf8').split('\n')) {
    if (!s.trim()) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.type === 'assistant') turn += 1;
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b?.type === 'tool_use' && (b.name === 'Read' || b.name === 'Edit')) calls.set(b.id, norm(b.input?.file_path));
    for (const b of c) {
      if (b?.type === 'tool_result' && calls.has(b.tool_use_id)) {
        const f = calls.get(b.tool_use_id);
        if (!refs.has(f)) refs.set(f, []);
        refs.get(f).push(turn);
      }
    }
  }
  return { refs, turns: turn };
}

const bucketsOf = (k) => (k <= 2 ? '0-2' : k <= 6 ? '3-6' : k <= 12 ? '7-12' : k <= 25 ? '13-25' : '26+');
const BUCKET_ORDER = ['0-2', '3-6', '7-12', '13-25', '26+'];

function analyze(file) {
  const { refs, turns } = referencesByFile(file);
  let gapsLe = 0, gapsGt = 0; // consecutive-reference gaps vs g*
  const hazard = new Map(); // idle bucket -> {reusedWithinG, total}
  // classifier: predict "cold within g*" when idle > g*, truth = NOT referenced within next g* turns.
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const [, tsRaw] of refs) {
    const ts = [...new Set(tsRaw)].sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i += 1) (ts[i + 1] - ts[i] <= G ? (gapsLe += 1) : (gapsGt += 1));
    // Walk every turn the file is resident (from first reference to session end); idle = turns since last ref.
    const nextRefFrom = (t) => ts.find((x) => x > t); // first reference strictly after t
    for (let t = ts[0]; t <= turns; t += 1) {
      const lastRef = ts.filter((x) => x <= t).at(-1);
      if (lastRef === undefined) continue;
      const idle = t - lastRef;
      if (idle === 0) continue; // the turn it was used; only score idle turns
      const nxt = nextRefFrom(t);
      const reusedWithinG = nxt !== undefined && nxt - t <= G;
      const bk = bucketsOf(idle);
      if (!hazard.has(bk)) hazard.set(bk, { reused: 0, total: 0 });
      const h = hazard.get(bk); h.total += 1; if (reusedWithinG) h.reused += 1;
      // classifier at threshold g*
      const predictCold = idle > G;
      const trulyCold = !reusedWithinG;
      if (predictCold && trulyCold) tp += 1;
      else if (predictCold && !trulyCold) fp += 1;
      else if (!predictCold && trulyCold) fn += 1;
      else tn += 1;
    }
  }
  const prec = tp + fp ? tp / (tp + fp) : 0;
  const rec = tp + fn ? tp / (tp + fn) : 0;
  const acc = tp + fp + tn + fn ? (tp + tn) / (tp + fp + tn + fn) : 0;
  return {
    name: basename(file).replace('claude-code-', '').replace('.jsonl', ''),
    turns, files: refs.size, gapsLe, gapsGt,
    gapLeShare: gapsLe + gapsGt ? gapsLe / (gapsLe + gapsGt) : 0,
    hazard: BUCKET_ORDER.map((b) => ({ idle: b, p: hazard.get(b) ? hazard.get(b).reused / hazard.get(b).total : null, n: hazard.get(b)?.total ?? 0 })),
    classifier: { tp, fp, tn, fn, precision: prec, recall: rec, accuracy: acc },
  };
}

const files = readdirSync(FIX).filter((f) => /^claude-code-session.*\.jsonl$/.test(f)).sort();
const sessions = files.map((f) => analyze(join(FIX, f)));
// pooled hazard
const pooled = new Map();
for (const s of sessions) for (const h of s.hazard) { if (h.p === null) continue; const e = pooled.get(h.idle) ?? { reused: 0, total: 0 }; e.reused += h.p * h.n; e.total += h.n; pooled.set(h.idle, e); }
const pooledHazard = BUCKET_ORDER.map((b) => ({ idle: b, p: pooled.get(b) ? pooled.get(b).reused / pooled.get(b).total : null, n: pooled.get(b)?.total ?? 0 }));
const cls = sessions.reduce((a, s) => ({ tp: a.tp + s.classifier.tp, fp: a.fp + s.classifier.fp, tn: a.tn + s.classifier.tn, fn: a.fn + s.classifier.fn }), { tp: 0, fp: 0, tn: 0, fn: 0 });
const pooledCls = { ...cls, precision: cls.tp / (cls.tp + cls.fp || 1), recall: cls.tp / (cls.tp + cls.fn || 1), accuracy: (cls.tp + cls.tn) / (cls.tp + cls.fp + cls.tn + cls.fn || 1) };

const results = { experiment: 'Tier 1 / idle-predicts-cold (LRU-at-g* signal validation)', date: new Date().toISOString(), g_star: G, sessions, pooledHazard, pooledClassifier: pooledCls,
  caveats: [
    'OFFLINE signal validation only — tests whether backward idle predicts forward cold. Does NOT test task success or cost; that is Tier 2 (live).',
    'A "reference" is a Read or Edit of a file; turn clock = assistant model calls. File granularity (not sub-file ranges).',
    'These fixtures largely fit the window (not the extreme-overflow corpus); the reuse structure in a stressed session may differ.',
  ] };
writeFileSync(join(OUT, 'results-tier1.json'), JSON.stringify(results, null, 2));

const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
const hz = (rows) => rows.map((h) => `${h.idle}: ${pct(h.p)} (n=${h.n})`).join('  ·  ');
const sRows = sessions.map((s) => `| ${s.name} | ${s.turns} | ${s.files} | ${pct(s.gapLeShare)} | ${pct(s.classifier.precision)} | ${pct(s.classifier.recall)} | ${pct(s.classifier.accuracy)} |`).join('\n');
const md = `# Tier 1 — does backward idle predict forward cold? (LRU-at-g\\* signal)

**Question:** the eviction rule LRU-at-g\\* drops a file reference once it has been idle > g\\* = ${G} turns
(the cache break-even w/r). That uses a trivially-countable backward signal (turns since last use) as a
proxy for the unknowable forward question (reused soon?). Does the proxy hold on real transcripts? This
validates the SIGNAL only — task-success/cost is Tier 2. Rerun: \`node experiments/context-dedup/tier1-idle-predicts-cold.mjs\`.

## Reuse-gap structure & classifier ("idle > g\\* ⇒ cold within g\\*")
| session | turns | files | gaps ≤ g\\* | precision | recall | accuracy |
|---|---|---|---|---|---|---|
${sRows}

- **precision** = of references the rule would evict, the share genuinely not reused within g\\* (few needless re-fetches).
- **recall** = of the genuinely-cold references, the share the rule catches.

## Hazard curve — P(reused within g\\* | current idle = k), pooled
${hz(pooledHazard)}

**Reading it:** if P(reuse) falls as idle grows — and is low by the time idle passes g\\* — then long idle
predicts cold and LRU-at-g\\* is a sound proxy. A flat curve would falsify it. Pooled classifier:
precision ${pct(pooledCls.precision)}, recall ${pct(pooledCls.recall)}, accuracy ${pct(pooledCls.accuracy)}.

${results.caveats.map((c) => `- ${c}`).join('\n')}
`;
writeFileSync(join(OUT, 'report-tier1-idle-predicts-cold.md'), md);
console.log(`Tier 1 (g*=${G}). Pooled hazard P(reused within g* | idle):`);
console.log('  ' + hz(pooledHazard));
console.log(`  classifier: precision ${pct(pooledCls.precision)}  recall ${pct(pooledCls.recall)}  accuracy ${pct(pooledCls.accuracy)}`);
for (const s of sessions) console.log(`  ${s.name}: gaps≤g* ${pct(s.gapLeShare)}  precision ${pct(s.classifier.precision)}  recall ${pct(s.classifier.recall)}`);
console.log(`Wrote results-tier1.json, report-tier1-idle-predicts-cold.md → ${OUT}`);
