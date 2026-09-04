#!/usr/bin/env node
/**
 * Zero-live-token gate for the `tree-snippet-hits` arm (DS-STAR Fable-interface
 * pass, iteration 3). Replays the search queries the model ACTUALLY issued in
 * the iteration-1 cell at W=131072 through the new handler and reports, per
 * query: hits returned, excerpt characters, exact tokens of the whole result
 * as the model would receive it (after the harness's snippet/text strip), the
 * visible rank of the answer branch, and whether any excerpt already carries
 * the answer literal — the claude.ai probe's "answered from the snippet, no
 * read" outcome, measured offline on our own substrate.
 *
 * Gates:
 *   NS1 excerpt survives the strip     — the field the model sees is non-empty
 *   NS2 payload fits                    — result tokens < 1/4 of the 18k headroom at W=131072
 *   NS3 mechanism fires on every query  — >= 1 hit with an excerpt
 *   NS4 (report only) literal-in-excerpt rate and answer visible rank
 *
 *   node eval/scripts/snippet-hits-killgate.mjs [results-file.json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TreeRetriever } from '@context-tree/core';
import { openScenario, handlersForArm, exact, SNIPPET_HIT_COUNT, SNIPPET_CHARS } from './transplant.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ART = join(REPO, 'eval/fixtures/transplant/s1/e1b289c32f40');
const resultsDir = join(ART, 'results');
const file = process.argv[2] ?? readdirSync(resultsDir)
  .filter((f) => f.startsWith('run-W131072-truncate-tail+tree-tail-v2+tree-search-coordinates-questions-deep'))
  .sort().at(-1);
const rows = JSON.parse(readFileSync(join(resultsDir, file), 'utf8')).rows;
const questions = JSON.parse(readFileSync(join(ART, 'questions-deep.json'), 'utf8')).questions;

const scenario = openScenario('s1');
const retriever = new TreeRetriever({ store: scenario.store, blobs: scenario.blobs, trace: scenario.trace, retrievalCenterFingerprintMode: 'bare-filename' });
const ctx = {
  config: scenario.config,
  handle: { config: scenario.config, paths: scenario.paths, trace: scenario.trace, blobs: scenario.blobs, store: scenario.store, close() {} },
  retriever,
  _searchObservations: [],
};
const search = handlersForArm('tree-snippet-hits')['context_search'];
const HEADROOM_W131072 = 18339; // A2 §2, first tool turn

const out = [];
let fail = [];
for (const q of questions) {
  const queries = [...new Set(rows.filter((r) => r.question === q.id && r.arm !== 'truncate-tail').flatMap((r) => r.searchQueries ?? []))];
  for (const query of queries) {
    ctx._oracleNodeIds = q.node_ids;
    const outcome = await search(ctx, { query });
    const hits = outcome.data.hits;
    // what the model sees: the harness strips `snippet`/`text`, never `excerpt`
    const visible = hits.map(({ snippet, text: _t, ...rest }) => rest);
    const json = JSON.stringify({ ...outcome.data, hits: visible });
    const tokens = exact.count(json);
    const withExcerpt = visible.filter((h) => typeof h.excerpt === 'string' && h.excerpt.length > 0);
    const literalIn = visible.some((h) => typeof h.excerpt === 'string' && q.answer_literals.some((l) => h.excerpt.includes(l)));
    const rank = visible.findIndex((h) => q.node_ids.includes(h.node_id));
    const seqHit = visible.findIndex((h) => h.seq === q.seq);
    const row = { q: q.id.slice(3, 7), query: query.slice(0, 60), hits: visible.length, withExcerpt: withExcerpt.length, excerptChars: withExcerpt.reduce((s, h) => s + h.excerpt.length, 0), tokens, answerRank: rank < 0 ? null : rank + 1, answerSeqRank: seqHit < 0 ? null : seqHit + 1, literalInExcerpt: literalIn };
    out.push(row);
    if (withExcerpt.length === 0) fail.push(`NS1/NS3 ${q.id} ${query}`);
    if (tokens >= HEADROOM_W131072 / 4) fail.push(`NS2 ${q.id} ${tokens} tokens`);
  }
}
console.table(out);
const lit = out.filter((r) => r.literalInExcerpt).length;
console.log(`k=${SNIPPET_HIT_COUNT} chars=${SNIPPET_CHARS} | queries=${out.length} | literal in an excerpt: ${lit}/${out.length} | answer branch visible: ${out.filter((r) => r.answerRank !== null).length}/${out.length} | answer EVENT visible: ${out.filter((r) => r.answerSeqRank !== null).length}/${out.length} | tokens median ${[...out.map((r) => r.tokens)].sort((a, b) => a - b)[Math.floor(out.length / 2)]}`);
// Gate artifact, not just the pass bit: print one excerpt per question.
for (const q of questions) {
  const query = (rows.find((r) => r.question === q.id && (r.searchQueries ?? []).length > 0)?.searchQueries ?? [])[0];
  if (!query) continue;
  ctx._oracleNodeIds = q.node_ids;
  const { data } = await search(ctx, { query });
  const h = data.hits[0];
  console.log(`\n--- ${q.id} query=${JSON.stringify(query)} top hit: ${h.title} rank_branch=${h.branch_rank} seq=${h.seq}\n${String(h.excerpt).slice(0, 400)}`);
}
console.log(fail.length === 0 ? '\nALL GATES PASS' : `\nGATE FAILURES:\n${fail.join('\n')}`);
process.exit(fail.length === 0 ? 0 : 1);
