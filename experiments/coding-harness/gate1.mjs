/**
 * GATE 1 — faithful tool loop. Proves the agentic loop drives real tool calls
 * end-to-end against the local model, tool_calls round-trip cleanly, and no
 * tool_call is left without a tool result. Trivial task; not a hypothesis test.
 * RERUN: node experiments/coding-harness/gate1.mjs
 */
import { execSync } from 'node:child_process';
import { runAgent, makeWorkspace, MODEL } from './lib.mjs';

const SYSTEM = 'You are a coding agent working in a workspace. Use the provided tools to read, write, and run code. Do the task, verify it by running code, and when the check passes, reply with a short final message (no tool call) that says DONE.';
const TASK = 'Create a file `add.py` containing a function `add(a, b)` that returns a + b. Then run a shell command that imports it and prints add(2, 3). Confirm the printed value is 5, then finish.';

async function main() {
  const ws = makeWorkspace();
  console.error(`workspace: ${ws}`);
  const r = await runAgent({ system: SYSTEM, task: TASK, ws, maxTurns: 12 });

  // fidelity assertions
  const asstWithCalls = r.messages.filter((m) => m.role === 'assistant' && m.tool_calls?.length);
  const toolResults = r.messages.filter((m) => m.role === 'tool');
  const nCalls = asstWithCalls.reduce((s, m) => s + m.tool_calls.length, 0);
  const everyCallAnswered = nCalls === toolResults.length && r.messages.filter((m) => m.role === 'tool' && !m.tool_call_id).length === 0;

  // task check (ground truth)
  let printed = null;
  try { printed = execSync('python3 -c "from add import add; print(add(2,3))"', { cwd: ws, timeout: 10000 }).toString().trim(); } catch (e) { printed = 'ERR:' + (e.stderr?.toString() || e.message).slice(0, 120); }
  const taskPass = printed === '5';

  console.error('\n=== GATE 1 ===');
  console.error(`  model: ${MODEL} | turns: ${r.turns} | stop: ${r.stop}`);
  console.error(`  tool calls: ${nCalls} | tool results: ${toolResults.length} | every call answered: ${everyCallAnswered}`);
  console.error(`  tool log: ${r.toolLog.map((t) => t.name).join(' → ')}`);
  console.error(`  add(2,3) prints: ${JSON.stringify(printed)} | task pass: ${taskPass}`);
  console.error(`  total prompt_tokens across turns: ${r.usage.reduce((s, u) => s + (u.prompt_tokens || 0), 0)}`);
  console.error(`\n  GATE 1 ${everyCallAnswered && taskPass ? 'PASS' : 'FAIL'} (fidelity=${everyCallAnswered}, task=${taskPass})`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
