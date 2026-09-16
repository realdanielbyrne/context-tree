/**
 * Report for the SWE-bench Verified solvability pilot (backlog item 9's gate).
 *
 * Every number is interpolated from PINNED results files; a missing file or field throws.
 * One section list renders both formats, so the .md and .html section lists cannot drift.
 *
 * Rerun: node experiments/context-dedup/report-swebench-pilot.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson } from './stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'reports', 'metrics', 'swebench-pilot');

// ------------------------------------------------------------------ pinned inputs
const FILES = {
  localClip2000: 'results-swebench-pilot-v1.json',
  localClip2000Replay: 'results-replay-swebench-pilot-v1.json',
  localClip30k: 'results-swebench-pilot-v2-clip30k.json',
  orClip2000: 'results-swebench-pilot-or-clip2000.json',
  orClip30k: 'results-swebench-pilot-or-clip30k.json',
  verify1: 'results-swebench-verify-pool.json',
  prereg2: 'preregistration-multi-v2.json',
  verify2: 'results-swebench-verify-pool-v2.json',
  selection: 'selection-v2.json',
  probeKilled: 'results-swebench-opencode-probe-2931.json',
  probe: 'results-swebench-opencode-probe-2931-b.json',
  tranche: 'results-swebench-opencode-tranche.json',
  rerunKilled: 'results-swebench-opencode-rerun-11138-local.json',
  rerunKilledB: 'results-swebench-opencode-rerun-11138-local-b.json',
  rerunKilledC: 'results-swebench-opencode-rerun-11138-local-c.json',
  rerun: 'results-swebench-opencode-rerun-11138-local-d.json',
};
const load = (k) => {
  const p = join(OUT, FILES[k]);
  if (!existsSync(p)) throw new Error(`report requires ${FILES[k]}`);
  return JSON.parse(readFileSync(p, 'utf8'));
};
const D = Object.fromEntries(Object.keys(FILES).map((k) => [k, load(k)]));
const OPENCODE_CONFIG = JSON.parse(readFileSync(join(HERE, 'opencode.json'), 'utf8'));
const need = (o, k, ctx = '') => { if (o == null || !(k in o) || o[k] === undefined) throw new Error(`missing ${ctx}${k}`); return o[k]; };

// ------------------------------------------------------------------ helpers
const medRaw = (x) => { if (!x.length) throw new Error('median of empty'); const s = [...x].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const med = (x) => Math.round(medRaw(x));
const pct = (v, d = 0) => { if (!Number.isFinite(v)) throw new Error('pct of non-finite'); return `${(v * 100).toFixed(d)}%`; };
const k = (v) => { if (!Number.isFinite(v)) throw new Error('number expected'); return Math.round(v).toLocaleString('en-US'); };
const usd = (v) => { if (!Number.isFinite(v)) throw new Error('usd expected'); return `$${v.toFixed(2)}`; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const yn = (b) => (b ? 'yes' : 'no');
const ci = (x, n) => { if (!n) return '0/0 (no problems)'; const [lo, hi] = wilson(x, n); return `${x}/${n} (${pct(x / n)}; 95% CI ${pct(lo)}–${pct(hi)})`; };
const promptTotal = (c) => { const t = need(c, 'tokens', `${c.instance}.`); return t.input + t.cache_read + t.cache_write; };
const costOf = (c) => (Number.isFinite(c.cost_reported) && c.cost_reported > 0 ? c.cost_reported : (c.cost_list_price ?? 0));
const cfgLimit = (provider, model) => need(need(need(need(OPENCODE_CONFIG.provider, provider, 'provider.'), 'models', `${provider}.`), model, `${provider}.models.`), 'limit', `${model}.`);

// ------------------------------------------------------------------ homegrown-loop diagnosis (dev instance)
const ARMS = [
  { key: 'localClip2000', label: 'local GGUF, clip 2,000' },
  { key: 'localClip30k', label: 'local GGUF, clip 30,000' },
  { key: 'orClip2000', label: 'OpenRouter, clip 2,000' },
  { key: 'orClip30k', label: 'OpenRouter, clip 30,000' },
].map((a) => {
  const cells = need(D[a.key], 'cells', `${a.key}.`);
  if (cells.length !== 3) throw new Error(`${a.key}: expected 3 runs, got ${cells.length}`);
  return {
    ...a,
    edited: cells.filter((c) => c.writes + c.edits > 0).length,
    ranTests: cells.filter((c) => c.test_runs > 0).length,
    ownStop: cells.filter((c) => c.stop === 'end_turn').length,
    f2p: cells.filter((c) => c.f2p_pass).length,
    p2p: cells.filter((c) => c.p2p_pass).length,
    pass: cells.filter((c) => c.pass).length,
    turns: med(cells.map((c) => c.turns)),
    peak: med(cells.map((c) => c.max_prompt_tokens)),
  };
});
const armBy = Object.fromEntries(ARMS.map((a) => [a.key, a]));
const replayStreaks = need(D.localClip2000Replay, 'runs').map((r) => need(r, 'longest_identical_visible_result_streak'));
const replayClipped = need(D.localClip2000Replay, 'runs').map((r) => need(r, 'clipped_outputs'));
const edited2000 = armBy.localClip2000.edited + armBy.orClip2000.edited;
const edited30k = armBy.localClip30k.edited + armBy.orClip30k.edited;
const devCost = ['orClip2000', 'orClip30k'].reduce((s, key) => s + D[key].cells.reduce((t, c) => t + need(c, 'cost_usd'), 0), 0);

// ------------------------------------------------------------------ verification + selection
const v1 = need(D.verify1, 'results');
const v2 = need(D.verify2, 'results');
const prereg2 = D.prereg2;
const stageCounts = (rs) => rs.reduce((a, r) => ({ ...a, [r.stage]: (a[r.stage] || 0) + 1 }), {});
const sel = need(D.selection, 'selection');
const selMan = need(D.selection, 'manifest');
const amendments = need(sel, 'amendments');
const calibrated = need(selMan, 'calibrated_p2p');
const floor = need(selMan, 'p2p_min_coverage');
const floorAdmitted = Object.entries(calibrated).filter(([, c]) => c.coverage < 1).map(([id, c]) => ({ id, ...c }));
const checked = sel.accepted.length + sel.rejected.length;

// ------------------------------------------------------------------ opencode probe + tranche
const probeCells = need(D.probe, 'cells');
if (probeCells.length !== 1) throw new Error('probe: expected one run');
const probe = probeCells[0];
const killedCells = need(D.probeKilled, 'cells');
if (killedCells.length !== 1) throw new Error('killed probe: expected one run');
const killed = killedCells[0];
if (killed.scored !== false) throw new Error('first probe was expected to be an unscored (killed) run');

const T = D.tranche;
const tm = need(T, 'manifest');
const tCells = need(T, 'cells');
const PRESS = need(need(prereg2, 'gate'), 'pressure_thresholds_prompt_tokens');
const SWEEP_MIN = 13;
const accepted = sel.accepted.map((c) => c.instance_id);
const ranIds = [...new Set(tCells.map((c) => c.instance))];
const notRun = accepted.filter((id) => !ranIds.includes(id));
const scoredCells = tCells.filter((c) => c.scored);
const unscored = tCells.filter((c) => !c.scored);
const allRep = ranIds.map((id) => scoredCells.filter((c) => c.instance === id).sort((a, b) => a.repeat - b.repeat)[0]).filter(Boolean);

// A run cut off by the host's CONFIGURED per-response cap did not get to attempt the task: it
// is INVALID (harness configuration defect), not a failure. Reclassified after the tranche.
const capInvalid = allRep.filter((c) => need(c, 'ended_on_output_limit', `${c.instance}.`) === true);
const firstRep = allRep.filter((c) => !c.ended_on_output_limit);
const nProb = firstRep.length;
const solved = firstRep.filter((c) => c.pass);
const f2pOnly = firstRep.filter((c) => c.f2p_pass && !c.p2p_pass);
const zeroEdit = firstRep.filter((c) => c.files_edited.length === 0);
const solvedOverPrimary = solved.filter((c) => c.peak_prompt_tokens > PRESS.primary);
const solvedOverSecondary = solved.filter((c) => c.peak_prompt_tokens > PRESS.secondary);
const allOverPrimary = firstRep.filter((c) => c.peak_prompt_tokens > PRESS.primary);
const [jointLo, jointHi] = nProb ? wilson(solvedOverPrimary.length, nProb) : [0, 0];
const jointRate = nProb ? solvedOverPrimary.length / nProb : 0;
const admitRate = checked ? sel.accepted.length / checked : 0;
const eligiblePool = need(prereg2, 'eligible_pool_size');
const projected = eligiblePool * admitRate * jointRate;
const projectedHi = eligiblePool * admitRate * jointHi;
const projectedLo = eligiblePool * admitRate * jointLo;
const usable = projected >= SWEEP_MIN;
const usableAtLowerBound = projectedLo >= SWEEP_MIN;
const repos = [...new Set(firstRep.map((c) => c.repo))].sort();
const perRepo = repos.map((r) => { const cs = firstRep.filter((c) => c.repo === r); return { repo: r, n: cs.length, solved: cs.filter((c) => c.pass).length }; });
const strata = ['<15 min fix', '15 min - 1 hour', '1-4 hours', '>4 hours'].map((d) => { const cs = firstRep.filter((c) => c.difficulty === d); return { d, n: cs.length, solved: cs.filter((c) => c.pass).length }; }).filter((s) => s.n);
// Sensitivity: count the cap-invalid run(s) as failures, as the pre-registered rules first did.
const solvedAll = allRep.filter((c) => c.pass).length;
const jointAll = allRep.filter((c) => c.pass && c.peak_prompt_tokens > PRESS.primary).length;

const overhead = med(tCells.filter((c) => c.first_step_prompt_tokens > 0).map((c) => c.first_step_prompt_tokens).concat(probe.first_step_prompt_tokens > 0 ? [probe.first_step_prompt_tokens] : []));
const totalCost = tCells.reduce((s, c) => s + costOf(c), 0);
const reasoningTokens = tCells.reduce((s, c) => s + c.tokens.reasoning, 0);
const outputTokens = tCells.reduce((s, c) => s + c.tokens.output, 0);
const version = need(tm, 'opencode_version');
const capValue = capInvalid.length ? need(capInvalid[0], 'max_step_response_tokens', `${capInvalid[0].instance}.`) : null;
const validByResponse = [...firstRep].sort((a, b) => need(b, 'max_step_response_tokens', `${b.instance}.`) - need(a, 'max_step_response_tokens', `${a.instance}.`));
const largestValid = validByResponse[0];
// The SPLIT of the capped step, not just its size: `output: 0` with the whole budget in
// `reasoning` is what made the run read as an ordinary failure rather than a truncation.
const lsr = capInvalid.length ? need(capInvalid[0], 'length_stop_response', `${capInvalid[0].instance}.`) : null;
// Reasoning is NOT a subset of output on OpenRouter — it is reported in its own field. Any cell
// whose reasoning exceeds its output proves that directly; the largest gap is cited.
const reasoningOverOutput = tCells
  .filter((c) => c.tokens.reasoning > c.tokens.output)
  .sort((a, b) => (b.tokens.reasoning - b.tokens.output) - (a.tokens.reasoning - a.tokens.output))[0] ?? null;

// ------------------------------------------------------------------ local re-run of the cap-invalid problem
const rrCells = need(D.rerun, 'cells');
if (rrCells.length !== 1) throw new Error('rerun: expected one run');
const rr = rrCells[0];
// The re-run's settings come from ITS OWN manifest (recorded at run start), never from the
// config file as it is now: the file changed several times during the pilot.
const rrLimit = need(rr, 'model_config', 'rerun.');
if (rrLimit.configured !== true) throw new Error('rerun manifest has no configured model entry');
const rrThinkingOpt = rrLimit.options?.chat_template_kwargs?.enable_thinking;
const rrThinkingOff = rrThinkingOpt === false;
// Thinking is measured from the transcript's reasoning parts, NEVER from reasoning-token counts:
// the local host returns reasoning text while reporting reasoning_tokens as 0.
const rrReasoningParts = need(rr, 'reasoning_parts', 'rerun.');
const rrReasoningChars = need(rr, 'reasoning_chars', 'rerun.');
const rrThinkingText = rrThinkingOff
  ? 'off (configured `enable_thinking: false`)'
  : `on: no thinking option was set, and the transcript contains ${k(rrReasoningParts)} reasoning parts (${k(rrReasoningChars)} characters of reasoning text)`;
const rrThinkingDiffers = rrThinkingOff;
const rrDiffCount = rrThinkingDiffers ? 3 : 2;
// Killed attempts: cause CONFIRMED by the other session (a host-wide SIGTERM to every process
// named opencode between its own test runs). Invalid, not failures.
const KILL_CAUSE = 'another session on the host ran a cleanup that sent SIGTERM to every process named `opencode` between its own test runs (confirmed by that session)';
const killedAttempts = [
  ['probe', D.probeKilled, 'confirmed'],
  ['rerun a', D.rerunKilled, 'confirmed'],
  ['rerun b', D.rerunKilledB, 'confirmed'],
  ['rerun c', D.rerunKilledC, 'confirmed'],
].map(([label, doc, cause]) => {
  const cs = need(doc, 'cells', `${label}.`);
  if (cs.length !== 1) throw new Error(`${label}: expected one run`);
  if (cs[0].scored !== false || cs[0].signal !== 'SIGTERM') throw new Error(`${label}: expected an unscored SIGTERM-killed run`);
  return { label, c: cs[0], cause };
});
const rrKilledAttempts = killedAttempts.filter((a) => a.label.startsWith('rerun'));
// Current config (for the forward-looking caveat only).
const orLimit = cfgLimit('openrouter', 'qwen/qwen3.8-27b');
const orRouting = need(need(OPENCODE_CONFIG.provider.openrouter.models['qwen/qwen3.8-27b'], 'options', 'openrouter model.'), 'provider', 'openrouter model options.');

// Unpinned OpenRouter routing (tranche). Backend spread is an external fact, cited, not data.
const OR_ENDPOINTS = {
  source: 'OpenRouter /api/v1/models/qwen/qwen3.8-27b/endpoints, queried 2026-09-15',
  backends: 16, maxResponseMin: 32768, maxResponseMax: 235929, precisions: 'fp4 to bf16', contextMin: 65536, contextMax: 1000000,
};
const diagProviders = ['orClip2000', 'orClip30k'].flatMap((key) => D[key].cells.map((c) => need(c, 'providers', `${key}.`)));
const diagProviderSet = [...new Set(diagProviders.flat())].sort();
const diagMultiBackendRuns = diagProviders.filter((p) => p.length > 1).length;

// ------------------------------------------------------------------ charts (inline SVG)
function chartDiagnosis() {
  const W = 760, rowH = 58, padL = 190, padT = 64, H = padT + ARMS.length * rowH + 30, iw = W - padL - 50;
  const series = [
    { key: 'edited', label: 'runs that edited a file', color: '#3b6fb6' },
    { key: 'f2p', label: 'runs that fixed the failing test', color: '#d08c2c' },
    { key: 'pass', label: 'runs that fully passed', color: '#2e8b57' },
  ];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Homegrown-loop clip diagnosis">`;
  s += `<text x="12" y="22" font-size="14" font-weight="600" fill="#1b1c1e">Homegrown loop on the development instance (3 runs per arm)</text>`;
  series.forEach((se, i) => { s += `<rect x="${12 + i * 240}" y="36" width="12" height="12" fill="${se.color}"/><text x="${30 + i * 240}" y="46" font-size="11.5" fill="#44474b">${esc(se.label)}</text>`; });
  ARMS.forEach((a, i) => {
    const y = padT + i * rowH;
    s += `<text x="${padL - 10}" y="${y + 26}" font-size="12.5" text-anchor="end" fill="#1b1c1e">${esc(a.label)}</text>`;
    series.forEach((se, j) => {
      const w = (a[se.key] / 3) * iw;
      s += `<rect x="${padL}" y="${y + 4 + j * 15}" width="${iw}" height="12" fill="#eceff1"/>`;
      s += `<rect x="${padL}" y="${y + 4 + j * 15}" width="${w.toFixed(1)}" height="12" fill="${se.color}"/>`;
      s += `<text x="${padL + iw + 6}" y="${y + 14 + j * 15}" font-size="11" fill="#44474b">${a[se.key]}/3</text>`;
    });
  });
  return s + '</svg>';
}

function chartPressure() {
  const W = 760, rowH = 22, padL = 260, padT = 60, n = Math.max(1, firstRep.length), H = padT + n * rowH + 40, iw = W - padL - 40;
  const max = Math.max(PRESS.primary * 1.25, ...firstRep.map((c) => c.peak_prompt_tokens), 1);
  const x = (v) => padL + (v / max) * iw;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Peak prompt size per validly run problem">`;
  s += `<text x="12" y="22" font-size="14" font-weight="600" fill="#1b1c1e">Largest prompt per validly run problem (provider-reported tokens, opencode)</text>`;
  s += `<text x="12" y="40" font-size="11.5" fill="#44474b">Filled dot = solved. Dashed: ${k(PRESS.secondary)}, ${k(PRESS.primary)} (primary). Grey band: opencode's fixed per-call overhead (${k(overhead)}).</text>`;
  s += `<rect x="${padL}" y="${padT - 6}" width="${(x(overhead) - padL).toFixed(1)}" height="${n * rowH + 6}" fill="#f1f3f4"/>`;
  for (const t of [PRESS.secondary, PRESS.primary]) s += `<line x1="${x(t).toFixed(1)}" y1="${padT - 6}" x2="${x(t).toFixed(1)}" y2="${padT + n * rowH}" stroke="#9aa0a6" stroke-dasharray="4 3"/>`;
  [...firstRep].sort((a, b) => a.peak_prompt_tokens - b.peak_prompt_tokens).forEach((c, i) => {
    const y = padT + i * rowH + 12;
    s += `<text x="${padL - 10}" y="${y + 4}" font-size="11" text-anchor="end" fill="#1b1c1e">${esc(c.instance)}</text>`;
    s += `<line x1="${padL}" y1="${y}" x2="${padL + iw}" y2="${y}" stroke="#e3e6e8"/>`;
    s += `<circle cx="${x(c.peak_prompt_tokens).toFixed(1)}" cy="${y}" r="5" fill="${c.pass ? '#2e8b57' : '#ffffff'}" stroke="${c.pass ? '#2e8b57' : '#b3261e'}" stroke-width="1.5"/>`;
  });
  s += `<text x="${padL}" y="${H - 12}" font-size="11" fill="#44474b">0</text><text x="${padL + iw}" y="${H - 12}" font-size="11" text-anchor="end" fill="#44474b">${k(max)}</text>`;
  return s + '</svg>';
}

// ------------------------------------------------------------------ content
const P = (t) => ({ p: t });
const TABLE = (head, rows) => ({ table: { head, rows } });
const UL = (items) => ({ ul: items });
const SVG = (svg) => ({ svg });

const verdictSentence = usable
  ? `projected ${projected.toFixed(1)} usable problems against the ${SWEEP_MIN} a sweep needs (${projectedLo.toFixed(1)} at the lower end of the interval, ${usableAtLowerBound ? 'still above' : 'below'} that bar)`
  : `projected ${projected.toFixed(1)} usable problems against the ${SWEEP_MIN} a sweep needs (${projectedHi.toFixed(1)} at the upper end of the interval)`;
const rrOutcome = rr.scored ? (rr.pass ? 'solved it' : `did not solve it (F2P ${yn(rr.f2p_pass)}, P2P ${yn(rr.p2p_pass)})`) : `produced no valid result (${rr.error ?? rr.grade_stage})`;

const sections = [
  {
    title: 'Abstract',
    blocks: [
      P(`Every live context-management experiment in this project has run on one synthetic task, so its repeats measure one problem's noise and not the variation between problems. SWE-bench Verified would fix that, but only if the model can solve real instances when given unlimited context, and only if solving them fills enough of the context window for a window policy to matter. This pilot tests both conditions with the Qwen3.8-27B model.`),
      P(`A first attempt, one instance run three times in an in-repo agent loop, failed with no file ever edited. That was a harness defect, not a verdict. The loop cut every tool result at 2,000 characters. Across two model endpoints, runs at that limit edited nothing (${edited2000}/6); runs at 30,000 characters edited in ${edited30k}/6. Following the project's own rule that evaluation runs in an external agent host (decision D20), the agent was moved to opencode ${version}. The problems were then drawn by a seeded, difficulty-stratified rule recorded before any agent ran, verified three ways, and screened against their gold fixes; ${sel.accepted.length} were accepted from ${new Set(sel.accepted.map((c) => c.repo)).size} repositories.`),
      P(`With opencode, uncapped, the model solved ${ci(solved.length, nProb)} of the validly run problems. ${capInvalid.length} further run (${capInvalid.map((c) => c.instance).join(', ')}) is invalid: a per-response output cap of ${k(capValue)} tokens, set as a placeholder in the pilot's own configuration, cut it off mid-reasoning before it could act. Re-run on the local model with that cap raised, it ${rrOutcome}; that run differs in ${rrDiffCount} ways from the others and is reported separately. Among solved problems, ${solvedOverPrimary.length} of ${solved.length} sent a prompt larger than ${k(PRESS.primary)} tokens; opencode alone adds about ${k(overhead)} tokens to every call. Verdict: ${verdictSentence}, so SWE-bench Verified with this model and host is ${usable ? '' : '**not** '}a usable substrate for the window and eviction experiments as run. Main limits: ${nProb} valid problems, one run each, several post-hoc (but pre-agent) amendments to the selection rule, unpinned OpenRouter routing whose serving backend (and so precision) is unknown for every run, and hosted weights that differ from the project's earlier local runs.`),
    ],
  },
  {
    title: 'What you need to know to read the rest',
    blocks: [TABLE(['Term', 'Meaning'], [
      ['agent', 'A language model plus a loop that lets it call tools (read, edit, run shell commands) until it stops.'],
      ['agent host / harness', 'The program that runs that loop. The scored runs use opencode, an external open-source coding agent; the diagnosis used an in-repo ("homegrown") loop.'],
      ['step', 'One model call inside a run.'],
      ['response', 'Everything the model generates on one step: visible output plus reasoning tokens.'],
      ['per-response output cap', 'The most tokens one response may contain. opencode takes it from `limit.output` in its configuration.'],
      ['context / prompt', 'Everything sent to the model on a step: the host\'s system prompt and tool definitions, the task, and the whole conversation so far.'],
      ['token', 'The unit models count text in; roughly four characters of English or code.'],
      ['peak prompt', 'The largest prompt of any step in a run, as reported by the provider (fresh plus cached input). The measure of context pressure.'],
      ['fixed overhead', 'The prompt size of a run\'s first step, dominated by the host\'s own instructions and tool definitions.'],
      ['window / cap', 'A limit on prompt size. A window policy decides what to drop when the conversation would exceed it; it can only matter if prompts get that large.'],
      ['eviction', 'Removing earlier parts of the conversation to fit a window.'],
      ['uncapped', 'No context window cap, no eviction, no middleware. (Distinct from the per-response output cap.)'],
      ['thinking / reasoning tokens', 'Output the model generates for its own deliberation before answering; opencode leaves this on by default.'],
      ['SWE-bench Verified', 'A public benchmark of 500 real GitHub issues from Python projects, each with a human-checked fix.'],
      ['instance / problem', 'One SWE-bench issue: a repository at a past commit, the issue text, a hidden gold fix and hidden tests.'],
      ['repeat', 'Running the same problem again. Repeats measure noise within a problem; distinct problems measure variation between problems.'],
      ['F2P (FAIL_TO_PASS)', 'Tests that fail before the fix and must pass after it.'],
      ['P2P (PASS_TO_PASS)', 'Tests that pass before the fix and must still pass after it.'],
      ['calibrated P2P', 'The P2P tests that pass with the gold fix in this environment; the ones used for grading here.'],
      ['pass', 'Every F2P test passes AND every calibrated P2P test passes.'],
      ['valid run', 'A run that exited cleanly, was graded, and was not cut off by a harness configuration limit before acting. Only valid runs count toward solve rates.'],
      ['gold patch', 'The real fix from the project\'s history. Never shown to the agent.'],
      ['three-way verification', 'F2P fails on the original code, passes with the gold patch, and P2P passes with the gold patch.'],
      ['tool-output clip', 'In the homegrown loop, the number of characters of a tool result the agent was shown.'],
      ['development instance', 'psf__requests-2931, the problem the harness was debugged on; held out of the scored set.'],
      ['stratum', 'A difficulty band from the dataset\'s own fix-time estimate.'],
      ['amendment', 'A change to the pre-registered selection rule, made after it was written but before any scored agent run.'],
      ['Wilson interval', 'A 95% confidence interval for a proportion that stays sensible at small counts and at 0% or 100%.'],
      ['void / errored run', 'A run whose grade could not be computed, or whose host run failed or timed out. Excluded from rates, never counted as a failure.'],
    ])],
  },
  {
    title: 'Why we ran this',
    blocks: [
      P('The project\'s window and eviction results all come from one synthetic build task. Repeats of one problem measure how much one agent varies on one task; they cannot measure variation across tasks, which is usually the larger source of variation for coding agents. The session handoff records this as constraint C0 and names SWE-bench Verified as the remedy.'),
      P('Two things could make SWE-bench useless for that purpose. The model might be unable to solve the problems even with unlimited context, so every policy would fail for reasons unrelated to context. Or it might solve them while keeping prompts small: agents with a shell tend to read only what they need (constraint C1), and a problem that never fills a window cannot tell window policies apart. The gate therefore has two parts, and a problem counts toward a usable substrate only if it passes both.'),
    ],
  },
  {
    title: 'The experimental setup',
    blocks: [
      P(`**The task.** opencode is started in a scratch copy of a repository at the commit where an issue was reported. Its message is the issue text word for word, with one framing line and a short note naming the project's Python interpreter and test runner. It is not told which file to change and never sees the gold patch or the tests; construction aborts if the prompt contains a graded test id, a failing test's name, or (in harness-written text) a line of either patch. It may edit any file; edits to test files are discarded before grading. After opencode exits, the hidden test patch is applied and F2P and calibrated P2P tests run with the project's own runner (pytest, or Django's runtests.py).`),
      P(`**The host.** opencode ${version}, model \`${tm.model}\` via OpenRouter, started with \`--pure\` (no plugins), \`--auto\` (tool permissions approved), its own tools and system prompt, thinking on by default, no tool-output clip, no context cap, no eviction, isolated state per run, and a ${k(tm.run_timeout_s)}-second wall-clock limit. During the tranche the pilot's opencode configuration gave the OpenRouter model a per-response output cap of ${k(capValue)} tokens, and routing was not pinned, so OpenRouter chose the serving backend per request; see What we got wrong.`),
      P(`**The substrate.** ${k(eligiblePool)} eligible instances across ${prereg2.eligible_repos.length} repositories (sympy and sphinx excluded: unsupported test runners; the development instance held out). With seed ${prereg2.seed}, each difficulty stratum's instances were shuffled per repository and taken round-robin across repositories: ${prereg2.candidates.length} candidates. Candidates were walked in drawn order and accepted while the stratum quota (${Object.entries(prereg2.quota).map(([s, q]) => `${s} ${q}`).join(', ')}) and a cap of ${prereg2.per_repo_cap} per repository (which also caps Django) allowed. ${amendments.length} amendments to that rule were made before any scored agent run; they are listed under What we got wrong.`),
      P('**What was varied.** Only the problem. Each accepted problem was run once. One problem whose run was invalidated was re-run once under a different configuration, reported separately.'),
      P('**What was recorded per run.** Pass, F2P and calibrated P2P separately; steps; tool calls by tool; files edited and read; the agent\'s diff; per-step tokens (fresh input, cached input, output, reasoning); peak prompt; largest single response; each step\'s finish reason; fixed overhead; provider-reported cost; wall time; exit status and errors; whether the run and the grade were valid; and the session export.'),
      P('**Why this substrate, and what it cannot show.** SWE-bench Verified gives many independent, human-checked problems with held-out tests, which a between-problem design needs. Ten problems cannot give a per-repository solve rate, and a non-Docker environment cannot reproduce every test the benchmark lists.'),
    ],
  },
  {
    title: 'Results',
    blocks: [
      P('**1. The first zero-edit result was the homegrown loop (diagnosis).**'),
      SVG(chartDiagnosis()),
      TABLE(['Arm (3 runs each)', 'Edited', 'Ran tests', 'Stopped on its own', 'F2P fixed', 'P2P kept', 'Passed', 'Median steps', 'Median peak prompt'],
        ARMS.map((a) => [a.label, `${a.edited}/3`, `${a.ranTests}/3`, `${a.ownStop}/3`, `${a.f2p}/3`, `${a.p2p}/3`, `${a.pass}/3`, k(a.turns), k(a.peak)])),
      P(`Replaying the local 2,000-character runs against a fresh copy of the repository reproduces what the agent was shown: ${replayClipped.join(', ')} of 50 tool results clipped, and runs of ${replayStreaks.join(', ')} consecutive identical visible results. The agent kept widening \`grep -A N\` on one function; past the clip every answer was the same. The same limit produced no edits on OpenRouter, so the contended local server and the quantized local weights do not explain it. This is a finding about the homegrown loop, not about SWE-bench or the model.`),
      P(`**2. opencode integration check (development instance).** A first check run was ended by \`${need(killed, 'signal')}\` after ${k(killed.wall_seconds)} seconds, mid-step (${k(killed.steps)} steps, ${k(killed.tool_calls)} tool calls, no edit). Cause: ${KILL_CAUSE}. The harness marked the run invalid and did not score it. Its export still imported into context-tree with no failures, mapping every tool part. The check was repeated.`),
      P(`Export and import on the repeat: the session export is ${k(need(probe, 'export_bytes'))} bytes; imported into context-tree it produced ${k(need(need(probe, 'context_tree_import'), 'events'))} trace events and ${k(probe.context_tree_import.file_nodes)} file nodes with ${k(probe.context_tree_import.failures)} failures and ${probe.context_tree_import.unmapped_tools.length} unmapped tools, so tool calls and results are mapped. Event stream complete against the export: ${yn(need(probe, 'events_complete'))}.`),
      P(`The repeat run made ${k(probe.tool_calls)} tool calls (${Object.entries(probe.tools_by_name).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}), edited ${probe.files_edited.length} file(s), and graded ${probe.grade_valid ? 'validly' : 'VOID'}: F2P ${yn(probe.f2p_pass)}, P2P ${yn(probe.p2p_pass)}. Peak prompt ${k(probe.peak_prompt_tokens)} tokens; first-step prompt ${k(probe.first_step_prompt_tokens)}.`),
      P('**3. Verification and selection are properties of the substrate.**'),
      TABLE(['Pool', 'Candidates', 'Verified three ways', 'Rejection stages'], [
        ['v1 draw (superseded)', k(v1.length), `${v1.filter((r) => r.usable).length}/${v1.length}`, Object.entries(stageCounts(v1.filter((r) => !r.usable))).map(([s, n]) => `${s}: ${n}`).join('; ')],
        ['v2 draw (scored)', k(v2.length), `${v2.filter((r) => r.usable).length}/${v2.length}`, Object.entries(stageCounts(v2.filter((r) => !r.usable))).map(([s, n]) => `${s}: ${n}`).join('; ') || 'none'],
      ]),
      P(`Walking the v2 draw: ${checked} candidates checked, ${sel.accepted.length} accepted, ${sel.rejected.length} rejected, ${sel.skipped.length} never checked because their stratum or repository was already full. The hardest stratum filled ${sel.accepted.filter((c) => c.stratum === 'H').length} of its ${prereg2.quota.H} slots.`),
      TABLE(['Rejected candidate', 'Repository', 'Reason'], sel.rejected.map((r) => [r.instance_id, r.repo, r.reason])),
      TABLE(['Accepted problem', 'Repository', 'Difficulty', 'Calibrated P2P'], sel.accepted.map((c) => { const cal = need(calibrated, c.instance_id, 'calibrated_p2p.'); return [c.instance_id, c.repo, c.difficulty, `${k(cal.effective_n)}/${k(cal.dataset_n)}`]; })),
      P('**4. Solvability on distinct problems (pre-registered).**'),
      TABLE(['Problem', 'Repo', 'Difficulty', 'Valid', 'Pass', 'F2P', 'P2P', 'Steps', 'Tool calls', 'Files edited', 'Files read', 'Peak prompt', 'Largest response', 'Total prompt', 'Reasoning', 'Cost', 'Wall s', 'Last step ended', 'Error'],
        allRep.map((c) => [c.instance, c.repo, c.difficulty, c.ended_on_output_limit ? 'no — output cap' : 'yes', yn(c.pass), yn(c.f2p_pass), yn(c.p2p_pass), k(c.steps), k(c.tool_calls), `${c.files_edited.length}`, `${c.files_read.length}`, k(c.peak_prompt_tokens), k(need(c, 'max_step_response_tokens', `${c.instance}.`)), k(promptTotal(c)), k(c.tokens.reasoning), usd(costOf(c)), k(c.wall_seconds), need(c, 'final_step_reason', `${c.instance}.`), c.error ?? ''])),
      P(`Pooled over validly run problems: solved ${ci(solved.length, nProb)}. Resampling unit: the problem. ${zeroEdit.length} valid run(s) edited no file; ${f2pOnly.length} fixed the reported bug but broke an existing test.`),
      P(`**Invalid run: per-response output cap.** ${capInvalid.map((c) => { const s = need(c, 'length_stop_response', `${c.instance}.`); return `${c.instance} made ${k(c.steps)} steps; its last step ended with finish reason \`length\`, reporting \`reasoning: ${k(s.reasoning)}\` and \`output: ${k(s.output)}\` — the entire budget went to thinking and **not one visible token was emitted**. opencode then exited normally with no edit`; }).join('; ')}. The limit was the \`limit.output\` placeholder in the pilot's own opencode configuration, not a property of the model or the task. It was first scored as a failure; that was wrong, and it is now excluded. The largest single response in any valid run was ${k(largestValid.max_step_response_tokens)} tokens (${largestValid.instance}), which finished normally, and no valid run ended on \`length\`.`),
      P(`**Sensitivity (post hoc).** Counting the invalid run as a failure, as first scored: solved ${ci(solvedAll, allRep.length)}; solved and above ${k(PRESS.primary)} tokens ${ci(jointAll, allRep.length)}. Valid runs: ${firstRep.map((c) => c.instance).join(', ')}. Invalid: ${capInvalid.map((c) => c.instance).join(', ')}.`),
      TABLE(['Repository (valid runs)', 'Problems', 'Solved'], perRepo.map((r) => [r.repo, k(r.n), ci(r.solved, r.n)])),
      TABLE(['Difficulty (valid runs)', 'Problems', 'Solved'], strata.map((s) => [s.d, k(s.n), ci(s.solved, s.n)])),
      unscored.length
        ? P(`${unscored.length} run(s) were not scored: ${unscored.map((c) => `${c.instance} (${c.error ?? c.grade_stage})`).join('; ')}.`)
        : P('No run errored and no grade was void.'),
      notRun.length ? P(`Accepted but not run: ${notRun.join(', ')}.`) : P('Every accepted problem was run.'),
      P('**5. Re-run of the invalidated problem (separate; not pooled).**'),
      P(`${rr.instance} was run once more with the cap out of the way. It is **not comparable** to the other runs and is not included in any rate above, because it differs on ${rrDiffCount} variables at once: (1) endpoint and weights — the local quantized GGUF (\`${rr.model}\`) instead of the hosted OpenRouter model; (2) per-response limit — ${k(need(rrLimit, 'limit_output'))} tokens instead of ${k(capValue)}${rrThinkingDiffers ? '; (3) thinking — off instead of on' : ''}. Thinking in the re-run was ${rrThinkingText}, as in the scored runs. It answers only whether this problem is solvable once the cap is not in the way.`),
      P(`${rrKilledAttempts.length} earlier re-run attempts were killed before finishing, and are invalid, not failures: ${rrKilledAttempts.map(({ label, c }) => `${label} after ${k(c.wall_seconds)} s (${k(c.steps)} steps, ${k(c.tool_calls)} tool calls, no edit)`).join('; ')}. Cause: ${KILL_CAUSE}. The table below is attempt ${String.fromCharCode(97 + rrKilledAttempts.length)}.`),
      TABLE(['Killed run', 'Signal', 'Ended (UTC)', 'Wall s', 'Steps', 'Other opencode runs live at start / peak', 'Cause'],
        killedAttempts.map(({ label, c, cause }) => [label, c.signal, c.ended_at ?? 'not recorded (runner predates this field)', k(c.wall_seconds), k(c.steps), c.other_opencode_runs_at_start == null ? 'not recorded' : `${k(c.other_opencode_runs_at_start)} / ${k(c.other_opencode_runs_peak)}`, cause])),
      P('Each kill came within seconds of that session launching its next opencode step, which is what identified the cause before it was confirmed. From the final attempt on, the "other opencode runs" counts include a decoy process placed on the host to identify the sender of any further kill; it is not a model client.'),
      TABLE(['Quantity', 'Value'], [
        ['Valid run', yn(rr.scored)],
        ['Other opencode runs live at start / peak', `${k(need(rr, 'other_opencode_runs_at_start', 'rerun.'))} / ${k(need(rr, 'other_opencode_runs_peak', 'rerun.'))}`],
        ['Pass', yn(rr.pass)],
        ['F2P fixed', yn(rr.f2p_pass)],
        ['P2P kept', yn(rr.p2p_pass)],
        ['Steps / tool calls', `${k(rr.steps)} / ${k(rr.tool_calls)}`],
        ['Files edited', rr.files_edited.length ? rr.files_edited.map((f) => f.split('/workspace/').pop()).join(', ') : 'none'],
        ['Peak prompt', k(rr.peak_prompt_tokens)],
        ['Largest single response', k(need(rr, 'max_step_response_tokens', 'rerun.'))],
        ['Steps ending on `length`', k(need(rr, 'length_stops', 'rerun.'))],
        ['Reasoning parts / characters (from the transcript)', `${k(rrReasoningParts)} / ${k(rrReasoningChars)}`],
        ['Visible text characters (from the transcript)', k(need(rr, 'text_chars', 'rerun.'))],
        ['Output tokens reported by the local host', `${k(rr.tokens.output)} (bundles reasoning; see caveats)`],
        ['Reasoning tokens as reported by the local host', `${k(rr.tokens.reasoning)} (not comparable; see caveats)`],
        ['Wall seconds', k(rr.wall_seconds)],
        ['Last step ended', need(rr, 'final_step_reason', 'rerun.')],
      ]),
      P('**6. Context pressure among solved problems (pre-registered).**'),
      SVG(chartPressure()),
      P(`Of ${solved.length} solved problem(s), ${solvedOverPrimary.length} exceeded ${k(PRESS.primary)} prompt tokens and ${solvedOverSecondary.length} exceeded ${k(PRESS.secondary)}. Across all ${nProb} validly run problems, ${allOverPrimary.length} exceeded ${k(PRESS.primary)}; median peak ${k(med(firstRep.map((c) => c.peak_prompt_tokens)))}. The primary threshold is the smallest context length commonly deployed for local models of this class; the secondary is the largest artificial cap the project's window sweeps used, and it now sits close to opencode's own fixed overhead of about ${k(overhead)} tokens per call.`),
      P('**7. The joint gate (pre-registered; computed over valid runs).**'),
      TABLE(['Quantity', 'Value'], [
        ['Problems both solved and above the primary threshold', ci(solvedOverPrimary.length, nProb)],
        ['Admission rate (accepted / checked candidates)', `${sel.accepted.length}/${checked} (${pct(admitRate)})`],
        ['Eligible pool', k(eligiblePool)],
        ['Projected usable problems (pool × admission × joint rate)', `${projected.toFixed(1)} (95% interval on the joint rate: ${projectedLo.toFixed(1)}–${projectedHi.toFixed(1)}; admission rate taken as a point estimate)`],
        ['Needed for a between-problem sweep', k(SWEEP_MIN)],
        ['Verdict', usable ? 'usable' : 'not usable as run'],
      ]),
      P(`Spend: ${usd(totalCost)} on the ${tCells.length} tranche runs and ${usd(devCost)} on the OpenRouter homegrown-loop diagnosis (provider-reported). These runs reported ${k(outputTokens)} output tokens and ${k(reasoningTokens)} reasoning tokens. **Those are two separate quantities, not a part and a whole:** through OpenRouter reasoning is reported in its own field and is *not* included in \`output\`${reasoningOverOutput ? `, which ${reasoningOverOutput.instance} shows directly — it reports ${k(reasoningOverOutput.tokens.reasoning)} reasoning against ${k(reasoningOverOutput.tokens.output)} output, impossible if one contained the other` : ''}. An earlier version of this line read "output tokens ${k(outputTokens)}, of which reasoning ${k(reasoningTokens)}", which is false on this endpoint. On the local endpoint the error runs the other way — there reasoning *is* bundled into \`output\`; see the re-run and the caveats.`),
    ],
  },
  {
    title: 'What we got wrong',
    blocks: [UL([
      'The pilot as first specified ran one instance three times. Three repeats of one problem is one problem: the same weakness (C0) SWE-bench was brought in to fix. It was replaced by a seeded draw of distinct problems.',
      `The first result, 0/3 with no edits, was drafted as a negative solvability verdict. It was a harness defect: the homegrown loop showed the agent at most 2,000 characters of any tool result, a size tuned to the synthetic task's small files. Across two endpoints, edits went from ${edited2000}/6 at that limit to ${edited30k}/6 at 30,000 characters.`,
      'The pilot measured with an in-repo agent loop, against the project\'s own decision D20 that evaluation runs in an external host. The scored runs were moved to opencode. The homegrown-loop results remain on disk, labelled by vehicle, and are used only for the diagnosis above.',
      `A per-response output cap of ${k(capValue)} tokens invalidated ${capInvalid.map((c) => c.instance).join(', ')}. The value was an undefended placeholder in \`limit.output\` of the pilot's own opencode configuration, copied from the local model entry into the OpenRouter entry. With thinking on, the model spent the whole budget reasoning in one step and opencode exited normally with no edit. This report first described that run as an ordinary failure and scored it; that classification was wrong. It is now invalid, the headline counts only valid runs (${solved.length}/${nProb}), and a separate re-run is reported with its differences stated.`,
      `The tranche ran with unpinned OpenRouter routing. OpenRouter serves \`qwen/qwen3.8-27b\` from ${OR_ENDPOINTS.backends} backends that differ in maximum response (${k(OR_ENDPOINTS.maxResponseMin)}–${k(OR_ENDPOINTS.maxResponseMax)} tokens), precision (${OR_ENDPOINTS.precisions}) and context (${k(OR_ENDPOINTS.contextMin)}–${k(OR_ENDPOINTS.contextMax)}) (${OR_ENDPOINTS.source}). opencode's export records only \`providerID: openrouter\`, so **the serving backend, and therefore the precision, is unknown for every scored run**, and may have changed between steps. The homegrown-loop diagnosis, which did record the backend per call, saw ${diagProviderSet.join(', ')} serve calls, with ${diagMultiBackendRuns} of ${diagProviders.length} runs switching backend mid-run. Because every backend allows at least ${k(OR_ENDPOINTS.maxResponseMin)} response tokens, the pilot's own ${k(capValue)} cap was the binding response limit in every run. The OpenRouter entry is now pinned to one backend and precision with no fallback.`,
      'The first draw (v1) was superseded before any agent ran on it. Most of its rejections were provisioner defects (unpinned current pytest and NumPy against period code, a pytest option older pytest rejects, an editable install without a modern build backend), not properties of the instances.',
      'Grader defects found during admission, each fixed before any scored run: Django writes test results to stderr, so a passing run looked empty; pytest aborts a whole run on one unresolvable test id, so grading now runs test files; SWE-bench records some pytest ids truncated at a space, so the grader matches that form; the period pytest prints its version to stderr; and scikit-learn\'s compiled extensions were not built because the check read the shared clone rather than the commit. The first tranche launch was stopped during admission because of these.',
      ...amendments.map((a) => `Selection amendment (${a.when}): ${a.rule}. Reason: ${a.why}.`),
      `The ≥${pct(floor)} calibrated-P2P floor is a post-hoc amendment to the gate. It was set after seeing one instance's ratio (requests-6028), mid-selection, before any agent result existed. It admitted ${floorAdmitted.length} problem(s) that would otherwise have been rejected: ${floorAdmitted.map((f) => `${f.id} (${k(f.effective_n)}/${k(f.dataset_n)})`).join(', ')}.`,
      `The first opencode runner captured \`opencode export\` and the event stream through pipes. opencode exits before flushing a large final write into a pipe, so the development-instance export arrived cut off at 146,176 of 430,431 bytes. The runner now writes to files. The scored runs had already started with pipe capture, so every session was re-exported to a file afterwards from its preserved session store, and each event stream was checked against its export: ${tCells.filter((c) => c.events_complete === true).length} of ${tCells.length} streams were complete${tCells.some((c) => c.events_complete !== true) ? `; incomplete: ${tCells.filter((c) => c.events_complete !== true).map((c) => c.instance).join(', ')} (their token and peak figures are lower bounds)` : ''}.`,
      'An arm with thinking enabled in the homegrown loop was started on the contended local server with the network timeout removed; one call hung for over 25 minutes and the arm was killed with no data. No conclusion about thinking mode is drawn from it.',
      'The first grader split pytest summary lines on whitespace, so a parametrised test id containing a space would have been scored missing and a correct fix failed; a unit test caught it before any scored run.',
    ])],
  },
  {
    title: 'Conclusions',
    blocks: [
      P(`**Established.** The zero-edit result on the development instance was caused by the homegrown loop's output clip, reproduced on two endpoints; it says nothing about SWE-bench or the model. With opencode, uncapped, the model solved ${pct(solved.length / nProb)} of ${nProb} validly run, distinct, verified problems (95% CI ${pct(wilson(solved.length, nProb)[0])}–${pct(wilson(solved.length, nProb)[1])}), and ${solvedOverPrimary.length} solved problem(s) exceeded ${k(PRESS.primary)} prompt tokens. One further problem's run was invalidated by the pilot's own output-cap placeholder; its separate re-run ${rrOutcome}, under a configuration not comparable to the rest.`),
      P(`**What it licenses.** ${usable ? 'Planning a between-problem window/eviction sweep on SWE-bench Verified with opencode, drawn from the same pool.' : 'Not starting a window/eviction sweep on SWE-bench Verified with this model and host: too few problems are both solved and large enough for a window to bind.'} Any future window experiment on opencode must set caps well above its ~${k(overhead)}-token fixed overhead, and must set the per-response output limit deliberately; the synthetic-task design with a 4,700-token cap cannot be reproduced on this host.`),
      P('**What it does not license.** It does not show the model cannot solve SWE-bench in general: the set is small and each problem ran once. It does not rank window policies. It is not comparable with the project\'s earlier local results, which used different weights and a different agent loop. Repositories that failed verification are untested, not rejected.'),
    ],
  },
  {
    title: 'Caveats',
    blocks: [UL([
      `${nProb} validly run distinct problems from ${repos.length} repositories, one run each; per-repository and per-difficulty rates rest on one or two problems.`,
      `Scored runs used \`${tm.model}\` through OpenRouter; provider precision differs from the project's local quantized model, providers can change between calls, and temperature is the host default, so runs are not reproducible bit for bit.`,
      `**Serving backend unknown.** All ${tCells.length} tranche runs used unpinned OpenRouter routing and their exports do not record the backend, so each run (possibly each step) may have been served at a different precision (${OR_ENDPOINTS.precisions}) with a different backend response cap; the data cannot tell which, and no per-run backend is estimated here.`,
      `The OpenRouter entry in experiments/context-dedup/opencode.json has since been pinned (\`provider.order: ${JSON.stringify(orRouting.order)}\`, \`quantizations: ${JSON.stringify(orRouting.quantizations)}\`, \`allow_fallbacks: ${orRouting.allow_fallbacks}\`) with \`limit.output: ${k(orLimit.output)}\` taken from that backend's published maximum. Every future OpenRouter run must use the pinned entry and record \`provider.order\`, \`quantizations\` and \`limit.output\` in its manifest; none of the scored runs here did.`,
      `The re-run of ${rr.instance} used a per-response limit of ${k(need(rrLimit, 'limit_output'))}. When the local host's limit was raised, it also accepted a request one token above the configured maximum, so it likely clamps silently rather than rejecting; the effective limit there is the host's, not the configuration's.`,
      `**The local endpoint reports \`reasoning_tokens: 0\` and bundles reasoning into \`output\`, and the bundling is most of the number.** The tokens are not missing, they are re-attributed, which is harder to catch than a zero because nothing reads as empty. Measured on the ${rr.instance} re-run: ${k(rr.tokens.output)} output tokens reported and ${k(rr.tokens.reasoning)} reasoning tokens, against ${k(rrReasoningChars)} characters of reasoning text in ${k(rrReasoningParts)} parts and only ${k(need(rr, 'text_chars', 'rerun.'))} characters of visible text — far too little text to account for ${k(rr.tokens.output)} tokens at any characters-per-token ratio, so the overwhelming majority of that "output" is thinking. Consequences: local \`output_tokens\` must never be read as content (a token-savings claim resting on it would overstate content by about an order of magnitude), reasoning-token totals are not comparable between the local endpoint and OpenRouter (which reports them separately), and whether a run reasoned is measured from its transcript's reasoning parts.`,
      `The re-run of ${rr.instance} changed ${rrThinkingDiffers ? 'endpoint and weights, per-response limit, and thinking' : 'endpoint and weights, and per-response limit'} at once; its outcome cannot be attributed to any one of them and is not pooled with the other runs. It shared the local host with other sessions (up to 4 concurrent connections are served).`,
      `Process note: the finalize step (re-export, event check, context-tree import) was executed once more by accident at 15:54 when another session imported the script to inspect it. It is idempotent: it rebuilds from the untouched worker result files and run directories and clears each context-tree store before importing, so only timestamps changed; the tranche file was re-checked afterwards (${tCells.length} cells, ${tCells.filter((c) => c.events_complete === true).length} complete event streams, ${tCells.filter((c) => c.context_tree_import?.ok === true).length} clean imports). The script now has a main guard.`,
      `${killedAttempts.length} opencode runs in this pilot (the first development-instance check and ${rrKilledAttempts.length} re-run attempts) were killed by an external SIGTERM; for all ${killedAttempts.filter((a) => a.cause === 'confirmed').length} the cause is confirmed: ${KILL_CAUSE}. The last of these came after that session believed it had stopped: a background batch it thought was gone was still running and executed its kill loops. All were voided and repeated, never scored.`,
      'opencode makes a model call during start-up (session titling) before a session exists. If all 4 connection slots on the local host are in use, a run hangs silently at start-up with no error; local-slot exhaustion is invisible through opencode.',
      'opencode also calls a separate small model (`openrouter/google/gemini-3.8-flash`) to title each session; it does not act in the workspace, but it is an extra model call in every run.',
      `The vehicle is opencode ${version}, which is a deployment host, but with isolated state, \`--auto\` permissions, and a scratch copy of the repository with the project interpreter placed first on PATH.`,
      'Grading uses calibrated P2P: tests that do not pass with the gold patch in this non-Docker environment are dropped, so a regression in one of them would go undetected.',
      'The selection rule was amended three times before any scored run, and one run was reclassified as invalid after the tranche; each change is listed above with its reason.',
      `With thinking on, a single step can spend a whole per-response budget on reasoning and opencode then ends the session with a normal exit.${lsr ? ` On ${capInvalid[0].instance} that step reported \`output: ${k(lsr.output)}\` and \`reasoning: ${k(lsr.reasoning)}\`: not one visible token was emitted, which is why the run read as an ordinary short failure rather than a truncation.` : ''} The runner now records each step's finish reason, the largest response, and the output/reasoning split of any length stop, so such stops are detectable.`,
      'The host is shared: one opencode run was killed by a signal from outside the harness. Runs record whether a kill was external and how many other opencode runs were active; an externally killed run is never scored.',
      'Pressure is the largest provider-reported prompt, including cached input. It says whether a window would bind, not which content a policy would need to keep.',
      'The pressure thresholds and the 13-problem sweep size are pre-registered judgments; the verdict is stated against them explicitly.',
      'The Wilson interval is the shared implementation in experiments/context-dedup/stats.mjs, cross-checked against statsmodels `proportion_confint(method="wilson")` on six (successes, n) pairs including 0/n and n/n; the largest difference was below 1e-5.',
    ])],
  },
];

// ------------------------------------------------------------------ render
const inlineHtml = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');

let MD = `# SWE-bench Verified solvability pilot\n\n`;
for (const s of sections) {
  MD += `## ${s.title}\n\n`;
  for (const b of s.blocks) {
    if (b.p) MD += `${b.p}\n\n`;
    else if (b.ul) MD += b.ul.map((i) => `- ${i}`).join('\n') + '\n\n';
    else if (b.table) {
      const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      MD += `| ${b.table.head.map(cell).join(' | ')} |\n| ${b.table.head.map(() => '---').join(' | ')} |\n`;
      MD += b.table.rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n') + '\n\n';
    } else if (b.svg) MD += `_(chart in the HTML version)_\n\n`;
  }
}

let HTML = `<title>SWE-bench Verified solvability pilot</title><style>
:root{--bg:#fbfbfa;--fg:#1b1c1e;--line:#dadce0;--card:#ffffff}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding-inline:16px}
main{max-width:980px;margin:0 auto;padding-block:32px}
h1{font-size:28px;margin:0 0 8px}h2{font-size:20px;margin:36px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
p{margin:0 0 12px}ul{padding-left:22px}li{margin-bottom:8px}code{background:#f1f3f4;padding:1px 4px;border-radius:3px;font-size:13px}
.tw{overflow-x:auto;margin:0 0 16px}table{border-collapse:collapse;font-size:13px;min-width:100%}
th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}th{background:#f1f3f4}
figure{margin:8px 0 18px;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;overflow-x:auto}
</style><main><h1>SWE-bench Verified solvability pilot</h1>`;
for (const s of sections) {
  HTML += `<h2>${esc(s.title)}</h2>`;
  for (const b of s.blocks) {
    if (b.p) HTML += `<p>${inlineHtml(b.p)}</p>`;
    else if (b.ul) HTML += `<ul>${b.ul.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</ul>`;
    else if (b.table) HTML += `<div class="tw"><table><thead><tr>${b.table.head.map((h) => `<th>${inlineHtml(h)}</th>`).join('')}</tr></thead><tbody>${b.table.rows.map((r) => `<tr>${r.map((v) => `<td>${inlineHtml(String(v))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    else if (b.svg) HTML += `<figure>${b.svg}</figure>`;
  }
}
HTML += '</main>';

for (const [name, text] of [['md', MD], ['html', HTML]]) {
  if (/undefined|NaN/.test(text)) throw new Error(`report .${name} contains undefined/NaN`);
}
const mdSections = [...MD.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
const htmlSections = [...HTML.matchAll(/<h2>(.+?)<\/h2>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
if (mdSections.join('|') !== htmlSections.join('|')) throw new Error('section lists differ between md and html');

writeFileSync(join(OUT, 'report-swebench-pilot.md'), MD);
writeFileSync(join(OUT, 'report-swebench-pilot.html'), HTML);
console.error(`wrote report-swebench-pilot.{md,html}: ${nProb} valid problems (+${capInvalid.length} invalid), solved ${solved.length}, joint ${solvedOverPrimary.length}, verdict ${usable ? 'usable' : 'not usable'}; rerun ${rr.instance} pass=${rr.pass}`);
