#!/usr/bin/env node
/**
 * §15 harness entry point.
 *
 *   node dist/run.js --benchmarks all --arms native,context-tree \
 *     --scenarios-dir ./eval/scenarios --limit 2
 *
 * Runs every scenario of every requested benchmark under both arms on the same
 * frontier model, meters every token (agent + summarizer + judge), exports a
 * Langfuse trace per scenario×arm (paired by session), and writes
 * `<out>/<runId>/results.json` + `report.md`.
 *
 * API keys come from the environment; the workspace-root `.env` is loaded
 * (existing env vars win) when present. Without Langfuse keys the export is a
 * no-op — the run still works, it just isn't visible in Langfuse.
 */
import { createProvider, loadApiKeys, resolveConfig } from '@context-tree/core';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { adapterFor, BENCHMARK_IDS } from './adapters/index.js';
import { loadWorkspaceEnv } from './env.js';
import { createLangfuseSink } from './langfuse.js';
import { runScenario } from './loop.js';
import { renderMarkdownReport, writeReportFiles } from './report.js';
import { isArm, type Arm, type HarnessOptions, type RunResult, type Scenario } from './types.js';

loadWorkspaceEnv(dirname(fileURLToPath(import.meta.url)));

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARMS_LIST = ['native', 'context-tree', 'dsa', 'tree-dsa'];

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, got "${value}"`);
  }
  return parsed;
}

const program = new Command();
program
  .name('context-tree-eval')
  .description('§15 benchmark harness: native vs context-tree arms, Langfuse A/B export')
  .requiredOption('--benchmarks <list>', `comma-separated benchmark ids or "all" (${BENCHMARK_IDS.join(', ')})`)
  .option('--arms <list>', 'comma-separated arms', 'native,context-tree')
  .option('--scenarios-dir <dir>', 'root directory holding one subdirectory per benchmark', join(evalRoot, 'scenarios'))
  .option('--limit <n>', 'max scenarios per benchmark', parsePositiveInt)
  .option('--model <id>', 'agent model id', 'claude-sonnet-5')
  .option('--leaf-model <id>', 'context-tree leaf summarizer model', 'claude-haiku-4-5-20251001')
  .option('--root-model <id>', 'context-tree root summarizer model', 'claude-sonnet-5')
  .option('--judge-model <id>', 'LLM judge model', 'claude-opus-5')
  .option('--provider <name>', 'model provider: anthropic | openrouter', 'anthropic')
  .option('--max-turns <n>', 'per-run turn cap', '40')
  .option(
    '--temperature <t>',
    'pinned sampling temperature for agent + summarizer calls (unset = provider default). ' +
      'NOTE: the Claude 5 API rejects this param ("deprecated for this model") — usable only with models/providers that still accept it',
  )
  .option('--time-cap-ms <n>', 'per-run wall-clock cap in ms', '900000')
  .option('--cost-cap-usd <n>', 'per-run spend cap in USD')
  .option('--out <dir>', 'results output directory', join(evalRoot, 'results'))
  .option('--run-id <id>', 'run identifier (defaults to a timestamp)')
  .option('--keep-sandbox', 'keep per-run sandboxes and record their paths', false)
  .option('--no-langfuse', 'disable the Langfuse export')
  .showHelpAfterError()
  .action(async (opts) => {
    const benchmarkIds: string[] =
      opts.benchmarks === 'all' ? [...BENCHMARK_IDS] : opts.benchmarks.split(',').map((s: string) => s.trim());
    for (const id of benchmarkIds) adapterFor(id); // fails loud on an unknown id

    const arms: Arm[] = [];
    for (const raw of opts.arms.split(',')) {
      const arm = raw.trim();
      if (!isArm(arm)) throw new Error(`unknown arm "${arm}" — known: ${ARMS_LIST.join(', ')}`);
      if (!arms.includes(arm)) arms.push(arm);
    }

    const provider = opts.provider === 'openrouter' ? 'openrouter' : 'anthropic';
    const keys = loadApiKeys();
    if (provider === 'anthropic' && keys.anthropic === undefined) {
      throw new Error('ANTHROPIC_API_KEY is not set — add it to the environment or the workspace .env');
    }
    if (provider === 'openrouter' && keys.openrouter === undefined) {
      throw new Error('OPENROUTER_API_KEY is not set — add it to the environment or the workspace .env');
    }
    const agentProvider = createProvider(resolveConfig({ provider }), keys);

    const sink = createLangfuseSink(opts.langfuse === false ? {} : process.env);
    if (!sink.enabled) {
      console.error('[langfuse] keys missing or export disabled — runs will not be exported');
    }

    const options: HarnessOptions = {
      model: opts.model,
      leafModel: opts.leafModel,
      rootModel: opts.rootModel,
      judgeModel: opts.judgeModel,
      provider,
      maxTurns: parsePositiveInt(opts.maxTurns),
      timeCapMs: parsePositiveInt(opts.timeCapMs),
      costCapUsd: opts.costCapUsd === undefined ? null : Number(opts.costCapUsd),
      budgets: { zoneB: 8000, zoneC: 30000 },
      keepSandbox: opts.keepSandbox === true,
      temperature: opts.temperature === undefined ? null : Number(opts.temperature),
    };
    if (options.temperature != null && !(options.temperature >= 0 && options.temperature <= 1)) {
      throw new Error(`--temperature must be in [0, 1], got "${opts.temperature}"`);
    }

    const runId = opts.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    const results: RunResult[] = [];
    let loaded = 0;

    for (const benchmarkId of benchmarkIds) {
      const dir = join(resolve(opts.scenariosDir), benchmarkId);
      let scenarios: Scenario[];
      try {
        scenarios = adapterFor(benchmarkId).load(dir);
      } catch (error) {
        console.error(`[eval] skipping ${benchmarkId}: ${(error as Error).message}`);
        continue;
      }
      if (opts.limit !== undefined) scenarios = scenarios.slice(0, opts.limit);
      loaded += scenarios.length;
      console.error(`[eval] ${benchmarkId}: ${scenarios.length} scenario(s) from ${dir}`);
      for (const scenario of scenarios) {
        for (const arm of arms) {
          process.stderr.write(`[eval] ${benchmarkId}/${scenario.id} arm=${arm} ... `);
          const { result } = await runScenario({ runId, scenario, arm, agentProvider, options, sink });
          results.push(result);
          process.stderr.write(
            `${result.status} success=${result.success} tokens=${result.metrics.tokens.total} ` +
              `turns=${result.metrics.turns.modelTurns} cost=${result.metrics.costUsd.toFixed(4)}\n`,
          );
        }
      }
    }

    if (loaded === 0) {
      console.error('[eval] no scenarios loaded — nothing to run');
      process.exitCode = 1;
    } else {
      const markdown = renderMarkdownReport({ runId, results, model: options.model, provider });
      const paths = writeReportFiles(opts.out, runId, results, markdown);
      console.error(`[eval] wrote ${paths.resultsPath}`);
      console.error(`[eval] wrote ${paths.reportPath}`);
    }
    await sink.shutdown();
  });

await program.parseAsync();

