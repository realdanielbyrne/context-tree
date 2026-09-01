/**
 * Integration wiring for the §15 benchmark.
 *
 * The harness, the 30 tasks and the fixtures were written by three different
 * authors against a shared spec, so every unit suite can pass while the pieces
 * do not actually compose. This file runs the real task set through the real
 * runner and asserts the two things that would otherwise only be discovered by
 * spending money: that the tasks load and that a run which sent nothing reports
 * `unproven` rather than a pass.
 */
import { describe, expect, it } from 'vitest';
import { loadTasks } from './task-spec.js';
import { runEvaluation, parseRunArgs, DEFAULT_RUN_ARGS } from './run.js';

describe('benchmark wiring smoke', () => {
  it('defaults point at the moved directory, not the concurrent eval/ harness', () => {
    expect(DEFAULT_RUN_ARGS.tasksPath).toContain('eval-resumption');
    expect(DEFAULT_RUN_ARGS.rubricPath).toContain('eval-resumption');
    expect(DEFAULT_RUN_ARGS.outRoot).toContain('eval-resumption');
  });

  it('loads all 30 tasks, written by a different author than the harness', () => {
    const tasks = loadTasks('eval-resumption/tasks');
    const byKind: Record<string, number> = {};
    for (const t of tasks) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
    console.log('TASKS:', tasks.length, 'BY KIND:', JSON.stringify(byKind));
    expect(tasks.length).toBe(30);
    expect(byKind).toEqual({ fresh: 10, resumed: 10, adversarial: 10 });
  });

  it('the harness runs the real task set end to end without a model (dry run)', async () => {
    const args = parseRunArgs(['--dry-run', '--seeds', '1', '--arms', 'A,B,C,D', '--cap', '100'], process.cwd());
    const report = await runEvaluation(args);
    console.log('PROJECTION:', JSON.stringify(report.projection));
    console.log('CRITERIA:', JSON.stringify(report.criteria));
    console.log('CONDITIONS:', JSON.stringify(report.conditions));
    console.log('COST:', JSON.stringify(report.cost));
    expect(report.taskIds).toHaveLength(30);
    // The honesty requirement: a run that sent nothing must not report a pass.
    const verdicts = JSON.stringify(report.criteria);
    expect(verdicts).not.toContain('"pass"');
  }, 180_000);
});
