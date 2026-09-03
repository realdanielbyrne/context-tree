/**
 * DS-STAR kill gate 2: Can event-level embeddings find the answer-bearing
 * event within its branch? If fewer than 6 of 12 answer events rank in top-5,
 * the embedding model can't discriminate at event level and the two-stage
 * retrieval design is dead.
 *
 * Cost: ~$0.003 in embedding tokens (one batch per question's target branch).
 */
import {
  storePaths, openStore, JsonlTraceLog, FsBlobStore,
  loadApiKeys, loadDotEnv,
} from '@context-tree/core';
import { TreeRetriever } from '@context-tree/core';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

loadDotEnv();

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'killgate2-'));
cpSync(join(REPO, 'eval/fixtures/transplant/s1/store'), tmp, { recursive: true });
const paths = storePaths(tmp);
const store = openStore(paths.db);
const trace = new JsonlTraceLog(paths.trace);
const blobs = new FsBlobStore(paths.blobs);

const keys = loadApiKeys();
const apiKey = keys.openai ?? process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY not set');

async function embed(texts) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!resp.ok) throw new Error(`OpenAI embedding error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.data.map(d => new Float32Array(d.embedding));
}

function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const questions = JSON.parse(readFileSync(join(REPO, 'eval/fixtures/transplant/s1/e1b289c32f40/questions.json'), 'utf8')).questions;
const nodes = store.nodesInCreationOrder().filter(n => n.kind === 'phase');
const nodeById = new Map(nodes.map(n => [n.id, n]));

// Answer event seqs from the blob tracing analysis
const answerSeqs = {
  's1-q01-head': 174, 's1-q02-head': 557, 's1-q03-head': 17,
  's1-q04-tail': 727, 's1-q05-tail': 743, 's1-q06-tail': 745,
  's1-q07-deep': 54,  's1-q08-deep': 558, 's1-q09-deep': 40,
  's1-q10-spanning': 172, 's1-q11-spanning': 466, 's1-q12-spanning': 690,
};

console.log('=== Kill Gate 2: Event-level embedding ranking within target branch ===\n');

let passes = 0, total = 0, totalTokens = 0;

for (const q of questions) {
  const targetNode = nodeById.get(q.node_id);
  if (!targetNode) { console.log(`${q.id}: target node ${q.node_id} not found`); continue; }
  const { span_start_seq: start, span_end_seq: end } = targetNode;
  if (start == null || end == null) { console.log(`${q.id}: no span`); continue; }

  const events = [];
  for (const ev of trace.read({ from: start, to: end })) {
    const texts = [];
    for (const field of ['blob', 'args_blob', 'output_blob']) {
      const ref = ev[field];
      if (typeof ref === 'string') {
        try { texts.push(blobs.getTextPrefix(ref, 2048)); } catch {}
      }
    }
    const text = texts.join('\n').slice(0, 2048);
    if (text.length > 10) events.push({ seq: ev.seq, type: ev.type, text });
  }

  if (events.length === 0) { console.log(`${q.id}: no text events in branch ${q.node_id}`); continue; }

  const allTexts = [q.question, ...events.map(e => e.text)];
  totalTokens += allTexts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);

  let vectors;
  try { vectors = await embed(allTexts); } catch (e) { console.log(`${q.id}: ${e.message}`); continue; }

  const queryVec = vectors[0];
  const ranked = events.map((ev, i) => ({
    seq: ev.seq, type: ev.type, sim: cosine(queryVec, vectors[i + 1]),
  })).sort((a, b) => b.sim - a.sim);

  const answerSeq = answerSeqs[q.id];
  const answerRank = ranked.findIndex(r => r.seq === answerSeq) + 1;
  const inTop5 = answerRank > 0 && answerRank <= 5;
  total++;
  if (inTop5) passes++;

  const lit = q.answer_literals[0]?.slice(0, 40) ?? '?';
  console.log(`${q.id.padEnd(20)} answer_seq=${String(answerSeq).padEnd(4)} rank=${String(answerRank || 'MISS').padEnd(4)}/${ranked.length} ${inTop5 ? 'PASS' : 'FAIL'}  "${lit}"`);
  console.log(`  top-3: ${ranked.slice(0, 3).map(r => `seq=${r.seq}(${r.sim.toFixed(3)})`).join(', ')}`);
}

console.log(`\n=== Result: ${passes}/${total} answer events in top-5 (gate threshold: ≥6/12) ===`);
console.log(`Estimated embedding tokens: ~${totalTokens}`);
console.log(passes >= 6 ? '>>> GATE PASSES — event-level embeddings can discriminate <<<' : '>>> GATE FAILS — embeddings cannot find the answer event <<<');

store.close();
