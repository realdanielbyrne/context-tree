/**
 * LIVE A/B — the covariance arms on `longbuild`. ⚠️ GATED: this file refuses to run
 * without `CT_COV_LIVE=1`, and the gate is not a formality.
 *
 * WHY IT IS GATED. Five live experiments on this substrate have varied WHICH context is
 * kept and all five came back null or void: selection signal p=0.70; reference vs
 * positional recency p=1.000 at n=13; needle position 180/180 at every depth out to
 * 155,773 tokens; eviction cadence p=0.54 once achieved peak is controlled; and the
 * instrument-sensitivity gate itself, which was VOIDED because its control arm wrote
 * zero files in 10 of 10 runs — a derailed agent, not a performance floor. Until that
 * gate is re-run at a lower ballast dose and either fires or does not, a sixth
 * "does signal X beat signal Y" run on this harness buys a sixth uninterpretable null.
 * The offline arm (`offline-replay.mjs`) is where the falsifiable weight sits today.
 *
 * WHAT THIS FILE IS FOR, THEN: it is the design, written down and runnable, so that the
 * moment the gate resolves the live arm is a command rather than a week. Its parameters
 * (`alpha`, `rho`) are meant to arrive from the offline sweep, not to be guessed here.
 *
 * FIVE CONSTRAINTS THIS PROJECT LEARNED EXPENSIVELY, AND HOW EACH IS HONOURED:
 *
 *  1. VOLUME-MATCHING. Every capped arm goes through the same `evictToBudget` with the
 *     same W, anchor and reserve and differs ONLY in `rank`. `units_kept_mean` and
 *     `peak_history_tokens` are reported per arm so the property is CHECKED rather than
 *     assumed — a previous control was voided because its treatment arm simply held
 *     more useful content, and "more context is better" is already established at
 *     OR 42x per e-fold.
 *  2. CONTINUOUS ENDPOINTS. The binary pass/fail endpoint has returned null four times
 *     and discarded a real 0 -> 7 improvement in files written. The PRIMARY endpoint
 *     here is the held-out suite's PASS FRACTION, obtained by re-running the same
 *     hidden grader `task.grade()` already writes and counting individual test
 *     outcomes. `task.grade()`'s boolean is kept as a secondary, not dropped.
 *  3. ACHIEVED PEAK, NOT NOMINAL CAP. `peak_history_tokens` is sampled AFTER eviction —
 *     the size actually sent — and is the covariate every model must adjust for. A
 *     result was retracted once because a cadence gate let the transcript overshoot the
 *     nominal cap; `cadence` is therefore fixed at 1 here and `cap_violations` is
 *     reported.
 *  4. A CONTROL MUST STILL BE ATTEMPTING THE TASK. `writes` and `no_write_cells` are
 *     recorded per arm and the validity block fires automatically when an arm stops
 *     writing files.
 *  5. NOTHING IS ADDED TO THE TRANSCRIPT. Three designs that injected material —
 *     foreign tool results, user-role pastes, duplicates of the agent's own reads —
 *     each stopped the agent working entirely. Every arm here only CHANGES WHAT IS
 *     KEPT. The reference log the covariance signal needs holds file PATHS and never
 *     enters the model's context.
 *
 * THE REFERENCE LOG. `makeRefLogger` accumulates, per turn, the file paths the agent
 * touched — including paths named on a `run_bash` command line, extracted with the same
 * `bashPaths` the offline arm uses, because with a shell available that is how this
 * agent touches most files. It is append-only and OUTLIVES eviction: computing
 * covariance from the resident buffer would be a feedback loop in which evicting a unit
 * destroys the history that would later justify keeping it.
 *
 * Rerun (only after backlog item 0 resolves):
 *   set -a; . ./.env; set +a
 *   CT_COV_LIVE=1 CT_WINDOWS=7000 CT_REPEATS=12 CT_COV_ALPHA=1 CT_COV_RHO=0 \
 *     node experiments/covariance-eviction/ab-covariance.mjs
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runAgent, makeWorkspace, estTokens, extractUnits, MODEL } from '../coding-harness/lib.mjs';
import { evictByRecency, evictByRandom, evictByIdle, makeRng } from '../context-dedup/policies.mjs';
import { evictByTcovBlend, evictByPriorityRatio } from './ranks.mjs';
import { bashPaths } from './transcript.mjs';
import { wilson } from '../context-dedup/stats.mjs';
import { welchT, holm } from './metrics.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOWS = (process.env.CT_WINDOWS || '7000').split(',').map(Number);
const REPEATS = +(process.env.CT_REPEATS || 12);
const MAX_TURNS = +(process.env.CT_MAX_TURNS || 60);
const ANCHOR = +(process.env.CT_ANCHOR || 4);
const TASK_NAME = process.env.CT_TASK || 'longbuild';
const TAG = process.env.CT_TAG || 'cov1';
const ARMS = (process.env.CT_ARMS || 'truncate-tail,idle,tcov,prio-shipped,prio-tuned,random,uncapped').split(',');
/** Blend weight for the tcov arm and edit:recurrence ratio for the priority arm.
 *  BOTH ARE MEANT TO ARRIVE FROM `offline-replay.mjs`, not from this file. The defaults
 *  reproduce the endpoints of each sweep (pure covariance; pure recurrence) so a run
 *  launched without them is obviously an endpoint probe and not a fitted arm. */
const ALPHA = process.env.CT_COV_ALPHA === undefined ? 1 : +process.env.CT_COV_ALPHA;
const RHO = process.env.CT_COV_RHO === undefined ? 0 : +process.env.CT_COV_RHO;
const COV_PARAMS = {
  K: +(process.env.CT_COV_K || 5),
  L: +(process.env.CT_COV_L || 3),
  m: +(process.env.CT_COV_M || 2),
  agg: process.env.CT_COV_AGG || 'max',
};

const NOOP = { changed: false, kept: null, evicted: 0, capViolated: false };
const isCapped = (arm) => arm !== 'uncapped';

/**
 * Append-only per-turn log of the file paths the agent touched. Keyed on tool_call id
 * so a path is logged exactly once, on the turn it happened, and eviction cannot erase
 * or duplicate it. An empty turn is still pushed — K and L are turn-denominated, so
 * compressing the clock would silently change both.
 */
export function makeRefLogger() {
  const seen = new Set();
  const log = [];
  return {
    log,
    observe(messages) {
      const fresh = new Set();
      for (const m of messages) {
        if (m.role !== 'assistant' || !m.tool_calls) continue;
        for (const tc of m.tool_calls) {
          if (seen.has(tc.id)) continue;
          seen.add(tc.id);
          let a = {};
          try { a = JSON.parse(tc.function.arguments || '{}'); } catch { continue; }
          if (a.path) fresh.add(String(a.path));
          if (a.command) for (const p of bashPaths(String(a.command))) fresh.add(p);
        }
      }
      log.push(fresh);
      return fresh;
    },
  };
}

function evictorFor(arm, W, repeat, refLogger) {
  const opts = { anchor: ANCHOR };
  if (!isCapped(arm)) return () => NOOP;
  if (arm === 'truncate-tail') return (m) => evictByRecency(m, W, opts);
  if (arm === 'idle') return (m) => evictByIdle(m, W, opts);
  if (arm === 'tcov') return (m) => evictByTcovBlend(m, W, ALPHA, { refLog: refLogger.log, params: COV_PARAMS }, opts);
  if (arm === 'prio-shipped') return (m) => evictByPriorityRatio(m, W, { rho: 2, directed: false }, opts);
  if (arm === 'prio-tuned') return (m) => evictByPriorityRatio(m, W, { rho: RHO, directed: false }, opts);
  if (arm === 'random') { const rng = makeRng(3000 + repeat); return (m) => evictByRandom(m, W, rng, opts); }
  throw new Error(`unknown arm ${arm}`);
}

/**
 * CONTINUOUS PRIMARY ENDPOINT. `task.grade()` writes the held-out suite into the
 * workspace and returns a boolean; re-running that same file with `-v` and counting
 * individual outcomes turns it into a fraction WITHOUT touching the task module, the
 * agent, or anything the agent ever sees. A run whose modules do not import at all
 * yields `tests_total = 0` and a fraction of 0 — which `writes` then distinguishes from
 * a run that merely scored badly.
 */
export function gradeContinuous(task, ws) {
  let pass = false;
  try { pass = task.grade(ws); } catch { pass = false; }
  let out = '';
  try {
    out = execSync('python3 -m unittest hidden_grade_test -v 2>&1', {
      cwd: ws, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
  } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  const ran = +((out.match(/Ran\s+(\d+)\s+test/) || [])[1] ?? 0);
  const bad = (out.match(/^(FAIL|ERROR):/gm) || []).length;
  const passed = Math.max(0, ran - bad);
  return { pass, tests_total: ran, tests_passed: passed, pass_fraction: ran > 0 ? passed / ran : 0 };
}

/**
 * SECONDARY CONTINUOUS ENDPOINT that survives a non-importable workspace: how many of
 * the task's six deliverables exist with real content. It is a filesystem check, so a
 * run that wrote four working modules and then broke the fifth is not scored the same
 * as one that never started.
 */
const DELIVERABLES = ['money.py', 'parsing.py', 'rules.py', 'report.py', 'cli.py', 'SUMMARY.md'];
export function artifactProgress(ws) {
  let n = 0;
  for (const f of DELIVERABLES) {
    const p = join(ws, f);
    if (!existsSync(p)) continue;
    try { if (readFileSync(p, 'utf8').trim().length > 120) n += 1; } catch { /* unreadable counts as absent */ }
  }
  return { deliverables_present: n, deliverables_total: DELIVERABLES.length, progress: n / DELIVERABLES.length };
}

async function runCell(task, arm, W, repeat) {
  const ws = makeWorkspace();
  task.seed(ws);
  const refLogger = makeRefLogger();
  const evict = evictorFor(arm, W, repeat, refLogger);

  const t = { peak: 0, peakPre: 0, evictions: 0, capViolations: 0, keptSum: 0, keptN: 0, keptLast: null };
  const hook = async (m) => {
    refLogger.observe(m);                       // BEFORE eviction: the log must see everything
    t.peakPre = Math.max(t.peakPre, estTokens(m));
    const r = isCapped(arm) ? evict(m) : NOOP;
    if (r.changed) t.evictions += 1;
    if (r.capViolated) t.capViolations += 1;
    if (r.kept !== null) { t.keptSum += r.kept; t.keptN += 1; t.keptLast = r.kept; }
    t.peak = Math.max(t.peak, estTokens(m));    // sampled AFTER eviction = what is sent
  };

  let err = null, r = null;
  const t0 = Date.now();
  try {
    r = await runAgent({ system: task.system, task: task.task, ws, maxTurns: MAX_TURNS, think: false, hook, allowedTools: task.allowedTools ?? null });
  } catch (e) { err = String(e.message || e).slice(0, 200); }

  const grade = gradeContinuous(task, ws);
  const progress = artifactProgress(ws);
  const reads = r ? r.toolLog.filter((x) => x.name === 'read_file') : [];
  const distinct = new Set(reads.map((x) => x.args?.path).filter(Boolean)).size;
  const writeCalls = r ? r.toolLog.filter((x) => /write_file|edit_file/.test(x.name)) : [];

  return {
    arm, window: isCapped(arm) ? W : null, repeat,
    // PRIMARY (continuous) and its binary shadow
    pass_fraction: +grade.pass_fraction.toFixed(4),
    tests_passed: grade.tests_passed, tests_total: grade.tests_total, pass: grade.pass,
    // SECONDARY continuous endpoints
    artifact_progress: +progress.progress.toFixed(4),
    deliverables_present: progress.deliverables_present,
    turns_to_first_write: writeCalls.length ? writeCalls[0].turn : null,
    writes: writeCalls.length,
    turns: r?.turns ?? null, stop: r?.stop ?? 'error',
    reads: reads.length, rereads: Math.max(0, reads.length - distinct),
    // the covariate every model must adjust for, plus the volume-matching evidence
    peak_history_tokens: t.peak, peak_before_evict: t.peakPre,
    units_kept_mean: t.keptN ? +(t.keptSum / t.keptN).toFixed(2) : null,
    units_kept_last: t.keptLast,
    evictions: t.evictions, cap_violations: t.capViolations,
    ref_log_turns: refLogger.log.length,
    ref_log_distinct_files: new Set(refLogger.log.flatMap((s) => [...s])).size,
    total_prompt_tokens: r ? r.usage.reduce((s, u) => s + (u.prompt_tokens || 0), 0) : 0,
    wall_seconds: Math.round((Date.now() - t0) / 1000), error: err,
  };
}

const med = (xs) => { const s = [...xs].filter((x) => x !== null).sort((a, b) => a - b); if (!s.length) return null; return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mean = (xs) => { const s = xs.filter((x) => x !== null && Number.isFinite(x)); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
const sd = (xs) => { const s = xs.filter((x) => x !== null && Number.isFinite(x)); if (s.length < 2) return null; const m = mean(s); return Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / (s.length - 1)); };

/**
 * Welch's t comes from `metrics.mjs` — an EXACT Student-t tail with
 * Welch-Satterthwaite df. An earlier version here used a normal approximation, which at
 * n=12 per arm (df ~ 22) reports p = 0.038 where the t distribution gives p = 0.050 —
 * i.e. it crossed the pre-registered alpha = 0.05 boundary in the permissive direction
 * on exactly the design's own operating point.
 */

async function main() {
  if (process.env.CT_COV_LIVE !== '1') {
    console.error([
      'REFUSING TO RUN. This is a live GPU experiment and it is gated.',
      '',
      'Backlog item 0 (instrument sensitivity) is VOID, not resolved: its control arm wrote',
      'zero files in 10 of 10 runs, so it measured a derailed agent rather than a floor. Five',
      'previous live runs that varied WHICH context is kept returned null or void. Running this',
      'before the gate resolves produces a sixth uninterpretable null at ~5 minutes per cell.',
      '',
      'The falsifiable work today is offline:  node experiments/covariance-eviction/offline-replay.mjs',
      '',
      'If the gate has resolved, or you are deliberately running a pilot, set CT_COV_LIVE=1.',
    ].join('\n'));
    process.exit(2);
  }

  const task = (await import(join(HERE, '..', 'context-dedup', 'ab-tasks', `${TASK_NAME}.mjs`))).default;
  const cells = [];
  for (let rep = 0; rep < REPEATS; rep++) {
    for (const W of WINDOWS) for (const arm of ARMS) {
      console.error(`\n--- rep${rep} W=${W} ${arm} ---`);
      const c = await runCell(task, arm, W, rep); cells.push(c);
      console.error(`    -> frac=${c.pass_fraction} (${c.tests_passed}/${c.tests_total}) prog=${c.artifact_progress} `
        + `writes=${c.writes} evict=${c.evictions} peak=${c.peak_history_tokens} kept~${c.units_kept_mean}${c.error ? ' ERR=' + c.error : ''}`);
    }
  }

  const groups = new Map();
  for (const c of cells) {
    const k = `${c.arm}@${c.window ?? 'inf'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const summary = [...groups.entries()].map(([k, cs]) => {
    const passes = cs.filter((c) => c.pass).length;
    const [lo, hi] = wilson(passes, cs.length);
    return {
      cell: k, n: cs.length,
      pass_fraction_mean: +mean(cs.map((c) => c.pass_fraction)).toFixed(4),
      pass_fraction_sd: sd(cs.map((c) => c.pass_fraction)) === null ? null : +sd(cs.map((c) => c.pass_fraction)).toFixed(4),
      artifact_progress_mean: +mean(cs.map((c) => c.artifact_progress)).toFixed(4),
      binary_passes: `${passes}/${cs.length}`, binary_ci95: [+(lo * 100).toFixed(0), +(hi * 100).toFixed(0)],
      writes_median: med(cs.map((c) => c.writes)),
      turns_to_first_write_median: med(cs.map((c) => c.turns_to_first_write)),
      rereads_median: med(cs.map((c) => c.rereads)),
      evictions_median: med(cs.map((c) => c.evictions)),
      peak_median: med(cs.map((c) => c.peak_history_tokens)),
      units_kept_mean: +mean(cs.map((c) => c.units_kept_mean) ?? 0).toFixed(2),
      total_tokens_median: med(cs.map((c) => c.total_prompt_tokens)),
      cap_violations_total: cs.reduce((s, c) => s + c.cap_violations, 0),
      errors_total: cs.filter((c) => c.error).length,
      no_write_cells: cs.filter((c) => c.writes === 0).length,
    };
  });

  const get = (arm, W) => cells.filter((c) => c.arm === arm && (isCapped(arm) ? c.window === W : c.window === null));
  // ONE pre-registered primary contrast; everything else is secondary and Holm-corrected
  // across the family. An earlier version pre-registered Holm in both design documents,
  // implemented it nowhere, and emitted five raw p-values.
  const PRIMARY = ['tcov', 'truncate-tail'];
  const FAMILY = [['tcov', 'truncate-tail'], ['tcov', 'idle'], ['prio-tuned', 'prio-shipped'],
    ['truncate-tail', 'random'], ['tcov', 'random']];
  let tests = [];
  for (const W of WINDOWS) {
    for (const [tn, cn] of FAMILY) {
      const A = get(tn, W), B = get(cn, W);
      if (!A.length || !B.length) continue;
      const primary = welchT(A.map((c) => c.pass_fraction), B.map((c) => c.pass_fraction));
      const peakA = med(A.map((c) => c.peak_history_tokens)), peakB = med(B.map((c) => c.peak_history_tokens));
      const keptA = mean(A.map((c) => c.units_kept_mean)) ?? 0, keptB = mean(B.map((c) => c.units_kept_mean)) ?? 0;
      tests.push({
        window: W, treatment: tn, control: cn, n: [A.length, B.length],
        is_primary: tn === PRIMARY[0] && cn === PRIMARY[1],
        primary_pass_fraction: primary,
        p: primary?.p ?? null,
        secondary_artifact_progress: welchT(A.map((c) => c.artifact_progress), B.map((c) => c.artifact_progress)),
        // THE VOLUME-MATCHING AUDIT. Matching is on TOKENS — `evictToBudget` packs to a
        // token budget — so equal peaks do NOT imply equal unit counts, and on a buffer
        // with uneven unit sizes they can diverge substantially. Both are reported and
        // both are gated below.
        peak_delta_median: peakA - peakB,
        peak_delta_pct: peakB ? +Math.abs((peakA - peakB) / peakB).toFixed(4) : null,
        units_kept_delta: +(keptA - keptB).toFixed(2),
        units_kept_delta_pct: keptB ? +Math.abs((keptA - keptB) / keptB).toFixed(4) : null,
      });
    }
  }
  tests = holm(tests, 0.05, 'p');

  const cap = (arm, W) => summary.find((s) => s.cell === `${arm}@${W}`);
  const validity = WINDOWS.map((W) => {
    const rnd = cap('random', W);
    const inc = cap('truncate-tail', W);
    const capped = summary.filter((s) => s.cell.endsWith(`@${W}`));
    const peaks = capped.map((s) => s.peak_median).filter((x) => x !== null);
    const spread = peaks.length ? (Math.max(...peaks) - Math.min(...peaks)) / Math.max(...peaks) : null;
    if (!rnd || !inc) {
      return { window: W, interpretable: null, reason: `validity arms absent from this run (ARMS=${ARMS.join(',')})` };
    }
    const attempts = rnd.n - rnd.no_write_cells;
    const conds = {
      // (i) the control must still be DOING the task — the condition that voided item 0
      control_still_attempts_task: attempts >= 0.5 * rnd.n,
      // (ii) room to lose: the incumbent must not already be at the ceiling on the
      //      continuous endpoint, or no arm can show an improvement
      incumbent_not_at_ceiling: inc.pass_fraction_mean < 0.95,
      // (iii) room to win: the incumbent must not be at the floor either
      incumbent_not_at_floor: inc.pass_fraction_mean > 0.05,
      // (iv) VOLUME-MATCHING actually achieved, not merely intended — on BOTH axes.
      //      `evictToBudget` packs to a TOKEN budget, so matched peaks do not imply
      //      matched unit counts: on a buffer where the units a signal prefers are
      //      systematically larger, arms can match to ~2% on tokens and still differ by
      //      ~1.8x in units kept. A difference in unit count is a difference in how many
      //      distinct pieces of history survive, which is part of what is under test.
      achieved_peaks_within_10pct: spread !== null && spread <= 0.10,
      units_kept_within_10pct: (() => {
        const ks = capped.map((x) => x.units_kept_mean).filter((x) => x !== null && Number.isFinite(x) && x > 0);
        if (ks.length < 2) return null;
        return (Math.max(...ks) - Math.min(...ks)) / Math.max(...ks) <= 0.10;
      })(),
      // (v) the cap was enforced every turn
      no_cap_violations: capped.every((s) => s.cap_violations_total === 0),
    };
    return {
      window: W, ...conds,
      control_cells_that_attempted: `${attempts}/${rnd.n}`,
      achieved_peak_spread: spread === null ? null : +spread.toFixed(3),
      units_kept_spread: (() => {
        const ks = capped.map((x) => x.units_kept_mean).filter((x) => x !== null && Number.isFinite(x) && x > 0);
        return ks.length < 2 ? null : +((Math.max(...ks) - Math.min(...ks)) / Math.max(...ks)).toFixed(3);
      })(),
      interpretable: Object.values(conds).every((v) => v === true),
      reason: Object.entries(conds).filter(([, v]) => !v).map(([k]) => k).join(', ') || null,
    };
  });

  const out = {
    manifest: {
      run_id: `covariance-live-${TAG}-${Date.now()}`,
      experiment: 'covariance-eviction / live A/B (H1 recurrence ratio, H2 temporal covariance)',
      model: MODEL, task: task.name, windows: WINDOWS, repeats: REPEATS, arms: ARMS,
      max_turns: MAX_TURNS, anchor: ANCHOR, cadence: 1,
      params: { alpha: ALPHA, rho: RHO, cov: COV_PARAMS },
      commit: gitSha(), date: nowISO(),
      multiplicity: 'ONE pre-registered primary contrast (tcov vs truncate-tail on pass fraction); the five-contrast family is Holm-corrected (`p_holm`, `reject_holm`). Raw p is reported alongside but is not the decision rule.',
      primary_endpoint: 'held-out suite PASS FRACTION (continuous). The binary pass is reported as a secondary because it has returned null four times running and once discarded a real 0 -> 7 improvement in files written.',
      falsification: 'H2 REJECTED if the tcov arm does not beat BOTH truncate-tail and idle on mean pass fraction at p < 0.05 (Welch) with achieved peaks matched to within 10%. H1 REJECTED if prio-tuned does not beat prio-shipped on the same terms. Either contrast is VOID, not null, if any validity condition fails.',
      gate: 'Backlog item 0 (instrument sensitivity) is VOID. This run is interpretable only if that gate has since fired; otherwise a null here is uninformative, exactly like the four before it.',
      caveats: [
        'C0: one problem (`longbuild`), so this is n repeats of one task, not n tasks. Between-problem variance is the larger term in agentic coding and is not measured here.',
        'alpha and rho must come from the offline sweep. Running this with the built-in endpoint defaults probes the ends of both sweeps, which is a pilot, not the test.',
        'The reference log is built from tool-call arguments, including a regex over `run_bash` command lines. It is the same extractor the offline arm uses, and it is the least trustworthy input in either.',
        'tcov degrades to positional recency when the reference log is empty or unsupported, so the early turns of every cell are incumbent behaviour. That makes the arm conservative and shrinks the effect it can show.',
        'pass_fraction is computed by re-running the held-out suite; a workspace whose modules fail to import scores 0 with tests_total 0. `writes` and `artifact_progress` separate that from a genuinely poor run.',
        'errors_total counts cells that threw (HTTP/timeout). They are scored as failures; treat an arm with errors_total > 0 with care.',
      ],
    }, summary, tests, validity, cells,
  };
  const path = writeResults('covariance-eviction', `results-live-${TAG}.json`, out);

  console.error(`\n=== COVARIANCE LIVE A/B [${task.name}] model=${MODEL} n=${REPEATS} ===`);
  console.error('  cell                    n   frac    prog   bin    peak   kept   wr  nowr  evict');
  for (const s of summary) {
    console.error(`  ${s.cell.padEnd(22)} ${String(s.n).padStart(2)}  ${String(s.pass_fraction_mean).padStart(6)}  `
      + `${String(s.artifact_progress_mean).padStart(5)}  ${s.binary_passes.padStart(5)}  ${String(s.peak_median).padStart(6)}  `
      + `${String(s.units_kept_mean).padStart(5)}  ${String(s.writes_median).padStart(3)}  ${String(s.no_write_cells).padStart(4)}  ${s.evictions_median}`);
  }
  console.error('\n  contrasts on the CONTINUOUS primary (Welch t, Holm-corrected), with the volume-matching audit:');
  for (const t of tests) {
    const p = t.primary_pass_fraction;
    console.error(`    ${t.is_primary ? '*' : ' '}${t.treatment.padEnd(14)} vs ${t.control.padEnd(14)} delta=${String(p?.delta).padStart(8)} `
      + `t=${String(p?.t).padStart(6)} df=${String(p?.df).padStart(5)} p=${String(p?.p).padStart(7)} p_holm=${String(t.p_holm).padStart(7)}   `
      + `peak ${t.peak_delta_pct === null ? 'n/a' : (t.peak_delta_pct * 100).toFixed(1) + '%'}  units ${t.units_kept_delta_pct === null ? 'n/a' : (t.units_kept_delta_pct * 100).toFixed(1) + '%'}`);
  }
  console.error('\n  validity:');
  for (const v of validity) {
    console.error(`    W=${v.window} -> ${v.interpretable === null ? 'NOT EVALUABLE' : v.interpretable ? 'INTERPRETABLE' : `DO NOT INTERPRET — ${v.reason}`}`);
  }
  console.error(`  written: ${path}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('FATAL', e); process.exit(1); });
}
