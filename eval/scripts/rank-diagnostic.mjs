#!/usr/bin/env node
/**
 * Offline ranking diagnostic for DS-STAR search-ranking pass.
 * Zero API tokens. Pure offline beam search analysis.
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

// Minimal term extraction (mirrors lexical.ts TERM_PATTERN)
const TERM_RE = /[a-z0-9_]+/g;
function extractTerms(text) { return text.toLowerCase().match(TERM_RE) ?? []; }
function uniqueTermsOf(text) { return [...new Set(extractTerms(text))]; }

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

  const nodes = store.nodesInCreationOrder();
  const rootId = store.root()?.id ?? null;

  console.log(`\n=== SEARCH RANKING DIAGNOSTIC ===`);
  console.log(`Nodes: ${nodes.length} (root: ${rootId}), Questions: ${questions.length}`);
  console.log(`Kill gate: correct branch in top-3 for >=8/12 questions\n`);

  let top3Count = 0;
  const rows = [];

  for (const q of questions) {
    const result = retriever.beamSearch(q.question, { limit: 30 });
    // Exclude task root (always ranks #1 and is never a source)
    const ranked = result.hits.filter((h) => h.kind !== 'task');
    const wanted = new Set(q.node_ids ?? [q.node_id]);
    const correctIdx = ranked.findIndex((h) => wanted.has(h.nodeId));
    const rank = correctIdx === -1 ? 99 : correctIdx + 1;
    const inTop3 = rank <= 3;
    if (inTop3) top3Count++;

    // Check answer literal in correct branch raw events
    let literalInBranch = false;
    try {
      const fetched = retriever.fetchBranch(q.node_id, { depth: 'full' });
      for (const lit of q.answer_literals) {
        if (fetched.text.toLowerCase().includes(lit.toLowerCase())) {
          literalInBranch = true;
          break;
        }
      }
    } catch { /* node might not exist */ }

    rows.push({ id: q.id, stratum: q.stratum, rank, inTop3, literalInBranch });

    console.log(`--- ${q.id} (${q.stratum}) ---`);
    console.log(`  Rank: ${rank} ${inTop3 ? 'TOP-3' : 'MISS'}`);
    console.log(`  Answer in raw events: ${literalInBranch}`);
    console.log(`  Top-3:`);
    for (let i = 0; i < Math.min(3, ranked.length); i++) {
      const h = ranked[i];
      console.log(`    ${i+1}. [${h.score.toFixed(4)}] "${h.title?.slice(0,60)}" (${h.nodeId})`);
    }
    if (correctIdx >= 0) {
      const ch = ranked[correctIdx];
      console.log(`  Correct: [${ch.score.toFixed(4)}] "${ch.title?.slice(0,60)}" at rank ${rank}`);
    }
    console.log();
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Top-3: ${top3Count}/12 (target: >=8/12) — Gate: ${top3Count >= 8 ? 'PASS' : 'FAIL'}\n`);

  console.log('Rank distribution:');
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(20)} rank=${String(r.rank).padStart(2)}  literal_in_branch=${r.literalInBranch}  ${r.inTop3 ? 'TOP-3' : ''}`);
  }

  // Grep with answer literals
  console.log(`\n=== GREP RANKING: answer literals ===`);
  let grepLitTop3 = 0;
  for (const q of questions) {
    const grepQuery = q.answer_literals[0];
    const grepResult = retriever.grepEvents(grepQuery, { limit: 30 });
    const grepRanked = grepResult.hits.filter((h) => h.kind !== 'task');
    const wanted = new Set(q.node_ids ?? [q.node_id]);
    const grepIdx = grepRanked.findIndex((h) => wanted.has(h.nodeId));
    const grepRank = grepIdx === -1 ? 99 : grepIdx + 1;
    if (grepRank <= 3) grepLitTop3++;
    console.log(`  ${q.id.padEnd(20)} grep_rank=${String(grepRank).padStart(2)}  hits=${grepRanked.length}  query="${grepQuery.slice(0,50)}"`);
  }
  console.log(`Grep (answer literal) top-3: ${grepLitTop3}/12\n`);

  // Grep with question text (what the model would actually search with)
  console.log(`=== GREP RANKING: question text ===`);
  let grepQTop3 = 0;
  for (const q of questions) {
    // Extract key phrases from question — try each 2-3 word window
    const words = q.question.split(/\s+/).filter(w => w.length > 2);
    let bestRank = 99;
    let bestPhrase = '';

    // Try the full question first
    const fullResult = retriever.grepEvents(q.question, { limit: 30 });
    const fullRanked = fullResult.hits.filter((h) => h.kind !== 'task');
    const wanted = new Set(q.node_ids ?? [q.node_id]);
    const fullIdx = fullRanked.findIndex((h) => wanted.has(h.nodeId));
    if (fullIdx !== -1 && fullIdx + 1 < bestRank) { bestRank = fullIdx + 1; bestPhrase = 'full'; }

    // Try distinctive phrases from the question (quoted terms, identifiers)
    const quoted = q.question.match(/[`'"](.*?)[`'"]/g) ?? [];
    for (const phrase of quoted) {
      const clean = phrase.replace(/[`'"]/g, '');
      if (clean.length < 3) continue;
      const r = retriever.grepEvents(clean, { limit: 30 });
      const rr = r.hits.filter((h) => h.kind !== 'task');
      const idx = rr.findIndex((h) => wanted.has(h.nodeId));
      if (idx !== -1 && idx + 1 < bestRank) { bestRank = idx + 1; bestPhrase = clean.slice(0, 40); }
    }

    if (bestRank <= 3) grepQTop3++;
    console.log(`  ${q.id.padEnd(20)} best_rank=${String(bestRank).padStart(2)}  via="${bestPhrase}"`);
  }
  console.log(`Grep (question text) top-3: ${grepQTop3}/12\n`);

  // Hybrid beam+grep: for each question, merge beam and grep-on-question results
  console.log(`=== HYBRID: beam + grep-question-phrases ===`);
  let hybridTop3 = 0;
  for (const q of questions) {
    const beamResult = retriever.beamSearch(q.question, { limit: 30 });
    const beamRanked = beamResult.hits.filter((h) => h.kind !== 'task');

    // Grep distinctive phrases from question
    const quoted = q.question.match(/[`'"](.*?)[`'"]/g) ?? [];
    const grepHits = new Map(); // nodeId -> count
    for (const phrase of quoted) {
      const clean = phrase.replace(/[`'"]/g, '');
      if (clean.length < 3) continue;
      const r = retriever.grepEvents(clean, { limit: 30 });
      for (const h of r.hits) {
        grepHits.set(h.nodeId, (grepHits.get(h.nodeId) ?? 0) + h.score);
      }
    }

    // Merge: beam score + grep bonus (normalized)
    const maxBeam = Math.max(...beamRanked.map(h => h.score), 0.001);
    const maxGrep = Math.max(...[...grepHits.values()], 0.001);
    const merged = beamRanked.map(h => ({
      ...h,
      hybridScore: h.score / maxBeam + (grepHits.get(h.nodeId) ?? 0) / maxGrep,
    }));
    // Add grep-only hits not in beam
    for (const [nodeId, score] of grepHits) {
      if (!beamRanked.find(h => h.nodeId === nodeId)) {
        const n = nodes.find(n => n.id === nodeId);
        if (n && n.kind !== 'task') {
          merged.push({ nodeId, title: n.title, kind: n.kind, score: 0, hybridScore: score / maxGrep });
        }
      }
    }
    merged.sort((a, b) => b.hybridScore - a.hybridScore);

    const wanted = new Set(q.node_ids ?? [q.node_id]);
    const idx = merged.findIndex((h) => wanted.has(h.nodeId));
    const rank = idx === -1 ? 99 : idx + 1;
    if (rank <= 3) hybridTop3++;
    console.log(`  ${q.id.padEnd(20)} hybrid_rank=${String(rank).padStart(2)}  beam_rank=${String(rows.find(r => r.id === q.id)?.rank ?? 99).padStart(2)}  grep_phrases=${quoted.length}`);
  }
  console.log(`Hybrid top-3: ${hybridTop3}/12\n`);

  store.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
