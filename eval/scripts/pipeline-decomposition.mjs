#!/usr/bin/env node
/**
 * Where does a live run stop? Selection, delivery, or extraction.
 *
 * The delivery-pass report published a three-bucket decomposition as prose, and an
 * adversarial recount could not reproduce the middle bucket under any definition it
 * tried — because the definition was never stated. That is the defect this script
 * exists to remove: the buckets are computed here, from the artifacts, under a
 * definition written down in code, and the report cites this output.
 *
 * The three stages, and exactly what each means:
 *
 *   SELECTED   the run fetched the question's own source branch (`node_id`).
 *   DELIVERED  the payload the run actually RECEIVED contained the answer literal.
 *              Reconstructed by replaying each branch the run fetched through the
 *              same call the handler makes — `fetchBranch(id, {depth:'full',
 *              maxTokens: liveHeadroom / ratio, query})`. Any fetched branch counts,
 *              not only the correct one: a run that found the literal in some other
 *              branch was still served the answer.
 *   SCORED     `gradeAnswer` matched, as recorded.
 *
 * These are NOT nested, and forcing them into a funnel is what produced the
 * unreproducible figure. A run can be delivered without having selected (the literal
 * turned up in another branch) and can score without either (the answer was in the
 * prompt, or it was fabricated). The report must quote the counts, not a funnel.
 *
 * Live headroom is approximated by turn 1's, which is the largest any turn has, so
 * DELIVERED is an upper bound: later fetches have less room, and the append cap
 * re-cuts afterwards. The query is likewise approximated — the handler centres on
 * whichever search preceded the fetch, and a row records searches and fetches as two
 * flat lists with no interleaving — so both the first and the last recorded query are
 * reported and the spread between them is the uncertainty.
 *
 *   node eval/scripts/pipeline-decomposition.mjs [<result-file-basename>] [questions-deep.json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsBlobStore, JsonlTraceLog, TreeRetriever, openStore, storePaths } from '@context-tree/core';
import { gradeAnswer } from './transplant.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCENARIO = join(REPO, 'eval/fixtures/transplant/s1');
const ARTIFACTS = join(SCENARIO, 'e1b289c32f40');
const DEFAULT_FILE = 'run-W65536-tree-tail-v2-questions-deep-z-ai_glm-5.3-flash.json';
const DEFAULT_SET = 'questions-deep.json';

function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const fileName = argv[0] ?? DEFAULT_FILE;
  const setName = argv[1] ?? DEFAULT_SET;

  const path = join(ARTIFACTS, 'results', fileName);
  if (!existsSync(path)) throw new Error(`no result file at ${path}`);
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  const questions = Object.fromEntries(
    JSON.parse(readFileSync(join(ARTIFACTS, setName), 'utf8')).questions.map((q) => [q.id, q]),
  );

  const paths = storePaths(join(SCENARIO, 'store'));
  const store = openStore(paths.db);
  const blobs = new FsBlobStore(paths.blobs);
  const trace = new JsonlTraceLog(paths.trace);
  const retriever = new TreeRetriever({ store, blobs, trace });

  const { window, ratio, maxReplyTokens = 0 } = payload.budgets ?? {};
  const carries = (branchId, maxTokens, query, question) => {
    try {
      const out = retriever.fetchBranch(branchId, { depth: 'full', maxTokens, query });
      return gradeAnswer(out?.text ?? '', question).success;
    } catch {
      return false;
    }
  };

  const arms = new Map();
  for (const row of payload.rows ?? []) {
    const question = questions[row.question];
    if (question === undefined) throw new Error(`${fileName}: ${row.question} absent from ${setName}`);
    const want = new Set(question.node_ids ?? [question.node_id]);
    const fetched = (row.fetchedIds ?? []).filter((id) => typeof id === 'string');
    const queries = (row.searchQueries ?? []).filter((q) => typeof q === 'string' && q.length > 0);
    const prompt = row.turns?.[0]?.promptTokens;
    const live = typeof window === 'number' && typeof prompt === 'number' ? Math.max(0, window - prompt - maxReplyTokens) : null;
    const maxTokens = live === null || typeof ratio !== 'number' ? null : Math.floor(live / ratio);

    const selected = fetched.some((id) => want.has(id));
    const deliveredBy = (query, ids) =>
      maxTokens === null ? null : ids.some((id) => carries(id, maxTokens, query ?? '', question));
    const first = deliveredBy(queries[0], fetched);
    const last = deliveredBy(queries[queries.length - 1], fetched);
    // The same question asked strictly: only the question's OWN branch counts. The
    // loose rule credits a run that found the literal in some other branch, which is
    // fair to the run and inflates the delivery bucket; the strict rule is the one
    // that isolates this question's retrieval. Both are printed because the split
    // between "retrieval delivered the wrong bytes" and "the model failed on the
    // right ones" moves with the choice, and a report that quotes one owes the other.
    const strict = deliveredBy(queries[0], fetched.filter((id) => want.has(id)));

    const arm = arms.get(row.arm) ?? { n: 0, selected: 0, dFirst: 0, dLast: 0, dStrict: 0, scored: 0, perQ: new Map() };
    arm.n += 1;
    if (selected) arm.selected += 1;
    if (first === true) arm.dFirst += 1;
    if (last === true) arm.dLast += 1;
    if (strict === true) arm.dStrict += 1;
    if (row.score === 1) arm.scored += 1;
    const key = row.question.replace('s1-', '').replace('-overflow', '');
    const q = arm.perQ.get(key) ?? { n: 0, selected: 0, delivered: 0, scored: 0 };
    q.n += 1;
    if (selected) q.selected += 1;
    if (first === true) q.delivered += 1;
    if (row.score === 1) q.scored += 1;
    arm.perQ.set(key, q);
    arms.set(row.arm, arm);
  }

  console.log(`\n=== PIPELINE DECOMPOSITION — ${fileName} ===`);
  console.log(`window ${window}, ratio ${ratio}, reply ${maxReplyTokens}\n`);
  for (const [name, arm] of arms) {
    console.log(`${name}  (n=${arm.n})`);
    console.log(`  SELECTED  fetched the question's own branch      ${arm.selected}/${arm.n}`);
    console.log(`  DELIVERED payload received carried the literal   ${arm.dFirst}/${arm.n} (any fetched branch)  ${arm.dLast}/${arm.n} (last query)`);
    console.log(`  DELIVERED strictly, own branch only              ${arm.dStrict}/${arm.n}`);
    console.log(`  SCORED                                           ${arm.scored}/${arm.n}`);
    console.log(`  split at the delivery boundary: ${arm.n - arm.dFirst} lost at/before delivery, ${arm.dFirst - arm.scored} after` +
      `  (strict: ${arm.n - arm.dStrict} / ${arm.dStrict - arm.scored})`);
    console.log(`  per question (selected | delivered | scored):`);
    for (const key of [...arm.perQ.keys()].sort()) {
      const q = arm.perQ.get(key);
      console.log(`    ${key}  ${q.selected}/${q.n}  |  ${q.delivered}/${q.n}  |  ${q.scored}/${q.n}`);
    }
    console.log('');
  }
  store.close();
}

main();
