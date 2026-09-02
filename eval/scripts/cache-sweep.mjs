#!/usr/bin/env node
/**
 * Experiment 4 (`eval/plans/tuning/exp-04-caching.md`) — runs the §17 cache
 * assertion harness (`packages/core/src/cache/{simulator,prefix}.ts`), which
 * exists and is offline but was never invoked from `eval/`, over a realistic
 * multi-turn replay of the FROZEN `s1` fixture.
 *
 * Zero model calls, zero network: every number below comes from the real
 * `ZoneAssembler` (`@context-tree/core`) reading a COPY of
 * `eval/fixtures/transplant/s1/store` (the frozen fixture itself is never
 * opened for writing — see `copyFixture` below) plus `ProviderCacheSimulator`
 * under `ANTHROPIC_PROFILE` (4 breakpoints max, 1024-token minimum cacheable
 * prefix — both respected, never relaxed).
 *
 * The replay: walk the store's 21 real phases in creation order; within each
 * phase, grow the (copied) node's `span_end_seq` one real L0 event at a time
 * so Zone C accretes exactly as it would turn-by-turn in a live session, with
 * Zone B restricted (`ZoneBSelection.keepBranches`) to phases already closed
 * at that point in the walk — a resumed session cannot see its own future.
 * 754 events -> 754 turns, the finest and most conservative unit (a coarser
 * "one turn per tool round-trip" choice would only dilute the same event mix).
 *
 * Two assemblers read the SAME walk in lockstep: `shipped` (today's default,
 * 2 breakpoints) and `threeBp` (`cacheZoneCBreakpoint: true`, this pass's
 * opt-in addition). Each feeds its own persistent `ProviderCacheSimulator`.
 *
 * Usage: node eval/scripts/cache-sweep.mjs [maxTurns]
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANTHROPIC_PROFILE,
  DEFAULT_CONFIG,
  FsBlobStore,
  HeuristicTokenizer,
  JsonlTraceLog,
  ProviderCacheSimulator,
  ZoneAssembler,
  cacheReport,
  openStore,
  priceFor,
  storePaths,
  systemContract,
} from '@context-tree/core';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = join(REPO, 'eval/fixtures/transplant/s1', 'store');
const MAX_TURNS = Number.parseInt(process.argv[2] ?? '', 10) || Number.POSITIVE_INFINITY;

const TOOL_SCHEMAS_TEXT = JSON.stringify([
  { name: 'context_fetch', description: 'Fetch full detail for one or more node ids.' },
  { name: 'context_search', description: 'Search branch summaries and detail lexically/semantically.' },
  { name: 'context_peek', description: 'Peek at a node at summary or full depth.' },
  { name: 'annotate', description: 'Record a durable note against a node.' },
]);

/** Never opens the frozen fixture for writing — copies it to a scratch dir. */
function copyFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-cache-sweep-'));
  const storeCopy = join(dir, 'store');
  cpSync(FIXTURE, storeCopy, { recursive: true });
  return { dir, storeCopy };
}

const { dir, storeCopy } = copyFixture();
const paths = storePaths(storeCopy);
const trace = new JsonlTraceLog(paths.trace);
const blobs = new FsBlobStore(paths.blobs);
const store = openStore(paths.db);
const tokenizer = new HeuristicTokenizer();

const phases = store
  .nodesInCreationOrder()
  .filter((n) => n.kind === 'phase')
  .sort((a, b) => a.span_start_seq - b.span_start_seq);

const deps = {
  store,
  blobs,
  trace,
  tokenizer,
  systemContract: systemContract(),
  budgets: { ...DEFAULT_CONFIG.budgets },
};
const shipped = { assembler: new ZoneAssembler(deps), sim: new ProviderCacheSimulator({ tokenizer, profile: ANTHROPIC_PROFILE }) };
const threeBp = {
  assembler: new ZoneAssembler({ ...deps, cacheZoneCBreakpoint: true }),
  sim: new ProviderCacheSimulator({ tokenizer, profile: ANTHROPIC_PROFILE }),
};

/** One row per turn: which phase was active, what kind of turn it was, and both layouts' outcomes. */
const rows = [];
const priceRow = priceFor('claude-sonnet-5');
const RATE = priceRow.price; // { input, output, cacheRead, cacheWrite } USD / 1M tokens

let turn = 0;
const completed = [];
outer: for (let pIdx = 0; pIdx < phases.length; pIdx += 1) {
  const phase = phases[pIdx];
  const keepBranches = new Set(completed);
  const trueEnd = phase.span_end_seq;
  for (let seq = phase.span_start_seq; seq <= trueEnd; seq += 1) {
    turn += 1;
    if (turn > MAX_TURNS) break outer;
    store.updateNode(phase.id, { span_end_seq: seq });
    const eventType = [...trace.read({ from: seq, to: seq })][0]?.type ?? 'unknown';
    const isPhaseTransition = seq === phase.span_start_seq && pIdx > 0;

    const options = { activeNodeId: phase.id, toolSchemasText: TOOL_SCHEMAS_TEXT, selection: { keepBranches } };
    const promptShipped = shipped.assembler.assemble(options);
    const outcomeShipped = shipped.sim.submit(promptShipped);
    const promptThreeBp = threeBp.assembler.assemble(options);
    const outcomeThreeBp = threeBp.sim.submit(promptThreeBp);

    rows.push({
      turn,
      phase: phase.id.slice(-6),
      phaseIdx: pIdx,
      seq,
      eventType,
      isPhaseTransition,
      shipped: outcomeShipped,
      threeBp: outcomeThreeBp,
    });
  }
  // Restore the real span so the NEXT phase's Zone B summary (read from the
  // real, frozen leaf-summary row) reflects the branch's true, complete
  // content once it closes — matches what really happened in this trace.
  store.updateNode(phase.id, { span_end_seq: trueEnd });
  completed.push(phase.id);
}

// ── (a)/(b): fraction of each turn's prompt served from cache ──────────────
function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function cacheFraction(outcome) {
  return outcome.total === 0 ? 0 : outcome.cacheRead / outcome.total;
}

const shippedReport = cacheReport(rows.map((r) => r.shipped));
const threeBpReport = cacheReport(rows.map((r) => r.threeBp));
const shippedFractions = rows.map((r) => cacheFraction(r.shipped));
const threeBpFractions = rows.map((r) => cacheFraction(r.threeBp));

const phasesReached = new Set(rows.map((r) => r.phaseIdx)).size;
console.log(`\nExperiment 4 — cache-sweep over ${rows.length} turns (s1, ${phases.length} phases total, ${phasesReached} reached)\n`);
console.log('(a)/(b) per-turn cache-read fraction of total prompt tokens:');
console.log('| layout | median | mean | session cacheRead | session cacheWrite | session fresh | session total | cacheReadRatio |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const [name, report, fractions] of [
  ['shipped (2 breakpoints)', shippedReport, shippedFractions],
  ['3rd breakpoint (Zone C)', threeBpReport, threeBpFractions],
]) {
  console.log(
    `| ${name} | ${median(fractions).toFixed(3)} | ${mean(fractions).toFixed(3)} | ${report.cacheRead} | ${report.cacheWrite} | ${report.fresh} | ${report.total} | ${report.cacheReadRatio.toFixed(4)} |`,
  );
}

// ── dollar cost at published claude-sonnet-5 rates ──────────────────────────
function usd(tokens, ratePerMillion) {
  return (tokens * ratePerMillion) / 1_000_000;
}
function sessionUsd(report) {
  return usd(report.cacheRead, RATE.cacheRead) + usd(report.cacheWrite, RATE.cacheWrite) + usd(report.fresh, RATE.input);
}
console.log(`\nSession dollar cost at ${priceRow.matched ?? 'claude-sonnet-5'} rates (input $${RATE.input}/M, cacheRead $${RATE.cacheRead}/M, cacheWrite $${RATE.cacheWrite}/M, all per 1M tokens):`);
console.log(`  shipped (2bp):  $${sessionUsd(shippedReport).toFixed(4)}`);
console.log(`  3rd breakpoint: $${sessionUsd(threeBpReport).toFixed(4)}`);

// ── (c): which event types invalidate which prefix ranges, ranked by cost ──
// Bucket every turn's Zone-C-and-later spend by whether it fell in a phase
// TRANSITION turn (Zone B grows, Zone C resets to the new branch) or an
// ordinary EVENT APPEND (Zone C grows within the same open phase), for both
// layouts — this is what makes the SAME event type cost differently per
// layout: an event append is `fresh` under shipped and `cacheWrite` under the
// 3rd breakpoint (see the packages/core test this experiment added).
function bucket(rows, key) {
  const groups = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}
function summarizeBucket(label, group, pick) {
  const write = group.reduce((s, r) => s + pick(r).cacheWrite, 0);
  const fresh = group.reduce((s, r) => s + pick(r).fresh, 0);
  const read = group.reduce((s, r) => s + pick(r).cacheRead, 0);
  const writeUsd = usd(write, RATE.cacheWrite);
  const freshUsd = usd(fresh, RATE.input);
  const readUsd = usd(read, RATE.cacheRead);
  return { label, n: group.length, write, fresh, read, costUsd: writeUsd + freshUsd + readUsd };
}

console.log('\n(c) invalidation ranking — tokens billed by event type and layout, at published rates:');
console.log('| layout | event type | n turns | cacheWrite tok | fresh tok | cacheRead tok | $ (write+fresh+read) |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const [layoutName, pick] of [
  ['shipped', (r) => r.shipped],
  ['3rd breakpoint', (r) => r.threeBp],
]) {
  const byType = bucket(rows, (r) => (r.isPhaseTransition ? 'phase transition' : `event append (${r.eventType})`));
  const summaries = [...byType.entries()]
    .map(([type, group]) => summarizeBucket(type, group, pick))
    .sort((a, b) => b.costUsd - a.costUsd);
  for (const s of summaries) {
    console.log(`| ${layoutName} | ${s.label} | ${s.n} | ${s.write} | ${s.fresh} | ${s.read} | $${s.costUsd.toFixed(4)} |`);
  }
}

// ── measured rewrite frequency of the moving Zone-C marker ─────────────────
// A turn "rewrites" the 3rd-breakpoint layout's Zone C stable run when that
// run shows up as cacheWrite rather than cacheRead — i.e. the marker landed
// on a new block position this turn (see the exp-04 test in cache.test.ts).
const zoneCRewriteTurns = rows.filter((r) => r.threeBp.cacheWrite > 0).length;
const measuredRewriteFreq = rows.length === 0 ? 0 : zoneCRewriteTurns / rows.length;

// ── crossover, computed from the published rates (not the 1-in-12.5 heuristic) ─
// Compare, per turn, for a Zone-C-sized stable run S:
//   shipped:    never marked -> billed at the plain INPUT rate every turn, cost = S * Pinput
//   3rd bp:     marked -> a turn where the marker moves is a cacheWRITE (Pwrite);
//               a turn where it doesn't move is a cacheREAD (Pread). At rewrite
//               frequency f: cost = f * S * Pwrite + (1 - f) * S * Pread
// Crossover f* solves Pinput = f*Pwrite + (1-f)*Pread:
const Pinput = RATE.input;
const Pwrite = RATE.cacheWrite;
const Pread = RATE.cacheRead;
const crossoverFreq = (Pinput - Pread) / (Pwrite - Pread);

console.log('\nCrossover — computed from claude-sonnet-5\'s published per-token rates, not assumed:');
console.log(`  Pinput=$${Pinput}/M, Pwrite=$${Pwrite}/M, Pread=$${Pread}/M  =>  Pwrite/Pread = ${(Pwrite / Pread).toFixed(2)}x`);
console.log(`  f* = (Pinput - Pread) / (Pwrite - Pread) = (${Pinput} - ${Pread}) / (${Pwrite} - ${Pread}) = ${crossoverFreq.toFixed(4)} (${(crossoverFreq * 100).toFixed(1)}% of turns)`);
console.log('  Below f*: marking (accept occasional cacheWrite) beats leaving it unmarked (plain input every turn).');
console.log('  Above f*: leaving it unmarked (shipped default) is cheaper than paying the write premium this often.');
console.log(`  MEASURED on this replay: the moving Zone-C marker rewrites on ${zoneCRewriteTurns}/${rows.length} turns = ${(measuredRewriteFreq * 100).toFixed(1)}% >> f* (${(crossoverFreq * 100).toFixed(1)}%)`);
// The crossover above answers a DIFFERENT question from the session table this
// script prints higher up, and conflating them is what made this line wrong.
//
// The frequency test asks: given a marker that rewrites on N of M turns, does
// marking beat not marking IF EVERY REWRITE PAYS FOR THE WHOLE MARKED REGION?
// Under the simulator's original exact-position matching that premise held, and
// the answer was no. It does not hold against a real provider, which matches any
// previously cached prefix, so a moving marker pays a DELTA and earns a read on
// everything before it. Iteration 3 corrected the simulator accordingly
// (`CacheMatchPolicy`, default `automatic-prefix`) and the same replay reversed:
// the third breakpoint went from +23% to -39.8% on this fixture, agreeing in
// sign and shape with the -18% measured live.
//
// So the crossover is reported as what it is — a rate identity, useful for
// reasoning about a marker whose region is rewritten wholesale — and the verdict
// line that read it as a verdict on the third breakpoint is retired.
console.log(
  `  Reading: f* is the break-even for a marker whose whole region is rewritten on each change. The Zone-C ` +
    `marker moves on ${zoneCRewriteTurns}/${rows.length} turns (${(measuredRewriteFreq * 100).toFixed(1)}%), which is ` +
    `above f* — but under automatic-prefix matching a move pays a DELTA, not the region, so this identity does not ` +
    `decide the third breakpoint. See the session table above for that, and eval/plans/tuning/exp3-a-simulator-fidelity.md.`,
);

store.close();
rmSync(dir, { recursive: true, force: true });
