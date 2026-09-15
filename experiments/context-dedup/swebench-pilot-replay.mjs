/**
 * Deterministic REPLAY of a pilot run's tool calls, to measure what the agent actually SAW.
 *
 * lib.mjs's toolLog keeps only the first 200 characters of each tool result, so a results
 * file cannot say whether a result was clipped or identical to the previous one. The
 * workspace is a fixed commit, so replaying every recorded call against a fresh workspace
 * reproduces each result exactly (read-only calls; the v1 runs made no edits, which this
 * script checks and refuses to replay past).
 *
 *   node experiments/context-dedup/swebench-pilot-replay.mjs results-swebench-pilot-v1.json
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkspace } from '../coding-harness/lib.mjs';
import { execToolClip } from './swebench-agent.mjs';
import { makeSwebenchTask } from './ab-tasks/swebench.mjs';
import { writeResults, nowISO } from '../rung-1-live-probe/lib.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports', 'metrics', 'swebench-pilot');
const file = process.argv[2];
if (!file) throw new Error('usage: swebench-pilot-replay.mjs <results file in reports/metrics/swebench-pilot>');
const src = JSON.parse(readFileSync(join(OUT, file), 'utf8'));
const clipChars = src.manifest.clip_chars ?? 2000;

const runs = [];
for (const c of src.cells) {
  if (c.writes + c.edits > 0) throw new Error(`${file} rep${c.repeat} edited files; a read-only replay would not reproduce it`);
  const task = makeSwebenchTask(c.instance);
  const ws = makeWorkspace();
  task.seed(ws);
  let clipped = 0, rejected = 0, sameAsPrevVisible = 0, longestSameVisible = 1, cur = 1, prev = null, argsAtCap = 0;
  for (const t of c.tool_trace) {
    if (t.arg.length >= 160) argsAtCap += 1;
    const args = t.name === 'run_bash' ? { command: t.arg } : t.name === 'read_file' ? { path: t.arg } : {};
    const out = execToolClip(ws, t.name, args, clipChars);
    if (/chars truncated\]$/.test(out)) clipped += 1;
    if (/^error: command/.test(out)) rejected += 1;
    // "visible" = what the model saw, minus the truncation marker, whose char count changes
    // with -A N even when the visible text does not.
    const visible = out.replace(/\n…\[\d+ chars truncated\]$/, '');
    if (prev !== null && visible === prev) { sameAsPrevVisible += 1; cur += 1; longestSameVisible = Math.max(longestSameVisible, cur); } else cur = 1;
    prev = visible;
  }
  runs.push({
    instance: c.instance, repeat: c.repeat, tool_calls: c.tool_trace.length, clip_chars: clipChars,
    clipped_outputs: clipped, rejected_commands: rejected,
    results_identical_to_previous_visible: sameAsPrevVisible, longest_identical_visible_result_streak: longestSameVisible,
    args_at_trace_cap: argsAtCap,
  });
  console.error(`rep${c.repeat}: calls=${c.tool_trace.length} clipped=${clipped} rejected=${rejected} same-visible=${sameAsPrevVisible} longest-streak=${longestSameVisible} args-at-cap=${argsAtCap}`);
}
const path = writeResults('swebench-pilot', file.replace(/^results-/, 'results-replay-'), {
  manifest: { source: file, clip_chars: clipChars, date: nowISO(), note: 'read-only deterministic replay of recorded tool calls against a fresh workspace at base_commit' },
  runs,
});
console.error(`written: ${path}`);
