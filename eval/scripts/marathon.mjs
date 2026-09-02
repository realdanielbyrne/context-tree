#!/usr/bin/env node
/**
 * Phase 3 marathon harness — verifies the D17 (root fold, rootKeep) + D18
 * (render caps) "indefinite conversation" claim from hier-verdict.md's Phase 3
 * checklist (items 10-13): with D17/D18, the context-tree prompt stays FLAT
 * across 160-200 closed branches while a native full-transcript prompt grows
 * without bound and would blow past a small model's context window.
 *
 * Offline prompt-construction harness — NOT a live agent loop. Zero LLM spend
 * in the default path: L0/L2/L1 are built with the real core pipeline
 * (JsonlTraceLog, FsBlobStore, SqliteTreeStore), branch nodes + leaf summaries
 * are inserted directly (the same pattern packages/core/test/assemble.test.ts's
 * `addBranch` harness uses), and root composition is the real, pure
 * `composeRootSummary` (D17) — no LLM call anywhere in this path.
 *
 * Determinism: every timestamp is the fixed `TS` constant, every node id is
 * assigned explicitly (`p0001`, `f0001`, ...) rather than left to a
 * ULID-from-clock default, and every stub module body is a pure function of
 * its cycle index. Reruns produce byte-identical trace/summary content and
 * therefore identical token counts.
 *
 * Usage:
 *   node eval/scripts/marathon.mjs [branches] [checkpointEvery]
 *   MARATHON_LIVE=1 node eval/scripts/marathon.mjs   # + one opt-in live probe pair
 *
 * Reads OPENROUTER_API_KEY from the workspace .env via the core dotenv loader
 * (only consulted when MARATHON_LIVE=1).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  FsBlobStore,
  HeuristicTokenizer,
  JsonlTraceLog,
  OpenRouterProvider,
  ZoneAssembler,
  composeRootSummary,
  loadDotEnv,
  priceFor,
  renderEvent,
  systemContract,
  openInMemoryStore,
} from '@context-tree/core';

// ── config ───────────────────────────────────────────────────────────────
const BRANCHES = Number.parseInt(process.argv[2] ?? '', 10) || 200;
const CHECKPOINT_EVERY = Number.parseInt(process.argv[3] ?? '', 10) || 10;
const ROOT_KEEP = DEFAULT_CONFIG.rootKeep; // D17 default: 40
const BUDGETS = { ...DEFAULT_CONFIG.budgets }; // zoneB: 8000, zoneC: 30000
const TS = '2026-01-01T00:00:00.000Z'; // fixed — no Date.now() anywhere below
const SMALL_WINDOW_MODELS = [
  { model: 'openai/gpt-3.5-turbo', windowTokens: 16_000 },
  { model: 'qwen/qwen-2.5-72b-instruct', windowTokens: 32_000 },
];

// Copied (not imported) from eval/src/loop.ts's NATIVE_SYSTEM_PROMPT — same
// shape and rough size, kept local so this script has no eval/src dependency.
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

// ── L0/L2/L1 setup — real core pipeline ─────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'ct-marathon-'));
const store = openInMemoryStore();
const blobs = new FsBlobStore(join(dir, 'blobs'));
const trace = new JsonlTraceLog(join(dir, 'trace.jsonl'));

const root = store.insertNode({
  id: 't_root',
  parent_id: null,
  kind: 'task',
  title: 'Marathon: roll out 200 stub modules under src/',
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

/**
 * One read -> write -> verify cycle = one closed phase branch with a
 * deterministic leaf summary (no LLM). Branch 10 plants a decision + open
 * question phrased with distinctive vocabulary for the §13 recall-probe
 * design stub at the bottom of this script.
 */
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

  const planted =
    i === 10
      ? {
          decisions: ['capped batch size at 50 to dodge an OOM in the loader as a stopgap'],
          open_questions: ['revisit the batch-size cap once the loader is rewritten'],
        }
      : { decisions: [`used the additive-offset pattern for mod_${pad}`], open_questions: [] };

  store.putSummary({
    node_id: node.id,
    model: 'mock-leaf-deterministic',
    text: `Implemented mod_${pad}: added computeMod${pad}(x) = x + ${i}. Verified via test_mod_${pad} (1 passed).`,
    meta: emptyMeta({
      node_ids: [node.id],
      files: [{ path, start_line: 1, end_line: 4, symbol: `computeMod${pad}` }],
      symbols: [`computeMod${pad}`],
      tests: [{ name: `test_mod_${pad}`, status: 'passed' }],
      ...planted,
    }),
    created_at: TS,
  });

  return { node, start, end };
}

// ── run the marathon, tracking both arms ────────────────────────────────────
const systemContractText = systemContract();
const nativeParts = [];
const rows = [];

for (let i = 1; i <= BRANCHES; i += 1) {
  const { start, end } = addCycle(i);
  for (const event of trace.read({ from: start, to: end })) {
    nativeParts.push(renderEvent(event, blobs));
  }

  const isCheckpoint = i % CHECKPOINT_EVERY === 0 || i === BRANCHES;
  if (!isCheckpoint) continue;

  // -- tree arm: real, pure D17 root composition + real ZoneAssembler --------
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
  const rootBlock = prompt.blocks.find((b) => b.id.startsWith('B:root:'));

  // -- native arm: concatenated full transcript (approximate, per spec) -----
  const nativeText = [NATIVE_SYSTEM_PROMPT, NATIVE_TASK_MESSAGE, ...nativeParts].join('\n\n');
  const nativeTokens = tokenizer.count(nativeText);

  rows.push({
    branch: i,
    nativeTokens,
    treeTotal: prompt.budgets.total,
    zoneB: prompt.budgets.zoneB,
    zoneA: prompt.budgets.zoneA,
    rootTokens: rootBlock?.tokens ?? 0,
    foldedCount: Math.max(0, i - ROOT_KEEP),
    overBudget: prompt.budgets.overBudget,
  });
}

// ── fine-grained native crossing points (cheap: no LLM, just tokenizing) ────
// Recomputed independently of the checkpoint loop above so the "branch at
// which native crosses N tokens" answer isn't rounded to the nearest 10.
function nativeTokensThroughBranch(branchCount) {
  // nativeParts is 8 rendered events per cycle, in cycle order (see addCycle).
  const eventsPerCycle = 8;
  const slice = nativeParts.slice(0, branchCount * eventsPerCycle);
  return tokenizer.count([NATIVE_SYSTEM_PROMPT, NATIVE_TASK_MESSAGE, ...slice].join('\n\n'));
}

function firstBranchExceeding(thresholdTokens) {
  for (let i = 1; i <= BRANCHES; i += 1) {
    if (nativeTokensThroughBranch(i) > thresholdTokens) return i;
  }
  return null; // not reached within BRANCHES
}

const deathPoints = SMALL_WINDOW_MODELS.map(({ model, windowTokens }) => ({
  model,
  windowTokens,
  branch: firstBranchExceeding(windowTokens),
}));

// ── report: checkpoint table ────────────────────────────────────────────────
console.log(`\nMarathon: ${BRANCHES} branches, checkpoint every ${CHECKPOINT_EVERY}, rootKeep=${ROOT_KEEP}, budgets.zoneB=${BUDGETS.zoneB}\n`);
console.log(
  '| branch | native tok | tree total | tree zoneB | root block tok | folded | overBudget |',
);
console.log('| ---: | ---: | ---: | ---: | ---: | ---: | --- |');
for (const r of rows) {
  console.log(
    `| ${r.branch} | ${r.nativeTokens} | ${r.treeTotal} | ${r.zoneB} | ${r.rootTokens} | ${r.foldedCount} | ${r.overBudget.join(',') || '-'} |`,
  );
}

console.log('\nDeath points (native arm, full-transcript tokens vs. small-context OpenRouter models):');
for (const dp of deathPoints) {
  console.log(
    `  ${dp.model} (window ${dp.windowTokens}): native exceeds at branch ${dp.branch ?? `> ${BRANCHES} (not reached)`}`,
  );
}

// ── assertions ───────────────────────────────────────────────────────────────
const failures = [];
function assert(cond, message) {
  if (!cond) failures.push(message);
}

const rowAt = (branch) => rows.find((r) => r.branch === branch);
const flatFrom50 = rows.filter((r) => r.branch >= 50);
const baseline50 = rowAt(50) ?? flatFrom50[0];
if (baseline50) {
  for (const r of flatFrom50) {
    const rel = Math.abs(r.treeTotal - baseline50.treeTotal) / baseline50.treeTotal;
    assert(
      rel <= 0.1,
      `tree total not flat: branch ${r.branch} treeTotal=${r.treeTotal} vs branch ${baseline50.branch} baseline=${baseline50.treeTotal} (${(rel * 100).toFixed(1)}% off)`,
    );
  }
} else {
  assert(false, 'no checkpoint at/after branch 50 to establish a flatness baseline');
}

const rootBaseline = rowAt(ROOT_KEEP) ?? rows.find((r) => r.branch >= ROOT_KEEP);
if (rootBaseline) {
  for (const r of rows.filter((row) => row.branch >= rootBaseline.branch)) {
    const rel = Math.abs(r.rootTokens - rootBaseline.rootTokens) / Math.max(1, rootBaseline.rootTokens);
    assert(
      rel <= 0.1,
      `root block not flat after rootKeep crossing: branch ${r.branch} rootTokens=${r.rootTokens} vs branch ${rootBaseline.branch} baseline=${rootBaseline.rootTokens} (${(rel * 100).toFixed(1)}% off)`,
    );
  }
} else {
  assert(false, `no checkpoint at/after rootKeep=${ROOT_KEEP} to establish the root-flatness baseline`);
}

assert(
  rows.every((r) => !r.overBudget.includes('B')),
  'Zone B reported overBudget at some checkpoint — D17/D18 should keep it under budget indefinitely',
);

for (let k = 1; k < rows.length; k += 1) {
  assert(rows[k].nativeTokens > rows[k - 1].nativeTokens, `native tokens did not grow from branch ${rows[k - 1].branch} to ${rows[k].branch}`);
}
if (rows.length >= 3) {
  const deltas = [];
  for (let k = 1; k < rows.length; k += 1) deltas.push(rows[k].nativeTokens - rows[k - 1].nativeTokens);
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const maxDevPct = Math.max(...deltas.map((d) => Math.abs(d - meanDelta) / meanDelta));
  assert(maxDevPct <= 0.25, `native token growth is not roughly linear (max per-checkpoint deviation from mean delta: ${(maxDevPct * 100).toFixed(1)}%)`);
}

console.log(`\n${failures.length === 0 ? 'ALL ASSERTIONS PASSED' : `${failures.length} ASSERTION(S) FAILED`}`);
for (const f of failures) console.log(`  FAIL: ${f}`);

// ── §13 recall probe — DESIGN STUB ONLY, not executed here ─────────────────
console.log('\n[recall probe — design stub, not executed]');
console.log('  Plant: branch 10 (node p0010) decisions=["capped batch size at 50 to dodge an OOM in the');
console.log('  loader as a stopgap"], open_questions=["revisit the batch-size cap once the loader is rewritten"].');
console.log('  Probe question (deliberately avoids that vocabulary): "Before we ship, undo the temporary');
console.log('  limit we agreed to early on, now that the underlying issue upstream is fixed."');
console.log('  Success: the model cannot answer from the root fold line/headline set alone and issues');
console.log('  context_search or context_fetch to recall branch ~10. Failure earns the §19 escalation');
console.log('  (sharpen the context_search prior -> widen the fold line title range -> base-k cover),');
console.log('  and does NOT invalidate the boundedness result above.');

// ── optional live probe (MARATHON_LIVE=1) ───────────────────────────────────
async function runLiveProbe() {
  if (process.env.MARATHON_LIVE !== '1') {
    console.log('\n[live probe] skipped (set MARATHON_LIVE=1 to opt in)');
    return;
  }
  if (failures.length > 0) {
    console.log('\n[live probe] skipped: offline assertions failed — fix the harness or the design gap first');
    return;
  }
  loadDotEnv();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log('\n[live probe] skipped: OPENROUTER_API_KEY not set');
    return;
  }

  const last = rows.at(-1);
  const model = 'qwen/qwen-2.5-72b-instruct';
  const { price } = priceFor(model);
  const estUsd = (last.nativeTokens + last.treeTotal) * (price.input / 1_000_000);
  if (estUsd >= 0.05) {
    console.log(`\n[live probe] skipped: estimated cost $${estUsd.toFixed(4)} >= $0.05 budget`);
    return;
  }

  console.log(`\n[live probe] running one completion per arm against ${model} (est. $${estUsd.toFixed(4)})`);
  const provider = new OpenRouterProvider({ apiKey });
  const instruction = 'Reply with exactly the word OK and nothing else.';

  // native arm: the full transcript as a single user message — expected to be
  // rejected for context length at the final checkpoint.
  const nativeText = [NATIVE_SYSTEM_PROMPT, NATIVE_TASK_MESSAGE, ...nativeParts].join('\n\n');
  try {
    const result = await provider.complete({
      model,
      system: NATIVE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${nativeText}\n\n${instruction}` }],
      maxTokens: 8,
    });
    console.log(`[live probe] native arm: UNEXPECTEDLY SUCCEEDED (${result.text.slice(0, 40)})`);
  } catch (error) {
    console.log(`[live probe] native arm: rejected as EXPECTED — ${String(error.message ?? error).slice(0, 200)}`);
  }

  // tree arm: the bounded ZoneAssembler prompt at the same checkpoint.
  composeRootSummary(store, root.id, () => TS, ROOT_KEEP);
  const assembler = new ZoneAssembler({ store, blobs, trace, tokenizer, systemContract: systemContractText, budgets: BUDGETS });
  const prompt = assembler.assemble({ toolSchemasText: TREE_TOOL_SCHEMAS_TEXT });
  const treeText = prompt.blocks.map((b) => b.text).join('\n\n');
  try {
    const result = await provider.complete({
      model,
      system: prompt.system,
      messages: [{ role: 'user', content: `${treeText}\n\n${instruction}` }],
      maxTokens: 8,
    });
    console.log(`[live probe] tree arm: succeeded as expected -> "${result.text.trim()}"`);
  } catch (error) {
    console.log(`[live probe] tree arm: UNEXPECTEDLY REJECTED — ${String(error.message ?? error).slice(0, 200)}`);
  }
}

await runLiveProbe();

store.close();
rmSync(dir, { recursive: true, force: true });

process.exitCode = failures.length === 0 ? 0 : 1;
