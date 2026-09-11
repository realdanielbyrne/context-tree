/**
 * ============================================================================
 * EVICTION EXPERIMENT — causal test of the assembler eviction defaults
 * ============================================================================
 * Synthetic NON-MONOTONIC coding task on the local model, with faithful tool
 * calls. Define parse_ts/fmt_ts early (tsutil.py), do 6 filler modules that
 * overflow a modest history budget, then build report.py that needs the EARLY
 * tsutil signature again (the H1 return). One variable = the eviction policy.
 *
 * ARMS (same task, same budget, same model):
 *   none      — no eviction (full history; upper bound on success, highest tokens)
 *   recency   — keep pinned + most-recent units to budget (naive)
 *   priority  — recorded defaults D-EV2..4: priority-dominant + recency + refrec,
 *               relevance≈0 (keep the early tsutil unit because it wrote a file)
 *
 * MEASURE: task success (report.py prints 02:02:03), total prompt_tokens (the
 *   re-send / quadratic cost eviction targets), peak history tokens, and re-reads
 *   of tsutil.py (recovery overhead when a policy dropped it).
 *
 * PREDICTION (recorded defaults): recency drops the dormant early tsutil → the
 *   agent must re-read it or fails; priority keeps it → success at lower re-read cost.
 *   A null (no difference) is a real result about the defaults on a live task.
 *
 * RERUN: node experiments/coding-harness/eviction-experiment.mjs
 * ============================================================================
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent, makeWorkspace, evictRecency, evictPriority, estTokens, extractUnits, MODEL } from './lib.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const BUDGET = 3500, MAXTURNS = 60;

// Seed substantial reference files (deterministic large read results) so history
// overflows the budget; r1.py documents the timestamp spec the late step depends on.
function seedRefs(ws) {
  const funcs = (p) => Array.from({ length: 8 }, (_, k) => `def ${p}_op${k}(x):\n    """Utility ${p} operation ${k}: fold a small transform over the input and return it."""\n    total = x\n    for i in range(${k + 1}):\n        total = total + i * ${k + 1}\n    return total\n`).join('\n');
  const spec = `"""Project reference conventions.\nTIMESTAMP FORMAT: timestamps are strings 'HH:MM:SS' (24-hour, zero-padded).\nThe canonical helpers are parse_ts(s) -> total integer seconds, and\nfmt_ts(n) -> the zero-padded 'HH:MM:SS' string for n seconds. Always follow this."""\n`;
  for (let i = 1; i <= 6; i++) writeFileSync(join(ws, `r${i}.py`), (i === 1 ? spec : `"""Reference module r${i}: assorted helpers used across the project."""\n`) + '\n' + funcs('r' + i));
}
const SYSTEM = 'You are a coding agent in a workspace. Use the tools to read, write, and run code. Do the task step by step, verify each step by running code, and when the final check passes reply with a short final message containing DONE and no tool call. Keep going until the task is complete.';
const TASK = `Build a Python toolkit, one step at a time, in this exact order, verifying each step by running code:
1. Read r1.py, then r2.py, r3.py, r4.py, r5.py, and r6.py to learn the project's existing conventions.
2. Create tsutil.py with parse_ts and fmt_ts EXACTLY as documented in r1.py (the 'HH:MM:SS' <-> integer-seconds convention). Run a check that parse_ts('00:01:00') == 60.
3. Create SIX new utility modules m1.py..m6.py. Each must import parse_ts and fmt_ts from tsutil and define one function that uses them (e.g. round-trips a timestamp); after creating each one, run a quick check that calls that function.
4. Create report.py that imports parse_ts and fmt_ts from tsutil, computes fmt_ts(parse_ts('01:02:03') + 3600), and prints it. Run report.py. The correct output is 02:02:03.
When report.py prints 02:02:03, reply DONE.`;

function makeHook(policy, track) {
  return (messages) => {
    const before = estTokens(messages);
    let fired = false;
    if (policy === 'recency') fired = evictRecency(messages, BUDGET);
    else if (policy === 'priority') fired = evictPriority(messages, BUDGET);
    track.peak = Math.max(track.peak, before);
    if (fired) track.evictions++;
    // did tsutil's content survive in context right now?
    track.tsutilPresentLast = messages.some((m) => (m.content || '').includes('def parse_ts'));
  };
}

async function runArm(policy) {
  const ws = makeWorkspace();
  seedRefs(ws);
  const track = { peak: 0, evictions: 0, tsutilPresentLast: true };
  const hook = policy === 'none' ? (m) => { track.peak = Math.max(track.peak, estTokens(m)); } : makeHook(policy, track);
  const r = await runAgent({ system: SYSTEM, task: TASK, ws, maxTurns: MAXTURNS, think: false, hook });
  // ground-truth success
  let printed = '';
  try { printed = execSync('python3 report.py', { cwd: ws, timeout: 10000 }).toString().trim(); } catch (e) { printed = 'ERR:' + (e.stderr?.toString() || e.message).slice(0, 100); }
  const success = printed.includes('02:02:03');
  const tsutilReads = r.toolLog.filter((t, i) => t.name === 'read_file' && /tsutil/.test(JSON.stringify(t.args)) && i > 3).length;
  const totalPromptTokens = r.usage.reduce((s, u) => s + (u.prompt_tokens || 0), 0);
  const filesMade = (() => { try { return execSync(`ls *.py`, { cwd: ws }).toString().trim().split(/\s+/); } catch { return []; } })();
  return { policy, success, printed, turns: r.turns, stop: r.stop, evictions: track.evictions, peak_history_tokens: track.peak, total_prompt_tokens: totalPromptTokens, tsutil_rereads: tsutilReads, ts_present_at_end: track.tsutilPresentLast, files: filesMade, ws };
}

async function main() {
  const arms = [];
  for (const policy of ['none', 'recency', 'priority']) {
    console.error(`\n--- arm: ${policy} (budget ${BUDGET}) ---`);
    arms.push(await runArm(policy));
  }
  const out = {
    manifest: {
      run_id: `eviction-${Date.now()}`, experiment: 'coding-harness / eviction (non-monotonic causal test)',
      model: MODEL, budget: BUDGET, maxTurns: MAXTURNS, task: 'non-monotonic tsutil→filler→report', thinking: false, n_per_arm: 1,
      eviction_defaults: 'priority = 2·prio + 1·recency + 0.5·refrec, relevance 0 (D-EV2..4)',
      commit: gitSha(), date: nowISO(),
      caveats: ['n=1 per arm, temp 0 — directional; agent path can vary run to run.', 'Budget 5000 (policy test), not the 262K ceiling.', 'Re-reading a dropped file is CORRECT recovery — cost shows as tokens/turns, not always failure.'],
    },
    arms: arms.map(({ ws, ...a }) => a),
  };
  const path = writeResults('coding-harness', 'results-eviction.json', out);
  console.error('\n=== EVICTION EXPERIMENT ===  [success | turns | evict | peakTok | totalPromptTok | tsutil-rereads | ts@end]');
  for (const a of out.arms) console.error(`  ${a.policy.padEnd(9)} ${a.success ? 'PASS' : 'FAIL'}  turns=${a.turns}  evict=${a.evictions}  peak=${a.peak_history_tokens}  totalPrompt=${a.total_prompt_tokens}  rereads=${a.tsutil_rereads}  ts@end=${a.ts_present_at_end}  (printed ${JSON.stringify(a.printed.slice(0, 20))})`);
  console.error(`\n  written: ${path}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
