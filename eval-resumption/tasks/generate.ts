/**
 * Writes the task set and its fixtures to disk.
 *
 * The `.json` files are generated and committed. `loadTasks()` reads a
 * directory of JSON, which is the harness's contract and the CLI's default, so
 * the JSON has to exist; and generating it from `definitions.ts` is what keeps
 * a task's `golden` in step with the edits in its trace, which is the one
 * inconsistency a reviewer could not see by reading either file alone.
 *
 * Regenerate both layers with:
 *
 *   node node_modules/.pnpm/vite-node@*\/node_modules/vite-node/vite-node.mjs \
 *     --config vitest.config.ts eval/tasks/generate.ts -- --write
 *
 * `tasks.test.ts` asserts the committed bytes equal a fresh generation, so a
 * forgotten regeneration fails the suite instead of drifting.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFixtures, type GeneratedFile } from '../fixtures/generate.js';
import { TASK_FILES } from './definitions.js';

/** `eval/tasks/`, resolved from this module so a caller's cwd cannot move it. */
export const TASKS_DIR = dirname(fileURLToPath(import.meta.url));

const GENERATED_NOTE =
  'Generated from eval/tasks/definitions.ts; every trace is synthetic. Do not hand-edit — see eval/tasks/generate.ts.';

export function taskFileContents(): GeneratedFile[] {
  return TASK_FILES.map((file) => ({
    name: file.name,
    content: `${JSON.stringify({ _generated: GENERATED_NOTE, tasks: file.tasks }, null, 2)}\n`,
  }));
}

export function writeTaskFiles(dir: string = TASKS_DIR): string[] {
  return taskFileContents().map((file) => {
    const target = join(dir, file.name);
    writeFileSync(target, file.content, 'utf8');
    return target;
  });
}

// vite-node leaves its own path in `argv[1]`, so an entry-point check would
// never fire; the explicit flag is what makes this runnable and importable.
if (process.argv.includes('--write')) {
  const written = [...writeFixtures(), ...writeTaskFiles()];
  process.stdout.write(`${String(written.length)} files written\n`);
}
