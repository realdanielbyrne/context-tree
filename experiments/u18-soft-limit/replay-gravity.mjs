#!/usr/bin/env node
/**
 * Offline replay of a recorded opencode session through the D27 pipeline, for a grid of
 * gravity settings. CPU only: no model is called (a summary request is answered by a fixed
 * short summary, synchronously — live, it lands a turn or more later).
 *
 * What it can say: where each breakpoint puts the first fold, how many blocks fold, unfold,
 * are summarized and deleted, the peak the host would send, and how many messages change
 * between consecutive turns (every change rewrites the cached prompt after it). What it
 * cannot say: whether the agent would have acted differently — the recorded actions are
 * replayed as they were.
 *
 *   node experiments/u18-soft-limit/replay-gravity.mjs --run <run dir> [--turns N] [--grid grid.json] [--out out.json]
 *
 * A grid is a list of `{ name, env }`, `env` being `CT_CT_*` overrides on the `gravity` arm.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = await import(join(REPO, 'packages/core/dist/index.js'));
const mcp = await import(join(REPO, 'packages/mcp/dist/index.js'));
const { mapOpencodeExport } = await import(join(REPO, 'packages/cli/dist/index.js'));
const { applyDecisions } = await import(join(REPO, 'experiments/context-dedup/oc-plugin/apply-decisions.mjs'));
const { sizeOf } = await import(join(REPO, 'experiments/context-dedup/oc-plugin/size.mjs'));
const { armKnobs, resolveKnobs } = await import(join(REPO, 'experiments/u18-soft-limit/lib.mjs'));
const { policyFromEnv, evictCallFor, assembleWindowFor, reserveOf } = await import(join(REPO, 'experiments/context-dedup/oc-plugin/policy.mjs'));

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const RUN = arg('run');
if (!RUN) throw new Error('--run <run dir> is required');
const TURNS = Number(arg('turns', 'Infinity'));
const TRACE = arg('trace');
const traced = [];
const GRID = arg('grid') ? JSON.parse(readFileSync(arg('grid'), 'utf8')) : [{ name: 'soft', arm: 'soft', env: {} }];

const text = readFileSync(join(RUN, 'export.json'), 'utf8');
const doc = JSON.parse(text.slice(text.indexOf('{')));
const META = { files: [], symbols: [], tests: [], artifacts: [], open_questions: [], decisions: [], node_ids: [] };
const provider = { id: 'fake', complete: async () => ({ text: JSON.stringify({ text: 'Earlier work on this range, folded.', meta: META }), model: 'fake', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], stopReason: 'stop' }) };
const keyOf = (d) => createHash('sha1').update(JSON.stringify(d)).digest('hex');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

async function replay({ name, arm = 'gravity', env: over }) {
  const env = { ...armKnobs(arm, resolveKnobs({})), CT_CT_TRIGGER: 'soft', ...over };
  const root = mkdtempSync(join(tmpdir(), 'ct-gravity-'));
  const pipeline = mcp.pipelineFromEnv(env);
  const config = core.resolveConfig({ root: join(root, '.context-tree'), taskTitle: 'replay', boundary: mcp.boundaryOf(pipeline) }, root);
  const handle = core.openTaskStore(config);
  const ctx = { config, handle, retriever: new core.TreeRetriever({ store: handle.store, blobs: handle.blobs, trace: handle.trace }), session: mcp.createSession(pipeline), summarizer: { provider, model: 'fake' } };
  const policy = policyFromEnv(env);
  const H = mcp.HANDLERS;
  const window = assembleWindowFor(policy);
  const budget = window - reserveOf(policy, window);
  const all = [];
  let previous = new Map();
  const stats = { turns: 0, peak: 0, raw_peak: 0, over_budget_turns: 0, first_fold: null, first_delete: null, folds: 0, unfolds: 0, summary_requests: 0, summaries_written: 0, summaries_rejected: 0, summaries_retired: 0, deleted_by_pull: 0, deleted_by_fit: 0, kappa: [], changed: [], d_after: [], slowest_ms: 0 };
  for (const message of doc.messages) {
    const mapped = mapOpencodeExport({ messages: [message] }, { startSeq: handle.trace.lastSeq(), blobs: handle.blobs });
    for (const { seq: _seq, ...event } of mapped.events) handle.trace.append(event);
    core.ingest({ handle });
    all.push(message);
    if (message.info.role !== 'assistant') continue;
    if (stats.turns >= TURNS) break;
    stats.turns += 1;
    const turn = stats.turns;
    const started = Date.now();
    const sized = all.map((m) => ({ id: m.info.id, hasTools: (m.parts ?? []).some((p) => p.type === 'tool') }));
    const geometry = { window_tokens: window, reserve_tokens: reserveOf(policy, window), turn };
    await H.assemble(ctx, geometry);
    const fold = (await H.fold(ctx, geometry)).data;
    stats.folds += fold.folded.length;
    stats.unfolds += fold.unfolded.length;
    stats.summaries_retired += fold.unsummarized.length;
    stats.summary_requests += fold.summary_requests.length;
    if (fold.folded.length > 0 && stats.first_fold === null) stats.first_fold = turn;
    stats.kappa.push(fold.kappa);
    for (const r of fold.summary_requests) {
      const s = (await H.summarize(ctx, { from_seq: r.from_seq, to_seq: r.to_seq, trigger: 'replay' })).data;
      if (s?.status === 'written') stats.summaries_written += 1; else stats.summaries_rejected += 1;
    }
    const call = evictCallFor(policy, turn, sizeOf(all));
    const { floor: _floor, ...args } = call;
    const ev = (await H.evict(ctx, { ...args, messages: sized })).data;
    stats.deleted_by_pull += ev.deleted_by_pull.length;
    stats.deleted_by_fit += ev.evicted.length - ev.deleted_by_pull.length;
    if (ev.evicted.length > 0 && stats.first_delete === null) stats.first_delete = turn;
    stats.slowest_ms = Math.max(stats.slowest_ms, Date.now() - started);

    const current = new Map(ev.decisions.map((d) => [d.id, keyOf(d)]));
    let changed = 0;
    for (const [id, key] of previous) if (current.get(id) !== key) changed += 1;
    stats.changed.push(changed);
    previous = current;
    const view = all.map((m) => m);
    applyDecisions(view, ev.decisions);
    const kept = sizeOf(view);
    stats.peak = Math.max(stats.peak, kept);
    stats.raw_peak = Math.max(stats.raw_peak, sizeOf(all));
    if (kept > budget) stats.over_budget_turns += 1;
    if (TRACE) traced.push({ name, turn, kept, sidecar_after: ev.tokens_after, fold_after: fold.tokens_after, folded: fold.folded.length, unfolded: fold.unfolded.length, requests: fold.summary_requests.length, evicted: ev.evicted.length, kappa: fold.kappa, d: fold.d_after });
    stats.d_after.push(Math.max(0, (budget - kept) / budget));
  }
  handle.close();
  rmSync(root, { recursive: true, force: true });
  const { kappa, changed, d_after, ...rest } = stats;
  return {
    name, arm, env: over, budget, ...rest,
    kappa_min: Math.min(...kappa), kappa_max: Math.max(...kappa), kappa_last: kappa.at(-1),
    changed_per_turn_median: median(changed), changed_total: changed.reduce((n, c) => n + c, 0),
    d_after_median: median(d_after), d_after_min: Math.min(...d_after),
  };
}

const results = [];
for (const config of GRID) {
  const r = await replay(config);
  results.push(r);
  console.error(JSON.stringify(r));
}
const out = arg('out');
if (TRACE) writeFileSync(TRACE, traced.map((r) => JSON.stringify(r)).join('\n') + '\n');
if (out) writeFileSync(out, `${JSON.stringify({ run: RUN, turns: TURNS, results }, null, 2)}\n`);
