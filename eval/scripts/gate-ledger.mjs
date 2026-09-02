#!/usr/bin/env node
/**
 * loop9b-item3 §4.5: read-only, no-model corpus replay of the tree-arm
 * completion-gate ledger the loop9b decision rests on
 * (eval/plans/loop9b-item3-judge-verdict.md §2, §4). Recomputes fire/rescue
 * counts purely from `turns[].toolCalls` (tool *names* only — no new capture)
 * across every `eval/results/**\/results.json`.
 *
 * The gate (`eval/src/loop.ts:1010`, `EVAL_NO_COMPLETION_GATE=1` disables it)
 * is a one-shot latch: once a bare-text reply follows any turn that made a
 * tool call, the nudge fires and can never fire again in that run, so the
 * FIRST such turn is the only place it can have happened, wherever it falls
 * in the sequence. This mirrors `eval/src/metrics.ts:deriveBatchingMetrics`
 * exactly (duplicated here, not imported, so this script has no build-order
 * dependency on `eval/dist` — the same self-contained-analysis precedent as
 * `eval/scripts/ct-stats.mjs`).
 *
 * eval/results/ is gitignored and mutates across sessions (new runs land,
 * old ones get pruned), so the corpus-wide totals below are a live count,
 * not a frozen artifact — this script reports what is on disk NOW and flags
 * where that has drifted from the judge-verdict snapshot (204 tree runs, 185
 * fires, 23 rescues) rather than silently reprinting stale numbers.
 *
 *   node eval/scripts/gate-ledger.mjs [resultsDir]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'eval/results';

function* findResults(path) {
  const st = statSync(path);
  if (st.isFile()) {
    if (path.endsWith('results.json')) yield path;
    return;
  }
  for (const entry of readdirSync(path)) yield* findResults(join(path, entry));
}

/** Identical logic to eval/src/metrics.ts:deriveBatchingMetrics's gate fields. */
function deriveGate(turns) {
  const n = turns.length;
  let trailingBareTurns = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (turns[i].toolCalls.length !== 0) break;
    trailingBareTurns += 1;
  }
  let toolWorkSeen = false;
  let firstBareAfterWork = -1;
  for (let i = 0; i < n; i += 1) {
    if (turns[i].toolCalls.length === 0) {
      if (toolWorkSeen && firstBareAfterWork === -1) firstBareAfterWork = i;
    } else {
      toolWorkSeen = true;
    }
  }
  const gateFired = firstBareAfterWork !== -1;
  const gateRescued = gateFired && firstBareAfterWork < n - 1 && turns[firstBareAfterWork + 1].toolCalls.length > 0;
  return { trailingBareTurns, gateFired, gateRescued };
}

function finalTurnTokens(turns) {
  const last = turns[turns.length - 1];
  if (last === undefined || last.usage === undefined) return undefined;
  const u = last.usage;
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

// eval/results/ can be under active write by a concurrently running batch
// (this ledger is read-only and must never touch eval/dist or block one), so
// a run record with no turns (mid-write truncation, or a genuine 'error'
// status run that never got a turn) is skipped rather than crashing the
// replay — reported below, not silently dropped.
const files = [...findResults(root)];
const rows = [];
let skipped = 0;
for (const file of files) {
  for (const run of JSON.parse(readFileSync(file, 'utf8'))) {
    if (!Array.isArray(run.turns) || run.turns.length === 0) {
      skipped += 1;
      continue;
    }
    rows.push({ file, ...run });
  }
}

const tree = rows.filter((r) => r.arm === 'context-tree');
const gates = tree.map((r) => ({ run: r, gate: deriveGate(r.turns) }));
const totalFires = gates.filter((g) => g.gate.gateFired).length;
const totalRescues = gates.filter((g) => g.gate.gateRescued).length;

const sw3Tree = tree.filter((r) => r.scenarioId === 'sw-3-refactor');
const sw3Gates = sw3Tree.map((r) => deriveGate(r.turns));
const sw3Fires = sw3Gates.filter((g) => g.gateFired).length;
const sw3Rescues = sw3Gates.filter((g) => g.gateRescued).length;
const sw3TwoTrailing = sw3Gates.filter((g) => g.trailingBareTurns >= 2).length;

const sw3Native = rows.filter((r) => r.arm === 'native' && r.scenarioId === 'sw-3-refactor');
const sw3NativeOneTrailing = sw3Native.filter((r) => deriveGate(r.turns).trailingBareTurns === 1).length;

// The six v6.x replicates the judge-verdict's 13,793 mean is computed over
// (v60-diverse + v61-diverse, sw-3-refactor, context-tree arm).
const v6x = sw3Tree.filter((r) => /^v6[01]-div-rep\d+$/.test(r.runId));
const v6xTotalsRaw = v6x.map((r) => ({ runId: r.runId, file: r.file, total: finalTurnTokens(r.turns) }));
const v6xTotals = v6xTotalsRaw.filter((t) => t.total !== undefined).map((t) => t.total);
if (v6xTotals.length !== v6xTotalsRaw.length) {
  const bad = v6xTotalsRaw.filter((t) => t.total === undefined);
  console.error(
    `warning: ${bad.length} v6.x replicate(s) had no readable final turn (concurrent write race?): ` +
      bad.map((t) => `${t.runId} (${t.file})`).join(', '),
  );
}
const v6xMean = v6xTotals.length > 0 ? v6xTotals.reduce((a, b) => a + b, 0) / v6xTotals.length : NaN;

console.log(
  `corpus-wide (arm=context-tree, ${files.length} results.json files, ${skipped} run(s) skipped for missing/empty turns): ` +
    `${tree.length} runs, ${totalFires} gate fires, ${totalRescues} rescued`,
);
console.log(
  `sw-3-refactor (context-tree): ${sw3Tree.length} runs, ${sw3Fires} fires, ${sw3Rescues} rescued, ` +
    `${sw3TwoTrailing}/${sw3Tree.length} end with >=2 trailing bare turns`,
);
console.log(
  `sw-3-refactor (native): ${sw3Native.length} runs, ${sw3NativeOneTrailing}/${sw3Native.length} end with exactly 1 trailing bare turn (no gate)`,
);
if (v6x.length > 0) {
  console.log(
    `sw-3-refactor v6.x replicates (${v6x.length}: ${v6x.map((r) => r.runId).join(', ')}): ` +
      `final-turn totals = [${v6xTotals.join(', ')}], mean = ${v6xMean.toFixed(2)}`,
  );
} else {
  console.log('sw-3-refactor v6.x replicates: none found in this corpus');
}

// --- Assertions against loop9b-item3-judge-verdict.md's ledger -------------
// eval/results/ is gitignored and local, so the corpus-wide totals can (and,
// per the header above, currently do) drift from the judge's snapshot as
// runs are added or pruned between sessions; that is reported as a FAIL, not
// silently absorbed. The sw-3-refactor-scoped numbers are the ones the
// loop9b-item3 decision actually rests on and are expected to hold exactly.
const checks = [
  ['corpus tree runs === 204', tree.length === 204],
  ['corpus gate fires === 185', totalFires === 185],
  ['corpus rescues === 23', totalRescues === 23],
  ['sw-3-refactor fires === 14', sw3Fires === 14],
  ['sw-3-refactor rescues === 0', sw3Rescues === 0],
  ['sw-3-refactor 14/14 two-trailing-bare', sw3TwoTrailing === sw3Tree.length && sw3Tree.length === 14],
  ['sw-3-refactor native 5/5 one-trailing-bare', sw3NativeOneTrailing === sw3Native.length && sw3Native.length === 5],
  ['sw-3-refactor v6.x mean final-turn tokens === 13793 (±1, rounding)', Math.abs(v6xMean - 13793) <= 1],
];

console.log('');
console.log('Ledger checks:');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
  if (!ok) failed += 1;
}
if (failed > 0) {
  console.log('');
  console.log(
    `${failed} check(s) drifted from the judge-verdict snapshot. eval/results/ is gitignored and ` +
      'mutable across sessions — re-read the drifted numbers against the current corpus before ' +
      'trusting the judge-verdict document\'s literal figures for anything beyond sw-3-refactor.',
  );
  process.exitCode = 1;
}
