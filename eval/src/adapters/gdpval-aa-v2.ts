/**
 * GDPval-AA v2: `gdpval-aa.jsonl` — open-ended, economically valuable tasks
 * graded by an LLM judge against the row's rubric (the "AA" agentic-assembly
 * condition). Deliverable/reference file lists land in meta for provenance.
 */
import type { Adapter, Scenario } from '../types.js';
import { fieldOf, filesFromRow, judgeFromRow, loadJsonlScenarios } from './util.js';

export const GDPVAL_AA_V2_ID = 'gdpval-aa-v2';

const FILENAME = 'gdpval-aa.jsonl';

export const gdpvalAaV2Adapter: Adapter = {
  id: GDPVAL_AA_V2_ID,
  load(dir: string): Scenario[] {
    return loadJsonlScenarios(GDPVAL_AA_V2_ID, dir, [FILENAME], (row, index, where) => {
      const task = fieldOf(row, ['prompt', 'task', 'instruction', 'question']);
      if (task === undefined) {
        throw new Error(`${where}: expected one of prompt|task|instruction|question`);
      }
      return {
        id: fieldOf(row, ['task_id', 'id', 'instance_id']) ?? `row-${index + 1}`,
        benchmark: GDPVAL_AA_V2_ID,
        task,
        files: filesFromRow(GDPVAL_AA_V2_ID, row, where),
        judge: judgeFromRow(row),
        meta: {
          source: FILENAME,
          occupation: fieldOf(row, ['occupation', 'industry']),
          deliverables: row['deliverables'] === undefined ? undefined : JSON.stringify(row['deliverables']),
        },
      };
    });
  },
};
