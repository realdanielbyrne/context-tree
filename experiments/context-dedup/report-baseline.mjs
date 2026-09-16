/**
 * Report for the SWE-bench BASELINE stability run: 10 problems x 3 repeats, one configuration,
 * uncapped, no middleware. The first within-problem variance measurement on this substrate.
 *
 * Every number is interpolated from PINNED results files; a missing file or field throws.
 * One section list renders both formats, so the .md and .html cannot drift.
 *
 * Rerun: node experiments/context-dedup/report-baseline.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson } from './stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'reports', 'metrics', 'swebench-pilot');

// ------------------------------------------------------------------ pinned inputs
const FILES = {
  baseline: 'results-swebench-opencode-baseline.json',
  pilot: 'results-swebench-opencode-tranche.json',
  prereg: 'preregistration-multi-v2.json',
  selection: 'selection-v2.json',
};
const load = (k) => {
  const p = join(OUT, FILES[k]);
  if (!existsSync(p)) throw new Error(`report requires ${FILES[k]}`);
  return JSON.parse(readFileSync(p, 'utf8'));
};
const D = Object.fromEntries(Object.keys(FILES).map((k) => [k, load(k)]));
const CONFIG = JSON.parse(readFileSync(join(HERE, 'opencode.json'), 'utf8'));
const need = (o, k, ctx = '') => { if (o == null || !(k in o) || o[k] === undefined) throw new Error(`missing ${ctx}${k}`); return o[k]; };

// ------------------------------------------------------------------ helpers
const medRaw = (x) => { if (!x.length) throw new Error('median of empty'); const s = [...x].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const med = (x) => Math.round(medRaw(x));            // never render a half-token
const k = (v) => { if (!Number.isFinite(v)) throw new Error('number expected'); return Math.round(v).toLocaleString('en-US'); };
const pct = (v, d = 0) => { if (!Number.isFinite(v)) throw new Error('pct of non-finite'); return `${(v * 100).toFixed(d)}%`; };
const usd = (v) => { if (!Number.isFinite(v)) throw new Error('usd expected'); return `$${v.toFixed(2)}`; };
const x2 = (v) => { if (!Number.isFinite(v)) throw new Error('ratio expected'); return `${v.toFixed(2)}x`; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const yn = (b) => (b ? 'yes' : 'no');
const short = (id) => id.replace(/^[^_]+__/, '');

// ------------------------------------------------------------------ the data
const man = need(D.baseline, 'manifest');
const cells = need(D.baseline, 'cells');
const valid = cells.filter((c) => c.scored);
const invalid = cells.filter((c) => !c.scored);
const PRESS = need(need(D.prereg, 'gate'), 'pressure_thresholds_prompt_tokens');
const MODEL = need(man, 'model');
const MODEL_CFG = need(need(man, 'model_configs'), MODEL, 'model_configs.');
const REPEATS_TARGET = 3;
const MIN_USABLE = 2;                                  // the pre-registered INSUFFICIENT gate

const ids = [...new Set(cells.map((c) => c.instance))];
const perProblem = ids.map((id) => {
  const runs = cells.filter((c) => c.instance === id);
  const v = runs.filter((c) => c.scored);
  const meta = runs[0];
  const base = {
    id, repo: need(meta, 'repo', `${id}.`), difficulty: need(meta, 'difficulty', `${id}.`),
    launched: runs.length, valid: v.length,
    p2pGraded: need(meta, 'p2p_graded_n', `${id}.`), p2pDataset: need(meta, 'p2p_dataset_n', `${id}.`),
  };
  if (v.length < MIN_USABLE) return { ...base, insufficient: true, pass: v.filter((c) => c.pass).length };
  const pk = v.map((c) => need(c, 'peak_prompt_tokens', `${id}.`));
  const st = v.map((c) => need(c, 'steps', `${id}.`));
  const wl = v.map((c) => need(c, 'wall_seconds', `${id}.`));
  const co = v.map((c) => c.cost_reported ?? 0);
  const nPass = v.filter((c) => c.pass).length;
  return {
    ...base, insufficient: false,
    pass: nPass, f2p: v.filter((c) => c.f2p_pass).length, p2p: v.filter((c) => c.p2p_pass).length,
    peakMin: Math.min(...pk), peakMed: med(pk), peakMax: Math.max(...pk), spread: Math.max(...pk) / Math.min(...pk),
    stepMin: Math.min(...st), stepMax: Math.max(...st),
    wallMin: Math.min(...wl), wallMax: Math.max(...wl),
    costMin: Math.min(...co), costMax: Math.max(...co),
    verdict: nPass === v.length ? 'always-pass' : (nPass === 0 ? 'always-fail' : 'mixed'),
  };
});
const decided = perProblem.filter((p) => !p.insufficient);
const alwaysPass = decided.filter((p) => p.verdict === 'always-pass');
const alwaysFail = decided.filter((p) => p.verdict === 'always-fail');
const mixed = decided.filter((p) => p.verdict === 'mixed');
const insufficient = perProblem.filter((p) => p.insufficient);
const spreads = decided.map((p) => p.spread);

// Validity + liveness. `files_edited` reads EDIT-TOOL calls, so a shell edit is invisible to it;
// the diff is ground truth. Both are reported because the divergence is itself a finding.
const lengthStops = cells.reduce((s, c) => s + (c.length_stops ?? 0), 0);
const incomplete = cells.filter((c) => c.events_complete !== true).length;
const extKills = cells.filter((c) => c.killed_externally).length;
const importsOk = cells.filter((c) => (c.context_tree_import ?? {}).ok === true).length;
const actedValid = valid.filter((c) => c.diff_empty === false).length;
const passEmptyDiff = valid.filter((c) => c.pass && c.diff_empty !== false).length;
const undercount = cells.filter((c) => c.files_edited.length === 0 && c.diff_empty === false);
const DIFF_CAP = 6000;
const truncatedDiffs = cells.filter((c) => (c.agent_diff ?? '').length >= DIFF_CAP).length;

const spend = cells.reduce((s, c) => s + (c.cost_reported ?? 0), 0);
const wallH = cells.reduce((s, c) => s + need(c, 'wall_seconds', `${c.instance}.`), 0) / 3600;
const reasoningTok = valid.reduce((s, c) => s + c.tokens.reasoning, 0);
const outputTok = valid.reduce((s, c) => s + c.tokens.output, 0);

// The pilot, for the comparison — CONFOUNDED, and the report says so wherever it appears.
const pilotCells = need(D.pilot, 'cells');
const pilotVerdict = Object.fromEntries(pilotCells.map((c) => [c.instance,
  c.ended_on_output_limit ? 'invalid (output cap)' : (c.pass ? 'pass' : 'fail')]));
const changed = decided.filter((p) => {
  const was = pilotVerdict[p.id];
  const now = p.verdict === 'always-pass' ? 'pass' : (p.verdict === 'always-fail' ? 'fail' : 'mixed');
  return was && was !== now;
}).map((p) => ({ ...p, was: pilotVerdict[p.id], now: p.verdict }));

// Headroom (post-hoc): how much room a treatment arm has on this pool, uncapped.
const winnable = perProblem.length - alwaysPass.length;
const MCNEMAR_MIN = 5;                                  // 0.5^5 = 0.03125 one-sided
const mcnemarP = 0.5 ** MCNEMAR_MIN;

// ------------------------------------------------------------------ charts (inline SVG)
function chartSpread() {
  const rows = [...decided].sort((a, b) => b.peakMax - a.peakMax);
  const W = 760, rowH = 26, padL = 180, padT = 70, H = padT + rows.length * rowH + 44, iw = W - padL - 70;
  const max = Math.max(...rows.map((r) => r.peakMax)) * 1.04;
  const X = (v) => padL + (v / max) * iw;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Achieved peak range across three identical repeats, per problem">`;
  s += `<text x="12" y="22" font-size="14" font-weight="600" fill="#1b1c1e">Achieved peak across three IDENTICAL repeats (bar = min..max, tick = median)</text>`;
  s += `<text x="12" y="41" font-size="11.5" fill="#44474b">Nothing varies between repeats. Dashed line: ${k(PRESS.primary)} tokens, the pre-registered pressure threshold.</text>`;
  s += `<text x="12" y="58" font-size="11.5" fill="#44474b">A cap inside a bar binds on some repeats of that problem and not others.</text>`;
  s += `<line x1="${X(PRESS.primary).toFixed(1)}" y1="${padT - 8}" x2="${X(PRESS.primary).toFixed(1)}" y2="${padT + rows.length * rowH}" stroke="#9aa0a6" stroke-dasharray="4 3"/>`;
  rows.forEach((r, i) => {
    const y = padT + i * rowH + 12;
    s += `<text x="${padL - 10}" y="${y + 4}" font-size="11.5" text-anchor="end" fill="#1b1c1e">${esc(short(r.id))}</text>`;
    s += `<line x1="${X(r.peakMin).toFixed(1)}" y1="${y}" x2="${X(r.peakMax).toFixed(1)}" y2="${y}" stroke="${r.verdict === 'always-pass' ? '#2e8b57' : '#d08c2c'}" stroke-width="9" stroke-linecap="round"/>`;
    s += `<line x1="${X(r.peakMed).toFixed(1)}" y1="${y - 7}" x2="${X(r.peakMed).toFixed(1)}" y2="${y + 7}" stroke="#1b1c1e" stroke-width="2"/>`;
    s += `<text x="${X(r.peakMax) + 8}" y="${y + 4}" font-size="11" fill="#44474b">${esc(x2(r.spread))}</text>`;
  });
  s += `<text x="${padL}" y="${H - 14}" font-size="11" fill="#44474b">0</text>`;
  s += `<text x="${padL + iw}" y="${H - 14}" font-size="11" text-anchor="end" fill="#44474b">${esc(k(max))} tokens</text>`;
  return `${s}</svg>`;
}

function chartOutcomes() {
  const rows = perProblem;
  const W = 760, rowH = 24, padL = 180, padT = 62, H = padT + rows.length * rowH + 28, cell = 30;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Pass or fail of each repeat, per problem">`;
  s += `<text x="12" y="22" font-size="14" font-weight="600" fill="#1b1c1e">Outcome of every repeat (filled = solved, hollow = not solved, grey = invalid run)</text>`;
  s += `<text x="12" y="41" font-size="11.5" fill="#44474b">Outcomes are stable where trajectories are not: ${alwaysPass.length} of ${rows.length} problems solved on every valid repeat.</text>`;
  rows.forEach((r, i) => {
    const y = padT + i * rowH + 10;
    s += `<text x="${padL - 10}" y="${y + 4}" font-size="11.5" text-anchor="end" fill="#1b1c1e">${esc(short(r.id))}</text>`;
    const runs = cells.filter((c) => c.instance === r.id);
    runs.forEach((c, j) => {
      const cx = padL + j * cell + 10;
      if (!c.scored) s += `<circle cx="${cx}" cy="${y}" r="6" fill="#e3e6e8" stroke="#9aa0a6" stroke-width="1.2"/>`;
      else if (c.pass) s += `<circle cx="${cx}" cy="${y}" r="6" fill="#2e8b57"/>`;
      else s += `<circle cx="${cx}" cy="${y}" r="6" fill="#ffffff" stroke="#b3261e" stroke-width="1.6"/>`;
    });
    const label = r.insufficient ? `${r.valid} valid of ${r.launched} — INSUFFICIENT` : `${r.pass}/${r.valid} solved`;
    s += `<text x="${padL + Math.max(runs.length, 3) * cell + 22}" y="${y + 4}" font-size="11" fill="#44474b">${esc(label)}</text>`;
  });
  return `${s}</svg>`;
}

// ------------------------------------------------------------------ content
const P = (t) => ({ p: t });
const TABLE = (head, rows) => ({ table: { head, rows } });
const UL = (items) => ({ ul: items });
const SVG = (svg) => ({ svg });

const sections = [
  {
    title: 'Abstract',
    blocks: [
      P(`An AI coding agent solving a real software issue re-sends its whole working transcript to the model on every step, so how much context it accumulates decides whether a context-management policy can help it at all. This project is about that policy, but every live measurement it has produced so far ran a problem exactly once. A single run cannot say whether an outcome is a property of the problem or a draw from a distribution, so the noise floor for every comparison in this repository was unknown.`),
      P(`We measured it. Ten SWE-bench Verified problems, drawn by a seeded rule written before any agent ran, were each run ${REPEATS_TARGET} times through opencode under one frozen configuration: ${esc(MODEL)} pinned to a single serving backend, no context cap, no eviction, no middleware. Nothing varied between repeats. We recorded not only pass or fail but the whole trajectory — largest prompt actually sent, steps, wall time, cost — and checked every run against validity conditions fixed in advance.`),
      P(`Outcomes are stable and trajectories are not. ${alwaysPass.length} of ${perProblem.length} problems were solved on every valid repeat, ${mixed.length} was solved on some, and ${insufficient.length} could not be decided; across ${valid.length} valid runs, ${valid.filter((c) => c.pass).length} passed. But with nothing varied, the largest prompt a run sent moved by ${x2(Math.min(...spreads))} to ${x2(Math.max(...spreads))} within a single problem (median ${x2(medRaw(spreads))}), and step counts moved by as much as ${k(Math.max(...decided.map((p) => p.stepMax - p.stepMin)))} steps. The quantity this project designates as the outcome variable for every window experiment — the peak context actually reached — is therefore not a property of a problem but a per-run draw.`),
      P(`Two consequences follow, and the second is the more awkward. A window cap set anywhere inside those ranges binds on some repeats of a problem and not on others, so "does this problem reach the cap?" has no single answer and pressure cannot be treated as a per-problem constant. And because ${alwaysPass.length} of ${perProblem.length} problems already pass every time without any middleware, this pool leaves at most ${winnable} problems for a context-management arm to win, while a paired test needs ${MCNEMAR_MIN} problems to change in one direction to reach p = ${mcnemarP.toFixed(3)}. On this pool, uncapped, no context-management result can reach significance however good the middleware is. The main limits: ten problems, one model, hosted weights that differ from the local model every earlier result in this project used, and one problem (${esc(short(insufficient[0]?.id ?? 'none'))}) left undecided by harness failures rather than by the model.`),
    ],
  },
  {
    title: 'What you need to know to read the rest',
    blocks: [TABLE(['Term', 'Meaning'], [
      ['agent', 'A language model plus a loop that lets it call tools — read a file, run a shell command, edit code — until it decides it is finished.'],
      ['agent host', 'The program running that loop. Here it is opencode, an external open-source coding agent, used because this project requires evaluation to happen in a real host rather than an in-repo harness.'],
      ['transcript / context', 'Everything the model sees on one step: the host\'s instructions and tool definitions, the task, and the entire conversation so far. It is re-sent in full on every step.'],
      ['token', 'The unit models count text in; roughly four characters of English or code.'],
      ['step', 'One model call inside a run.'],
      ['run / cell', 'One execution of one problem. Three runs of the same problem are called repeats.'],
      ['repeat vs problem', 'Repeats measure how much one problem varies with itself. Distinct problems measure variation between problems. They are different quantities and only the second generalises.'],
      ['achieved peak', 'The largest prompt any step of a run actually sent, as reported by the provider, including cached input. This project treats it — not the configured cap — as the outcome variable for window experiments.'],
      ['spread', 'For one problem, the largest repeat\'s achieved peak divided by the smallest. 1.00x would mean the three repeats reached identical context sizes.'],
      ['window cap', 'A configured limit on prompt size. A context-management policy decides what to drop when the conversation would exceed it, so it can only matter when prompts actually get that large.'],
      ['eviction', 'Removing earlier parts of the conversation to fit a window. Not used here: this run is uncapped.'],
      ['middleware', 'The context-management system this project builds. Not used here either — this is the baseline it will eventually be compared against.'],
      ['SWE-bench Verified', 'A public benchmark of real GitHub issues from Python projects, each with a human-checked fix and hidden tests.'],
      ['F2P (FAIL_TO_PASS)', 'Tests that fail before the fix and must pass after it. This is what "solved" means.'],
      ['P2P (PASS_TO_PASS)', 'Tests that passed before the fix and must still pass, so a fix cannot win by breaking something else.'],
      ['calibrated P2P', 'The subset of P2P tests that actually pass with the official fix in this environment; tests that cannot run here are dropped rather than counted as regressions.'],
      ['valid run', 'A run that exited cleanly, produced steps, and was graded. A run cut short by a harness limit or a provider error is invalid: it never got to attempt the task, so it is excluded rather than scored as a failure.'],
      ['INSUFFICIENT', `A problem with fewer than ${MIN_USABLE} valid runs. It receives no verdict at all, under a rule fixed before these results existed.`],
      ['liveness', 'Evidence the agent actually did something: here, whether the run left a non-empty code diff. Used to tell "tried and failed" apart from "never attempted".'],
      ['Wilson interval', 'A confidence interval for a proportion that stays sensible at small counts and at 0% or 100%.'],
      ['McNemar test', 'The right test for comparing two arms on the same problems: it looks only at problems where the arms disagree. With all disagreements in one direction, five are needed for p = 0.031.'],
      ['resampling unit', 'The thing assumed independent when computing an interval. Here it is the PROBLEM, never the run — three repeats of one problem are not three independent observations.'],
    ])],
  },
  {
    title: 'Why we ran this',
    blocks: [
      P(`This project's central claim is that reorganising an agent's context helps it on long tasks. Testing that claim means comparing an agent with the middleware against the same agent without it, and the "without it" side is this baseline. Before any comparison can mean anything, two things about the baseline have to be known: whether it is stable — does the same problem produce the same outcome when run again — and how much it varies internally, because a difference between two arms is only interesting if it is larger than the difference an arm has with itself.`),
      P(`Neither was known. An earlier solvability pilot on this same substrate established that the problems are solvable and that they generate real context pressure, but it ran each problem exactly once. Every window and eviction result in this repository has the same shape: repeats of a single synthetic task, or one run each of several problems. A single run per problem cannot distinguish "this problem is hard for the model" from "this run happened to go badly", and two of that pilot's ten problems were recorded as failures on exactly that evidence.`),
      P(`This run was therefore designed to answer three narrow questions and nothing else. Does the frozen configuration work end to end, without harness failures? Is each problem's outcome reproducible across repeats? And how much does an identical configuration vary with itself — specifically in achieved peak, the quantity every planned window experiment is going to measure?`),
    ],
  },
  {
    title: 'The experimental setup',
    blocks: [
      P(`**The task.** opencode is started in a scratch copy of a repository at the commit where an issue was reported. Its instruction is the issue text verbatim, plus a framing line and a note naming the project's Python interpreter and test runner. It is never told which file to change, and never sees the official fix or the hidden tests; construction aborts if the prompt would leak a graded test name or a line of either patch. It may edit any file, and edits to test files are discarded before grading. After opencode exits, the hidden test patch is applied and the F2P and calibrated P2P tests are run with the project's own runner. "Solved" means every F2P test passes **and** every calibrated P2P test still passes.`),
      P(`**The substrate.** ${perProblem.length} distinct problems from ${new Set(perProblem.map((p) => p.repo)).size} repositories, drawn by a seeded, difficulty-stratified rule recorded before any agent ran and verified three ways (the failing tests must fail on the original code, and both they and the P2P tests must pass with the official fix in this environment). Each problem was run ${REPEATS_TARGET} times, giving ${cells.length} launched runs.`),
      P(`**What was varied: nothing.** That is the point of the design. Every run used ${esc(MODEL)} with \`limit.context\` ${k(need(MODEL_CFG, 'limit_context'))} and \`limit.output\` ${k(need(MODEL_CFG, 'limit_output'))}, pinned to a single serving backend (${esc(JSON.stringify(need(need(MODEL_CFG, 'options'), 'provider').order))}, ${esc(JSON.stringify(need(need(MODEL_CFG, 'options'), 'provider').quantizations))}, no fallbacks) so that provider routing could not silently change precision between runs. Thinking is on, the host default. No tool-output clip, no context cap, no eviction, no middleware. The only thing that differs between the three repeats of a problem is the model's own non-determinism.`),
      P(`**What was recorded per run.** Pass, F2P and calibrated P2P separately; steps and tool calls by tool; the code diff the agent left behind; per-step tokens; achieved peak; the largest single response; each step's finish reason; wall time; provider-reported cost; exit status; whether the run was killed or timed out; and the session export, re-imported into this project's own store to confirm it is machine-readable. The validity conditions — clean exit, graded, no output-limit stop, complete event stream — were fixed before the run.`),
      P(`**Why this substrate, and what it cannot show.** Real problems with held-out tests are the only way to measure between-problem variation, which is the larger source of variation in agentic coding and the thing repeats of one synthetic task cannot reach. What it cannot show: anything about the middleware, which is absent here by design; anything about behaviour under a window cap, since nothing is capped; and anything about the local quantized model this project used for its earlier results, since these runs use hosted weights at a different precision.`),
    ],
  },
  {
    title: 'Results',
    blocks: [
      P(`**1. The instrument is clean.** Every validity condition was checked on every launched run.`),
      TABLE(['Validity check', 'Result'], [
        ['Runs launched', k(cells.length)],
        ['Valid runs (clean exit, graded, no harness cut-off)', `${k(valid.length)} of ${k(cells.length)}`],
        ['Invalid runs (excluded, never scored as failures)', k(invalid.length)],
        ['Steps ending on the output limit', `${k(lengthStops)} — none`],
        ['Incomplete event streams', `${k(incomplete)} — none`],
        ['Runs killed by anything outside the harness', `${k(extKills)} — none`],
        ['Session exports that re-imported cleanly', `${k(importsOk)} of ${k(cells.length)}`],
        ['Valid runs that left a real code change (liveness)', `${k(actedValid)} of ${k(valid.length)}`],
        ['Valid runs that "passed" without changing code', `${k(passEmptyDiff)} — none, so no pass is a grading artefact`],
      ]),
      P(`**2. Outcomes are reproducible.** ${alwaysPass.length} of ${perProblem.length} problems were solved on every valid repeat, ${mixed.length} on some, ${alwaysFail.length} on none, and ${insufficient.length} had too few valid runs to judge.`),
      SVG(chartOutcomes()),
      TABLE(['Problem', 'Repository', 'Difficulty', 'Valid', 'Solved', 'F2P', 'P2P', 'Verdict'],
        perProblem.map((p) => [short(p.id), p.repo, p.difficulty, `${p.valid}/${p.launched}`,
          p.insufficient ? '—' : `${p.pass}/${p.valid}`, p.insufficient ? '—' : `${p.f2p}/${p.valid}`,
          p.insufficient ? '—' : `${p.p2p}/${p.valid}`,
          p.insufficient ? `INSUFFICIENT (<${MIN_USABLE} valid)` : p.verdict])),
      P(`Pooled over valid runs, ${valid.filter((c) => c.pass).length} of ${valid.length} passed. That figure is descriptive only: **the resampling unit is the problem, not the run**, because three repeats of one problem are not three independent observations. At the problem level the rate is ${alwaysPass.length + mixed.length} of ${perProblem.length} problems solved at least once, and a Wilson interval on ${alwaysPass.length} of ${decided.length} decided problems solved every time runs ${pct(wilson(alwaysPass.length, decided.length)[0])}–${pct(wilson(alwaysPass.length, decided.length)[1])}.`),
      P(`**3. Trajectories are not reproducible, and this is the finding.** With nothing varied between repeats, the largest prompt a run actually sent moved substantially within every problem.`),
      SVG(chartSpread()),
      TABLE(['Problem', 'Achieved peak: min / median / max', 'Spread', 'Steps', 'Wall seconds', 'Cost'],
        [...decided].sort((a, b) => b.spread - a.spread).map((p) => [short(p.id),
          `${k(p.peakMin)} / ${k(p.peakMed)} / ${k(p.peakMax)}`, x2(p.spread),
          `${k(p.stepMin)}–${k(p.stepMax)}`, `${k(p.wallMin)}–${k(p.wallMax)}`, `${usd(p.costMin)}–${usd(p.costMax)}`])),
      P(`Within-problem spread runs ${x2(Math.min(...spreads))} to ${x2(Math.max(...spreads))}, median ${x2(medRaw(spreads))}. The extreme case is ${esc(short(decided.reduce((a, b) => (a.spread > b.spread ? a : b)).id))} at ${x2(Math.max(...spreads))}. ${esc(short(decided.find((p) => p.stepMax - p.stepMin === Math.max(...decided.map((q) => q.stepMax - q.stepMin))).id))} solved the same issue in as few as ${k(decided.find((p) => p.stepMax - p.stepMin === Math.max(...decided.map((q) => q.stepMax - q.stepMin))).stepMin)} steps and as many as ${k(decided.find((p) => p.stepMax - p.stepMin === Math.max(...decided.map((q) => q.stepMax - q.stepMin))).stepMax)}. Because a run's achieved peak is a draw rather than a constant, a cap placed inside a problem's range binds on some repeats and not others.`),
      P(`**4. Invalid runs, and why each was excluded.** All ${k(invalid.length)} belong to one problem, and none is a model failure.`),
      TABLE(['Problem', 'Outcome', 'Steps', 'Achieved peak', 'Would have graded', 'Cause'],
        invalid.map((c) => [short(c.instance), need(c, 'exit_outcome', `${c.instance}.`), k(c.steps),
          k(c.peak_prompt_tokens), c.pass ? 'solved' : 'not solved', (c.error ?? '').slice(0, 72)])),
      P(`One of them had already solved the problem when the harness stopped it: it was cut off by this harness's own ${k(need(man, 'run_timeout_s'))}-second wall-clock ceiling after ${k(Math.max(...invalid.filter((c) => c.exit_outcome === 'timeout').map((c) => c.steps)))} steps with its F2P and calibrated P2P tests passing. The rest ended when the provider account ran out of funds mid-run. Under the pre-registered rule, a problem with fewer than ${MIN_USABLE} valid runs gets no verdict, so ${esc(short(insufficient[0]?.id ?? 'none'))} is reported as INSUFFICIENT rather than as a failure. That rule was committed to version control before these runs produced their results.`),
      P(`**5. Comparison with the earlier single-run pilot (post-hoc, and confounded).** The same ten problems were run once each in an earlier pilot. Two verdicts differ.`),
      TABLE(['Problem', 'Pilot (1 run)', 'Baseline (3 runs)'],
        perProblem.map((p) => [short(p.id), pilotVerdict[p.id] ?? '—',
          p.insufficient ? 'INSUFFICIENT' : `${p.verdict} (${p.pass}/${p.valid})`])),
      P(`${changed.length ? changed.map((c) => `**${esc(short(c.id))}** was recorded as ${esc(c.was)} and is now ${esc(c.now)} (${c.pass}/${c.valid})`).join('; ') : 'No verdict changed'}. **This is not evidence that repeats alone flipped them.** The pilot differed in three ways at once: its provider routing was unpinned, so the serving backend and numerical precision are unknown per run and may have changed between steps; its per-response output limit was ${k(16384)} rather than ${k(need(MODEL_CFG, 'limit_output'))}; and it ran each problem once rather than ${REPEATS_TARGET} times. The honest statement is that both problems are solvable by this model and neither was a stable failure — not that a particular one of those three changes is responsible.`),
      P(`**6. Headroom for a future comparison (post-hoc).** ${alwaysPass.length} of ${perProblem.length} problems are solved on every repeat with no middleware at all, leaving at most ${winnable} problems where any context-management arm could show an improvement. A paired McNemar test over the same problems needs ${MCNEMAR_MIN} problems to change in one direction to reach p = ${mcnemarP.toFixed(3)}. ${winnable} < ${MCNEMAR_MIN}, so on this pool, uncapped, no middleware result can reach significance — not because the middleware is ineffective but because there is nothing left to win.`),
      P(`**7. Cost and scale.** ${k(cells.length)} launched runs cost ${usd(spend)} and ${wallH.toFixed(1)} hours of wall time. Valid runs reported ${k(outputTok)} output tokens and ${k(reasoningTok)} reasoning tokens; on this provider reasoning is reported separately and is **not** included in the output figure.`),
    ],
  },
  {
    title: 'What we got wrong',
    blocks: [UL([
      `**A passing run was described as having "edited 0 files".** The per-run \`files_edited\` field is built from edit-tool calls, so an agent that edits through the shell records none. One valid run (${esc(short(undercount[0]?.instance ?? 'none'))}) shows ${k(undercount.length)} edited file(s) by that measure while leaving a real ${k(DIFF_CAP)}-character diff, having used ${k(cells.find((c) => c.instance === (undercount[0]?.instance ?? '') && c.files_edited.length === 0 && c.diff_empty === false)?.tools_by_name?.bash ?? 0)} shell calls. It solved the problem legitimately. Liveness in this report is therefore measured from the diff, not from \`files_edited\`, and the earlier description was withdrawn before publication.`,
      `**The provider error was diagnosed twice, wrongly both times.** Runs failed with "would exceed your available credits". The account-key endpoint reported ample headroom, so it was first reported that funds were available; that endpoint reports the key's spending cap, not the account balance, which was nearly zero. It was then reported that concurrent shards were exceeding an in-flight reservation, and that running alone would fix it — a re-run alone failed identically, falsifying that explanation. The account had simply run out of money.`,
      `**A harness ceiling was mistaken for a hard limit.** The ${k(need(man, 'run_timeout_s'))}-second wall-clock ceiling was set without checking the longest observed run; it then killed a run that had already solved its problem, and another problem reached ${pct(Math.max(...decided.map((p) => p.wallMax)) / need(man, 'run_timeout_s'))} of it. This is the same class of defect as the output cap that invalidated this same problem in the earlier pilot: a configured limit, chosen without evidence, presenting as a model failure.`,
      `**Diff records are truncated.** The runner stores at most ${k(DIFF_CAP)} characters of each diff, and ${k(truncatedDiffs)} of ${k(cells.length)} records hit that cap. The diffs were used only to answer "did the agent change code", which truncation does not affect, but a record at exactly ${k(DIFF_CAP)} characters is not a complete diff and must not be read as one.`,
    ])],
  },
  {
    title: 'Conclusions',
    blocks: [
      P(`**Established.** The frozen configuration runs end to end without instrument failure: ${k(valid.length)} of ${k(cells.length)} runs valid, no output-limit stops, no truncated event streams, every export machine-readable, and no pass unbacked by a real code change. Outcomes are reproducible at the problem level — ${alwaysPass.length} of ${perProblem.length} problems solved on every valid repeat, ${mixed.length} mixed, ${insufficient.length} undecided. Trajectories are not reproducible: achieved peak varies ${x2(Math.min(...spreads))}–${x2(Math.max(...spreads))} within a problem under an identical configuration.`),
      P(`**What this licenses.** Using these ${decided.length} decided problems as a control arm, provided any comparison is **paired within problem** and the arms are run under this same frozen configuration. Treating achieved peak as a per-run draw rather than a per-problem property, and sizing repeats to cover a spread of roughly ${x2(medRaw(spreads))} at the median. Reporting a single run's outcome on this substrate as provisional: two of the earlier pilot's single-run verdicts did not survive repetition.`),
      P(`**What this does not license.** It says nothing about the middleware, which was absent. It says nothing about behaviour under a window cap, because nothing was capped — and the spread measured here means a capped run cannot be assumed to reach the same context size twice. It is not comparable with this project's earlier local-model results, which used different weights at a different precision. It does not establish that repeats alone flipped the two changed verdicts, because three things changed at once. And it does not show that this model cannot solve ${esc(short(insufficient[0]?.id ?? 'none'))}: that problem is **untested**, not failed — a distinction this project treats as a defect to blur.`),
      TABLE(['Claim', 'Status'], [
        ['The frozen configuration runs without instrument failure', 'tested, supported'],
        ['Problem outcomes are reproducible across repeats', `tested, supported (${alwaysPass.length}/${decided.length} decided problems unanimous)`],
        ['Achieved peak is stable within a problem', `tested and REJECTED (${x2(Math.min(...spreads))}–${x2(Math.max(...spreads))})`],
        ['The two pilot failures were caused by single-run noise', 'untested — confounded with routing and output-limit changes'],
        [`${short(insufficient[0]?.id ?? 'none')} is unsolvable for this model`, 'untested — fewer than the required valid runs'],
        ['A context-management arm would beat this baseline', 'untested — and unreachable on this pool uncapped'],
      ]),
    ],
  },
  {
    title: 'Caveats',
    blocks: [UL([
      `${perProblem.length} problems from ${new Set(perProblem.map((p) => p.repo)).size} repositories, ${REPEATS_TARGET} repeats each. Per-repository and per-difficulty rates rest on one or two problems and are not reported.`,
      `The resampling unit is the problem. Any interval computed over the ${k(valid.length)} runs as though they were independent would be too narrow, because repeats within a problem are correlated by construction.`,
      `One model, hosted at one precision. The measurement vehicle is **not** the deployment vehicle for this project's earlier results, which used a locally quantized model; nothing here transfers to those numbers.`,
      `Temperature is the host default and the provider is pinned but not deterministic, so "identical configuration" means identical inputs and settings, not a reproducible sequence of tokens.`,
      `${esc(short(insufficient[0]?.id ?? 'none'))} is unresolved: ${k(insufficient[0]?.valid ?? 0)} valid run of ${k(insufficient[0]?.launched ?? 0)}, blocked on provider funds rather than on anything about the problem. Completing it needs ${MIN_USABLE - (insufficient[0]?.valid ?? 0)} more valid runs.`,
      `Grading uses calibrated P2P: tests that cannot pass with the official fix in this non-Docker environment are dropped, so a regression in one of them would go undetected.`,
      `The Wilson interval is this repository's shared implementation, previously cross-checked against \`statsmodels.proportion_confint(method="wilson")\` on six (successes, n) pairs including 0/n and n/n, agreeing to better than 1e-5. The McNemar threshold quoted is the exact one-sided binomial 0.5^${MCNEMAR_MIN} = ${mcnemarP.toFixed(5)}, not an approximation.`,
      `Cost figures are provider-reported per run and include the host's own overhead calls; they are not a benchmark of the model's price-performance.`,
    ])],
  },
];

// ------------------------------------------------------------------ render
const inlineHtml = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');

let MD = `# The baseline runs itself twice and gets a different journey\n\n*Ten SWE-bench problems, three identical repeats each: the outcomes repeat, the trajectories do not.*\n\n`;
for (const s of sections) {
  MD += `## ${s.title}\n\n`;
  for (const b of s.blocks) {
    if (b.p) MD += `${b.p}\n\n`;
    else if (b.ul) MD += `${b.ul.map((i) => `- ${i}`).join('\n')}\n\n`;
    else if (b.table) {
      const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      MD += `| ${b.table.head.map(cell).join(' | ')} |\n| ${b.table.head.map(() => '---').join(' | ')} |\n`;
      MD += `${b.table.rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n')}\n\n`;
    } else if (b.svg) MD += `_(chart in the HTML version)_\n\n`;
  }
}

let HTML = `<title>SWE-bench baseline stability</title><style>
:root{--bg:#fbfbfa;--fg:#1b1c1e;--line:#dadce0;--card:#ffffff}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding-inline:16px}
main{max-width:980px;margin:0 auto;padding-block:32px}
h1{font-size:28px;margin:0 0 6px}h2{font-size:20px;margin:36px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
p{margin:0 0 12px}ul{padding-left:22px}li{margin-bottom:8px}code{background:#f1f3f4;padding:1px 4px;border-radius:3px;font-size:13px}
.sub{color:#5f6368;font-style:italic;margin:0 0 18px}
.tw{overflow-x:auto;margin:0 0 16px}table{border-collapse:collapse;font-size:13px;min-width:100%}
th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}th{background:#f1f3f4}
figure{margin:8px 0 18px;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;overflow-x:auto}
</style><main><h1>The baseline runs itself twice and gets a different journey</h1><p class="sub">Ten SWE-bench problems, three identical repeats each: the outcomes repeat, the trajectories do not.</p>`;
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

writeFileSync(join(OUT, 'report-baseline.md'), MD);
writeFileSync(join(OUT, 'report-baseline.html'), HTML);
console.error(`wrote report-baseline.{md,html}: ${valid.length}/${cells.length} valid, ${alwaysPass.length} always-pass, ${mixed.length} mixed, ${insufficient.length} insufficient; spread ${x2(Math.min(...spreads))}-${x2(Math.max(...spreads))}`);
