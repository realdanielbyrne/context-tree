/**
 * HLE w/ Tools: `hle.jsonl` — Humanity's Last Exam questions graded by exact
 * match against the reference answer; the agent has its tools available (the
 * "w/ Tools" condition). Image-bearing rows are loaded but flagged in meta:
 * this harness is text-only, so a multimodal row is a documented limitation,
 * not a silent mismatch.
 */
import type { Adapter, Scenario } from '../types.js';
import { fieldOf, filesFromRow, judgeFromRow, loadJsonlScenarios } from './util.js';

export const HLE_TOOLS_ID = 'hle-tools';

const FILENAME = 'hle.jsonl';

export const hleToolsAdapter: Adapter = {
  id: HLE_TOOLS_ID,
  load(dir: string): Scenario[] {
    return loadJsonlScenarios(HLE_TOOLS_ID, dir, [FILENAME], (row, index, where) => {
      const task = fieldOf(row, ['question', 'prompt', 'task']);
      if (task === undefined) {
        throw new Error(`${where}: expected one of question|prompt|task`);
      }
      const judge = judgeFromRow(row);
      if (judge.kind !== 'exact_match') {
        throw new Error(`${where}: HLE rows must carry an "answer" for exact-match grading`);
      }
      return {
        id: fieldOf(row, ['id', 'question_id']) ?? `row-${index + 1}`,
        benchmark: HLE_TOOLS_ID,
        task,
        files: filesFromRow(HLE_TOOLS_ID, row, where),
        judge,
        meta: {
          source: FILENAME,
          category: fieldOf(row, ['category', 'subject', 'domain']),
          image: row['image'] === undefined ? undefined : 'image content omitted (text-only harness)',
        },
      };
    });
  },
};
