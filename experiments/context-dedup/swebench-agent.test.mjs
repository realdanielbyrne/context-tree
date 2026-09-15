/**
 *   node --test experiments/context-dedup/swebench-agent.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable, backoffMs, makeClip } from './swebench-agent.mjs';

test('isRetryable retries rate limits, server errors, dropped connections and 200-with-error bodies', () => {
  assert.equal(isRetryable({ status: 429 }), true);
  assert.equal(isRetryable({ status: 502 }), true);
  assert.equal(isRetryable({ networkError: true }), true);
  assert.equal(isRetryable({ status: 200, bodyError: 'upstream timeout' }), true);
});

test('isRetryable does NOT retry a malformed or unauthorised request', () => {
  // Retrying a 400/401 forever would turn a harness bug into a silent hang, and scoring it
  // would turn it into an apparent model failure.
  assert.equal(isRetryable({ status: 400 }), false);
  assert.equal(isRetryable({ status: 401 }), false);
  assert.equal(isRetryable({ status: 404 }), false);
});

test('backoffMs grows with the attempt and is capped at about a minute', () => {
  assert.ok(backoffMs(1) > backoffMs(0));
  assert.ok(backoffMs(3) > backoffMs(2));
  assert.ok(backoffMs(20) <= 60_500);
});

test('makeClip leaves short output alone and marks truncation', () => {
  assert.equal(makeClip(10)('short'), 'short');
  assert.match(makeClip(5)('0123456789'), /^01234\n…\[10 chars truncated\]$/);
});
