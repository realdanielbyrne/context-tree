import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARMS, recallCalls, KNOBS, U18_DEFAULTS, U18_FIXED, armKnobs, resolveKnobs, servedPerHeuristic, tagBase, analyze as analyzeRaw, cellProblems, foreignLibraryReads, gateVerdict, instrumentFailure, signFlipP, wireStats, MODEL, RULES, SERVED_WINDOW } from './lib.mjs';

// The fixture's control solves 27/30; the A/A rung is exercised on its own below.
const analyze = (o) => analyzeRaw({ historicalSolved: 27, ...o });

const W = 50347;
const IDS = Array.from({ length: 10 }, (_, i) => `p${i}`);
const BINDING = new Set(['p0', 'p1', 'p2', 'p3']);

function cell(arm, instance, repeat, { pass = true, peak, fired = false, over = {} } = {}) {
  const ct = arm === 'off' ? null : {
    plugin_loaded: true, plugin_registered: true, arm_agrees: true, arm_disagreements: [], plugin_turns: 40,
    plugin_errors: 0, assemble_errors: 0, fired, evicted_units: fired ? 7 : 0,
    arm_effective: { trigger: arm, softWindow: W, summaries: false },
  };
  return {
    instance, repeat, model: MODEL, endpoint: 'local', model_config: { limit_context: SERVED_WINDOW }, window: null,
    sandbox: { enabled: true, preflight: { 'no outbound network': true, 'no DNS': true, 'hidden /w/dataset': true, 'hidden /w/repos': true, 'imports from workspace': true } },
    steps: 40, repo: 'psf/requests', other_opencode_runs_peak: 1,
    arm: arm === 'off' ? 'off' : 'ct', ct, pass, grade_valid: true, scored: true, run_valid: true,
    peak_prompt_tokens: peak, export_part_types: {}, run_dir: `/nonexistent/${arm}/${instance}/${repeat}`, ...over,
  };
}

/** `softSolves(id)` → solves out of 3 under soft; off solves 3/3 on everything but p9. */
function arms({ softSolves = () => 3, softPeak = 45000, engage = true } = {}) {
  const off = [], soft = [], hard = [];
  for (const id of IDS) for (let r = 0; r < 3; r++) {
    const big = BINDING.has(id);
    off.push(cell('off', id, r, { pass: id !== 'p9', peak: big ? 110000 : 25000 }));
    hard.push(cell('hard', id, r, { pass: id !== 'p9', peak: big ? 112000 : 27000 }));
    soft.push(cell('soft', id, r, { pass: id !== 'p9' && r < softSolves(id), peak: big ? softPeak : 27000, fired: engage && big }));
  }
  return { off, soft, hard };
}

test('parity with a material peak fall is HELD', () => {
  const r = analyze({ arms: arms(), window: W });
  assert.equal(r.verdict, 'HELD');
  assert.equal(r.primary_soft_vs_off.delta_solved_itt, 0);
  assert.deepEqual(r.primary_soft_vs_off.binding_problems, ['p0', 'p1', 'p2', 'p3']);
});

test('a treatment that never evicted is VOID, never a null', () => {
  assert.equal(analyze({ arms: arms({ engage: false }), window: W }).verdict, 'VOID');
});

test('evictions logged but no peak fall is VOID', () => {
  assert.equal(analyze({ arms: arms({ softPeak: 111000 }), window: W }).verdict, 'VOID');
});

test('losing three solves refutes at this W', () => {
  const r = analyze({ arms: arms({ softSolves: (id) => (id === 'p0' ? 0 : 3) }), window: W });
  assert.equal(r.verdict, 'REFUTED_AT_W');
  assert.deepEqual(r.primary_soft_vs_off.collapsed, ['p0']);
});

test('two lost solves is inside the noise margin', () => {
  assert.equal(analyze({ arms: arms({ softSolves: (id) => (id === 'p0' ? 1 : 3) }), window: W }).verdict, 'HELD');
});

test('a small peak fall holds accuracy but is not material', () => {
  assert.equal(analyze({ arms: arms({ softPeak: 100000 }), window: W }).verdict, 'HELD_NOT_MATERIAL');
});

test('one unsandboxed cell invalidates the analysis', () => {
  const a = arms();
  a.soft[4] = cell('soft', a.soft[4].instance, a.soft[4].repeat, { peak: 45000, fired: true, over: { sandbox: { enabled: false } } });
  const r = analyze({ arms: a, window: W });
  assert.equal(r.verdict, 'INVALID');
  assert.match(r.integrity_problems[0], /sandbox OFF/);
});

test('an unscored cell counts as a fail, not as missing', () => {
  const a = arms();
  for (const c of a.soft.filter((x) => x.instance === 'p0')) Object.assign(c, { scored: false, exit_outcome: 'error_event' });
  const r = analyze({ arms: a, window: W });
  assert.equal(r.primary_soft_vs_off.delta_solved_itt, -3);
  assert.equal(r.arms.soft.solved, 24);
  assert.equal(r.verdict, 'DESCRIPTIVE_ONLY');
});

test('a missing or duplicated cell is INCOMPLETE', () => {
  const a = arms(); a.off.pop();
  assert.equal(analyze({ arms: a, window: W }).verdict, 'INCOMPLETE');
  const b = arms(); b.soft.push(b.soft[0]);
  assert.equal(analyze({ arms: b, window: W }).verdict, 'INCOMPLETE');
});

test('cellProblems catches the silent arm failures', () => {
  const inert = cell('soft', 'p0', 0, { peak: 1, over: {} });
  inert.ct.arm_effective.trigger = 'off'; inert.ct.arm_agrees = false; inert.ct.arm_disagreements = ['CT_CT_TRIGGER'];
  assert.ok(cellProblems(inert, { arm: 'soft', window: W }).length >= 2);
  assert.ok(cellProblems(cell('soft', 'p0', 0, { peak: 1, over: { window: 50000 } }), { arm: 'soft', window: W }).some((p) => /CT_WINDOW/.test(p)));
  assert.ok(cellProblems(cell('off', 'p0', 0, { peak: 1, over: { model: 'local/unsloth/Qwen3.8-27B-GGUF' } }), { arm: 'off', window: W }).length);
  assert.deepEqual(cellProblems(cell('hard', 'p0', 0, { peak: 1 }), { arm: 'hard', window: W }), []);
});

test('gate: soft must evict, keep the wire clean, and hold the real peak near W', () => {
  const wire = { present: true, requests: 80, ok: 80, rejected: 0, peak_bytes: 1 };
  const side = { max_ms: 900, over_ceiling_turns: 0, over_budget_rulings: 0 };
  const good = cell('soft', 'g', 0, { peak: 60000, fired: true });
  const v = (c, w = wire, s2 = side, arm = 'soft') => gateVerdict(c, w, s2, { arm, window: W }).pass;
  assert.equal(v(good), true);
  assert.equal(v(cell('soft', 'g', 0, { peak: 60000 })), false, 'nothing evicted');
  assert.equal(v(good, { ...wire, rejected: 1 }), false);
  // Below the compaction-capped control peak (~118K) is NOT enough: the limit must be held.
  assert.equal(v(cell('soft', 'g', 0, { peak: Math.round(W * RULES.gatePeakFactor) + 1, fired: true })), false);
  assert.equal(v(cell('soft', 'g', 0, { peak: Math.round(W * RULES.gatePeakFactor), fired: true })), true);
  assert.equal(v(good, wire, { ...side, max_ms: RULES.gateMaxAssembleMs + 1 }), false);
  assert.equal(v(good, wire, { ...side, over_budget_rulings: 1 }), false, 'a ruling the pinned units defeated');
  assert.equal(v(cell('hard', 'g', 0, { peak: 140000 }), wire, side, 'hard'), true, 'hard need not evict');
});

test('thresholds are pinned at their boundaries', () => {
  // Δ = −3 spread over three problems: no collapse rule to hide behind.
  const three = new Set(['p0', 'p4', 'p5']), two = new Set(['p0', 'p4']);
  assert.equal(analyze({ arms: arms({ softSolves: (id) => (three.has(id) ? 2 : 3) }), window: W }).verdict, 'REFUTED_AT_W');
  assert.equal(analyze({ arms: arms({ softSolves: (id) => (two.has(id) ? 2 : 3) }), window: W }).verdict, 'HELD');
  const withEngaged = (n) => { const a = arms(); a.soft.forEach((c, i) => { const on = i < n; c.ct.fired = on; c.ct.evicted_units = on ? 5 : 0; }); return analyze({ arms: a, window: W }).verdict; };
  assert.equal(withEngaged(7), 'VOID');
  assert.equal(withEngaged(8), 'HELD');
  assert.equal(analyze({ arms: arms({ softPeak: 110000 * 0.75 }), window: W }).verdict, 'HELD');
  assert.equal(analyze({ arms: arms({ softPeak: 110000 * 0.76 }), window: W }).verdict, 'HELD_NOT_MATERIAL');
});

test('an instrument that moved decides nothing', () => {
  assert.equal(analyzeRaw({ arms: arms(), window: W, historicalSolved: 27 - RULES.aaDrift }).verdict, 'DESCRIPTIVE_ONLY');
  assert.equal(analyzeRaw({ arms: arms(), window: W, historicalSolved: 27 - RULES.aaDrift + 1 }).verdict, 'HELD');
});

test('uneven unscored cells are a finding about the arm, not a refutation (rule 10)', () => {
  const a = arms();
  for (const c of a.soft.slice(0, 2)) Object.assign(c, { scored: false, exit_outcome: 'timeout', timed_out: true });
  const r = analyze({ arms: a, window: W });
  assert.equal(r.verdict, 'DESCRIPTIVE_ONLY');
  assert.equal(r.arms.soft.timeouts, 2);
});

test('instrument failures are owed again, never scored', () => {
  assert.equal(instrumentFailure({ killed_externally: true, steps: 9 }), 'killed externally');
  assert.match(instrumentFailure({ steps: 0, exit_outcome: 'nonzero_exit' }), /no model step/);
  assert.match(instrumentFailure({ steps: 3 }, { present: true, ok: 0 }), /never answered/);
  assert.equal(instrumentFailure({ steps: 3, pass: false, scored: false, exit_outcome: 'timeout' }, { present: true, ok: 12 }), null, 'a timeout is an outcome');
  const a = arms(); a.soft.pop();
  const r = analyze({ arms: a, window: W, owed: ['soft p9__r2 (killed externally)'] });
  assert.equal(r.verdict, 'INCOMPLETE');
  assert.match(r.why, /owed again/);
});

test('REFUTED names the plumbing when the matched control lost the same solves', () => {
  const a = arms({ softSolves: (id) => (id === 'p0' ? 0 : 3) });
  for (const c of a.hard.filter((x) => x.instance === 'p0')) c.pass = false;
  assert.match(analyze({ arms: a, window: W }).why, /PLUMBING/);
  assert.match(analyze({ arms: arms({ softSolves: (id) => (id === 'p0' ? 0 : 3) }), window: W }).why, /sweep moves UP/);
});

test('integrity: compaction in a ct cell, a shared device, a stray pool, a vacuous preflight', () => {
  assert.ok(cellProblems(cell('soft', 'p0', 0, { peak: 1, fired: true, over: { export_part_types: { compaction: 1 } } }), { arm: 'soft', window: W }).some((p) => /compaction/.test(p)));
  assert.ok(cellProblems(cell('off', 'p0', 0, { peak: 1, over: { other_opencode_runs_peak: 2 } }), { arm: 'off', window: W }).some((p) => /shared the device/.test(p)));
  assert.ok(cellProblems(cell('off', 'p0', 0, { peak: 1, over: { sandbox: { enabled: true, preflight: { a: true } } } }), { arm: 'off', window: W }).some((p) => /never checked/.test(p)));
  const few = cell('soft', 'p0', 0, { peak: 1, fired: true }); few.ct.plugin_errors = 4;
  assert.deepEqual(cellProblems(few, { arm: 'soft', window: W }), [], 'a few fail-open turns are the treatment, reported not refused');
  few.ct.plugin_errors = 5;
  assert.equal(cellProblems(few, { arm: 'soft', window: W }).length, 1);
  assert.equal(analyze({ arms: arms(), window: W, instances: ['p0'] }).verdict, 'INCOMPLETE');
});

test('wireStats and foreignLibraryReads read the run dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'u18-'));
  writeFileSync(join(dir, 'wire.jsonl'), [
    { status: 200, bytes: 10, counts: { tools: 0 } }, { status: 200, bytes: 500, counts: { tools: 1 } }, { status: 500, bytes: 900, counts: { tools: 1 } },
  ].map((r) => JSON.stringify(r)).join('\n'));
  assert.deepEqual(wireStats(dir), { present: true, requests: 2, ok: 1, rejected: 1, peak_bytes: 900 });
  assert.equal(wireStats(join(dir, 'nope')).present, false);
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ cmd: 'cat /v/lib/python3.9/site-packages/pip/_vendor/requests/models.py' }));
  assert.equal(foreignLibraryReads(dir, 'psf/requests').length, 1);
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ cmd: 'cat requests/models.py; ls /usr/lib/python3/dist-packages' }));
  assert.deepEqual(foreignLibraryReads(dir, 'psf/requests'), []);
});

test('signFlipP is exact and one-sided', () => {
  assert.equal(signFlipP([0, 0, 0]), 1);
  assert.equal(signFlipP([-1, -1, -1]), 1 / 8);
  assert.equal(signFlipP([1, 1, 1]), 1);
  assert.equal(signFlipP([-2, 1]), 2 / 4);
});

test('the pipeline knobs ARE the package registry; only the stated departures differ', async () => {
  const { PIPELINE_PARAMS, PIPELINE_DEFAULTS } = await import(new URL('../../packages/mcp/dist/index.js', import.meta.url).href);
  const k = resolveKnobs({});
  for (const spec of PIPELINE_PARAMS) {
    if (spec.env in U18_FIXED) { assert.ok(!KNOBS.some((x) => x.ct === spec.env), `${spec.env} is fixed, not a knob`); continue; }
    const knob = KNOBS.find((x) => x.ct === spec.env);
    assert.ok(knob, `${spec.env} is a knob with no edit here`);
    const packageDefault = spec.kind === 'bool' ? (spec.default ? '1' : '0') : String(spec.default);
    assert.equal(k[spec.env], U18_DEFAULTS[spec.env] ?? packageDefault, spec.env);
  }
  assert.deepEqual(U18_DEFAULTS, { CT_CT_ANCHOR: '3' });
  assert.equal(PIPELINE_DEFAULTS.anchor, 4, 'the package default is still 4; U18 runs at 3 on purpose');
  assert.equal(new Set(KNOBS.map((x) => x.ct)).size, KNOBS.length);
  assert.equal(new Set(KNOBS.map((x) => x.name)).size, KNOBS.length);
  // top_k was deleted once; it is a knob again, and so is what makes it matter.
  assert.deepEqual(['TOPK', 'W_RELEVANCE', 'UNIT', 'PROTECTION'].filter((n) => !KNOBS.some((x) => x.name === n)), []);
});

test('a knob that does not parse is refused, and so is a window that cannot work', () => {
  for (const bad of [{ U18_ANCHOR: '2.5' }, { U18_ANCHOR: 'three' }, { U18_W_DORMANCY: '-1' }, { U18_REDUCER: 'magic' }, { U18_DRIFT_K: '0' }, { U18_SOFT_TARGET_FRAC: '1.5' }, { U18_UNIT: 'message' }, { U18_PRIORITY_HALFLIFE: '0' }, { U18_WINDOW: '20000' }, { U18_WINDOW: '151040' }, { U18_HARD_WINDOW: '262144' }]) {
    assert.throws(() => resolveKnobs(bad), RangeError, JSON.stringify(bad));
  }
  assert.equal(resolveKnobs({ U18_ANCHOR: '0', U18_NEUTRAL_PHASES: 'none' }).CT_CT_ANCHOR, '0');
});

test('tags separate every setting an arm depends on, and nothing it does not', () => {
  const base = resolveKnobs({});
  assert.match(tagBase('soft', base), /^u18-soft-W50347-A3-[0-9a-f]{6}$/);
  assert.equal(tagBase('off', base), 'u18-off');
  const tags = (env) => ['soft', 'hard'].map((a) => tagBase(a, resolveKnobs(env)));
  const [soft, hard] = tags({});
  assert.notEqual(tags({ U18_ANCHOR: '4' })[0], soft);
  assert.notEqual(tags({ U18_W_DORMANCY: '2' })[1], hard, 'a weight moves the hard arm too');
  // The soft window is not something `hard` reads: a W sweep re-uses its cells.
  assert.deepEqual(tags({ U18_WINDOW: '75520' }).map((t, i) => t === [soft, hard][i]), [false, true]);
  assert.equal(armKnobs('hard', base).CT_CT_WINDOW, undefined);
});

test('a cell that ran under another config is an integrity problem', () => {
  const knobs = resolveKnobs({});
  const c = cell('soft', 'p0', 0, { peak: 1, fired: true });
  Object.assign(c.ct, armKnobs('soft', knobs));
  assert.deepEqual(cellProblems(c, { arm: 'soft', window: W, knobs }), []);
  c.ct.CT_CT_ANCHOR = '4';
  assert.match(cellProblems(c, { arm: 'soft', window: W, knobs })[0], /CT_CT_ANCHOR ran as "4"/);
});

test('served-per-heuristic is a per-turn distribution, and null when the join cannot be trusted', () => {
  const rows = [{ kept_tokens: 900 }, { kept_tokens: 10_000 }, { kept_tokens: 20_000 }, { kept_tokens: 40_000 }, { kept_tokens: 40_000 }];
  const served = [11_000, 22_000, 35_000, 59_000, 63_000];
  assert.deepEqual(servedPerHeuristic(rows, served), { aligned: true, turns: 4, min: 1.1, median: 1.2, max: 1.3, first_quartile_median: 1.1, last_quartile_median: 1.3 });
  assert.deepEqual(servedPerHeuristic(rows, served.slice(1)), { aligned: false, turns: 0 });
});

/** A recall-arm cell: soft trigger, stubs applied, optionally the agent's own recall calls. */
function recallCell(arm, instance, repeat, { pass = true, recalls = 0, over = {} } = {}) {
  const base = cell('soft', instance, repeat, { pass, peak: 45000, fired: true });
  return {
    ...base, mcp: { tools: recalls ? { 'context-tree_fetch': recalls } : {} },
    ct: { ...base.ct, stubs_folded: 9, reasoning_edited: 4, summaries_written: arm === 'summary' ? 2 : 0, arm_effective: { trigger: 'soft', softWindow: W, foldSummaries: arm === 'summary' } },
    ...over,
  };
}

test('the arms are a ladder: each sets one thing more, and recorded tags do not move', () => {
  const knobs = resolveKnobs({});
  assert.deepEqual(ARMS.soft.set, {});
  assert.equal(armKnobs('think', knobs).CT_CT_FOLD_REASONING_AFTER, '3');
  assert.equal(armKnobs('think', knobs).CT_CT_FOLD_TRIGGER, undefined, 'think does not fold under pressure');
  assert.equal(armKnobs('stub', knobs).CT_CT_FOLD_TRIGGER, 'pressure');
  assert.equal(armKnobs('stub', knobs).CT_CONTRACT, 'v5');
  assert.equal(armKnobs('stub', knobs).CT_CT_FOLD_SUMMARIES, undefined);
  assert.equal(armKnobs('summary', knobs).CT_CT_FOLD_SUMMARIES, '1');
  assert.equal(armKnobs('soft', knobs).CT_CT_FOLD_TRIGGER, undefined, 'what an arm IS is never a knob');
  assert.throws(() => armKnobs('nope', knobs), /unknown arm/);
  // Waves were recorded under these two tags before the fold parameters existed.
  assert.equal(tagBase('soft', knobs), 'u18-soft-W50347-A3-0b6139');
  assert.equal(tagBase('hard', knobs), 'u18-hard-A3-3b1020');
  assert.equal(new Set(['soft', 'hard', 'think', 'stub', 'summary'].map((a) => tagBase(a, knobs))).size, 5);
  // ...but a late knob moved OFF its default is part of the key like any other.
  assert.notEqual(tagBase('soft', resolveKnobs({ U18_FOLD_STUB_AT: '0.5' })), 'u18-soft-W50347-A3-0b6139');
});

test('an older cell that never recorded a late knob is not an integrity problem; a wrong value is', () => {
  const knobs = resolveKnobs({});
  const late = new Set(['CT_CT_FOLD_STUB_AT', 'CT_CT_CADENCE_N', 'CT_CT_FOLD_REASONING', 'CT_CT_FOLD_REASONING_TAIL', 'CT_CT_FOLD_SUMMARIZE_AT', 'CT_CT_FOLD_MIN_RUN', 'CT_CT_SUMMARY_RATIO', 'CT_CT_SUMMARY_MAX_TOKENS']);
  const recorded = Object.fromEntries(Object.entries(armKnobs('soft', knobs)).filter(([k]) => !late.has(k) && !k.includes('BOUNDARY') && !k.includes('COVARIANCE')));
  const old = cell('soft', 'p0', 0, { peak: 45000, fired: true });
  assert.deepEqual(cellProblems({ ...old, ct: { ...old.ct, ...recorded } }, { arm: 'soft', window: W, knobs }), []);
  assert.match(cellProblems({ ...old, ct: { ...old.ct, ...recorded, CT_CT_FOLD_STUB_AT: '0.5' } }, { arm: 'soft', window: W, knobs }).join(' '), /CT_CT_FOLD_STUB_AT ran as/);
  // Summaries belong to exactly one arm.
  assert.match(cellProblems(recallCell('summary', 'p0', 0), { arm: 'stub', window: W }).join(' '), /summaries ON/);
  assert.match(cellProblems(recallCell('stub', 'p0', 0), { arm: 'summary', window: W }).join(' '), /summaries off/);
});

test('gate: a cell too short to show anything fails, and a fold arm must have done what it is', () => {
  const wire = { present: true, requests: 80, ok: 80, rejected: 0, peak_bytes: 1 };
  const side = { max_ms: 900, over_ceiling_turns: 0, over_budget_rulings: 0 };
  const verdict = (c, arm) => gateVerdict(c, wire, side, { arm, window: W });
  // The cell that once passed `hard`: one step, nothing evicted, nothing wrong — and nothing shown.
  assert.match(verdict(cell('hard', 'g', 0, { peak: 13059, over: { steps: 1 } }), 'hard').reasons.join(' '), /too short/);
  assert.equal(verdict(recallCell('stub', 'g', 0), 'stub').pass, true);
  assert.match(verdict(recallCell('stub', 'g', 0), 'summary').reasons.join(' '), /summaries off/);
  const silent = recallCell('stub', 'g', 0);
  assert.match(verdict({ ...silent, ct: { ...silent.ct, stubs_folded: 0, fired: true, evicted_units: 3 } }, 'stub').reasons.join(' '), /no block was ever folded/);
  const unwritten = recallCell('summary', 'g', 0);
  assert.match(verdict({ ...unwritten, ct: { ...unwritten.ct, summaries_written: 0 } }, 'summary').reasons.join(' '), /no summary was ever written/);
  // think: no eviction at all, so no evict clauses; it must have folded reasoning and given window back.
  const think = { ...recallCell('think', 'g', 0), peak_prompt_tokens: 90_000 };
  think.ct = { ...think.ct, arm_effective: { trigger: 'off', softWindow: W, foldSummaries: false }, fired: true, evicted_units: 0 };
  assert.equal(verdict(think, 'think').pass, true);
  assert.match(verdict({ ...think, ct: { ...think.ct, reasoning_edited: 0 } }, 'think').reasons.join(' '), /no reasoning part was ever folded/);
  assert.match(verdict({ ...think, peak_prompt_tokens: 130_000 }, 'think').reasons.join(' '), /not below the control/);
});

test('a recall arm whose agent never recalled says nothing about recall', () => {
  const base = arms();
  const stub = (recalls) => IDS.flatMap((id, i) => [0, 1, 2].map((r) => recallCell('stub', id, r, { pass: id !== 'p9', recalls: i < recalls && r === 0 ? 2 : 0 })));
  const quiet = analyze({ arms: { ...base, stub: stub(0) }, window: W });
  assert.equal(quiet.recall.stub.exercised, false);
  assert.match(quiet.recall.stub.note, /RECALL NOT EXERCISED/);
  assert.equal(quiet.arms.stub.recall_tool_calls, 0);
  const used = analyze({ arms: { ...base, stub: stub(RULES.minRecallCells) }, window: W, finish: (c) => ({ last: c.arm === 'ct' && c.instance === 'p0' ? 'length' : 'stop' }) });
  assert.equal(used.recall.stub.exercised, true);
  assert.equal(used.arms.stub.recall_tool_calls, 2 * RULES.minRecallCells);
  assert.equal(used.recall.stub.vs_soft.delta_solved_itt, 0);
  assert.ok(used.arms.stub.cells_ended_at_output_cap > 0);
  // The registered ladder is untouched by the extra arm.
  assert.equal(used.verdict, analyze({ arms: base, window: W }).verdict);
  assert.equal(recallCalls({ mcp: { tools: { 'context-tree_evict': 3, 'context-tree_search': 1 } } }), 1);
});
