/**
 * Automation Bench: `automation-bench.jsonl` — automation/workflow tasks with
 * optional rubrics or expected outcomes.
 */
import type { Adapter, Scenario } from '../types.js';
import { fieldOf, filesFromRow, judgeFromRow, loadJsonlScenarios } from './util.js';

export const AUTOMATION_BENCH_ID = 'automation-bench';

const FILENAME = 'automation-bench.jsonl';

export const automationBenchAdapter: Adapter = {
  id: AUTOMATION_BENCH_ID,
  load(dir: string): Scenario[] {
    return loadJsonlScenarios(AUTOMATION_BENCH_ID, dir, [FILENAME], (row, index, where) => {
      const task = fieldOf(row, ['task', 'prompt', 'instruction', 'goal']);
      if (task === undefined) {
        throw new Error(`${where}: expected one of task|prompt|instruction|goal`);
      }
      return {
        id: fieldOf(row, ['id', 'task_id', 'instance_id']) ?? `row-${index + 1}`,
        benchmark: AUTOMATION_BENCH_ID,
        task,
        files: filesFromRow(AUTOMATION_BENCH_ID, row, where),
        judge: judgeFromRow(row),
        meta: { source: FILENAME },
      };
    });
  },
};
