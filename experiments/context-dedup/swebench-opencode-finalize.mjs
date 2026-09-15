/**
 * Finalize opencode pilot runs: re-export every session to a FILE, check each captured event
 * stream against its export, import each export into context-tree, and merge worker result
 * files into one tranche file.
 *
 * Why: runs launched before the pipe fix captured `opencode export` (and the event stream)
 * through a pipe, which truncates a large final write. Each run's XDG session store is kept,
 * so the export can be regenerated exactly; the event stream cannot, so a stream that lost
 * events is FLAGGED (events_complete=false) and its token accounting treated as a lower bound.
 *
 * Runs ONLY when executed directly. It used to run at import time, so merely importing it to
 * check its imports re-exported every session and rewrote the tranche file (2026-09-15 15:54;
 * idempotent that time, since every field is recomputed from the worker files and run dirs).
 *
 *   node experiments/context-dedup/swebench-opencode-finalize.mjs
 *     CT_FINALIZE_INPUTS=results-swebench-opencode-probe-2931-b.json  (single file, rewritten in place)
 *     default: merges tranche-w1..w3 into results-swebench-opencode-tranche.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { exportSession } from './swebench-opencode.mjs';
import { parseJsonLines, summarizeEvents, summarizeExport } from './swebench-opencode-events.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = join(REPO, 'reports', 'metrics', 'swebench-pilot');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const OPENCODE_CONFIG = join(HERE, 'opencode.json');

function main() {
  const inputs = (process.env.CT_FINALIZE_INPUTS || 'results-swebench-opencode-tranche-w1.json,results-swebench-opencode-tranche-w2.json,results-swebench-opencode-tranche-w3.json').split(',');
  const output = process.env.CT_FINALIZE_OUTPUT || (inputs.length === 1 ? inputs[0] : 'results-swebench-opencode-tranche.json');

  const docs = inputs.map((f) => {
    const p = join(OUT, f);
    if (!existsSync(p)) throw new Error(`finalize requires ${f}`);
    return { file: f, doc: JSON.parse(readFileSync(p, 'utf8')) };
  });

  const cells = [];
  for (const { file, doc } of docs) {
    for (const c of doc.cells) {
      const ws = join(c.run_dir, 'workspace');
      const env = {
        ...process.env, OPENCODE_CONFIG,
        XDG_CONFIG_HOME: join(c.run_dir, 'xdg', 'config'), XDG_DATA_HOME: join(c.run_dir, 'xdg', 'data'),
        XDG_STATE_HOME: join(c.run_dir, 'xdg', 'state'), XDG_CACHE_HOME: join(c.run_dir, 'xdg', 'cache'),
      };
      const ex = exportSession({ runDir: c.run_dir, ws, env, sessionID: c.session_id, eventSummary: { steps: c.steps, tool_calls: c.tool_calls } });

      let imp = { ok: false };
      if (ex.export_ok) {
        const root = join(c.run_dir, 'context-tree');
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true });
        const r = spawnSync('node', [CLI, 'import', '--from-opencode', '--root', root, '--json', join(c.run_dir, 'export.json')], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        try {
          const j = JSON.parse(r.stdout);
          imp = { ok: j.failures.length === 0, events: j.events, skipped: j.skipped, failures: j.failures.length, nodes: j.stats.nodes, phases: j.stats.phases, file_nodes: j.stats.fileNodes, unmapped_tools: j.stats.unmappedTools };
        } catch { imp = { ok: false, error: (r.stdout || r.stderr || '').slice(0, 300) }; }
      }

      let exportSummary = null;
      if (ex.export_ok) {
        try { const t = readFileSync(join(c.run_dir, 'export.json'), 'utf8'); exportSummary = summarizeExport(JSON.parse(t.slice(t.indexOf('{')))); } catch {}
      }
      const evFile = join(c.run_dir, 'events.jsonl');
      const evSummary = existsSync(evFile) ? summarizeEvents(parseJsonLines(readFileSync(evFile, 'utf8')).events) : null;
      const merged = {
        ...c,
        final_step_reason: evSummary?.final_step_reason ?? null,
        length_stops: evSummary?.length_stops ?? null,
        ended_on_output_limit: evSummary?.final_step_reason === 'length',
        max_step_response_tokens: evSummary?.max_step_response_tokens ?? null,
        // Reasoning measured from the transcript (the local host reports reasoning_tokens 0).
        reasoning_parts: exportSummary?.reasoning_parts ?? null,
        reasoning_chars: exportSummary?.reasoning_chars ?? null,
        export_ok: ex.export_ok, export_part_types: ex.export_part_types, export_bytes: ex.export_bytes,
        events_complete: ex.events_complete, events_missing_steps: ex.missing_steps, events_missing_tool_calls: ex.missing_tool_calls,
        context_tree_import: imp, finalized_from: file,
      };
      cells.push(merged);
      console.error(`${c.instance.padEnd(34)} export=${ex.export_ok} ${ex.export_bytes}B events_complete=${ex.events_complete} import_ok=${imp.ok} events=${imp.events ?? '-'}`);
    }
  }

  const manifest = {
    ...docs[0].doc.manifest,
    run_id: `swebench-opencode-${output.replace(/^results-swebench-opencode-|\.json$/g, '')}`,
    merged_from: inputs,
    finalized_at: new Date().toISOString(),
    finalize_note: 'exports regenerated to file from each run\'s XDG session store; event streams checked against exports; exports imported into context-tree',
  };
  writeFileSync(join(OUT, output), JSON.stringify({ manifest, cells }, null, 2));
  console.error(`written: ${join(OUT, output)} (${cells.length} cells)`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
