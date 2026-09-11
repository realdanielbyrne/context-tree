/**
 * ============================================================================
 * FOLLOW-UP: does topic-shift's boundary RANKING beat tool-phase at coarse K?
 * ============================================================================
 *
 * The D1 run (report-online-segmentation.md) matched both arms at 180 boundaries,
 * where both over-cut and tied (F1 ~0.18). But topic-shift has one structural edge
 * the flat metric can't reward: it RANKS boundaries by drift strength, so it can
 * emit a FEW high-confidence cuts — whereas tool-phase treats every tool transition
 * as equal and has no way to pick its "best K". This tests exactly that:
 *
 *   topic-shift@v1  → precision of its TOP-K drift boundaries (K = 8, 16, 32)
 *   tool-phase@v1   → precision over a random sample of its (unranked) boundaries
 *                     [K-invariant: with no ranking, its best-K == its average]
 *   base rate       → oracle shift-rate at interior positions (floor)
 *
 * Same corpus / oracle / confound controls as the D1 run (imported, no drift).
 * PRE-REGISTERED: ranking HELPS iff topic-shift P@16 >= tool-phase P + 0.10.
 *   (If topic's top boundaries are drift spikes that aren't topic shifts, P@K stays
 *    near tool-phase — ranking buys nothing.)
 *
 * RERUN: node experiments/online-segmentation/strength-ranked-segmentation.mjs
 * ============================================================================
 */
import { makeEmbedder } from '../rung-0e-retrievers/lib.mjs';
import { writeResults, gitSha, nowISO, MODEL } from '../rung-1-live-probe/lib.mjs';
import { parseTurns, toolPhaseBoundaries, topicShiftScores, oracleLabel } from './online-segmentation.mjs';

const K_LIST = [8, 16, 32];
const TOOL_SAMPLE = 40, INTERIOR_SAMPLE = 24, SEED = 1234;
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rng = mulberry32(SEED);
const sample = (arr, n) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };

async function main() {
  const turns = parseTurns();
  const N = turns.length;
  const valid = (p) => p >= 3 && p <= N - 3;
  const emb = await makeEmbedder();
  if (!emb.ok) throw new Error('MiniLM needed: ' + emb.reason);

  const z = await topicShiftScores(turns, emb.embed);
  const orderedTopic = z.map((v, i) => [i, v]).filter(([i]) => i >= 1 && valid(i)).sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const topicTop = orderedTopic.slice(0, Math.max(...K_LIST));      // top-32, sliceable to 8/16
  const tool = [...toolPhaseBoundaries(turns)].filter(valid);
  const toolSample = sample(tool, TOOL_SAMPLE);
  const interior = turns.map((t, i) => i).filter((p) => valid(p) && !new Set(tool).has(p) && !new Set(topicTop).has(p));
  const interiorSample = sample(interior, INTERIOR_SAMPLE);

  const toLabel = [...new Set([...topicTop, ...toolSample, ...interiorSample])];
  console.error(`turns:${N} | labeling ${toLabel.length} positions (topic-top${topicTop.length} + tool${toolSample.length} + interior${interiorSample.length})`);
  const labels = {}; let done = 0;
  for (const p of toLabel) { labels[p] = await oracleLabel(turns, p, false); process.stderr.write(labels[p] === 'shift' ? '|' : '.'); if (++done % 40 === 0) process.stderr.write(` ${done}\n`); }
  process.stderr.write('\n');

  const rate = (ps) => ps.length ? +(ps.filter((p) => labels[p] === 'shift').length / ps.length).toFixed(4) : 0;
  const topic_at_k = Object.fromEntries(K_LIST.map((K) => [`P@${K}`, rate(topicTop.slice(0, K))]));
  const tool_p = rate(toolSample);
  const base_rate = rate(interiorSample);
  const ranking_helps = topic_at_k['P@16'] >= tool_p + 0.10;

  const out = {
    manifest: {
      run_id: `strength-ranked-${Date.now()}`, experiment: 'online-segmentation / strength-ranked (topic-shift ranking vs tool-phase at coarse K)',
      arms: { topic: 'topic-shift@v1 top-K by drift', tool: 'tool-phase@v1 random-K (unranked)' },
      model: MODEL, oracle: 'local model SAME/DIFFERENT, blind, tool-stripped, thinking off, temp 0',
      corpus: 'claude-code-session-2.jsonl', turns: N, K_list: K_LIST, tool_sample: TOOL_SAMPLE, interior_sample: INTERIOR_SAMPLE, seed: SEED,
      commit: gitSha(), date: nowISO(),
      falsification: 'ranking helps iff topic-shift P@16 >= tool-phase P + 0.10',
      caveats: ['n small, directional; base rate of shifts is low (coherent session).', 'tool-phase precision is K-invariant (unranked) — a random sample estimates it.', 'Same single-27B thinking-off oracle as the D1 run.'],
    },
    topic_shift_precision_at_k: topic_at_k,
    tool_phase_precision: tool_p,
    base_rate_interior: base_rate,
    verdict: { ranking_helps, topic_best: Math.max(...Object.values(topic_at_k)), tool: tool_p },
  };
  const path = writeResults('online-segmentation', 'results-strength-ranked.json', out);

  console.error('\n=== STRENGTH-RANKED (topic-shift ranking vs tool-phase) ===');
  console.error(`  topic-shift  ${K_LIST.map((K) => `P@${K}=${topic_at_k['P@' + K]}`).join('  ')}`);
  console.error(`  tool-phase   P=${tool_p} (unranked, K-invariant)`);
  console.error(`  interior base rate=${base_rate}`);
  console.error(`  VERDICT ranking helps (topic P@16 >= tool P + .10): ${ranking_helps}`);
  console.error(`  written: ${path}`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('FATAL', e); process.exit(1); });
