#!/usr/bin/env node
/**
 * Phase 3 recall probe (hier-verdict.md item 13) — LIVE. Builds the same
 * 200-branch marathon store as `marathon.mjs`, but gives phase 10 distinctive,
 * fetchable content ("loader hardening"), then asks claude-sonnet-5 to recall
 * it under three conditions:
 *
 *   A. folded (rootKeep=40)   + vocabulary-free question   — THE probe
 *   B. folded (rootKeep=40)   + vocabulary question         — retrieval control
 *   C. unfolded (rootKeep=Inf)+ vocabulary-free question    — visibility control
 *
 * n=5 replicates per condition, max 6 turns each, real Anthropic API calls
 * (no temperature pinning — current Claude models reject it; the 5 replicates
 * ARE the variance control). The store build is deterministic and offline;
 * only the probe turns themselves spend real tokens. A cost cap (MeteredProvider
 * + InMemoryCostMeter) stops the run before it can exceed the $1.50 budget.
 *
 * The context tools dispatch through the SAME `HANDLERS` the MCP server and
 * eval/src/loop.ts's tree arm use (packages/mcp `tools/index.js`), against a
 * TaskStore-shaped handle wrapping the in-memory store built here. `annotate`
 * is deliberately NOT offered: it re-runs the full hermetic ingest pipeline
 * (packages/core/src/ingest/ingest.ts) over L0 from scratch, re-segmenting by
 * tool-name -> phase rules that do not match this script's hand-built phase
 * boundaries (each cycle here is ONE phase; the real segmenter would split
 * each into diagnosis+implementation on the Read/Write tool-phase change) —
 * calling it would re-mint node ids and could silently corrupt the very tree
 * this probe is testing. context_fetch/context_search/context_peek are pure
 * reads in Mode A (tool-backend, the default) and touch L0 not at all.
 *
 * Usage: ANTHROPIC_API_KEY (workspace .env) + `node eval/scripts/recall-probe.mjs`
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnthropicProvider,
  CostCapExceededError,
  FsBlobStore,
  HeuristicTokenizer,
  InMemoryCostMeter,
  JsonlTraceLog,
  MeteredProvider,
  TreeRetriever,
  ZoneAssembler,
  addUsage,
  composeRootSummary,
  loadDotEnv,
  openInMemoryStore,
  resolveConfig,
  storePaths,
  systemContract,
  toMessages,
} from '@context-tree/core';
import {
  CONTEXT_FETCH,
  CONTEXT_FETCH_DESCRIPTION,
  CONTEXT_PEEK,
  CONTEXT_PEEK_DESCRIPTION,
  CONTEXT_SEARCH,
  CONTEXT_SEARCH_DESCRIPTION,
  HANDLERS,
  toCallToolResult,
} from '@context-tree/mcp';

// ── config ───────────────────────────────────────────────────────────────
const BRANCHES = 200;
const ROOT_KEEP = 40;
const MAX_TURNS = 6;
const REPS = 5;
const MODEL = 'claude-sonnet-5';
const MAX_REPLY_TOKENS = 600;
const COST_CAP_USD = 1.45; // stay under the $1.50 budget; the meter stops the NEXT call once past this
const TS = '2026-01-01T00:00:00.000Z';
const PHASE_10_INDEX = 10;

const tokenizer = new HeuristicTokenizer();
const config = resolveConfig({});

// ── L0/L2/L1 setup — real core pipeline, same shape as marathon.mjs ────────
const dir = mkdtempSync(join(tmpdir(), 'ct-recall-probe-'));
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

/** Generic stub cycle — identical to marathon.mjs's addCycle for i !== 10. */
function addGenericCycle(i) {
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
    blob: blobs.put(`Reading ${path}, applying the additive-offset pattern, and running the module's unit test.`),
  });
  const readCall = trace.append({
    type: 'tool_call',
    ts: TS,
    tool: 'Read',
    path,
    blob: blobs.put(`// mod_${pad} v0 (stub)\nexport function noopMod${pad}() {\n  return 0;\n}\n`),
  });
  trace.append({ type: 'tool_result', ts: TS, call_seq: readCall.seq, output_blob: blobs.put(`read 4 lines from ${path}`) });
  const writeCall = trace.append({
    type: 'tool_call',
    ts: TS,
    tool: 'Write',
    path,
    blob: blobs.put(`// mod_${pad} v1\nexport function computeMod${pad}(x) {\n  return x + ${i};\n}\n`),
  });
  trace.append({ type: 'tool_result', ts: TS, call_seq: writeCall.seq, output_blob: blobs.put(`wrote ${path} (4 lines)`) });
  const verifyCall = trace.append({ type: 'tool_call', ts: TS, tool: 'Bash', args_blob: blobs.put(`npm test -- mod_${pad}`) });
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
  store.insertNode({ id: `f${pad}`, parent_id: node.id, kind: 'file', title: path, span_start_seq: writeCall.seq, span_end_seq: writeCall.seq, meta_json: { path } });
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
    }),
    created_at: TS,
  });
}

/**
 * Phase 10 — distinctive, fetchable content per the recall-probe spec. Its
 * own summary row (below) is what beamSearch's lexical index actually reads
 * (packages/core/src/retrieve/lexical.ts summaryDocument): title + summary
 * text + file/symbol pointers. It carries none of the generic "mod_XXXX"
 * vocabulary the other 199 branches share, so it is the one outlier document
 * in the corpus — which is exactly what makes it findable AT ALL once a
 * search is issued with the right (or a lucky) query.
 */
function addLoaderHardeningCycle() {
  const path = 'src/loader.py';
  const start = trace.lastSeq() + 1;
  trace.append({
    type: 'user_message',
    ts: TS,
    blob: blobs.put("Fix loader.py: it's OOMing on large ingest batches. Find a safe batch size and add a regression test."),
  });
  trace.append({
    type: 'assistant_message',
    ts: TS,
    blob: blobs.put('Reading loader.py, capping the batch size, and verifying with the loader test suite.'),
  });
  const readCall = trace.append({
    type: 'tool_call',
    ts: TS,
    tool: 'Read',
    path,
    blob: blobs.put(
      'def ingest_batches(records):\n    BATCH_SIZE = 500\n    for i in range(0, len(records), BATCH_SIZE):\n        yield records[i:i + BATCH_SIZE]\n',
    ),
  });
  trace.append({ type: 'tool_result', ts: TS, call_seq: readCall.seq, output_blob: blobs.put(`read 4 lines from ${path}`) });
  const writeCall = trace.append({
    type: 'tool_call',
    ts: TS,
    tool: 'Write',
    path,
    blob: blobs.put(
      'def ingest_batches(records):\n    BATCH_SIZE = 50  # capped to avoid an OOM on large ingest batches; revisit when streaming lands\n    for i in range(0, len(records), BATCH_SIZE):\n        yield records[i:i + BATCH_SIZE]\n',
    ),
  });
  trace.append({ type: 'tool_result', ts: TS, call_seq: writeCall.seq, output_blob: blobs.put(`wrote ${path} (4 lines)`) });
  const verifyCall = trace.append({ type: 'tool_call', ts: TS, tool: 'Bash', args_blob: blobs.put('pytest tests/test_loader.py') });
  trace.append({
    type: 'tool_result',
    ts: TS,
    call_seq: verifyCall.seq,
    output_blob: blobs.put('PASS test_loader_batch_size (1 passed, 0 failed) - ingest_batches no longer OOMs at BATCH_SIZE=50'),
  });
  const end = trace.lastSeq();

  const node = store.insertNode({
    id: 'p0010',
    parent_id: root.id,
    kind: 'phase',
    title: 'loader hardening',
    phase_type: 'implementation',
    span_start_seq: start,
    span_end_seq: end,
    status: 'closed',
  });
  store.insertNode({ id: 'f0010', parent_id: node.id, kind: 'file', title: path, span_start_seq: writeCall.seq, span_end_seq: writeCall.seq, meta_json: { path } });
  store.updateNode(root.id, { span_end_seq: end });

  store.putSummary({
    node_id: node.id,
    model: 'mock-leaf-deterministic',
    text: 'Capped the loader batch size at 50 to avoid an out-of-memory crash in ingest_batches(); revisit when streaming lands.',
    meta: emptyMeta({
      node_ids: [node.id],
      files: [{ path, start_line: 1, end_line: 4, symbol: 'ingest_batches' }],
      symbols: ['ingest_batches', 'BATCH_SIZE'],
      tests: [{ name: 'test_loader_batch_size', status: 'passed' }],
      decisions: ['capped the loader batch size at 50 to avoid an OOM in ingest_batches() as a stopgap'],
      open_questions: ['revisit the batch size cap once streaming lands'],
    }),
    created_at: TS,
  });
}

for (let i = 1; i <= BRANCHES; i += 1) {
  if (i === PHASE_10_INDEX) addLoaderHardeningCycle();
  else addGenericCycle(i);
}

// ── the 3 read-only §9 tools as native Anthropic tool schemas ──────────────
// `annotate` is deliberately excluded — see the file header.
const CONTEXT_TOOL_SCHEMAS_QA = [
  {
    name: CONTEXT_FETCH,
    description: CONTEXT_FETCH_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        branch_id: { type: 'string', description: 'Node id of the branch to read, as returned by context_search.' },
        depth: { type: 'string', enum: ['summary', 'full'], description: "'summary' (default) or 'full' replay." },
        file: { type: 'string', description: 'Repo-relative path: narrow the fetch to one file node.' },
      },
      required: ['branch_id'],
      additionalProperties: false,
    },
  },
  {
    name: CONTEXT_SEARCH,
    description: CONTEXT_SEARCH_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in words.' },
        kind: { type: 'string', enum: ['task', 'phase', 'file', 'turn'] },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: CONTEXT_PEEK,
    description: CONTEXT_PEEK_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Node to excerpt.' },
        max_chars: { type: 'number', description: 'Excerpt length cap.' },
      },
      required: ['node_id'],
      additionalProperties: false,
    },
  },
];

const QA_ADDENDUM = [
  '',
  '# Answering this question',
  "You are being asked a single question about this task's history. The branch summaries above may",
  'omit older branches entirely (see any "folded" line in the task summary) — use context_search,',
  'context_fetch, or context_peek if you need to recall detail not shown above.',
  'When you are ready, reply with your final answer in plain text and make NO further tool call:',
  'a reply with no tool call ends the conversation.',
].join('\n');

const systemContractText = systemContract() + QA_ADDENDUM;

function buildPrompt(rootKeep) {
  composeRootSummary(store, root.id, () => TS, rootKeep);
  const assembler = new ZoneAssembler({
    store,
    blobs,
    trace,
    tokenizer,
    systemContract: systemContractText,
    budgets: { ...config.budgets },
  });
  return assembler.assemble({ toolSchemasText: JSON.stringify(CONTEXT_TOOL_SCHEMAS_QA) });
}

// ── ToolContext — same shape openTaskStore() returns, wrapping our in-memory store ──
const handle = {
  config,
  paths: storePaths(config.root),
  trace,
  blobs,
  store,
  close() {},
};
const retriever = new TreeRetriever({ store, blobs, trace }); // no `embed` -> beam fallback, always
const toolCtx = { config, handle, retriever };

// ── conditions ───────────────────────────────────────────────────────────
const Q_VOCAB_FREE =
  'We need to undo the temporary limit we agreed on early in this task. What was it, what value did we set, and in which file?';
const Q_VOCAB = 'What did we decide about the loader batch size cap?';

const CONDITIONS = [
  { id: 'A', label: 'folded + vocab-free (THE probe)', rootKeep: ROOT_KEEP, question: Q_VOCAB_FREE },
  { id: 'B', label: 'folded + vocab (retrieval control)', rootKeep: ROOT_KEEP, question: Q_VOCAB },
  { id: 'C', label: 'unfolded + vocab-free (visibility control)', rootKeep: Number.POSITIVE_INFINITY, question: Q_VOCAB_FREE },
];

// ── cost-capped provider ────────────────────────────────────────────────
loadDotEnv();
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY not set (checked process.env and workspace .env). Aborting.');
  process.exit(1);
}
const meter = new InMemoryCostMeter({ capUsd: COST_CAP_USD });
const provider = new MeteredProvider(new AnthropicProvider({ apiKey }), meter);

function factScore(text) {
  const lower = text.toLowerCase();
  const fact1 = /batch[\s-]*size/.test(lower) || /batch\s*cap/.test(lower);
  const fact2 = /\b50\b/.test(text);
  const fact3 = /loader|ingest_batches/.test(lower);
  return { fact1, fact2, fact3, score: (fact1 ? 1 : 0) + (fact2 ? 1 : 0) + (fact3 ? 1 : 0) };
}

async function runOneReplicate(condition, prompt) {
  const messages = [...toMessages(prompt), { role: 'user', content: condition.question }];
  const searchQueries = [];
  const fetchedIds = [];
  const searchPaths = new Set();
  const fallbacks = new Set();
  let retrievedPhase10 = false;
  let totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let finalText = '';
  let status = 'turn_cap';
  let turnsUsed = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    turnsUsed = turn;
    const request = {
      model: MODEL,
      system: prompt.system,
      messages,
      tools: CONTEXT_TOOL_SCHEMAS_QA,
      maxTokens: MAX_REPLY_TOKENS,
    };
    const result = await provider.complete(request);
    totalUsage = addUsage(totalUsage, result.usage);
    messages.push({ role: 'assistant', content: result.text.length > 0 ? result.text : '(invoking tool)' });

    if (result.toolCalls.length === 0) {
      finalText = result.text;
      status = 'completed';
      break;
    }

    for (const call of result.toolCalls) {
      if (call.name === CONTEXT_SEARCH && typeof call.input.query === 'string') searchQueries.push(call.input.query);
      if (call.name === CONTEXT_FETCH && typeof call.input.branch_id === 'string') fetchedIds.push(call.input.branch_id);

      const handler = HANDLERS[call.name];
      const outcome = handler
        ? await handler(toolCtx, call.input)
        : { ok: false, error: { code: 'invalid_input', message: `unknown tool: ${call.name}` } };
      const wire = toCallToolResult(outcome);
      const text = wire.content[0]?.text ?? '';
      if (text.includes('p0010') || text.toLowerCase().includes('ingest_batches')) retrievedPhase10 = true;
      if (call.name === CONTEXT_SEARCH && outcome.ok) {
        searchPaths.add(outcome.data.path);
        if (outcome.data.fallback) fallbacks.add(outcome.data.fallback);
      }
      messages.push({ role: 'user', content: `[tool_result ${call.name}] ${text}` });
    }
  }

  const facts = factScore(finalText);
  return {
    status,
    turnsUsed,
    finalText,
    searchQueries,
    fetchedIds,
    retrievedPhase10,
    searchPaths: [...searchPaths],
    fallbacks: [...fallbacks],
    usage: totalUsage,
    facts,
  };
}

// ── run the matrix ──────────────────────────────────────────────────────
const results = [];
let capHit = false;

for (const condition of CONDITIONS) {
  if (capHit) break;
  const prompt = buildPrompt(condition.rootKeep);
  console.log(
    `\n=== Condition ${condition.id}: ${condition.label} ===\nquestion: "${condition.question}"\nprompt tokens: total=${prompt.budgets.total} zoneB=${prompt.budgets.zoneB} overBudget=${prompt.budgets.overBudget.join(',') || '-'}`,
  );
  for (let rep = 1; rep <= REPS; rep += 1) {
    try {
      const r = await runOneReplicate(condition, prompt);
      results.push({ condition: condition.id, rep, ...r });
      const totalTok = r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite;
      console.log(
        `  rep ${rep}: status=${r.status} turns=${r.turnsUsed} searched=${r.searchQueries.length > 0} fetched=${r.fetchedIds.length > 0} retrieved=${r.retrievedPhase10} facts=${r.facts.score}/3 tokens=${totalTok} spend=$${meter.totalUsd().toFixed(3)}`,
      );
      if (r.searchQueries.length > 0) console.log(`    queries: ${JSON.stringify(r.searchQueries)}`);
      console.log(`    final: ${r.finalText.slice(0, 200).replace(/\n/g, ' ')}`);
    } catch (error) {
      if (error instanceof CostCapExceededError) {
        console.log(`\n[cost cap] stopped at $${meter.totalUsd().toFixed(3)} (cap $${COST_CAP_USD}) — remaining runs skipped`);
        capHit = true;
        break;
      }
      console.log(`  rep ${rep}: ERROR ${error.message}`);
      results.push({ condition: condition.id, rep, status: 'error', error: error.message, facts: { score: 0 }, retrievedPhase10: false, searchQueries: [], fetchedIds: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────
console.log('\n\n=== RESULTS TABLE ===');
console.log('| cond | rep | searched | fetched | retrieved | facts | turns | tokens | status |');
console.log('| --- | --: | --- | --- | --- | --: | --: | --: | --- |');
for (const r of results) {
  const tok = r.usage ? r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite : 0;
  console.log(
    `| ${r.condition} | ${r.rep} | ${r.searchQueries?.length > 0} | ${r.fetchedIds?.length > 0} | ${r.retrievedPhase10} | ${r.facts?.score ?? 0}/3 | ${r.turnsUsed ?? '-'} | ${tok} | ${r.status} |`,
  );
}

console.log('\n=== search path executed ===');
const allPaths = new Set();
const allFallbacks = new Set();
for (const r of results) {
  for (const p of r.searchPaths ?? []) allPaths.add(p);
  for (const f of r.fallbacks ?? []) allFallbacks.add(f);
}
console.log(
  allPaths.size === 0
    ? 'no context_search calls were made in any run'
    : `path(s): ${[...allPaths].join(', ')}; fallback reason(s): ${[...allFallbacks].join(', ') || 'none'} (no embedder was configured, so this is ALWAYS the lexical beam-search fallback over stored summary text — never a vector/kNN search, and no §9.1 registry/grep provider was wired either)`,
);

console.log('\n=== verdict ===');
for (const condition of CONDITIONS) {
  const rows = results.filter((r) => r.condition === condition.id);
  if (rows.length === 0) {
    console.log(`${condition.id}: no runs completed (cost cap hit before this condition)`);
    continue;
  }
  const successes = rows.filter((r) => (r.facts?.score ?? 0) >= 2).length;
  console.log(
    `${condition.id} (${condition.label}): ${successes}/${rows.length} runs recovered >=2/3 facts -> ${successes >= 4 && rows.length >= 5 ? 'PASS (>=4/5)' : 'FAIL (<4/5 or incomplete)'}`,
  );
}

const finalSpend = meter.snapshot();
console.log(`\nTotal spend: $${finalSpend.totalUsd.toFixed(4)} (cap $${COST_CAP_USD})`);
if (finalSpend.entries.some((e) => e.calls > 0)) {
  for (const e of finalSpend.entries) console.log(`  ${e.model}: ${e.calls} calls, $${e.usd.toFixed(4)}`);
}

store.close();
rmSync(dir, { recursive: true, force: true });
