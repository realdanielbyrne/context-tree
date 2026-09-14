/**
 * A/B WINDOW-CAP SWEEP (v2) — one model, one substrate, sweep the artificial cap.
 *
 * Design: ONE model (Qwen3.8-27B, 262K real window) so the provider never rejects
 * a prompt; the only synthetic element is an artificial cap W enforced by the
 * assembler each turn — which is what a deployment window IS. FULL tools are kept
 * (no artificial tool removal), so this is ecological.
 *
 * ARMS — all capped arms fit the SAME budget W with the SAME anchor rule and
 * differ ONLY in the ORDER they sacrifice units. They are therefore
 * VOLUME-MATCHED by construction, so any difference is a difference in SELECTION
 * SIGNAL, not in how much was evicted.
 *   uncapped      — no cap; reference that the task is solvable + its cost.
 *   truncate-tail — keep the most RECENT units that fit (what real harnesses do).
 *   random        — CONTROL: keep a random subset that fits (no signal).
 *   idle          — keep the units whose FILES were referenced most recently.
 *
 * v2 fixes (adversarial review found these in v1, all confirmed by measurement):
 *   BLOCKER 1 idleOf keyed on the promiscuous `fp` fingerprint (`__init__` linked
 *             every unit to the newest), pinning idle near 0 -> the arm was inert.
 *   BLOCKER 2 the backstop delegated to evictRecency, which keeps a contiguous
 *             suffix and deleted exactly what the idle rule had saved.
 *   M1        peak was sampled BEFORE eviction, so capped arms reported pre-cap size.
 *   M2        the control was not volume-matched with the treatment.
 *   M5        this file carried its own copy of the policies, so the unit tests
 *             validated code that was never executed. It now IMPORTS policies.mjs.
 *
 * LIVE. Rerun:
 *   set -a; . ./.env; set +a
 *   CT_LOCAL_MODEL=unsloth/Qwen3.8-27B-GGUF CT_TASK=longbuild \
 *   CT_WINDOWS=9500,4700 CT_REPEATS=3 CT_MAX_TURNS=60 \
 *     node experiments/context-dedup/ab-window-sweep.mjs
 */
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, makeWorkspace, estTokens, MODEL } from '../coding-harness/lib.mjs';
import { evictByRecency, evictByRandom, evictByIdle, evictByBlend, makeRng } from './policies.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOWS = (process.env.CT_WINDOWS || '9500,4700').split(',').map(Number);
const REPEATS = +(process.env.CT_REPEATS || 3);
const MAX_TURNS = +(process.env.CT_MAX_TURNS || 60);
const ANCHOR = +(process.env.CT_ANCHOR || 4);
const ARMS = (process.env.CT_ARMS || 'uncapped,truncate-tail,random,idle').split(',');
const TASK_NAME = process.env.CT_TASK || 'longbuild';
const TAG = process.env.CT_TAG || 'v2';   // distinguishes concurrent runs' output files
// CADENCE: only check/evict every N turns. N=1 is DV2's worst case; larger N lets the
// context overshoot W between events, so cadence and effective window are ENTANGLED —
// peak_history_tokens is recorded so the two can be told apart.
const CADENCE = +(process.env.CT_CADENCE || 1);
const ALPHA = process.env.CT_ALPHA === undefined ? null : +process.env.CT_ALPHA;

const NOOP = { changed: false, kept: null, evicted: 0, capViolated: false };
function evictorFor(arm, W, repeat) {
  const opts = { anchor: ANCHOR };
  if (arm === 'uncapped') return () => NOOP;
  if (arm === 'truncate-tail') return (m) => evictByRecency(m, W, opts);
  if (arm === 'idle') return (m) => evictByIdle(m, W, opts);
  if (arm === 'blend') return (m) => evictByBlend(m, W, ALPHA ?? 0.5, opts);
  if (arm === 'random') { const rng = makeRng(1000 + repeat); return (m) => evictByRandom(m, W, rng, opts); }
  throw new Error(`unknown arm ${arm}`);
}

async function runCell(task, arm, W, repeat) {
  const ws = makeWorkspace();
  task.seed(ws);
  const track = { peak: 0, peakPre: 0, evictions: 0, capViolations: 0, keptLast: null };
  const evict = evictorFor(arm, W, repeat);
  // peak is sampled AFTER eviction: that is what is actually sent to the model.
  let turnNo = 0;
  const hook = async (m) => {
    track.peakPre = Math.max(track.peakPre, estTokens(m));
    const fire = (turnNo++ % CADENCE) === 0;          // cadence gate
    const r = fire ? evict(m) : NOOP;
    if (r.changed) track.evictions += 1;
    if (r.capViolated) track.capViolations += 1;
    track.keptLast = r.kept;
    track.peak = Math.max(track.peak, estTokens(m));
  };
  let err = null, r = null;
  const t0 = Date.now();
  try {
    r = await runAgent({ system: task.system, task: task.task, ws, maxTurns: MAX_TURNS, think: false, hook, allowedTools: task.allowedTools ?? null });
  } catch (e) { err = String(e.message || e).slice(0, 200); }
  let pass = false;
  try { pass = task.grade(ws); } catch { pass = false; }
  const reads = r ? r.toolLog.filter((t) => t.name === 'read_file') : [];
  const distinct = new Set(reads.map((t) => t.args?.path).filter(Boolean)).size;
  return {
    arm, window: arm === 'uncapped' ? null : W, repeat,
    pass, turns: r?.turns ?? null, stop: r?.stop ?? 'error',
    evictions: track.evictions, cap_violations: track.capViolations, units_kept_last: track.keptLast,
    reads: reads.length, rereads: Math.max(0, reads.length - distinct),
    peak_history_tokens: track.peak, peak_before_evict: track.peakPre,
    total_prompt_tokens: r ? r.usage.reduce((s, u) => s + (u.prompt_tokens || 0), 0) : 0,
    wall_seconds: Math.round((Date.now() - t0) / 1000), error: err,
  };
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

async function main() {
  const task = (await import(join(HERE, 'ab-tasks', `${TASK_NAME}.mjs`))).default;
  const cells = [];
  for (let rep = 0; rep < REPEATS; rep++) {
    if (ARMS.includes('uncapped')) {
      console.error(`\n--- rep${rep} uncapped ---`);
      const c = await runCell(task, 'uncapped', Infinity, rep); cells.push(c);
      console.error(`    -> ${c.pass ? 'PASS' : 'FAIL'} turns=${c.turns} peak=${c.peak_history_tokens} tok=${c.total_prompt_tokens}`);
    }
    for (const W of WINDOWS) for (const arm of ARMS) {
      if (arm === 'uncapped') continue;
      console.error(`\n--- rep${rep} W=${W} ${arm} ---`);
      const c = await runCell(task, arm, W, rep); cells.push(c);
      console.error(`    -> ${c.pass ? 'PASS' : 'FAIL'} turns=${c.turns} evict=${c.evictions} rereads=${c.rereads} peak=${c.peak_history_tokens} tok=${c.total_prompt_tokens}`);
    }
  }
  // aggregate per (arm, window)
  const groups = new Map();
  for (const c of cells) {
    const k = `${c.arm}@${c.window ?? 'inf'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const summary = [...groups.entries()].map(([k, cs]) => ({
    cell: k, n: cs.length,
    pass_rate: cs.filter((c) => c.pass).length / cs.length,
    turns_median: med(cs.map((c) => c.turns ?? MAX_TURNS)),
    turns_min: Math.min(...cs.map((c) => c.turns ?? MAX_TURNS)),
    turns_max: Math.max(...cs.map((c) => c.turns ?? MAX_TURNS)),
    rereads_median: med(cs.map((c) => c.rereads)),
    evictions_median: med(cs.map((c) => c.evictions)),
    peak_median: med(cs.map((c) => c.peak_history_tokens)),
    total_tokens_median: med(cs.map((c) => c.total_prompt_tokens)),
    cap_violations_total: cs.reduce((s, c) => s + c.cap_violations, 0),
  }));
  const out = {
    manifest: {
      run_id: `ab-window-sweep-v2-${TASK_NAME}-${Date.now()}`,
      experiment: `context-dedup / A/B window-cap sweep v2 (${TASK_NAME})`,
      model: MODEL, task: task.name, windows: WINDOWS, repeats: REPEATS,
      max_turns: MAX_TURNS, anchor: ANCHOR, cadence: CADENCE, alpha: ALPHA, commit: gitSha(), date: nowISO(),
      hypothesis: 'At a binding cap, keeping units by REFERENCE recency (idle) completes with fewer turns/re-reads than keeping by POSITIONAL recency (truncate-tail), and both beat the random control. All capped arms are volume-matched (same budget, same anchor).',
      falsification: 'if idle does not beat truncate-tail outside the measured run-to-run noise band, and/or does not beat random, reference-recency adds nothing over positional recency.',
      caveats: [
        `n=${REPEATS} per cell, temp 0 but NOT bit-identical on this host — read differences against the observed turns_min..turns_max spread.`,
        'total_prompt_tokens is RAW (the local server may not do prompt caching); this measures task survival + context volume, not cached cost (DV2 covers cached cost).',
        'Synthetic long-horizon task, NOT a published benchmark: SWE-bench was environmentally impossible (no docker/pip/PyPI/conda at the time of this run).',
        'Grading is all-or-nothing, so FAIL cells are not distinguished by how close they came.',
      ],
    }, summary, cells,
  };
  const path = writeResults('context-dedup', `results-ab-${TASK_NAME}-${TAG}.json`, out);
  console.error(`\n=== A/B WINDOW SWEEP v2 [${task.name}] model=${MODEL} n=${REPEATS} ===`);
  console.error('  cell                     n  pass  turns(med/min-max)  rereads  evict  peak    tokens');
  for (const s of summary) {
    console.error(`  ${s.cell.padEnd(24)} ${s.n}  ${(s.pass_rate * 100).toFixed(0).padStart(3)}%  ${String(s.turns_median).padStart(5)} (${s.turns_min}-${s.turns_max})   ${String(s.rereads_median).padStart(5)}  ${String(s.evictions_median).padStart(5)}  ${String(s.peak_median).padStart(6)}  ${s.total_tokens_median}`);
  }
  console.error(`  written: ${path}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
