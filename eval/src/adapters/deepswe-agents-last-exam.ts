/**
 * JSONL benchmarks share one shape: a dataset file of JSON objects with an id,
 * a task/prompt and whatever grading material the row carries. Each adapter
 * below is a thin declaration of filenames and key aliases over
 * `loadJsonlScenarios`; format variance across dataset revisions is absorbed
 * by the key-alias lists rather than by per-row guessing.
 *
 * DeepSWE AgentsLastExam: `agents-last-exam.jsonl` — hard agentic tasks with
 * optional reference answers / rubrics.
 */
import type { Adapter, Scenario } from '../types.js';
import { fieldOf, filesFromRow, judgeFromRow, loadJsonlScenarios } from './util.js';

export const DEEPSWE_AGENTS_LAST_EXAM_ID = 'deepswe-agents-last-exam';

const FILENAME = 'agents-last-exam.jsonl';

export const deepsweAgentsLastExamAdapter: Adapter = {
  id: DEEPSWE_AGENTS_LAST_EXAM_ID,
  load(dir: string): Scenario[] {
    return loadJsonlScenarios(DEEPSWE_AGENTS_LAST_EXAM_ID, dir, [FILENAME], (row, index, where) => {
      const task = fieldOf(row, ['task', 'prompt', 'instruction', 'problem']);
      if (task === undefined) {
        throw new Error(`${where}: expected one of task|prompt|instruction|problem`);
      }
      return {
        id: fieldOf(row, ['id', 'task_id', 'instance_id']) ?? `row-${index + 1}`,
        benchmark: DEEPSWE_AGENTS_LAST_EXAM_ID,
        task,
        files: filesFromRow(DEEPSWE_AGENTS_LAST_EXAM_ID, row, where),
        judge: judgeFromRow(row),
        meta: { source: FILENAME },
      };
    });
  },
};
