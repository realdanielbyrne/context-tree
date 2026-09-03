#!/usr/bin/env node
/**
 * Kill gate for DS-STAR search ranking pass.
 * Tests the FULL search() path (fingerprints + hybrid grep) on the frozen store.
 * Target: correct branch in top-3 for >=8/12 questions.
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
  const storeDir = join(scenarioDir, 'store');
  const paths = storePaths(storeDir);
  const store = openStore(paths.db);
  const blobs = new FsBlobStore(paths.blobs);
  const trace = new JsonlTraceLog(paths.trace);
  const retriever = new TreeRetriever({ store, blobs, trace });

  let questionsPath;
  for (const entry of readdirSync(scenarioDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(scenarioDir, entry.name, 'questions.json');
    if (existsSync(candidate)) { questionsPath = candidate; break; }
  }
  const { questions } = JSON.parse(readFileSync(questionsPath, 'utf8'));
  const rootId = store.root()?.id ?? null;

  console.log(`\n=== KILL GATE: search() with fingerprints + hybrid grep ===`);
  console.log(`Questions: ${questions.length}, Target: >=8/12 top-3\n`);

  let top3 = 0;
  for (const q of questions) {
    // Use the full search() path — fingerprints + grep hybrid
    const result = await retriever.search(q.question, { limit: 20 });
    const ranked = result.hits.filter(h => h.kind !== 'task');
    const wanted = new Set(q.node_ids ?? [q.node_id]);
    const idx = ranked.findIndex(h => wanted.has(h.nodeId));
    const rank = idx === -1 ? 99 : idx + 1;
    if (rank <= 3) top3++;
    console.log(`  ${q.id.padEnd(20)} rank=${String(rank).padStart(2)}  path=${result.path}  ${rank <= 3 ? 'TOP-3' : ''}`);
  }

  console.log(`\nTop-3: ${top3}/12 — Gate: ${top3 >= 8 ? 'PASS' : 'FAIL'}`);

  // Also run beam-only for comparison
  console.log(`\n--- Beam-only (fingerprint-enriched, no grep) ---`);
  let beamTop3 = 0;
  for (const q of questions) {
    const result = retriever.beamSearch(q.question, { limit: 20 });
    const ranked = result.hits.filter(h => h.kind !== 'task');
    const wanted = new Set(q.node_ids ?? [q.node_id]);
    const idx = ranked.findIndex(h => wanted.has(h.nodeId));
    const rank = idx === -1 ? 99 : idx + 1;
    if (rank <= 3) beamTop3++;
    console.log(`  ${q.id.padEnd(20)} rank=${String(rank).padStart(2)}  ${rank <= 3 ? 'TOP-3' : ''}`);
  }
  console.log(`\nBeam-only top-3: ${beamTop3}/12`);

  store.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
