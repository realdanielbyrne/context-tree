import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { replayAttentionCapture, recurrenceProof } from './replay-attention-policies.mjs';

function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ct-policy-replay-'));
  mkdirSync(join(directory, 'blobs'));
  const rows = [];
  const put = (text) => {
    const id = createHash('sha256').update(text).digest('hex');
    writeFileSync(join(directory, 'blobs', id), text);
    return id;
  };
  const record = (kind, value) => rows.push({ seq: rows.length + 1, kind, value });
  const original = 'export class FutureCounter {}\n' + 'ordinary source code\n'.repeat(100);
  const request = { model: 'fixture', system: 'Inspect source.', messages: [{ role: 'user', content: 'Inspect the file.' }], tools: [] };
  const requestBlob = put(JSON.stringify(request));
  const firstText = options.firstText ?? 'I have enough information to inspect this file.';
  const firstResponse = { text: firstText, toolCalls: [{ id: 'read1', name: 'read_file', input: { path: 'source.ts' } }] };
  const originalBlob = put(options.original ?? original);
  record('manifest', { version: 1, runId: 'fixture', arm: 'native', scenario: { id: 'fixture' }, options: { model: 'fixture', window: 10_000 } });
  record('request', { attempt: 1, role: 'agent', requestBlob });
  record('response', { attempt: 1, role: 'agent', requestBlob, responseBlob: put(JSON.stringify(firstResponse)) });
  record('read_file', { path: 'source.ts', blob: originalBlob });
  const nextRequest = { ...request, messages: [...request.messages, { role: 'assistant', content: firstText }, { role: 'user', content: `[tool_result read_file] ${options.original ?? original}` }] };
  const nextRequestBlob = put(JSON.stringify(nextRequest));
  record('request', { attempt: 2, role: 'agent', requestBlob: nextRequestBlob });
  record('response', { attempt: 2, role: 'agent', requestBlob: nextRequestBlob, responseBlob: put(JSON.stringify({ text: options.nextText ?? 'FutureCounter is the referenced class.', toolCalls: [] })) });
  if (options.closed !== false) record('capture_complete', {});
  writeFileSync(join(directory, 'events.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return { directory, originalBlob, rows, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test('native replay separates prefix features from later observed references', () => {
  const first = fixture();
  const differentFuture = fixture({ nextText: 'An unrelated result with NoEvidenceClass.' });
  try {
    const a = replayAttentionCapture(first.directory, { excerptChars: 64 });
    const b = replayAttentionCapture(differentFuture.directory, { excerptChars: 64 });
    assert.equal(a.signals.length, 1);
    assert.equal(a.signals[0].source, 'capture_agent_response');
    assert.equal(a.signals[0].offsetsValid, true);
    assert.equal(a.summary.contextCallsIssued, 0);
    assert.equal(a.payloads[0].status, 'measured');
    assert.deepEqual(a.payloads[0].features, b.payloads[0].features);
    assert.deepEqual(a.payloads[0].variants, b.payloads[0].variants);
    assert.ok(a.payloads[0].outcomes.novelReferencedIdentifiers.includes('FutureCounter'));
    assert.deepEqual(b.payloads[0].outcomes.referencedIdentifiers, []);
    assert.equal(a.payloads[0].firstVsRarestChanged, false); // read_file supplies no query terms.
    assert.equal(a.payloads[0].variants[3].status, 'unsupported_structure');
    assert.equal(a.eligibility.priority.nextFetchAuc, null);
    assert.equal(a.eligibility.H1.eligible, false);
    assert.equal(a.eligibility.H6.eligible, false);
  } finally { first.dispose(); differentFuture.dispose(); }
});

test('tool-output phrases and quoted assistant phrases never become H4 features', () => {
  const input = fixture({ firstText: '"I have enough information to inspect this file."', original: 'Should I implement the plan? I have enough information.' });
  try {
    const report = replayAttentionCapture(input.directory, { excerptChars: 64 });
    assert.deepEqual(report.signals, []);
  } finally { input.dispose(); }
});

test('missing calibration inputs and unfinished captures remain unavailable', () => {
  const input = fixture({ closed: false });
  try {
    const report = replayAttentionCapture(input.directory);
    assert.equal(report.closedCapture, false);
    assert.equal(report.payloads[0].status, 'unavailable');
    assert.equal(report.summary.referencedFractionMean, null);
    assert.equal(report.eligibility.H4.status, 'missing_labels');
  } finally { input.dispose(); }
});

test('rejects corrupted source blobs and legacy telemetry', () => {
  const input = fixture();
  try {
    writeFileSync(join(input.directory, 'blobs', input.originalBlob), 'tampered');
    assert.throws(() => replayAttentionCapture(input.directory, { excerptChars: 64 }), /digest mismatch/);
    writeFileSync(join(input.directory, 'events.jsonl'), JSON.stringify({ seq: 1, kind: 'legacy', value: {} }) + '\n');
    assert.throws(() => replayAttentionCapture(input.directory), /RunCapture v1/);
  } finally { input.dispose(); }
});

test('API→UI→tests proof validates recurrence, pins, source order and supersession', () => {
  const proof = recurrenceProof();
  assert.equal(proof.passed, true);
  assert.equal(proof.checks.supersededPriorityZeroDespiteLaterReference, true);
  assert.equal(proof.checks.supersessionDoesNotEraseRelevantHistory, true);
  assert.equal(proof.checks.futureSupersessionIgnored, true);
});

test('CLI writes reproducible JSON without timestamps or model calls', () => {
  const input = fixture();
  try {
    const script = fileURLToPath(new URL('./replay-attention-policies.mjs', import.meta.url));
    const first = join(input.directory, 'first.json');
    const second = join(input.directory, 'second.json');
    for (const output of [first, second]) execFileSync(process.execPath, [script, '--capture-dir', input.directory, '--excerpt-chars', '64', '--output', output]);
    assert.equal(readFileSync(first, 'utf8'), readFileSync(second, 'utf8'));
    assert.equal(JSON.parse(readFileSync(first, 'utf8')).syntheticRecurrenceProof.passed, true);
  } finally { input.dispose(); }
});
