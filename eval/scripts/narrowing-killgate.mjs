#!/usr/bin/env node
/**
 * Zero-live-token kill gate for the ONE-CUT narrowing fix.
 *
 * The tree arm's failure mode was a double truncation: `fetchBranch` narrowed a
 * branch to a budget it ESTIMATED, and then the append path re-cut the result
 * against the budget that was actually left — front-first, blind to relevance,
 * so a band centred on the answer could lose the answer. This gate asserts the
 * two properties that make the retriever's cut the only cut worth making:
 *
 *   FITS     the returned text is within the requested maxTokens
 *   CARRIES  the returned text still contains the answer literal
 *
 * A band that fits but drops the answer is a useless band; one that carries the
 * answer but overruns the budget gets re-cut downstream and becomes the first
 * case. Both must hold, at every budget, for every question.
 *
 *   node eval/scripts/narrowing-killgate.mjs [questions-overflow.json]
 */
import { FsBlobStore, HeuristicTokenizer, JsonlTraceLog, TreeRetriever, loadConfig, openStore, storePaths } from '@context-tree/core';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCENARIO = join(REPO, 'eval/fixtures/transplant/s1');
const ARTIFACTS = join(SCENARIO, 'e1b289c32f40');
/** The budgets a fetch actually sees: half a small window up to a whole large one. */
const BUDGETS = [2_000, 4_000, 8_000, 16_000];

const questionsFile = process.argv[2] ?? 'questions-overflow.json';
const questionsPath = join(ARTIFACTS, questionsFile);
if (!existsSync(questionsPath)) throw new Error(`no question set at ${questionsPath}`);
const questions = JSON.parse(readFileSync(questionsPath, 'utf8')).questions;

const storeRoot = join(SCENARIO, 'store');
const paths = storePaths(storeRoot);
const config = { ...loadConfig(REPO), root: storeRoot };
const trace = new JsonlTraceLog(paths.trace);
const blobs = new FsBlobStore(paths.blobs);
const store = openStore(paths.db);
const tokenizer = new HeuristicTokenizer();
const retriever = new TreeRetriever({ store, blobs, trace, tokenizer });

let failures = 0;
console.log(`narrowing kill gate: ${questions.length} question(s) x ${BUDGETS.length} budget(s), ${questionsFile}\n`);
for (const q of questions) {
  for (const maxTokens of BUDGETS) {
    const fetched = retriever.fetchBranch(q.node_id, { depth: 'full', maxTokens, query: q.question });
    const tokens = tokenizer.count(fetched.text ?? '');
    const fits = tokens <= maxTokens;
    const carries = q.answer_literals.every((literal) => (fetched.text ?? '').includes(literal));
    const ok = fits && carries;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} ${q.id} @${maxTokens}: ${tokens} tok ` +
        `${fits ? 'fits' : `OVER by ${tokens - maxTokens}`}, ${carries ? 'carries the answer' : 'ANSWER MISSING'}`,
    );
  }
}
store.close();
trace.close();

const total = questions.length * BUDGETS.length;
console.log(`\n${total - failures}/${total} cells pass`);
if (failures > 0) {
  console.log('\nA FAIL on `fits` means the append path will re-cut this result — the double truncation is back.');
  console.log('A FAIL on `carries` means the band is centred somewhere the answer is not.');
  process.exitCode = 1;
}
