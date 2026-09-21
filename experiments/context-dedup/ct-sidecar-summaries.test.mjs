import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingest, openTaskStore, resolveConfig } from '../../packages/core/dist/index.js';
import { makeSummaries } from './ct-sidecar.mjs';

const TS = '2026-09-21T00:00:00.000Z';
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

test('a closed phase is summarized once, in the background, and the summary lands in the store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-sum-'));
  const handle = openTaskStore(resolveConfig({ root, taskTitle: 't' }));
  try {
    const { trace, blobs } = handle;
    trace.append({ type: 'user_message', ts: TS, blob: blobs.put('fix price()') });
    const read = trace.append({ type: 'tool_call', ts: TS, tool: 'Read', path: 'a.ts' });
    trace.append({ type: 'tool_result', ts: TS, call_seq: read.seq, output_blob: blobs.put('export const price = 1;') });
    const edit = trace.append({ type: 'tool_call', ts: TS, tool: 'Edit', path: 'a.ts', blob: blobs.put('export const price = 2;') });
    trace.append({ type: 'tool_result', ts: TS, call_seq: edit.seq, output_blob: blobs.put('ok') });
    ingest({ handle });
    const closed = handle.store.byKind('phase').filter((p) => p.status !== 'open');
    assert.ok(closed.length >= 1, 'the fixture has a closed phase');

    let calls = 0;
    const provider = {
      id: 'fake',
      complete: async (request) => {
        calls += 1;
        const meta = { files: [{ path: 'a.ts', start_line: 1, end_line: 1 }], symbols: [], tests: [], artifacts: [], open_questions: [], decisions: [], node_ids: [] };
        return { text: JSON.stringify({ text: 'Read a.ts and found price hard-coded.', meta }), model: request.model, usage, toolCalls: [], stopReason: 'stop' };
      },
    };
    const tick = makeSummaries(handle, { provider, model: 'local-model', maxTokens: 1024 });
    tick();
    tick(); // a second poll must not ask for the same phase again
    await new Promise((resolve) => setTimeout(resolve, 50));
    tick();
    // One request per phase, plus at most the summarizer's own single contract retry — never a
    // second round because the poll ran again.
    assert.ok(calls >= closed.length && calls <= 2 * closed.length, `${calls} calls for ${closed.length} phases`);
    const settled = calls;
    tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, settled);
    assert.ok(closed.some((p) => /price hard-coded/.test(handle.store.currentSummary(p.id)?.text ?? '')));
  } finally {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
