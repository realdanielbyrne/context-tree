/**
 * U18 — the pre-registered rules, as pure functions. Nothing here runs on import: the
 * experiment is `run.sh`, the reader is `analyze.mjs`, and a test can import this module
 * without starting either (see `context-dedup/stats.mjs` for why that matters).
 *
 * Every threshold below is stated in README.md with its rationale and was fixed BEFORE any
 * arm ran. Change one and the README's decision record has to change with it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MODEL = 'local/HuggingJoost/Swift-Qwen3.8-27B-NVFP4-GGUF';
export const SERVED_WINDOW = 151_040;
export const PROBLEMS = 10;
export const REPEATS = 3;
/** The clean Swift-NVFP4 baseline this run's `off` arm is an A/A repeat of. */
export const HISTORICAL_SOLVED = 19;

export const RULES = Object.freeze({
  /** Soft cells that must have evicted for the arm to count as having run at all. */
  minEngagedCells: 8,
  /** Δ solves (soft − control, of 30) at or below which the claim is refuted at this W. */
  refuteDelta: -3,
  /** Geo-mean soft/off peak ratio on binding problems at or below which the fall is "material". */
  materialPeakRatio: 0.75,
  /** |fresh off − historical| at or above which the INSTRUMENT moved and nothing is decided. */
  aaDrift: 3,
  /** Standing rule 10: unscored share of all cells, and unscored asymmetry across arms. */
  maxUnscoredShare: 0.25,
  unscoredAsymmetry: 2,
  /** A fail-open plugin turn is the treatment's own behaviour — up to this share of a cell's turns. */
  maxPluginErrorShare: 0.10,
  /** Gate: the soft cell's real peak may exceed the nominal W by this factor (W is heuristic tokens). */
  gatePeakFactor: 1.3,
  /** Gate: slowest assembly turn, against the plugin's 8,000 ms fail-open budget. */
  gateMaxAssembleMs: 4000,
});

const PREFLIGHT_MUST_INCLUDE = [/^no outbound network$/, /^no DNS$/, /^hidden .*\/dataset$/, /^hidden .*\/repos$/, /^imports from workspace$/];
const LIBRARY_OF = Object.freeze({
  'django/django': ['django'], 'psf/requests': ['requests'], 'pydata/xarray': ['xarray'],
  'pylint-dev/pylint': ['pylint'], 'pytest-dev/pytest': ['_pytest', 'pytest'], 'scikit-learn/scikit-learn': ['sklearn'],
});

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const geoMean = (xs) => (xs.length ? Math.exp(xs.reduce((n, x) => n + Math.log(x), 0) / xs.length) : null);
const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);

/**
 * What the relay saw. It sits outside the sandbox, downstream of the plugin, so it is the one
 * peak measure an inert arm cannot fake. Only tool-bearing requests: the titling call never
 * passes through the hook.
 */
export function wireStats(runDir) {
  const p = join(runDir, 'wire.jsonl');
  if (!existsSync(p)) return { present: false, requests: 0, ok: 0, rejected: 0, peak_bytes: null };
  const rows = readJsonl(p).filter((r) => (r.counts?.tools ?? 0) > 0);
  return {
    present: true, requests: rows.length,
    ok: rows.filter((r) => r.status === 200).length,
    rejected: rows.filter((r) => r.status !== 200).length,
    peak_bytes: rows.reduce((m, r) => Math.max(m, r.bytes ?? 0), 0),
  };
}

/**
 * Did the agent open a copy of the task's library that is NOT the workspace? The sandbox masks
 * the host's copies, but every venv carries pip's vendored ones (`pip/_vendor/requests` is a
 * released requests, against psf__requests-1142), and those cannot be masked without changing
 * the venv. So the event stream is searched instead.
 */
export function foreignLibraryReads(runDir, repo) {
  const p = join(runDir, 'events.jsonl');
  if (!existsSync(p)) return [];
  const names = LIBRARY_OF[repo] ?? [];
  const text = readFileSync(p, 'utf8');
  return names.flatMap((n) => [...text.matchAll(new RegExp(`(?:_vendor|dist-packages|/snap|/opt)/[^"\\\\\\s]*?\\b${n}\\b[^"\\\\\\s]*`, 'g'))].map((m) => m[0])).slice(0, 5);
}

/**
 * Standing rule 9: "the agent did nothing" is an instrument failure until proven otherwise.
 * Every criterion here is blind to the grade — a killed process, a run with no model step, a
 * run the provider never answered — so re-running such a cell is not choosing an outcome.
 * `run.sh` owes these cells again and the analysis treats them as absent.
 */
export function instrumentFailure(cell, wire = null) {
  if (cell.killed_externally) return 'killed externally';
  if (!(cell.steps > 0)) return `no model step (${cell.exit_outcome})`;
  if (wire?.present && wire.ok === 0) return 'the provider never answered a tool-bearing request';
  return null;
}

/**
 * Is this cell evidence at all? A problem here voids the ANALYSIS, not just the cell: a run
 * that escaped the sandbox, ran on other weights, or carried an arm the sidecar never booted
 * cannot be averaged away.
 */
export function cellProblems(cell, { arm, window, foreignReads = [] }) {
  const out = [];
  if (cell.model !== MODEL) out.push(`model ${cell.model}`);
  if (cell.endpoint !== 'local') out.push(`endpoint ${cell.endpoint}`);
  if (cell.model_config?.limit_context !== SERVED_WINDOW) out.push(`limit.context ${cell.model_config?.limit_context}`);
  if (cell.window !== null && cell.window !== undefined) out.push(`CT_WINDOW ${cell.window} re-declared the host context`);
  if (!cell.sandbox?.enabled) out.push('sandbox OFF');
  else {
    const checks = Object.entries(cell.sandbox.preflight ?? {});
    const failed = checks.filter(([, ok]) => ok !== true).map(([k]) => k);
    const absent = PREFLIGHT_MUST_INCLUDE.filter((re) => !checks.some(([k]) => re.test(k))).map(String);
    if (failed.length) out.push(`sandbox preflight failed: ${failed.join('; ')}`);
    if (absent.length) out.push(`sandbox preflight never checked: ${absent.join(' ')}`);
  }
  if (foreignReads.length) out.push(`agent touched a foreign copy of the task library: ${foreignReads.join(' ')}`);
  if ((cell.other_opencode_runs_peak ?? 0) > 1) out.push(`${cell.other_opencode_runs_peak - 1} other opencode run(s) shared the device`);
  if (cell.ct?.CT_G0_DROP_FIRST) out.push('G0 gate cell');

  const wantArm = arm === 'off' ? 'off' : 'ct';
  if (cell.arm !== wantArm) out.push(`arm ${cell.arm}, expected ${wantArm}`);
  if (wantArm === 'ct') {
    const ct = cell.ct ?? {};
    if (!ct.plugin_loaded || !ct.plugin_registered) out.push('plugin never loaded/registered');
    if (!ct.arm_agrees) out.push(`sidecar arm disagrees: ${(ct.arm_disagreements ?? []).join('; ')}`);
    if (ct.arm_effective?.trigger !== arm) out.push(`trigger ${ct.arm_effective?.trigger}, expected ${arm}`);
    if (arm === 'soft' && ct.arm_effective?.softWindow !== window) out.push(`soft window ${ct.arm_effective?.softWindow}, expected ${window}`);
    if (ct.arm_effective?.summaries) out.push('summaries ON (that is U20)');
    if (!(ct.plugin_turns > 0)) out.push('zero plugin turns');
    const errorTurns = (ct.plugin_errors ?? 0) + (ct.assemble_errors ?? 0);
    if (ct.plugin_turns > 0 && errorTurns / ct.plugin_turns > RULES.maxPluginErrorShare) out.push(`${errorTurns} error turns of ${ct.plugin_turns}: the arm mostly failed open`);
    if (compactions(cell) > 0) out.push('host compaction ran in a ct arm');
  }
  return out;
}

export const engaged = (cell) => !!cell.ct?.fired && (cell.ct?.evicted_units ?? 0) > 0;
const solved = (cell) => !!cell.scored && !!cell.pass && cell.grade_valid !== false;
function compactions(cell) { return cell.export_part_types?.compaction ?? 0; }

/** Slowest assembly, and the heuristic-vs-real token ratio, from the sidecar's own log. */
export function sidecarStats(runDir, cell) {
  const rows = readJsonl(join(runDir, 'mcp', 'ct-mcp.jsonl')).filter((r) => r.event === 'assemble');
  const maxTotal = rows.reduce((m, r) => Math.max(m, r.total ?? 0), 0);
  const real = (cell.peak_prompt_tokens ?? 0) - (cell.first_step_prompt_tokens ?? 0);
  return {
    assemble_rows: rows.length, max_ms: rows.reduce((m, r) => Math.max(m, r.ms ?? 0), 0),
    over_ceiling_turns: rows.filter((r) => r.over_ceiling).length, escalations: rows.reduce((n, r) => n + (r.escalations ?? 0), 0),
    max_kept_heuristic: rows.reduce((m, r) => Math.max(m, r.kept_tokens ?? 0), 0), max_total_heuristic: maxTotal,
    // Rough: real growth since step one over the largest heuristic message total. W is
    // denominated in the heuristic; this says what it is worth in served tokens.
    real_per_heuristic_token: maxTotal > 0 && real > 0 ? +(real / maxTotal).toFixed(2) : null,
  };
}

/**
 * G1 + G2 on ONE ct cell. `soft`: the mechanism must fire and the real peak must sit near W —
 * NOT merely below the control's, which host compaction caps at ~119K. `hard`: the arm must
 * survive a problem that fills the window with host compaction off.
 */
export function gateVerdict(cell, wire, sidecar, { arm, window }) {
  const reasons = [...cellProblems(cell, { arm, window })];
  const broken = instrumentFailure(cell, wire);
  if (broken) reasons.push(`instrument failure: ${broken}`);
  if (!cell.run_valid) reasons.push(`run not valid: ${cell.exit_outcome} ${cell.error ?? ''}`.trim());
  if (!wire.present || wire.requests === 0) reasons.push('no wire record');
  if (wire.rejected > 0) reasons.push(`G1: ${wire.rejected} provider request(s) rejected — a broken message array or an overflow shows up here`);
  if ((cell.ct?.plugin_errors ?? 0) + (cell.ct?.assemble_errors ?? 0) > 0) reasons.push('G1: a plugin or assembly turn failed open');
  if (sidecar.max_ms > RULES.gateMaxAssembleMs) reasons.push(`G1: slowest assembly ${sidecar.max_ms} ms > ${RULES.gateMaxAssembleMs} (the plugin fails open at 8,000)`);
  if (sidecar.over_ceiling_turns > 0) reasons.push(`${sidecar.over_ceiling_turns} turn(s) left the prompt over the ceiling`);
  if (arm === 'soft') {
    if (!engaged(cell)) reasons.push('G2: nothing evicted — the mechanism did not fire');
    const limit = Math.round(window * RULES.gatePeakFactor);
    if (!(cell.peak_prompt_tokens <= limit)) reasons.push(`G2: real peak ${cell.peak_prompt_tokens} > ${limit} (W × ${RULES.gatePeakFactor}): evictions are logged but the limit is not held`);
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * Exact one-sided paired sign-flip test, H1: treatment < control. `diffs` are per-problem
 * (treatment − control). 2^10 assignments: enumerated, not sampled.
 */
export function signFlipP(diffs) {
  const d = diffs.filter((x) => x !== 0);
  if (!d.length) return 1;
  const observed = d.reduce((a, b) => a + b, 0);
  let hits = 0;
  for (let mask = 0; mask < 2 ** d.length; mask++) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += (mask >> i) & 1 ? -d[i] : d[i];
    if (s <= observed) hits += 1;
  }
  return hits / 2 ** d.length;
}

function byProblem(cells) {
  const m = new Map();
  for (const c of cells) m.set(c.instance, [...(m.get(c.instance) ?? []), c]);
  return m;
}

const peaks = (cells) => cells.map((c) => c.peak_prompt_tokens).filter((x) => Number.isFinite(x) && x > 0);

function armSummary(cells) {
  const unscored = cells.filter((c) => !c.scored);
  const turns = cells.reduce((n, c) => n + (c.ct?.plugin_turns ?? 0), 0);
  return {
    cells: cells.length,
    // Intention to treat: an unscored cell (timeout, session error) is a FAIL. A ct arm runs with
    // host compaction off, so a session the arm itself broke must stay in its own denominator.
    solved: cells.filter(solved).length,
    rate_itt: +(cells.filter(solved).length / Math.max(1, cells.length)).toFixed(3),
    unscored: unscored.map((c) => `${c.instance}__r${c.repeat}: ${c.exit_outcome}`),
    timeouts: cells.filter((c) => c.timed_out).length,
    median_peak: median(peaks(cells)), max_peak: peaks(cells).length ? Math.max(...peaks(cells)) : null,
    compacted_cells: cells.filter((c) => compactions(c) > 0).length,
    engaged_cells: cells.filter(engaged).length,
    plugin_error_turns: cells.reduce((n, c) => n + (c.ct?.plugin_errors ?? 0) + (c.ct?.assemble_errors ?? 0), 0), plugin_turns: turns,
  };
}

/** Paired within problem: solves out of REPEATS, and the median peak over repeats. */
function paired(treatment, control, { window, wire }) {
  const t = byProblem(treatment), c = byProblem(control);
  return [...c.keys()].sort().map((instance) => {
    const tc = t.get(instance) ?? [], cc = c.get(instance) ?? [];
    const bytes = (cells) => median(cells.map((x) => wire(x).peak_bytes).filter(Number.isFinite));
    const controlPeak = median(peaks(cc)), treatmentPeak = median(peaks(tc));
    return {
      instance,
      control_solved: cc.filter(solved).length, treatment_solved: tc.filter(solved).length,
      control_peak: controlPeak, treatment_peak: treatmentPeak,
      peak_ratio: controlPeak && treatmentPeak ? +(treatmentPeak / controlPeak).toFixed(3) : null,
      control_wire_bytes: bytes(cc), treatment_wire_bytes: bytes(tc),
      // "Binding" is defined on the CONTROL, so the treatment cannot choose its own denominator.
      binding: controlPeak > window,
      treatment_engaged_cells: tc.filter(engaged).length,
    };
  });
}

function compare(treatment, control, opts) {
  const rows = paired(treatment, control, opts);
  const diffs = rows.map((r) => r.treatment_solved - r.control_solved);
  const binding = rows.filter((r) => r.binding && r.peak_ratio !== null);
  const wired = binding.filter((r) => r.control_wire_bytes && r.treatment_wire_bytes);
  // Peak is a per-run draw (standing rule 3), so the per-problem medians are backed by a
  // per-CELL view: engaged treatment cells against every control cell of the same problem.
  const c = byProblem(control);
  const engagedRatios = treatment.filter(engaged).flatMap((x) => {
    const base = median(peaks(c.get(x.instance) ?? []));
    return base && x.peak_prompt_tokens > 0 ? [x.peak_prompt_tokens / base] : [];
  });
  return {
    rows,
    delta_solved_itt: diffs.reduce((a, b) => a + b, 0),
    sign_flip_p_treatment_worse: +signFlipP(diffs).toFixed(4),
    collapsed: rows.filter((r) => r.control_solved === REPEATS && r.treatment_solved === 0 && r.treatment_engaged_cells > 0).map((r) => r.instance),
    binding_problems: binding.map((r) => r.instance),
    binding_peak_fell_on: binding.filter((r) => r.peak_ratio < 1).length,
    binding_peak_ratio_geomean: binding.length ? +geoMean(binding.map((r) => r.peak_ratio)).toFixed(3) : null,
    binding_wire_ratio_geomean: wired.length ? +geoMean(wired.map((r) => r.treatment_wire_bytes / r.control_wire_bytes)).toFixed(3) : null,
    engaged_cell_peak_ratio_median: engagedRatios.length ? +median(engagedRatios).toFixed(3) : null,
  };
}

/**
 * The verdict ladder. Order matters and is part of the pre-registration: integrity, then
 * completeness, then whether the instrument held still, then whether the treatment ran, and
 * only then what it did.
 *
 * `arms` holds cells that are NOT instrument failures; `owed` lists the ones that were.
 */
export function analyze({ arms, window, instances = null, owed = [], historical = null, historicalSolved = HISTORICAL_SOLVED, wire = () => ({ peak_bytes: null }), foreignReads = () => [] }) {
  const { off, soft, hard = null } = arms;
  const present = Object.entries(arms).filter(([, cells]) => cells);
  const integrity = present.flatMap(([arm, cells]) => cells.flatMap((c) => cellProblems(c, { arm, window, foreignReads: foreignReads(c) }).map((p) => `${arm} ${c.instance}__r${c.repeat}: ${p}`)));
  const expected = PROBLEMS * REPEATS;
  const incomplete = [...owed.map((o) => `owed again: ${o}`), ...present.flatMap(([arm, cells]) => {
    const keys = new Set(cells.map((c) => `${c.instance}__r${c.repeat}`));
    const out = [];
    if (keys.size !== cells.length) out.push(`${arm}: duplicate cells — a finished cell was re-run; resolve by hand, and say so in the report`);
    if (keys.size !== expected) out.push(`${arm}: ${keys.size}/${expected} cells`);
    if (instances) {
      const stray = [...new Set(cells.map((c) => c.instance))].filter((id) => !instances.includes(id));
      if (stray.length) out.push(`${arm}: not in the pool: ${stray.join(', ')}`);
    }
    return out;
  })];

  const summary = Object.fromEntries(present.map(([arm, cells]) => [arm, armSummary(cells)]));
  const primary = compare(soft, off, { window, wire });
  const attribution = hard ? { soft_vs_hard: compare(soft, hard, { window, wire }), hard_vs_off: compare(hard, off, { window, wire }) } : null;
  const unscoredCounts = present.map(([, cells]) => cells.filter((c) => !c.scored).length);
  const unscoredShare = unscoredCounts.reduce((a, b) => a + b, 0) / Math.max(1, present.reduce((n, [, c]) => n + c.length, 0));
  const nBinding = primary.binding_problems.length;
  const peakNote = `peak ratio ${primary.binding_peak_ratio_geomean} over ${nBinding} binding problem(s)`;

  let verdict, why;
  if (integrity.length) [verdict, why] = ['INVALID', 'a cell failed an integrity check; nothing below is evidence'];
  else if (incomplete.length) [verdict, why] = ['INCOMPLETE', incomplete.join('; ')];
  else if (Math.abs(summary.off.solved - historicalSolved) >= RULES.aaDrift) {
    [verdict, why] = ['DESCRIPTIVE_ONLY', `fresh off solved ${summary.off.solved}, the same arm solved ${historicalSolved} on the same weights: the instrument moved by more than the margin a verdict rests on`];
  } else if (unscoredShare > RULES.maxUnscoredShare || Math.max(...unscoredCounts) - Math.min(...unscoredCounts) >= RULES.unscoredAsymmetry) {
    [verdict, why] = ['DESCRIPTIVE_ONLY', `unscored cells per arm ${JSON.stringify(Object.fromEntries(present.map(([a], i) => [a, unscoredCounts[i]])))} (standing rule 10): the asymmetry is a finding about the arm that truncates, not a solve-rate result`];
  } else if (summary.soft.engaged_cells < RULES.minEngagedCells) {
    [verdict, why] = ['VOID', `soft evicted on ${summary.soft.engaged_cells} cells (< ${RULES.minEngagedCells}): the treatment barely ran — NOT RUNNABLE at this W, not a null`];
  } else if (!nBinding || primary.binding_peak_fell_on * 2 <= nBinding || !(primary.binding_peak_ratio_geomean < 1)) {
    [verdict, why] = ['VOID', `achieved peak did not fall where the control exceeded W (${peakNote}): the trigger is not doing what the arm claims`];
  } else if (primary.delta_solved_itt <= RULES.refuteDelta || primary.collapsed.length) {
    // The sweep moves up only if EVICTION is to blame. If the plumbing-matched control lost
    // the same solves, a larger W fixes nothing.
    const plumbing = attribution && attribution.hard_vs_off.delta_solved_itt <= RULES.refuteDelta;
    const action = plumbing ? `hard lost ${attribution.hard_vs_off.delta_solved_itt} against off too: the PLUMBING is implicated, not eviction — do not sweep, fix the arm`
      : attribution ? `soft − hard = ${attribution.soft_vs_hard.delta_solved_itt}: the sweep moves UP, not down` : 'unattributed (no hard arm): the sweep moves UP, not down';
    [verdict, why] = ['REFUTED_AT_W', `Δ solves ${primary.delta_solved_itt}${primary.collapsed.length ? `; collapsed 3/3→0/3 on ${primary.collapsed.join(', ')}` : ''}. ${action}`];
  } else if (primary.binding_peak_ratio_geomean <= RULES.materialPeakRatio) {
    [verdict, why] = ['HELD', `Δ solves ${primary.delta_solved_itt} (inside the ±2 noise margin), ${peakNote}. No ≥3-solve loss found — not demonstrated equivalence`];
  } else {
    [verdict, why] = ['HELD_NOT_MATERIAL', `accuracy held (Δ ${primary.delta_solved_itt}) but ${peakNote} > ${RULES.materialPeakRatio}`];
  }

  return {
    verdict, why, window, rules: RULES, integrity_problems: integrity, incomplete,
    arms: summary, primary_soft_vs_off: primary, attribution,
    // Same arm, same weights, a day apart: the measured A/A spread the ±2 margin rests on.
    a_a_noise: historical ? {
      historical_solved: historical.filter(solved).length, fresh_off_solved: summary.off.solved,
      by_problem: compare(off, historical, { window, wire: () => ({ peak_bytes: null }) }).rows.map((r) => ({ instance: r.instance, historical: r.control_solved, fresh: r.treatment_solved, historical_peak: r.control_peak, fresh_peak: r.treatment_peak })),
    } : null,
  };
}
