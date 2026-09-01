/**
 * The §15 task set, loaded and validated.
 *
 * Loading happens at import time and the group-count assertion throws, because
 * a benchmark that quietly runs 28 of its 30 tasks reports a number nobody can
 * interpret. §15 asks for 10 fresh / 10 resumed / 10 adversarial; if the
 * directory does not hold exactly that, the right outcome is a loud failure
 * here rather than a plausible-looking results table later.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_KINDS, loadTasks, type EvalTask, type TaskKind, type TrapKind } from '../harness/task-spec.js';

export const TASKS_DIR = dirname(fileURLToPath(import.meta.url));

/** §15's group size. Ten per kind, thirty in total. */
export const TASKS_PER_GROUP = 10;

function countByKind(tasks: readonly EvalTask[]): Record<TaskKind, number> {
  const counts = { fresh: 0, resumed: 0, adversarial: 0 };
  for (const task of tasks) counts[task.kind] += 1;
  return counts;
}

/**
 * Throws naming the kind and the two numbers. Exported so a test can assert the
 * assertion itself fires — a guard nothing exercises is a guard that will be
 * wrong the first time it matters.
 */
export function assertGroupCounts(tasks: readonly EvalTask[], perGroup = TASKS_PER_GROUP): void {
  const counts = countByKind(tasks);
  const wrong = TASK_KINDS.filter((kind) => counts[kind] !== perGroup);
  if (wrong.length > 0) {
    const detail = wrong.map((kind) => `${kind}: ${String(counts[kind])} (expected ${String(perGroup)})`).join('; ');
    throw new Error(`§15 task set is the wrong shape — ${detail}`);
  }
}

/** Every task in the set, id-sorted by `loadTasks` so runs compare like with like. */
export const TASKS: readonly EvalTask[] = loadTasks(TASKS_DIR);

assertGroupCounts(TASKS);

export const TASK_COUNTS: Readonly<Record<TaskKind, number>> = Object.freeze(countByKind(TASKS));

export function tasksOfKind(kind: TaskKind): EvalTask[] {
  return TASKS.filter((task) => task.kind === kind);
}

export function tasksWithTrap(trap: TrapKind): EvalTask[] {
  return TASKS.filter((task) => task.trap === trap);
}
