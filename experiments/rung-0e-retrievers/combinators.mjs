/**
 * ============================================================================
 * EXPERIMENT: Rung 0e Phase 2c — coverage-aware combinators
 * ============================================================================
 *
 * Source plan: reports/hypothesis-test-ladder.md, Rung 0 item 0e.
 * Results: reports/metrics/rung-0e-retrievers/results-combinators.json
 * Shared retriever/corpus code: ./lib.mjs
 *
 * WHY
 * ---
 * Phase 2 showed RRF WINS on mixed traffic (overlapping coverage) but LOSES on
 * single-style queries (only one retriever covers → the others demote its hit).
 * The unifying variable is coverage overlap. So the combinator should be
 * COVERAGE-AWARE. Two candidates, tested INDIVIDUALLY (one variable each):
 *
 *   router-feature   — a heuristic router on the query's SURFACE FORM (not the
 *                      gold stratum): symbol/typo → grep/fuzzy, identifier+value
 *                      phrasing → grep, structural phrasing → graft, else → vector.
 *   gated-rrf(gate)  — RRF, but a retriever joins the fusion only if it is
 *                      CONFIDENT: it returned a hit AND its top-1→top-2 relative
 *                      margin ≥ gate. Non-covering retrievers (flat/empty) self-
 *                      exclude, so they can't demote the covering one. gate is
 *                      SWEPT {0,0.1,0.25,0.5}; gate=0 ≡ plain RRF (the baseline).
 *
 * Baselines carried through: best-single, rrf (=gated 0), router-oracle (route
 * by TRUE stratum — the routing ceiling).
 *
 * TEST SET: a MIXED 20-question set — structural/literal/fuzzy (from the repo
 * benchmark) + the 8 paraphrase-pure hardened-semantic questions — so both
 * regimes (multi-coverage and single-coverage) are present. A good coverage-aware
 * arm must match RRF on the multi-coverage strata AND vector on hard-semantic.
 *
 * JUDGE: ground-truth answer FILE in top-k. CAVEAT: n=20 (directional); file-level.
 * RERUN: node combinators.mjs   (needs real graft CLI + MiniLM model)
 * ============================================================================
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  OUT_DIR, buildChunks, makeEmbedder, buildRankers, rrf, hit, files, queryTerms,
  gitSha, graftVersion, sourceFiles, CHUNK,
} from './lib.mjs';

const TOPK = [1, 3, 5];
const GATES = [0, 0.1, 0.25, 0.5];
const STRATA = ['structural', 'literal', 'semantic', 'fuzzy'];
const EXPECTED = { structural: 'graft', literal: 'grep', semantic: 'vector', fuzzy: 'fuzzy' };

// Mixed set: repo-benchmark's structural/literal/fuzzy + hardened semantic (data union).
const QUESTIONS = [
  { id: 'st1', stratum: 'structural', q: 'What functions call excerptAround?', file: 'packages/core/src/retrieve/retriever.ts' },
  { id: 'st2', stratum: 'structural', q: 'Which file parses edited blobs into minimal enclosing named spans using tree-sitter grammars?', file: 'packages/core/src/spans/extractor.ts' },
  { id: 'st3', stratum: 'structural', q: 'Where is the lexical index built and which function consumes it during search?', file: 'packages/core/src/retrieve/retriever.ts' },
  { id: 'st4', stratum: 'structural', q: 'How does the MCP context_search tool connect to the retriever and providers?', file: 'packages/mcp/src/tools/context-search.ts' },
  { id: 'li1', stratum: 'literal', q: 'What is the value of the constant RRF_K?', file: 'packages/core/src/retrieve/retriever.ts' },
  { id: 'li2', stratum: 'literal', q: 'What is the default excerptChars in the retrieval config?', file: 'packages/core/src/config.ts' },
  { id: 'li3', stratum: 'literal', q: 'What DEFAULT_TIMEOUT_MS does the graft provider use?', file: 'packages/core/src/providers/graft.ts' },
  { id: 'li4', stratum: 'literal', q: 'What are the default retrieval provider names in the config?', file: 'packages/core/src/config.ts' },
  { id: 'fz1', stratum: 'fuzzy', q: 'excrptAround', file: 'packages/core/src/retrieve/excerpt.ts' },
  { id: 'fz2', stratum: 'fuzzy', q: 'detctAttentionSignals', file: 'packages/core/src/attention/signals.ts' },
  { id: 'fz3', stratum: 'fuzzy', q: 'TreeSiterSpanExtractor', file: 'packages/core/src/spans/extractor.ts' },
  { id: 'fz4', stratum: 'fuzzy', q: 'buildTopicIndx', file: 'packages/core/src/attention/topic-index.ts' },
  { id: 'h1', stratum: 'semantic', q: 'When someone rewrites an early message, which part works out how much of the previously sent conversation the model host can still reuse without being billed to read it again?', file: 'packages/core/src/cache/prefix.ts' },
  { id: 'h2', stratum: 'semantic', q: 'What imitates the way a language-model host charges for input so a test can prove that a small change to the prompt did not needlessly force the whole thing to be re-read and re-paid?', file: 'packages/core/src/cache/simulator.ts' },
  { id: 'h3', stratum: 'semantic', q: 'Which piece ranks older parts of the dialogue by how likely they still matter and sets aside the ones that no longer bear on the work at hand?', file: 'packages/core/src/attention/policy.ts' },
  { id: 'h4', stratum: 'semantic', q: 'Where is the running record of actions split into stages so that each stage can later be condensed on its own?', file: 'packages/core/src/segment/segment.ts' },
  { id: 'h5', stratum: 'semantic', q: 'How does the tool judge which earlier passage best answers a request using only word counts, for the case where numeric meaning vectors are not available?', file: 'packages/core/src/retrieve/lexical.ts' },
  { id: 'h6', stratum: 'semantic', q: 'Which part builds the final block of text handed to the model out of a frozen header, short overviews of past work, and the detail of whatever is being worked on now?', file: 'packages/core/src/assemble/assembler.ts' },
  { id: 'h7', stratum: 'semantic', q: 'Where are hits from several different lookup helpers combined into one ordered list, taking care that a confident answer from one helper is not buried by noise from the others?', file: 'packages/core/src/providers/merge.ts' },
  { id: 'h8', stratum: 'semantic', q: 'Which piece judges whether a past step could simply be run again to reproduce its output, so that output need not be carried along?', file: 'packages/core/src/attention/rederive.ts' },
];

// --- confidence: relative top-1 → top-2 margin of a scored list (0 if empty) ---
function margin(scored) {
  if (scored.length === 0) return 0;
  const s0 = scored[0].score; const s1 = scored[1]?.score ?? 0;
  return s0 > 0 ? (s0 - s1) / s0 : 0;
}

// --- gated RRF: fuse only retrievers that returned a hit AND clear the margin gate ---
function gatedRrf(scoredByName, gate) {
  const included = Object.values(scoredByName).filter((s) => s.length > 0 && margin(s) >= gate);
  const use = included.length > 0 ? included : Object.values(scoredByName).filter((s) => s.length > 0);
  return rrf(use.map(files));
}

// --- feature router: choose ONE retriever from the query's surface form ---
const ID_RX = /`[^`]+`|['"][^'"]{3,}['"]|\b[A-Z][A-Z0-9_]{3,}\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/;
function routeFeature(q, scoredByName) {
  const toks = q.trim().split(/\s+/);
  if (toks.length === 1) { // a bare symbol → exact if the corpus has it, else typo
    return (scoredByName.grep && scoredByName.grep.length > 0) ? 'grep' : 'fuzzy';
  }
  const hasId = ID_RX.test(q) || queryTerms(q).some((t) => /[A-Z_]/.test(t) || t.includes('/'));
  const literalPhrasing = /\b(value|default|constant|timeout|names?)\b/i.test(q);
  const structuralPhrasing = /\b(call|calls|caller|connect|connects|implement|parses|consume|which file|how does)\b/i.test(q);
  if (hasId && literalPhrasing) return 'grep';
  if (hasId && structuralPhrasing) return 'graft';
  if (hasId) return 'grep';
  return 'vector'; // natural-language, no identifier → semantic
}

async function main() {
  const emb = await makeEmbedder();
  const chunks = await buildChunks();
  const rankers = await buildRankers(chunks, emb);
  const names = Object.keys(rankers);

  const perQ = [];
  for (const item of QUESTIONS) {
    const scored = {};
    for (const n of names) scored[n] = await rankers[n](item.q);
    const lists = Object.fromEntries(names.map((n) => [n, files(scored[n])]));
    const arms = {
      rrf: rrf(Object.values(lists)),
      'router-oracle': lists[EXPECTED[item.stratum]] ?? [],
      'router-feature': lists[routeFeature(item.q, scored)] ?? [],
      ...Object.fromEntries(GATES.map((g) => [`gated-rrf@${g}`, gatedRrf(scored, g)])),
    };
    perQ.push({ ...item, lists, arms, routedTo: routeFeature(item.q, scored) });
    process.stderr.write('.');
  }
  process.stderr.write('\n');

  const armNames = ['best-single', 'rrf', 'router-oracle', 'router-feature', ...GATES.map((g) => `gated-rrf@${g}`)];
  const bestSingle = {};
  for (const k of TOPK) bestSingle[k] = Math.max(...names.map((n) => perQ.filter((x) => hit(x.lists[n], x.file, k)).length)) / perQ.length;

  function rate(pick, set, k) { return +(set.filter((x) => hit(pick(x), x.file, k)).length / (set.length || 1)).toFixed(3); }
  const overall = {}; const byStratum = {};
  for (const arm of armNames) {
    const pick = arm === 'best-single' ? null : (x) => x.arms[arm];
    overall[arm] = {};
    byStratum[arm] = {};
    for (const k of TOPK) {
      overall[arm][k] = arm === 'best-single' ? +bestSingle[k].toFixed(3) : rate(pick, perQ, k);
      for (const s of STRATA) byStratum[arm][`${s}@${k}`] = arm === 'best-single'
        ? Math.max(...names.map((n) => perQ.filter((x) => x.stratum === s && hit(x.lists[n], x.file, k)).length))
        : perQ.filter((x) => x.stratum === s && hit(pick(x), x.file, k)).length;
    }
  }

  const out = {
    runId: process.env.RUN_ID ?? `rung-0e-combinators-${new Date().toISOString().slice(0, 10)}`,
    armId: 'coverage-aware-combinators@v1', rung: '0e-phase2c', offline: true,
    corpus: 'context-tree repo (each package src TypeScript)', graft: 'real CLI ' + graftVersion(),
    setup: { chunker: `RecursiveCharacterTextSplitter(${CHUNK.chunkSize}/${CHUNK.chunkOverlap})`, chunks: chunks.length, files: sourceFiles().length, topK: TOPK, gates: GATES, embedModel: emb.ok ? 'Xenova/all-MiniLM-L6-v2' : null },
    judge: 'ground-truth answer FILE in top-k', commit: gitSha(), date: new Date().toISOString(),
    questions: QUESTIONS.length, strata: STRATA, stratumCounts: Object.fromEntries(STRATA.map((s) => [s, QUESTIONS.filter((q) => q.stratum === s).length])),
    caveat: 'n=20 mixed (semantic=8 hardened, others=4 each). File-level judge. gate=0 gated-rrf ≡ plain rrf. router-feature uses surface form only, not the gold stratum.',
    vectorAvailable: emb.ok,
    overall, byStratum,
    routing: perQ.map((x) => ({ id: x.id, stratum: x.stratum, routedTo: x.routedTo, routedCorrect: x.routedTo === EXPECTED[x.stratum] })),
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results-combinators.json'), JSON.stringify(out, null, 2));
  printSummary(out, armNames);
  console.log(`\nwrote ${join('reports', 'metrics', 'rung-0e-retrievers', 'results-combinators.json')}`);
}

function printSummary(out, armNames) {
  console.log(`corpus: ${out.setup.files} files → ${out.setup.chunks} chunks | n=${out.questions} (${JSON.stringify(out.stratumCounts)})`);
  console.log(`\noverall file-in-top-k by arm:`);
  console.log('arm'.padEnd(16) + TOPK.map((k) => `@${k}`.padStart(7)).join(''));
  for (const arm of armNames) console.log(arm.padEnd(16) + TOPK.map((k) => `${(out.overall[arm][k] * 100).toFixed(0)}%`.padStart(7)).join(''));
  console.log(`\nper-stratum @5 (count of that stratum's questions):`);
  console.log('arm'.padEnd(16) + STRATA.map((s) => `${s.slice(0, 6)}/${out.stratumCounts[s]}`.padStart(10)).join(''));
  for (const arm of armNames) console.log(arm.padEnd(16) + STRATA.map((s) => String(out.byStratum[arm][`${s}@5`]).padStart(10)).join(''));
  const rc = out.routing.filter((r) => r.routedCorrect).length;
  console.log(`\nrouter-feature routing accuracy: ${rc}/${out.routing.length} (route matched the expected retriever for the stratum)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
