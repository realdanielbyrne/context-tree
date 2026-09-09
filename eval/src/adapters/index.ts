/**
 * The benchmark registry. Each id is a directory name under the scenarios root
 * and a value accepted by `--benchmarks`.
 */
import { deepSweAdapter, DEEPSWE_ID } from './deepswe.js';
import type { Adapter } from '../types.js';
import { automationBenchAdapter, AUTOMATION_BENCH_ID } from './automation-bench.js';
import { deepsweAgentsLastExamAdapter, DEEPSWE_AGENTS_LAST_EXAM_ID } from './deepswe-agents-last-exam.js';
import { gdpvalAaV2Adapter, GDPVAL_AA_V2_ID } from './gdpval-aa-v2.js';
import { hleToolsAdapter, HLE_TOOLS_ID } from './hle-tools.js';
import { lhtbAdapter, LHTB_ID } from './lhtb.js';
import { TERMINAL_BENCH_ID, terminalBenchAdapter } from './terminal-bench.js';

export const ADAPTERS: readonly Adapter[] = [
  terminalBenchAdapter,
  deepSweAdapter,
  lhtbAdapter,
  deepsweAgentsLastExamAdapter,
  automationBenchAdapter,
  hleToolsAdapter,
  gdpvalAaV2Adapter,
];

export const BENCHMARK_IDS: readonly string[] = ADAPTERS.map((adapter) => adapter.id);

export { DEEPSWE_ID, LHTB_ID, AUTOMATION_BENCH_ID, DEEPSWE_AGENTS_LAST_EXAM_ID, GDPVAL_AA_V2_ID, HLE_TOOLS_ID, TERMINAL_BENCH_ID };

export function adapterFor(id: string): Adapter {
  const adapter = ADAPTERS.find((candidate) => candidate.id === id);
  if (adapter === undefined) {
    throw new Error(`unknown benchmark "${id}" — known: ${BENCHMARK_IDS.join(', ')}`);
  }
  return adapter;
}
