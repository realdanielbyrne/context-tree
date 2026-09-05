#!/usr/bin/env node
/**
 * Zero-live-token gate for per-turn window management (plan 2026-09-04 pm, §3.1).
 *
 * Replays the tool calls the model ACTUALLY issued in the recorded W=131,072 deep
 * batches through the real handlers, but under the elastic tail: before every
 * call the raw tail is recomputed to fill exactly what the prefix, the question
 * and the appended results leave, so a result is budgeted against the space
 * eviction creates. Assistant text is stood in by a block of the recorded size
 * (`turns[i].output`); the fixtures hold no transcript.
 *
 * Gates:
 *   EG1 every request ≤ W − reply                       (hard; 0 overflows)
 *   EG2 report: appended results still truncated. The cap already budgets a result against the
 *       space the tail can yield, so a remaining cut means the result alone exceeded
 *       W − prefix − appended − reply: the window is genuinely full. Recorded figure alongside.
 *   EG3 report: tail-moving turns per run, fresh tokens re-sent when the tail moves
 *   EG4 report: recorded calls cut WITHOUT the literal that now arrive whole WITH it
 *   EG5 the null arms' prompts fit at W=131,072 for every deep question (prefill included)
 *
 *   node eval/scripts/elastic-tail-killgate.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TreeRetriever } from '@context-tree/core';
import {
  appendHeadroom, buildArm, budgetsFor, capToolResult, exact, handlersForArm, openScenario, ratioVerdict, requestTokens,
} from './transplant.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ART = join(REPO, 'eval/fixtures/transplant/s1/e1b289c32f40');
const W = 131_072;
const files = readdirSync(join(ART, 'results')).filter((f) => f.startsWith('run-W131072-') && f.includes('questions-deep')).sort();
const questions = JSON.parse(readFileSync(join(ART, 'questions-deep.json'), 'utf8')).questions;
const manifest = JSON.parse(readFileSync(join(ART, 'manifest.json'), 'utf8'));

const scenario = openScenario('s1');
const ratio = manifest.ratio;
const budgets = budgetsFor(scenario, W, ratio, ratioVerdict(ratio).slackFraction, 'tree-snippet-hits-elastic');
const built = await buildArm(scenario, 'tree-snippet-hits-elastic', budgets, {});
const MESSAGE_OVERHEAD_TOKENS = 4;
const REQUEST_MARGIN_TOKENS = 64;

const toolCtx = () => {
  const ctx = {
    config: scenario.config,
    handle: { config: scenario.config, paths: scenario.paths, trace: scenario.trace, blobs: scenario.blobs, store: scenario.store, close() {} },
    retriever: new TreeRetriever({ store: scenario.store, blobs: scenario.blobs, trace: scenario.trace, retrievalCenterFingerprintMode: 'bare-filename' }),
    _searchObservations: [], _fetchObservations: [],
  };
  ctx.retriever.observeFetch = undefined;
  return ctx;
};
const handlers = handlersForArm('tree-snippet-hits-elastic');

let fullWindowCuts = 0;
let evictedResults = 0;
let overflows = 0, truncated = 0, recordedTruncated = 0, calls = 0, recovered = 0, recoverable = 0, movedTurns = 0, movedFresh = 0, runs = 0;
const perFile = [];
for (const file of files) {
  const rows = JSON.parse(readFileSync(join(ART, 'results', file), 'utf8')).rows.filter((r) => r.arm !== 'truncate-tail' && (r.toolCalls ?? []).length > 0);
  let fOver = 0, fTrunc = 0, fRec = 0, fMoved = 0;
  for (const row of rows) {
    runs += 1;
    const q = questions.find((x) => x.id === row.question);
    const ctx = toolCtx();
    ctx._oracleNodeIds = q.node_ids;
    const messages = [...built.messages, { role: 'user', content: q.question }];
    let tailFrom = 0;
    let seenCount = 0;
    const wire = () => {
      const limit = W - budgets.maxReplyTokens - REQUEST_MARGIN_TOKENS - MESSAGE_OVERHEAD_TOKENS;
      for (let i = built.messages.length; i < seenCount && requestTokens({ system: built.system, messages, tools: built.tools }) > limit; i += 1) {
        const m = messages[i];
        if (m.role === 'user' && m.content.startsWith('[tool_result ') && !m.content.endsWith('evicted to fit the window]')) {
          const name = m.content.slice('[tool_result '.length).split(']')[0];
          messages[i] = { role: 'user', content: `[tool_result ${name}: earlier result evicted to fit the window]` };
          evictedResults += 1;
        }
      }
      const fixed = requestTokens({ system: built.system, messages, tools: built.tools });
      const budget = W - fixed - budgets.maxReplyTokens - REQUEST_MARGIN_TOKENS - MESSAGE_OVERHEAD_TOKENS - exact.count(`${built.elastic.header}\n`);
      let tail = built.elastic.tail(Math.max(0, budget), tailFrom);
      const moved = tailFrom !== 0 && tail.fromSeq > tailFrom;
      if (moved) tail = built.elastic.tail(Math.max(0, budget - budgets.maxReplyTokens), tailFrom);
      tailFrom = Math.max(tailFrom, tail.fromSeq);
      const request = tail.events === 0
        ? messages
        : [...built.messages, { role: 'user', content: `${built.elastic.header}\n${tail.text}` }, ...messages.slice(built.messages.length)];
      seenCount = messages.length;
      return { request, moved, tailTokens: exact.count(tail.text), tailEvents: tail.events };
    };
    const byTurn = new Map();
    for (const tc of row.toolCalls) { if (!byTurn.has(tc.turn)) byTurn.set(tc.turn, []); byTurn.get(tc.turn).push(tc); }
    for (const [turn, tcs] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
      const { request, moved, tailTokens, tailEvents } = wire();
      const sent = requestTokens({ system: built.system, messages: request, tools: built.tools });
      if (sent + budgets.maxReplyTokens > W) { overflows += 1; fOver += 1; console.log(`  EG1 overflow: ${file.slice(13, 40)} ${row.arm} ${row.question.slice(3, 7)} rep${row.rep} turn ${turn}: sent ${sent} + reply ${budgets.maxReplyTokens} > ${W}; tail events ${tailEvents}, tail tokens ${tailTokens}`); }
      if (moved) { movedTurns += 1; fMoved += 1; movedFresh += tailTokens; }
      const out = row.turns?.find((t) => t.turn === turn)?.output ?? 20;
      messages.push({ role: 'assistant', content: 'x '.repeat(Math.max(1, Math.floor(out / 1))) });
      for (const tc of tcs) {
        calls += 1;
        const live = appendHeadroom({ prefix: `[tool_result ${tc.name}] `, system: built.system, messages, tools: built.tools, window: W, maxReplyTokens: budgets.maxReplyTokens });
        ctx._liveHeadroom = live; ctx._liveHeadroomHeuristic = Math.floor(live / ratio);
        const handler = handlers[tc.name];
        const outcome = handler ? await handler(ctx, tc.input) : { ok: false, error: { message: 'unknown tool' } };
        let text = outcome.ok ? JSON.stringify(outcome.data) : `error: ${outcome.error?.message}`;
        if (tc.name === 'context_search' && outcome.ok && Array.isArray(outcome.data?.hits)) text = JSON.stringify({ ...outcome.data, hits: outcome.data.hits.map(({ snippet, text: _t, ...rest }) => rest) });
        const capped = capToolResult({ text, prefix: `[tool_result ${tc.name}] `, system: built.system, messages, tools: built.tools, window: W, maxReplyTokens: budgets.maxReplyTokens });
        if (capped.droppedChars > 0) { truncated += 1; fTrunc += 1; if (tailEvents === 0) fullWindowCuts += 1; }
        if (tc.droppedChars > 0) recordedTruncated += 1;
        if (tc.droppedChars > 0 && tc.answerLiteralPresentAfterCap === false) {
          recoverable += 1;
          if (q.answer_literals.some((l) => capped.text.includes(l))) { recovered += 1; fRec += 1; }
        }
        messages.push({ role: 'user', content: `[tool_result ${tc.name}] ${capped.text}` });
      }
    }
  }
  perFile.push({ file: file.slice(13, 75), runs: rows.length, overflows: fOver, truncated: fTrunc, recoveredLiterals: fRec, tailMoves: fMoved });
}
console.table(perFile);
console.log(`EG1 overflows: ${overflows} (over ${runs} runs) ${overflows === 0 ? 'PASS' : 'FAIL'}`);
console.log(`EG2 results still truncated: ${truncated}/${calls} (recorded: ${recordedTruncated}/${calls}); of these, ${fullWindowCuts} had the tail already exhausted at the previous send`);
console.log(`EG1b already-seen appended results evicted once the tail was exhausted: ${evictedResults}`);
console.log(`EG3 tail moved on ${movedTurns} turns; fresh tail tokens re-sent on those turns: ${movedFresh} (mean ${movedTurns ? Math.round(movedFresh / movedTurns) : 0})`);
console.log(`EG4 recorded cut-without-literal calls that now arrive with the literal: ${recovered}/${recoverable}`);

// EG5: null arms fit at W for every deep question, prefill included.
let eg5Fail = 0;
for (const arm of ['flat-events', 'prefix-plus-retrieval']) {
  const b = budgetsFor(scenario, W, ratio, ratioVerdict(ratio).slackFraction, arm);
  const nb = await buildArm(scenario, arm, b, {});
  for (const q of questions) {
    const ctx = toolCtx();
    const messages = [...nb.messages, { role: 'user', content: q.question }];
    let prefillHits = null;
    if (typeof nb.prefill === 'function') {
      const remaining = appendHeadroom({ prefix: '', system: nb.system, messages, tools: nb.tools, window: W, maxReplyTokens: b.maxReplyTokens });
      const filled = await nb.prefill(q.question, ctx, Math.max(0, remaining));
      messages.push({ role: 'user', content: filled.content });
      prefillHits = `${filled.hits}/${filled.available}` + (q.answer_literals.some((l) => filled.content.includes(l)) ? ' literal✓' : ' literal✗');
    }
    let request = messages;
    if (nb.elastic) {
      const fixed = requestTokens({ system: nb.system, messages, tools: nb.tools });
      const tail = nb.elastic.tail(Math.max(0, W - fixed - b.maxReplyTokens - REQUEST_MARGIN_TOKENS - MESSAGE_OVERHEAD_TOKENS - exact.count(`${nb.elastic.header}\n`)), 0);
      request = [{ role: 'user', content: `${nb.elastic.header}\n${tail.text}` }, ...messages];
    }
    const sent = requestTokens({ system: nb.system, messages: request, tools: nb.tools });
    const ok = sent + b.maxReplyTokens <= W;
    if (!ok) eg5Fail += 1;
    console.log(`EG5 ${arm.padEnd(22)} ${q.id.slice(3, 7)} request ${sent} tokens ${ok ? 'fits' : 'OVER'}${prefillHits ? ` prefill ${prefillHits}` : ''}`);
  }
}
console.log(eg5Fail === 0 ? 'EG5 PASS' : `EG5 FAIL (${eg5Fail})`);
process.exit(overflows === 0 && eg5Fail === 0 ? 0 : 1);
