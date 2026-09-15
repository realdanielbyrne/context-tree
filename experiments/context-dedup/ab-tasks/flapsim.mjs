/**
 * Task adapter for the `flapsim` scenario (experiments/scenarios/flapsim/).
 *
 * The prompts, seed files and turn gates are DATA and live in the scenario. This file
 * carries only the GRADER, because grading is experiment-specific while the workload
 * is not — another experiment can drive the same scenario with a different grader.
 *
 * Grading is held-out: a reference implementation is written into the workspace at
 * grade time and both programs are run with identical argv, stdout compared. The
 * agent never sees the held-out cases, and they share no (seed, ticks, flaps) triple
 * with the worked examples in spec/08, so hardcoding the examples scores ~0 on core.
 *
 * Five parts, reported separately, so we can see WHICH phase an arm damages:
 *   core     12  held-out score/alive
 *   trace     8  byte-exact stdout on held-out cases
 *   feature  10  --powerups behaviour + the no-flag regression requirement
 *   review    4  REVIEW.md cites real file:line
 *   docs      6  GETTING_STARTED.md quotes real signatures and real output
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarioTask } from '../../scenarios/load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REF = join(HERE, '..', '..', 'scenarios', 'flapsim', 'grader', 'ref.py');

/** Held-out — disjoint from spec/08_examples.md by construction (asserted in tests). */
const CORE = [[13, 200, '0010'], [17, 160, '0001'], [23, 200, '0010'], [4, 80, '01'], [29, 200, '0001'], [6, 120, '0']];
const TRACE = [[13, 200, '0010'], [17, 160, '0001']];
const FEATURE = [[13, 200, '0010'], [23, 200, '0001'], [29, 200, '0010'], [17, 160, '0001']];
const DEMO = ['--seed', '7', '--ticks', '200', '--flaps', '0010'];

const run = (cwd, script, args) => {
  try { return execSync(`python3 ${script} ${args.join(' ')}`, { cwd, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
  catch { return null; }
};
const digest = (out) => {
  if (!out) return null;
  const m = out.trim().split('\n').find((l) => l.startsWith('DIGEST'));
  if (!m) return null;
  const g = (k) => { const x = m.match(new RegExp(`${k}=(-?\\+?\\d+)`)); return x ? x[1] : null; };
  return { score: g('score'), alive: g('alive'), shields: g('shields') };
};

function score(ws) {
  const parts = { core: 0, trace: 0, feature: 0, review: 0, docs: 0 };
  mkdirSync(join(ws, '_grade'), { recursive: true });
  writeFileSync(join(ws, '_grade', 'ref.py'), readFileSync(REF, 'utf8'));
  const ref = (args) => run(ws, '_grade/ref.py', args);
  const agent = (args) => run(ws, 'flapsim.py', args);

  for (const [s, t, f] of CORE) {
    const a = digest(agent(['--seed', s, '--ticks', t, '--flaps', f]));
    const r = digest(ref(['--seed', s, '--ticks', t, '--flaps', f]));
    if (!a || !r) continue;
    if (a.score === r.score) parts.core += 1;
    if (a.alive === r.alive) parts.core += 1;
  }
  for (const [s, t, f] of TRACE) {
    const a = agent(['--seed', s, '--ticks', t, '--flaps', f]);
    const r = ref(['--seed', s, '--ticks', t, '--flaps', f]);
    if (!a || !r) continue;
    const al = a.trim().split('\n'), rl = r.trim().split('\n');
    const matched = rl.filter((line, i) => al[i] === line).length;
    parts.trace += Math.floor(4 * matched / Math.max(1, rl.length));
  }
  for (const [s, t, f] of FEATURE) {
    const a = digest(agent(['--seed', s, '--ticks', t, '--flaps', f, '--powerups']));
    const r = digest(ref(['--seed', s, '--ticks', t, '--flaps', f, '--powerups']));
    if (!a || !r) continue;
    if (a.score === r.score) parts.feature += 1;
    if (a.shields !== null && a.shields === r.shields) parts.feature += 1;
  }
  // the regression requirement: --powerups ABSENT must be unchanged
  const plain = agent(DEMO), refPlain = ref(DEMO);
  if (plain && refPlain && plain === refPlain) parts.feature += 1;
  try { if (plain && readFileSync(join(ws, 'replay.txt'), 'utf8').trim() === plain.trim()) parts.feature += 1; } catch {}

  // REVIEW.md — must cite real file:line
  try {
    const rv = readFileSync(join(ws, 'REVIEW.md'), 'utf8');
    const ents = [...rv.matchAll(/^\s*-\s*([\w./]+\.py):(\d+)\s+(.+?)\s*->\s*(.+)$/gm)];
    if (ents.length >= 3) parts.review += 1;
    if (ents.length && ents.every((e) => existsSync(join(ws, e[1])))) parts.review += 1;
    const real = ents.filter((e) => {
      try { const L = readFileSync(join(ws, e[1]), 'utf8').split('\n'); const n = +e[2];
            return n >= 1 && n <= L.length && L[n - 1].trim().length > 0; } catch { return false; }
    }).length;
    if (real >= 2) parts.review += 2; else if (real === 1) parts.review += 1;
  } catch {}

  // GETTING_STARTED.md — must quote real output and real signatures
  try {
    const gs = readFileSync(join(ws, 'GETTING_STARTED.md'), 'utf8');
    if (/flapsim\.py\s+--seed\s+7\s+--ticks\s+200\s+--flaps\s+0010/.test(gs)) parts.docs += 1;
    if (plain) {
      const dg = plain.trim().split('\n').find((l) => l.startsWith('DIGEST'));
      if (dg && gs.includes(dg)) parts.docs += 2;
    }
    const mods = ['units.py', 'physics.py', 'world.py', 'collide.py', 'engine.py', 'flapsim.py'];
    if (mods.every((m) => gs.includes(m))) parts.docs += 1;
    const defs = [...gs.matchAll(/^\s*(def\s+\w+\([^)]*\):)/gm)].map((m) => m[1].trim());
    const verbatim = defs.filter((d) => mods.some((m) => {
      try { return readFileSync(join(ws, m), 'utf8').includes(d); } catch { return false; }
    })).length;
    parts.docs += Math.min(2, verbatim >= 4 ? 2 : verbatim >= 2 ? 1 : 0);
  } catch {}

  const correct = Object.values(parts).reduce((a, b) => a + b, 0);
  return { correct, total: 40, parts };
}

/**
 * PROGRESS LADDER. Without context-tree machinery a long task eventually exhausts the
 * window and simply fails, so pass/fail throws away the thing we actually care about:
 * HOW FAR it got before the wall. This is a monotone ladder over workspace artifacts,
 * so a run that dies mid-way is still measured rather than scored 0 and discarded.
 */
const PHASES = [
  ['start', () => true],
  ['modules-started', (ws) => readdirSync(ws).some((f) => f.endsWith('.py') && f !== 'test_flapsim.py')],
  ['modules-complete', (ws) => ['units.py', 'physics.py', 'world.py', 'collide.py', 'engine.py', 'flapsim.py'].every((m) => existsSync(join(ws, m)))],
  ['selfcheck-runs', (ws) => !!run(ws, 'flapsim.py', ['--selfcheck'])],
  ['selfcheck-all-ok', (ws) => { const o = run(ws, 'flapsim.py', ['--selfcheck']); return !!o && o.trim().split('\n').length >= 6 && !/FAIL/.test(o); }],
  ['tests-written', (ws) => existsSync(join(ws, 'test_flapsim.py'))],
  ['reviewed', (ws) => existsSync(join(ws, 'REVIEW.md'))],
  ['artifact-produced', (ws) => { try { return readFileSync(join(ws, 'replay.txt'), 'utf8').length >= 200; } catch { return false; } }],
  ['feature-implemented', (ws) => { const o = run(ws, 'flapsim.py', ['--seed', '7', '--ticks', '200', '--flaps', '0010', '--powerups']); return !!o && /shields=\d/.test(o); }],
  ['docs-written', (ws) => existsSync(join(ws, 'GETTING_STARTED.md'))],
];

function phaseReached(ws) {
  let idx = 0;
  const done = [];
  for (let i = 0; i < PHASES.length; i++) {
    let ok = false;
    try { ok = PHASES[i][1](ws); } catch { ok = false; }
    if (ok) { idx = i; done.push(PHASES[i][0]); }
  }
  return { phase_index: idx, phase_name: PHASES[idx][0], phases_total: PHASES.length - 1, phases_done: done };
}

/** Validity flags — a run that violates these is not comparable, not just worse. */
function metrics(ws) {
  let maxChars = 0, over = 0, mods = 0, floats = 0;
  try {
    for (const f of readdirSync(ws)) {
      if (!f.endsWith('.py')) continue;
      mods += 1;
      const t = readFileSync(join(ws, f), 'utf8');
      maxChars = Math.max(maxChars, t.length);
      if (t.length > 1800) over += 1;
      floats += (t.match(/\b\d+\.\d+\b/g) || []).length;
    }
  } catch {}
  return { ...phaseReached(ws),
    max_py_chars: maxChars, files_over_1800: over, module_count: mods, float_literals: floats,
    has_replay: existsSync(join(ws, 'replay.txt')), has_review: existsSync(join(ws, 'REVIEW.md')),
    has_docs: existsSync(join(ws, 'GETTING_STARTED.md')) };
}

const base = scenarioTask('flapsim', { score, grade: (ws) => score(ws).correct >= 34 });
export default { ...base, score, metrics, grade: (ws) => score(ws).correct >= 34 };
