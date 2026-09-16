/**
 * MERGE + VERDICT for arm runs that were executed as separate processes.
 *
 * oc-runner.mjs compares arms against `none` WITHIN one run. To parallelise, each arm
 * was run as its own process, so no single result file contains a comparison. This
 * pools them and emits the decision the experiment exists to make.
 *
 * THE DECISION: fold anchoring into context-tree only if an arm cuts BOTH cumulative
 * prompt tokens AND wall-clock to completion against no-intervention, at task score
 * within noise. Tokens and time are separate primaries — the provider caches prefixes,
 * so re-sent tokens are cheap in TIME while still being billed.
 *
 * VALIDITY GATES run before any verdict, because on this stack a broken instrument
 * presents as a clean result rather than an error:
 *   - a fired anchor that was not truthful          -> run INVALID (it claimed something false)
 *   - a degenerate anchor-topk substitution          -> arm C invalid (replacement bigger than content)
 *   - a timed-out turn                               -> that CELL excluded (truncated, scores low, reads as an arm effect)
 *   - finish:"length" in an export                   -> that CELL excluded (response truncated mid-step)
 *
 * Token accounting notes that must travel with any number quoted from here:
 *   - prompt_tokens is the honest primary. On the local endpoint tokens.output BUNDLES
 *     reasoning while tokens.reasoning reads 0, so "output tokens" is mostly thinking.
 *   - reasoning is reported as CHARS from export parts, never converted to tokens: the
 *     chars/token ratio for reasoning-dense text is ~2.3, not 4, and a derived token
 *     figure saturates the reported output.
 *
 * Rerun: node experiments/context-dedup/merge-oc-arms.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const METRICS = join(REPO, 'reports', 'metrics', 'context-dedup');
const PREFIX = process.env.CT_MERGE_PREFIX || 'results-oc-flapsim-v2-';
const ARMS = (process.env.CT_ARMS || 'none,anchor,anchor-topk,placebo').split(',');

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const mean = (xs) => xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : 0;

/** Read per-message finish from the cell's own export — the only retrospective way to
 *  catch a silent output-cap stop. The REQUESTED limit is unrecoverable; the ceiling
 *  actually hit is not. */
function lengthStops(cellDir) {
  const p = join(REPO, cellDir, 'transcript.json');
  if (!existsSync(p)) return { checked: false, stops: 0, max_output: null };
  let t; try { t = JSON.parse(readFileSync(p, 'utf8')); } catch { return { checked: false, stops: 0, max_output: null, parse_error: true }; }
  let stops = 0, maxOut = 0;
  for (const m of t.messages || []) {
    const i = m.info || m; const tk = i.tokens || {};
    if (i.finish === 'length') stops += 1;
    maxOut = Math.max(maxOut, tk.output || 0);
  }
  return { checked: true, stops, max_output: maxOut };
}

/**
 * PRE-REGISTERED EXCLUSION POLICY — fixed BEFORE any cell completed, because deciding
 * it after seeing which arm the truncated cells fell in is the post-hoc call this
 * project has already been burned by.
 *
 * T1 An arm with fewer than 2 usable cells gets no verdict (INSUFFICIENT).
 * T2 If more than 25% of all cells are excluded (>3 of 12), the run is DESCRIPTIVE
 *    ONLY — report the numbers, emit no fold-in/leave-out decision.
 * T3 If exclusions are UNEVEN across arms (max-per-arm minus min-per-arm >= 2), do not
 *    pool. Truncation is not random: an arm whose turns run longer truncates more, so
 *    dropping its cells biases the survivors in that arm's favour. Uneven exclusion is
 *    a signal about the arm, not noise to be discarded.
 */
const T2_MAX_EXCLUDED_FRACTION = 0.25;
const T3_MAX_ARM_IMBALANCE = 2;

const files = readdirSync(METRICS).filter((f) => f.startsWith(PREFIX) && f.endsWith('.json'));
if (!files.length) { console.error(`no result files matching ${PREFIX}* in ${METRICS}`); process.exit(1); }

const cells = [];
const sources = [];
for (const f of files) {
  const d = JSON.parse(readFileSync(join(METRICS, f), 'utf8'));
  sources.push({ file: f, run_id: d.manifest?.run_id, commit: d.manifest?.commit, host: d.manifest?.host_version, model: d.manifest?.model });
  for (const c of d.cells || []) cells.push(c);
}

// ---- validity ----
for (const c of cells) {
  const ls = c.cell_dir ? lengthStops(c.cell_dir) : { checked: false, stops: 0, max_output: null };
  c.length_stops = ls.stops; c.max_step_output = ls.max_output; c.export_checked = ls.checked;
  c.turn_timed_out = (c.turn_log || []).some((t) => t.timed_out);
  c.excluded = c.turn_timed_out ? 'turn-timed-out'
    : ls.stops > 0 ? 'output-cap-length-stop'
    : c.error ? 'errored'
    : null;
}
const usable = cells.filter((c) => !c.excluded);
const runInvalid = cells.some((c) => (c.anchor_untruthful || 0) > 0);

const summary = ARMS.map((arm) => {
  const all = cells.filter((c) => c.arm === arm);
  const cs = usable.filter((c) => c.arm === arm);
  return { arm, n_run: all.length, n_usable: cs.length,
    excluded: all.filter((c) => c.excluded).map((c) => `rep${c.repeat}:${c.excluded}`),
    score_mean: mean(cs.map((c) => c.score_correct || 0)), score_total: cs[0]?.score_total ?? 40,
    milestones_mean: mean(cs.map((c) => (c.phases_done || []).length)),
    prompt_tokens_median: med(cs.map((c) => c.prompt_tokens || 0)),
    output_tokens_median: med(cs.map((c) => c.output_tokens || 0)),
    reasoning_chars_median: med(cs.map((c) => c.reasoning_chars || 0)),
    wall_seconds_median: med(cs.map((c) => c.wall_seconds || 0)),
    fires_median: med(cs.map((c) => c.fires || 0)),
    would_fire_median: med(cs.map((c) => c.would_fire || 0)),
    anchor_untruthful: cs.reduce((a, c) => a + (c.anchor_untruthful || 0), 0),
    degenerate_topk: cs.reduce((a, c) => a + (c.degenerate_topk || 0), 0),
    files_over_1800_median: med(cs.map((c) => c.files_over_1800 || 0)) };
});

// ---- pre-registered gates, evaluated before any delta is looked at ----
const excludedCount = cells.filter((c) => c.excluded).length;
const perArmExcluded = ARMS.map((a) => cells.filter((c) => c.arm === a && c.excluded).length);
const imbalance = Math.max(...perArmExcluded) - Math.min(...perArmExcluded);
const gates = {
  T2_excluded_fraction: +(excludedCount / Math.max(1, cells.length)).toFixed(3),
  T2_threshold: T2_MAX_EXCLUDED_FRACTION,
  T2_breached: excludedCount / Math.max(1, cells.length) > T2_MAX_EXCLUDED_FRACTION,
  T3_arm_imbalance: imbalance, T3_threshold: T3_MAX_ARM_IMBALANCE,
  T3_breached: imbalance >= T3_MAX_ARM_IMBALANCE,
  per_arm_excluded: Object.fromEntries(ARMS.map((a, i) => [a, perArmExcluded[i]])),
};
gates.reportable = !gates.T2_breached && !gates.T3_breached && !runInvalid;

const base = summary.find((s) => s.arm === 'none');
for (const s of summary) {
  if (!base || !base.prompt_tokens_median) { s.verdict = 'no baseline'; continue; }
  s.tokens_delta_pct = +(100 * (1 - s.prompt_tokens_median / base.prompt_tokens_median)).toFixed(2);
  s.wall_delta_pct = base.wall_seconds_median ? +(100 * (1 - s.wall_seconds_median / base.wall_seconds_median)).toFixed(2) : null;
  s.score_delta = +(s.score_mean - base.score_mean).toFixed(2);
  if (s.arm === 'none') { s.verdict = '—'; continue; }
  s.verdict =
    runInvalid ? 'INVALID — a fired anchor was not truthful'
    : gates.T2_breached ? `DESCRIPTIVE ONLY — ${excludedCount}/${cells.length} cells excluded (>${T2_MAX_EXCLUDED_FRACTION * 100}%)`
    : gates.T3_breached ? `DESCRIPTIVE ONLY — exclusions uneven across arms (imbalance ${imbalance}); truncation correlates with arm behaviour`
    : s.n_usable < 2 ? `INSUFFICIENT — only ${s.n_usable} usable cell(s)`
    : s.arm === 'anchor-topk' && s.degenerate_topk > 0 ? 'INVALID — degenerate top-k substitution'
    : s.score_delta < -2 ? 'LEAVE OUT — task score degraded'
    : (s.tokens_delta_pct > 0 && s.wall_delta_pct > 0) ? 'FOLD IN — saves tokens and time at equal score'
    : s.tokens_delta_pct <= 0 ? 'LEAVE OUT — no token saving'
    : 'LEAVE OUT — tokens saved but no wall-clock saving';
}

const out = { manifest: {
    run_id: `oc-flapsim-merged-${Date.now()}`,
    experiment: 'context-dedup / anchor arms on opencode (merged from per-arm runs)',
    sources, commit: gitSha(), date: nowISO(),
    scenario_prompt_version: 'flapsim six-turn split (core/engine/tests/review/artifact/feature+docs)',
    problems: 1, repeats_per_arm: 3, design: 'single-problem, n repeats — NOT n problems',
    hypothesis: 'An anchor reduces cumulative prompt tokens AND wall-clock to completion at no cost to task success. If it does, fold it into context-tree; if not, leave it out.',
    falsification: 'FOLD IN only if an arm cuts BOTH tokens and wall-clock against no-intervention at score within noise. Any fired anchor that was not truthful invalidates the run.',
    caveats: [
      'SINGLE-PROBLEM (caveat C0), and this is the headline limitation, not a footnote. All 12 cells run ONE problem — the flapsim scenario — with seed files copied verbatim, so every repeat starts from an identical workspace and the only thing varying between repeats is model nondeterminism. n=3 measures WITHIN-problem variance. The repo design rule is "sample PROBLEMS, not just seeds" and this run does not. Any result here means "on flapsim, arm X did or did not cut tokens and wall-clock" — it is NOT a general claim about anchoring, and more repeats could not make it one.',
      'Arms were run as SEPARATE processes to parallelise, then merged here. All cells share one scenario, one model and one endpoint; nothing crosses a provider or routing change.',
      'prompt_tokens is the primary. On the local endpoint tokens.output BUNDLES reasoning while tokens.reasoning reads 0, so output tokens are mostly thinking and must not be read as content.',
      'Reasoning is reported in CHARS from export parts. Converting to tokens is not defensible here: the ratio for reasoning-dense text is ~2.3 chars/token, and a derived figure saturates the reported output.',
      'Cells were run 4-way concurrent on one GPU, which inflated per-turn latency ~2.4-6x versus solo. Wall-clock is therefore comparable BETWEEN arms (all equally contended) but NOT against a solo run.',
      'A low fire count must be read alongside files_over_1800: oversized modules are clipped on read, and the plugin correctly refuses to anchor a clipped fragment.',
    ] }, summary, cells };

const p = writeResults('context-dedup', 'results-oc-flapsim-merged.json', out);
console.error(`\n=== ANCHOR ARMS — MERGED (${sources.length} runs, ${cells.length} cells, ${usable.length} usable) ===`);
console.error('  arm           n   score   miles   fires  promptTok    Δtok%   wall_s   Δwall%  reasonChars');
for (const s of summary) console.error(`  ${s.arm.padEnd(12)} ${String(s.n_usable + '/' + s.n_run).padStart(3)}  ${String(s.score_mean).padStart(5)}  ${String(s.milestones_mean).padStart(5)}  ${String(s.fires_median).padStart(6)}  ${String(s.prompt_tokens_median).padStart(9)}  ${String(s.tokens_delta_pct ?? '—').padStart(7)}  ${String(s.wall_seconds_median).padStart(7)}  ${String(s.wall_delta_pct ?? '—').padStart(7)}  ${s.reasoning_chars_median}`);
const exc = cells.filter((c) => c.excluded);
if (exc.length) { console.error('\n  EXCLUDED CELLS:'); for (const c of exc) console.error(`    ${c.arm} rep${c.repeat}: ${c.excluded}`); }
console.error('\n  PRE-REGISTERED GATES:');
console.error(`    excluded ${excludedCount}/${cells.length} (${(100 * gates.T2_excluded_fraction).toFixed(0)}%, limit ${T2_MAX_EXCLUDED_FRACTION * 100}%) -> ${gates.T2_breached ? 'BREACHED' : 'ok'}`);
console.error(`    per-arm exclusions ${JSON.stringify(gates.per_arm_excluded)} imbalance=${imbalance} (limit ${T3_MAX_ARM_IMBALANCE}) -> ${gates.T3_breached ? 'BREACHED' : 'ok'}`);
console.error(`    reportable as a decision: ${gates.reportable}`);
console.error('\n  SCOPE: single problem (flapsim), n=3 repeats per arm. Repeats vary only by model');
console.error('         nondeterminism, so any verdict below is "on this problem", not general.');
console.error('\n  DECISION:');
for (const s of summary) if (s.arm !== 'none') console.error(`    ${s.arm.padEnd(14)} ${s.verdict}`);
console.error(`\n  written: ${p}`);
