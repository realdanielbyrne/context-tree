/**
 *   node --test experiments/context-dedup/swebench-opencode-events.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLines, sessionIdOf, summarizeEvents, tokensOf, costAt, classifyExit, summarizeExport, eventsCompleteAgainstExport } from './swebench-opencode-events.mjs';

const step = (id, input, output, reasoning, read = 0, write = 0, cost = 0) =>
  ({ type: 'step_finish', sessionID: 'ses_1', part: { id, type: 'step-finish', tokens: { input, output, reasoning, cache: { read, write } }, cost } });
const tool = (callID, name, status, input) => ({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', callID, tool: name, state: { status, input } } });

test('parseJsonLines counts unparseable lines instead of throwing', () => {
  const { events, bad } = parseJsonLines('{"a":1}\nnot json\n\n{"b":2}\n');
  assert.equal(events.length, 2);
  assert.equal(bad, 1);
});

test('sessionIdOf reads the id from the first event that carries one', () => {
  assert.equal(sessionIdOf([{ type: 'x' }, { part: { sessionID: 'ses_9' } }]), 'ses_9');
  assert.equal(sessionIdOf([{ type: 'x' }]), null);
});

test('summarizeEvents sums tokens, keeps reasoning separate, and peaks on the full prompt incl. cache', () => {
  const s = summarizeEvents([step('s1', 9300, 50, 120, 0, 0, 0.01), step('s2', 400, 80, 30, 9300, 0, 0.002)]);
  assert.equal(s.steps, 2);
  assert.deepEqual(s.tokens, { input: 9700, output: 130, reasoning: 150, cache_read: 9300, cache_write: 0 });
  // step 2's prompt is 400 fresh + 9300 cached = 9700; counting `input` alone would say 9300.
  assert.equal(s.peak_prompt_tokens, 9700);
  assert.equal(s.first_step_prompt_tokens, 9300);
  assert.equal(s.cost_reported, 0.012);
});

test('summarizeEvents exposes an output-length stop on the final step', () => {
  // django-11138: reasoning used the entire 16,384-token output budget in one step, opencode
  // exited 0, and the run looked like an ordinary short failure.
  const s = summarizeEvents([
    { type: 'step_finish', part: { id: 'a', type: 'step-finish', reason: 'tool-calls', tokens: { input: 10, output: 5, reasoning: 5 } } },
    { type: 'step_finish', part: { id: 'b', type: 'step-finish', reason: 'length', tokens: { input: 10, output: 0, reasoning: 16384 } } },
  ]);
  assert.equal(s.final_step_reason, 'length');
  assert.equal(s.length_stops, 1);
  // Response size includes reasoning: output alone (5 vs 0) would miss the capped step.
  assert.equal(s.max_step_response_tokens, 16384);
  assert.equal(summarizeEvents([]).final_step_reason, null);
});

test('summarizeEvents counts a step once even if its event is repeated', () => {
  assert.equal(summarizeEvents([step('s1', 10, 1, 0), step('s1', 10, 1, 0)]).steps, 1);
});

test('summarizeEvents counts completed tool calls once, ignoring running updates, and extracts edited/read files', () => {
  const s = summarizeEvents([
    tool('c1', 'read', 'running', { filePath: '/w/a.py' }),
    tool('c1', 'read', 'completed', { filePath: '/w/a.py' }),
    tool('c2', 'read', 'completed', { filePath: '/w/a.py' }),
    tool('c3', 'edit', 'completed', { filePath: '/w/a.py' }),
    tool('c4', 'bash', 'error', { command: 'pytest' }),
  ]);
  assert.equal(s.tool_calls, 4);
  assert.deepEqual(s.tools_by_name, { read: 2, edit: 1, bash: 1 });
  assert.equal(s.tool_errors, 1);
  assert.deepEqual(s.files_edited, ['/w/a.py']);
  assert.deepEqual(s.files_read, ['/w/a.py']);
  assert.equal(s.reads, 2);
});

test('classifyExit attributes SIGTERM to an outside process, never to the runner timeout', () => {
  // The first probe ended with signal SIGTERM and exit null; scoring it, or calling it a
  // timeout, would misreport a host incident as model behaviour.
  const c = classifyExit({ code: null, signal: 'SIGTERM', timedOut: false, steps: 8 });
  assert.equal(c.outcome, 'killed_externally');
  assert.equal(c.killed_externally, true);
  assert.equal(c.valid, false);
});

test('classifyExit: own timeout is a timeout, not an external kill', () => {
  const c = classifyExit({ code: null, signal: 'SIGKILL', timedOut: true, steps: 50 });
  assert.equal(c.outcome, 'timeout');
  assert.equal(c.killed_externally, false);
  assert.equal(c.valid, false);
});

test('classifyExit: exit 0 is valid only with steps and no error events', () => {
  assert.equal(classifyExit({ code: 0, signal: null, timedOut: false, steps: 12, errors: 0 }).valid, true);
  assert.equal(classifyExit({ code: 0, signal: null, timedOut: false, steps: 0 }).outcome, 'no_steps');
  assert.equal(classifyExit({ code: 0, signal: null, timedOut: false, steps: 3, errors: 1 }).outcome, 'error_event');
  assert.equal(classifyExit({ code: 1, signal: null, timedOut: false, steps: 3 }).outcome, 'nonzero_exit');
});

test('summarizeExport counts steps, completed tool calls and part types', () => {
  const doc = { messages: [
    { parts: [{ type: 'step-start' }, { type: 'tool', state: { status: 'completed' } }, { type: 'step-finish' }] },
    { parts: [{ type: 'tool', state: { status: 'running' } }, { type: 'tool', state: { status: 'error' } }, { type: 'step-finish' }, { type: 'text' }] },
  ] };
  const s = summarizeExport(doc);
  assert.equal(s.messages, 2);
  assert.equal(s.steps, 2);
  assert.equal(s.tool_calls, 2, 'running parts are not finished calls');
  assert.deepEqual(s.part_types, { 'step-start': 1, tool: 3, 'step-finish': 2, text: 1 });
  assert.equal(s.reasoning_parts, 0);
});

test('summarizeExport measures reasoning from reasoning parts, not token counts', () => {
  // The local host returns reasoning text but reports reasoning_tokens 0; inferring "no
  // thinking" from the token count was a wrong conclusion this pilot nearly published.
  const doc = { messages: [{ parts: [
    { type: 'reasoning', text: 'abcd' },
    { type: 'step-finish', tokens: { input: 5, output: 3, reasoning: 0 } },
    { type: 'reasoning', text: 'xy' },
    { type: 'reasoning' },
  ] }] };
  const s = summarizeExport(doc);
  assert.equal(s.reasoning_parts, 3);
  assert.equal(s.reasoning_chars, 6);
});

test('eventsCompleteAgainstExport flags a stream that lost trailing steps (pipe truncation)', () => {
  // The dev-instance export arrived truncated through a pipe; an event stream can lose its
  // tail the same way, which would silently understate tokens and peak context.
  assert.deepEqual(eventsCompleteAgainstExport({ steps: 43, tool_calls: 50 }, { steps: 43, tool_calls: 50 }), { complete: true, missing_steps: 0, missing_tool_calls: 0 });
  assert.deepEqual(eventsCompleteAgainstExport({ steps: 40, tool_calls: 50 }, { steps: 43, tool_calls: 50 }), { complete: false, missing_steps: 3, missing_tool_calls: 0 });
  assert.equal(eventsCompleteAgainstExport({ steps: 43, tool_calls: 48 }, { steps: 43, tool_calls: 50 }).complete, false);
});

test('tokensOf tolerates missing cache fields', () => {
  assert.deepEqual(tokensOf({ input: 5, output: 2 }), { input: 5, output: 2, reasoning: 0, cache_read: 0, cache_write: 0 });
  assert.equal(tokensOf(null), null);
});

test('costAt bills reasoning at the output rate', () => {
  const c = costAt({ input: 1e6, output: 0, reasoning: 1e6, cache_read: 0, cache_write: 0 }, { input: 0.214, output: 2.55 });
  assert.equal(c, 2.764);
});
