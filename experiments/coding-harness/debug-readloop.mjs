/**
 * DEBUG (systematic-debugging Phase 1): reproduce + instrument the read-loop.
 * Runs one arm at the tight budget that triggers the loop, capturing per turn:
 * the tool call + args, the assistant's own text, and the post-eviction context
 * (unit count, tokens, which files are still "known"). No fix — evidence only.
 * RERUN: node experiments/coding-harness/debug-readloop.mjs [--budget 2500] [--policy priority] [--maxturns 30]
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent, makeWorkspace, evictRecency, evictPriority, estTokens, extractUnits } from './lib.mjs';

const argv = process.argv.slice(2);
const av = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const BUDGET = +av('--budget', '2500'), POLICY = av('--policy', 'priority'), MAXTURNS = +av('--maxturns', '30');
const DETHRASH = argv.includes('--dethrash');
const SUMMARIZE = argv.includes('--summarize');

function seedRefs(ws) {
  const funcs = (p) => Array.from({ length: 8 }, (_, k) => `def ${p}_op${k}(x):\n    """op ${k}."""\n    total = x\n    for i in range(${k + 1}):\n        total = total + i * ${k + 1}\n    return total\n`).join('\n');
  const spec = `"""TIMESTAMP FORMAT: 'HH:MM:SS' (24h). parse_ts(s)->int seconds; fmt_ts(n)->'HH:MM:SS'."""\n`;
  for (let i = 1; i <= 6; i++) writeFileSync(join(ws, `r${i}.py`), (i === 1 ? spec : `"""ref r${i}."""\n`) + '\n' + funcs('r' + i));
}
const SYSTEM = 'You are a coding agent in a workspace. Use tools to read, write, run code. Do the task step by step, verify each step, and when the final check passes reply with a short message containing DONE and no tool call.';
const TASK = `Build a Python toolkit in order, verifying each step:
1. Read r1.py..r6.py to learn conventions.
2. Create tsutil.py with parse_ts and fmt_ts per r1.py. Check parse_ts('00:01:00')==60.
3. Create m1.py..m6.py, each importing parse_ts/fmt_ts from tsutil and using them; check each.
4. Create report.py importing from tsutil, print fmt_ts(parse_ts('01:02:03')+3600) (correct: 02:02:03). Run it, then reply DONE.`;

async function main() {
  const ws = makeWorkspace();
  seedRefs(ws);
  const trace = [];
  const hook = (messages, turn) => {
    const before = estTokens(messages);
    let fired = false;
    if (POLICY === 'recency') fired = evictRecency(messages, BUDGET);
    else if (POLICY === 'priority') fired = evictPriority(messages, BUDGET);
    const { units } = extractUnits(messages);
    const filesKnown = new Set(); for (const m of messages) for (const w of (m.content || '').matchAll(/\b([a-z0-9]+\.py)\b/g)) filesKnown.add(w[1]);
    const lastAsst = [...messages].reverse().find((m) => m.role === 'assistant');
    trace.push({ turn, tokBefore: before, evicted: fired, tokAfter: estTokens(messages), units: units.length, filesKnown: [...filesKnown], lastAsstText: (lastAsst?.content || '').slice(0, 120) });
  };
  const r = await runAgent({ system: SYSTEM, task: TASK, ws, maxTurns: MAXTURNS, think: false, hook, dethrash: DETHRASH, summarizeReads: SUMMARIZE });
  let printed = ''; try { printed = execSync('python3 report.py', { cwd: ws, timeout: 10000 }).toString().trim(); } catch (e) { printed = 'ERR'; }
  const success = printed.includes('02:02:03');
  console.error(`\nSUCCESS=${success} dethrash=${DETHRASH} summarize=${SUMMARIZE} turns=${r.turns} stop=${r.stop} breakouts=${r.breakouts} (report.py printed ${JSON.stringify(printed.slice(0, 20))})`);

  // tool-call sequence with args (the loop is visible here)
  const seq = r.toolLog.map((t) => `${t.name}(${JSON.stringify(t.args).slice(0, 60)})`);
  // detect repetition: most-repeated (name+args)
  const counts = {}; for (const s of seq) counts[s] = (counts[s] || 0) + 1;
  const topRepeat = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);

  console.error(`policy=${POLICY} budget=${BUDGET} turns=${r.turns} stop=${r.stop}`);
  console.error('\nTOOL-CALL SEQUENCE:'); seq.forEach((s, i) => console.error(`  ${String(i).padStart(2)} ${s}`));
  console.error('\nMOST-REPEATED CALLS:'); for (const [s, n] of topRepeat) console.error(`  ${n}×  ${s}`);
  console.error('\nPER-TURN CONTEXT (turn | evicted | units | tok | filesKnown):');
  for (const t of trace) console.error(`  t${String(t.turn).padStart(2)} ev=${t.evicted ? 'Y' : '.'} u=${t.units} tok=${t.tokAfter} known=[${t.filesKnown.join(',')}]`);
  const out = join('/tmp', `readloop-trace-${POLICY}-${BUDGET}.json`);
  writeFileSync(out, JSON.stringify({ budget: BUDGET, policy: POLICY, turns: r.turns, stop: r.stop, seq, topRepeat, trace, finalMessages: r.messages.map((m) => ({ role: m.role, content: (m.content || '').slice(0, 200), tool_calls: (m.tool_calls || []).map((tc) => `${tc.function.name}(${tc.function.arguments})`) })) }, null, 2));
  console.error(`\nfull trace: ${out}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
