#!/usr/bin/env node
/**
 * Zero-live-token kill gate for LINE-GRANULARITY retrieval.
 *
 * Every retrieval result in this project so far has been measured on an index
 * whose unit is enormous relative to the answer: 21 phase summaries, or a 26KB
 * branch replay in which the answer is one line. Two rounds of work on the
 * RANKING over that index have now failed to move a live score — fingerprint +
 * grep fusion took offline top-3 from 2/12 to 11/12 with no live gain, and the
 * oracle arm (ranking made perfect by fiat) still scores 13/25 where full
 * context scores 25/25. The facet measurement said why: at 40 tokens an entry,
 * a mediocre rank costs 200 tokens and does not matter; at 26KB an entry, a
 * perfect rank still buries the answer.
 *
 * So this gate holds the machinery fixed and shrinks the UNIT. The index is one
 * entry per non-blank line of tool output — the finest unit L0 offers without
 * parsing content the tree does not own — and the rankers are the ones already
 * shipped:
 *
 *   C1   plain lexical, `uniqueTerms(question)` scored by `lexicalScore`
 *   C1'  fingerprints + exact grep + rank-reciprocal fusion (k=60), the same
 *        hybrid `TreeRetriever.search` runs on summaries
 *
 * Reported per question: the rank of the line that actually contains the answer
 * literal, and what a top-10 slice would cost to return. Pre-registered win
 * criterion: >= 10 of 17 questions with the answer line in the top 10.
 *
 *   node eval/scripts/line-index-killgate.mjs
 */
import { FsBlobStore, HeuristicTokenizer, JsonlTraceLog, storePaths } from '@context-tree/core';
import { buildLexicalIndex, extractFingerprints, lexicalScore, uniqueTerms } from '../../packages/core/dist/retrieve/lexical.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ARTIFACTS = join(REPO, 'eval/fixtures/transplant/s1/e1b289c32f40');
/** The retriever's own fusion constant, reused so the comparison is unit, not tuning. */
const RRF_K = 60;
/** Pre-registered: the depth a search result can actually afford to return. */
const TOP_N = 10;
const WIN_AT = 10;

const paths = storePaths(join(REPO, 'eval/fixtures/transplant/s1/store'));
const trace = new JsonlTraceLog(paths.trace);
const blobs = new FsBlobStore(paths.blobs);
const tok = new HeuristicTokenizer();

/**
 * The line index: one entry per line of tool output, carrying its seq so a hit
 * is a COORDINATE into L0 (the invariant: L1 never stores content). Bounded at
 * both ends — a line under 8 characters carries no query signal, and one over
 * 200 is a minified blob or a base64 payload, not a fact a person asks about.
 */
function buildLineIndex() {
  const entries = [];
  for (const event of trace.all()) {
    if (event.type !== 'tool_result') continue;
    const text = event.output_blob == null ? '' : blobs.get(event.output_blob).toString('utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.length < 8 || line.length > 200) continue;
      entries.push({ seq: event.seq, line });
    }
  }
  return entries;
}

const lines = buildLineIndex();
const docs = lines.map((l) => l.line);
const index = buildLexicalIndex(docs);

/** C1: the plain lexical ranker, over lines. */
function rankLexical(question) {
  const qTerms = uniqueTerms(question);
  return lines
    .map((l, i) => ({ i, score: lexicalScore(index, qTerms, docs[i]) }))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.i);
}

/**
 * C1': the shipped hybrid, over lines. Fingerprints pull the distinctive tokens
 * out of the question (paths, identifiers, quoted spans); grep is exact and
 * therefore authoritative where it fires; RRF fuses the two orders without
 * either dominating.
 */
function rankHybrid(question) {
  const lexOrder = rankLexical(question);
  const distinctive = [...extractFingerprints(question)];
  const grepOrder = [];
  if (distinctive.length > 0) {
    const scored = [];
    for (let i = 0; i < lines.length; i += 1) {
      let hits = 0;
      for (const term of distinctive) if (docs[i].includes(term)) hits += 1;
      if (hits > 0) scored.push({ i, hits });
    }
    scored.sort((a, b) => b.hits - a.hits);
    for (const s of scored) grepOrder.push(s.i);
  }
  const rr = new Map();
  const add = (order) => {
    order.forEach((idx, rank) => rr.set(idx, (rr.get(idx) ?? 0) + 1 / (RRF_K + rank + 1)));
  };
  add(lexOrder);
  add(grepOrder);
  return [...rr.entries()].sort((a, b) => b[1] - a[1]).map(([idx]) => idx);
}

const questions = [
  ...JSON.parse(readFileSync(join(ARTIFACTS, 'questions-deep.json'), 'utf8')).questions,
  ...JSON.parse(readFileSync(join(ARTIFACTS, 'questions.json'), 'utf8')).questions,
];

console.log(`line index: ${lines.length} entries from tool output, ${tok.count(docs.join('\n'))} tokens whole`);
console.log(`ranking over lines; win criterion pre-registered at answer-in-top-${TOP_N} for >= ${WIN_AT}/${questions.length}\n`);
console.log('question            kind      C1 rank   C1\' rank   top-10 payload');

const tally = { c1: 0, hybrid: 0, absent: 0 };
for (const q of questions) {
  const holds = (i) => q.answer_literals.every((literal) => docs[i].includes(literal));
  const present = docs.some((_, i) => holds(i));
  if (!present) {
    tally.absent += 1;
    console.log(`  ${q.id.replace('s1-', '').padEnd(18)} ${(q.kind ?? '').padEnd(9)} ABSENT — no single output line carries every answer literal`);
    continue;
  }
  const c1 = rankLexical(q.question).findIndex(holds) + 1;
  const order = rankHybrid(q.question);
  const hy = order.findIndex(holds) + 1;
  if (c1 >= 1 && c1 <= TOP_N) tally.c1 += 1;
  if (hy >= 1 && hy <= TOP_N) tally.hybrid += 1;
  const payload = tok.count(order.slice(0, TOP_N).map((i) => `[${lines[i].seq}] ${lines[i].line}`).join('\n'));
  console.log(
    `  ${q.id.replace('s1-', '').padEnd(18)} ${(q.kind ?? '').padEnd(9)} ${String(c1).padStart(7)}   ${String(hy).padStart(8)}   ${payload} tok`,
  );
}
trace.close();

console.log(`\nC1  (plain lexical over lines): ${tally.c1}/${questions.length} in top-${TOP_N}`);
console.log(`C1' (fingerprint + grep + RRF): ${tally.hybrid}/${questions.length} in top-${TOP_N}`);
console.log(`absent from the line index entirely: ${tally.absent}/${questions.length}`);
const winner = tally.hybrid >= WIN_AT;
console.log(
  `\n${winner ? 'PASS' : 'FAIL'}: C1' ${winner ? 'clears' : 'misses'} the pre-registered ${WIN_AT}/${questions.length} gate` +
    `${winner ? ' — it earns a live arm.' : ' — embeddings (C2) get their shot, or the hypothesis is retired.'}`,
);
if (!winner) process.exitCode = 1;
