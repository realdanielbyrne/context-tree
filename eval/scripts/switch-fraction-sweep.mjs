#!/usr/bin/env node
/**
 * Experiment 3 (reports/algorithm.md dimension 3 — "when summaries are
 * written, and under what policy"; analysis at
 * eval/plans/tuning/03-summary-policy.md §3(d)) — sweeps the switch fraction
 * and the summary-insertion cadence entirely offline. Zero LLM calls, zero
 * network. Every number either comes from a pure, local computation over a
 * synthetic corpus built the same way eval/scripts/marathon.mjs builds one,
 * or (§2 below) from `usage` fields already recorded in
 * eval/results/long-v65-gate/*\/results.json.
 *
 * Why a sibling script rather than a change to marathon.mjs: marathon.mjs
 * carries its own fixed-cadence contract — a docstring that states a specific
 * claim (D17/D18 keep the tree prompt flat across 160-200 branches) and
 * assertions that check exactly that invariant. It always assembles in
 * post-switch/summarized mode from branch 1; it has no notion of a pre-switch
 * "whole trace" mode at all, because verifying flatness never needed one.
 * Turning that into a *family* of curves needs two axes marathon.mjs was
 * never parameterized for (switch fraction, cadence), and bolting them onto
 * a script whose existing assertions assume single-cadence behaviour risks
 * silently invalidating the invariant it verifies. So this script duplicates
 * marathon.mjs's deterministic generator (`addCycle`, copied verbatim, kept
 * in sync by hand — it is eight lines of trace-shape fixture, not logic worth
 * sharing through an import) and drives the same real core pipeline
 * (JsonlTraceLog, FsBlobStore, SqliteTreeStore via openInMemoryStore,
 * ZoneAssembler, composeRootSummary) so both scripts measure the same
 * underlying corpus shape and the numbers are comparable.
 *
 * §1 method. At every branch i (1..BRANCHES) this script computes, with no
 * model call anywhere:
 *   - nativeTokens(i): tokens in the full raw transcript through branch i —
 *     this IS the "devolved" (pre-switch) candidate: the production gate's
 *     `belowLazyK` branch sets zoneCBudget=Infinity and activeNodeId=root,
 *     which is exactly "show the whole trace" (eval/src/loop.ts:1003-1012).
 *   - treeTotal(i): the real ZoneAssembler's post-switch prompt size — root
 *     (D17 fold) + branch summaries in Zone B, bounded active-branch detail
 *     in Zone C, at DEFAULT_CONFIG's budgets. This is what marathon.mjs
 *     already computes at every checkpoint; here it is computed at every
 *     branch for crossing-point precision.
 * A candidate switch fraction f defines switchTokens = floor(f * W). The
 * crossing branch is the first i with nativeTokens(i) >= switchTokens (a
 * one-way latch, matching eval/src/loop.ts's `lazyCrossed`). The stitched
 * per-fraction curve is nativeTokens(i) for i < crossing, treeTotal(i) for
 * i >= crossing — "re-sequenced arithmetically over data already in hand",
 * per the analysis this experiment was scoped from.
 *
 * W = 200,000 (Sonnet's advertised window) because that is the model the six
 * real crossings in §2 and in reports/metrics/context-growth.md were measured
 * on. There is no live billing tokenizer in this harness to convert between
 * token spaces — algorithm.md's "heuristic-to-tokenizer ratio" (0.851) was
 * measured on the transplant corpus, not this synthetic one, and reusing it
 * here without re-measuring it on THIS corpus would be exactly the
 * unvalidated-constant defect rule 2 warns about. So switchTokens is computed
 * directly against HeuristicTokenizer counts (ratio = 1, this harness's own
 * units throughout). That keeps the RELATIVE ranking of the five candidate
 * fractions valid — every threshold scales by the same unstated ratio, so it
 * cancels out of any across-fraction comparison — but the absolute
 * crossing-branch numbers below are NOT a claim about where a real run
 * against real billed tokens would cross; that would need this corpus's own
 * measured ratio, which has not been taken.
 *
 * Cadence (batch-at-crossing vs incremental-at-close) does not change either
 * curve above — post-switch Zone B content is the same set of branch
 * summaries either way once the switch has fired, whether they were built in
 * one lump at the crossing or one at a time as each branch closed. What
 * cadence changes is WHEN the summarizer is asked to do work, which this
 * script tracks as a separate build-count schedule (§1b) rather than a token
 * count, because marathon-style harnesses insert summaries directly with no
 * LLM call and therefore no per-call cost to attribute.
 *
 * Usage: node eval/scripts/switch-fraction-sweep.mjs [branches] [W]
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  FsBlobStore,
  HeuristicTokenizer,
  JsonlTraceLog,
  ZoneAssembler,
  composeRootSummary,
  renderEvent,
  systemContract,
  openInMemoryStore,
} from '@context-tree/core';

const BRANCHES = Number.parseInt(process.argv[2] ?? '', 10) || 300;
const WINDOW_TOKENS = Number.parseInt(process.argv[3] ?? '', 10) || 200_000;
const SWITCH_FRACTIONS = [0.15, 0.2, 0.25, 0.3, 0.35];
const ROOT_KEEP = DEFAULT_CONFIG.rootKeep;
const BUDGETS = { ...DEFAULT_CONFIG.budgets };
const TS = '2026-01-01T00:00:00.000Z';

const NATIVE_SYSTEM_PROMPT = [
  'You are a capable coding agent working inside a task sandbox.',
  'Complete the task using the provided tools. Keep tool outputs and file edits precise,',
  'and verify your work by running the relevant commands.',
  'When the task is complete, STOP calling tools and reply with your final answer —',
  'a reply without tool calls ends the task, so make that reply the deliverable the task asks for.',
].join('\n');
const NATIVE_TASK_MESSAGE =
  'Implement all stub modules under src/, one per module, verifying each with its own test.';
const TREE_TOOL_SCHEMAS_TEXT = JSON.stringify([
  { name: 'context_fetch', description: 'Fetch full detail for one or more node ids.' },
  { name: 'context_search', description: 'Search branch summaries and detail lexically/semantically.' },
  { name: 'context_peek', description: 'Peek at a node at summary or full depth.' },
  { name: 'annotate', description: 'Record a durable note against a node.' },
]);

const tokenizer = new HeuristicTokenizer();
const dir = mkdtempSync(join(tmpdir(), 'ct-switch-sweep-'));
const store = openInMemoryStore();
const blobs = new FsBlobStore(join(dir, 'blobs'));
const trace = new JsonlTraceLog(join(dir, 'trace.jsonl'));

const root = store.insertNode({
  id: 't_root',
  parent_id: null,
  kind: 'task',
  title: 'Sweep: roll out stub modules under src/',
  span_start_seq: 1,
  span_end_seq: 1,
});

function emptyMeta(overrides = {}) {
  return {
    files: [],
    symbols: [],
    tests: [],
    artifacts: [],
    open_questions: [],
    decisions: [],
    node_ids: [],
    ...overrides,
  };
}

// Copied verbatim from eval/scripts/marathon.mjs's addCycle — see header note.
function addCycle(i) {
  const pad = String(i).padStart(4, '0');
  const path = `src/mod_${pad}.ts`;
  const start = trace.lastSeq() + 1;
  trace.append({
    type: 'user_message',
    ts: TS,
    blob: blobs.put(
      `Implement stub module mod_${pad}: add a computeMod${pad} export that offsets its input by ${i}, then verify with the test suite.`,
    ),
  });
  trace.append({
    type: 'assistant_message',
    ts: TS,
    blob: blobs.put(
      `Reading ${path}, applying the additive-offset pattern, and running the module's unit test.`,
    ),
  });
  const readCall = trace.append({
    type: 'tool_call',
    ts: TS,
    tool: 'Read',
    path,
    blob: blobs.put(`// mod_${pad} v0 (stub)\nexport function noopMod${pad}() {\n  return 0;\n}\n`),
  });
  trace.append({
    type: 'tool_result',
    ts: TS,
    call_seq: readCall.seq,
    output_blob: blobs.put(`read 4 lines from ${path}`),
  });
  const writeCall = trace.append({
    type: 'tool_call',
    ts: TS,
    tool: 'Write',
    path,
    blob: blobs.put(`// mod_${pad} v1\nexport function computeMod${pad}(x) {\n  return x + ${i};\n}\n`),
  });
  trace.append({
    type: 'tool_result',
    ts: TS,
    call_seq: writeCall.seq,
    output_blob: blobs.put(`wrote ${path} (4 lines)`),
  });
  const verifyCall = trace.append({
    type: 'tool_call',
    ts: TS,
    tool: 'Bash',
    args_blob: blobs.put(`npm test -- mod_${pad}`),
  });
  trace.append({
    type: 'tool_result',
    ts: TS,
    call_seq: verifyCall.seq,
    output_blob: blobs.put(`PASS test_mod_${pad} (1 passed, 0 failed) - computeMod${pad} returns x + ${i}`),
  });
  const end = trace.lastSeq();

  const node = store.insertNode({
    id: `p${pad}`,
    parent_id: root.id,
    kind: 'phase',
    title: `implement mod_${pad}`,
    phase_type: 'implementation',
    span_start_seq: start,
    span_end_seq: end,
    status: 'closed',
  });
  store.insertNode({
    id: `f${pad}`,
    parent_id: node.id,
    kind: 'file',
    title: path,
    span_start_seq: writeCall.seq,
    span_end_seq: writeCall.seq,
    meta_json: { path },
  });
  store.updateNode(root.id, { span_end_seq: end });

  store.putSummary({
    node_id: node.id,
    model: 'mock-leaf-deterministic',
    text: `Implemented mod_${pad}: added computeMod${pad}(x) = x + ${i}. Verified via test_mod_${pad} (1 passed).`,
    meta: emptyMeta({
      node_ids: [node.id],
      files: [{ path, start_line: 1, end_line: 4, symbol: `computeMod${pad}` }],
      symbols: [`computeMod${pad}`],
      tests: [{ name: `test_mod_${pad}`, status: 'passed' }],
      decisions: [`used the additive-offset pattern for mod_${pad}`],
      open_questions: [],
    }),
    created_at: TS,
  });

  return { node, start, end };
}

// ── §1: build both candidate curves at every branch ─────────────────────────
const systemContractText = systemContract();
const nativeParts = [];
const curve = []; // { branch, nativeTokens, treeTotal }

for (let i = 1; i <= BRANCHES; i += 1) {
  const { start, end } = addCycle(i);
  for (const event of trace.read({ from: start, to: end })) {
    nativeParts.push(renderEvent(event, blobs));
  }
  const nativeText = [NATIVE_SYSTEM_PROMPT, NATIVE_TASK_MESSAGE, ...nativeParts].join('\n\n');
  const nativeTokens = tokenizer.count(nativeText);

  composeRootSummary(store, root.id, () => TS, ROOT_KEEP);
  const assembler = new ZoneAssembler({
    store,
    blobs,
    trace,
    tokenizer,
    systemContract: systemContractText,
    budgets: BUDGETS,
  });
  const prompt = assembler.assemble({ toolSchemasText: TREE_TOOL_SCHEMAS_TEXT });

  curve.push({ branch: i, nativeTokens, treeTotal: prompt.budgets.total });
}

// ── §1a: stitch a curve per candidate fraction (+ no-switch baseline) ───────
function crossingBranch(fraction) {
  const switchTokens = Math.floor(fraction * WINDOW_TOKENS);
  const row = curve.find((r) => r.nativeTokens >= switchTokens);
  return { switchTokens, branch: row ? row.branch : null };
}

function stitchedCurve(crossing) {
  return curve.map((r) => ({
    branch: r.branch,
    size: crossing.branch !== null && r.branch >= crossing.branch ? r.treeTotal : r.nativeTokens,
  }));
}

// ── §1b: summary build-count schedule per cadence (bookkeeping, not tokens) ─
// batch-at-crossing: matches eval/src/loop.ts today — nothing is summarized
// while belowLazyBudget() holds (loop.ts:871), so the first post-crossing
// pass drains the whole backlog in one call (loop.ts:936-937), then one
// branch at a time thereafter as each subsequent branch closes.
// incremental-at-close: the §3(c)/(d) proposal — scheduleSummarize as soon as
// a branch closes, independent of the switch. One per branch, from branch 1,
// whether or not (or how early) the switch ever fires.
function buildSchedule(branchCount, crossing, cadence) {
  const perBranch = new Array(branchCount + 1).fill(0);
  if (cadence === 'incremental-at-close') {
    for (let i = 1; i < branchCount; i += 1) perBranch[i] = 1; // newest branch never summarizes
    return perBranch;
  }
  if (crossing.branch === null) return perBranch; // never crosses -> never summarizes; matches the measured 0% share on non-crossing tasks
  perBranch[crossing.branch] = crossing.branch - 1; // catch-up lump
  for (let i = crossing.branch + 1; i < branchCount; i += 1) perBranch[i] = 1;
  return perBranch;
}

const results = SWITCH_FRACTIONS.map((fraction) => {
  const crossing = crossingBranch(fraction);
  const stitched = stitchedCurve(crossing);
  const sizes = stitched.map((r) => r.size);
  const totalTokens = sizes.reduce((a, b) => a + b, 0);
  const peak = Math.max(...sizes);
  const finalSize = sizes.at(-1);
  const batchSchedule = buildSchedule(BRANCHES, crossing, 'batch-at-crossing');
  const incSchedule = buildSchedule(BRANCHES, crossing, 'incremental-at-close');
  return {
    fraction,
    switchTokens: crossing.switchTokens,
    crossingBranch: crossing.branch,
    peak,
    finalSize,
    totalTokens,
    batchAtCrossingSize: crossing.branch !== null ? batchSchedule[crossing.branch] : 0,
    batchTotalSummaries: batchSchedule.reduce((a, b) => a + b, 0),
    incrementalMaxLump: Math.max(...incSchedule),
    incrementalTotalSummaries: incSchedule.reduce((a, b) => a + b, 0),
    stitched,
  };
});

const noSwitch = {
  fraction: null,
  switchTokens: null,
  crossingBranch: null,
  peak: Math.max(...curve.map((r) => r.nativeTokens)),
  finalSize: curve.at(-1).nativeTokens,
  totalTokens: curve.reduce((a, r) => a + r.nativeTokens, 0),
  batchAtCrossingSize: 0,
  batchTotalSummaries: 0,
  incrementalMaxLump: 1,
  incrementalTotalSummaries: BRANCHES - 1,
};

// ── report §1 ────────────────────────────────────────────────────────────
console.log(`\n=== Experiment 3, part 1: switch-fraction x cadence sweep ===`);
console.log(`branches=${BRANCHES}, W=${WINDOW_TOKENS}, rootKeep=${ROOT_KEEP}, budgets.zoneB=${BUDGETS.zoneB}, budgets.zoneC=${BUDGETS.zoneC}\n`);

console.log('| fraction | switchTokens | crossing branch | peak tokens | final tokens | total tokens (sum over run) | batch-at-crossing lump | incremental total builds |');
console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
console.log(
  `| no-switch | - | never (>${BRANCHES}) | ${noSwitch.peak} | ${noSwitch.finalSize} | ${noSwitch.totalTokens} | ${noSwitch.batchAtCrossingSize} | ${noSwitch.incrementalTotalSummaries} |`,
);
for (const r of results) {
  console.log(
    `| ${r.fraction.toFixed(2)} | ${r.switchTokens} | ${r.crossingBranch ?? `never (>${BRANCHES})`} | ${r.peak} | ${r.finalSize} | ${r.totalTokens} | ${r.batchAtCrossingSize} | ${r.incrementalTotalSummaries} |`,
  );
}

console.log('\nPer-fraction stitched size series (every 20 branches, plus the exact crossing row):');
for (const r of results) {
  console.log(`\n  fraction=${r.fraction} (switch at ${r.switchTokens} tok, crosses branch ${r.crossingBranch}):`);
  const rowsToShow = new Set([1]);
  for (let b = 20; b <= BRANCHES; b += 20) rowsToShow.add(b);
  if (r.crossingBranch !== null) {
    rowsToShow.add(Math.max(1, r.crossingBranch - 1));
    rowsToShow.add(r.crossingBranch);
    rowsToShow.add(Math.min(BRANCHES, r.crossingBranch + 1));
  }
  rowsToShow.add(BRANCHES);
  const sorted = [...rowsToShow].sort((a, b) => a - b);
  for (const b of sorted) {
    const row = r.stitched.find((x) => x.branch === b);
    if (row) console.log(`    branch ${row.branch}: ${row.size} tok${r.crossingBranch === b ? '  <- switch fires' : ''}`);
  }
}

const beats035 = results.find((r) => r.fraction === 0.2).totalTokens < results.find((r) => r.fraction === 0.35).totalTokens;
const minRow = results.reduce((min, r) => (r.totalTokens < min.totalTokens ? r : min), results[0]);
console.log(`\nDoes 0.20 beat 0.35 on total tokens at equal coverage (same ${BRANCHES}-branch run)? ${beats035 ? 'YES' : 'NO'}`);
console.log(
  `  0.20 total=${results.find((r) => r.fraction === 0.2).totalTokens}, 0.35 total=${results.find((r) => r.fraction === 0.35).totalTokens}`,
);
console.log(`Minimum total tokens among the tested fractions: ${minRow.fraction} (total=${minRow.totalTokens})`);
console.log(
  `For reference, the native/tree crossover (branch at which treeTotal first drops below nativeTokens) is branch ${curve.find((r) => r.treeTotal < r.nativeTokens)?.branch ?? 'never'} — every tested fraction's switchTokens corresponds to a branch far past this point.`,
);

// ── §2: quantify the one-turn lag from the six recorded real crossings ─────
function loadRecordedCrossings(resultsDir) {
  const THRESHOLD = 30_000; // the live suite's absolute switch point these runs actually used
  const files = [];
  (function walk(p) {
    const st = statSync(p);
    if (st.isFile()) {
      if (p.endsWith('results.json')) files.push(p);
      return;
    }
    for (const entry of readdirSync(p)) walk(join(p, entry));
  })(resultsDir);

  const rows = [];
  for (const f of files.sort()) {
    const runs = JSON.parse(readFileSync(f, 'utf8'));
    for (const run of runs) {
      const series = run.turns.map((t) => ({
        index: t.index,
        size: t.usage.input + t.usage.cacheRead + t.usage.cacheWrite,
      }));
      const crossIdx = series.findIndex((t) => t.size >= THRESHOLD);
      if (crossIdx === -1) continue;
      const crossing = series[crossIdx];
      const next = series.find((t) => t.index === crossing.index + 1);
      rows.push({
        file: f,
        runId: run.runId,
        scenarioId: run.scenarioId,
        crossingTurn: crossing.index,
        crossingSize: crossing.size,
        overshootToday: crossing.size - THRESHOLD,
        nextTurnSize: next ? next.size : null,
        overshootFixed: next ? Math.max(0, next.size - THRESHOLD) : null,
      });
    }
  }
  return { rows, threshold: THRESHOLD };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const { rows: lagRows, threshold } = loadRecordedCrossings('eval/results/long-v65-gate');

console.log(`\n=== Experiment 3, part 2: one-turn lag, quantified from recorded crossings ===`);
console.log(`Threshold (live suite's absolute switch point at the time these runs were made): ${threshold}\n`);
console.log('| run | scenario | crossing turn | crossing size (today, actually sent) | overshoot today | next-turn size (proxy for the fixed same-turn switch) | overshoot under the fix |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const r of lagRows) {
  console.log(
    `| ${r.runId} | ${r.scenarioId} | ${r.crossingTurn} | ${r.crossingSize} | +${r.overshootToday} | ${r.nextTurnSize ?? 'n/a'} | ${r.overshootFixed ?? 'n/a'} |`,
  );
}
console.log(`\nn = ${lagRows.length}`);
console.log(`Median overshoot TODAY (lagged gate): ${median(lagRows.map((r) => r.overshootToday))} tokens`);
console.log(
  `Median overshoot UNDER THE FIX (same-turn check, next-turn size as proxy): ${median(lagRows.map((r) => r.overshootFixed))} tokens`,
);
console.log(
  `Worst-case overshoot under the fix: ${Math.max(...lagRows.map((r) => r.overshootFixed))} tokens (vs worst-case today: ${Math.max(...lagRows.map((r) => r.overshootToday))} tokens)`,
);
console.log(
  [
    '',
    'Caveat: "next-turn size" is a proxy, not an exact replay. These are real production runs (loop.ts',
    '+ a live model); their raw L0 trace was not archived, only per-turn usage aggregates in results.json.',
    'The proxy is defensible because the crossing turn itself IS the exact number the same-turn check would',
    'have computed before sending (the gate stayed in devolved mode through that turn, so what was billed IS',
    'the devolved candidate) — the open question is only what the bounded, post-switch prompt would have cost',
    'THAT SAME turn instead, and the closest on-disk answer is what the real run billed one turn later, once',
    'one extra turn of trace growth had accrued on top.',
  ].join('\n'),
);

// ── §2b: measured wall-clock cost of the extra local tokenizer pass ────────
function benchmarkTokenizerPass(sizeChars, iterations) {
  const mixedText = Array.from({ length: Math.floor(sizeChars / 40) }, (_, i) =>
    i % 3 === 0
      ? `function computeMod${i}(x) { return x + ${i}; }\n`
      : i % 3 === 1
        ? `PASS test_mod_${i} (1 passed, 0 failed)\n`
        : `Reading src/mod_${i}.ts, applying the additive-offset pattern.\n`,
  ).join('');
  const t0 = process.hrtime.bigint();
  let total = 0;
  for (let i = 0; i < iterations; i += 1) total += tokenizer.count(mixedText);
  const t1 = process.hrtime.bigint();
  return { mixed: { msTotal: Number(t1 - t0) / 1e6, tokens: total / iterations } };
}

// Char counts chosen so the mixed-content generator's own token/char ratio
// (measured, not assumed) lands close to the two crossing sizes actually
// observed in §2 (~30k and ~45k heuristic tokens) — reported with the
// measured token count alongside the char count so the label is exact either way.
const bench30k = benchmarkTokenizerPass(4 * 30_000, 50);
const bench45k = benchmarkTokenizerPass(4 * 45_000, 50);

console.log(`\n=== Experiment 3, part 2b: wall-clock cost of the extra local tokenizer pass ===`);
console.log('(HeuristicTokenizer.count is a single O(n) character scan — packages/core/src/tokens/index.ts:59)');
console.log(`  ${(4 * 30_000).toLocaleString()}-char mixed-content prompt, 50 reps:`);
console.log(`    mean ${(bench30k.mixed.msTotal / 50).toFixed(3)} ms/pass (measured ${Math.round(bench30k.mixed.tokens)} heuristic tokens)`);
console.log(`  ${(4 * 45_000).toLocaleString()}-char mixed-content prompt, 50 reps:`);
console.log(`    mean ${(bench45k.mixed.msTotal / 50).toFixed(3)} ms/pass (measured ${Math.round(bench45k.mixed.tokens)} heuristic tokens)`);
console.log('  For comparison, the recorded crossing turns above have p50/p95 turn latencies in the seconds');
console.log('  (results.json turns[].latencyMs) — the model call itself, not this local pass, dominates wall-clock.');

store.close();
rmSync(dir, { recursive: true, force: true });
