#!/usr/bin/env node
/**
 * DS-STAR dimension 1 (branch count), iteration 2, experiment 1.
 *
 * `eval/plans/tuning/01-branch-count.md` found that the fold-ladder rung
 * (`rootKeep`) and the number of rendered branch-summary BODIES
 * (`branchesSurviving`) move in OPPOSITE directions, and that which
 * allocation of a fixed Zone B budget gets used today is decided by a
 * hand-picked ladder WALK DIRECTION (`tree` walks large-to-small, `tree-wide`
 * walks small-to-large — `transplant.mjs`'s `ARM_ROOT_LADDER`), not by
 * measuring which allocation is best. It named two offline, zero-cost next
 * steps:
 *
 *   (a) walk every rung at every window through the REAL assembler (the same
 *       `fitsRoot` predicate `deriveRootKeep` already uses — gate 8's
 *       "does Zone B fit, with >=1 branch surviving" — never a proxy), so
 *       "two hand-picked directions" becomes the whole curve, and the rung
 *       that maximizes branchesSurviving subject to fitting can be read off
 *       directly instead of guessed at via ladder direction.
 *   (b) join each recorded run row's `self_retrieval.rank` (question
 *       metadata, already on disk) against that row's `score` (already on
 *       disk), among rows that searched, to test whether a rank/confidence-
 *       triggered widen policy (a refinement of "demand-driven") has any
 *       signal to key on.
 *
 * Zero model calls, zero network: (a) re-assembles the FROZEN store's
 * existing summaries through the real `ZoneAssembler` (no LLM call — the
 * store's summaries were written once, long before this script runs); (b)
 * reads JSON already on disk. The frozen fixture at
 * `eval/fixtures/transplant/s1` is never written to — (a) copies `store/` to
 * a temp dir first, because `composeRootSummary` appends a new root-summary
 * VERSION (D3) whenever a rung not already composed on that exact store is
 * requested, and walking all 7 rungs x 5 windows would do that repeatedly.
 *
 * Usage: node eval/scripts/ladder-curve.mjs
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FsBlobStore,
  HeuristicTokenizer,
  JsonlTraceLog,
  ZoneAssembler,
  composeRootSummary,
  openStore,
  storePaths,
  systemContract,
} from '@context-tree/core';
import {
  ARM_ROOT_LADDER,
  NESTING_WINDOWS,
  ROOT_KEEP_LADDER,
  contractVersionFor,
  deriveBudgets,
} from './transplant.mjs';
import { CONTEXT_TOOL_SCHEMAS } from '../dist/tools.js';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURE_DIR = join(REPO, 'eval/fixtures/transplant/s1');
const ARTIFACTS_DIR = join(FIXTURE_DIR, 'e1b289c32f40');

// Verbatim from `transplant.mjs` (`QA_ADDENDUM`, not exported — it is literal
// system-prompt text, not logic, so copying it here does not duplicate a
// mechanism). Zone A's exact byte count does not change what this experiment
// measures (Zone B allocation), but the real system text is used anyway so
// the assembled prompt this script builds is the one the harness actually
// sends, not a stand-in.
const QA_ADDENDUM = [
  '',
  '# Answering this question',
  "You are being asked a single question about this task's history. The context above may omit",
  'older branches entirely (see any "folded" line in the task summary) — use context_search,',
  'context_fetch, or context_peek if you need to recall detail not shown above.',
  'When you are ready, reply with your final answer in plain text and make NO further tool call:',
  'a reply with no tool call ends the conversation.',
].join('\n');

const heuristic = new HeuristicTokenizer();

function seqRangeOf(store, nodeIds) {
  const nodes = nodeIds.map((id) => store.getNode(id)).filter((n) => n !== null);
  if (nodes.length === 0) return null;
  return {
    from: Math.min(...nodes.map((n) => n.span_start_seq)),
    to: Math.max(...nodes.map((n) => n.span_end_seq)),
  };
}

/** Opens a store rooted at `storeRoot` — used only against a COPY, never the frozen original. */
function openScenarioCopy(storeRoot) {
  const paths = storePaths(storeRoot);
  const trace = new JsonlTraceLog(paths.trace);
  const blobs = new FsBlobStore(paths.blobs);
  const store = openStore(paths.db);
  const root = store.root();
  if (root === null) throw new Error(`${storeRoot}: store has no root node`);
  return {
    trace,
    blobs,
    store,
    root,
    close() {
      store.close();
      trace.close();
    },
  };
}

/**
 * Assembles the real Zone B/C prompt at an EXPLICIT `rootKeep`, exactly as
 * `transplant.mjs`'s `assembleTreeAt`/`fitsRoot` do (gate 8's real predicate,
 * never a modelled proxy) — reimplemented locally because `assembleTreeAt`
 * is not exported and is wired to the FROZEN fixture's path constant, which
 * this script must not touch.
 */
function assembleAt(scenario, budgets, rootKeep, systemText, toolSchemasText) {
  composeRootSummary(scenario.store, scenario.root.id, undefined, rootKeep);
  const assembler = new ZoneAssembler({
    store: scenario.store,
    blobs: scenario.blobs,
    trace: scenario.trace,
    tokenizer: heuristic,
    systemContract: systemText,
    budgets: { zoneB: budgets.zoneB, zoneC: budgets.zoneC },
  });
  const prompt = assembler.assemble({ toolSchemasText });
  return prompt;
}

/** One rung's row: fits or not, and the allocation it actually produced. */
function rungRow(scenario, budgets, rootKeep, systemText, toolSchemasText) {
  const prompt = assembleAt(scenario, budgets, rootKeep, systemText, toolSchemasText);
  const branchBlocks = prompt.blocks.filter((b) => b.zone === 'B' && !b.id.startsWith('B:root'));
  const nodeIds = [...new Set(branchBlocks.map((b) => b.nodeId).filter((id) => id !== undefined))];
  const rootBlock = prompt.blocks.find((b) => b.zone === 'B' && b.id.startsWith('B:root'));
  return {
    keep: rootKeep,
    fits: prompt.budgets.overBudget.length === 0 && nodeIds.length >= 1,
    rootBlockTokens: rootBlock === undefined ? 0 : rootBlock.tokens,
    branchesSurviving: nodeIds.length,
    seqRange: seqRangeOf(scenario.store, nodeIds),
    overBudget: [...prompt.budgets.overBudget],
    zoneBTotal: prompt.budgets.zoneB,
  };
}

/** First rung in `ladder` whose row `fits` — what `deriveRootKeep` returns, restated over precomputed rows. */
function firstFitting(rowsByKeep, ladder) {
  for (const keep of ladder) {
    const row = rowsByKeep.get(keep);
    if (row?.fits) return row;
  }
  return null;
}

function fmtSeq(range) {
  return range === null ? '—' : `${range.from}–${range.to}`;
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

// ── (a) the whole allocation curve ─────────────────────────────────────────
async function partA() {
  const manifest = JSON.parse(readFileSync(join(ARTIFACTS_DIR, 'manifest.json'), 'utf8'));
  const ratio = manifest.ratio;

  const tmp = mkdtempSync(join(tmpdir(), 'ct-ladder-curve-'));
  const tmpStore = join(tmp, 'store');
  cpSync(join(FIXTURE_DIR, 'store'), tmpStore, { recursive: true });

  const scenario = openScenarioCopy(tmpStore);
  const systemText = systemContract(contractVersionFor('tree')) + QA_ADDENDUM;
  const toolSchemasText = JSON.stringify(CONTEXT_TOOL_SCHEMAS);

  const treeLadder = ARM_ROOT_LADDER.tree; // largest-first: ROOT_KEEP_LADDER itself
  const treeWideLadder = ARM_ROOT_LADDER['tree-wide']; // smallest-first: reversed

  const curveRows = []; // flat, for the full-curve table
  const perWindow = [];

  try {
    for (const window of NESTING_WINDOWS) {
      const budgets = deriveBudgets(window, ratio);
      const rowsByKeep = new Map();
      for (const keep of ROOT_KEEP_LADDER) {
        const row = rungRow(scenario, budgets, keep, systemText, toolSchemasText);
        rowsByKeep.set(keep, row);
        curveRows.push([
          window,
          keep,
          row.fits ? 'yes' : 'no',
          row.rootBlockTokens,
          row.branchesSurviving,
          row.zoneBTotal,
          fmtSeq(row.seqRange),
        ]);
      }

      const treeRow = firstFitting(rowsByKeep, treeLadder);
      const treeWideRow = firstFitting(rowsByKeep, treeWideLadder);
      const fittingRows = [...rowsByKeep.values()].filter((r) => r.fits);
      const maxBodiesRow =
        fittingRows.length === 0
          ? null
          : fittingRows.reduce((best, r) => (r.branchesSurviving > best.branchesSurviving ? r : best));

      perWindow.push({
        window,
        zoneB: budgets.zoneB,
        treeRow,
        treeWideRow,
        maxBodiesRow,
      });
    }
  } finally {
    scenario.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n=== (a) Full ladder allocation curve — every window x every rung, real assembler ===\n');
  printTable(
    ['window', 'rung(keep)', 'fits', 'rootBlockTok', 'branchesSurviving', 'zoneBTotal', 'seqRange(visible)'],
    curveRows,
  );

  console.log('\n=== (a) Per-window: which rung maximizes branchesSurviving subject to fitting ===\n');
  const summaryRows = perWindow.map(({ window, zoneB, treeRow, treeWideRow, maxBodiesRow }) => {
    const maxKeep = maxBodiesRow === null ? '—' : maxBodiesRow.keep;
    const maxBodies = maxBodiesRow === null ? 0 : maxBodiesRow.branchesSurviving;
    const usesTree = maxBodiesRow !== null && treeRow !== null && maxBodiesRow.keep === treeRow.keep;
    const usesTreeWide = maxBodiesRow !== null && treeWideRow !== null && maxBodiesRow.keep === treeWideRow.keep;
    return [
      window,
      zoneB,
      treeRow === null ? 'dead' : `keep=${treeRow.keep} (${treeRow.branchesSurviving} bodies)`,
      treeWideRow === null ? 'dead' : `keep=${treeWideRow.keep} (${treeWideRow.branchesSurviving} bodies)`,
      maxBodiesRow === null ? 'dead (no rung fits)' : `keep=${maxKeep} (${maxBodies} bodies)`,
      maxBodiesRow === null ? '—' : usesTree ? 'tree' : usesTreeWide ? 'tree-wide' : 'NEITHER shipped arm',
    ];
  });
  printTable(
    ['window', 'zoneBBudget', "tree's rung", "tree-wide's rung", 'max-bodies rung', 'matches which arm'],
    summaryRows,
  );

  return { curveRows, perWindow };
}

// ── (b) rank-vs-score correlation among rows that searched ────────────────
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

function partB() {
  const questions = JSON.parse(readFileSync(join(ARTIFACTS_DIR, 'questions.json'), 'utf8')).questions;
  const qmeta = new Map(
    questions.map((q) => [q.id, { rank: q.self_retrieval?.rank ?? null, stratum: q.stratum }]),
  );

  // Scope: the 5 full-rep `run-*.json` result files (the measured dataset the
  // §1.2/§4.2 tables in `01-branch-count.md` already cite). The `smoke-*.json`
  // files are n=1-3 sanity checks across throwaway models and are excluded —
  // mixing them in would pool a diagnostic run with the measured one.
  const resultsDir = join(ARTIFACTS_DIR, 'results');
  const files = readdirSync(resultsDir).filter((f) => f.startsWith('run-') && f.endsWith('.json'));

  const rows = [];
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(resultsDir, file), 'utf8'));
    for (const row of data.rows) {
      if (row.score === null || row.score === undefined) continue; // not completed — no score to join
      const meta = qmeta.get(row.question);
      if (meta === undefined || meta.rank === null) continue;
      rows.push({
        question: row.question,
        stratum: meta.stratum,
        rank: meta.rank,
        score: row.score,
        searched: Boolean(row.searched),
        arm: row.arm,
        window: row.window,
        model: row.model,
      });
    }
  }

  const searched = rows.filter((r) => r.searched);
  const notSearched = rows.filter((r) => !r.searched);
  const r = searched.length >= 2 ? pearson(searched.map((x) => x.rank), searched.map((x) => x.score)) : null;
  const rNot =
    notSearched.length >= 2 ? pearson(notSearched.map((x) => x.rank), notSearched.map((x) => x.score)) : null;

  console.log('\n=== (b) rank-vs-score correlation, rows that searched (source: results/run-*.json) ===\n');
  const cells = new Map();
  for (const row of searched) {
    const key = `${row.arm} W=${row.window} ${row.model}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  console.log(`n completed rows joined (all): ${rows.length}`);
  console.log(`n searched: ${searched.length}  |  n not-searched: ${notSearched.length}`);
  console.log('composition of the "searched" set, by (arm, window, model):');
  for (const [key, n] of cells) console.log(`  ${key}: ${n} rows`);
  console.log(
    `\nPearson r (self_retrieval.rank vs score), among rows that searched: ${r === null ? 'undefined (n<2)' : r.toFixed(3)} (n=${searched.length})`,
  );
  console.log(
    `Pearson r (rank vs score), among rows that did NOT search, for contrast: ${rNot === null ? 'undefined (n<2)' : rNot.toFixed(3)} (n=${notSearched.length})`,
  );

  console.log('\nPer-question breakdown, searched rows only (sorted by rank, low = best lexical match):\n');
  const byQuestion = new Map();
  for (const row of searched) {
    if (!byQuestion.has(row.question)) byQuestion.set(row.question, []);
    byQuestion.get(row.question).push(row.score);
  }
  const qRows = [...qmeta.entries()]
    .filter(([, m]) => m.rank !== null)
    .sort((a, b) => a[1].rank - b[1].rank)
    .map(([qid, m]) => {
      const scores = byQuestion.get(qid) ?? [];
      const mean = scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length;
      return [qid, m.stratum, m.rank, scores.length, mean === null ? '—' : mean.toFixed(3)];
    });
  printTable(['question', 'stratum', 'rank', 'n_searched', 'mean_score'], qRows);

  return { r, rNot, nSearched: searched.length, nNotSearched: notSearched.length };
}

const a = await partA();
const b = partB();

console.log('\n=== summary ===');
console.log(
  'Part (a): the ladder-direction choice only matters at windows where more than one rung both fits and',
  "differs in branchesSurviving — see the 'matches which arm' column above.",
);
console.log(
  `Part (b): rank-vs-score Pearson r among searched rows = ${b.r === null ? 'undefined' : b.r.toFixed(3)} (n=${b.nSearched}).`,
);
