#!/usr/bin/env node
/** Offline only: node eval/scripts/attention-audit.mjs --legacy --out /tmp/audit.json */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { distribution, readCapture } from '../dist/experiment.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sum = (values) => values.length === 0 || values.some((v) => typeof v !== 'number' || !Number.isFinite(v)) ? null : values.reduce((a, b) => a + b, 0);
const usageTotal = (usage) => usage == null ? null : sum(['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => usage[key]));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const grouped = (rows, key) => {
  const groups = new Map();
  for (const row of rows) { const id = key(row); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(row); }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
};
const readArtifact = (repo, path) => {
  const text = readFileSync(join(repo, path), 'utf8');
  return { path, sha256: sha(text), data: JSON.parse(text) };
};

export function auditLegacy(repo = ROOT) {
  const base = 'reports/metrics/window-regime-and-retrieval-unit/step8-sonnet';
  const taskArtifacts = [1, 2, 3].map((rep) => readArtifact(repo, `${base}/results-r${rep}.json`));
  const taskRows = taskArtifacts.flatMap((artifact) => artifact.data.map((row) => ({ ...row, artifact: artifact.path })));
  const taskSummary = grouped(taskRows, (row) => `${row.scenarioId}/${row.arm}`).map(([key, rows]) => {
    const allModel = rows.map((row) => Array.isArray(row.costByModel) ? sum(row.costByModel.map((entry) => usageTotal(entry.usage))) : null);
    const models = [...new Set(rows.flatMap((row) => (row.costByModel ?? []).map((entry) => entry.model)))].sort();
    return {
      key, n: rows.length,
      recordedSuccesses: rows.filter((row) => row.success === true).length,
      recordedJudgePasses: rows.filter((row) => row.judge?.success === true && /^--- exit 0 ---/m.test(row.judge?.detail ?? '')).length,
      recordedOutcomeDisagreements: rows.filter((row) => row.success !== row.judge?.success).length,
      statuses: Object.fromEntries(grouped(rows, (row) => row.status).map(([status, values]) => [status, values.length])),
      turns: distribution(rows.map((row) => row.metrics?.turns?.modelTurns ?? null)),
      agentOnlyTokens: distribution(rows.map((row) => row.metrics?.tokens?.total ?? null)),
      allModelTokens: distribution(allModel),
      recordedCostUsd: distribution(rows.map((row) => row.metrics?.costUsd ?? null)),
      costByModel: Object.fromEntries(models.map((model) => [model, distribution(rows.map((row) => {
        if (!Array.isArray(row.costByModel)) return null;
        const entries = row.costByModel.filter((entry) => entry.model === model);
        return entries.length === 0 ? 0 : sum(entries.map((entry) => entry.usd));
      }))])),
      verifiedSuccesses: null,
      promotable: false,
      limitations: ['n=3', 'no exact request/response capture', 'recorded judge output is not an independently rerun verifier', 'caps and stalls remain included'],
      runs: rows.map((row, i) => ({ artifact: row.artifact, runId: row.runId, status: row.status, success: row.success, agentOnlyTokens: row.metrics?.tokens?.total ?? null, allModelTokens: allModel[i] })),
    };
  });
  const results = 'eval/fixtures/transplant/s1/e1b289c32f40/results';
  const questionPath = 'eval/fixtures/transplant/s1/e1b289c32f40/questions-deep.json';
  const questionSha = sha(readFileSync(join(repo, questionPath)));
  const qaArtifacts = readdirSync(join(repo, results)).filter((name) => /^run-W131072-.*questions-deep-.*-n5-z-ai_glm-5\.3-flash\.json$/.test(name))
    .sort().map((name) => readArtifact(repo, `${results}/${name}`));
  const qa = qaArtifacts.map((artifact) => ({
    path: artifact.path, sha256: artifact.sha256,
    epoch: artifact.data.identity?.codeKey ?? null,
    questionSha: artifact.data.identity?.questionSha ?? null,
    questionHashMatches: artifact.data.identity?.questionSha === questionSha,
    partial: artifact.data.partial ?? null,
    arms: grouped(artifact.data.rows ?? [], (row) => row.arm).map(([arm, rows]) => ({
      arm, attempted: rows.length,
      statuses: Object.fromEntries(grouped(rows, (row) => row.status).map(([status, values]) => [status, values.length])),
      recordedSuccesses: rows.filter((row) => row.success === true).length,
      recordedScores: distribution(rows.map((row) => row.score ?? null)),
      completedScores: distribution(rows.filter((row) => row.status === 'completed').map((row) => row.score ?? null)),
      turns: distribution(rows.map((row) => row.modelTurns ?? null)),
      allModelTokens: distribution(rows.map((row) => usageTotal(row.usage))),
      zeroToolCallRuns: rows.filter((row) => Array.isArray(row.toolCalls) && row.toolCalls.length === 0).length,
      appendedResultTruncations: sum(rows.map((row) => row.resultsTruncated ?? null)),
      historicalLiteralDeliveryFlags: rows.filter((row) => row.literalInToolResult === true || row.prefill?.answerLiteralInPrefill === true).length,
      verifiedEarnedSuccesses: null, promotable: false,
      limitations: ['raw scores and historical delivery flags only; exact sent payloads were not captured', 'do not pool across epochs'],
    })),
  }));
  return {
    version: 1, kind: 'historical-evidence-audit', liveCalls: 0, httpWireVerified: false,
    taskArtifacts: taskArtifacts.map(({ path, sha256 }) => ({ path, sha256 })),
    taskSummary, qa,
    conclusions: [
      'Task metrics.tokens excludes other-model summarization; use the costByModel usage ledger for all-model tokens.',
      'A recorded passing judge result on a capped or stalled run does not make that run complete or promotable.',
      'Historical raw Q&A scores are reproducible numerically; earned-success provenance is not reverified by this audit.',
      'These historical fixtures are exploratory and do not substitute for frozen primary DeepSWE tasks.',
    ],
  };
}

function main(argv) {
  let repo = ROOT, output, capture, legacy = argv.length === 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--legacy') legacy = true;
    else if (arg === '--repo') repo = resolve(argv[++i] ?? '');
    else if (arg === '--out') output = argv[++i];
    else if (arg === '--capture') capture = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!legacy && capture === undefined) throw new Error('choose --legacy or --capture DIR');
  const report = {
    ...(legacy ? { legacy: auditLegacy(repo) } : {}),
    ...(capture === undefined ? {} : { capture: (() => { const { frames, ...audit } = readCapture(capture); return { ...audit, requestFrames: frames.map(({ seq, attempt, role, requestBlob, priorEvents }) => ({ seq, attempt, role, requestBlob, priorEventCount: priorEvents.length })) }; })() }),
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output === undefined) process.stdout.write(text);
  else writeFileSync(output, text);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
