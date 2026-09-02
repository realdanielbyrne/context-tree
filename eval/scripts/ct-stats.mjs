#!/usr/bin/env node
/**
 * Aggregate eval results across runs/replicates and report variance honestly:
 * per (label, scenario, arm) group -> n, mean, sample SD, median, IQR, CV for
 * cost / tokens / turns, plus the raw per-run rows and per-turn records for
 * downstream charts.
 *
 *   node eval/scripts/ct-stats.mjs [--json out.json] <resultsDirOrFile...>
 *
 * A directory is scanned recursively for results.json files; the label of a
 * row is its runId with a trailing "-repN" stripped, so parallel replicates
 * of one experiment fold into one group.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
let jsonOut;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') jsonOut = args[++i];
  else inputs.push(args[i]);
}
if (inputs.length === 0) {
  console.error('usage: ct-stats.mjs [--json out.json] <resultsDirOrFile...>');
  process.exit(1);
}

function* findResults(path) {
  const st = statSync(path);
  if (st.isFile()) {
    if (path.endsWith('results.json')) yield path;
    return;
  }
  for (const entry of readdirSync(path)) yield* findResults(join(path, entry));
}

const rows = [];
for (const input of inputs) {
  for (const file of findResults(input)) {
    for (const run of JSON.parse(readFileSync(file, 'utf8'))) {
      rows.push({ file, ...run });
    }
  }
}

const labelOf = (runId) => runId.replace(/-rep\d+$/, '');

function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return undefined;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const q = (p) => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  return {
    n,
    mean,
    sd,
    cv: mean === 0 ? 0 : sd / mean,
    min: v[0],
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    max: v[n - 1],
  };
}

const METRICS = {
  costUsd: (r) => r.metrics.costUsd,
  totalTokens: (r) => r.metrics.tokens.total,
  inputTokens: (r) => r.metrics.tokens.input,
  outputTokens: (r) => r.metrics.tokens.output,
  cacheRead: (r) => r.metrics.tokens.cacheRead,
  cacheWrite: (r) => r.metrics.tokens.cacheWrite,
  modelTurns: (r) => r.metrics.turns.modelTurns,
  toolCalls: (r) => r.metrics.turns.toolCalls,
  wallMs: (r) => r.metrics.speed.wallMs,
  score: (r) => (typeof r.judge?.score === 'number' ? r.judge.score : r.success === true ? 1 : 0),
};

const groups = new Map();
for (const row of rows) {
  const key = `${labelOf(row.runId)}|${row.scenarioId}|${row.arm}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const summary = [];
for (const [key, members] of [...groups.entries()].sort()) {
  const [label, scenarioId, arm] = key.split('|');
  const entry = {
    label,
    scenarioId,
    arm,
    n: members.length,
    successRate: members.filter((m) => m.success === true).length / members.length,
    metrics: {},
  };
  for (const [name, get] of Object.entries(METRICS)) {
    entry.metrics[name] = stats(members.map(get));
  }
  summary.push(entry);
}

const fmt = (x, digits = 3) =>
  x === undefined ? '-' : x >= 1000 ? Math.round(x).toLocaleString('en-US') : Number(x.toFixed(digits));

console.log('| label | scenario | arm | n | ok | score mean | cost mean±sd (cv) | cost median [IQR] | turns med | totTok med | inTok med | outTok med | cacheW med |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const e of summary) {
  const c = e.metrics.costUsd;
  const t = e.metrics.modelTurns;
  const tok = e.metrics.totalTokens;
  const cw = e.metrics.cacheWrite;
  const sc = e.metrics.score;
  const it = e.metrics.inputTokens;
  const ot = e.metrics.outputTokens;
  console.log(
    `| ${e.label} | ${e.scenarioId} | ${e.arm} | ${e.n} | ${Math.round(e.successRate * 100)}% | ${fmt(sc.mean * 100, 1)}% | ` +
      `$${fmt(c.mean, 3)}±${fmt(c.sd, 3)} (${fmt(c.cv * 100, 1)}%) | $${fmt(c.median, 3)} [${fmt(c.p25, 3)}–${fmt(c.p75, 3)}] | ` +
      `${fmt(t.median, 1)} | ${fmt(tok.median, 0)} | ${fmt(it.median, 0)} | ${fmt(ot.median, 0)} | ${fmt(cw.median, 0)} |`,
  );
}

if (jsonOut) {
  const perRun = rows.map((r) => ({
    label: labelOf(r.runId),
    runId: r.runId,
    scenarioId: r.scenarioId,
    arm: r.arm,
    status: r.status,
    success: r.success,
    costUsd: r.metrics.costUsd,
    tokens: r.metrics.tokens,
    modelTurns: r.metrics.turns.modelTurns,
    toolCalls: r.metrics.turns.toolCalls,
    wallMs: r.metrics.speed.wallMs,
    turns: r.turns.map((t) => ({
      index: t.index,
      latencyMs: t.latencyMs,
      usage: t.usage,
      toolCalls: t.toolCalls,
    })),
  }));
  writeFileSync(jsonOut, JSON.stringify({ summary, perRun }, null, 1));
  console.log(`\n[ct-stats] wrote ${jsonOut} (${perRun.length} runs, ${summary.length} groups)`);
}
