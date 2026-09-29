import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeuristicTokenizer } from '../../packages/core/dist/index.js';
import { TOKENIZER_ID, messageTokens, sizeOf } from './oc-plugin/size.mjs';

const core = new HeuristicTokenizer();

test('the plugin sizes with the tokenizer the sidecar budgets with', () => {
  assert.equal(TOKENIZER_ID, core.id);
  const text = 'def test_timezone(self):\n    return connection.ops.adapt(value)';
  assert.equal(messageTokens({ parts: [{ type: 'text', text }] }), core.count(text));
});

test('reasoning, tool input and tool output are all sized — the host sends all three', () => {
  const input = { filePath: 'a.py', offset: 10 };
  const message = { parts: [
    { type: 'reasoning', text: 'the fixture is stale' },
    { type: 'tool', state: { input, output: 'line one\nline two' } },
    { type: 'step-start' },
  ] };
  assert.equal(messageTokens(message), core.count('the fixture is stale') + core.count(JSON.stringify(input)) + core.count('line one\nline two'));
  assert.equal(sizeOf([message, message]), 2 * messageTokens(message));
  assert.equal(messageTokens({}), 0);
});
