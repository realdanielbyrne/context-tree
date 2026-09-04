#!/usr/bin/env node
/**
 * Kill gate for search ranking. Runs the FULL search() path (fingerprint-enriched
 * beam + hybrid grep, merged by RRF) over the frozen store and reports how often
 * the question's own source branch lands in the top three.
 *
 * It used to hardcode `questions.json`, so the offline top-3 rate had never been
 * measured on the two overflow sets — and the multi-index report compared "10/12
 * offline" against a LIVE score on five entirely different questions, which is not
 * a comparison. Every set is now measurable, and `--all` runs them together.
 *
 * The bar is stated as a fraction of the set rather than a count: the original
 * pre-registered gate was 8 of 12, which is two-thirds, and two-thirds is what
 * ports to a set of another size. At n=12 it is the same 8 it always was.
 *
 *   node eval/scripts/rank-killgate.mjs                      # questions.json
 *   node eval/scripts/rank-killgate.mjs questions-deep.json
 *   node eval/scripts/rank-killgate.mjs --all
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsBlobStore, JsonlTraceLog, TreeRetriever, openStore, storePaths } from '@context-tree/core';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURES = join(REPO, 'eval/fixtures/transplant');
const TOP_N = 3;
/** The original gate's 8-of-12, expressed so it survives a set of another size. */
const PASS_FRACTION = 2 / 3;
const DEFAULT_SET = 'questions.json';
const ALL_SETS = ['questions.json', 'questions-overflow.json', 'questions-deep.json'];

/** The artifact directory is named from the trace sha; find it rather than assume it. */
function artifactDir(scenarioDir) {
  for (const entry of readdirSync(scenarioDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(scenarioDir, entry.name, DEFAULT_SET))) return join(scenarioDir, entry.name);
  }
  throw new Error(`no artifact directory with ${DEFAULT_SET} under ${scenarioDir}`);
}

function rankOf(hits, question) {
  const ranked = hits.filter((h) => h.kind !== 'task');
  const wanted = new Set(question.node_ids ?? [question.node_id]);
  const index = ranked.findIndex((h) => wanted.has(h.nodeId));
  return index === -1 ? null : index + 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const scenarioDir = join(FIXTURES, 's1');
  const dir = artifactDir(scenarioDir);
  const sets = argv.includes('--all') ? ALL_SETS : [argv.find((a) => !a.startsWith('--')) ?? DEFAULT_SET];

  const paths = storePaths(join(scenarioDir, 'store'));
  const store = openStore(paths.db);
  const blobs = new FsBlobStore(paths.blobs);
  const trace = new JsonlTraceLog(paths.trace);
  const retriever = new TreeRetriever({ store, blobs, trace });

  let failed = false;
  try {
    for (const set of sets) {
      const path = join(dir, set);
      if (!existsSync(path)) {
        console.log(`\n=== ${set}: absent, skipped ===`);
        continue;
      }
      const { questions } = JSON.parse(readFileSync(path, 'utf8'));
      const bar = Math.ceil(questions.length * PASS_FRACTION);

      console.log(`\n=== KILL GATE: search() with fingerprints + hybrid grep — ${set} ===`);
      console.log(`Questions: ${questions.length}, bar: >=${bar}/${questions.length} in top-${TOP_N}\n`);

      let hybrid = 0;
      let beam = 0;
      for (const q of questions) {
        const full = await retriever.search(q.question, { limit: 20 });
        const fullRank = rankOf(full.hits, q);
        const beamRank = rankOf(retriever.beamSearch(q.question, { limit: 20 }).hits, q);
        if (fullRank !== null && fullRank <= TOP_N) hybrid += 1;
        if (beamRank !== null && beamRank <= TOP_N) beam += 1;
        const show = (r) => (r === null ? '--' : String(r).padStart(2));
        console.log(
          `  ${q.id.padEnd(22)} hybrid=${show(fullRank)}  beam=${show(beamRank)}  path=${full.path}` +
            `${fullRank !== null && fullRank <= TOP_N ? '  TOP-3' : ''}`,
        );
      }

      const pass = hybrid >= bar;
      if (!pass) failed = true;
      console.log(`\n  hybrid top-${TOP_N}: ${hybrid}/${questions.length} — ${pass ? 'PASS' : 'FAIL'} (bar ${bar})`);
      console.log(`  beam-only top-${TOP_N}: ${beam}/${questions.length}`);
    }
  } finally {
    store.close();
  }

  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
