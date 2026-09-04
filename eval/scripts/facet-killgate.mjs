#!/usr/bin/env node
/**
 * Zero-live-token kill gate for the MULTI-INDEX hypothesis.
 *
 * The tree indexes a session on one axis: phase, which is temporal. That axis
 * answers "what happened while we were working on X" and is the wrong shape for
 * a fact identified by its KIND — "the description of the bash command that
 * rebuilt core". Every phase ran bash commands, so every phase summary mentions
 * running them, and the ranking problem is ambiguous by construction. Worse, a
 * phase that IS correctly identified returns a whole replay, in which the answer
 * is one line among hundreds.
 *
 * A facet index is a second axis over the same L0: group events by an EXACT key
 * they already carry, so each entry is one line instead of one replay. This gate
 * measures the three properties that decide whether that helps, and it is the
 * sole source for every facet, coverage and routing figure in
 * `reports/metrics/ds-star-multi-index-report.md` §7-§8:
 *
 *   SIZE        entries and whole-index tokens per facet — cheapness is a
 *               property of key cardinality, not of the idea
 *   COVERAGE    whether the answer exists in a given index AT ALL, which is the
 *               ceiling no ranker can pass
 *   COMBINATOR  routing to the best single index, against fusing all four by
 *               relevance (RRF). These differ, and not in the obvious direction.
 *
 * Deterministic on purpose: keys are `tool` + command head, `path`, extracted
 * fingerprints, and output lines — never an embedding cluster. Exact keys are
 * free, reproducible bit-for-bit as ingestion requires, and introduce no k and
 * no distance threshold. Clustering earns its cost only for groupings with no
 * exact key, which none of these are.
 *
 *   node eval/scripts/facet-killgate.mjs
 */
import { FsBlobStore, HeuristicTokenizer, JsonlTraceLog, storePaths } from '@context-tree/core';
// The lexical ranker is a retrieve-side internal, not on core's public surface;
// imported from the build directly so this gate scores with the SAME function
// the retriever uses rather than a reimplementation of it.
import { buildLexicalIndex, extractFingerprints, lexicalScore, uniqueTerms } from '../../packages/core/dist/retrieve/lexical.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCENARIO = join(REPO, 'eval/fixtures/transplant/s1');
const ARTIFACTS = join(SCENARIO, 'e1b289c32f40');
/** The retriever's own fusion constant, reused so a difference is combinator, not tuning. */
const RRF_K = 60;
/** The depth a search result can actually afford to return (~300 tokens of lines). */
const TOP_N = 10;

const paths = storePaths(join(SCENARIO, 'store'));
const trace = new JsonlTraceLog(paths.trace);
const blobs = new FsBlobStore(paths.blobs);
const tok = new HeuristicTokenizer();
const blobText = (ref) => (ref == null ? '' : blobs.get(ref).toString('utf8'));

/**
 * Four indexes over the same L0, built from fields the events already carry.
 * No LLM, no embedder, no network — the hermeticity ingestion holds itself to.
 * A line entry is bounded at both ends: under 8 characters carries no query
 * signal, over 200 is a minified blob rather than a fact anyone asks about.
 */
function buildIndexes() {
  const F = { file: [], command: [], symbol: [], line: [] };
  for (const event of trace.all()) {
    if (event.type === 'tool_call') {
      const argsText = blobText(event.args_blob);
      let args = {};
      try {
        args = JSON.parse(argsText);
      } catch {
        // Non-JSON arguments still belong in the index; they contribute raw text.
      }
      const tool = event.tool ?? 'unknown';
      const description = typeof args.description === 'string' ? args.description : '';
      const command = typeof args.command === 'string' ? args.command : '';
      // The command head is the second half of the key: `npx vitest` and `git
      // status` are different facets even though both are Bash.
      const head = command.trim().split(/\s+/).slice(0, 2).join(' ');
      F.command.push({
        seq: event.seq,
        key: head === '' ? tool : `${tool}:${head}`,
        line: `[${event.seq}] ${tool}${head === '' ? '' : ` (${head})`}${description === '' ? '' : ` — ${description}`}`,
        hay: `${tool} ${head} ${description} ${command}`,
      });
      if (event.path) {
        F.file.push({ seq: event.seq, key: event.path, line: `[${event.seq}] ${tool} ${event.path}`, hay: `${event.path} ${tool} ${description}` });
      }
      for (const symbol of extractFingerprints(argsText)) {
        F.symbol.push({ seq: event.seq, key: symbol, line: `[${event.seq}] ${symbol}`, hay: `${symbol} ${event.path ?? ''} ${description}` });
      }
    }
    if (event.type === 'tool_result') {
      for (const raw of blobText(event.output_blob).split('\n')) {
        const line = raw.trim();
        if (line.length < 8 || line.length > 200) continue;
        F.line.push({ seq: event.seq, key: String(event.seq), line: `[${event.seq}] ${line}`, hay: line });
      }
    }
  }
  return F;
}

const F = buildIndexes();
const idx = {};
for (const [name, entries] of Object.entries(F)) {
  const docs = entries.map((e) => e.hay);
  idx[name] = { entries, docs, lex: buildLexicalIndex(docs) };
}

/** The shipped hybrid ranker, per index: lexical order fused with exact-grep order. */
function order(name, question) {
  const { entries, docs, lex } = idx[name];
  const qTerms = uniqueTerms(question);
  const lexOrder = entries.map((_, i) => ({ i, s: lexicalScore(lex, qTerms, docs[i]) })).sort((a, b) => b.s - a.s).map((x) => x.i);
  const distinctive = [...extractFingerprints(question)];
  const grepOrder = [];
  if (distinctive.length > 0) {
    const scored = [];
    for (let i = 0; i < docs.length; i += 1) {
      let hits = 0;
      for (const term of distinctive) if (docs[i].includes(term)) hits += 1;
      if (hits > 0) scored.push({ i, hits });
    }
    scored.sort((a, b) => b.hits - a.hits);
    for (const s of scored) grepOrder.push(s.i);
  }
  const rr = new Map();
  for (const o of [lexOrder, grepOrder]) o.forEach((i, rank) => rr.set(i, (rr.get(i) ?? 0) + 1 / (RRF_K + rank + 1)));
  return [...rr.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
}

// Both question sets. They SHARE question ids (`s1-qo01-overflow` names a
// different question in each, and one id is byte-identical in both), so the
// source file travels with each question — without it an aggregation by id
// silently merges two different questions.
const SETS = ['questions-deep.json', 'questions.json'];
const questions = SETS.flatMap((file) =>
  JSON.parse(readFileSync(join(ARTIFACTS, file), 'utf8')).questions.map((q) => ({ ...q, set: file === 'questions-deep.json' ? 'deep' : 'orig' })),
);

console.log('index      entries   whole-index tokens   distinct keys');
for (const [name, { entries }] of Object.entries(idx)) {
  console.log(
    `  ${name.padEnd(8)} ${String(entries.length).padStart(6)}   ${String(tok.count(entries.map((e) => e.line).join('\n'))).padStart(18)}   ${String(new Set(entries.map((e) => e.key)).size).padStart(13)}`,
  );
}

console.log(`\nper question: rank of the entry holding the answer, per index (top-${TOP_N} starred)`);
console.log('question              set    file    command symbol  line    | best single  union(RRF)');
let bestSingleTop = 0;
let unionTop = 0;
let absentAll = 0;
const demotions = [];
for (const q of questions) {
  const holds = (name, i) => q.answer_literals.every((literal) => idx[name].entries[i].hay.includes(literal));
  const per = {};
  for (const name of Object.keys(idx)) {
    const o = order(name, q.question);
    const found = o.findIndex((i) => holds(name, i));
    per[name] = { order: o, rank: found < 0 ? null : found + 1 };
  }
  const present = Object.values(per).filter((p) => p.rank !== null);
  if (present.length === 0) {
    absentAll += 1;
    console.log(`  ${q.id.replace('s1-', '').padEnd(19)} ${q.set.padEnd(6)} ABSENT from all four indexes`);
    continue;
  }
  const best = Object.entries(per).filter(([, p]) => p.rank !== null).sort((a, b) => a[1].rank - b[1].rank)[0];
  if (best[1].rank <= TOP_N) bestSingleTop += 1;
  // Fusion across indexes: each contributes its own top slice, pooled by RRF.
  const pooled = new Map();
  for (const [name, p] of Object.entries(per)) {
    p.order.slice(0, TOP_N).forEach((i, rank) => pooled.set(`${name}:${i}`, (pooled.get(`${name}:${i}`) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  const fused = [...pooled.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const uRank = fused.findIndex((key) => holds(key.split(':')[0], Number(key.split(':')[1])));
  if (uRank >= 0 && uRank < TOP_N) unionTop += 1;
  if (best[1].rank <= TOP_N && !(uRank >= 0 && uRank < TOP_N)) {
    demotions.push(`${q.id.replace('s1-', '')} (${q.set}): ${best[0]}#${best[1].rank} -> union #${uRank < 0 ? '>' + fused.length : uRank + 1}`);
  }
  const cell = (name) => {
    const r = per[name].rank;
    return (r === null ? '-' : `${r}${r <= TOP_N ? '*' : ''}`).padEnd(8);
  };
  console.log(
    `  ${q.id.replace('s1-', '').padEnd(19)} ${q.set.padEnd(6)} ${cell('file')}${cell('command')}${cell('symbol')}${cell('line')}| ${(best[0] + '#' + best[1].rank).padEnd(12)} ${uRank < 0 ? '>' + TOP_N : uRank + 1}`,
  );
}
trace.close();

console.log(`\nrouting to the best single index, answer in top-${TOP_N}: ${bestSingleTop}/${questions.length}`);
console.log(`fusing all four by relevance (RRF),  top-${TOP_N}: ${unionTop}/${questions.length}`);
console.log(`absent from every index: ${absentAll}/${questions.length}  <- the coverage ceiling no ranker can pass`);
if (demotions.length > 0) console.log(`\nanswers found by routing and LOST by fusion:\n  ${demotions.join('\n  ')}`);
console.log(
  '\nABSENT is the honest limit, not a bug. A fact that is not a tool call, a path, a symbol or\n' +
    'an output line has no entry here; and a fact needing TWO literals from two places cannot be\n' +
    'one entry in any single-entry index. Facets are chosen per fact-kind, never universally.',
);
