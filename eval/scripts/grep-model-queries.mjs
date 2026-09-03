#!/usr/bin/env node
/**
 * Tests real model search queries against grep to see if models write
 * queries that would benefit from a grep-augmented search path.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FsBlobStore,
  JsonlTraceLog,
  TreeRetriever,
  openStore,
  storePaths,
} from '@context-tree/core';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURES = join(REPO, 'eval/fixtures/transplant');

async function main() {
  const scenarioDir = join(FIXTURES, 's1');
  const paths = storePaths(join(scenarioDir, 'store'));
  const store = openStore(paths.db);
  const blobs = new FsBlobStore(paths.blobs);
  const trace = new JsonlTraceLog(paths.trace);
  const retriever = new TreeRetriever({ store, blobs, trace });
  const rootId = store.root()?.id ?? null;

  // Load questions for node_id mapping
  let questionsPath;
  for (const entry of readdirSync(scenarioDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(scenarioDir, entry.name, 'questions.json');
    if (existsSync(candidate)) { questionsPath = candidate; break; }
  }
  const { questions } = JSON.parse(readFileSync(questionsPath, 'utf8'));
  const qMap = new Map(questions.map(q => [q.id, q]));

  // Load tree-tail result with search queries
  const resultPath = join(scenarioDir, 'e1b289c32f40/results/run-W32768-tree-tail-qwen_qwen3.7-flash.json');
  const resultData = JSON.parse(readFileSync(resultPath, 'utf8'));
  const rows = resultData.rows || [];

  // Collect unique queries per question
  const queryMap = new Map();
  for (const r of rows) {
    const qid = r.question;
    const queries = r.searchQueries || [];
    if (!queryMap.has(qid)) queryMap.set(qid, new Set());
    for (const q of queries) queryMap.get(qid).add(q);
  }

  const STOP_WORDS = new Set(['the','and','from','that','with','this','for','was','not','are','its','has','what','how','when','where','which','who','why','did','does','were','been','have','had','will','would','could','should','may','might','can','into','over','about','than','then','them','they','their','also','each','but','all','any','after','before','other','some','such','there','these','those','through','under','very','just','only','its','own','per','out','too','being']);

  console.log('=== GREP ON REAL MODEL QUERIES ===\n');

  for (const [qid, querySet] of queryMap) {
    const q = qMap.get(qid);
    if (!q) continue;
    const wanted = new Set(q.node_ids ?? [q.node_id]);
    const queries = [...querySet];

    let overallBestRank = 99;
    let bestQuery = '';
    let bestTerm = '';

    for (const query of queries) {
      // Extract distinctive terms (not stop words, length > 2)
      const words = query.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));

      for (const word of words) {
        const r = retriever.grepEvents(word, { limit: 30 });
        const ranked = r.hits.filter(h => h.kind !== 'task');
        const idx = ranked.findIndex(h => wanted.has(h.nodeId));
        if (idx !== -1 && idx + 1 < overallBestRank) {
          overallBestRank = idx + 1;
          bestQuery = query;
          bestTerm = word;
        }
      }

      // Also try multi-word phrases from quoted strings
      const quoted = query.match(/["'`](.*?)["'`]/g) ?? [];
      for (const phrase of quoted) {
        const clean = phrase.replace(/["'`]/g, '');
        if (clean.length < 3) continue;
        const r = retriever.grepEvents(clean, { limit: 30 });
        const ranked = r.hits.filter(h => h.kind !== 'task');
        const idx = ranked.findIndex(h => wanted.has(h.nodeId));
        if (idx !== -1 && idx + 1 < overallBestRank) {
          overallBestRank = idx + 1;
          bestQuery = query;
          bestTerm = clean;
        }
      }
    }

    const beamResult = retriever.beamSearch(queries[0] || q.question, { limit: 30 });
    const beamRanked = beamResult.hits.filter(h => h.kind !== 'task');
    const beamIdx = beamRanked.findIndex(h => wanted.has(h.nodeId));
    const beamRank = beamIdx === -1 ? 99 : beamIdx + 1;

    console.log(`${qid.padEnd(20)} beam=${String(beamRank).padStart(2)}  grep_best=${String(overallBestRank).padStart(2)}  via="${bestTerm.slice(0,40)}"  queries=${queries.length}`);
  }

  store.close();
}

main().catch(err => { console.error(err); process.exit(1); });
