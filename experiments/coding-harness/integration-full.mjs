/**
 * ============================================================================
 * INTEGRATION (best-of-breed): the full middleware in one agent loop
 * ============================================================================
 * Only the validated good stuff, wired together (middleware.mjs):
 *   RETRIEVER  = ensemble RRF(BM25, vector/MiniLM) chunk-retrieve, router-gated
 *   CLASSIFIER = topic-shift dormancy z(lexical)+z(semantic) drift vs recent window
 *   ASSEMBLER  = D-EV priority eviction (priority-dominant + recency, relevance≈0),
 *                dormant-first ejection, recency anchor, reduce-on-overflow
 * vs TRUNCATE-TAIL (raw + recency). Realistic toolset (incl. run_bash), so the
 * model CAN self-retrieve — this asks whether the whole thing works in a realistic
 * agent, and where it breaks. Under the served model's window (8.2K if that model).
 *
 * RERUN: CT_LOCAL_MODEL=unsloth/Qwen3.8-Flash-Next-GGUF \
 *        node experiments/coding-harness/integration-full.mjs
 * ============================================================================
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent, makeWorkspace, evictRecency, estTokens, MODEL } from './lib.mjs';
import { REDUCERS } from './reducers.mjs';
import { makeEmbedder, makeEnsembleReducer, makeAssembler } from './middleware.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const BUDGET = 6800;
const ITEMS = [{ file: 'widget_catalog.md', name: 'Widget', price: 13 }, { file: 'gadget_catalog.md', name: 'Gadget', price: 27 },
  { file: 'gizmo_catalog.md', name: 'Gizmo', price: 41 }, { file: 'doohickey_catalog.md', name: 'Doohickey', price: 58 }];
const TOTAL = ITEMS.reduce((s, i) => s + i.price, 0);

function seed(ws) {
  const secs = ['Overview', 'Specifications', 'Materials', 'Assembly', 'Warranty', 'Compliance', 'Shipping', 'Returns', 'Support', 'Maintenance'];
  const filler = (s, n) => (`The ${s} section of the ${n} catalog details conventions, procedures, and expectations at length. Integrators should review this and cross-reference parameters. `).repeat(15);
  for (const it of ITEMS) {
    const lines = [`# ${it.name} Catalog`, ''];
    for (const s of secs) { lines.push(`## ${s}`, filler(s, it.name)); if (s === 'Specifications') lines.push(`Pricing note: the ${it.name} unit price is ${it.price} dollars per unit.`); lines.push(''); }
    writeFileSync(join(ws, it.file), lines.join('\n'));
  }
}
const SYSTEM = 'You are an agent in a workspace. Use the tools to read files and run commands. Work step by step; when finished reply with a short message containing DONE and no tool call.';
const TASK = `Four catalogs are in the workspace: ${ITEMS.map((i) => i.file).join(', ')}. Read each and find its product unit price. Write ONLY the integer sum of the four prices to answer.txt, then reply DONE.`;

async function runArm(config, embed) {
  const ws = makeWorkspace(); seed(ws);
  const track = { peak: 0, evictions: 0 };
  const reducer = config === 'full' ? makeEnsembleReducer(embed) : REDUCERS.none;
  const evict = config === 'full' ? makeAssembler(embed, BUDGET) : (m) => evictRecency(m, BUDGET);
  const hook = async (m) => { track.peak = Math.max(track.peak, estTokens(m)); if (await evict(m)) track.evictions++; };
  let err = null, r = null;
  try { r = await runAgent({ system: SYSTEM, task: TASK, ws, maxTurns: 40, think: false, reducer, hook }); }
  catch (e) { err = String(e.message || e).slice(0, 160); }
  let answer = ''; try { answer = execSync('cat answer.txt', { cwd: ws, timeout: 5000 }).toString().trim(); } catch { answer = '(none)'; }
  const reads = r ? r.toolLog.filter((t) => t.name === 'read_file').length : 0;
  return { config, success: /\b139\b/.test(answer), answer: answer.slice(0, 30), turns: r?.turns ?? null, stop: r?.stop ?? 'error', evictions: track.evictions, peak_history_tokens: track.peak, reads, total_prompt_tokens: r ? r.usage.reduce((s, u) => s + (u.prompt_tokens || 0), 0) : 0, error: err };
}

async function main() {
  const emb = await makeEmbedder();
  if (!emb.ok) throw new Error('MiniLM needed: ' + emb.reason);
  const arms = [];
  for (const config of ['truncate-tail', 'full']) { console.error(`\n--- ${config} ---`); arms.push(await runArm(config, emb.embed)); }
  const out = {
    manifest: {
      run_id: `integration-full-${Date.now()}`, experiment: 'coding-harness / integration-full (best-of-breed middleware)',
      model: MODEL, window_budget: BUDGET, correct_sum: TOTAL,
      pieces: 'ensemble RRF(bm25,vector) reducer + drift-dormancy classifier + D-EV priority eviction; realistic toolset', commit: gitSha(), date: nowISO(),
      caveats: ['n=1 per arm, temp 0. Realistic toolset (model can self-retrieve via run_bash).', 'Exploratory integration — goal is to find breaks.'],
    }, arms,
  };
  const path = writeResults('coding-harness', 'results-integration-full.json', out);
  console.error('\n=== INTEGRATION-FULL (best-of-breed vs truncate-tail) ===  [success | turns | evict | reads | peakTok | totalTok]');
  for (const a of arms) console.error(`  ${a.config.padEnd(14)} ${a.success ? 'PASS' : 'FAIL'}  turns=${a.turns}  evict=${a.evictions}  reads=${a.reads}  peak=${a.peak_history_tokens}  total=${a.total_prompt_tokens}  ${a.error ? 'ERR=' + a.error : 'ans=' + JSON.stringify(a.answer)}`);
  console.error(`  written: ${path}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
