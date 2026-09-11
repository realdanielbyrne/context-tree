/**
 * ============================================================================
 * EXPERIMENT: buried detail — does the MIDDLEWARE reducer PRESERVE the answer?
 * ============================================================================
 * The read-loop break-out (report-readloop.md) reduces a large tool result's
 * footprint. The operator's point: a reducer only breaks the loop WITHOUT losing
 * the task if it preserves what the task needs. This tests that directly, isolated
 * from agent-loop dynamics: SINGLE-TURN QA on the reduced document.
 *
 * One variable = the reducer (the plugin's tool.execute.after payload):
 *   none          — full doc (answer present, heavy)
 *   summarize     — gist (headings + first lines): the buried number is DROPPED
 *   chunk_retrieve — the span most relevant to the question, verbatim: number KEPT
 *
 * A long spec buries "payments API rate limit is 137 requests per minute". We ask
 * the local model the question given the REDUCED doc; success = it answers 137.
 *
 * PREDICTION: none + chunk_retrieve PASS; summarize FAILS (137 not in the gist).
 * Confirms: summarization is insufficient for a buried detail; chunk+retrieve is
 * the right reducer. (A separate finding from the agent-loop version: with a grep
 * tool, a capable agent ROUTES AROUND lossy summarization by re-fetching — on-demand
 * retrieval — so summarize is lossy-but-not-always-fatal when the agent can search.)
 *
 * RERUN: node experiments/coding-harness/buried-detail.mjs
 * ============================================================================
 */
import { generate, MODEL, writeResults, gitSha, nowISO, estTok } from '../rung-1-live-probe/lib.mjs';
import { REDUCERS } from './reducers.mjs';

const SECRET = 137;
function makeSpec() {
  const topics = ['Overview', 'Authentication', 'Accounts API', 'Ledger API', 'Webhooks', 'Payments API',
    'Refunds API', 'Idempotency', 'Errors', 'Pagination', 'Rate Limits', 'Sandbox', 'Versioning', 'Changelog'];
  const filler = (t) => `This section documents the ${t} surface. It covers request and response shapes, ` +
    `field semantics, and common integration patterns. Clients should follow the conventions described here ` +
    `and consult the reference for exhaustive field lists. Typical usage involves configuring credentials, ` +
    `issuing requests, and handling responses idempotently. See related sections for cross-cutting concerns.`;
  const lines = ['# Service Specification', ''];
  for (const t of topics) {
    lines.push(`## ${t}`, filler(t));
    if (t === 'Rate Limits') lines.push(`Per-endpoint limits apply. In particular, the payments API rate limit is ${SECRET} requests per minute; exceeding it returns HTTP 429.`);
    lines.push('');
  }
  return lines.join('\n');
}

const SYSTEM = 'Answer using ONLY the provided document. Reply with just the number asked for, or exactly UNKNOWN if the document does not contain it.';
const QUESTION = 'What is the payments API rate limit, in requests per minute?';

async function main() {
  const spec = makeSpec();
  const arms = [];
  for (const name of ['none', 'summarize', 'chunk_retrieve']) {
    const ctx = REDUCERS[name]({ out: spec, task: QUESTION });
    const present = /\b137\b/.test(ctx); // does the reduced content still contain the answer? (retrieval ceiling)
    const r = await generate({ system: SYSTEM, user: `Document:\n"""\n${ctx}\n"""\n\n${QUESTION}`, maxTokens: 24, temperature: 0, think: false });
    const success = /\b137\b/.test(r.grade_text);
    arms.push({ reducer: name, answer_present_in_reduced: present, model_success: success, answer: (r.grade_text || '').slice(0, 30), ctx_tokens: estTok(ctx), prompt_tokens: r.usage.prompt_tokens ?? null });
    process.stderr.write(`${name}: present=${present} model=${success ? 'PASS' : 'FAIL'} ans=${JSON.stringify((r.grade_text || '').slice(0, 20))}\n`);
  }
  const out = {
    manifest: {
      run_id: `buried-detail-${Date.now()}`, experiment: 'coding-harness / buried-detail (single-turn QA on reduced doc)',
      model: MODEL, buried_value: SECRET, seam: 'middleware reducer (plugin tool.execute.after payload)', full_spec_tokens: estTok(spec),
      commit: gitSha(), date: nowISO(),
      falsification: 'summarize is insufficient for a buried detail IFF summarize FAILS while chunk_retrieve PASSES (answer present + model answers)',
      caveats: ['n=1 per arm, temp 0 (deterministic). Single model/task.', 'Single-turn isolates the reducer (no agent loop / no grep bypass).', 'Chunk retrieval is BM25-ish overlap vs the question — a weak retriever; a real one is stronger.', 'Text-only; PDF/vision needs an image model.'],
    },
    arms,
  };
  const path = writeResults('coding-harness', 'results-buried-detail.json', out);
  console.error('\n=== BURIED DETAIL (single-turn; reducer = one variable) ===  [answer-present | model | ctx-tokens]');
  for (const a of arms) console.error(`  ${a.reducer.padEnd(14)} present=${a.answer_present_in_reduced}  model=${a.model_success ? 'PASS' : 'FAIL'}  ctx_tok=${a.ctx_tokens}  ans=${JSON.stringify(a.answer)}`);
  const s = Object.fromEntries(arms.map((a) => [a.reducer, a.model_success]));
  console.error(`\n  hypothesis (summarize insufficient, chunk needed): ${s.summarize === false && s.chunk_retrieve === true ? 'CONFIRMED' : 'not confirmed'}`);
  console.error(`  written: ${path}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
