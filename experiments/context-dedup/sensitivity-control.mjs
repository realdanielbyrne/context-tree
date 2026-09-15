/**
 * INSTRUMENT-SENSITIVITY POSITIVE CONTROL — can this harness detect selection
 * quality AT ALL?
 *
 * THE PROBLEM. Every live result that varies WHICH context is kept has come back
 * null on this substrate:
 *     selection signal (arm)              p = 0.70
 *     reference vs positional recency     p = 1.000   (n=13, backlog item 8)
 *     needle position in context          180/180     (report-position-probe)
 *     eviction cadence | achieved peak    p = 0.54    (78 cells, arm-adjusted)
 * The only variable that has ever moved task success is ACHIEVED PEAK — how many
 * tokens of context are present — at OR 42x per e-fold. Two readings of that are
 * observationally identical:
 *     (a) selection genuinely does not matter on `longbuild`; or
 *     (b) the harness cannot SEE selection quality, making every null above
 *         uninformative rather than negative.
 * Reading (b) would mean four reported findings are measurement artifacts and
 * that backlog items 1, 2, 6 and 7 are unrunnable as designed. This is a GATE,
 * not a study.
 *
 * THE MANIPULATION (see `ballast.mjs` for why it is this and not something more
 * obvious). Duplicate reads of files the agent has already read are injected on a
 * schedule. A byte-identical copy of resident content is provably zero-
 * information, so a policy that drops it loses nothing and gains budget. Two
 * earlier designs — fabricated reads of unrelated files, then the same material
 * as a user paste — both DERAILED the agent instead of merely taxing it, and
 * were discarded after pilots.
 *
 * ARMS. All capped arms share one budget, one anchor and one reserve, and differ
 * only in sacrifice order, so they are volume-matched by construction.
 *     oracle          drops superseded duplicates first      CEILING
 *     truncate-tail   positional recency (what harnesses do) incumbent
 *     idle            reference recency (our signal)         candidate
 *     random          no signal                              FLOOR
 * plus references that pin down the mechanism and the operating point:
 *     clean           capped, no ballast      what the cap costs on its own
 *     uncapped-ballast / uncapped-clean       the pair that separates
 *                     DISPLACEMENT from DISTRACTION; neither alone can.
 *
 * Because the label is exact and computable, `oracle` is ALSO a shippable policy
 * (the naive dedup rule this project has circled since DV1) — so a win here is a
 * result, not only a calibration.
 *
 * ⚠️ **KNOWN LIMIT OF THIS DESIGN — read before interpreting any result.** Adversarial
 * review established that the oracle's advantage flows through exactly one channel:
 * USEFUL-TOKEN VOLUME. Measured, oracle holds ~4,255 useful tokens against random's
 * ~1,557 — `ln(4255/1557) = 1.005`, a one e-fold manipulation of the very quantity
 * already known to drive this task at OR 42x per e-fold. So `oracle > random` is
 * PREDICTED BY THE ESTABLISHED VOLUME LAW ALONE, at almost any n.
 *
 * What that costs us: the four nulls this was built to adjudicate were all measured at
 * MATCHED useful volume (no ballast existed, so kept == useful in every arm). A control
 * that only moves useful volume therefore CANNOT show whether the harness sees selection
 * *at matched volume*. A win here licenses only the weaker claim — "the outcome metric
 * responds when a policy keeps a better subset" — which still separates "metric blind"
 * from "not blind", but does NOT license "the four nulls stand as real findings".
 *
 * Also unresolved: at this ballast dose every control arm (random, truncate-tail, idle)
 * fell to ZERO file writes, the same signature that killed ballast designs v1 and v2, and
 * the `uncapped-ballast`/`uncapped-clean` pair that would separate displacement from
 * distraction has not been run. Until it is, a win is confounded with derailment.
 *
 * PRE-REGISTERED, WITH ITS VALIDITY CONDITIONS STATED UP FRONT.
 *   Primary:   oracle > random, one-sided Fisher, alpha = 0.05.
 *   Valid only if (i) `clean` is NOT at the floor — the operating point must
 *     leave room to lose — and (ii) `random` <= 0.4n, so there is room to win.
 *     If either fails the run is an operating-point miss, NOT evidence about the
 *     instrument, and must be re-run at a different W rather than interpreted.
 *   Secondary (continuous, reported regardless because the binary endpoint is
 *     weak at this n): turns-to-DONE, re-reads, and mean resident USEFUL tokens.
 *   If the primary fires: the outcome metric DOES respond when a policy keeps a
 *     better subset, so it is not blind — but see the KNOWN LIMIT above: this does
 *     NOT license 'the four nulls stand'. Dedup becomes a live candidate policy.
 *   If it does not fire AND the validity conditions hold: the metric cannot see
 *     even a one-e-fold improvement in useful context. That is a strong indictment
 *     of the instrument — state the four nulls as UNINFORMATIVE and redesign items
 *     1/2/6/7 before running them.
 *
 * POWER — stated before the run, not after. At n=10/arm a one-sided Fisher needs
 * (control 0/10 -> treatment 4/10), (1/10 -> 6/10), (2/10 -> 7/10), (3/10 ->
 * 8/10), (4/10 -> 9/10); at control >= 7/10 no treatment count can reach 0.05.
 * `minDetectable` prints this for the observed control rate so the reader can
 * see what the design could and could not have found.
 *
 * LIVE. Rerun:
 *   set -a; . ./.env; set +a
 *   CT_WINDOWS=7000 CT_REPEATS=10 CT_BALLAST_EVERY=2 CT_BALLAST_BURST=2 \
 *     node experiments/context-dedup/sensitivity-control.mjs
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runAgent, makeWorkspace, estTokens, extractUnits, MODEL } from '../coding-harness/lib.mjs';
import { evictByRecency, evictByRandom, evictByIdle, evictByOracle, makeRng } from './policies.mjs';
import { makeBallastInjector, makeSupersededLabel, NO_BALLAST } from './ballast.mjs';
import { fisherOneSided, wilson, minDetectable } from './stats.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOWS = (process.env.CT_WINDOWS || '7000').split(',').map(Number);
const REPEATS = +(process.env.CT_REPEATS || 10);
const MAX_TURNS = +(process.env.CT_MAX_TURNS || 60);
const ANCHOR = +(process.env.CT_ANCHOR || 4);
const TASK_NAME = process.env.CT_TASK || 'longbuild';
const TAG = process.env.CT_TAG || 'sens';
const ARMS = (process.env.CT_ARMS || 'oracle,truncate-tail,idle,random,clean,uncapped-ballast,uncapped-clean').split(',');
const BALLAST_EVERY = +(process.env.CT_BALLAST_EVERY || 2);
const BALLAST_BURST = +(process.env.CT_BALLAST_BURST || 2);
/** Ignore the first few turns when averaging junk share: before the agent has read
 *  anything the buffer is trivially 0% or 100% junk and says nothing about steady state. */
const WARMUP_TURNS = +(process.env.CT_WARMUP || 5);

const NOOP = { changed: false, kept: null, evicted: 0, capViolated: false };
const hasBallast = (arm) => arm !== 'clean' && arm !== 'uncapped-clean';
const isCapped = (arm) => arm !== 'uncapped-ballast' && arm !== 'uncapped-clean';

function evictorFor(arm, W, repeat, isJunk) {
  const opts = { anchor: ANCHOR };
  if (!isCapped(arm)) return () => NOOP;
  if (arm === 'oracle') return (m) => evictByOracle(m, W, isJunk, opts);
  if (arm === 'truncate-tail' || arm === 'clean') return (m) => evictByRecency(m, W, opts);
  if (arm === 'idle') return (m) => evictByIdle(m, W, opts);
  if (arm === 'random') { const rng = makeRng(2000 + repeat); return (m) => evictByRandom(m, W, rng, opts); }
  throw new Error(`unknown arm ${arm}`);
}

/**
 * Split what is ACTUALLY SENT into useful and junk tokens. Recorded per turn
 * because mean resident USEFUL tokens is the covariate that has to be controlled
 * for — controlling for it is exactly what killed the cadence result, and a
 * peak-plus-mean-of-ratios cannot reconstruct it after the fact.
 */
function residency(messages) {
  const { units } = extractUnits(messages);
  const label = makeSupersededLabel();
  let junk = 0, useful = 0, junkUnits = 0;
  units.forEach((u, i) => {
    const t = estTokens(u.slice);
    if (label(u, i, units)) { junk += t; junkUnits += 1; } else useful += t;
  });
  return { junk, useful, junkUnits, units: units.length };
}

async function runCell(task, arm, W, repeat) {
  const ws = makeWorkspace();
  task.seed(ws);                       // workspace is IDENTICAL in every arm
  const inject = hasBallast(arm)
    ? makeBallastInjector({ every: BALLAST_EVERY, burst: BALLAST_BURST })
    : () => 0;
  const isJunk = hasBallast(arm) ? makeSupersededLabel() : NO_BALLAST;
  const evict = evictorFor(arm, W, repeat, isJunk);

  const t = {
    peak: 0, peakPre: 0, evictions: 0, capViolations: 0, injected: 0, keptLast: null,
    usefulSum: 0, junkSum: 0, samples: 0, usefulPeak: 0, anchorJunk: 0,
  };
  const hook = async (m, turn) => {
    t.injected += inject(m, turn);                 // ballast enters BEFORE eviction sees it
    t.peakPre = Math.max(t.peakPre, estTokens(m));
    const r = isCapped(arm) ? evict(m) : NOOP;
    if (r.changed) t.evictions += 1;
    if (r.capViolated) t.capViolations += 1;
    t.keptLast = r.kept;
    t.peak = Math.max(t.peak, estTokens(m));
    if (turn >= WARMUP_TURNS) {
      const res = residency(m);
      t.usefulSum += res.useful; t.junkSum += res.junk; t.samples += 1;
      t.usefulPeak = Math.max(t.usefulPeak, res.useful);
      t.anchorJunk += res.junkUnits;
    }
  };

  let err = null, r = null;
  const t0 = Date.now();
  try {
    r = await runAgent({ system: task.system, task: task.task, ws, maxTurns: MAX_TURNS, think: false, hook, allowedTools: task.allowedTools ?? null });
  } catch (e) { err = String(e.message || e).slice(0, 200); }
  let pass = false;
  try { pass = task.grade(ws); } catch { pass = false; }

  const reads = r ? r.toolLog.filter((x) => x.name === 'read_file') : [];
  const distinct = new Set(reads.map((x) => x.args?.path).filter(Boolean)).size;
  const writes = r ? r.toolLog.filter((x) => /write_file|edit_file/.test(x.name)).length : 0;
  const n = Math.max(1, t.samples);
  return {
    arm, window: isCapped(arm) ? W : null, repeat, pass,
    turns: r?.turns ?? null, stop: r?.stop ?? 'error',
    evictions: t.evictions, cap_violations: t.capViolations, units_kept_last: t.keptLast,
    ballast_injected: t.injected,
    useful_tokens_mean: Math.round(t.usefulSum / n),      // the decisive covariate
    junk_tokens_mean: Math.round(t.junkSum / n),
    useful_peak: t.usefulPeak,
    junk_share_mean: +(t.junkSum / Math.max(1, t.usefulSum + t.junkSum)).toFixed(4),  // token-weighted
    reads: reads.length, rereads: Math.max(0, reads.length - distinct), writes,
    peak_history_tokens: t.peak, peak_before_evict: t.peakPre,
    total_prompt_tokens: r ? r.usage.reduce((s, u) => s + (u.prompt_tokens || 0), 0) : 0,
    wall_seconds: Math.round((Date.now() - t0) / 1000), error: err,
  };
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

async function main() {
  const task = (await import(join(HERE, 'ab-tasks', `${TASK_NAME}.mjs`))).default;
  const cells = [];
  for (let rep = 0; rep < REPEATS; rep++) {
    for (const W of WINDOWS) for (const arm of ARMS) {
      console.error(`\n--- rep${rep} W=${W} ${arm} ---`);
      const c = await runCell(task, arm, W, rep); cells.push(c);
      console.error(`    -> ${c.pass ? 'PASS' : 'FAIL'} turns=${c.turns} writes=${c.writes} evict=${c.evictions} peak=${c.peak_history_tokens} useful=${c.useful_tokens_mean} junk%=${(c.junk_share_mean * 100).toFixed(0)} tok=${c.total_prompt_tokens}${c.error ? ' ERR=' + c.error : ''}`);
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
      cell: k, n: cs.length, passes, pass_rate: passes / cs.length,
      ci95: [+(lo * 100).toFixed(0), +(hi * 100).toFixed(0)],
      turns_median: med(cs.map((c) => c.turns ?? MAX_TURNS)),
      writes_median: med(cs.map((c) => c.writes)),
      rereads_median: med(cs.map((c) => c.rereads)),
      evictions_median: med(cs.map((c) => c.evictions)),
      peak_median: med(cs.map((c) => c.peak_history_tokens)),
      useful_tokens_median: med(cs.map((c) => c.useful_tokens_mean)),
      junk_share_median: +med(cs.map((c) => c.junk_share_mean)).toFixed(4),
      total_tokens_median: med(cs.map((c) => c.total_prompt_tokens)),
      cap_violations_total: cs.reduce((s, c) => s + c.cap_violations, 0),
      errors_total: cs.filter((c) => c.error).length,
      // a cell that never wrote a file did not attempt the task — the failure mode
      // that killed ballast designs v1 and v2, surfaced rather than buried
      no_write_cells: cs.filter((c) => c.writes === 0).length,
    };
  });

  const tests = [];
  for (const W of WINDOWS) {
    const get = (arm) => cells.filter((c) => c.arm === arm && (isCapped(arm) ? c.window === W : c.window === null));
    const pair = (tName, cName) => {
      const A = get(tName), B = get(cName);
      if (!A.length || !B.length) return null;
      const a = A.filter((c) => c.pass).length, b = A.length - a;
      const c2 = B.filter((c) => c.pass).length, d = B.length - c2;
      return {
        window: W, treatment: tName, control: cName,
        treatment_passes: `${a}/${A.length}`, control_passes: `${c2}/${B.length}`,
        p_one_sided: +fisherOneSided(a, b, c2, d).toFixed(4),
        min_detectable_treatment_passes: minDetectable(A.length, c2),
      };
    };
    for (const [tn, cn] of [['oracle', 'random'], ['truncate-tail', 'random'], ['idle', 'random'], ['oracle', 'truncate-tail']]) {
      const r = pair(tn, cn); if (r) tests.push(r);
    }
  }

  // validity, decided by the rule stated in the header rather than after the fact
  const cap = (arm, W) => summary.find((s) => s.cell === `${arm}@${W}`);
  // "arm absent from this run" must NOT be recorded as "validity failed" — a split run
  // would otherwise bake a false OPERATING-POINT MISS verdict into its own artifact.
  const validity = WINDOWS.map((W) => {
    const clean = cap('clean', W), rnd = cap('random', W);
    if (!clean || !rnd) {
      return { window: W, clean: clean ? `${clean.passes}/${clean.n}` : null,
        random: rnd ? `${rnd.passes}/${rnd.n}` : null,
        clean_not_at_floor: null, random_has_headroom: null,
        interpretable: null, reason: `validity arms not present in this run (ARMS=${ARMS.join(',')}); combine with the run that has them` };
    }
    const cleanOk = clean.passes > 0;
    const randomOk = rnd.passes <= 0.4 * rnd.n;
    // ADDED AFTER THE FIRST REAL RUN, which satisfied both conditions above and was
    // still worthless: random went 0/10 with 10/10 cells writing ZERO files. An arm
    // that never attempts the task is not a floor, it is a derailed agent, and a
    // contrast against it says nothing about the metric's sensitivity. A control must
    // still be DOING THE TASK for its failures to mean anything.
    const controlAttempts = rnd.n - rnd.no_write_cells;
    const attemptOk = controlAttempts >= 0.5 * rnd.n;
    return { window: W, clean: `${clean.passes}/${clean.n}`, random: `${rnd.passes}/${rnd.n}`,
      control_cells_that_attempted: `${controlAttempts}/${rnd.n}`,
      clean_not_at_floor: cleanOk, random_has_headroom: randomOk, control_still_attempts_task: attemptOk,
      interpretable: cleanOk && randomOk && attemptOk,
      ...(attemptOk ? {} : { reason: 'the control arm stopped attempting the task (zero file writes) — this is derailment, not a performance floor; reduce the ballast dose and re-run' }) };
  });
  // A run that does not contain every arm the pre-registration names cannot evaluate it.
  const FULL_ARMS = ['oracle', 'truncate-tail', 'idle', 'random', 'clean'];
  const missingArms = FULL_ARMS.filter((a) => !ARMS.includes(a));

  const out = {
    manifest: {
      run_id: `sensitivity-control-${TASK_NAME}-${Date.now()}`,
      experiment: 'context-dedup / instrument-sensitivity positive control (duplicate ballast)',
      model: MODEL, task: task.name, windows: WINDOWS, repeats: REPEATS, arms: ARMS,
      max_turns: MAX_TURNS, anchor: ANCHOR, warmup_turns: WARMUP_TURNS,
      ballast: { kind: 'duplicate re-reads of already-read task files', every_turns: BALLAST_EVERY, burst: BALLAST_BURST },
      commit: gitSha(), date: nowISO(),
      partial_run: missingArms.length ? { missing_arms: missingArms, note: 'This file CANNOT evaluate the pre-registration on its own — combine with the run(s) carrying the missing arms and recompute summary/tests/validity.' } : null,
      known_limit: 'The oracle-vs-random contrast flows entirely through USEFUL-TOKEN VOLUME (~4255 vs ~1557 tokens = 1.0 e-fold), the quantity already known to drive this task at OR 42x per e-fold. A win therefore licenses only "the metric responds when a policy keeps a better subset" — NOT "the four selection nulls stand", which were measured at matched useful volume.',
      question: 'Can this harness detect selection quality at all? If a policy that drops provably zero-information units cannot beat a volume-matched random control, the harness is blind and every previous selection null is uninformative rather than negative.',
      falsification: 'PRIMARY: oracle > random at one-sided Fisher p<0.05. Interpretable ONLY if clean is not at the floor AND random <= 0.4n; otherwise the run is an operating-point miss and must be re-run at a different W, not interpreted. If the primary does not fire while validity holds: withdraw the arm/idle/position/cadence nulls as evidence of no effect and redesign backlog items 1, 2, 6, 7.',
      caveats: [
        'The oracle label is exact by construction (byte-identical superseded reads). It is therefore also IMPLEMENTABLE — this arm is both a sensitivity ceiling and a candidate dedup policy.',
        'Duplicate ballast is the EASY version of selection: real irrelevance is confusable, exact duplication is not. A null here is damning; a win here is only a ceiling.',
        'Two earlier ballast designs (foreign tool results; foreign user pastes) DERAILED the agent — it stopped writing files entirely. no_write_cells is reported so that failure mode is visible rather than scored as a task failure.',
        'C0 still applies: one problem (longbuild), so this measures within-problem sensitivity only.',
        'Binary grading is weak at n=10; min_detectable_treatment_passes states what the design could have found, and continuous secondaries are reported alongside.',
        'errors_total counts cells that threw (HTTP/timeout). They are scored as failures; treat an arm with errors_total>0 with care.',
      ],
    }, summary, tests, validity, cells,
  };
  const path = writeResults('context-dedup', `results-${TAG}.json`, out);

  console.error(`\n=== SENSITIVITY CONTROL [${task.name}] model=${MODEL} n=${REPEATS} ===`);
  console.error('  cell                        n  pass   peak  useful  junk%  evict  wr  err  nowr  tokens');
  for (const s of summary) {
    console.error(`  ${s.cell.padEnd(26)} ${s.n}  ${s.passes}/${s.n}  ${String(s.peak_median).padStart(5)}  ${String(s.useful_tokens_median).padStart(6)}  ${(s.junk_share_median * 100).toFixed(0).padStart(4)}%  ${String(s.evictions_median).padStart(5)}  ${String(s.writes_median).padStart(2)}  ${String(s.errors_total).padStart(3)}  ${String(s.no_write_cells).padStart(4)}  ${s.total_tokens_median}`);
  }
  console.error('\n  pre-registered tests (one-sided Fisher):');
  for (const t of tests) {
    console.error(`    W=${t.window}  ${t.treatment.padEnd(14)} ${t.treatment_passes.padStart(6)}  vs ${t.control.padEnd(14)} ${t.control_passes.padStart(6)}   p=${t.p_one_sided}   (needed >= ${t.min_detectable_treatment_passes ?? 'IMPOSSIBLE'})`);
  }
  console.error('\n  validity:');
  for (const v of validity) {
    const verdict = v.interpretable === null ? `NOT EVALUABLE HERE (${v.reason})`
      : v.interpretable ? 'INTERPRETABLE'
      : `DO NOT INTERPRET — ${v.reason ?? 'operating-point miss'}`;
    console.error(`    W=${v.window}  clean=${v.clean} random=${v.random} attempted=${v.control_cells_that_attempted ?? 'n/a'}  -> ${verdict}`);
  }
  if (missingArms.length) console.error(`  PARTIAL RUN — missing arms: ${missingArms.join(', ')}; the pre-registration cannot be evaluated from this file alone.`);
  console.error(`  written: ${path}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('FATAL', e); process.exit(1); });
}
