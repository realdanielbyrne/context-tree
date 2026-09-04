#!/usr/bin/env node
/** Zero-live-token NC20--NC27 gate for the all-rank coordinate search view. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTokens } from 'gpt-tokenizer';
import { HANDLERS, CONTEXT_SEARCH, toCallToolResult } from '@context-tree/mcp';
import { TreeRetriever } from '@context-tree/core';
import { coordinateSearchData, openScenario } from './transplant.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ARTIFACTS = join(REPO, 'eval/fixtures/transplant/s1/e1b289c32f40');
const LIVE = join(ARTIFACTS, 'results/run-W65536-truncate-tail+tree-tail-v2+tree-center-filename-questions-deep-q9ebc3150-cb2b5adc512bc-n5-z-ai_glm-5.3-flash.json');
const QUESTIONS = join(ARTIFACTS, 'questions-deep.json');
const OUT = join(REPO, 'reports/metrics/ds-star-native-context/iteration2-readiness.json');
const EXPECTED_QUESTION_SHA = '9ebc3150d54dadf0c31bdbce1990cb66d4653a6688d0bccf1befd6662ef85abc';
const EXPECTED_RANK = new Map([
  ['s1-qo01-overflow', 1], ['s1-qo02-overflow', 2], ['s1-qo03-overflow', 7],
  ['s1-qo04-overflow', 1], ['s1-qo05-overflow', 1],
]);

const live = JSON.parse(readFileSync(LIVE, 'utf8'));
const questions = JSON.parse(readFileSync(QUESTIONS, 'utf8')).questions;
const questionById = new Map(questions.map((question) => [question.id, question]));
const scenario = openScenario('s1');
const gates = [];
const pass = (id, detail, evidence = {}) => gates.push({ id, status: 'PASS', detail, evidence });
const fail = (id, detail, evidence = {}) => gates.push({ id, status: 'FAIL', detail, evidence });
const textOf = (outcome) => toCallToolResult(outcome).content[0]?.text ?? '';

function truncateExact(text, budget) {
  if (budget <= 0) return '';
  if (countTokens(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countTokens(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function toolContext() {
  const config = scenario.config;
  return {
    config,
    handle: { config, paths: scenario.paths, trace: scenario.trace, blobs: scenario.blobs, store: scenario.store, close() {} },
    retriever: new TreeRetriever({
      store: scenario.store,
      blobs: scenario.blobs,
      trace: scenario.trace,
      retrievalCenterFingerprintMode: 'bare-filename',
    }),
  };
}

const arms = ['truncate-tail', 'tree-tail-v2', 'tree-center-filename'];
const epochOk = live.partial === false && live.rows?.length === 75 &&
  live.identity?.questionSha === EXPECTED_QUESTION_SHA &&
  arms.every((arm) => live.rows.filter((row) => row.arm === arm).length === 25) &&
  ['traceSha', 'storeSha', 'configSha', 'rootSha'].every((key) => typeof live.identity?.[key] === 'string');
(epochOk ? pass : fail)('NC20-epoch-input', epochOk ? 'frozen 75-row iteration-1 cell is complete' : 'iteration-1 epoch/header mismatch', {
  questionSha: live.identity?.questionSha, rows: live.rows?.length, identity: live.identity,
});

const filenameRows = live.rows.filter((row) => row.arm === 'tree-center-filename');
const rankRows = [];
let ranksOk = true;
for (const row of filenameRows) {
  const question = questionById.get(row.question);
  const wanted = new Set(question?.node_ids ?? [question?.node_id]);
  const first = row.toolCalls?.find((call) => call.name === CONTEXT_SEARCH && call.hitIds?.length > 0);
  if (first === undefined) continue;
  const index = first.hitIds.findIndex((id) => wanted.has(id));
  const rank = index < 0 ? null : index + 1;
  rankRows.push({ question: row.question, rep: row.rep, query: first.input.query, target: [...wanted], returned: first.hitIds.length, rank });
  if (rank !== EXPECTED_RANK.get(row.question)) ranksOk = false;
}
const observableRows = filenameRows.filter((row) => row.toolCalls?.some((call) => call.name === CONTEXT_SEARCH && call.hitIds?.length > 0)).length;
(ranksOk && rankRows.length === observableRows ? pass : fail)('NC21-live-rank-audit', `audited ${rankRows.length} nonempty first searches; two provider-error rows have no telemetry`, { rankRows });

const queryRecords = [];
let parityOk = true;
let serializationOk = true;
for (const row of filenameRows) {
  let sawNonemptySearch = false;
  for (const call of row.toolCalls ?? []) {
    if (call.name !== CONTEXT_SEARCH || typeof call.input?.query !== 'string' || call.hitIds?.length === 0) continue;
    const firstSearch = !sawNonemptySearch;
    sawNonemptySearch = true;
    const ctx = toolContext();
    const upstream = await HANDLERS[CONTEXT_SEARCH](ctx, call.input);
    if (!upstream.ok) { parityOk = false; continue; }
    const beforeIds = upstream.data.hits.map((hit) => hit.node_id);
    const beforeScores = upstream.data.hits.map((hit) => hit.score);
    const projected = coordinateSearchData(upstream.data);
    const afterIds = projected.hits.map((hit) => hit.node_id);
    const afterScores = projected.hits.map((hit) => hit.score);
    const bytes = textOf({ ok: true, data: projected });
    const tokens = countTokens(bytes);
    const same = JSON.stringify(beforeIds) === JSON.stringify(afterIds) && JSON.stringify(beforeScores) === JSON.stringify(afterScores);
    parityOk &&= same;
    serializationOk &&= projected.candidates.length === 0 && projected.hits.length === upstream.data.hits.length &&
      (!firstSearch || call.exactHeadroom <= 0 || tokens <= call.exactHeadroom);
    queryRecords.push({ question: row.question, rep: row.rep, query: call.input.query, upstream: beforeIds.length, visible: afterIds.length, tokens, headroom: call.exactHeadroom, firstSearch, same });
  }
}
(parityOk ? pass : fail)('NC22-one-change-parity', 'underlying IDs/order/scores are unchanged by projection', { calls: queryRecords.length });
const tokenValues = queryRecords.filter((row) => row.firstSearch).map((row) => row.tokens).sort((a, b) => a - b);
(serializationOk ? pass : fail)('NC23-coordinate-serialization', 'all upstream ranks remain visible and positive-headroom responses fit', {
  calls: queryRecords.length,
  tokens: { min: tokenValues[0], median: tokenValues[Math.floor(tokenValues.length / 2)], max: tokenValues.at(-1) },
  qo03: queryRecords.find((row) => row.question === 's1-qo03-overflow'),
});

const replayRows = [];
let replayOk = true;
for (const row of filenameRows.filter((candidate) => Array.isArray(candidate.toolCalls))) {
  const question = questionById.get(row.question);
  const literal = question.answer_literals[0];
  const ctx = toolContext();
  let savedTokens = 0;
  let lastQuery = '';
  let delivered = false;
  let targetFetch = null;
  const calls = [];
  for (const call of row.toolCalls) {
    const headroom = (call.exactHeadroom ?? 0) + savedTokens;
    let rendered = '';
    let centerSeq = null;
    if (call.name === CONTEXT_SEARCH) {
      lastQuery = call.input?.query ?? '';
      const upstream = await HANDLERS[CONTEXT_SEARCH](ctx, call.input);
      if (upstream.ok) rendered = textOf({ ok: true, data: coordinateSearchData(upstream.data) });
    } else if (call.name === 'context_fetch' && typeof call.input?.branch_id === 'string') {
      let observation = null;
      ctx.retriever = new TreeRetriever({
        store: scenario.store, blobs: scenario.blobs, trace: scenario.trace,
        retrievalCenterFingerprintMode: 'bare-filename',
        observeFetch: (value) => { observation = value; },
      });
      const fetched = ctx.retriever.fetchBranch(call.input.branch_id, {
        depth: 'full', maxTokens: Math.max(0, Math.floor(headroom / live.budgets.ratio)), query: lastQuery,
      });
      centerSeq = observation?.centerSeq ?? null;
      rendered = textOf({ ok: true, data: {
        branch_id: fetched.nodeId, kind: fetched.kind, title: fetched.title, phase_type: fetched.phaseType,
        depth: fetched.depth, file: fetched.file ?? null, summary_version: fetched.summaryVersion,
        meta: fetched.meta, nodes: fetched.nodes, spans: fetched.spans, events: fetched.events, text: fetched.text,
      }});
    }
    const served = truncateExact(rendered, headroom);
    const candidateTokens = countTokens(served);
    const originalTokens = call.afterTokens ?? 0;
    savedTokens += originalTokens - candidateTokens;
    const hasLiteral = served.includes(literal);
    delivered ||= hasLiteral;
    if (call.name === 'context_fetch' && call.input?.branch_id === question.node_id && targetFetch === null) {
      targetFetch = { headroom, centerSeq, tokens: candidateTokens, delivered: hasLiteral };
    }
    calls.push({ name: call.name, headroom, tokens: candidateTokens, centerSeq, delivered: hasLiteral });
  }
  const record = { question: row.question, rep: row.rep, delivered, targetFetch, calls };
  replayRows.push(record);
  if (row.question === 's1-qo04-overflow') replayOk &&= targetFetch?.headroom > 0 && targetFetch.centerSeq === 218 && targetFetch.delivered;
}
const qo04Replay = replayRows.filter((row) => row.question === 's1-qo04-overflow');
const qo03Replay = replayRows.filter((row) => row.question === 's1-qo03-overflow');
replayOk &&= qo04Replay.length === 4 && qo03Replay.filter((row) => row.delivered).length >= 4;
(replayOk ? pass : fail)('NC24-ordered-headroom-replay', 'compact searches leave the existing centered fetch answer-bearing', {
  qo04: qo04Replay, qo03Delivered: qo03Replay.filter((row) => row.delivered).length,
});

const boundaryInput = { query: 'q', hits: [
  { node_id: 'a', kind: 'phase', title: 'A', phase_type: null, path: null, score: 2, meta: { files: ['large'] } },
  { node_id: 'b', kind: 'file', title: 'B', phase_type: null, path: '/b', score: 1, meta: null },
], candidates: [{ node_id: 'a' }, { node_id: 'a' }] };
const boundary = coordinateSearchData(boundaryInput);
const boundaryOk = boundary.hits.length === 2 && boundary.hits[0].node_id === 'a' && boundary.hits[1].path === '/b' &&
  Object.keys(boundary.hits[0]).join(',') === 'node_id,kind,title,phase_type,path,score' && boundary.candidates.length === 0 &&
  coordinateSearchData({ hits: [], candidates: [] }).hits.length === 0;
(boundaryOk ? pass : fail)('NC25-boundaries', 'empty/null/duplicate-view projection boundaries are deterministic');

const leakedTruth = JSON.stringify(coordinateSearchData(boundaryInput)).includes('answerVisibleRank');
const provenanceOk = !leakedTruth && qo04Replay.every((row) => row.targetFetch?.delivered === true);
(provenanceOk ? pass : fail)('NC26-instrument-provenance', 'fixture truth is absent from model-visible JSON and replay delivery is post-cap');

const readinessOk = gates.every((gate) => gate.status === 'PASS');
(readinessOk ? pass : fail)('NC27-live-readiness', readinessOk ? 'authorized' : 'cancelled', {
  command: 'node eval/scripts/transplant.mjs --phase run --scenario s1 --window 65536 --arm truncate-tail,tree-center-filename,tree-search-coordinates --model z-ai/glm-5.3-flash --reps 5 --questions-file questions-deep.json',
});

const artifact = { status: gates.every((gate) => gate.status === 'PASS') ? 'PASS' : 'FAIL', input: LIVE, questions: QUESTIONS, gates };
writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
console.table(gates.map(({ id, status, detail }) => ({ id, status, detail })));
console.log(`${artifact.status}: wrote ${OUT}`);
scenario.close();
process.exitCode = artifact.status === 'PASS' ? 0 : 1;
