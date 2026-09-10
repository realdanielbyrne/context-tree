/**
 * ============================================================================
 * EXPERIMENT: Assembler zone I/O — what goes in, what comes out of each zone
 * ============================================================================
 *
 * Results: reports/metrics/assembler-zone-io/results.json
 *
 * WHAT THIS DOES
 * --------------
 * Drives the SHIPPED ZoneAssembler (packages/core) over a deterministic synthetic
 * session, sweeping the context window W, and reports for each zone what it
 * admitted and what it dropped/truncated. No live model — summaries are fixed
 * strings, so the run is bit-identical across invocations (D8). This is a
 * characterization harness, not a pass/fail test: it makes the zone contract
 * observable so eviction candidates can be reasoned about against real numbers.
 *
 * INPUT (per turn): the store (root task + N phase branches, each with a summary
 * and raw Zone C detail), a window W, tool schemas.
 * OUTPUT per zone: Zone A (frozen system + tools), Zone B (root + branch summaries
 * in creation order, to budget), Zone C (active branch raw detail, truncatable),
 * tail (raw recent events filling headroom). Reported: tokens, block count, how
 * many Zone B branches were dropped, whether Zone C truncated, total occupancy,
 * and the cache-breakpoint count.
 *
 * WHY IT BEARS ON "SHOULD WE HAVE ZONES": it quantifies what Zone B COSTS and what
 * it DISPLACES (does its token share force Zone C truncation / tail eviction) at
 * each W — the empirical input to that question, which the record has only
 * partially answered (Zone B measured inert-to-harmful when raw events fit; its
 * overflow-regime compression role untested).
 *
 * RERUN: node zone-io.mjs   (needs @context-tree/core built)
 * ============================================================================
 */
import { writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT_DIR = join(REPO, 'reports', 'metrics', 'assembler-zone-io');
const D = (p) => join(REPO, 'packages', 'core', 'dist', p);
const WINDOWS = [16384, 32768, 65536, 131072, 200000];
const N_BRANCHES = 150;      // enough Zone B content to exceed budget at small W
const N_TAIL = 12;           // appended retrieval results (the shipped tail = results, not raw events)
const TAIL_TOKENS = 400;     // approx per tail entry
const TS = '2026-01-01T00:00:00.000Z';

const { openInMemoryStore } = await import(D('store/index.js'));
const { FsBlobStore } = await import(D('blobs/index.js'));
const { JsonlTraceLog } = await import(D('trace/index.js'));
const { HeuristicTokenizer } = await import(D('tokens/index.js'));
const { ZoneAssembler } = await import(D('assemble/index.js'));
function gitSha() { try { return execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim(); } catch { return null; } }
const meta = (o = {}) => ({ files: [], symbols: [], tests: [], artifacts: [], open_questions: [], decisions: [], node_ids: [], ...o });

function buildStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-zoneio-'));
  const store = openInMemoryStore();
  const blobs = new FsBlobStore(join(dir, 'blobs'));
  const trace = new JsonlTraceLog(join(dir, 'trace.jsonl'));
  const tokenizer = new HeuristicTokenizer();
  const root = store.insertNode({ parent_id: null, kind: 'task', title: 'fix pricing rounding', span_start_seq: 1, span_end_seq: 1 });
  store.putSummary({ node_id: root.id, model: 'mock-root', text: 'The task is to fix pricing rounding across many modules, edit each, and verify with tests.', meta: meta({ node_ids: [root.id] }) });
  for (let i = 0; i < N_BRANCHES; i++) {
    const phase = ['diagnosis', 'implementation', 'verification'][i % 3];
    const path = `src/mod${i}.ts`;
    const start = trace.lastSeq() + 1;
    trace.append({ type: 'user_message', ts: TS, blob: blobs.put(`please handle module ${i} rounding`) });
    trace.append({ type: 'assistant_message', ts: TS, blob: blobs.put(`starting module ${i}`) });
    const call = trace.append({ type: 'tool_call', ts: TS, tool: 'Edit', path, blob: blobs.put(`post-edit content for module ${i}: ${'rounding logic and boundary handling '.repeat(30)}`) });
    trace.append({ type: 'tool_result', ts: TS, call_seq: call.seq, output_blob: blobs.put(`applied module ${i}`) });
    const end = trace.lastSeq();
    const node = store.insertNode({ parent_id: root.id, kind: 'phase', title: `module ${i}`, phase_type: phase, span_start_seq: start, span_end_seq: end, status: i === N_BRANCHES - 1 ? 'open' : 'closed' });
    store.insertNode({ parent_id: node.id, kind: 'file', title: path, span_start_seq: call.seq, span_end_seq: call.seq, meta_json: { path } });
    store.updateNode(root.id, { span_end_seq: end });
    if (i !== N_BRANCHES - 1) store.putSummary({ node_id: node.id, model: 'mock-leaf',
      text: `Module ${i}: edited ${path}, replaced the naive rounding with banker's rounding at the cent boundary, added a regression test for the half-cent case, and confirmed downstream totals match. ${'Extra detail. '.repeat(6)}`,
      meta: meta({ files: [{ path, start_line: 1, end_line: 20, symbol: 'priceOf' }], symbols: ['priceOf'], node_ids: [node.id] }) });
  }
  return { store, blobs, trace, tokenizer, root, branches: N_BRANCHES };
}

function zoneReport(prompt, totalBranches) {
  const z = {};
  for (const b of prompt.blocks) { z[b.zone] = z[b.zone] ?? { blocks: 0, tokens: 0 }; z[b.zone].blocks++; z[b.zone].tokens += b.tokens; }
  const A = z.A ?? { blocks: 0, tokens: 0 }, B = z.B ?? { blocks: 0, tokens: 0 }, C = z.C ?? { blocks: 0, tokens: 0 }, tail = z.tail ?? z.T ?? { blocks: 0, tokens: 0 };
  // Zone B holds root + included branch summaries; branches present = B.blocks - 1 (root).
  const branchesIncluded = Math.max(0, B.blocks - 1);
  return { A, B, C, tail, branchesIncluded, branchesDropped: Math.max(0, (totalBranches - 1) - branchesIncluded),
    totalTokens: A.tokens + B.tokens + C.tokens + tail.tokens, cacheBreakpoints: (prompt.cacheBreakpoints ?? []).length };
}

function main() {
  const h = buildStore();
  const tailText = `context_fetch result: ${'retrieved raw event text spanning several lines of prior work '.repeat(TAIL_TOKENS / 10)}`;
  const rows = [];
  for (const W of WINDOWS) {
    // Fresh assembler per W so tail state does not carry across windows.
    const asm = new ZoneAssembler({ store: h.store, blobs: h.blobs, trace: h.trace, tokenizer: h.tokenizer, systemContract: 'CONTEXT-TREE CONTRACT: fetch before you edit; peek when in doubt.' });
    for (let t = 0; t < N_TAIL; t++) asm.appendTail({ id: `fetch-${t}`, text: tailText, ephemeral: true });
    const prompt = asm.assemble({ window: W, toolSchemasText: '{"tools":["context_fetch","context_search","context_peek","annotate"]}' });
    const r = zoneReport(prompt, h.branches);
    const bg = prompt.budgets ?? {};
    const budgets = { zoneB: bg.zoneB, zoneC: bg.zoneC, tail: bg.tail, windowRemaining: bg.windowRemaining, overWindow: bg.overWindow, replyAllowance: bg.replyAllowance,
      droppedFromZoneB: (bg.droppedFromZoneB ?? []).length, droppedFromZoneC: bg.droppedFromZoneC ?? 0, evictedFromTail: (bg.evictedFromTail ?? []).length };
    rows.push({ W, ...r, occupancy: +(r.totalTokens / W).toFixed(4), budgets });
  }

  const out = {
    runId: process.env.RUN_ID ?? `assembler-zone-io-${new Date().toISOString().slice(0, 10)}`,
    armId: 'assembler-zone-io@v1', offline: true, model: null, deterministic: true,
    commit: gitSha(), date: new Date().toISOString(),
    corpus: { synthetic: true, branches: h.branches, note: 'root task + N phase branches; branch N-1 is open (Zone C active); no live summarizer (fixed strings).' },
    windows: WINDOWS, rows,
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(out, null, 2));

  console.log(`synthetic store: ${h.branches} branches (1 open) | assembler = shipped ZoneAssembler | deterministic`);
  console.log('\nwhat goes in / comes out of each zone, by window W (tokens):');
  console.log('W'.padStart(8) + 'ZoneA'.padStart(8) + 'ZoneB'.padStart(9) + '(br in/drop)'.padStart(12) + 'ZoneC'.padStart(8) + 'tail'.padStart(7) + 'total'.padStart(8) + 'occ%'.padStart(7) + 'brk'.padStart(5));
  for (const r of rows) {
    console.log(String(r.W).padStart(8) + String(r.A.tokens).padStart(8) + String(r.B.tokens).padStart(9) +
      `${r.branchesIncluded}/${r.branchesDropped}`.padStart(12) + String(r.C.tokens).padStart(8) + String(r.tail.tokens).padStart(7) +
      String(r.totalTokens).padStart(8) + (r.occupancy * 100).toFixed(1).padStart(7) + String(r.cacheBreakpoints).padStart(5));
  }
  console.log('\nbr in/drop = Zone B branch summaries included / dropped (of ' + (h.branches - 1) + ' closed branches).');
  console.log(`wrote ${join('reports', 'metrics', 'assembler-zone-io', 'results.json')}`);
}

main();
