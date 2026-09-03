#!/usr/bin/env node
/**
 * Tests enriched summary documents: beam search where each branch's summary
 * document is augmented with distinctive keywords extracted from its raw events.
 * Offline, zero API tokens.
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
  const phaseNodes = nodes.filter(n => n.kind === 'phase');

  // Step 1: Extract raw event keywords per branch
  console.log(`\nExtracting raw event keywords for ${phaseNodes.length} phase nodes...`);
  const branchKeywords = new Map(); // nodeId -> Set<string>
  const globalTF = new Map(); // term -> total count across all branches

  for (const node of phaseNodes) {
    try {
      const fetched = retriever.fetchBranch(node.id, { depth: 'full' });
      const terms = extractTerms(fetched.text);
      const unique = new Set(terms);
      branchKeywords.set(node.id, unique);
      for (const t of unique) {
        globalTF.set(t, (globalTF.get(t) ?? 0) + 1);
      }
    } catch { branchKeywords.set(node.id, new Set()); }
  }

  // Step 2: Compute TF-IDF-like distinctiveness per branch
  // A term is distinctive for a branch if it appears there but in few other branches
  const branchCount = phaseNodes.length;
  function idf(term) { return Math.log(1 + branchCount / (1 + (globalTF.get(term) ?? 0))); }

  // For each branch, pick top-N most distinctive terms (high IDF, present in branch)
  const TOP_N_VALUES = [20, 50, 100, 200];

  for (const topN of TOP_N_VALUES) {
    const enrichedDocs = new Map();
    for (const node of nodes) {
      const summary = store.currentSummary(node.id);
      // Base document: title + path + summary text + meta
      const parts = [node.title];
      const nodePath = node.meta_json?.path;
      if (typeof nodePath === 'string') parts.push(nodePath);
      if (summary) {
        parts.push(summary.text);
        for (const file of summary.meta.files) parts.push(file.symbol ? `${file.path} ${file.symbol}` : file.path);
        for (const sym of summary.meta.symbols) parts.push(sym);
      }

      // Enrich with distinctive event keywords
      const kw = branchKeywords.get(node.id);
      if (kw) {
        const scored = [...kw].map(t => ({ t, idf: idf(t) })).sort((a, b) => b.idf - a.idf);
        const topTerms = scored.slice(0, topN).map(s => s.t);
        parts.push(topTerms.join(' '));
      }
      enrichedDocs.set(node.id, parts.join('\n'));
    }

    // Build a new index and re-rank
    const allDocs = [...enrichedDocs.values()];
    const df = new Map();
    for (const doc of allDocs) {
      for (const term of new Set(extractTerms(doc))) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const docCount = allDocs.length;
    function idfIndex(term) { return Math.log(1 + docCount / (1 + (df.get(term) ?? 0))); }

    function score(queryTerms, doc) {
      const tf = new Map();
      for (const t of extractTerms(doc)) tf.set(t, (tf.get(t) ?? 0) + 1);
      let matched = 0, mass = 0;
      for (const term of queryTerms) {
        const w = idfIndex(term);
        mass += w;
        const count = tf.get(term);
        if (count !== undefined) matched += w * (1 + Math.log(count));
      }
      return mass === 0 ? 0 : matched / mass;
    }

    let top3Count = 0;
    const results = [];

    for (const q of questions) {
      const queryTerms = uniqueTermsOf(q.question);
      const scored = [];
      for (const node of nodes) {
        if (node.kind === 'task') continue;
        const doc = enrichedDocs.get(node.id) ?? '';
        scored.push({ nodeId: node.id, title: node.title, s: score(queryTerms, doc) });
      }
      scored.sort((a, b) => b.s - a.s);

      const wanted = new Set(q.node_ids ?? [q.node_id]);
      const idx = scored.findIndex(h => wanted.has(h.nodeId));
      const rank = idx === -1 ? 99 : idx + 1;
      if (rank <= 3) top3Count++;
      results.push({ id: q.id, rank });
    }

    console.log(`\n=== ENRICHED (top-${topN} keywords) ===`);
    console.log(`Top-3: ${top3Count}/12 (target: >=8/12) — Gate: ${top3Count >= 8 ? 'PASS' : 'FAIL'}`);
    for (const r of results) {
      console.log(`  ${r.id.padEnd(20)} rank=${String(r.rank).padStart(2)}  ${r.rank <= 3 ? 'TOP-3' : ''}`);
    }
  }

  store.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
