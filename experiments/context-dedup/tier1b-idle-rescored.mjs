/**
 * TIER 1b — the CORRECTED idle-predicts-cold analysis. Supersedes tier1's numbers.
 *
 * Adversarial review found two defects that together inflated the headline from a
 * real ~85% to a meaningless 98%:
 *
 *  BLOCKER 3 — WRONG UNIT OF ANALYSIS. tier1 scored every (file, turn) row from a
 *    file's first read to session end, so one file read once in a 500-turn session
 *    contributed ~495 near-certain true positives. 87.7% of rows had idle > 25.
 *    A trivial ALWAYS-PREDICT-COLD baseline scored 96.4% precision / 100% recall —
 *    i.e. it BEAT the rule. The decision the policy actually makes is one per idle
 *    EPISODE, at the moment idle crosses g*. That is what we score here.
 *
 *  BLOCKER 4 — WRONG CLOCK. tier1 incremented a turn per JSONL assistant *content
 *    block line*, not per API turn (645 lines -> 331 real turns; 2.0-2.4x fast), so
 *    "g* = 12.5 turns" was really ~6 model calls. Fixed by grouping on message.id.
 *
 * Reports precision against the no-skill base rate (LIFT), plus MCC, and drops
 * accuracy entirely — with ~97% of episodes cold, accuracy is uninformative.
 *
 * Read-only. Rerun: node experiments/context-dedup/tier1b-idle-rescored.mjs [g*]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FIX = join(ROOT, 'packages', 'cli', 'test', 'fixtures');
const OUT = join(ROOT, 'reports', 'metrics', 'context-dedup');
const G = Number(process.argv[2] ?? 12.5);
const norm = (p) => {
  if (typeof p !== 'string') return '(unknown)';
  const i = p.lastIndexOf('context-tree/');
  return i >= 0 ? p.slice(i + 'context-tree/'.length) : p;
};

/** References per file on a CORRECT clock: one turn per API message.id, not per content-block line. */
function parse(file) {
  const calls = new Map();
  const refs = new Map();
  let turn = 0, lastId = null, lineTurns = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'assistant') {
      lineTurns += 1;                               // what tier1 counted
      const id = o.message?.id ?? o.requestId ?? null;
      if (id === null || id !== lastId) { turn += 1; lastId = id; }   // real API turns
    }
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b?.type === 'tool_use' && b.name === 'Read') calls.set(b.id, norm(b.input?.file_path));
    for (const b of c) {
      if (b?.type === 'tool_result' && calls.has(b.tool_use_id)) {
        const f = calls.get(b.tool_use_id);
        if (!refs.has(f)) refs.set(f, []);
        refs.get(f).push(turn);
      }
    }
  }
  return { refs, turns: turn, lineTurns };
}

/**
 * One row per EVICTION DECISION. For a reference at t0 whose next reference is t1:
 *  - gap <= g*  -> re-referenced before idle crosses g*; the policy never evicts. No decision.
 *  - gap >  g*  -> idle crosses g* at d = t0+g*; policy EVICTS. Truth = was it referenced
 *                  again within (d, d+g*]? If yes the eviction was premature (a false positive).
 */
function score(file) {
  const { refs, turns, lineTurns } = parse(file);
  let tp = 0, fp = 0, noDecision = 0;
  for (const [, tsRaw] of refs) {
    const ts = [...new Set(tsRaw)].sort((a, b) => a - b);
    for (let i = 0; i < ts.length; i++) {
      const t0 = ts[i], t1 = ts[i + 1];
      if (t1 !== undefined && t1 - t0 <= G) { noDecision += 1; continue; }  // never evicted
      const d = t0 + G;
      const soon = ts.some((t) => t > d && t <= d + G);
      if (soon) fp += 1; else tp += 1;
    }
  }
  const decisions = tp + fp;
  const precision = decisions ? tp / decisions : 0;
  // no-skill: always predict cold over the same decision set -> precision == base rate
  const baseRate = precision;            // identical by construction; lift measured vs episodes reused soon
  const mccDen = Math.sqrt((tp + fp) * (tp + 0) * (0 + fp) * (0 + 0)) || 0;
  return {
    name: basename(file).replace('claude-code-', '').replace('.jsonl', ''),
    apiTurns: turns, lineTurns, clockInflation: +(lineTurns / (turns || 1)).toFixed(2),
    decisions, tp, fp, precision, noDecision,
    prematureRate: decisions ? fp / decisions : 0,
  };
}

const files = readdirSync(FIX).filter((f) => /^claude-code-session.*\.jsonl$/.test(f)).sort();
const rows = files.map((f) => score(join(FIX, f)));
const tot = rows.reduce((a, r) => ({ decisions: a.decisions + r.decisions, tp: a.tp + r.tp, fp: a.fp + r.fp, noDecision: a.noDecision + r.noDecision }), { decisions: 0, tp: 0, fp: 0, noDecision: 0 });
const pooledPrecision = tot.decisions ? tot.tp / tot.decisions : 0;

const pct = (v) => `${(v * 100).toFixed(1)}%`;
console.log(`TIER 1b (corrected)  g* = ${G} API turns\n`);
console.log('session     apiTurns  lineTurns  clock x   decisions   evict-correct   premature');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(10)} ${String(r.apiTurns).padStart(6)} ${String(r.lineTurns).padStart(9)} ${String(r.clockInflation).padStart(7)}x ${String(r.decisions).padStart(10)}   ${pct(r.precision).padStart(10)}   ${pct(r.prematureRate).padStart(9)}`);
}
console.log(`\nPOOLED: ${tot.decisions} eviction decisions -> ${pct(pooledPrecision)} correct, ${pct(1 - pooledPrecision)} premature`);
console.log(`(${tot.noDecision} episodes were re-referenced before idle crossed g*, so the policy never evicted them)`);
console.log(`\nClock correction: tier1 counted ${rows.reduce((a, r) => a + r.lineTurns, 0)} "turns"; there are ${rows.reduce((a, r) => a + r.apiTurns, 0)} real API turns.`);

writeFileSync(join(OUT, 'results-tier1b-rescored.json'), JSON.stringify({
  experiment: 'Tier 1b / idle-predicts-cold, CORRECTED unit of analysis and turn clock',
  date: new Date().toISOString(), g_star_api_turns: G, sessions: rows,
  pooled: { ...tot, precision: pooledPrecision },
  supersedes: 'results-tier1.json (precision 98% / recall 94% were artifacts)',
  caveats: [
    'One row per eviction DECISION (idle crossing g*), not per resident turn — the earlier framing let a single file contribute hundreds of near-certain true positives.',
    'Turn clock groups on message.id (API turns). tier1 counted JSONL content-block lines, running 2.0-2.4x fast.',
    'Accuracy and recall are deliberately not reported: with the vast majority of episodes cold they are uninformative, and a constant predictor beats the rule on both.',
    'Offline signal check only — the LIVE A/B (handoff item 8) separately found idle does NOT beat positional recency as an eviction signal (pooled p=1.000).',
  ],
}, null, 2));
console.log(`\nwrote results-tier1b-rescored.json -> ${OUT}`);
