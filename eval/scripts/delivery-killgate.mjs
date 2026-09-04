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
 * Headrooms a fetch is swept over. The high end is past the largest branch on
 * this store, so a question that never flips anywhere is undeliverable for a
 * reason other than size. The headroom the LIVE path actually produces is not
 * one of these — it is derived per result file from what the runs recorded, so
 * this gate cannot repeat the mistake the narrowing gate made of sweeping an
 * axis the live path never occupies.
 */
const HEADROOMS = [4_000, 6_000, 8_000, 12_000, 16_000, 24_000, 40_000, 64_000];

/**
 * One entry per RUN, not per distinct query string. Pooling distinct queries and
 * asking whether ANY of them delivers is the flattering reading and it answers a
 * question nobody has: what matters is how often a run's own first query put the
 * answer in the band. Keeping runs separate is what makes the delivery rate
 * comparable to the live score, run for run.
 */
function loadRecordedRuns(setName) {
  const dir = join(ARTIFACTS, 'results');
  const suffix = `-${setName.replace(/\.json$/, '')}-`;
  const byQuestion = new Map();
  if (!existsSync(dir)) return byQuestion;
  for (const file of readdirSync(dir)) {
    if (!file.startsWith('run-W') || !file.includes(suffix)) continue;
    const payload = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    // The headroom this file's runs actually had, from the file's own budgets and
    // the prompt its first turn sent — never a constant typed in here.
    const window = payload.budgets?.window ?? null;
    const reply = payload.budgets?.maxReplyTokens ?? 0;
    for (const row of payload.rows ?? []) {
      const query = (row.searchQueries ?? []).find((q) => typeof q === 'string' && q.length > 0);
      if (query === undefined) continue;
      const prompt = row.turns?.[0]?.promptTokens ?? null;
      const headroom = window !== null && prompt !== null ? Math.max(0, window - prompt - reply) : null;
      const list = byQuestion.get(row.question) ?? [];
      list.push({ arm: row.arm, rep: row.rep, query, headroom, scored: row.score === 1 });
      byQuestion.set(row.question, list);
    }
  }
  return byQuestion;
}

function main() {
  const argv = process.argv.slice(2);
  const setName = argv.find((a) => !a.startsWith('--')) ?? 'questions-deep.json';
  const questions = JSON.parse(readFileSync(join(ARTIFACTS, setName), 'utf8')).questions;
  const recorded = loadRecordedRuns(setName);

  const paths = storePaths(join(SCENARIO, 'store'));
  const store = openStore(paths.db);
  const blobs = new FsBlobStore(paths.blobs);
  const trace = new JsonlTraceLog(paths.trace);
  const retriever = new TreeRetriever({ store, blobs, trace });
  const tokenizer = new HeuristicTokenizer();

  const carries = (nodeId, literal, maxTokens, query) => {
    const out = retriever.fetchBranch(nodeId, { depth: 'full', maxTokens, query });
    return (out?.text ?? '').includes(literal);
  };

  console.log(`\n=== DELIVERY GATE — ${setName} ===`);
  console.log('Does the fetch, narrowed to a live headroom, still contain the answer?\n');

  // Part 1: the live reading. Each recorded run, its own first query, its own headroom.
  console.log('PER RUN, at the headroom that run actually had:\n');
  console.log(`${'question'.padEnd(8)} ${'branch'.padEnd(7)} ${'branchTok'.padStart(9)} ${'answerAt'.padStart(8)} ${'delivered'.padStart(10)} ${'scored'.padStart(7)}  medHeadroom`);
  let deliveredRuns = 0;
  let totalRuns = 0;
  let undelivered = [];
  for (const question of questions) {
    const literal = question.answer_literals[0];
    const runs = recorded.get(question.id) ?? [];
    const whole = retriever.fetchBranch(question.node_id, { depth: 'full' });
    const wholeText = whole?.text ?? '';
    const at = wholeText.indexOf(literal);
    const answerAt = at < 0 ? '--' : `${((at / wholeText.length) * 100).toFixed(0)}%`;
    let ok = 0;
    let scored = 0;
    const heads = [];
    for (const run of runs) {
      if (run.headroom === null) continue;
      heads.push(run.headroom);
      if (carries(question.node_id, literal, run.headroom, run.query)) ok += 1;
      if (run.scored) scored += 1;
    }
    const n = heads.length;
    deliveredRuns += ok;
    totalRuns += n;
    if (n > 0 && ok === 0) undelivered.push(question.id);
    const sorted = [...heads].sort((a, b) => a - b);
    const medHead = n === 0 ? '--' : String(sorted[Math.floor(n / 2)]);
    console.log(
      `${question.id.replace('s1-', '').replace('-overflow', '').padEnd(8)} ` +
        `${question.node_id.slice(-6).padEnd(7)} ${String(tokenizer.count(wholeText)).padStart(9)} ${answerAt.padStart(8)} ` +
        `${`${ok}/${n}`.padStart(10)} ${`${scored}/${n}`.padStart(7)}  ${medHead}`,
    );
  }
  console.log(`\nDELIVERED: ${deliveredRuns}/${totalRuns} runs received the answer in the band.`);
  if (undelivered.length > 0) {
    console.log(`UNDELIVERABLE at every recorded run: ${undelivered.join(', ')}`);
    console.log('A question that is not delivered cannot be answered from retrieval at any');
    console.log('ranking, so its live score measures the band, not the model.');
  }

  // Part 2: the sweep, to separate "band too small" from "band in the wrong place".
  console.log('\nBY BUDGET, best case over every query the question ever drew:\n');
  console.log(`${'question'.padEnd(8)}  ${HEADROOMS.map((h) => `${h / 1000}k`.padStart(5)).join(' ')}`);
  for (const question of questions) {
    const literal = question.answer_literals[0];
    const queries = [...new Set((recorded.get(question.id) ?? []).map((r) => r.query))];
    const cells = HEADROOMS.map((headroom) => queries.some((query) => carries(question.node_id, literal, headroom, query)));
    console.log(
      `${question.id.replace('s1-', '').replace('-overflow', '').padEnd(8)}  ` +
        `${cells.map((hit) => (hit ? '  YES' : '   --')).join(' ')}`,
    );
  }
  console.log('\nA row still `--` at a budget near the branch size is mis-centred, not');
  console.log('starved: at that point the band is essentially the whole branch, so a YES');
  console.log('there says nothing about centring. Read the LOW columns — a row that is');
  console.log('`--` at every budget a live run actually gets is the one to fix.');

  store.close();
  process.exitCode = deliveredRuns === totalRuns ? 0 : 1;
}

main();
