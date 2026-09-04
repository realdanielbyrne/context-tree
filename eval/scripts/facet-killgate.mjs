#!/usr/bin/env node
/**
 * Zero-live-token kill gate for the FACET INDEX hypothesis.
 *
 * The tree indexes a session on one axis: phase, which is temporal. That axis
 * answers "what happened while we were working on X" and is the wrong shape for
 * a fact identified by its KIND — "the description of the bash command that
 * rebuilt core". Every phase ran bash commands, so every phase summary mentions
 * running them, and the ranking problem is ambiguous by construction. Worse, a
 * phase that IS correctly identified still returns a whole replay, in which the
 * answer is one line among thousands: measured, the oracle arm (perfect
 * ranking, by fiat) scores 13/25 where full context scores 25/25, and 31k
 * tokens of those replays are cut to fit the window.
 *
 * A facet index is a second axis over the same L0: group events by an EXACT key
 * they already carry, and each entry is one line instead of one replay. This
 * gate measures the two properties that decide whether that helps:
 *
 *   RANK     where the entry holding the answer lands, scored by the SAME
 *            lexical ranker the retriever uses on summaries — so the comparison
 *            is index shape, not scoring
 *   PAYLOAD  what the model must read to have the answer in front of it
 *
 * Deterministic on purpose: the key is `tool_name` (plus the command head for
 * bash), never an embedding cluster. Exact keys are free, reproducible
 * bit-for-bit across runs as ingestion requires, and introduce no k and no
 * distance threshold. Clustering earns its cost only for groupings with no
 * exact key, which this is not.
 *
 *   node eval/scripts/facet-killgate.mjs [questions-deep.json]
 */
import { FsBlobStore, HeuristicTokenizer, JsonlTraceLog, openStore, storePaths } from '@context-tree/core';
// The lexical ranker is a retrieve-side internal, not on core's public surface;
// imported from the build directly so this gate scores with the SAME function
// the retriever uses rather than a reimplementation of it.
import { buildLexicalIndex, lexicalScore, uniqueTerms } from '../../packages/core/dist/retrieve/lexical.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCENARIO = join(REPO, 'eval/fixtures/transplant/s1');
const ARTIFACTS = join(SCENARIO, 'e1b289c32f40');

const questionsFile = process.argv[2] ?? 'questions-deep.json';
const questionsPath = join(ARTIFACTS, questionsFile);
if (!existsSync(questionsPath)) throw new Error(`no question set at ${questionsPath}`);
const questions = JSON.parse(readFileSync(questionsPath, 'utf8')).questions;

const paths = storePaths(join(SCENARIO, 'store'));
const trace = new JsonlTraceLog(paths.trace);
const blobs = new FsBlobStore(paths.blobs);
const store = openStore(paths.db);
const tok = new HeuristicTokenizer();

/**
 * The facet index, built from L0 alone: one entry per tool call, carrying the
 * fields the event already has. No LLM, no embedder, no network — the same
 * hermeticity ingestion holds itself to.
 */
function buildFacets() {
  const entries = [];
  for (const event of trace.all()) {
    if (event.type !== 'tool_call') continue;
    const ref = event.args_blob;
    const text = ref === undefined || ref === null ? '' : blobs.get(ref).toString('utf8');
    let args = {};
    try {
      args = JSON.parse(text);
    } catch {
      // A tool call whose args are not JSON still belongs in the index; it just
      // contributes its raw text rather than parsed fields.
    }
    const tool = event.tool ?? 'unknown';
    const description = typeof args.description === 'string' ? args.description : '';
    const command = typeof args.command === 'string' ? args.command : '';
    // The command head is the second half of the key: `npx vitest` and `git
    // status` are different facets even though both are Bash.
    const head = command.trim().split(/\s+/).slice(0, 2).join(' ');
    entries.push({
      seq: event.seq,
      key: head === '' ? tool : `${tool}:${head}`,
      // What the model would see for this entry: one line, not a replay.
      line: `[${event.seq}] ${tool}${head === '' ? '' : ` (${head})`}${description === '' ? '' : ` — ${description}`}`,
      haystack: `${tool} ${head} ${description} ${command}`,
    });
  }
  return entries;
}

const facets = buildFacets();
const docs = facets.map((f) => f.haystack);
const index = buildLexicalIndex(docs);
const wholeIndexTokens = tok.count(facets.map((f) => f.line).join('\n'));

console.log(`facet index: ${facets.length} tool-call entries, ${new Set(facets.map((f) => f.key)).size} distinct keys`);
console.log(`whole index as one payload: ${wholeIndexTokens} tokens\n`);

let top1 = 0;
let top3 = 0;
let absent = 0;
for (const q of questions) {
  const literal = q.answer_literals[0];
  const queryTerms = uniqueTerms(q.question);
  const scored = facets
    .map((f, i) => ({ f, score: lexicalScore(index, queryTerms, docs[i]) }))
    .sort((a, b) => b.score - a.score);
  // The entry that actually holds the answer, wherever it ranked.
  const truthIdx = scored.findIndex((s) => s.f.haystack.includes(literal));
  const rank = truthIdx === -1 ? null : truthIdx + 1;
  if (rank === null) absent += 1;
  else if (rank === 1) top1 += 1;
  if (rank !== null && rank <= 3) top3 += 1;
  // What it COSTS to have the answer in hand. The point of a facet index is
  // that an entry is a line, not a replay — so when ranking is mediocre the
  // answer is bought by returning more entries, which is affordable here in a
  // way that returning more branch replays never is.
  const cost = (n) => tok.count(scored.slice(0, n).map((s) => s.f.line).join('\n'));
  console.log(
    `  ${q.id} (${q.kind}): rank ${rank === null ? 'ABSENT from the facet index' : rank}` +
      (rank === null ? '' : `  |  payload to include it: top-${rank} = ${cost(rank)} tok` +
        `   (top-10 = ${cost(10)}, top-20 = ${cost(20)}, whole index = ${wholeIndexTokens})`),
  );
}
store.close();
trace.close();

const present = questions.length - absent;
let inTop10 = 0;
let inTop20 = 0;
for (const q of questions) {
  const queryTerms = uniqueTerms(q.question);
  const scored = facets.map((f, i) => ({ f, score: lexicalScore(index, queryTerms, docs[i]) })).sort((a, b) => b.score - a.score);
  const idx = scored.findIndex((s) => s.f.haystack.includes(q.answer_literals[0]));
  if (idx >= 0 && idx < 10) inTop10 += 1;
  if (idx >= 0 && idx < 20) inTop20 += 1;
}
console.log(`\ntop-1: ${top1}/${questions.length}   top-3: ${top3}/${questions.length}   top-10: ${inTop10}/${questions.length}   top-20: ${inTop20}/${questions.length}   absent: ${absent}/${questions.length}`);
console.log(`of the ${present} question(s) this facet can represent at all: top-10 covers ${inTop10}/${present}, top-20 covers ${inTop20}/${present}`);
console.log(
  'ABSENT is the honest limit, not a bug: a fact that is not a tool call has no entry here and needs a\n' +
    'different facet (a symbol index for identifiers). Facets are chosen per fact-kind, never universally.',
);
