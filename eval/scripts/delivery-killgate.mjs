#!/usr/bin/env node
/**
 * Zero-live-token gate on DELIVERY, not on ranking.
 *
 * `tree-oracle` hands the model the question's own source branch, ranked first,
 * with every distractor removed. It scores 13/25 on the deep set against a
 * 25/25 ground truth, and the multi-index report read that residual as
 * post-retrieval loss — the model failing to extract an answer it had been
 * given. That reading assumes the answer was delivered. This gate checks the
 * assumption.
 *
 * A branch is not a payload. `fetchBranch` narrows a branch to the live
 * per-call headroom, growing a band outward from the events the query matches,
 * so a 57,000-token branch reaching a model with 8,000 tokens of headroom
 * arrives as one seventh of itself — centred wherever the query's terms
 * happened to match. Whether the answer is inside that band is a property of
 * the query, the branch size and the headroom, and it is measurable offline.
 *
 * So: for every question, replay the search queries the model ACTUALLY issued
 * (read from the recorded run, so the queries are the model's own and not a
 * flattering invention) through the real narrowing path, at a sweep of
 * headrooms spanning the live range, and report the smallest headroom at which
 * the delivered text still contains the answer.
 *
 * The gate that this replaces swept synthetic budgets of 2,000-16,000 tokens
 * and passed 20/20 while the live delivered payload did not move — an offline
 * axis that did not overlap the live one. This one takes its budgets and its
 * queries from the runs themselves.
 *
 *   node eval/scripts/delivery-killgate.mjs [questions-deep.json]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsBlobStore, HeuristicTokenizer, JsonlTraceLog, TreeRetriever, openStore, storePaths } from '@context-tree/core';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCENARIO = join(REPO, 'eval/fixtures/transplant/s1');
const ARTIFACTS = join(SCENARIO, 'e1b289c32f40');
/**
 * Headrooms a fetch actually sees. The low end is the measured live p90 at
 * W=32,768 (~5,350) and W=65,536 (~8,100); the high end is past the largest
 * branch on this store, so every question is guaranteed to flip somewhere and
 * the flip point is the reportable number.
 */
const HEADROOMS = [4_000, 6_000, 8_000, 12_000, 16_000, 24_000, 40_000, 64_000];

function loadRecordedQueries(setName) {
  const dir = join(ARTIFACTS, 'results');
  const suffix = `-${setName.replace(/\.json$/, '')}-`;
  const byQuestion = new Map();
  if (!existsSync(dir)) return byQuestion;
  for (const file of readdirSync(dir)) {
    if (!file.startsWith('run-W') || !file.includes(suffix)) continue;
    for (const row of JSON.parse(readFileSync(join(dir, file), 'utf8')).rows ?? []) {
      for (const query of row.searchQueries ?? []) {
        if (typeof query !== 'string' || query.length === 0) continue;
        const list = byQuestion.get(row.question) ?? [];
        if (!list.includes(query)) list.push(query);
        byQuestion.set(row.question, list);
      }
    }
  }
  return byQuestion;
}

function main() {
  const argv = process.argv.slice(2);
  const setName = argv.find((a) => !a.startsWith('--')) ?? 'questions-deep.json';
  const questions = JSON.parse(readFileSync(join(ARTIFACTS, setName), 'utf8')).questions;
  const recorded = loadRecordedQueries(setName);

  const paths = storePaths(join(SCENARIO, 'store'));
  const store = openStore(paths.db);
  const blobs = new FsBlobStore(paths.blobs);
  const trace = new JsonlTraceLog(paths.trace);
  const retriever = new TreeRetriever({ store, blobs, trace });
  const tokenizer = new HeuristicTokenizer();

  console.log(`\n=== DELIVERY GATE — ${setName} ===`);
  console.log('Does the fetch, narrowed to a live headroom, still contain the answer?\n');
  console.log(
    `${'question'.padEnd(8)} ${'branch'.padEnd(7)} ${'branchTok'.padStart(9)} ${'answerAt'.padStart(8)}  ` +
      `${HEADROOMS.map((h) => `${h / 1000}k`.padStart(5)).join(' ')}   queries`,
  );

  let deliveredAtLive = 0;
  const LIVE = 8_000;
  for (const question of questions) {
    const literal = question.answer_literals[0];
    const queries = recorded.get(question.id) ?? [question.question];
    const whole = retriever.fetchBranch(question.node_id, { depth: 'full' });
    const wholeText = whole?.text ?? '';
    const at = wholeText.indexOf(literal);
    const answerAt = at < 0 ? '--' : `${((at / wholeText.length) * 100).toFixed(0)}%`;

    // A question is delivered at a headroom if ANY query the model issued
    // produces a band containing the answer — the most generous reading, so a
    // failure here is not an artifact of picking the worst query.
    const cells = HEADROOMS.map((headroom) => {
      const hit = queries.some((query) => {
        const out = retriever.fetchBranch(question.node_id, { depth: 'full', maxTokens: headroom, query });
        return (out?.text ?? '').includes(literal);
      });
      return hit;
    });
    if (cells[HEADROOMS.indexOf(LIVE)] === true) deliveredAtLive += 1;

    console.log(
      `${question.id.replace('s1-', '').replace('-overflow', '').padEnd(8)} ` +
        `${question.node_id.slice(-6).padEnd(7)} ${String(tokenizer.count(wholeText)).padStart(9)} ${answerAt.padStart(8)}  ` +
        `${cells.map((hit) => (hit ? '  YES' : '   --')).join(' ')}   ${queries.length}`,
    );
  }

  console.log(
    `\ndelivered at the live headroom (${LIVE} tokens): ${deliveredAtLive}/${questions.length}\n` +
      'A question that is not delivered cannot be answered from retrieval at any ranking,\n' +
      'so its live score measures the band, not the model.',
  );
  store.close();
  process.exitCode = deliveredAtLive === questions.length ? 0 : 1;
}

main();
