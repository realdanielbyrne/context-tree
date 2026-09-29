import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.js';
import { ingest, openTaskStore, rebuild } from '../src/ingest/index.js';
import { foldsFrom, replaySummaries, writeSummary } from '../src/segment/index.js';
import type { TraceEvent } from '../src/contracts/index.js';

const TS = '2026-09-21T00:00:00.000Z';
const META = { files: [], symbols: [], tests: [], artifacts: [], open_questions: [], decisions: [], node_ids: [] };

describe('the fold ledger (D26): L0 is the truth for stubs and summaries', () => {
  const ev = (seq: number, e: Record<string, unknown>): TraceEvent => ({ seq, ts: TS, ...e }) as TraceEvent;

  it('folds are read back in order, an unfold retires one, and ranges may overlap', () => {
    const folds = foldsFrom([
      ev(1, { type: 'user_message', blob: 'b' }),
      ev(2, { type: 'fold', fold_id: 'm2', kind: 'summary', from_seq: 1, to_seq: 65, blob: 'x' }),
      ev(3, { type: 'fold', fold_id: 'm3', kind: 'summary', from_seq: 40, to_seq: 85, blob: 'y' }),
      ev(4, { type: 'fold', fold_id: 's5', kind: 'stub', from_seq: 5, to_seq: 5, blob: 'z' }),
      ev(5, { type: 'unfold', fold_id: 's5' }),
    ]);
    expect(folds.map((f) => [f.id, f.fromSeq, f.toSeq])).toEqual([['m2', 1, 65], ['m3', 40, 85]]);
  });

  it('a summary is a fold event first and a node_summaries row second; a rebuild gets it back at the same version', () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-ledger-'));
    const config = resolveConfig({ root, taskTitle: 'ledger' });
    const handle = openTaskStore(config);
    try {
      const { trace, blobs, store } = handle;
      trace.append({ type: 'user_message', ts: TS, blob: blobs.put('fix it') });
      const call = trace.append({ type: 'tool_call', ts: TS, tool: 'Edit', path: 'a.ts', blob: blobs.put('x') });
      trace.append({ type: 'tool_result', ts: TS, call_seq: call.seq, output_blob: blobs.put('ok') });
      ingest({ handle });
      const phase = store.byKind('phase')[0]!;
      const ledger = { trace, blobs };
      writeSummary(store, { node_id: phase.id, model: 'm', text: 'first', meta: META, created_at: TS }, ledger, 'test');
      writeSummary(store, { node_id: phase.id, model: 'm', text: 'second', meta: META, created_at: TS }, ledger, 'test');
      expect(trace.all().filter((e) => e.type === 'fold')).toHaveLength(2);
      expect(store.currentSummary(phase.id)?.version).toBe(2);

      // Ingesting again writes nothing twice.
      const again = ingest({ handle });
      expect(again.stats.summariesReplayed).toBe(0);
      expect(store.summaryVersions(phase.id)).toHaveLength(2);
      // The fold events widen no segment: the phase still ends at its last content event.
      expect(store.getNode(phase.id)?.span_end_seq).toBe(3);

      handle.close();
      const rebuilt = rebuild(config);
      try {
        const back = rebuilt.handle.store.byKind('phase')[0]!;
        expect(rebuilt.handle.store.currentSummary(back.id)).toMatchObject({ version: 2, text: 'second' });
        expect(rebuilt.handle.store.summaryVersion(back.id, 1)?.text).toBe('first');
        expect(replaySummaries(rebuilt.handle.trace.all(), rebuilt.handle.blobs, rebuilt.handle.store)).toEqual({ summaries: 0, unresolved: 0 });
      } finally {
        rebuilt.handle.close();
      }
    } finally {
      try { handle.close(); } catch { /* closed above */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
