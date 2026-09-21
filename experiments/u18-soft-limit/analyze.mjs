#!/usr/bin/env node
/**
 * U18 — reads what `run.sh` produced. Runs nothing, calls no model, safe to re-run at any time.
 *
 *   node analyze.mjs config                   the resolved knobs, per-arm tags; records the config
 *   node analyze.mjs env <arm>                `CT_*=value` lines for the driver
 *   node analyze.mjs tag <arm>                the arm's tag base under this config
 *   node analyze.mjs missing <arm> <repeat>   instance ids still owed for that wave (run.sh's resume)
 *   node analyze.mjs gate <arm> <tag>         G1+G2 verdict on one gate attempt; exit 1 unless PASS
 *   node analyze.mjs gate-status <arm>        prints PASS | FAIL | NONE for the newest attempt
 *   node analyze.mjs report                   the pre-registered verdict (rules: lib.mjs, README.md)
 *
 * The `U18_*` knobs (lib.mjs KNOBS) select WHICH cells are read: every tag carries a hash of
 * the knobs its arm depends on. `off` depends on none and `hard` not on W, so a W sweep
 * re-uses both.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, CT_ARMS, analyze, armKnobs, finishReasons, foreignLibraryReads, gateVerdict, instrumentFailure, resolveKnobs, sidecarStats, tagBase as tagBaseOf, wireStats } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const PILOT = process.env.U18_PILOT_DIR || join(REPO, 'reports', 'metrics', 'swebench-pilot');
const OUT = process.env.U18_OUT_DIR || join(REPO, 'reports', 'metrics', 'u18-soft-limit');
let KNOBS;
try { KNOBS = resolveKnobs(); } catch (error) { console.error(`u18: ${error.message}`); process.exit(2); }
const WINDOW = Number(KNOBS.CT_CT_WINDOW);
const HISTORICAL = 'results-swebench-opencode-baseline-swift-sbx-x3.json';
const SELECTION = join(PILOT, 'selection-v2.json');

const tagBase = (arm) => tagBaseOf(arm, KNOBS);
const instances = () => JSON.parse(readFileSync(SELECTION, 'utf8')).selection.accepted.map((c) => c.instance_id);
const readDoc = (file) => JSON.parse(readFileSync(join(PILOT, file), 'utf8'));
const wireCache = new Map();
const wire = (cell) => { if (!wireCache.has(cell.run_dir)) wireCache.set(cell.run_dir, wireStats(cell.run_dir)); return wireCache.get(cell.run_dir); };

/**
 * Every cell an arm has, across its waves and their resume files (`-w<R>` then `-w<R>-p<k>`).
 * A cell is superseded ONLY by a later run of the same cell when it was an instrument
 * failure — a criterion blind to the grade (lib.mjs `instrumentFailure`). Any other duplicate
 * means someone re-rolled a finished cell; both copies are kept so the analysis refuses them.
 */
export function armCells(arm) {
  const re = new RegExp(`^results-swebench-opencode-${tagBase(arm)}-w(\\d+)(?:-p(\\d+))?\\.json$`);
  const files = readdirSync(PILOT).map((f) => [f, re.exec(f)]).filter(([, m]) => m)
    .sort(([, a], [, b]) => (+a[1] - +b[1]) || ((+a[2] || 0) - (+b[2] || 0))).map(([f]) => f);
  const cells = [], commits = {}, superseded = [];
  for (const file of files) {
    const doc = readDoc(file);
    commits[file] = doc.manifest?.commit ?? null;
    for (const c of doc.cells) {
      const prior = cells.findIndex((x) => x.instance === c.instance && x.repeat === c.repeat);
      if (prior >= 0 && cells[prior].instrument_failure) superseded.push(...cells.splice(prior, 1).map((x) => `${arm} ${x.instance}__r${x.repeat}: ${x.instrument_failure} (${x.source})`));
      cells.push({ ...c, source: file, instrument_failure: instrumentFailure(c, wire(c)) });
    }
  }
  return { files, commits, superseded, usable: cells.filter((c) => !c.instrument_failure), broken: cells.filter((c) => c.instrument_failure) };
}

function missing(arm, repeat) {
  const have = new Set(armCells(arm).usable.filter((c) => c.repeat === repeat).map((c) => c.instance));
  return instances().filter((id) => !have.has(id));
}

const gateFile = (arm) => join(OUT, `gate-${tagBase(arm)}.json`);
const readGate = (arm) => (existsSync(gateFile(arm)) ? JSON.parse(readFileSync(gateFile(arm), 'utf8')) : { arm, attempts: [] });

/** Attempts are APPENDED, never replaced: a gate that passes on its third try says so. */
function gate(arm, tag) {
  const file = `results-swebench-opencode-${tag}.json`;
  let attempt;
  if (!existsSync(join(PILOT, file))) attempt = { pass: false, reasons: [`the driver wrote no results file for ${tag}`] };
  else {
    const doc = readDoc(file);
    const cell = doc.cells[0];
    const w = wireStats(cell.run_dir), sidecar = sidecarStats(cell.run_dir);
    attempt = {
      ...gateVerdict(cell, w, sidecar, { arm, window: WINDOW, knobs: KNOBS }), instance: cell.instance, commit: doc.manifest.commit, at: doc.manifest.date,
      observed: { solved: cell.pass, exit_outcome: cell.exit_outcome, peak_prompt_tokens: cell.peak_prompt_tokens, first_step_prompt_tokens: cell.first_step_prompt_tokens, evicted_units: cell.ct?.evicted_units, messages_dropped: cell.ct?.messages_dropped, plugin_turns: cell.ct?.plugin_turns, wire: w, sidecar },
    };
  }
  const record = readGate(arm);
  record.config = armKnobs(arm, KNOBS);
  record.note = 'gate cells are evidence about the harness, never pooled with a wave';
  record.attempts.push({ tag, ...attempt });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(gateFile(arm), `${JSON.stringify(record, null, 2)}\n`);
  return attempt;
}

function report() {
  const arms = {}, sources = {}, commits = {}, owed = [], superseded = [];
  for (const arm of Object.keys(ARMS)) {
    const a = armCells(arm);
    if (!a.files.length) continue;
    arms[arm] = a.usable; sources[arm] = a.files; Object.assign(commits, a.commits);
    owed.push(...a.broken.map((c) => `${arm} ${c.instance}__r${c.repeat} (${c.instrument_failure})`));
    superseded.push(...a.superseded);
  }
  if (!arms.off || !arms.soft) throw new Error(`need both off and soft waves in ${PILOT}; found ${JSON.stringify(sources)}`);
  const historical = existsSync(join(PILOT, HISTORICAL)) ? readDoc(HISTORICAL).cells : null;
  const distinct = [...new Set(Object.values(commits))];
  const runLog = join(OUT, 'run-log.jsonl');
  return {
    experiment: 'U18 soft limit', generated_at: new Date().toISOString(), sources,
    selection_sha256: createHash('sha256').update(readFileSync(SELECTION)).digest('hex'),
    commits: distinct, mixed_commits: distinct.length > 1 ? 'waves ran at more than one commit: diff experiments/context-dedup and packages between them before trusting the pool' : null,
    dirty_tree_runs: existsSync(runLog) ? readFileSync(runLog, 'utf8').split('\n').filter((l) => l.includes('"dirty":true')).length : null,
    // Cells re-run because the INSTRUMENT failed, with the reason. Outcome-blind by construction.
    instrument_failures_rerun: superseded,
    gates: Object.fromEntries(CT_ARMS.map((arm) => [arm, readGate(arm).attempts.map(({ tag, pass, commit }) => ({ tag, pass, commit }))])),
    config: KNOBS, tags: Object.fromEntries(Object.keys(ARMS).map((a) => [a, tagBase(a)])),
    ...analyze({ arms, window: WINDOW, knobs: KNOBS, instances: instances(), owed, historical, wire, foreignReads: (c) => foreignLibraryReads(c.run_dir, c.repo), finish: (c) => finishReasons(c.run_dir) }),
  };
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'config') {
    // The full knob set behind each hash, so a tag can always be read back.
    mkdirSync(join(OUT, 'configs'), { recursive: true });
    for (const arm of CT_ARMS) writeFileSync(join(OUT, 'configs', `${tagBase(arm)}.json`), `${JSON.stringify({ arm, tag: tagBase(arm), knobs: armKnobs(arm, KNOBS) }, null, 2)}\n`);
    for (const [k, v] of Object.entries(KNOBS)) console.log(`  ${k}=${v}`);
    for (const arm of Object.keys(ARMS)) console.log(`  tag ${arm}: ${tagBase(arm)}`);
    return;
  }
  if (mode === 'env') { process.stdout.write(Object.entries(armKnobs(rest[0], KNOBS)).map(([k, v]) => `${k}=${v}`).join('\n')); return; }
  if (mode === 'trigger') { process.stdout.write(ARMS[rest[0]]?.trigger ?? 'off'); return; }
  if (mode === 'tag') { process.stdout.write(tagBase(rest[0])); return; }
  if (mode === 'missing') { process.stdout.write(missing(rest[0], Number(rest[1])).join(',')); return; }
  if (mode === 'gate-status') { const last = readGate(rest[0]).attempts.at(-1); process.stdout.write(last ? `${last.pass ? 'PASS' : 'FAIL'} ${last.commit ?? ''}` : 'NONE'); return; }
  if (mode === 'gate') {
    const g = gate(rest[0], rest[1]);
    console.error(`gate ${rest[0]} ${g.pass ? 'PASS' : 'FAIL'}${g.reasons.length ? `\n  - ${g.reasons.join('\n  - ')}` : ''}\nrecord: ${gateFile(rest[0])}`);
    process.exit(g.pass ? 0 : 1);
  }
  if (mode === 'report') {
    const r = report();
    mkdirSync(OUT, { recursive: true });
    const path = join(OUT, `analysis-${tagBase('soft')}.json`);
    writeFileSync(path, `${JSON.stringify(r, null, 2)}\n`);
    console.log(`U18 @ ${tagBase('soft')}: ${r.verdict} — ${r.why}`);
    for (const [arm, s] of Object.entries(r.arms)) console.log(`  ${arm.padEnd(5)} solved ${s.solved}/${s.cells}  median peak ${s.median_peak}  max ${s.max_peak}  compacted ${s.compacted_cells}  engaged ${s.engaged_cells}  unscored ${s.unscored.length} (timeouts ${s.timeouts})  agent evict calls ${s.agent_evict_calls}  error turns ${s.plugin_error_turns}/${s.plugin_turns}`);
    for (const [arm, s] of Object.entries(r.arms)) if (arm !== 'off') console.log(`  ${arm.padEnd(7)} recall-tool calls ${s.recall_tool_calls} in ${s.cells_with_recall} cell(s)  ended at the output cap ${s.cells_ended_at_output_cap}`);
    for (const [arm, x] of Object.entries(r.recall)) console.log(`  ${arm.padEnd(7)} vs off Δ ${x.vs_off.delta_solved_itt}  vs soft Δ ${x.vs_soft.delta_solved_itt}${x.note ? `  — ${x.note}` : ''}`);
    for (const row of r.primary_soft_vs_off.rows) console.log(`  ${row.instance.padEnd(36)} off ${row.control_solved}/3 soft ${row.treatment_solved}/3  peak ${row.control_peak} → ${row.treatment_peak} (${row.peak_ratio})${row.binding ? ' binding' : ''} engaged ${row.treatment_engaged_cells}/3`);
    if (r.a_a_noise) console.log(`  A/A: this off arm ${r.a_a_noise.fresh_off_solved}, historical ${r.a_a_noise.historical_solved}`);
    for (const line of [...r.integrity_problems, ...(r.mixed_commits ? [r.mixed_commits] : [])]) console.log(`  ! ${line}`);
    console.log(`written: ${path}`);
    return;
  }
  console.error('usage: analyze.mjs config | env <arm> | tag <arm> | missing <arm> <repeat> | gate <arm> <tag> | gate-status <arm> | report');
  process.exit(2);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
