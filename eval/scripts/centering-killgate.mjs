#!/usr/bin/env node
/**
 * NC2/NC3: zero-live-token paired replay of within-branch centring.
 *
 * This deliberately uses one explicit historical cell and the known source
 * branch for each question. It is a mechanism gate, not an end-to-end score:
 * branch selection and model answering remain outside this replay.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FsBlobStore,
  HeuristicTokenizer,
  JsonlTraceLog,
  TreeRetriever,
  openStore,
  storePaths,
} from '@context-tree/core';
import { countTokens } from 'gpt-tokenizer';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCENARIO = join(REPO, 'eval/fixtures/transplant/s1');
const ARTIFACTS = join(SCENARIO, 'e1b289c32f40');
const DEFAULT_RESULT = join(
  ARTIFACTS,
  'results/run-W65536-tree-tail-v2-questions-deep-z-ai_glm-5.3-flash.json',
);
const DEFAULT_OUT = join(REPO, 'reports/metrics/ds-star-native-context/iteration1-offline.json');

function option(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return resolve(inline.slice(prefix.length));
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? resolve(process.argv[at + 1]) : fallback;
}

const resultPath = option('result', DEFAULT_RESULT);
const outPath = option('out', DEFAULT_OUT);
const payload = JSON.parse(readFileSync(resultPath, 'utf8'));
const questionPath = join(ARTIFACTS, 'questions-deep.json');
const questions = JSON.parse(readFileSync(questionPath, 'utf8')).questions;
const questionById = new Map(questions.map((question) => [question.id, question]));
const paths = storePaths(join(SCENARIO, 'store'));
const store = openStore(paths.db);
const blobs = new FsBlobStore(paths.blobs);
const trace = new JsonlTraceLog(paths.trace);
const tokenizer = new HeuristicTokenizer();

function truncateExact(text, budget) {
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

function replay(row, question, mode) {
  let diagnostic = null;
  const retriever = new TreeRetriever({
    store,
    blobs,
    trace,
    retrievalCenterFingerprintMode: mode,
    observeFetch: (observed) => { diagnostic = observed; },
  });
  const query = (row.searchQueries ?? []).find((value) => typeof value === 'string' && value.length > 0) ?? '';
  const promptTokens = row.turns?.[0]?.promptTokens;
  if (!Number.isFinite(promptTokens)) throw new Error(`${row.question}#${row.rep}: no first-turn promptTokens`);
  const exactHeadroom = Math.max(0, payload.budgets.window - promptTokens - payload.budgets.maxReplyTokens);
  const heuristicHeadroom = Math.floor(exactHeadroom / payload.budgets.ratio);
  const fetched = retriever.fetchBranch(question.node_id, {
    depth: 'full',
    maxTokens: heuristicHeadroom,
    query,
  });
  const literal = question.answer_literals[0];
  const toolResult = JSON.stringify({
    branch_id: fetched.nodeId,
    kind: fetched.kind,
    title: fetched.title,
    phase_type: fetched.phaseType,
    depth: fetched.depth,
    file: fetched.file ?? null,
    summary_version: fetched.summaryVersion,
    meta: fetched.meta,
    nodes: fetched.nodes,
    spans: fetched.spans,
    events: fetched.events,
    text: fetched.text,
  });
  const served = truncateExact(toolResult, exactHeadroom);
  return {
    query,
    exactHeadroom,
    heuristicHeadroom,
    centerSeq: diagnostic?.centerSeq ?? null,
    centeringTerms: diagnostic?.terms ?? [],
    spans: fetched.spans,
    renderedTokens: tokenizer.count(fetched.text),
    preCapDelivered: toolResult.includes(literal),
    servedTokens: countTokens(served),
    delivered: served.includes(literal),
    excerpt: served.includes(literal)
      ? served.slice(Math.max(0, served.indexOf(literal) - 100), served.indexOf(literal) + literal.length + 100)
      : null,
  };
}

const rows = [];
for (const row of payload.rows ?? []) {
  const question = questionById.get(row.question);
  if (question === undefined) continue;
  const legacy = replay(row, question, 'legacy');
  const candidate = replay(row, question, 'bare-filename');
  rows.push({ question: row.question, rep: row.rep, answerSeq: question.seq, legacy, candidate });
}

const summary = questions.map((question) => {
  const own = rows.filter((row) => row.question === question.id);
  return {
    question: question.id,
    n: own.length,
    legacyDelivered: own.filter((row) => row.legacy.delivered).length,
    candidateDelivered: own.filter((row) => row.candidate.delivered).length,
    mechanismFired: own.filter((row) => row.legacy.centerSeq !== row.candidate.centerSeq).length,
    candidateCenteredOnAnswer: own.filter((row) => row.candidate.centerSeq === question.seq).length,
    headroomBreaches: own.filter((row) => row.candidate.servedTokens > row.candidate.exactHeadroom).length,
  };
});
const qo04 = summary.find((row) => row.question === 's1-qo04-overflow');
const protectedRegression = summary.some((row) => row.question !== 's1-qo04-overflow' && row.candidateDelivered < row.legacyDelivered);
const passed =
  qo04?.n === 5 &&
  qo04.legacyDelivered === 0 &&
  qo04.candidateDelivered === 5 &&
  qo04.mechanismFired === 5 &&
  qo04.candidateCenteredOnAnswer === 5 &&
  !protectedRegression &&
  summary.every((row) => row.headroomBreaches === 0);
const sample = rows.find((row) => row.question === 's1-qo04-overflow');
const artifact = {
  gate: 'NC2/NC3-bare-filename-centering',
  status: passed ? 'PASS' : 'FAIL',
  scope: 'conditional centring/delivery ceiling; known correct branch; pre-append-cap',
  input: resultPath,
  questionPath,
  rows: rows.length,
  summary,
  sample,
};
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log('\nNC2/NC3 bare-filename centring replay');
console.table(summary);
console.log('\nqo04 sample:');
console.log(JSON.stringify(sample, null, 2));
console.log(`\n${artifact.status}: wrote ${outPath}`);
store.close();
trace.close();
process.exitCode = passed ? 0 : 1;
