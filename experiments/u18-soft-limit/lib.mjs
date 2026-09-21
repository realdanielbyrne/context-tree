/**
 * U18 — the pre-registered rules, as pure functions. Nothing here runs on import: the
 * experiment is `run.sh`, the reader is `analyze.mjs`, and a test can import this module
 * without starting either (see `context-dedup/stats.mjs` for why that matters).
 *
 * Every threshold below is stated in README.md with its rationale and was fixed BEFORE any
 * arm ran. Change one and the README's decision record has to change with it.
 */
import { createHash } from 'node:crypto';
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
  /** Gate: a cell this short never filled anything, so it shows nothing about an arm (a one-step cell once passed `hard`). */
  gateMinSteps: 20,
  /** A recall arm whose agent called a recall tool in fewer cells than this did not exercise recall. */
  minRecallCells: 3,
  /** Gate: slowest assembly turn, against the plugin's 8,000 ms fail-open budget. */
  gateMaxAssembleMs: 4000,
});

/**
 * EVERY value that still needs a sweep is a knob: `U18_<NAME>` on the command line, handed to
 * the driver as the `CT_*` variable beside it.
 *
 * The PIPELINE half is not written here. It is `@context-tree/mcp`'s parameter registry
 * (`PIPELINE_PARAMS`), read from the build the sidecar will run — so a parameter added to the
 * package is a knob here with no edit, and its bounds are the package's. What IS written here
 * is what the package does not own: the plugin's policy knobs, the two sidecar-only settings,
 * and this experiment's deliberate departures from the package defaults.
 *
 * Not knobs, deliberately: the model, the sandbox, the prompt, repeats, the timeout, and the
 * trigger itself (it IS the arm).
 */
const { PIPELINE_PARAMS } = await import(new URL('../../packages/mcp/dist/index.js', import.meta.url).href);

/**
 * THE ARMS. Each is a trigger plus what it SETS on top of the shared knobs, and each adds one
 * thing to the one before it:
 *
 *   off      the host alone
 *   hard     the plumbing, evicting only at the real window        — plumbing-matched control
 *   soft     evicts at W, SILENTLY: a dropped message leaves nothing behind
 *   stub     soft + an evicted turn stays visible as a stub with a recall id, and the contract
 *            (v5) describes those tags. No summaries.
 *   summary  stub + closed phases fold to a headline summary with a recall id (U20)
 *
 * `soft` exists unchanged because its cells were run before the other two were designed: in 21
 * ct cells the agent never once called a recall tool, which is what `stub` and `summary` address.
 */
export const ARMS = Object.freeze({
  off: { trigger: null, set: {} },
  hard: { trigger: 'hard', set: {} },
  soft: { trigger: 'soft', set: {} },
  stub: { trigger: 'soft', set: { CT_CT_EVICT_MODE: 'stub', CT_CONTRACT: 'v5' } },
  summary: { trigger: 'soft', set: { CT_CT_EVICT_MODE: 'stub', CT_CONTRACT: 'v5', CT_CT_SUMMARIES: '1' } },
});
export const CT_ARMS = Object.freeze(Object.keys(ARMS).filter((a) => ARMS[a].trigger !== null));
/** Arms whose purpose is that the agent can get evicted content back. */
export const RECALL_ARMS = Object.freeze(['stub', 'summary']);

/** Set per arm (`ARMS`), never from the command line: summaries are an arm, not a knob. `run.sh` defaults it to 0. */
export const U18_FIXED = Object.freeze({ CT_CT_SUMMARIES: '0' });

/**
 * Parameters added to the package AFTER cells had been recorded. At its package default such a
 * knob is left out of the tag hash and may be absent from an older cell's record — otherwise
 * adding a parameter upstream would orphan every wave already run under the old hash.
 */
const LATE_KNOBS = Object.freeze(['CT_CT_EVICT_MODE', 'CT_CT_SUMMARY_RENDER']);
const atLateDefault = (ct, value) => LATE_KNOBS.includes(ct) && value === KNOBS.find((k) => k.ct === ct)?.def;

/** Where U18 runs away from the package default, and since when. */
export const U18_DEFAULTS = Object.freeze({ CT_CT_ANCHOR: '3' /* 2026-09-20; package default 4 */ });

const POLICY_KNOBS = [
  { ct: 'CT_CT_WINDOW', def: '50347', triggers: ['soft'], describe: 'The soft limit, in heuristic tokens — the swept variable.' },
  { ct: 'CT_CT_HARD_WINDOW', def: '151040', describe: 'The real context; also sets the overflow ceiling.' },
  { ct: 'CT_CT_REPLY_RESERVE', def: '8192', describe: 'Held back from the window for the reply.' },
  { ct: 'CT_CT_HEAD_TOKENS', def: '12000', describe: 'Allowance for what the plugin cannot see (system block, tool schemas).' },
  { ct: 'CT_ASSEMBLE_MS', def: '8000', describe: 'Per-turn budget before the plugin fails open.' },
  { ct: 'CT_CT_NEUTRAL_PHASES', def: 'other', text: true, describe: 'Phases that never open a new phase; `none` for the literal rule. Matters to folding, and to `unit: phase`.' },
  { ct: 'CT_CONTRACT', def: 'v1', oneOf: ['v1', 'v2', 'v3', 'v4', 'v5'], describe: 'System-contract version shipped to the agent.' },
];

const fromRegistry = (spec) => ({
  ct: spec.env,
  def: spec.kind === 'bool' ? (spec.default ? '1' : '0') : String(spec.default),
  describe: spec.describe,
  ...(spec.kind === 'enum' ? { oneOf: spec.values } : spec.kind === 'bool' ? { oneOf: ['0', '1'] } : { int: spec.kind === 'int', min: spec.min, exclusiveMin: spec.exclusiveMin === true, max: spec.max }),
});

export const KNOBS = Object.freeze(
  [...POLICY_KNOBS.map((k) => ({ ...k, half: 'policy' })), ...PIPELINE_PARAMS.filter((spec) => !(spec.env in U18_FIXED)).map((spec) => ({ ...fromRegistry(spec), half: 'pipeline' }))]
    .map((k) => ({ ...k, name: k.ct.replace(/^CT_(CT_)?/, ''), def: U18_DEFAULTS[k.ct] ?? k.def })),
);

/** The resolved knob set, as `CT_*` -> string. Throws on anything that does not parse. */
export function resolveKnobs(env = process.env) {
  const out = {}, problems = [];
  for (const k of KNOBS) {
    const raw = env[`U18_${k.name}`];
    const value = raw === undefined || raw === '' ? k.def : String(raw);
    if (k.oneOf) { if (!k.oneOf.includes(value)) problems.push(`U18_${k.name} must be ${k.oneOf.join('|')}, got "${value}"`); }
    else if (!k.text) {
      const n = Number(value);
      const min = k.min ?? 0;
      if (!Number.isFinite(n) || (k.exclusiveMin ? n <= min : n < min) || (k.int && !Number.isInteger(n)) || (k.max !== undefined && n > k.max)) problems.push(`U18_${k.name} is not a valid value: "${value}"`);
    }
    out[k.ct] = value;
  }
  const w = Number(out.CT_CT_WINDOW), hard = Number(out.CT_CT_HARD_WINDOW), held = Number(out.CT_CT_REPLY_RESERVE) + Number(out.CT_CT_HEAD_TOKENS);
  if (hard !== SERVED_WINDOW) problems.push(`U18_HARD_WINDOW must be the served window ${SERVED_WINDOW}`);
  if (!(w < hard)) problems.push(`U18_WINDOW ${w} is not below the served window`);
  if (!(w > held)) problems.push(`U18_WINDOW ${w} leaves no room above reserve + head (${held})`);
  if (problems.length) throw new RangeError(problems.join('; '));
  return out;
}

/** The `CT_*` knobs an arm depends on: `hard` never reads the soft window, `off` reads none. */
export function armKnobs(arm, knobs) {
  const def = ARMS[arm];
  if (!def) throw new RangeError(`unknown arm "${arm}": ${Object.keys(ARMS).join('|')}`);
  if (def.trigger === null) return {};
  return { ...Object.fromEntries(KNOBS.filter((k) => !k.triggers || k.triggers.includes(def.trigger)).map((k) => [k.ct, knobs[k.ct]])), ...def.set };
}

/**
 * Tags carry a hash of every knob the arm depends on, so cells run under different settings
 * can never pool by accident — the readable parts (W, A) are for people, the hash is the key.
 */
export function tagBase(arm, knobs) {
  if (arm === 'off') return 'u18-off';
  const mine = Object.entries(armKnobs(arm, knobs)).filter(([ct, value]) => !atLateDefault(ct, value));
  const hash = createHash('sha256').update(JSON.stringify(mine.sort())).digest('hex').slice(0, 6);
  return `u18-${arm}-${ARMS[arm].trigger === 'soft' ? `W${knobs.CT_CT_WINDOW}-` : ''}A${knobs.CT_CT_ANCHOR}-${hash}`;
}

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
export function cellProblems(cell, { arm, window, knobs = null, foreignReads = [] }) {
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
    const { trigger, set } = ARMS[arm];
    if (ct.arm_effective?.trigger !== trigger) out.push(`trigger ${ct.arm_effective?.trigger}, expected ${trigger}`);
    if (trigger === 'soft' && ct.arm_effective?.softWindow !== window) out.push(`soft window ${ct.arm_effective?.softWindow}, expected ${window}`);
    if (Boolean(ct.arm_effective?.summaries) !== (set.CT_CT_SUMMARIES === '1')) out.push(`summaries ${ct.arm_effective?.summaries ? 'ON' : 'off'}: not what the ${arm} arm is`);
    // The cell must have run under exactly the config this analysis is reading.
    for (const [key, want] of Object.entries(knobs ? armKnobs(arm, knobs) : {})) {
      if (ct[key] === undefined && atLateDefault(key, want)) continue;
      if (ct[key] !== want) out.push(`${key} ran as ${JSON.stringify(ct[key])}, this config says ${JSON.stringify(want)}`);
    }
    if (!(ct.plugin_turns > 0)) out.push('zero plugin turns');
    const errorTurns = (ct.plugin_errors ?? 0) + (ct.assemble_errors ?? 0);
    if (ct.plugin_turns > 0 && errorTurns / ct.plugin_turns > RULES.maxPluginErrorShare) out.push(`${errorTurns} error turns of ${ct.plugin_turns}: the arm mostly failed open`);
    if (compactions(cell) > 0) out.push('host compaction ran in a ct arm');
  }
  return out;
}

export const engaged = (cell) => !!cell.ct?.fired && (cell.ct?.evicted_units ?? 0) + (cell.ct?.stubbed_units ?? 0) > 0;

const RECALL_TOOL = /^context-tree_(fetch|search|peek)$/;
/** How many times the AGENT called a recall tool. The plugin's own calls go over HTTP and are not counted here. */
export const recallCalls = (cell) => Object.entries(cell.mcp?.tools ?? {}).filter(([t]) => RECALL_TOOL.test(t)).reduce((n, [, k]) => n + k, 0);

/** How a session ended, from opencode's event stream: `length` is a step that ran into the output cap. */
export function finishReasons(runDir) {
  const reasons = readJsonl(join(runDir, 'events.jsonl')).filter((e) => e.type === 'step_finish').map((e) => e.part?.reason ?? null);
  return { last: reasons.at(-1) ?? null, length_steps: reasons.filter((r) => r === 'length').length };
}
const solved = (cell) => !!cell.scored && !!cell.pass && cell.grade_valid !== false;
function compactions(cell) { return cell.export_part_types?.compaction ?? 0; }

/** Served prompt tokens per model step, in order, from opencode's event stream. */
export function servedPerStep(runDir) {
  return readJsonl(join(runDir, 'events.jsonl')).filter((e) => e.type === 'step_finish')
    .map((e) => (e.part?.tokens?.input ?? 0) + (e.part?.tokens?.cache?.read ?? 0));
}

/**
 * SERVED tokens per HEURISTIC token, measured turn by turn.
 *
 * "Heuristic" = computed by arithmetic rather than by the served tokenizer: here the
 * plugin's `kept_tokens`, which is the sidecar's own tokenizer over the same content. "Served" = what the provider
 * reports for that step, minus step one's prompt (the head the plugin cannot see, assumed
 * constant). So this is an estimate of an estimate, and it is NOT a constant: it differs
 * by problem and drifts within a run, plausibly with the content mix. Reported as a
 * distribution, never folded into a single conversion factor. Row n joins step n; when the
 * counts differ the join is not trusted and the ratio is null.
 */
export function servedPerHeuristic(rows, served) {
  if (!rows.length || rows.length !== served.length) return { aligned: false, turns: 0 };
  const head = served[0];
  const ratios = rows.map((r, i) => ((r.kept_tokens ?? 0) >= 2000 ? (served[i] - head) / r.kept_tokens : null)).filter((x) => x !== null && x > 0);
  if (!ratios.length) return { aligned: true, turns: 0 };
  const q = Math.max(1, Math.floor(ratios.length / 4));
  const r2 = (x) => +x.toFixed(2);
  return { aligned: true, turns: ratios.length, min: r2(Math.min(...ratios)), median: r2(median(ratios)), max: r2(Math.max(...ratios)), first_quartile_median: r2(median(ratios.slice(0, q))), last_quartile_median: r2(median(ratios.slice(-q))) };
}

/**
 * What one ct cell's own logs say. The PLUGIN's rows are per turn and measured after the edit
 * (what was actually sent); the SIDECAR's `evict` rows are the ruling
 * (in unit tokens, the heuristic W is compared against).
 */
export function sidecarStats(runDir) {
  const turns = readJsonl(join(runDir, 'mcp', 'ct-plugin.jsonl')).filter((r) => r.turn !== undefined && !r.error);
  const calls = readJsonl(join(runDir, 'mcp', 'ct-mcp.jsonl'));
  const evicts = calls.filter((r) => r.event === 'evict');
  const assembles = calls.filter((r) => r.event === 'assemble');
  const first = turns.findIndex((r) => (r.dropped ?? 0) + (r.folded ?? 0) + (r.reduced ?? 0) > 0);
  const kept = (rs) => rs.reduce((m, r) => Math.max(m, r.kept_tokens ?? 0), 0);
  return {
    plugin_turns: turns.length, assemble_calls: assembles.length, evict_calls: evicts.length,
    max_ms: turns.reduce((m, r) => Math.max(m, r.ms ?? 0), 0),
    over_ceiling_turns: turns.filter((r) => r.over_ceiling).length,
    floor_evictions: turns.filter((r) => r.evict_floor).length,
    // A ruling that could not meet its budget: only the pinned units were left to pay.
    over_budget_rulings: evicts.filter((r) => r.over_budget).length,
    reduced_units: assembles.reduce((m, r) => Math.max(m, r.reduced ?? 0), 0),
    // The numbers that explain a limit that was or was not held.
    first_edit_turn: first >= 0 ? turns[first].turn : null,
    max_kept_before_first_edit: kept(first >= 0 ? turns.slice(0, first) : turns),
    max_kept_after_first_edit: first >= 0 ? kept(turns.slice(first)) : null,
    max_unit_tokens_after_ruling: evicts.reduce((m, r) => Math.max(m, r.tokens_after ?? 0), 0),
    served_per_heuristic: servedPerHeuristic(turns, servedPerStep(runDir)),
  };
}

/**
 * G1 + G2 on ONE ct cell. `soft`: the mechanism must fire and the real peak must sit near W —
 * NOT merely below the control's, which host compaction caps at ~119K. `hard`: the arm must
 * survive a problem that fills the window with host compaction off.
 */
export function gateVerdict(cell, wire, sidecar, { arm, window, knobs = null }) {
  const reasons = [...cellProblems(cell, { arm, window, knobs })];
  const broken = instrumentFailure(cell, wire);
  if (broken) reasons.push(`instrument failure: ${broken}`);
  if (!cell.run_valid) reasons.push(`run not valid: ${cell.exit_outcome} ${cell.error ?? ''}`.trim());
  if (!wire.present || wire.requests === 0) reasons.push('no wire record');
  if (wire.rejected > 0) reasons.push(`G1: ${wire.rejected} provider request(s) rejected — a broken message array or an overflow shows up here`);
  if ((cell.ct?.plugin_errors ?? 0) + (cell.ct?.assemble_errors ?? 0) > 0) reasons.push('G1: a plugin or assembly turn failed open');
  if (sidecar.max_ms > RULES.gateMaxAssembleMs) reasons.push(`G1: slowest assembly ${sidecar.max_ms} ms > ${RULES.gateMaxAssembleMs} (the plugin fails open at 8,000)`);
  if (sidecar.over_ceiling_turns > 0) reasons.push(`${sidecar.over_ceiling_turns} turn(s) left the prompt over the ceiling`);
  if (sidecar.over_budget_rulings > 0) reasons.push(`G2: ${sidecar.over_budget_rulings} ruling(s) could not meet the budget — the pinned units alone exceeded it`);
  if ((cell.steps ?? 0) < RULES.gateMinSteps) reasons.push(`the cell ran ${cell.steps ?? 0} step(s) (< ${RULES.gateMinSteps}): too short to show anything about the arm`);
  if (ARMS[arm].set.CT_CT_EVICT_MODE === 'stub' && !((cell.ct?.messages_stubbed ?? 0) > 0)) reasons.push('G2: no message was ever stubbed — the arm ran as silent eviction');
  if (ARMS[arm].set.CT_CT_SUMMARIES === '1' && !((cell.ct?.messages_folded ?? 0) > 0)) reasons.push('G2: no phase was ever folded to a summary — the arm ran as `stub`');
  if (ARMS[arm].trigger === 'soft') {
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

function armSummary(cells, finish = () => null) {
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
    // Secondary outcomes, registered before the recall arms ran: did the agent ever reach for what
    // was evicted, and did a session end by running into the output cap.
    recall_tool_calls: cells.reduce((n, c) => n + recallCalls(c), 0),
    cells_with_recall: cells.filter((c) => recallCalls(c) > 0).length,
    cells_ended_at_output_cap: cells.filter((c) => finish(c)?.last === 'length').length,
    // The agent can call the pipeline tools itself (D22). In `hard` that would make the
    // plumbing control evict, so it is counted where it can be seen.
    agent_evict_calls: cells.reduce((n, c) => n + Object.entries(c.mcp?.tools ?? {}).filter(([t]) => /^context-tree_(evict|restore)$/.test(t)).reduce((m, [, k]) => m + k, 0), 0),
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
export function analyze({ arms, window, knobs = null, instances = null, owed = [], historical = null, historicalSolved = HISTORICAL_SOLVED, wire = () => ({ peak_bytes: null }), foreignReads = () => [], finish = () => null }) {
  const { off, soft, hard = null } = arms;
  const present = Object.entries(arms).filter(([, cells]) => cells);
  const integrity = present.flatMap(([arm, cells]) => cells.flatMap((c) => cellProblems(c, { arm, window, knobs, foreignReads: foreignReads(c) }).map((p) => `${arm} ${c.instance}__r${c.repeat}: ${p}`)));
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

  const summary = Object.fromEntries(present.map(([arm, cells]) => [arm, armSummary(cells, finish)]));
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

  // The recall arms answer a different question from the ladder above, which stays soft-vs-off as
  // registered: does making eviction VISIBLE and RECALLABLE change what silent eviction did? An
  // arm whose agent never recalled anything says nothing about recall, whatever it scored.
  const recall = Object.fromEntries(RECALL_ARMS.filter((arm) => arms[arm]).map((arm) => [arm, {
    exercised: summary[arm].cells_with_recall >= RULES.minRecallCells,
    note: summary[arm].cells_with_recall >= RULES.minRecallCells ? null : `the agent called a recall tool in ${summary[arm].cells_with_recall} cell(s) (< ${RULES.minRecallCells}): RECALL NOT EXERCISED — this arm's solve rate is evidence about visible eviction, not about recall`,
    vs_off: compare(arms[arm], off, { window, wire }),
    vs_soft: compare(arms[arm], soft, { window, wire }),
  }]));

  return {
    verdict, why, window, rules: RULES, integrity_problems: integrity, incomplete,
    arms: summary, primary_soft_vs_off: primary, attribution, recall,
    // Same arm, same weights, a day apart: the measured A/A spread the ±2 margin rests on.
    a_a_noise: historical ? {
      historical_solved: historical.filter(solved).length, fresh_off_solved: summary.off.solved,
      by_problem: compare(off, historical, { window, wire: () => ({ peak_bytes: null }) }).rows.map((r) => ({ instance: r.instance, historical: r.control_solved, fresh: r.treatment_solved, historical_peak: r.control_peak, fresh_peak: r.treatment_peak })),
    } : null,
  };
}
