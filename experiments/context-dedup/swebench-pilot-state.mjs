/**
 * Resume state for the SWE-bench pilot, written when the agent vehicle changed from the
 * homegrown loop to opencode (D20). Data only, generated from PINNED files; a missing input
 * throws. The opencode run resumes from `selection.accepted` in drawn order.
 *
 *   node experiments/context-dedup/swebench-pilot-state.mjs
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports', 'metrics', 'swebench-pilot');
const load = (f) => {
  const p = join(OUT, f);
  if (!existsSync(p)) throw new Error(`state requires ${f}`);
  return JSON.parse(readFileSync(p, 'utf8'));
};

const arms = {
  'local GGUF, clip 2000': 'results-swebench-pilot-v1.json',
  'local GGUF, clip 30000': 'results-swebench-pilot-v2-clip30k.json',
  'OpenRouter qwen/qwen3.8-27b, clip 2000': 'results-swebench-pilot-or-clip2000.json',
  'OpenRouter qwen/qwen3.8-27b, clip 30000': 'results-swebench-pilot-or-clip30k.json',
};
const diagnosis = Object.entries(arms).map(([arm, file]) => {
  const cells = load(file).cells;
  return {
    arm, file, runs: cells.length,
    edited: cells.filter((c) => c.writes + c.edits > 0).length,
    f2p_fixed: cells.filter((c) => c.f2p_pass).length,
    p2p_kept: cells.filter((c) => c.p2p_pass).length,
    passed: cells.filter((c) => c.pass).length,
    max_prompt_tokens: cells.map((c) => c.max_prompt_tokens),
  };
});
const at = (clip) => diagnosis.filter((d) => d.arm.endsWith(`clip ${clip}`));
const sum = (ds, k) => ds.reduce((s, d) => s + d[k], 0);
const replay = load('results-replay-swebench-pilot-v1.json').runs;

const prereg = load('preregistration-multi-v2.json');
const verify = load('results-swebench-verify-pool-v2.json');
const selection = load('selection-v2.json');
const dev = load('selection-dev-2931.json');

const state = {
  written_at: new Date().toISOString(),
  status: 'PAUSED before any scored agent run: agent vehicle changing from the homegrown loop to opencode (D20)',
  vehicle_history: [
    { vehicle: 'experiments/coding-harness/lib.mjs runAgent (homegrown)', used_for: 'dev-instance diagnosis, local GGUF', status: 'retired' },
    { vehicle: 'experiments/context-dedup/swebench-agent.mjs runAgentClip (homegrown)', used_for: 'dev-instance clip diagnosis, local + OpenRouter', status: 'retired' },
    { vehicle: 'opencode', used_for: 'scored tranche', status: 'pending integration' },
  ],
  finding_about_homegrown_harness: {
    claim: 'The v1 zero-edit 0/3 on psf__requests-2931 was caused by the homegrown loop clipping tool output at 2,000 chars, not by the model or SWE-bench.',
    clip_2000: { runs: sum(at(2000), 'runs'), edited: sum(at(2000), 'edited'), endpoints: at(2000).map((d) => d.arm) },
    clip_30000: { runs: sum(at(30000), 'runs'), edited: sum(at(30000), 'edited'), f2p_fixed: sum(at(30000), 'f2p_fixed'), passed: sum(at(30000), 'passed') },
    replay_of_local_clip_2000: replay.map((r) => ({ repeat: r.repeat, clipped_outputs: r.clipped_outputs, longest_identical_visible_result_streak: r.longest_identical_visible_result_streak })),
    implication: 'A homegrown loop is the wrong measurement vehicle; its tool-output policy alone flipped editing from 0/6 to 5/6.',
  },
  diagnosis_arms: diagnosis,
  scored_agent_runs: 0,
  tranche_attempt_aborted: {
    log_note: 'first tranche launch was stopped during admission; it started no agent run',
    harness_defects_found_during_admission: [
      'django results are written to STDERR; a stdout-only capture of a passing run saw none',
      'pytest aborts (exit 4) when any passed id is not collectable; grading now runs test FILES',
      'SWE-bench records some pytest ids truncated at a space (its own parse_log_pytest); matching now uses that key too',
      'period pytest prints --version to STDERR (envcheck only)',
      'compiled-extension detection read the shared clone state instead of the commit; scikit-learn was never built',
    ],
  },
  draw: {
    prereg_file: 'preregistration-multi-v2.json', seed: prereg.seed, quota: prereg.quota, per_repo_cap: prereg.per_repo_cap,
    candidates: prereg.candidates.length, eligible_pool: prereg.eligible_pool_size,
    amendments: selection.selection.amendments,
  },
  verification: {
    file: 'results-swebench-verify-pool-v2.json',
    usable: verify.results.filter((r) => r.usable).length, total: verify.results.length,
    rejections: verify.results.filter((r) => !r.usable).map((r) => ({ instance_id: r.instance_id, repo: r.repo, stage: r.stage })),
  },
  selection: {
    file: 'selection-v2.json',
    checks: selection.manifest.checks, not_applied: selection.manifest.not_applied,
    accepted_in_drawn_order: selection.selection.accepted,
    rejected: selection.selection.rejected,
    skipped: selection.selection.skipped,
  },
  dev_instance_grader_recheck: { file: 'selection-dev-2931.json', admitted: dev.admitted, selftests: dev.selftests.map((s) => ({ instance: s.instance, grader_ok: s.grader_ok })) },
  resume: {
    run: 'selection.accepted_in_drawn_order, one opencode run per problem, uncapped, no eviction, no middleware',
    grade: 'ab-tasks/swebench.mjs gradeDetail on the workspace opencode edited (restores test files, applies test patch, F2P and P2P separately; void grades excluded)',
    gate: prereg.gate,
  },
};

const path = join(OUT, 'state-swebench-pilot.json');
writeFileSync(path, JSON.stringify(state, null, 2));
console.error(`wrote ${path}: accepted ${state.selection.accepted_in_drawn_order.length}, rejected ${state.selection.rejected.length}, clip2000 edited ${state.finding_about_homegrown_harness.clip_2000.edited}/${state.finding_about_homegrown_harness.clip_2000.runs}, clip30000 edited ${state.finding_about_homegrown_harness.clip_30000.edited}/${state.finding_about_homegrown_harness.clip_30000.runs}`);
