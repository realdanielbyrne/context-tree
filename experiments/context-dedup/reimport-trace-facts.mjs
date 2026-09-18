/**
 * Re-derive per-run trace facts for both baseline arms from their opencode exports, under the
 * CURRENT segmenter, and write them to a pinned file.
 *
 * Two facts need this rather than the results files:
 *   - segmentation. Each results file carries a `context_tree_import` taken at finalize time, and
 *     the two arms were finalized on opposite sides of D21 (shell tools phased by command).
 *     Comparing those stored counts would report a segmenter change as a model difference.
 *   - compaction. The host records it as a `compaction` message part; nothing rolls it up per cell.
 *
 * Reads each run's export.json and writes no run dir. Rerun:
 *   node experiments/context-dedup/reimport-trace-facts.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = join(REPO, 'reports', 'metrics', 'swebench-pilot');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'bin.js');

const ARMS = {
  swift: 'results-swebench-opencode-baseline-swift-sbx-x3.json',
  q8: 'results-swebench-opencode-baseline-q8-sbx-x3.json',
};

const commit = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const scratch = mkdtempSync(join(tmpdir(), 'ct-trace-facts-'));
const arms = {};

for (const [arm, file] of Object.entries(ARMS)) {
  const { manifest, cells } = JSON.parse(readFileSync(join(OUT, file), 'utf8'));
  const runs = [];
  for (const c of cells) {
    const exp = join(c.run_dir, 'export.json');
    if (!existsSync(exp)) throw new Error(`${arm} ${c.instance} r${c.repeat}: no export at ${exp}`);

    const messages = JSON.parse(readFileSync(exp, 'utf8')).messages;
    let compactions = 0;
    let compactions_on_overflow = 0;
    for (const m of messages) {
      for (const part of m.parts ?? []) {
        if (part.type !== 'compaction') continue;
        compactions++;
        if (part.overflow) compactions_on_overflow++;
      }
    }

    const root = join(scratch, `${arm}-${c.instance}-r${c.repeat}`);
    mkdirSync(root, { recursive: true });
    const r = spawnSync('node', [CLI, 'import', '--from-opencode', '--root', root, '--json', exp],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    let j;
    try { j = JSON.parse(r.stdout); } catch {
      throw new Error(`${arm} ${c.instance} r${c.repeat}: import failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
    }
    if (j.failures.length) throw new Error(`${arm} ${c.instance} r${c.repeat}: ${j.failures.length} import failures`);
    rmSync(root, { recursive: true, force: true });

    runs.push({
      instance: c.instance, repeat: c.repeat, messages: messages.length,
      compactions, compactions_on_overflow,
      events: j.events, skipped: j.skipped, nodes: j.stats.nodes, phases: j.stats.phases,
      file_nodes: j.stats.fileNodes, unmapped_tools: j.stats.unmappedTools,
    });
  }
  const tot = (k) => runs.reduce((s, x) => s + x[k], 0);
  arms[arm] = {
    model: manifest.model, runs,
    totals: {
      events: tot('events'), nodes: tot('nodes'), phases: tot('phases'), file_nodes: tot('file_nodes'),
      compactions: tot('compactions'), compactions_on_overflow: tot('compactions_on_overflow'),
      runs_compacted: runs.filter((x) => x.compactions > 0).length,
    },
  };
  const t = arms[arm].totals;
  console.error(`${arm.padEnd(6)} ${runs.length} runs  events=${t.events} phases=${t.phases} nodes=${t.nodes} compacted=${t.runs_compacted}`);
}

rmSync(scratch, { recursive: true, force: true });
writeFileSync(join(OUT, 'trace-facts-swift-vs-q8.json'), `${JSON.stringify({
  note: 'both arms re-imported under ONE segmenter so phase counts are comparable; the per-arm context_tree_import fields in the results files are NOT (they straddle D21). Compactions counted from the host\'s own `compaction` message parts.',
  generated_at: new Date().toISOString(), segmenter_commit: commit, inputs: ARMS, arms,
}, null, 1)}\n`);
console.error('wrote trace-facts-swift-vs-q8.json');
