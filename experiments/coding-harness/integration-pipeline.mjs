/**
 * ============================================================================
 * INTEGRATION: tie the validated pieces into one middleware and stress it
 * ============================================================================
 * Wires together, in one agent loop under a REAL hard window:
 *   - reducer ROUTER  (reducers.mjs; summarize|chunk per query) at tool.execute.after
 *   - priority EVICTION (lib.mjs evictPriority; D-EV defaults) at chat.transform
 * vs the TRUNCATE-TAIL baseline (no reducer + recency eviction). The task forces
 * BOTH failure modes: read 4 large catalogs (each overflows), extract each buried
 * price, sum them (needs ALL four late = non-monotonic), under the 8.2K window,
 * with NO grep escape hatch (read_file + write_file only) so the middleware is the
 * only thing standing between the agent and window overflow / thrashing.
 *
 * The point is not a clean win — it is to SEE WHERE IT WORKS AND BREAKS.
 * Prediction: truncate-tail thrashes / evicts earlier prices → fails; the full
 * pipeline keeps the price spans small enough to all fit → succeeds. Whatever
 * actually happens is the finding.
 *
 * RERUN: CT_LOCAL_MODEL=unsloth/Qwen3.8-Flash-Next-GGUF \
 *        node experiments/coding-harness/integration-pipeline.mjs
 * ============================================================================
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent, makeWorkspace, evictRecency, evictPriority, estTokens, MODEL } from './lib.mjs';
import { REDUCERS } from './reducers.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const BUDGET = 6800; // keep the assembled prompt under the 8192 window (room for question + reply)
const ITEMS = [{ file: 'widget_catalog.md', name: 'Widget', price: 13 }, { file: 'gadget_catalog.md', name: 'Gadget', price: 27 },
  { file: 'gizmo_catalog.md', name: 'Gizmo', price: 41 }, { file: 'doohickey_catalog.md', name: 'Doohickey', price: 58 }];
const TOTAL = ITEMS.reduce((s, i) => s + i.price, 0); // 139

function seed(ws) {
  const secs = ['Overview', 'Specifications', 'Materials', 'Assembly', 'Warranty', 'Compliance', 'Shipping', 'Returns', 'Support', 'Maintenance'];
  const filler = (s, n) => (`The ${s} section of the ${n} catalog details conventions, procedures, and expectations at length. ` +
    `Integrators should review this material and cross-reference parameters. Standard handling applies throughout. `).repeat(15); // ~2.5K tok/doc → 4 docs ~10K >> budget
  for (const it of ITEMS) {
    const lines = [`# ${it.name} Catalog`, ''];
    for (const s of secs) {
      lines.push(`## ${s}`, filler(s, it.name));
      if (s === 'Specifications') lines.push(`Pricing note: the ${it.name} unit price is ${it.price} dollars per unit.`);
      lines.push('');
    }
    writeFileSync(join(ws, it.file), lines.join('\n'));
  }
}

const SYSTEM = 'You are an agent in a workspace with read_file and write_file. Do the task step by step. When finished, reply with a short message containing DONE and no tool call.';
const TASK = `Four catalogs are in the workspace: ${ITEMS.map((i) => i.file).join(', ')}. Read each catalog and find its product's unit price (a number of dollars). Then write ONLY the integer sum of the four unit prices to answer.txt using write_file. Then reply DONE.`;

async function runArm(config) {
  const ws = makeWorkspace(); seed(ws);
  const track = { peak: 0, evictions: 0 };
  const reducer = config === 'full-pipeline' ? REDUCERS.router : REDUCERS.none;
  const hook = (m) => {
    const before = estTokens(m); track.peak = Math.max(track.peak, before);
    const fired = config === 'full-pipeline' ? evictPriority(m, BUDGET) : evictRecency(m, BUDGET);
    if (fired) track.evictions++;
  };
  let err = null, r = null;
  try { r = await runAgent({ system: SYSTEM, task: TASK, ws, maxTurns: 40, reducer, hook, allowedTools: ['read_file', 'write_file'] }); }
  catch (e) { err = String(e.message || e).slice(0, 160); }
  let answer = ''; try { answer = execSync('cat answer.txt', { cwd: ws, timeout: 5000 }).toString().trim(); } catch { answer = '(none)'; }
  const success = /\b139\b/.test(answer);
  const reads = r ? r.toolLog.filter((t) => t.name === 'read_file').length : 0;
  const rereads = r ? reads - new Set(r.toolLog.filter((t) => t.name === 'read_file').map((t) => t.args.path)).size : 0;
  const total = r ? r.usage.reduce((s, u) => s + (u.prompt_tokens || 0), 0) : 0;
  return { config, success, answer: answer.slice(0, 30), turns: r?.turns ?? null, stop: r?.stop ?? 'error', evictions: track.evictions, peak_history_tokens: track.peak, reads, rereads, total_prompt_tokens: total, error: err };
}

async function main() {
  const arms = [];
  for (const config of ['truncate-tail', 'full-pipeline']) { console.error(`\n--- ${config} (window-budget ${BUDGET}) ---`); arms.push(await runArm(config)); }
  const out = {
    manifest: {
      run_id: `integration-${Date.now()}`, experiment: 'coding-harness / integration (full middleware vs truncate-tail, hard window)',
      model: MODEL, window_budget: BUDGET, task: '4-doc read + sum under a hard window, no grep', maxTurns: 40, correct_sum: TOTAL,
      pieces: 'router reducer (tool.execute.after) + priority eviction (chat.transform) + faithful tool loop', commit: gitSha(), date: nowISO(),
      caveats: ['n=1 per arm, temp 0. Weak 8.2K model. Exploratory integration — the goal is to find breaks.', 'read_file+write_file only (no grep) so the middleware is the only defense.'],
    },
    arms,
  };
  const path = writeResults('coding-harness', 'results-integration-pipeline.json', out);
  console.error('\n=== INTEGRATION (full middleware vs truncate-tail) ===  [success | turns | evict | reads | rereads | peakTok | totalTok]');
  for (const a of arms) console.error(`  ${a.config.padEnd(14)} ${a.success ? 'PASS' : 'FAIL'}  turns=${a.turns}  evict=${a.evictions}  reads=${a.reads}  rereads=${a.rereads}  peak=${a.peak_history_tokens}  total=${a.total_prompt_tokens}  ${a.error ? 'ERR=' + a.error : 'ans=' + JSON.stringify(a.answer)}`);
  console.error(`\n  written: ${path}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
