#!/usr/bin/env node
/**
 * DS-STAR tuning · dimension 2 (branch depth) · experiment 2.
 *
 * Re-derives L1 from the frozen `transplant/s1` store's L0 under two
 * `SegmentConfig`s — today's shipped default (`neutralPhases: ['other']`) and
 * the segmenter's own documented alternative (`neutralPhases: []`, "the
 * literal §7 rule") — and reports what changes: branch count and size
 * distribution, how many branches exceed each window the transplant harness
 * tests, whether each of the twelve frozen questions' answer literal still
 * falls inside a branch that fits, and the leaf-summarizer call count each
 * segmentation implies, priced at the leaf model's named rate.
 *
 * Zero model calls, zero network. `segment()` is pure (D15); this script only
 * re-runs it and `applySegmentation()` against a COPY of the frozen store —
 * the fixture at eval/fixtures/transplant/s1 is never opened for writing.
 * Token counts are the real cl100k tokenizer (`gpt-tokenizer`), a local BPE
 * table, not an estimate — strictly more decisive than the chars/4×ratio
 * heuristic the first-iteration analysis used, and still zero spend.
 *
 * Usage: node eval/scripts/resegment.mjs
 */
import { mkdtempSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import {
  loadConfig,
  segment,
  applySegmentation,
  nodeIdMinter,
  openInMemoryStore,
  JsonlTraceLog,
  FsBlobStore,
  HeuristicTokenizer,
  priceFor,
  usdFor,
  isUserMessage,
  isAssistantMessage,
  isToolCall,
  isToolResult,
  isSegmentBoundary,
  isManualAnnotation,
} from '@context-tree/core';

/**
 * Inlined from `packages/core/src/retrieve/detail.ts` (`renderEvent`/
 * `renderSpans`) — that module is an internal path within `retrieve/`, not
 * re-exported from the package root, so this reproduces it exactly rather
 * than reaching past the package's public surface. Byte-for-byte the same
 * rendering `context_fetch depth:"full"` would produce for one span.
 */
function renderEvent(event, blobs) {
  const head = `[${event.seq}] ${event.type}`;
  if (isUserMessage(event) || isAssistantMessage(event)) {
    return `${head}\n${blobs.getText(event.blob)}`;
  }
  if (isToolCall(event)) {
    const lines = [event.path === undefined ? `${head} ${event.tool}` : `${head} ${event.tool} path=${event.path}`];
    if (event.args_blob !== undefined) lines.push(`--- args\n${blobs.getText(event.args_blob)}`);
    if (event.blob !== undefined) lines.push(`--- content\n${blobs.getText(event.blob)}`);
    return lines.join('\n');
  }
  if (isToolResult(event)) {
    const lines = [`[${event.seq}] tool_result(call=${event.call_seq})${event.truncated === true ? ' truncated' : ''}`];
    if (event.error !== undefined) lines.push(`error: ${event.error}`);
    if (event.output_blob !== undefined) lines.push(blobs.getText(event.output_blob));
    return lines.join('\n');
  }
  if (isSegmentBoundary(event)) {
    return `${head} ${event.from ?? 'null'} -> ${event.to}`;
  }
  if (isManualAnnotation(event)) {
    const target = event.node_id === undefined ? '' : ` node=${event.node_id}`;
    return `${head}${target}\n${blobs.getText(event.blob)}`;
  }
  return head;
}

function renderSpans(trace, blobs, spans) {
  const blocks = [];
  for (const span of spans) {
    for (const event of trace.read({ from: span.start, to: span.end })) {
      blocks.push(renderEvent(event, blobs));
    }
  }
  return { text: blocks.join('\n\n'), events: blocks.length };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const FIXTURE_STORE = join(REPO_ROOT, 'eval/fixtures/transplant/s1/store');
const QUESTIONS_PATH = join(
  REPO_ROOT,
  'eval/fixtures/transplant/s1/e1b289c32f40/questions.json',
);
const MANIFEST_PATH = join(REPO_ROOT, 'eval/fixtures/transplant/s1/e1b289c32f40/manifest.json');

// The windows the live transplant harness actually tests (manifest.json
// `windows`), plus the fuller sweep `NESTING_WINDOWS` in transplant.mjs uses
// for the g9 nesting gate. §5(c) step 2 of the first-iteration analysis named
// running the full sweep, not just W=32768, as unrun; this closes that gap.
const LIVE_WINDOWS = [16_384, 32_768];
const NESTING_WINDOWS = [8_192, 16_384, 32_768, 65_536, 200_000];
const ALL_WINDOWS = [...new Set([...LIVE_WINDOWS, ...NESTING_WINDOWS])].sort((a, b) => a - b);
const SMALLEST_TESTED_WINDOW = Math.min(...LIVE_WINDOWS);

const heuristic = new HeuristicTokenizer();

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

function median(xs) {
  return percentile([...xs].sort((a, b) => a - b), 0.5);
}

function stats(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: median(sorted),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1],
  };
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Re-segments `events` under `neutralPhases`, applies the resulting ops to a
 * fresh in-memory store, and reads back every `phase` node's raw span. This
 * is deliberately narrower than the production `ingest()` path: it skips
 * tree-sitter span extraction (file-level spans, irrelevant to branch-depth
 * metrics) so the offline sweep stays fast, but it uses the same `segment()`
 * + `applySegmentation()` the real ingestion path uses for L1, which is what
 * `g5-rebuild-determinism` already established reproduces the frozen tree
 * exactly.
 */
function resegmentAndMeasure(events, config, neutralPhases, trace, blobs) {
  const segmentation = segment(events, {
    toolPhase: config.toolPhase,
    neutralPhases,
    fileTools: config.fileTools,
    taskTitle: config.taskTitle,
  });

  const store = openInMemoryStore();
  applySegmentation(segmentation, store, nodeIdMinter(events));
  const phaseNodes = store
    .byKind('phase')
    .filter((n) => n.span_start_seq !== null)
    .sort((a, b) => a.span_start_seq - b.span_start_seq);

  const branches = phaseNodes.map((node) => {
    const start = node.span_start_seq;
    const end = node.span_end_seq ?? start;
    const detail = renderSpans(trace, blobs, [{ start, end }]);
    const chars = detail.text.length;
    const tokensExact = countTokens(detail.text);
    const tokensHeuristic = heuristic.count(detail.text);
    return {
      id: node.id,
      phaseType: node.phase_type,
      start,
      end,
      events: detail.events,
      chars,
      tokensExact,
      tokensHeuristic,
    };
  });

  store.close();
  return { segmentation, branches };
}

function findContainingBranch(branches, seq) {
  const hits = branches.filter((b) => b.start <= seq && seq <= b.end);
  return hits;
}

async function main() {
  console.log(`Fixture: ${FIXTURE_STORE}`);
  console.log('Copying to a scratch directory (frozen fixture is never opened for writing)...\n');

  const workDir = mkdtempSync(join(tmpdir(), 'ct-resegment-'));
  const storeDir = join(workDir, 'store');
  cpSync(FIXTURE_STORE, storeDir, { recursive: true });

  try {
    const config = loadConfig(REPO_ROOT); // reads context-tree.config.json, merged over DEFAULT_CONFIG
    const trace = new JsonlTraceLog(join(storeDir, 'trace.jsonl'));
    const blobs = new FsBlobStore(join(storeDir, 'blobs'));
    const events = trace.all();

    console.log(`L0 events: ${events.length}\n`);

    const CANDIDATES = [
      { name: 'current (neutralPhases: ["other"])', neutralPhases: config.neutralPhases },
      { name: 'neutralPhases: []  (literal §7 rule)', neutralPhases: [] },
    ];

    const results = CANDIDATES.map((c) => ({
      ...c,
      ...resegmentAndMeasure(events, config, c.neutralPhases, trace, blobs),
    }));

    // ---- Table 1: branch count + size distribution -----------------------
    console.log('='.repeat(100));
    console.log('TABLE 1 — branch count and size distribution (per candidate)');
    console.log('='.repeat(100));
    console.log(
      pad('config', 40) +
        pad('branches', 10) +
        pad('events(min/med/p90/max)', 26) +
        pad('chars(min/med/p90/max)', 30),
    );
    for (const r of results) {
      const ev = stats(r.branches.map((b) => b.events));
      const ch = stats(r.branches.map((b) => b.chars));
      console.log(
        pad(r.name, 40) +
          pad(String(r.branches.length), 10) +
          pad(`${fmt(ev.min)}/${fmt(ev.median)}/${fmt(ev.p90)}/${fmt(ev.max)}`, 26) +
          pad(`${fmt(ch.min)}/${fmt(ch.median)}/${fmt(ch.p90)}/${fmt(ch.max)}`, 30),
      );
    }
    console.log();
    console.log(
      pad('config', 40) +
        pad('exact cl100k tok(min/med/p90/max)', 38) +
        pad('heuristic tok(min/med/p90/max)', 34),
    );
    for (const r of results) {
      const te = stats(r.branches.map((b) => b.tokensExact));
      const th = stats(r.branches.map((b) => b.tokensHeuristic));
      console.log(
        pad(r.name, 40) +
          pad(`${fmt(te.min)}/${fmt(te.median)}/${fmt(te.p90)}/${fmt(te.max)}`, 38) +
          pad(`${fmt(th.min)}/${fmt(th.median)}/${fmt(th.p90)}/${fmt(th.max)}`, 34),
      );
    }

    // ---- Table 1b: per-branch exact/heuristic ratio, to explain any
    // divergence from a single corpus-wide ratio (gates.json g7-bpe-ratio).
    // Same definition as g7 (exact cl100k tokens / HeuristicTokenizer tokens),
    // applied per branch instead of once over the whole corpus's raw blobs.
    console.log('\n' + '-'.repeat(100));
    console.log(
      'TABLE 1b — per-branch (exact tok / heuristic tok) ratio — how far a single corpus-wide\n' +
        'ratio (gates.json g7-bpe-ratio = 0.850896663206653, on raw L2 blobs) can be from one\n' +
        "branch's rendered detail (headers + args + content, what context_fetch depth:'full' sends)",
    );
    console.log('-'.repeat(100));
    console.log(pad('config', 40) + pad('ratio(min/med/p90/max)', 26) + pad('branches with ratio>1.6', 26));
    for (const r of results) {
      const ratios = r.branches.map((b) => b.tokensExact / b.tokensHeuristic);
      const rs = stats(ratios);
      const over = r.branches.filter((b) => b.tokensExact / b.tokensHeuristic > 1.6).length;
      console.log(
        pad(r.name, 40) +
          pad(`${rs.min.toFixed(3)}/${rs.median.toFixed(3)}/${rs.p90.toFixed(3)}/${rs.max.toFixed(3)}`, 26) +
          pad(String(over), 26),
      );
    }

    // ---- Table 2: branches exceeding each tested window -------------------
    console.log('\n' + '='.repeat(100));
    console.log('TABLE 2 — branches exceeding each tested window (raw span, exact cl100k tokens)');
    console.log('='.repeat(100));
    console.log(pad('config', 40) + ALL_WINDOWS.map((w) => pad(`>${w}`, 10)).join(''));
    for (const r of results) {
      const counts = ALL_WINDOWS.map((w) => r.branches.filter((b) => b.tokensExact > w).length);
      console.log(pad(r.name, 40) + counts.map((c) => pad(String(c), 10)).join(''));
    }

    // ---- Table 3: per-question containment ---------------------------------
    const questionsDoc = JSON.parse(readFileSync(QUESTIONS_PATH, 'utf8'));
    console.log('\n' + '='.repeat(100));
    console.log('TABLE 3 — per-question containment (does the answer-literal seq land in exactly');
    console.log('one branch, and does that branch fit each live window?)');
    console.log('='.repeat(100));
    for (const r of results) {
      console.log(`\n-- ${r.name} --`);
      console.log(
        pad('question', 16) +
          pad('seq', 6) +
          pad('#branches', 10) +
          pad('span', 14) +
          pad('exact tok', 10) +
          LIVE_WINDOWS.map((w) => pad(`fits ${w}`, 12)).join(''),
      );
      let anyMultiHit = false;
      let anyOverAllWindows = 0;
      for (const q of questionsDoc.questions) {
        const hits = findContainingBranch(r.branches, q.seq);
        if (hits.length !== 1) anyMultiHit = true;
        const b = hits[0];
        const label = `${q.stratum}@${q.seq}`;
        if (b === undefined) {
          console.log(pad(label, 16) + pad(String(q.seq), 6) + pad(String(hits.length), 10) + 'NO CONTAINING BRANCH');
          continue;
        }
        const fits = LIVE_WINDOWS.map((w) => (b.tokensExact <= w ? 'yes' : 'NO'));
        console.log(
          pad(label, 16) +
            pad(String(q.seq), 6) +
            pad(String(hits.length), 10) +
            pad(`${b.start}-${b.end}`, 14) +
            pad(String(b.tokensExact), 10) +
            fits.map((f) => pad(f, 12)).join(''),
        );
      }
      console.log(
        `  (${questionsDoc.questions.length} questions; each lands in exactly one branch: ${
          anyMultiHit ? 'NO — see above' : 'yes'
        })`,
      );
    }

    // ---- Table 4: leaf-summarizer call count + price footnote -------------
    console.log('\n' + '='.repeat(100));
    console.log('TABLE 4 — leaf-summarizer calls implied, priced at the leaf model\'s named rate');
    console.log('='.repeat(100));
    const leafModel = config.leafModel; // 'claude-haiku-4-5-20251001' on this store
    const { price, matched } = priceFor(leafModel);
    const maxSummaryTokens = config.summarize.maxSummaryTokens;
    const leafPromptPath = join(REPO_ROOT, 'packages/core/src/prompts/leaf-summary.v1.md');
    const leafPromptTok = countTokens(readFileSync(leafPromptPath, 'utf8'));
    console.log(
      `Leaf model: ${leafModel} -> price-table prefix "${matched}" ` +
        `($${price.input}/M in, $${price.output}/M out — packages/core/src/models/cost.ts DEFAULT_PRICES)`,
    );
    console.log(
      `Fixed per-call system-prompt overhead: ${leafPromptTok} exact tok ` +
        `(packages/core/src/prompts/leaf-summary.v1.md, measured — not the branch content, charged once per call regardless of branch size)`,
    );
    console.log(`Per-call output cap assumed: maxSummaryTokens=${maxSummaryTokens} (config.ts, upper bound — real output is usually less)\n`);
    console.log(pad('config', 40) + pad('leaf calls', 12) + pad('sum input tok', 16) + pad('est. cost (USD)', 16));
    const costRows = [];
    for (const r of results) {
      const sumInputTok = r.branches.reduce((s, b) => s + b.tokensExact + leafPromptTok, 0);
      const usd = r.branches.reduce(
        (s, b) =>
          s + usdFor({ input: b.tokensExact + leafPromptTok, output: maxSummaryTokens, cacheRead: 0, cacheWrite: 0 }, price),
        0,
      );
      costRows.push({ name: r.name, calls: r.branches.length, sumInputTok, usd });
      console.log(
        pad(r.name, 40) + pad(String(r.branches.length), 12) + pad(String(sumInputTok), 16) + pad(`$${usd.toFixed(4)}`, 16),
      );
    }
    const ratio = costRows[1].calls / costRows[0].calls;
    const usdRatio = costRows[1].usd / costRows[0].usd;
    console.log(`\ncall-count ratio (candidate 2 / candidate 1): ${ratio.toFixed(2)}x`);
    console.log(`est. cost ratio (candidate 2 / candidate 1): ${usdRatio.toFixed(2)}x`);
    // How much of the cost delta is the fixed per-call overhead (prompt +
    // output cap) vs. the branch content itself — content is ~fixed (a
    // partition of the same L0), so the delta should track the per-call
    // overhead terms almost exactly.
    const fixedPerCallUsd = usdFor({ input: leafPromptTok, output: maxSummaryTokens, cacheRead: 0, cacheWrite: 0 }, price);
    const fixedDelta = fixedPerCallUsd * (costRows[1].calls - costRows[0].calls);
    console.log(
      `of the $${(costRows[1].usd - costRows[0].usd).toFixed(4)} delta, $${fixedDelta.toFixed(4)} is the ` +
        `${costRows[1].calls - costRows[0].calls} extra calls' fixed per-call cost alone ` +
        `(${leafPromptTok} tok prompt + ${maxSummaryTokens}-tok output cap, content held constant)`,
    );

    // ---- Table 5: boundary condition ---------------------------------------
    console.log('\n' + '='.repeat(100));
    console.log(`TABLE 5 — boundary condition: any branch whose raw span exceeds the smallest`);
    console.log(`tested window (W=${SMALLEST_TESTED_WINDOW})?`);
    console.log('='.repeat(100));
    for (const r of results) {
      const over = r.branches.filter((b) => b.tokensExact > SMALLEST_TESTED_WINDOW);
      console.log(
        `${r.name}: ${over.length > 0 ? 'YES' : 'no'} — ${over.length} branch(es) exceed W=${SMALLEST_TESTED_WINDOW}` +
          (over.length > 0
            ? `: ${over.map((b) => `${b.id.slice(0, 14)}… (${b.start}-${b.end}, ${b.tokensExact} tok)`).join(', ')}`
            : ''),
      );
    }

    // ---- Table 6: full ranked branch list, largest first (both configs) ---
    console.log('\n' + '='.repeat(100));
    console.log('TABLE 6 — full ranked branch list (largest exact-token first)');
    console.log('='.repeat(100));
    for (const r of results) {
      console.log(`\n-- ${r.name} (${r.branches.length} branches) --`);
      const sorted = [...r.branches].sort((a, b) => b.tokensExact - a.tokensExact);
      console.log(
        pad('id', 30) + pad('phase_type', 16) + pad('span', 14) + pad('events', 8) + pad('chars', 10) + pad('exact tok', 10),
      );
      for (const b of sorted) {
        console.log(
          pad(b.id.slice(0, 27) + '…', 30) +
            pad(b.phaseType ?? '', 16) +
            pad(`${b.start}-${b.end}`, 14) +
            pad(String(b.events), 8) +
            pad(String(b.chars), 10) +
            pad(String(b.tokensExact), 10),
        );
      }
    }

    console.log('\nDone.');
    trace.close();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function pad(s, width) {
  s = String(s);
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
