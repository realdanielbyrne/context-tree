/**
 * Recover completed cells from a sensitivity-control run log that was killed
 * before it could write its results file.
 *
 * The `uncapped-ballast` run was terminated by the OOM killer partway through its
 * second cell, so the first cell — which is the decisive displacement-vs-distraction
 * datapoint — existed only as a console line. This parses those lines back into a
 * results file rather than losing the measurement or retyping it by hand.
 *
 * The output is STAMPED `recovered_from_log: true` and carries only the fields the
 * console actually printed; everything the log did not contain is `null`, never
 * guessed. A recovered file must never be mistaken for a complete run.
 *
 * Usage: node experiments/context-dedup/recover-run-log.mjs <run.log> <out.json> [tag]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [, , logPath, outPath, tag] = process.argv;
if (!logPath || !outPath) {
  console.error('usage: recover-run-log.mjs <run.log> <out.json> [tag]');
  process.exit(2);
}

const text = readFileSync(logPath, 'utf8');
const lines = text.split('\n');
const cells = [];
let pending = null;

for (const line of lines) {
  const head = line.match(/^---\s+rep(\d+)\s+W=(\d+)\s+(\S+)\s+---/);
  if (head) { pending = { repeat: +head[1], window: +head[2], arm: head[3] }; continue; }
  const res = line.match(/->\s+(PASS|FAIL)\s+turns=(\d+)\s+writes=(\d+)\s+evict=(\d+)\s+peak=(\d+)\s+useful=(\d+)\s+junk%=(\d+)\s+tok=(\d+)/);
  if (res && pending) {
    const uncapped = pending.arm.startsWith('uncapped');
    cells.push({
      arm: pending.arm,
      window: uncapped ? null : pending.window,
      repeat: pending.repeat,
      pass: res[1] === 'PASS',
      turns: +res[2],
      writes: +res[3],
      evictions: +res[4],
      peak_history_tokens: +res[5],
      useful_tokens_mean: +res[6],
      junk_share_mean: +res[7] / 100,
      total_prompt_tokens: +res[8],
      // not printed to the console, so not knowable from the log
      junk_tokens_mean: null, useful_peak: null, reads: null, rereads: null,
      cap_violations: null, units_kept_last: null, ballast_injected: null,
      peak_before_evict: null, wall_seconds: null, stop: null, error: null,
      recovered_from_log: true,
    });
    pending = null;
  }
}

if (!cells.length) { console.error('no completed cells found in the log'); process.exit(1); }

const out = {
  manifest: {
    run_id: `recovered-${tag ?? basename(logPath)}-${Date.now()}`,
    experiment: 'context-dedup / instrument-sensitivity positive control (RECOVERED FROM RUN LOG)',
    recovered_from_log: basename(logPath),
    date: new Date().toISOString(),
    incomplete: true,
    caveats: [
      'RECOVERED from console output after the run was killed (OOM) before writing its results file. Only cells that had already printed a result line are present.',
      'Fields the console did not print are null, not estimated. Do not treat this file as a complete run.',
      'No summary, tests or validity block: those are computed over a full arm set and cannot be reconstructed from partial console output.',
    ],
  },
  summary: null, tests: null, validity: null,
  cells,
};
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`recovered ${cells.length} cell(s) -> ${outPath}`);
for (const c of cells) console.log(`  ${c.arm}@${c.window ?? 'inf'} rep${c.repeat}: ${c.pass ? 'PASS' : 'FAIL'} writes=${c.writes} peak=${c.peak_history_tokens} useful=${c.useful_tokens_mean} junk=${(c.junk_share_mean * 100).toFixed(0)}%`);
