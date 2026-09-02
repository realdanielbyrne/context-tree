#!/usr/bin/env node
/**
 * Loop-9 cross-model context transplant (Design C, `eval/fixtures/transplant/JUDGE-VERDICT.md`).
 *
 * One large-model trace is frozen once, reorganized into a tree once, and then
 * *replayed* to two small-window models that never saw it. The question the
 * design asks is the null hypothesis: does the ORGANIZATION carry recall, or
 * would any compaction of the same bytes do as well? So every arm gets the same
 * frozen substrate, the same question set, the same epoch — and the compaction
 * baseline is pinned to the tree's leaf model, output cap, AND total prompt
 * budget, because a compaction baseline that is cheaper is not a baseline.
 *
 * Forked from `recall-probe.mjs` (Graft 1) minus its synthetic store builders:
 * the store here is read from disk, never built, never re-summarized. What
 * carries over verbatim is the plumbing that matters — `HANDLERS` dispatch
 * against a TaskStore-shaped handle, `TreeRetriever` with no embedder (lexical
 * beam fallback, always), `MeteredProvider` + `InMemoryCostMeter`, and the
 * `buildPrompt`/turn loop shape.
 *
 *   --phase gates    the zero-live-token verification checklist (items 1-14)
 *   --phase prep     literal extraction -> strata -> questions.json
 *   --phase run      one (model, W, arm) cell
 *   --phase verdict  MEAN score / tokens / turns per (arm, stratum, model)
 *
 * Hermeticity, restated because it is the whole experiment: `--phase gates` and
 * the offline half of `--phase prep` read only L0, L2, L1 and a local BPE table.
 * The paraphrase batch and every arm are live and gated behind `--allow-live`
 * (prep) or an explicit `--phase run` (arms). Nothing here re-ingests or
 * re-summarizes: `manifest.json` is the freeze line and a store sha mismatch
 * against it is a hard stop, not a warning.
 *
 * Budgets are NOT hand-tuned (D19). They derive from the target window W as
 * fixed fractions, each divided by the measured heuristic->BPE ratio, so the
 * one number a reviewer has to trust is a token count they can recompute
 * offline. `EVAL_LAZY_TOKENS` is exported from that derivation rather than
 * being a constant anyone edits (Graft 6: `eval/src/loop.ts` is not touched).
 *
 * Usage:
 *   node eval/scripts/transplant.mjs --phase gates --scenario s1
 *   node eval/scripts/transplant.mjs --phase prep  --scenario s1 [--allow-live]
 *   node eval/scripts/transplant.mjs --phase run   --scenario s1 --window 16384 \
 *        --arm tree --model qwen/qwen-2.5-72b-instruct --reps 5
 *   TRANSPLANT_SMOKE=1 node eval/scripts/transplant.mjs --phase run --scenario s1
 *   node eval/scripts/transplant.mjs --phase verdict --scenario s1
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CostCapExceededError,
  ExactTokenizer,
  FsBlobStore,
  HeuristicTokenizer,
  InMemoryCostMeter,
  JsonlTraceLog,
  MeteredProvider,
  ModelCallError,
  OpenRouterProvider,
  TreeRetriever,
  ZoneAssembler,
  addUsage,
  composeRootSummary,
  ingest,
  loadConfig,
  loadDotEnv,
  openStore,
  openTaskStore,
  renderEvent,
  storePaths,
  systemContract,
  toMessages,
} from '@context-tree/core';
// `renderSummaryBlock` is not on core's public surface (it is an assembler
// internal); the root-keep derivation has to size the block the assembler
// will actually emit, so it is imported from the built module directly.
import { renderSummaryBlock } from '../../packages/core/dist/assemble/format.js';
import { ANNOTATE, CONTEXT_FETCH, CONTEXT_PEEK, CONTEXT_SEARCH, HANDLERS, toCallToolResult } from '@context-tree/mcp';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import { CONTEXT_TOOL_SCHEMAS } from '../dist/tools.js';
import { exactMatchJudge } from '../dist/scoring.js';

// ── paths ────────────────────────────────────────────────────────────────
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURES = join(REPO, 'eval/fixtures/transplant');

// ── the frozen constants of the experiment ───────────────────────────────
/** Verbatim from the verdict's Step 3. `W` is reported as given, never rounded. */
export const WINDOWS = Object.freeze([16_384, 32_768]);
/** Graft 3's portability sweep. 200k is the published 200,000-token class. */
export const NESTING_WINDOWS = Object.freeze([8_192, 16_384, 32_768, 65_536, 200_000]);
/** D19 fractions of W. They sum to 1.00; each is divided by the measured ratio. */
export const FRACTIONS = Object.freeze({ reply: 0.05, zoneA: 0.1, zoneB: 0.2, zoneC: 0.2, lazy: 0.35, slack: 0.1 });
const SLACK_REFLOOR_ABOVE = 1.15;
const SLACK_REFLOORED = 0.15;
const SLACK_MITIGATION = 0.2;
const RATIO_KILL = 1.6;
/** truncate-tail keeps `0.85 W / ratio - reply`; the 0.85 is the verdict's. */
const K_FRACTION = 0.85;

const MODELS = Object.freeze(['qwen/qwen-2.5-72b-instruct', 'openai/gpt-3.5-turbo']);
const PARAPHRASE_MODEL = 'z-ai/glm-5.3-flash';
const COMPACT_MODEL = 'claude-haiku-4-5-20251001';
const COMPACT_MODEL_OR = 'anthropic/claude-haiku-4.5';
const MAX_SUMMARY_TOKENS = 1_024;
const ROOT_KEEP = 40;
const REPS = 5;
const SPANNING_REPS = 3;
const MAX_TURNS = 6;
const MAX_REPLY_TOKENS = 800;
const CAP_USD_PER_MODEL = 3.0;
const CAP_USD_TOTAL = 6.0;
const SMOKE_N = 3;

const PRIMARY_STRATA = Object.freeze(['head', 'tail', 'deep']);
const EXPLORATORY_STRATA = Object.freeze(['spanning']);
const Q_PER_STRATUM = 3;
/** A literal with less surrounding prose than this cannot be paraphrased into a question. */
const MIN_CONTEXT_CHARS = 200;
const CONTEXT_WINDOW_CHARS = 600;

export const ARM_IDS = Object.freeze([
  'naive-full',
  'truncate-tail',
  'compact-rolling',
  'tree',
  'tree-static',
  'memgpt',
]);
/** Arms whose MEAN enters the primary verdict. `naive-full` is a precondition. */
const SCORED_ARMS = Object.freeze(['truncate-tail', 'compact-rolling', 'tree']);

/** Checklist item ids from the verdict's VERIFICATION CHECKLIST, in order. */
export const GATE_IDS = Object.freeze([
  'g1-trace-sha',
  'g2-hermetic-import',
  'g3-ismeta-skipped',
  'g4-unmapped-tools',
  'g5-rebuild-determinism',
  'g6-native-exceeds-window',
  'g7-bpe-ratio',
  'g8-over-budget',
  'g9-zone-b-nesting',
  'g10-prefix-stability',
  'g11-literal-uniqueness',
  'g12-leakage-gate',
  'g13-manifest-hashed',
  'g14-cost-cap',
]);

const heuristic = new HeuristicTokenizer();
/** §17's exact tokenizer, behind core's wrapper: a local cl100k table, no API. */
export const exact = new ExactTokenizer('cl100k_base/gpt-tokenizer', (text) => countTokens(text));

// ── small pure helpers ───────────────────────────────────────────────────
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const escapeRe = (s) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Non-overlapping occurrence count — the strict reading of "exactly once". */
export function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

// ── window derivation (D19) ──────────────────────────────────────────────
/**
 * Budgets as fractions of W divided by the measured heuristic->BPE ratio.
 *
 * The division is the whole point. The assembler counts with
 * `HeuristicTokenizer`, the provider bills cl100k, and those two disagree by a
 * measurable factor on *this* corpus. Handing the assembler `0.20 * W` would
 * mean the real prompt is `0.20 * W * ratio` — off by however far the heuristic
 * drifts. Handing it `0.20 * W / ratio` makes the real prompt `0.20 * W`,
 * which is the number the window is expressed in.
 *
 * A re-floored slack is paid for out of Zone C, never Zone B: shrinking B
 * drops branch summaries, and whether branch summaries carry recall is the
 * claim under test — the baseline must not be handed the answer.
 */
export function deriveBudgets(windowTokens, ratio, options = {}) {
  if (!(windowTokens > 0)) throw new Error(`window must be > 0, got ${windowTokens}`);
  if (!(ratio > 0)) throw new Error(`ratio must be > 0, got ${ratio}`);
  const slackFraction =
    options.slackFraction ?? (ratio > SLACK_REFLOOR_ABOVE ? SLACK_REFLOORED : FRACTIONS.slack);
  const zoneCFraction = FRACTIONS.zoneC - (slackFraction - FRACTIONS.slack);
  if (zoneCFraction <= 0) throw new Error(`slack ${slackFraction} leaves no Zone C`);
  const per = (fraction) => Math.floor((fraction * windowTokens) / ratio);
  const reply = per(FRACTIONS.reply);
  const budgets = {
    window: windowTokens,
    ratio,
    slackFraction,
    zoneCFraction,
    reply,
    zoneA: per(FRACTIONS.zoneA),
    zoneB: per(FRACTIONS.zoneB),
    zoneC: per(zoneCFraction),
    lazy: per(FRACTIONS.lazy),
    slack: per(slackFraction),
    /** truncate-tail's keep window, in heuristic tokens. */
    K: Math.floor((K_FRACTION * windowTokens) / ratio) - reply,
    /**
     * `maxTokens` is a provider-native count, so it is NOT divided by the
     * ratio — there is nothing to convert. It is the smaller of the design's
     * 800-token reply and the window's 5% reply share.
     */
    maxReplyTokens: Math.min(MAX_REPLY_TOKENS, Math.floor(FRACTIONS.reply * windowTokens)),
  };
  // D19 extended: `rootKeep` is derived from the window too, not fixed at 40.
  // The predicate is injected and receives the budgets it must fit inside, so
  // the ladder walk stays a pure function of "does this rung pass" while the
  // decision of what passing MEANS lives with the thing that can assemble.
  if (options.fitsRoot !== undefined) {
    Object.assign(budgets, deriveRootKeep((keep) => options.fitsRoot(keep, budgets)));
  }
  return budgets;
}

/** D17's keep ladder, largest first — the derivation walks it downward. */
export const ROOT_KEEP_LADDER = Object.freeze([40, 16, 12, 8, 6, 4, 2]);

/**
 * `rootKeep` derived per window (D19 extended to D17's cap): the LARGEST rung
 * for which `fits(keep)` holds.
 *
 * A fixed `rootKeep = 40` is the same category of mistake D19 was written to
 * kill: a constant tuned against one window. Measured on the loop-9 store, the
 * rendered root block at keep=40 is 6,917 heuristic tokens — larger than the
 * whole 16k Zone B budget (3,850). The assembler's rule-4 valve cannot save
 * that: the root is deliberately exempt from dropping (`assembler.ts:245-252`),
 * so it drops all 21 branch summaries and *still* reports `overBudget`.
 *
 * What "fits" means is deliberately NOT a share constant. An earlier draft
 * capped the root at half of Zone B, which is a number invented to stand in
 * for the property actually wanted — and tuning it afterwards to rescue a cell
 * would be reverse-engineering a constant to rescue a result. The property
 * wanted is exactly gate 8's invariant, so the caller supplies a predicate
 * that ASSEMBLES the real prompt at that keep and asks it directly:
 * `overBudget == []` and at least one branch summary survived. Two rules
 * collapse into one — wherever this returns a keep, gate 8 provably passes.
 *
 * If no rung passes, the cell is genuinely dead and says so: the same shape as
 * the ratio kill gate, never a forced fit.
 */
export function deriveRootKeep(fits, ladder = ROOT_KEEP_LADDER) {
  const rootLadder = [];
  for (const keep of ladder) {
    const outcome = fits(keep);
    const row = { keep, ...(typeof outcome === 'object' && outcome !== null ? outcome : { ok: outcome === true }) };
    rootLadder.push(row);
    if (row.ok === true) return { rootKeep: keep, rootLadder, rootKeepOk: true, ...rootDetail(row) };
  }
  return { rootKeep: null, rootLadder, rootKeepOk: false, ...rootDetail(rootLadder.at(-1)) };
}

/** The reportable numbers off one ladder rung, whether it passed or not. */
function rootDetail(row) {
  return {
    rootBlockTokens: row?.rootBlockTokens ?? null,
    branchesSurviving: row?.branchesSurviving ?? null,
    branchSeqRange: row?.branchSeqRange ?? null,
    overBudget: row?.overBudget ?? null,
  };
}

/** `ratio > 1.6` is a stated kill condition; between 1.15 and 1.6 slack re-floors. */
export function ratioVerdict(ratio) {
  if (ratio > RATIO_KILL) {
    return { ok: false, action: 'mitigate-or-drop-16k', slackFraction: SLACK_MITIGATION };
  }
  return {
    ok: true,
    action: ratio > SLACK_REFLOOR_ABOVE ? 'slack-refloored-to-0.15' : 'slack-stays-0.10',
    slackFraction: ratio > SLACK_REFLOOR_ABOVE ? SLACK_REFLOORED : FRACTIONS.slack,
  };
}

// ── L0 / L2 access over a frozen store ───────────────────────────────────
/** Blob refs in sha order — a deterministic enumeration of L2, independent of L0. */
export function blobRefsOf(blobsRoot) {
  const refs = [];
  for (const dir of readdirSync(blobsRoot).sort()) {
    const dirPath = join(blobsRoot, dir);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const file of readdirSync(dirPath).sort()) refs.push(dir + file);
  }
  return refs.sort();
}

/**
 * The ratio sample, defined once so it is reproducible: every L2 blob, in sha
 * order, newline-joined. Not "a representative sample" chosen by taste — the
 * whole payload, which is the only sample nobody has to argue about.
 */
export function l0Sample(blobs, blobsRoot) {
  return blobRefsOf(blobsRoot)
    .map((ref) => blobs.getText(ref))
    .join('\n');
}

/**
 * The rendered size and sha of the root block at every rung of the keep
 * ladder, cached on disk and keyed by the leaf-summary sha it is a function of.
 *
 * The cache is not an optimization, it is a correctness property of a frozen
 * fixture. `composeRootSummary` skips the write only when the composed text
 * equals the CURRENT one (D3: versions are appended, never overwritten), so a
 * naive ladder walk appends one root version per rung per call — measured at
 * +33 versions per gate run. Deriving the ladder once and re-reading it makes
 * repeat runs write only when a window genuinely changes the keep.
 */
function rootLadderFor(scenario) {
  const root = scenario.store.root();
  const leafSha = sha256(leafSummaryDump(scenario.store));
  const path = join(scenario.artifacts, 'root-ladder.json');
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    if (cached.leaf_summaries_sha256 === leafSha) return cached.rungs;
  }
  const rungs = {};
  for (const keep of ROOT_KEEP_LADDER) {
    composeRootSummary(scenario.store, root.id, undefined, keep);
    const summary = scenario.store.currentSummary(root.id);
    rungs[keep] = {
      tokens: summary === null ? 0 : heuristic.count(renderSummaryBlock(root, summary, true)),
      sha256: summary === null ? null : sha256(summary.text),
    };
  }
  writeFileSync(path, `${JSON.stringify({ leaf_summaries_sha256: leafSha, rungs }, null, 2)}\n`);
  return rungs;
}

/**
 * Composes the root at `rootKeep` and returns its summary + sha — a no-op when
 * the store already holds exactly those bytes, which is what keeps a re-run
 * from appending a version that says nothing new.
 */
function composeRootAt(scenario, rootKeep, expectedSha) {
  const root = scenario.store.root();
  const current = scenario.store.currentSummary(root.id);
  if (current !== null && expectedSha !== undefined && sha256(current.text) === expectedSha) {
    return { summary: current, sha256: expectedSha };
  }
  composeRootSummary(scenario.store, root.id, undefined, rootKeep ?? ROOT_KEEP_LADDER.at(-1));
  const summary = scenario.store.currentSummary(root.id);
  return { summary, sha256: summary === null ? null : sha256(summary.text) };
}

/**
 * The budgets for one window, with `rootKeep` derived and the store LEFT
 * composed at that keep — every caller downstream (assembly, gates, arms) then
 * reads a root that matches the budget it was sized against.
 */
function budgetsFor(scenario, windowTokens, ratio, slackFraction) {
  const rungs = rootLadderFor(scenario);
  // The predicate IS gate 8, run against the real assembly. Nothing is
  // modelled: the prompt is built at this keep and asked whether it fits and
  // whether anything but the root survived in Zone B.
  const fitsRoot = (keep, budgets) => {
    const { prompt } = assembleTreeAt(scenario, budgets, keep, { withTools: true, expectedSha: rungs[keep]?.sha256 });
    const branches = prompt.blocks.filter((b) => b.zone === 'B' && !b.id.startsWith('B:root'));
    const nodeIds = [...new Set(branches.map((b) => b.nodeId).filter((id) => id !== undefined))];
    return {
      ok: prompt.budgets.overBudget.length === 0 && nodeIds.length >= 1,
      rootBlockTokens: rungs[keep]?.tokens ?? null,
      branchesSurviving: nodeIds.length,
      branchSeqRange: seqRangeOf(scenario.store, nodeIds),
      overBudget: [...prompt.budgets.overBudget],
      zoneB: prompt.budgets.zoneB,
    };
  };
  const budgets = deriveBudgets(windowTokens, ratio, { slackFraction, fitsRoot });
  const chosen = rungs[budgets.rootKeep ?? ROOT_KEEP_LADDER.at(-1)];
  const { sha256: rootSummarySha } = composeRootAt(scenario, budgets.rootKeep, chosen?.sha256);
  return { ...budgets, rootSummarySha };
}

/** L0 span covered by a set of branch nodes — where visibility actually ends. */
function seqRangeOf(store, nodeIds) {
  const nodes = nodeIds.map((id) => store.getNode(id)).filter((n) => n !== null);
  if (nodes.length === 0) return null;
  return {
    from: Math.min(...nodes.map((n) => n.span_start_seq)),
    to: Math.max(...nodes.map((n) => n.span_end_seq)),
  };
}

/** The one ratio measurement, so every phase reads the same number. */
function measureRatio(scenario) {
  const sample = l0Sample(scenario.blobs, scenario.paths.blobs);
  return exact.count(sample) / heuristic.count(sample);
}

/** What `naive-full` would send: every L0 event rendered, in seq order. */
export function renderNativeTranscript(events, blobs) {
  return events.map((event) => renderEvent(event, blobs)).join('\n\n');
}

/** Node dump the store sha is taken over — coordinates only, never content. */
export function nodeDump(store) {
  return JSON.stringify(
    store.nodesInCreationOrder().map((n) => ({
      id: n.id,
      parent_id: n.parent_id,
      kind: n.kind,
      title: n.title,
      phase_type: n.phase_type ?? null,
      span_start_seq: n.span_start_seq,
      span_end_seq: n.span_end_seq,
      status: n.status ?? null,
    })),
  );
}

function openScenario(scenarioId) {
  const dir = join(FIXTURES, scenarioId);
  const src = join(dir, 'trace.src.jsonl');
  const storeRoot = join(dir, 'store');
  if (!existsSync(storeRoot)) throw new Error(`scenario ${scenarioId}: no store at ${storeRoot}`);
  const paths = storePaths(storeRoot);
  const config = { ...loadConfig(REPO), root: storeRoot };
  const trace = new JsonlTraceLog(paths.trace);
  const blobs = new FsBlobStore(paths.blobs);
  const store = openStore(paths.db);
  const traceSha = existsSync(src) ? sha256File(src) : null;
  const artifacts = join(dir, traceSha === null ? 'no-src' : traceSha.slice(0, 12));
  mkdirSync(artifacts, { recursive: true });
  return {
    id: scenarioId,
    dir,
    src,
    storeRoot,
    paths,
    config,
    trace,
    blobs,
    store,
    traceSha,
    traceBytes: existsSync(src) ? statSync(src).size : null,
    artifacts,
    close() {
      store.close();
      trace.close();
    },
  };
}

/** Every stored summary body, keyed by node — the leakage gate's corpus. */
function summaryBodies(store) {
  const out = new Map();
  for (const node of store.nodesInCreationOrder()) {
    const summary = store.currentSummary(node.id);
    if (summary !== null) out.set(node.id, summary.text);
  }
  return out;
}

/**
 * The LEAF summary rows the freeze covers. Deliberately excludes the task
 * root: once `rootKeep` is derived per window (D19 extended), the root gains
 * one deterministic version per distinct keep, so a whole-store summary hash
 * would flag every window switch as a freeze violation. The leaves are the
 * invariant — their shas never change after Step 1 — and the root is pinned
 * per window instead, by `root_by_window` in the manifest.
 */
function leafSummaryDump(store) {
  const rootId = store.root()?.id ?? null;
  const rows = [];
  for (const node of store.nodesInCreationOrder()) {
    if (node.id === rootId) continue;
    const summary = store.currentSummary(node.id);
    if (summary !== null) rows.push({ node_id: node.id, version: summary.version, model: summary.model, text: summary.text });
  }
  return JSON.stringify(rows);
}

// ── manifest (Graft 2) ───────────────────────────────────────────────────
export function buildManifest(scenario, extra = {}) {
  const configPath = join(REPO, 'context-tree.config.json');
  return {
    scenario: scenario.id,
    trace: { path: `eval/fixtures/transplant/${scenario.id}/trace.src.jsonl`, sha256: scenario.traceSha, bytes: scenario.traceBytes },
    store: {
      path: `eval/fixtures/transplant/${scenario.id}/store`,
      trace_jsonl_sha256: sha256File(scenario.paths.trace),
      node_dump_sha256: sha256(nodeDump(scenario.store)),
      // Step 1 freezes node_summaries too, so the LEAF rows are hashed. The
      // consequence is deliberate: the summarize pass changes this sha, which
      // forces `--phase prep` to be re-run before any arm — which is also the
      // only point at which the `deep` stratum can be cut. The root is not in
      // here; it is pinned per window by `root_by_window` below.
      leaf_summaries_sha256: sha256(leafSummaryDump(scenario.store)),
      summaries: summaryBodies(scenario.store).size,
      nodes: scenario.store.nodesInCreationOrder().length,
      l0_events: scenario.trace.lastSeq(),
      blobs: blobRefsOf(scenario.paths.blobs).length,
    },
    // The toolPhase map is part of the epoch: change it and the segmentation
    // changes, so it is hashed like the trace is.
    config: { path: 'context-tree.config.json', sha256: sha256File(configPath) },
    gates: [...GATE_IDS],
    models: { answerers: [...MODELS], paraphraser: PARAPHRASE_MODEL, compaction: COMPACT_MODEL },
    /** W verbatim — the numbers the design named, not a rounded restatement. */
    windows: [...WINDOWS],
    fractions: { ...FRACTIONS },
    caps: { per_model_usd: CAP_USD_PER_MODEL, total_usd: CAP_USD_TOTAL, max_summary_tokens: MAX_SUMMARY_TOKENS, root_keep: ROOT_KEEP },
    ...extra,
  };
}

/**
 * Per-window root pin: the derived `rootKeep` and the sha of the root summary
 * it composes to. This is what replaces a whole-store summary hash now that
 * the root is versioned per window (D19 extended) — the leaves stay invariant,
 * the root is pinned once per W.
 */
function rootByWindow(scenario, ratio, slackFraction, windows = WINDOWS) {
  const out = {};
  for (const w of windows) {
    const budgets = budgetsFor(scenario, w, ratio, slackFraction);
    out[String(w)] = {
      rootKeep: budgets.rootKeep,
      rootBlockTokens: budgets.rootBlockTokens,
      branchesSurviving: budgets.branchesSurviving,
      branchSeqRange: budgets.branchSeqRange,
      rootSummarySha: budgets.rootSummarySha,
      zoneB: budgets.zoneB,
    };
  }
  return out;
}

function manifestPath(scenario) {
  return join(scenario.artifacts, 'manifest.json');
}

function readManifest(scenario) {
  const path = manifestPath(scenario);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/**
 * The freeze line. Step 1 says no re-ingest and no re-summarize after the
 * manifest is written, for any arm at any W — so a store that no longer hashes
 * to the manifest is a stopped experiment, not a warning to scroll past.
 */
function assertFrozen(scenario, options = {}) {
  const manifest = readManifest(scenario);
  if (manifest === null) throw new Error(`no manifest at ${manifestPath(scenario)} — run --phase prep first`);
  const now = buildManifest(scenario);
  for (const key of ['trace_jsonl_sha256', 'node_dump_sha256', 'leaf_summaries_sha256']) {
    if (manifest.store[key] !== now.store[key]) {
      throw new Error(
        `FREEZE VIOLATION: store.${key} is ${now.store[key]} but the manifest says ${manifest.store[key]} — ` +
          'the store was re-ingested or re-summarized after the freeze; every arm run against it is off-epoch',
      );
    }
  }
  if (manifest.config.sha256 !== now.config.sha256) {
    throw new Error('FREEZE VIOLATION: context-tree.config.json changed after the freeze (toolPhase is part of the epoch)');
  }
  // The root is versioned per window, so it is pinned per window: composing at
  // the recorded keep must reproduce the recorded bytes. That keeps the freeze
  // meaningful for the one summary the derivation is allowed to re-mint.
  if (options.window !== undefined) {
    const recorded = manifest.root_by_window?.[String(options.window)];
    if (recorded === undefined) {
      throw new Error(`no root_by_window entry for W=${options.window} in the manifest — re-run --phase prep`);
    }
    const { sha256: actual } = composeRootAt(scenario, recorded.rootKeep, recorded.rootSummarySha);
    if (actual !== recorded.rootSummarySha) {
      throw new Error(
        `FREEZE VIOLATION: root at W=${options.window} (rootKeep=${recorded.rootKeep}) composes to ${actual} ` +
          `but the manifest says ${recorded.rootSummarySha} — the leaf summaries changed under it`,
      );
    }
  }
  return manifest;
}

// ── question extraction (Step 2, offline half) ───────────────────────────
/**
 * Candidate answer literals. Five shapes, each anchored so a partial match
 * cannot pass: paths, long hex digests, multi-digit numbers, camel/snake
 * identifiers, and short quoted phrases (the "quoted decisions" of the spec).
 */
const LITERAL_PATTERNS = Object.freeze([
  ['path', /(?:[\w.@~-]+)?(?:\/[\w.@+-]+){1,}\.[A-Za-z][\w]{0,4}/g],
  ['hex', /\b[0-9a-f]{8,64}\b/g],
  ['number', /\b\d{2,}(?:[.,]\d{3})*(?:\.\d+)?\b/g],
  ['ident', /\b(?:[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+|[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)\b/g],
  ['quoted', /"([^"\n]{8,80})"/g],
]);

/** Markup, shell redirection and quoting inside a literal disqualify it. */
const MARKUP_RE = /[<>{}|\\"=&$`]/;
/** A literal sitting inside rendered HTML is a report fragment, not a fact. */
const HTML_NEIGHBOURHOOD_RE = /<\/?[a-z][\w-]*[\s>/]|&[a-z]{2,6};/i;

/**
 * Shape filter. The spec asks for "numbers, paths, identifiers, quoted
 * decisions", and a regex sweep over a real trace also yields
 * `">15.4%</td><td class="` and `2>/dev/null || python3 -c "`. Those are not
 * answer keys: no paraphraser can turn one into a question in plain words, and
 * no model can be expected to reproduce it verbatim — grading them would
 * measure transcription, not recall. So the filter is part of the extractor,
 * not a taste judgement applied afterwards.
 */
export function looksLikeAnswerKey(record) {
  const { literal, kind, context } = record;
  if (MARKUP_RE.test(literal)) return false;
  if (HTML_NEIGHBOURHOOD_RE.test(context)) return false;
  switch (kind) {
    case 'quoted':
      return /^[A-Za-z][\w ,.\-/():']{7,}$/.test(literal) && literal.split(/\s+/).length >= 3;
    case 'path':
      return /^[\w.@~-]{2,}(?:\/[\w.@+-]+)+\.[A-Za-z]\w{0,4}$/.test(literal);
    case 'number':
      return /^\d{3,}(?:[.,]\d{3})*(?:\.\d+)?$/.test(literal);
    case 'ident':
      return literal.length >= 6;
    default:
      return true;
  }
}

/**
 * Every once-only literal in L0, with the coordinates that make it an answer
 * key: the seq it occurs at and the phase node whose span covers that seq.
 *
 * Uniqueness is checked against the whole rendered transcript, not per-event —
 * a literal that is unique inside its own turn but repeated three phases later
 * is not an answer key, it is a coin flip.
 */
export function extractLiterals(events, blobs, store) {
  const rendered = events.map((event) => renderEvent(event, blobs));
  const whole = rendered.join('\n\n');
  const phases = store.nodesInCreationOrder().filter((n) => n.kind === 'phase');
  const phaseOf = (seq) => phases.find((p) => p.span_start_seq <= seq && seq <= p.span_end_seq) ?? null;

  const seen = new Map();
  for (let i = 0; i < events.length; i += 1) {
    const text = rendered[i] ?? '';
    for (const [kind, pattern] of LITERAL_PATTERNS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(text);
      while (match !== null) {
        const literal = (match[1] ?? match[0]).trim();
        if (literal.length >= 4 && !seen.has(literal)) {
          const at = match.index;
          const context = text.slice(Math.max(0, at - CONTEXT_WINDOW_CHARS), at + literal.length + CONTEXT_WINDOW_CHARS);
          const phase = phaseOf(events[i].seq);
          seen.set(literal, {
            literal,
            kind,
            seq: events[i].seq,
            node_id: phase?.id ?? null,
            phase_type: phase?.phase_type ?? null,
            context,
            occurrences: 0,
          });
        }
        match = pattern.exec(text);
      }
    }
  }
  for (const record of seen.values()) record.occurrences = countOccurrences(whole, record.literal);
  const wellShaped = [...seen.values()].filter(looksLikeAnswerKey);
  return {
    whole,
    all: [...seen.values()],
    wellShaped,
    onceOnly: wellShaped.filter((r) => r.occurrences === 1 && r.context.length >= MIN_CONTEXT_CHARS),
  };
}

/**
 * The seq at which `truncate-tail`'s keep window opens: walk L0 newest-first,
 * charging heuristic tokens, and stop when K is spent. Everything at or after
 * that seq is visible to truncation (the `tail` stratum); everything before it
 * is not (the `head` stratum). Stratifying on the token boundary rather than an
 * event count is what makes "head" mean "provably outside the baseline's view".
 */
export function truncationBoundarySeq(events, blobs, K, tokenizer = heuristic) {
  let spent = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const cost = tokenizer.count(renderEvent(events[i], blobs));
    if (spent + cost > K) return events[i].seq + 1;
    spent += cost;
  }
  return events.length === 0 ? 1 : events[0].seq;
}

/**
 * Deterministic pick: sort by `sha256(literal)` and take the first `n` that sit
 * in distinct phase nodes. Sha order is arbitrary but fixed — it is not
 * position-biased the way "first n in seq order" is, and it is reproducible the
 * way a seeded RNG is not across engines.
 */
export function pickDeterministic(pool, n, { distinctNodes = true, exclude = new Set() } = {}) {
  const sorted = [...pool]
    .filter((candidate) => !exclude.has(candidate.literal))
    .sort((a, b) => (sha256(a.literal) < sha256(b.literal) ? -1 : 1));
  const picked = [];
  const usedNodes = new Set();
  for (const candidate of sorted) {
    if (picked.length === n) break;
    if (distinctNodes && candidate.node_id !== null && usedNodes.has(candidate.node_id)) continue;
    if (candidate.node_id !== null) usedNodes.add(candidate.node_id);
    picked.push(candidate);
  }
  // Spreading across branches is a preference, not a constraint: the `tail`
  // pool is by construction the newest ~15k tokens, which is one or two phases,
  // so insisting on three distinct branches there would silently return two
  // questions and quietly shrink the stratum the design pre-registered at 3.
  if (picked.length < n) {
    for (const candidate of sorted) {
      if (picked.length === n) break;
      if (!picked.includes(candidate)) picked.push(candidate);
    }
  }
  return picked;
}

/** Word n-grams over case-folded, punctuation-stripped text. */
export function ngramSet(text, n = 3) {
  const words = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0);
  const grams = new Set();
  for (let i = 0; i + n <= words.length; i += 1) grams.add(words.slice(i, i + n).join(' '));
  return grams;
}

/**
 * The leakage gate, with the carve-out that makes it usable: a question is
 * rejected for sharing a 3-gram with its source phase's stored summary *after
 * the answer literal is removed from the question*. Without the carve-out the
 * gate rejects every question that must contain its own answer token — which is
 * most of them, since a paraphrase of "we capped it at 50" mentions 50.
 */
export function leakageGate({ question, summaryText, answerLiterals = [], n = 3 }) {
  let stripped = question;
  for (const literal of answerLiterals) stripped = stripped.split(literal).join(' ');
  const summary = ngramSet(summaryText, n);
  const shared = [...ngramSet(stripped, n)].filter((gram) => summary.has(gram));
  return { ok: shared.length === 0, shared };
}

/**
 * Grading is `exactMatchJudge` (normalized substring) per answer literal,
 * conjoined, plus a boundary-tolerant regex per literal so a model that writes
 * "50 records" and one that writes "50." both pass. No model is called: the
 * paraphraser wrote the questions and must never also grade them.
 */
export function answerRegexesFor(literals) {
  return literals.map((literal) => `(?<![\\w])${escapeRe(literal)}(?![\\w])`);
}

export function gradeAnswer(finalText, question) {
  const literals = question.answer_literals;
  const perLiteral = literals.map((literal, i) => ({
    literal,
    exact_match: exactMatchJudge(finalText, literal).success === true,
    regex: new RegExp(question.answer_regexes[i], 'i').test(finalText),
  }));
  const matched = perLiteral.every((r) => r.regex || r.exact_match);
  return { score: matched ? 1 : 0, success: matched, perLiteral };
}

// ── statistics, pre-registered (Graft 4) ─────────────────────────────────
/** C's binomial form: n = 16 p̄(1−p̄) / Δ². */
export function binomialN(pBar, delta) {
  if (!(delta > 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil((16 * pBar * (1 - pBar)) / (delta * delta));
}

/** B's pooled-σ two-proportion form at α=.05 / power .80, as the cross-check. */
export function pooledSigmaN(pA, pB) {
  const delta = Math.abs(pA - pB);
  if (!(delta > 0)) return Number.POSITIVE_INFINITY;
  const pooled = (pA + pB) / 2;
  return Math.ceil((2 * (1.959_964 + 0.841_621) ** 2 * pooled * (1 - pooled)) / (delta * delta));
}

/** Escalate on the LARGER of the two forms, capped at 20, one escalation only. */
export function escalationN(pTree, pCompact, cap = 20) {
  const delta = Math.abs(pTree - pCompact);
  const pBar = (pTree + pCompact) / 2;
  const binomial = binomialN(pBar, delta);
  const pooled = pooledSigmaN(pTree, pCompact);
  const required = Math.max(binomial, pooled);
  return { binomial, pooled, required, capped: Math.min(cap, required), delta, pBar };
}

/** Deterministic bootstrap (LCG) — the CI must be identical on a re-run. */
export function bootstrapCI(treeScores, compactScores, { iterations = 2_000, seed = 1, alpha = 0.05 } = {}) {
  if (treeScores.length === 0 || compactScores.length === 0) return null;
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  const draws = [];
  for (let i = 0; i < iterations; i += 1) {
    let a = 0;
    let b = 0;
    for (let j = 0; j < treeScores.length; j += 1) a += treeScores[Math.floor(next() * treeScores.length)];
    for (let j = 0; j < compactScores.length; j += 1) b += compactScores[Math.floor(next() * compactScores.length)];
    draws.push(a / treeScores.length - b / compactScores.length);
  }
  draws.sort((x, y) => x - y);
  const lo = draws[Math.floor((alpha / 2) * iterations)];
  const hi = draws[Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))];
  return { point: mean(treeScores) - mean(compactScores), lo, hi, crossesZero: lo <= 0 && hi >= 0 };
}

// ── prompt assembly (forked from recall-probe's buildPrompt) ─────────────
const QA_ADDENDUM = [
  '',
  '# Answering this question',
  "You are being asked a single question about this task's history. The context above may omit",
  'older branches entirely (see any "folded" line in the task summary) — use context_search,',
  'context_fetch, or context_peek if you need to recall detail not shown above.',
  'When you are ready, reply with your final answer in plain text and make NO further tool call:',
  'a reply with no tool call ends the conversation.',
].join('\n');

const FLAT_SYSTEM = [
  'You are resuming a software task from a record of an earlier session. The record below is',
  'all you have; there are no tools and no filesystem.',
  '',
  '# Answering this question',
  "You are being asked a single question about that session's history. Answer from the record.",
  'Reply with your final answer in plain text. If the record does not contain the answer, say so.',
].join('\n');

const TREE_SYSTEM = systemContract() + QA_ADDENDUM;
/** Zone A's schemas as one byte-stable string — the four §9 tools (§9, D5). */
const TOOL_SCHEMAS_TEXT = JSON.stringify(CONTEXT_TOOL_SCHEMAS);

/**
 * `annotate` is in Zone A because the design's Zone-A sizing and Step 5 smoke
 * are both specified over the four-tool contract — but its handler re-runs the
 * hermetic ingest pipeline, which would re-mint node ids on a store Step 1
 * froze. Offering it and refusing it is the only way to hold both rules: the
 * schema is present for sizing and for the smoke's parseable-args question,
 * and a model that actually calls it gets an error instead of a mutated epoch.
 */
const FROZEN_ANNOTATE_REFUSAL = Object.freeze({
  ok: false,
  error: {
    code: 'invalid_input',
    message:
      'annotate is disabled in the transplant harness: L1 was frozen at Step 1 and annotate re-runs ingestion, ' +
      'which would re-mint node ids mid-experiment. Use context_search / context_fetch / context_peek.',
  },
});

/**
 * Assembles at an EXPLICIT keep — the primitive the rootKeep derivation walks
 * the ladder with, and which `buildTreePrompt` is the guarded wrapper around.
 * Split out precisely so the derivation can test the real thing rather than a
 * model of it.
 */
function assembleTreeAt(scenario, budgets, rootKeep, { withTools, expectedSha }) {
  // Routed through `composeRootAt` so an already-composed root is a no-op
  // rather than another appended version (D3 keeps every one of them).
  composeRootAt(scenario, rootKeep, expectedSha);
  const assembler = new ZoneAssembler({
    store: scenario.store,
    blobs: scenario.blobs,
    trace: scenario.trace,
    tokenizer: heuristic,
    systemContract: TREE_SYSTEM,
    budgets: { zoneB: budgets.zoneB, zoneC: budgets.zoneC },
  });
  const prompt = assembler.assemble({ toolSchemasText: withTools ? TOOL_SCHEMAS_TEXT : '' });
  return { assembler, prompt };
}

function buildTreePrompt(scenario, budgets, { withTools }) {
  if (budgets.rootKeep === null || budgets.rootKeep === undefined) {
    throw new Error(
      `W=${budgets.window}: no rootKeep on the ladder [${ROOT_KEEP_LADDER.join(', ')}] produces a Zone B that fits ` +
        `${budgets.zoneB} tokens with at least one branch summary surviving — this cell is dead, publish the ` +
        'surviving windows and record the reason (do not force the fit)',
    );
  }
  return assembleTreeAt(scenario, budgets, budgets.rootKeep, { withTools, expectedSha: budgets.rootSummarySha });
}

/** truncate-tail: newest L0 events whose cumulative heuristic cost fits K. */
function buildTruncatedTail(scenario, budgets) {
  const events = scenario.trace.all();
  const from = truncationBoundarySeq(events, scenario.blobs, budgets.K);
  const kept = events.filter((event) => event.seq >= from);
  return { text: renderNativeTranscript(kept, scenario.blobs), fromSeq: from, events: kept.length };
}

// ── gates (checklist items 1-14) ─────────────────────────────────────────
function pass(id, detail, data = {}) {
  return { id, status: 'PASS', detail, ...data };
}
function fail(id, detail, data = {}) {
  return { id, status: 'FAIL', detail, ...data };
}
function defer(id, detail, data = {}) {
  return { id, status: 'DEFER', detail, ...data };
}

/** Copies L0+L2 to a scratch root and re-derives L1 from them alone (D8, D15). */
function rederive(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-transplant-rederive-'));
  try {
    mkdirSync(join(dir, 'store'), { recursive: true });
    cpSync(scenario.paths.trace, join(dir, 'store', 'trace.jsonl'));
    cpSync(scenario.paths.blobs, join(dir, 'store', 'blobs'), { recursive: true });
    const handle = openTaskStore({ ...scenario.config, root: join(dir, 'store') });
    try {
      const { stats } = ingest({ handle });
      return { stats, dump: nodeDump(handle.store) };
    } finally {
      handle.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runGates(scenario, options) {
  const results = [];
  const summaries = summaryBodies(scenario.store);
  const hasSummaries = summaries.size > 0;
  const events = scenario.trace.all();

  // 1 — trace sha + byte length recorded.
  if (scenario.traceSha === null) {
    results.push(fail('g1-trace-sha', `no trace.src.jsonl at ${scenario.src}`));
  } else {
    results.push(
      pass('g1-trace-sha', `sha256=${scenario.traceSha} bytes=${scenario.traceBytes}`, {
        sha256: scenario.traceSha,
        bytes: scenario.traceBytes,
      }),
    );
  }

  // 2 + 4 + 5 — one offline re-derivation answers three questions: it ran with
  // no network (hermetic), it named no unmapped tool, and it produced the same
  // node ids and spans as the frozen L1.
  let rederived = null;
  try {
    rederived = rederive(scenario);
    results.push(
      pass('g2-hermetic-import', `ingest() re-derived L1 from L0+L2+tree-sitter alone: ${rederived.stats.events} events, ${rederived.stats.phases} phases`),
    );
    results.push(
      rederived.stats.unmappedTools.length === 0
        ? pass('g4-unmapped-tools', 'unmapped tools -> "other" list is empty')
        : fail('g4-unmapped-tools', `unmapped: ${rederived.stats.unmappedTools.join(', ')} — add them to toolPhase`),
    );
    const frozenDump = nodeDump(scenario.store);
    results.push(
      rederived.dump === frozenDump
        ? pass('g5-rebuild-determinism', `node ids + spans identical after re-derivation (${sha256(frozenDump).slice(0, 12)})`)
        : fail('g5-rebuild-determinism', 're-derived L1 differs from the frozen L1 — L1 is not a function of L0+L2'),
    );
  } catch (error) {
    results.push(fail('g2-hermetic-import', `ingest() threw: ${error.message}`));
    results.push(defer('g4-unmapped-tools', 're-derivation failed'));
    results.push(defer('g5-rebuild-determinism', 're-derivation failed'));
  }

  // 3 — isMeta lines counted as skipped, zero imported as user turns.
  if (scenario.traceSha === null) {
    results.push(defer('g3-ismeta-skipped', 'no trace.src.jsonl to map'));
  } else {
    const { mapClaudeCodeTranscript } = await import(join(REPO, 'packages/cli/dist/index.js'));
    const dir = mkdtempSync(join(tmpdir(), 'ct-transplant-map-'));
    try {
      const lines = readFileSync(scenario.src, 'utf8').split('\n');
      const scratch = new FsBlobStore(join(dir, 'blobs'));
      const mapped = mapClaudeCodeTranscript(lines, { startSeq: 0, blobs: scratch });
      const metaTexts = new Set();
      for (const raw of lines) {
        if (raw.trim().length === 0) continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        if (parsed?.isMeta === true) metaTexts.add(JSON.stringify(parsed.message?.content ?? null));
      }
      const imported = mapped.events
        .filter((event) => event.type === 'user_message')
        .map((event) => scratch.getText(event.blob));
      const leaked = imported.filter((text) => [...metaTexts].some((meta) => meta.includes(text) && text.length > 0));
      results.push(
        metaTexts.size === 0
          ? fail('g3-ismeta-skipped', 'no isMeta:true lines in the source — the assertion is vacuous, check the substrate')
          : leaked.length === 0
            ? pass('g3-ismeta-skipped', `${metaTexts.size} isMeta line(s) counted into skipped=${mapped.skipped}; 0 imported as user turns`)
            : fail('g3-ismeta-skipped', `${leaked.length} isMeta payload(s) reached L0 as user turns`),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 6 — the native transcript, in real cl100k tokens, exceeds both windows.
  const native = renderNativeTranscript(events, scenario.blobs);
  const nativeExact = exact.count(native);
  const nativeHeuristic = heuristic.count(native);
  const overAll = WINDOWS.every((w) => nativeExact > w);
  results.push(
    (overAll ? pass : fail)(
      'g6-native-exceeds-window',
      `native transcript = ${nativeExact} cl100k tokens (heuristic ${nativeHeuristic}); ` +
        WINDOWS.map((w) => `${(nativeExact / w).toFixed(2)}x W=${w}`).join(', '),
      { nativeExact, nativeHeuristic, nativeChars: native.length },
    ),
  );

  // 7 — the ratio, the slack re-floor, and the kill condition.
  const sample = l0Sample(scenario.blobs, scenario.paths.blobs);
  const sampleHeuristic = heuristic.count(sample);
  const sampleExact = exact.count(sample);
  const ratio = sampleExact / sampleHeuristic;
  const verdict = ratioVerdict(ratio);
  results.push(
    (verdict.ok ? pass : fail)(
      'g7-bpe-ratio',
      `ratio = ${sampleExact}/${sampleHeuristic} = ${ratio.toFixed(6)} over all ${blobRefsOf(scenario.paths.blobs).length} L2 blobs; ` +
        `${verdict.action}${verdict.ok ? '' : ` (kill condition ratio > ${RATIO_KILL})`}`,
      { ratio, sampleExact, sampleHeuristic, slackFraction: verdict.slackFraction },
    ),
  );

  // The derived budget table — printed here because every later gate reads it.
  // Budgets per window, with `rootKeep` derived (D19 extended) — the store is
  // left composed at the LAST window's keep, so every consumer below composes
  // its own before assembling.
  const table = {};
  for (const w of WINDOWS) table[w] = budgetsFor(scenario, w, ratio, verdict.slackFraction);

  // 8 — overBudget == [] at both W with the derived budgets, AND at least one
  // branch summary survives. The second half is not decoration: the root is
  // exempt from rule-4 dropping, so a root that eats Zone B leaves a "passing"
  // prompt whose Zone B is root-only — a flattened summary wearing the tree's
  // costs, and the `tail` stratum would be scored against it as if it were a
  // tree. The derived `rootKeep` is what makes room; this asserts it worked.
  const survivors = {};
  if (!hasSummaries) {
    results.push(defer('g8-over-budget', 'node_summaries is empty — Zone B has no content to size; run after the summarize pass'));
  } else {
    const problems = [];
    for (const w of WINDOWS) {
      if (table[w].rootKeep === null) {
        problems.push(
          `W=${w}: no rootKeep on the ladder produces a Zone B fitting ${table[w].zoneB} tokens with a branch summary ` +
            `surviving (smallest keep: root ${table[w].rootBlockTokens} tok, ${table[w].branchesSurviving} branch(es)) — cell is dead`,
        );
        continue;
      }
      const { prompt } = buildTreePrompt(scenario, table[w], { withTools: true });
      const branchBlocks = prompt.blocks.filter((b) => b.zone === 'B' && !b.id.startsWith('B:root'));
      survivors[w] = new Set(branchBlocks.map((b) => b.nodeId ?? b.id)).size;
      if (prompt.budgets.overBudget.length > 0) problems.push(`W=${w}: overBudget=${prompt.budgets.overBudget.join(',')}`);
      if (survivors[w] < 1) problems.push(`W=${w}: Zone B is root-only — 0 branch summaries survived`);
    }
    results.push(
      problems.length === 0
        ? pass(
            'g8-over-budget',
            `overBudget == [] at W = ${WINDOWS.join(' and ')}; branch summaries surviving in Zone B: ` +
              WINDOWS.map((w) => `W=${w} -> ${survivors[w]}/${summaries.size - 1} (rootKeep=${table[w].rootKeep}, root ${table[w].rootBlockTokens} tok)`).join(', '),
            { survivors: { ...survivors } },
          )
        : fail('g8-over-budget', problems.join('; '), { survivors: { ...survivors } }),
    );
  }

  // 9 — Zone B nesting across the portability sweep (Graft 3, D5).
  //
  // Originally written as a PREFIX-subset check, which is the wrong shape and
  // would have failed for a healthy reason: rule-4 degradation drops the
  // OLDEST branches first, so a smaller window keeps the NEWEST branches — its
  // branch list is a contiguous SUFFIX of the larger window's, not a prefix.
  // (Measured: at W=65536 root+branches exceed the Zone B budget and the two
  // oldest branches drop.) The root block is excluded outright: `rootKeep` is
  // now derived per window, so the root legitimately differs between them.
  // What still must hold is that the tree grows newest-aligned and in creation
  // order, which is exactly what a contiguous suffix asserts.
  const nesting = [];
  const dead = [];
  if (!hasSummaries) {
    results.push(defer('g9-zone-b-nesting', 'node_summaries is empty — the nesting sweep would be vacuously true'));
  } else {
    const problems = [];
    for (const w of NESTING_WINDOWS) {
      const budgets = budgetsFor(scenario, w, ratio, verdict.slackFraction);
      if (budgets.rootKeep === null) {
        // A dead window renders no Zone B at all, so it is not a nesting
        // counter-example — it is a missing row. Named here, adjudicated by
        // gate 8 for the primary windows.
        dead.push(`W=${w} (zoneB ${budgets.zoneB}; smallest keep=${ROOT_KEEP_LADDER.at(-1)} root ${budgets.rootBlockTokens} tok leaves no branch)`);
        continue;
      }
      const { prompt } = buildTreePrompt(scenario, budgets, { withTools: true });
      nesting.push({
        w,
        rootKeep: budgets.rootKeep,
        rootBlockTokens: budgets.rootBlockTokens,
        branchIds: prompt.blocks.filter((b) => b.zone === 'B' && !b.id.startsWith('B:root')).map((b) => b.id),
        overBudget: prompt.budgets.overBudget,
      });
    }
    for (let i = 0; i < nesting.length - 1; i += 1) {
      const small = nesting[i];
      const large = nesting[i + 1];
      if (!isContiguousSuffix(small.branchIds, large.branchIds)) {
        problems.push(`W=${small.w} branch list is not a contiguous suffix of W=${large.w}`);
      }
    }
    for (const row of nesting) {
      if (row.overBudget.length > 0) problems.push(`W=${row.w} overBudget=${row.overBudget.join(',')}`);
    }
    results.push(
      problems.length === 0
        ? pass(
            'g9-zone-b-nesting',
            'Zone B branch lists nest newest-aligned across W ∈ ' +
              `{${nesting.map((r) => `${r.w}:${r.branchIds.length}b/keep${r.rootKeep}/root${r.rootBlockTokens}`).join(', ')}}; ` +
              'creation order intact, root excluded (derived per window)' +
              (dead.length === 0 ? '' : ` — DEAD, no Zone B renders: ${dead.join(', ')}`),
            { nesting: nesting.map(({ w, rootKeep, rootBlockTokens, branchIds }) => ({ w, rootKeep, rootBlockTokens, branches: branchIds.length })) },
          )
        : fail('g9-zone-b-nesting', problems.join('; ')),
    );
  }

  // 10 — mocked-LLM dry run: the Zone A+B prefix is byte-identical across reps
  // and across questions within an arm, and a fetch result lands after Zone C.
  const liveWindow = WINDOWS.find((w) => table[w].rootKeep !== null);
  if (!hasSummaries) {
    results.push(defer('g10-prefix-stability', 'node_summaries is empty — no Zone B prefix to compare'));
  } else if (liveWindow === undefined) {
    results.push(defer('g10-prefix-stability', 'every primary window is dead (no rootKeep fits) — nothing assembles to compare'));
  } else {
    const budgets = table[liveWindow];
    const prefixes = new Set();
    for (let rep = 0; rep < 3; rep += 1) {
      const { assembler, prompt } = buildTreePrompt(scenario, budgets, { withTools: true });
      const zoneAB = prompt.system + ' ' + prompt.blocks.filter((b) => b.zone === 'B').map((b) => b.text).join('\n\n');
      prefixes.add(sha256(zoneAB));
      if (rep === 0) {
        assembler.appendTail({ id: 'probe', text: 'FETCHED-PROBE', ephemeral: true });
        const withTail = assembler.assemble({ toolSchemasText: TOOL_SCHEMAS_TEXT, tail: assembler.tailEntries() });
        const zones = withTail.blocks.map((b) => b.zone);
        const lastC = zones.lastIndexOf('C');
        const firstTail = zones.indexOf('tail');
        if (firstTail !== -1 && lastC !== -1 && firstTail < lastC) prefixes.add('TAIL-BEFORE-ZONE-C');
      }
    }
    results.push(
      prefixes.size === 1
        ? pass('g10-prefix-stability', `Zone A+B prefix byte-identical across 3 assemblies at W=${liveWindow} (${[...prefixes][0].slice(0, 12)}); tail appends after Zone C`)
        : fail('g10-prefix-stability', `prefix is not stable: ${[...prefixes].join(' / ')}`),
    );
  }

  // 11 — every answer literal occurs exactly once in L0.
  const literalsPath = join(scenario.artifacts, 'literals.json');
  const questionsPath = join(scenario.artifacts, 'questions.json');
  const literalsFile = existsSync(literalsPath) ? JSON.parse(readFileSync(literalsPath, 'utf8')) : null;
  if (literalsFile === null) {
    results.push(defer('g11-literal-uniqueness', `no literals.json at ${literalsPath} — run --phase prep`));
  } else {
    const bad = [];
    for (const item of literalsFile.selected ?? []) {
      for (const literal of item.answer_literals) {
        const n = countOccurrences(native, literal);
        if (n !== 1) bad.push(`${JSON.stringify(literal)} x${n}`);
      }
    }
    results.push(
      bad.length === 0
        ? pass('g11-literal-uniqueness', `all ${(literalsFile.selected ?? []).length} selected item(s) have literals occurring exactly once in L0`)
        : fail('g11-literal-uniqueness', `not once-only: ${bad.join(', ')}`),
    );
  }

  // 12 — leakage gate + the deep stratum's defining property.
  if (!hasSummaries) {
    results.push(defer('g12-leakage-gate', 'node_summaries is empty — nothing to leak against; run after the summarize pass'));
  } else if (!existsSync(questionsPath)) {
    results.push(defer('g12-leakage-gate', `no questions.json at ${questionsPath} — run --phase prep --allow-live`));
  } else {
    const questions = JSON.parse(readFileSync(questionsPath, 'utf8'));
    const problems = [];
    for (const q of questions.questions) {
      const summary = summaries.get(q.node_id) ?? '';
      const gate = leakageGate({ question: q.question, summaryText: summary, answerLiterals: q.answer_literals });
      if (!gate.ok) problems.push(`${q.id}: shares ${JSON.stringify(gate.shared[0])}`);
      if (q.stratum === 'deep') {
        for (const literal of q.answer_literals) {
          for (const body of summaries.values()) {
            if (body.includes(literal)) problems.push(`${q.id}: deep literal ${JSON.stringify(literal)} appears in a summary`);
          }
        }
      }
    }
    results.push(
      problems.length === 0
        ? pass('g12-leakage-gate', `${questions.questions.length} question(s): zero 3-gram overlap (answer literal excluded); deep literals absent from every summary`)
        : fail('g12-leakage-gate', problems.join('; ')),
    );
  }

  // 13 — manifest + question set hashed; the grader makes no model call.
  const manifest = readManifest(scenario);
  if (manifest === null) {
    results.push(defer('g13-manifest-hashed', `no manifest.json at ${manifestPath(scenario)} — run --phase prep`));
  } else if (!existsSync(questionsPath)) {
    results.push(
      defer('g13-manifest-hashed', 'manifest present but questions.json is not — the question-set sha cannot be checked yet', {
        manifest_gates: manifest.gates?.length ?? 0,
      }),
    );
  } else {
    const qsha = sha256File(questionsPath);
    results.push(
      manifest.questions?.sha256 === qsha
        ? pass('g13-manifest-hashed', `question-set sha ${qsha.slice(0, 12)} matches the manifest; grader = exactMatchJudge + regex, zero model calls`)
        : fail('g13-manifest-hashed', `questions.json hashes to ${qsha.slice(0, 12)} but the manifest says ${String(manifest.questions?.sha256).slice(0, 12)}`),
    );
  }

  // 14 — cost-cap plumbing: force a synthetic overspend and assert the throw.
  const meter = new InMemoryCostMeter({ capUsd: 0.000_001 });
  let fired = false;
  try {
    meter.record('claude-opus-5', { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
    meter.assertUnderCap('claude-opus-5');
  } catch (error) {
    fired = error instanceof CostCapExceededError;
  }
  results.push(
    fired
      ? pass('g14-cost-cap', `CostCapExceededError fires past the cap (meter recorded $${meter.totalUsd().toFixed(2)})`)
      : fail('g14-cost-cap', 'a synthetic overspend did NOT raise CostCapExceededError — the per-model cap is not wired'),
  );

  // ── report ─────────────────────────────────────────────────────────────
  const wanted = options.gates === undefined ? null : new Set(options.gates.split(',').map((s) => s.trim()));
  const shown = results.filter((r) => wanted === null || wanted.has(r.id));

  console.log(`\n=== OFFLINE GATES — scenario ${scenario.id} (${scenario.traceSha?.slice(0, 12) ?? 'no-src'}) ===`);
  for (const r of shown) console.log(`[${r.status}] ${r.id}: ${r.detail}`);

  console.log('\n=== DERIVED BUDGET TABLE (D19: fractions of W ÷ measured ratio) ===');
  console.log(`ratio = ${ratio.toFixed(6)}  slack fraction = ${verdict.slackFraction}  (${verdict.action})`);
  console.log('| W | zoneA | zoneB | zoneC | lazy | reply | slack | K (truncate-tail) | maxTokens | rootKeep | root block | branches |');
  console.log('| --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |');
  for (const w of WINDOWS) {
    const b = table[w];
    console.log(
      `| ${w} | ${b.zoneA} | ${b.zoneB} | ${b.zoneC} | ${b.lazy} | ${b.reply} | ${b.slack} | ${b.K} | ${b.maxReplyTokens} | ` +
        `${b.rootKeep ?? 'DEAD'} | ${b.rootBlockTokens} | ${b.branchesSurviving ?? 0} |`,
    );
  }
  console.log('\n=== rootKeep ladder (assembled Zone B at each rung: root tok / branches surviving / overBudget) ===');
  for (const w of WINDOWS) {
    console.log(
      `W=${w} zoneB ${table[w].zoneB}: ` +
        table[w].rootLadder
          .map((r) => `keep${r.keep}=${r.rootBlockTokens}tok/${r.branchesSurviving}b${r.overBudget?.length ? `/over:${r.overBudget.join('+')}` : ''}${r.ok ? ' <-' : ''}`)
          .join(' '),
    );
  }

  // Diagnostic, not a rule: the derivation stops at the LARGEST passing rung,
  // which maximises root headline coverage — but a headline is a pointer and a
  // branch summary is content, and a smaller keep frees Zone B for more of the
  // latter. Walking the rest of the ladder shows what that choice cost, so the
  // tradeoff is a number in the artifact rather than an assumption.
  console.log('\n=== rootKeep tradeoff (rungs BELOW the chosen one; diagnostic only) ===');
  for (const w of WINDOWS) {
    if (table[w].rootKeep === null) continue;
    const below = ROOT_KEEP_LADDER.filter((k) => k < table[w].rootKeep);
    const rows = below.map((keep) => {
      const { prompt } = assembleTreeAt(scenario, table[w], keep, { withTools: true });
      const branches = new Set(prompt.blocks.filter((b) => b.zone === 'B' && !b.id.startsWith('B:root')).map((b) => b.nodeId));
      return `keep${keep}=${branches.size}b`;
    });
    console.log(
      `W=${w} chosen keep${table[w].rootKeep} -> ${table[w].branchesSurviving} branches` +
        (rows.length === 0 ? ' (lowest rung)' : `; below: ${rows.join(' ')}`),
    );
    // Leave the store composed at the window's own keep again.
    composeRootAt(scenario, table[w].rootKeep, table[w].rootSummarySha);
  }

  // Does the smallest cell survive? Zone A is MEASURED, not assumed, and the
  // comparison is made in cl100k — the currency the window is denominated in.
  // Zone A's heuristic count is printed beside it because that is what the
  // assembler sees, and the two disagree by exactly the ratio measured above.
  const zoneAHeuristic = heuristic.count(TREE_SYSTEM) + heuristic.count(TOOL_SCHEMAS_TEXT);
  const zoneAExact = exact.count(TREE_SYSTEM) + exact.count(TOOL_SCHEMAS_TEXT);
  console.log('\n=== 16k CELL SURVIVAL (cl100k — the window own currency) ===');
  console.log(`Zone A measured: ${zoneAExact} cl100k / ${zoneAHeuristic} heuristic tokens (system contract + 4 tool schemas)`);
  for (const w of WINDOWS) {
    const b = table[w];
    const allowance = Math.floor(FRACTIONS.zoneA * w);
    const abc = zoneAExact + Math.round((b.zoneB + b.zoneC) * ratio);
    const spent = abc + MAX_REPLY_TOKENS;
    // Two independent ways a cell dies, and both must be reported or the
    // headline contradicts gate 8: the window can be too small for the zones,
    // OR Zone B can be too small for a root block that is exempt from
    // dropping. On this substrate it is the second that bites.
    const windowFits = zoneAExact <= allowance && spent <= w;
    const rootFits = b.rootKeep !== null;
    console.log(
      `W=${w}: zoneA ${zoneAExact} <= ${FRACTIONS.zoneA}*W = ${allowance} -> ${zoneAExact <= allowance}; ` +
        `A+B+C = ${abc} + ${MAX_REPLY_TOKENS} reply = ${spent} <= ${w} -> ${spent <= w} (headroom ${w - spent}); ` +
        `rootKeep ${b.rootKeep ?? `NONE (smallest keep leaves ${b.branchesSurviving} branches)`}` +
        `${b.rootKeep === null ? '' : ` (root ${b.rootBlockTokens} tok, ${b.branchesSurviving} branches visible, seq ${b.branchSeqRange?.from}-${b.branchSeqRange?.to})`} ` +
        `=> ${windowFits && rootFits ? 'SURVIVES' : rootFits ? 'DOES NOT FIT (window)' : 'DEAD (root block cannot fit half of Zone B)'}`,
    );
  }

  const failures = results.filter((r) => r.status === 'FAIL');
  const deferred = results.filter((r) => r.status === 'DEFER');
  console.log(
    `\n${results.length - failures.length - deferred.length} PASS / ${failures.length} FAIL / ${deferred.length} DEFER` +
      (deferred.length > 0 ? ` (deferred: ${deferred.map((r) => r.id).join(', ')})` : ''),
  );
  writeFileSync(join(scenario.artifacts, 'gates.json'), `${JSON.stringify({ ratio, table, results }, null, 2)}\n`);
  return { results, ratio, table, slackFraction: verdict.slackFraction };
}

/**
 * `small` must be a CONTIGUOUS, newest-aligned suffix of `large` — the shape
 * Zone B actually nests in once rule-4 drops the oldest branches first. Set
 * inclusion is not enough (a reorder is the D5 cache killer) and a prefix is
 * the wrong end of the list.
 */
export function isContiguousSuffix(small, large) {
  if (small.length > large.length) return false;
  const offset = large.length - small.length;
  for (let i = 0; i < small.length; i += 1) if (small[i] !== large[offset + i]) return false;
  return true;
}

// ── prep (Step 2) ────────────────────────────────────────────────────────
const PARAPHRASE_INSTRUCTIONS = [
  'You are writing ONE recall question for a memory benchmark.',
  '',
  'Below is a verbatim excerpt from an engineering session, and one FACT from inside it.',
  'Write a single question whose only correct answer is that fact.',
  '',
  'Rules:',
  '- Use NONE of the distinctive vocabulary from the excerpt. Describe the situation in your own',
  '  plain words, the way a colleague who was not there would ask about it.',
  '- Do not mention file names, symbol names, or tool names from the excerpt.',
  '- Do not include the fact itself in the question.',
  '- One sentence. Output the question and nothing else.',
].join('\n');

async function runPrep(scenario, options) {
  const events = scenario.trace.all();
  const summaries = summaryBodies(scenario.store);
  const ratio = measureRatio(scenario);
  const verdict = ratioVerdict(ratio);
  if (!verdict.ok) {
    throw new Error(`KILL GATE: heuristic->BPE ratio ${ratio.toFixed(4)} exceeds ${RATIO_KILL} — see Step 3 mitigation before proceeding`);
  }
  // Strata are cut against the SMALLEST window's K: a fact outside the tightest
  // truncation window is outside every wider one, so `head` means the same
  // thing at every W and the question set stays one frozen artifact.
  const budgets = budgetsFor(scenario, Math.min(...WINDOWS), ratio, verdict.slackFraction);
  const boundary = truncationBoundarySeq(events, scenario.blobs, budgets.K);
  const rootPins = summaries.size === 0 ? {} : rootByWindow(scenario, ratio, verdict.slackFraction);
  for (const [w, pin] of Object.entries(rootPins)) {
    console.log(
      `root pin W=${w}: rootKeep=${pin.rootKeep ?? 'DEAD'} root ${pin.rootBlockTokens} tok, ` +
        `${pin.branchesSurviving} branch summaries visible (seq ${pin.branchSeqRange?.from ?? '-'}-${pin.branchSeqRange?.to ?? '-'}), zoneB ${pin.zoneB}`,
    );
  }

  const { onceOnly, all, wellShaped } = extractLiterals(events, scenario.blobs, scenario.store);
  console.log(
    `candidates: ${all.length} distinct literals -> ${wellShaped.length} well-shaped -> ${onceOnly.length} once-only with >= ${MIN_CONTEXT_CHARS} chars of context`,
  );
  console.log(`truncate-tail boundary: seq >= ${boundary} is visible to truncation at W=${Math.min(...WINDOWS)} (K=${budgets.K})`);

  const head = onceOnly.filter((r) => r.seq < boundary);
  const tail = onceOnly.filter((r) => r.seq >= boundary);
  const deepPending = summaries.size === 0;
  const deep = deepPending
    ? []
    : head.filter((r) => ![...summaries.values()].some((body) => body.includes(r.literal)));

  const strata = {
    head: pickDeterministic(head, Q_PER_STRATUM),
    tail: pickDeterministic(tail, Q_PER_STRATUM),
    deep: pickDeterministic(deep, Q_PER_STRATUM),
  };
  // `spanning` is exploratory (Graft 5): two literals from two DIFFERENT
  // phases, so answering it needs at least a two-branch hop. Pre-registered as
  // exploratory here so it cannot be promoted into the primary verdict later.
  // Its literals are disjoint from the primary strata's — an exploratory probe
  // that re-asks a scored question's answer is not an independent probe.
  const claimed = new Set(Object.values(strata).flat().map((r) => r.literal));
  const spanPool = pickDeterministic(head, Q_PER_STRATUM * 2, { exclude: claimed });
  const spanning = [];
  for (let i = 0; i + 1 < spanPool.length && spanning.length < Q_PER_STRATUM; i += 2) {
    spanning.push({ ...spanPool[i], pair: spanPool[i + 1] });
  }

  const selected = [];
  let n = 0;
  for (const stratum of [...PRIMARY_STRATA, ...EXPLORATORY_STRATA]) {
    const pool = stratum === 'spanning' ? spanning : strata[stratum];
    for (const item of pool) {
      const literals = stratum === 'spanning' ? [item.literal, item.pair.literal] : [item.literal];
      n += 1;
      selected.push({
        id: `${scenario.id}-q${String(n).padStart(2, '0')}-${stratum}`,
        stratum,
        exploratory: EXPLORATORY_STRATA.includes(stratum),
        node_id: item.node_id,
        node_ids: stratum === 'spanning' ? [item.node_id, item.pair.node_id] : [item.node_id],
        seq: item.seq,
        kind: item.kind,
        answer_literals: literals,
        answer_regexes: answerRegexesFor(literals),
        source_context: stratum === 'spanning' ? `${item.context}\n---\n${item.pair.context}` : item.context,
      });
    }
  }

  const literalsFile = {
    scenario: scenario.id,
    trace_sha256: scenario.traceSha,
    ratio,
    boundary_seq: boundary,
    K: budgets.K,
    counts: { distinct: all.length, once_only: onceOnly.length, head: head.length, tail: tail.length, deep: deep.length },
    deep_pending: deepPending,
    selected,
  };
  writeFileSync(join(scenario.artifacts, 'literals.json'), `${JSON.stringify(literalsFile, null, 2)}\n`);
  writeFileSync(manifestPath(scenario), `${JSON.stringify(buildManifest(scenario, { ratio, root_by_window: rootPins, literals: { sha256: sha256(JSON.stringify(literalsFile)) } }), null, 2)}\n`);
  console.log(
    `strata: head=${strata.head.length} tail=${strata.tail.length} deep=${strata.deep.length} spanning=${spanning.length}` +
      (deepPending ? ' (deep is EMPTY: node_summaries has no rows yet)' : ''),
  );
  console.log(`wrote ${join(scenario.artifacts, 'literals.json')} and ${manifestPath(scenario)}`);

  if (deepPending) {
    console.log(
      '\nThe `deep` stratum is defined as "absent from EVERY stored summary", so it cannot be cut before\n' +
        'the summarize pass. Re-run `--phase prep` after summarization to fill it.',
    );
  }
  if (options.allowLive !== true) {
    console.log(
      '\nSTOPPED after literal extraction: the paraphrase batch is LIVE (`z-ai/glm-5.3-flash`).\n' +
        'Re-run with --allow-live to write questions.json.',
    );
    return;
  }

  // ── live: one small paraphrase batch, third model family ───────────────
  loadDotEnv();
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set — the paraphrase batch needs it');
  const meter = new InMemoryCostMeter({ capUsd: 0.25 });
  const provider = new MeteredProvider(new OpenRouterProvider({ apiKey }), meter);
  const questions = [];
  for (const item of selected) {
    // The paraphraser sees the raw L0 span and the fact. It never sees node_id,
    // branch_id, the stratum, or which retrieval tool would surface the answer.
    const result = await provider.complete({
      model: PARAPHRASE_MODEL,
      messages: [
        {
          role: 'user',
          content: `${PARAPHRASE_INSTRUCTIONS}\n\n# Excerpt\n${item.source_context}\n\n# Fact\n${item.answer_literals.join(' AND ')}`,
        },
      ],
      maxTokens: 200,
    });
    const question = result.text.trim().split('\n')[0] ?? '';
    const summary = summaries.get(item.node_id) ?? '';
    const gate = leakageGate({ question, summaryText: summary, answerLiterals: item.answer_literals });
    questions.push({ ...item, question, leakage: gate, rejected: !gate.ok });
    console.log(`  ${item.id} [${gate.ok ? 'ok' : `REJECTED: shares ${JSON.stringify(gate.shared[0])}`}] ${question.slice(0, 110)}`);
  }
  const kept = questions.filter((q) => !q.rejected);
  const file = { scenario: scenario.id, trace_sha256: scenario.traceSha, paraphraser: PARAPHRASE_MODEL, ratio, questions: kept, rejected: questions.filter((q) => q.rejected) };
  const path = join(scenario.artifacts, 'questions.json');
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  writeFileSync(
    manifestPath(scenario),
    `${JSON.stringify(buildManifest(scenario, { ratio, root_by_window: rootPins, literals: { sha256: sha256(JSON.stringify(literalsFile)) }, questions: { sha256: sha256File(path), count: kept.length } }), null, 2)}\n`,
  );
  console.log(`\nkept ${kept.length}/${questions.length} questions -> ${path} (paraphrase spend $${meter.totalUsd().toFixed(4)})`);
}

// ── run (Steps 4-6) ──────────────────────────────────────────────────────
function providerFor(model, meters) {
  if (!meters.has(model)) meters.set(model, new InMemoryCostMeter({ capUsd: CAP_USD_PER_MODEL }));
  loadDotEnv();
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  return new MeteredProvider(new OpenRouterProvider({ apiKey }), meters.get(model));
}

/**
 * Step 4's rolling compaction artifact: one per (trace, W), question-independent
 * and frozen. Model, output cap and total prompt budget are the TREE's — a
 * compaction baseline that is allowed a bigger prompt or a stronger summarizer
 * is measuring the budget, not the organization.
 */
async function buildCompactionArtifact(scenario, budgets, provider) {
  const path = join(scenario.artifacts, `compact-${budgets.window}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const events = scenario.trace.all();
  const chunkBudget = Math.floor((0.5 * budgets.window) / budgets.ratio);
  const chunks = [];
  let current = [];
  let spent = 0;
  for (const event of events) {
    const text = renderEvent(event, scenario.blobs);
    const cost = heuristic.count(text);
    if (spent + cost > chunkBudget && current.length > 0) {
      chunks.push(current);
      current = [];
      spent = 0;
    }
    current.push(text);
    spent += cost;
  }
  if (current.length > 0) chunks.push(current);

  let running = '(no earlier summary)';
  for (const chunk of chunks) {
    const result = await provider.complete({
      model: COMPACT_MODEL_OR,
      messages: [
        {
          role: 'user',
          content: [
            'You are maintaining a rolling summary of a long engineering session so it can be resumed later.',
            'Rewrite the running summary so it also covers the new chunk. Keep concrete coordinates —',
            'file paths, symbol names, numbers, decisions, open questions. Prose only.',
            '',
            '# Running summary so far',
            running,
            '',
            '# New chunk',
            chunk.join('\n\n'),
          ].join('\n'),
        },
      ],
      maxTokens: MAX_SUMMARY_TOKENS,
    });
    running = result.text.trim();
  }
  const artifact = { window: budgets.window, chunks: chunks.length, chunk_budget: chunkBudget, model: COMPACT_MODEL, summary: running };
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function truncateToBudget(text, budget) {
  if (heuristic.count(text) <= budget) return text;
  // Newest-first is the whole point of a verbatim tail, so cut from the head.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (heuristic.count(text.slice(mid)) > budget) lo = mid + 1;
    else hi = mid;
  }
  return text.slice(lo);
}

async function buildArm(scenario, arm, budgets, provider) {
  switch (arm) {
    case 'naive-full': {
      return { system: FLAT_SYSTEM, context: renderNativeTranscript(scenario.trace.all(), scenario.blobs), tools: [] };
    }
    case 'truncate-tail': {
      const tail = buildTruncatedTail(scenario, budgets);
      return { system: FLAT_SYSTEM, context: tail.text, tools: [], meta: { fromSeq: tail.fromSeq, events: tail.events } };
    }
    case 'compact-rolling': {
      const artifact = await buildCompactionArtifact(scenario, budgets, provider);
      const tail = buildTruncatedTail(scenario, budgets);
      const context = truncateToBudget(
        `# Rolling summary of the earlier session\n${artifact.summary}\n\n# Verbatim tail\n${tail.text}`,
        budgets.zoneB + budgets.zoneC,
      );
      return { system: FLAT_SYSTEM, context, tools: [], meta: { chunks: artifact.chunks } };
    }
    case 'tree':
    case 'tree-static': {
      const withTools = arm === 'tree';
      const { assembler, prompt } = buildTreePrompt(scenario, budgets, { withTools });
      return {
        system: prompt.system,
        messages: toMessages(prompt),
        tools: withTools ? CONTEXT_TOOL_SCHEMAS : [],
        assembler,
        meta: { zoneB: prompt.budgets.zoneB, zoneC: prompt.budgets.zoneC, overBudget: prompt.budgets.overBudget },
      };
    }
    case 'memgpt':
      // R2, the named plug point. Deliberately a throw, not a stub that scores
      // zero: an unimplemented arm reported as 0.00 is a fabricated baseline.
      throw new Error(
        "arm 'memgpt' is not implemented — this is the R2 plug point. It runs over the same frozen manifest + " +
          'questions.json; implement it here and add it to ARM_IDS-scored arms.',
      );
    default:
      throw new Error(`unknown arm "${arm}" — known: ${ARM_IDS.join(', ')}`);
  }
}

const SMOKE_QUESTION =
  'Before answering anything else, call context_search once with a query of your choice, then reply with the id of the first result.';

async function runOneReplicate(scenario, built, question, model, provider, budgets) {
  const messages =
    built.messages !== undefined
      ? [...built.messages, { role: 'user', content: question }]
      : [
          { role: 'user', content: built.context },
          { role: 'user', content: question },
        ];
  const searchQueries = [];
  const fetchedIds = [];
  /**
   * One record per model call, `TurnRecord`-shaped (`eval/src/types.ts`) plus
   * the derived `promptTokens`. This is the context-size series: the whole
   * claim is that the tree's prompt stays flat where a baseline's grows, and
   * that is only visible per turn. Pure bookkeeping on usage the provider
   * already returned — it costs no extra call.
   */
  const turnRecords = [];
  let annotateRefused = 0;
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let finalText = '';
  let status = 'turn_cap';
  let turns = 0;
  const started = Date.now();

  for (let turn = 1; turn <= (built.tools.length > 0 ? MAX_TURNS : 1); turn += 1) {
    turns = turn;
    const turnStarted = Date.now();
    const result = await provider.complete({
      model,
      system: built.system,
      messages,
      ...(built.tools.length > 0 ? { tools: built.tools } : {}),
      maxTokens: budgets.maxReplyTokens,
    });
    usage = addUsage(usage, result.usage);
    turnRecords.push({
      index: turn,
      turn,
      latencyMs: Date.now() - turnStarted,
      usage: { ...result.usage },
      // Everything the provider billed as prompt, however it was cached.
      promptTokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
      input: result.usage.input,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      output: result.usage.output,
      toolCalls: result.toolCalls.map((call) => call.name),
      stopReason: result.stopReason ?? null,
    });
    messages.push({ role: 'assistant', content: result.text.length > 0 ? result.text : '(invoking tool)' });
    if (result.toolCalls.length === 0) {
      finalText = result.text;
      status = 'completed';
      break;
    }
    for (const call of result.toolCalls) {
      if (call.name === CONTEXT_SEARCH && typeof call.input.query === 'string') searchQueries.push(call.input.query);
      if (call.name === CONTEXT_FETCH && typeof call.input.branch_id === 'string') fetchedIds.push(call.input.branch_id);
      let outcome;
      if (call.name === ANNOTATE) {
        annotateRefused += 1;
        outcome = FROZEN_ANNOTATE_REFUSAL;
      } else {
        const handler = HANDLERS[call.name];
        outcome = handler
          ? await handler(built.toolCtx, call.input)
          : { ok: false, error: { code: 'invalid_input', message: `unknown tool: ${call.name}` } };
      }
      const text = toCallToolResult(outcome).content[0]?.text ?? '';
      messages.push({ role: 'user', content: `[tool_result ${call.name}] ${text}` });
    }
  }
  return {
    status,
    modelTurns: turns,
    finalText,
    searched: searchQueries.length > 0,
    fetched: fetchedIds.length > 0,
    searchQueries,
    fetchedIds,
    annotateRefused,
    usage,
    /** `RunResult.turns: TurnRecord[]` — same field name, same shape (§15). */
    turns: turnRecords,
    durationMs: Date.now() - started,
  };
}

async function runArms(scenario, options) {
  const smoke = process.env.TRANSPLANT_SMOKE === '1';
  const window = Number.parseInt(options.window ?? String(WINDOWS[0]), 10);
  if (!WINDOWS.includes(window)) throw new Error(`--window must be one of ${WINDOWS.join(', ')}`);
  // Checks the freeze AND leaves the store composed at this window's root, so
  // every arm below reads the root the manifest pinned.
  const manifest = assertFrozen(scenario, { window });
  const ratio = manifest.ratio ?? measureRatio(scenario);
  const budgets = budgetsFor(scenario, window, ratio, ratioVerdict(ratio).slackFraction);
  // Graft 6: the derived value is EXPORTED, never hand-edited into loop.ts.
  process.env.EVAL_LAZY_TOKENS = String(budgets.lazy);
  console.log(
    `derived: EVAL_LAZY_TOKENS=${budgets.lazy} --zone-b-budget=${budgets.zoneB} --zone-c-budget=${budgets.zoneC} ` +
      `K=${budgets.K} rootKeep=${budgets.rootKeep} (root ${budgets.rootBlockTokens} tok, ${budgets.branchesSurviving} branches ` +
      `seq ${budgets.branchSeqRange?.from}-${budgets.branchSeqRange?.to}) maxTokens=${budgets.maxReplyTokens}`,
  );

  const models = options.model === undefined ? [...MODELS] : [options.model];
  const arms = options.arm === undefined ? [...SCORED_ARMS] : options.arm.split(',').map((s) => s.trim());
  const reps = Number.parseInt(options.reps ?? String(REPS), 10);
  const meters = new Map();

  const questionsPath = join(scenario.artifacts, 'questions.json');
  let questions;
  if (smoke) {
    questions = [{ id: 'smoke', stratum: 'smoke', question: SMOKE_QUESTION, answer_literals: [], answer_regexes: [], node_id: null }];
  } else {
    if (!existsSync(questionsPath)) throw new Error(`no questions.json at ${questionsPath} — run --phase prep --allow-live`);
    questions = JSON.parse(readFileSync(questionsPath, 'utf8')).questions;
    if (options.stratum !== undefined) questions = questions.filter((q) => q.stratum === options.stratum);
  }

  const retriever = new TreeRetriever({ store: scenario.store, blobs: scenario.blobs, trace: scenario.trace });
  const toolCtx = {
    config: scenario.config,
    handle: { config: scenario.config, paths: scenario.paths, trace: scenario.trace, blobs: scenario.blobs, store: scenario.store, close() {} },
    retriever,
  };

  const rows = [];
  for (const model of models) {
    const provider = providerFor(model, meters);
    for (const arm of arms) {
      const built = { ...(await buildArm(scenario, arm, budgets, provider)), toolCtx };
      const n = smoke ? SMOKE_N : arm === 'naive-full' ? 1 : questions[0]?.exploratory === true ? SPANNING_REPS : reps;
      for (const question of questions) {
        for (let rep = 1; rep <= n; rep += 1) {
          try {
            const r = await runOneReplicate(scenario, built, question.question, model, provider, budgets);
            const grade = smoke || question.answer_literals.length === 0 ? { score: null, success: null } : gradeAnswer(r.finalText, question);
            rows.push({ scenario: scenario.id, model, arm, window, question: question.id, stratum: question.stratum, rep, ...r, ...grade });
            console.log(
              `  ${arm}/${model}/${question.id}#${rep}: ${r.status} turns=${r.modelTurns} searched=${r.searched} fetched=${r.fetched} ` +
                `score=${grade.score ?? '-'} tok=${r.usage.input + r.usage.output} $${meters.get(model).totalUsd().toFixed(4)}`,
            );
          } catch (error) {
            if (error instanceof CostCapExceededError) {
              console.log(`[cost cap] ${model} stopped at $${meters.get(model).totalUsd().toFixed(4)} (cap $${CAP_USD_PER_MODEL})`);
              rows.push({ scenario: scenario.id, model, arm, window, question: question.id, stratum: question.stratum, rep, status: 'cost_cap', score: null });
              break;
            }
            const kind = error instanceof ModelCallError ? 'model_call_error' : 'error';
            // Step 5's routing signal: unparseable tool args mean this model's
            // tree arm runs as `tree-static` and `deep` is UNTESTABLE for it.
            console.log(`  ${arm}/${model}/${question.id}#${rep}: ${kind} ${error.message.slice(0, 160)}`);
            rows.push({ scenario: scenario.id, model, arm, window, question: question.id, stratum: question.stratum, rep, status: kind, error: error.message, score: null });
          }
          const total = [...meters.values()].reduce((sum, m) => sum + m.totalUsd(), 0);
          if (total > CAP_USD_TOTAL) throw new Error(`total spend $${total.toFixed(2)} exceeded the $${CAP_USD_TOTAL} cap`);
        }
      }
    }
  }

  const out = join(scenario.artifacts, 'results');
  mkdirSync(out, { recursive: true });
  const name = `${smoke ? 'smoke' : 'run'}-W${window}-${arms.join('+')}-${models.map((m) => m.replaceAll('/', '_')).join('+')}.json`;
  writeFileSync(join(out, name), `${JSON.stringify({ budgets, rows }, null, 2)}\n`);
  console.log(`\nwrote ${join(out, name)}; spend ${[...meters].map(([m, meter]) => `${m}=$${meter.totalUsd().toFixed(4)}`).join(' ')}`);
}

/** Median of a numeric array — the per-turn central line for the charts. */
export function median(xs) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Chart-ready context-growth series per (arm, model, W): every rep's own
 * prompt-token-by-turn line, plus the per-turn median across reps. Median, not
 * mean, because a single run that flails to the turn cap should not bend the
 * central line — the same reason the §15 tables report medians.
 */
export function contextGrowthSeries(rows) {
  const cells = new Map();
  for (const row of rows) {
    if (!Array.isArray(row.turns) || row.turns.length === 0) continue;
    const key = `${row.model}|${row.window}|${row.arm}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(row);
  }
  const out = [];
  for (const [key, group] of [...cells].sort()) {
    const [model, window, arm] = key.split('|');
    const reps = group.map((row) => ({
      question: row.question,
      stratum: row.stratum,
      rep: row.rep,
      points: row.turns.map((t) => ({
        turn: t.turn ?? t.index,
        promptTokens: t.promptTokens,
        input: t.input,
        cacheRead: t.cacheRead,
        cacheWrite: t.cacheWrite,
        output: t.output,
      })),
    }));
    const maxTurn = Math.max(...reps.map((r) => r.points.length));
    const medianByTurn = [];
    for (let turn = 1; turn <= maxTurn; turn += 1) {
      const at = reps.map((r) => r.points.find((p) => p.turn === turn)).filter((p) => p !== undefined);
      medianByTurn.push({
        turn,
        n: at.length,
        promptTokens: median(at.map((p) => p.promptTokens)),
        output: median(at.map((p) => p.output)),
      });
    }
    out.push({ model, window: Number.parseInt(window, 10), arm, reps, medianByTurn });
  }
  return out;
}

// ── verdict (Step 6's reporting half) ────────────────────────────────────
function runVerdict(scenario) {
  const dir = join(scenario.artifacts, 'results');
  if (!existsSync(dir)) throw new Error(`no results under ${dir}`);
  const rows = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json') || file.startsWith('smoke-')) continue;
    rows.push(...JSON.parse(readFileSync(join(dir, file), 'utf8')).rows);
  }
  const cells = new Map();
  for (const row of rows) {
    const key = `${row.model}|${row.window}|${row.arm}|${row.stratum}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(row);
  }

  console.log('\n=== MEAN score / tokens / turns per (model, W, arm, stratum) ===');
  console.log('| model | W | arm | stratum | n | MEAN score | tokens | turns | ms | fetched |');
  console.log('| --- | --: | --- | --- | --: | --: | --: | --: | --: | --: |');
  for (const [key, group] of [...cells].sort()) {
    const [model, window, arm, stratum] = key.split('|');
    const scored = group.filter((r) => typeof r.score === 'number').map((r) => r.score);
    const tok = group.filter((r) => r.usage).map((r) => r.usage.input + r.usage.output);
    console.log(
      `| ${model} | ${window} | ${arm} | ${stratum} | ${group.length} | ${mean(scored)?.toFixed(3) ?? '-'} | ` +
        `${mean(tok)?.toFixed(0) ?? '-'} | ${mean(group.map((r) => r.modelTurns ?? 0))?.toFixed(2) ?? '-'} | ` +
        `${mean(group.map((r) => r.durationMs ?? 0))?.toFixed(0) ?? '-'} | ${group.filter((r) => r.fetched).length}/${group.length} |`,
    );
  }

  // ── context size vs turn ───────────────────────────────────────────────
  // The line charts baseline and tree are plotted on: one series per rep plus
  // the per-turn median, so a growing baseline and a flat tree land on the
  // same axes. Derived entirely from the persisted `turns: TurnRecord[]`.
  const series = contextGrowthSeries(rows);
  const seriesPath = join(scenario.artifacts, 'context-growth.json');
  writeFileSync(seriesPath, `${JSON.stringify(series, null, 2)}\n`);
  console.log('\n=== context size vs turn (median promptTokens; per-rep series in context-growth.json) ===');
  console.log('| model | W | arm | reps | median promptTokens by turn |');
  console.log('| --- | --: | --- | --: | --- |');
  for (const cell of series) {
    console.log(`| ${cell.model} | ${cell.window} | ${cell.arm} | ${cell.reps.length} | ${cell.medianByTurn.map((p) => p.promptTokens).join(', ')} |`);
  }
  console.log(`wrote ${seriesPath}`);

  console.log('\n=== tree − compact-rolling, bootstrap 95% CI + pre-registered escalation ===');
  for (const model of new Set(rows.map((r) => r.model))) {
    for (const window of new Set(rows.map((r) => r.window))) {
      for (const stratum of PRIMARY_STRATA) {
        const pick = (arm) =>
          rows.filter((r) => r.model === model && r.window === window && r.arm === arm && r.stratum === stratum && typeof r.score === 'number').map((r) => r.score);
        const tree = pick('tree').length > 0 ? pick('tree') : pick('tree-static');
        const compact = pick('compact-rolling');
        if (tree.length === 0 || compact.length === 0) continue;
        const ci = bootstrapCI(tree, compact);
        const esc = escalationN(mean(tree), mean(compact));
        console.log(
          `${model} W=${window} ${stratum}: Δ=${ci.point.toFixed(3)} CI [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] ` +
            `${ci.crossesZero ? `CROSSES 0 -> escalate to n=${esc.capped} (binomial ${esc.binomial}, pooled-σ ${esc.pooled})` : 'does not cross 0'}`,
        );
        // §15.2's numeric criteria, stated as the criteria and not as a hint.
        const truncate = rows
          .filter((r) => r.model === model && r.window === window && r.arm === 'truncate-tail' && r.stratum === stratum && typeof r.score === 'number')
          .map((r) => r.score);
        if (stratum === 'head') console.log(`  §15.2 head: tree ${mean(tree).toFixed(3)} >= compact ${mean(compact).toFixed(3)} + 0.25 -> ${mean(tree) >= mean(compact) + 0.25}`);
        if (stratum === 'tail' && truncate.length > 0) {
          const ok = mean(tree) >= mean(truncate) - 0.05;
          console.log(`  §15.2 tail: tree ${mean(tree).toFixed(3)} >= truncate ${mean(truncate).toFixed(3)} − 0.05 -> ${ok}${ok ? '' : ' (REGRESSION, not a tradeoff)'}`);
        }
      }
    }
  }
}

// ── cli ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [flag, inline] = arg.slice(2).split('=');
    const key = flag.replaceAll(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (inline !== undefined) options[key] = inline;
    else if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else options[key] = true;
  }
  return options;
}

/**
 * Guarded so the pure functions above can be imported by `eval/test/` without
 * the import opening a store, reading a manifest, or spending anything.
 */
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const options = parseArgs(process.argv.slice(2));
  const scenario = openScenario(options.scenario ?? 's1');
  try {
    switch (options.phase ?? 'gates') {
      case 'gates':
        await runGates(scenario, options);
        break;
      case 'prep':
        await runPrep(scenario, options);
        break;
      case 'run':
        await runArms(scenario, options);
        break;
      case 'verdict':
        runVerdict(scenario);
        break;
      default:
        throw new Error(`unknown --phase "${options.phase}" — one of gates|prep|run|verdict`);
    }
  } finally {
    scenario.close();
  }
}
