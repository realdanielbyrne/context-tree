/**
 * Offline forensics for one kept context-tree sandbox: reconstructs the exact
 * prompt the model saw on every turn (real ZoneAssembler, real final summaries,
 * trace capped at each turn's seq), breaks each request down by zone, and dumps
 * the final turn's full text.
 *
 * Usage: node scripts/ct-analyze.mjs <sandboxPath> <outJson> [outPromptTxt]
 */
import { openTaskStore, resolveConfig, ZoneAssembler, HeuristicTokenizer, systemContract, toCompletionRequest } from '@context-tree/core';
import { TREE_ZONE_A_TOOL_SCHEMAS_TEXT, TREE_COMPLETION_ADDENDUM } from '../dist/tools.js';
import { writeFileSync } from 'node:fs';

const [sandboxPath, outJson, outPromptTxt] = process.argv.slice(2);
if (sandboxPath === undefined || outJson === undefined) {
  console.error('usage: node scripts/ct-analyze.mjs <sandboxPath> <outJson> [outPromptTxt]');
  process.exit(1);
}

const config = resolveConfig({ root: `${sandboxPath}/.context-tree` });
const handle = openTaskStore(config);
const realTrace = handle.trace;
const tokenizer = new HeuristicTokenizer();

const events = realTrace.all();
const assistantSeqs = events.filter((e) => e.type === 'assistant_message').map((e) => e.seq);

// A read-only TraceLog shim that hides everything after `upTo`, so the real
// assembler rebuilds exactly what the model saw before turn k's completion.
function shim(upTo) {
  return {
    read(range) {
      const to = Math.min(range?.to ?? Number.MAX_SAFE_INTEGER, upTo);
      return realTrace.read({ from: range?.from ?? 1, to });
    },
    lastSeq() {
      return upTo;
    },
  };
}

const perTurn = [];
let lastRequest = null;

for (const [i, aSeq] of assistantSeqs.entries()) {
  const upTo = aSeq - 1; // the request for this turn was assembled before this assistant event existed
  const assembler = new ZoneAssembler({
    store: handle.store,
    blobs: handle.blobs,
    trace: shim(upTo),
    tokenizer,
    systemContract: systemContract() + TREE_COMPLETION_ADDENDUM,
    budgets: { zoneB: 8000, zoneC: 30000 },
  });
  const prompt = assembler.assemble({
    toolSchemasText: TREE_ZONE_A_TOOL_SCHEMAS_TEXT,
    // Mirror the harness loop's Zone C anchoring (see loop.ts).
    activeNodeId: handle.store.openPhase()?.id ?? handle.store.root()?.id,
  });
  const request = toCompletionRequest(prompt, 'claude-sonnet-5', { maxTokens: 8192 });
  perTurn.push({
    turn: i + 1,
    assistantSeq: aSeq,
    eventsUpTo: upTo,
    zoneA: prompt.budgets.zoneA,
    zoneB: prompt.budgets.zoneB,
    zoneC: prompt.budgets.zoneC,
    tail: prompt.budgets.tail,
    totalPromptTokens: prompt.budgets.total,
    systemTokens: tokenizer.count(request.system ?? ''),
    overBudget: prompt.budgets.overBudget,
    droppedFromZoneB: prompt.budgets.droppedFromZoneB.length,
    messages: request.messages.length,
  });
  lastRequest = request;
}

// Zone B summary texts — what the model is told the task state is.
const summaries = [];
for (const node of handle.store.nodesInCreationOrder()) {
  const s = handle.store.currentSummary(node.id);
  if (s !== null) {
    summaries.push({
      nodeId: node.id,
      kind: node.kind,
      title: node.title,
      phase: node.phase_type,
      status: node.status,
      version: s.version,
      text: s.text,
      files: s.meta.files.map((f) => f.path),
      open_questions: s.meta.open_questions,
      decisions: s.meta.decisions,
    });
  }
}

// The tail: last assistant text and the last few rendered Zone C events.
const lastEvents = events.slice(-6).map((e) => {
  if (e.type === 'tool_call') return { type: e.type, seq: e.seq, tool: e.tool, args: e.args_blob === undefined ? undefined : JSON.parse(handle.blobs.getText(e.args_blob)) };
  if (e.type === 'tool_result') return { type: e.type, seq: e.seq, output: e.output_blob === undefined ? undefined : handle.blobs.getText(e.output_blob).slice(0, 300) };
  return { type: e.type, seq: e.seq };
});

writeFileSync(outJson, JSON.stringify({ perTurn, summaries, lastEvents }, null, 2));
if (outPromptTxt !== undefined && lastRequest !== null) {
  const text = [
    '=== SYSTEM ===',
    lastRequest.system,
    ...lastRequest.messages.map((m) => `=== ${m.role.toUpperCase()}${m.cacheBreakpoint === true ? ' [cache]' : ''} ===\n${m.content}`),
  ].join('\n\n');
  writeFileSync(outPromptTxt, text);
}
handle.close();
console.log(JSON.stringify({ turns: perTurn.length, lastTotal: perTurn.at(-1)?.totalPromptTokens, summaries: summaries.length }));
