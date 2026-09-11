/**
 * ============================================================================
 * EXPERIMENT: assembler eviction — how to WEIGHT the incoming signals
 * ============================================================================
 * Isolates the cache-assembler/ejector. One variable: the weights on the eviction
 * signals. Signal extraction is shared with the LR refinement via ./lib.mjs (no
 * drift). OFFLINE, no model — keep-needed recall is a fingerprint fact.
 *
 * Non-degeneracy: eviction decides at t−1 from 0..t−1, "needed" is the unseen t;
 * a unit dormant in the recent window but referenced at t (H1) decides the weights.
 * Signals (min-max normalized per turn): rec recency · rel relevance-to-recent ·
 * prio priority(recurrence) · refrec reference-recency(inverse dormancy).
 * Metric: keep-needed recall @ budget M, overall and on the NON-MONOTONIC subset.
 * PRE-REGISTERED: a signal earns weight iff it lifts recall (esp. non-monotonic)
 *   over recency-only by >=0.03 at equal M.
 * RERUN: node experiments/assembler-weighting/assembler-weighting.mjs [--session 1|2]
 * ============================================================================
 */
import { buildTurnData, PARAMS } from './lib.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const argv = process.argv.slice(2);
const SESSION_N = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : '2';
const M_LIST = [8, 16, 32, 64];

function main() {
  const { turns, cand, perTurn } = buildTurnData(SESSION_N);
  const NAMED = {
    'recency-only': [1, 0, 0, 0], 'relevance-only': [0, 1, 0, 0], 'priority-only': [0, 0, 1, 0],
    'rel+prio': [0, 1, 1, 0], 'rel+prio+refrec': [0, 1, 1, 1], 'rec+rel+prio+refrec': [0.5, 1, 1, 1],
  };
  const grid = {};
  for (const wrel of [0, 0.5, 1]) for (const wprio of [0, 0.5, 1]) for (const wrefrec of [0, 0.5, 1]) for (const wrec of [0, 0.5, 1]) {
    if (wrel + wprio + wrefrec + wrec === 0) continue;
    grid[`g_${wrec}_${wrel}_${wprio}_${wrefrec}`] = [wrec, wrel, wprio, wrefrec];
  }
  const ARMS = { ...NAMED, ...grid };
  const acc = {}; for (const a of Object.keys(ARMS)) acc[a] = Object.fromEntries(M_LIST.map((M) => [M, { hit: 0, need: 0, nmHit: 0, nmNeed: 0 }]));
  let evalTurns = 0;

  for (const { raw } of perTurn) {
    const needSet = raw.filter((x) => x.neededH);
    if (needSet.length === 0) continue;
    evalTurns++;
    for (const [a, [wr, wl, wp, wf]] of Object.entries(ARMS)) {
      const scored = raw.map((x) => [x.u, wr * x.rec + wl * x.relN + wp * x.prioN + wf * x.refrec]).sort((p, q) => q[1] - p[1]);
      for (const M of M_LIST) {
        const kept = new Set(scored.slice(0, M).map(([u]) => u));
        for (const x of needSet) { acc[a][M].need++; if (kept.has(x.u)) acc[a][M].hit++; if (x.dormant) { acc[a][M].nmNeed++; if (kept.has(x.u)) acc[a][M].nmHit++; } }
      }
    }
  }

  const rows = {};
  for (const a of Object.keys(ARMS)) rows[a] = Object.fromEntries(M_LIST.map((M) => { const c = acc[a][M]; return [M, { recall: +(c.hit / (c.need || 1)).toFixed(4), nonmono_recall: +(c.nmHit / (c.nmNeed || 1)).toFixed(4) }]; }));
  const base = rows['recency-only'];
  const named = Object.fromEntries(Object.keys(NAMED).map((a) => [a, rows[a]]));
  const bestByM = Object.fromEntries(M_LIST.map((M) => {
    const best = Object.entries(rows).sort((p, q) => q[1][M].recall - p[1][M].recall)[0];
    return [M, { arm: best[0], weights: ARMS[best[0]], recall: best[1][M].recall, nonmono: best[1][M].nonmono_recall, lift_over_recency: +(best[1][M].recall - base[M].recall).toFixed(4) }];
  }));

  const out = {
    manifest: {
      run_id: `assembler-weighting-${Date.now()}`, experiment: 'assembler-weighting / signal weighting sweep',
      corpus: SESSION_N === '1' ? 'claude-code-session.jsonl' : 'claude-code-session-2.jsonl',
      turns: turns.length, fingerprinted_units: cand.length, eval_turns: evalTurns, params: { ...PARAMS, M_LIST }, offline: true, model: null,
      signals: 'rec(recency) rel(relevance-to-recent) prio(priority=recurrence) refrec(reference-recency)',
      ground_truth: 'needed = fingerprint overlap within horizon H (observational identifier overlap, not causal)',
      falsification: 'a signal earns weight iff it lifts keep-needed recall (esp. non-monotonic) over recency-only by >=0.03 at equal M',
      commit: gitSha(), date: nowISO(),
      caveats: ['Ground truth is identifier-overlap (observational), the standing DSA proxy — not causal usefulness.', 'Units = turns (fixed); segmentation not varied here.', 'One session; fingerprint extraction is heuristic.'],
    },
    named_arms: named, best_grid_by_M: bestByM,
  };
  const path = writeResults('assembler-weighting', `results-assembler-weighting${SESSION_N === '1' ? '-s1' : ''}.json`, out);

  console.error(`corpus session-${SESSION_N} | ${turns.length} turns, ${cand.length} fingerprinted units | eval turns ${evalTurns}`);
  console.error('\n=== keep-needed recall (nonmono in parens) by weighting × M ===');
  console.error('arm'.padEnd(22) + M_LIST.map((M) => `M=${M}`.padStart(16)).join(''));
  for (const a of Object.keys(NAMED)) console.error(a.padEnd(22) + M_LIST.map((M) => `${named[a][M].recall.toFixed(2)}(${named[a][M].nonmono_recall.toFixed(2)})`.padStart(16)).join(''));
  console.error('\nbest grid weighting per M [w_rec,w_rel,w_prio,w_refrec]:');
  for (const M of M_LIST) { const b = bestByM[M]; console.error(`  M=${String(M).padEnd(3)} recall=${b.recall} (nonmono ${b.nonmono}) lift_vs_recency=+${b.lift_over_recency}  weights=${JSON.stringify(b.weights)}`); }
  console.error(`\nwritten: ${path}`);
}
main();
