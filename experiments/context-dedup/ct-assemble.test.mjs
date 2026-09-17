/**
 * The assembly arm's two halves, tested where they can go wrong silently:
 * the trigger (which window each turn gets) and the verdicts (which messages the
 * plugin is told to drop), plus the plugin's in-place contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planDecisions, windowForTurn, validateArm, ARM } from './ct-sidecar.mjs';
import { applyDecisions } from './oc-plugin/apply-decisions.mjs';
import * as plugin from './oc-plugin/ct-assemble-plugin.mjs';

const SOFT = 50_347;
const HARD = 151_040;
const arm = (trigger, turn, cadenceN = 5) =>
  windowForTurn({ trigger, turn, softWindow: SOFT, hardWindow: HARD, cadenceN });

test('the trigger IS the window handed to the assembler, one arm per setting', () => {
  // `off` must never evict: assembleFlex keeps everything when the budget is infinite.
  assert.equal(arm('off', 1), Number.POSITIVE_INFINITY);
  assert.equal(arm('hard', 1), HARD);
  assert.equal(arm('soft', 1), SOFT);
});

test('cadence fires on every Nth turn and leaves the others untouched (U19)', () => {
  const fired = [1, 2, 3, 4, 5, 6, 9, 10].map((t) => arm('cadence', t));
  assert.deepEqual(fired, [Infinity, Infinity, Infinity, Infinity, SOFT, Infinity, Infinity, SOFT]);
  // Turn 0 never fires: a cadence that evicts before there is history is not a cadence.
  assert.equal(arm('cadence', 0), Number.POSITIVE_INFINITY);
});

const msg = (id, extra = {}) => ({ id, role: 'assistant', tokens: 100, hasTools: false, ...extra });
const messages = [msg('m1'), msg('m2'), msg('m3'), msg('m4'), msg('m5'), msg('m6')];
const index = new Map([
  ['m1', { start: 1, end: 2 }], ['m2', { start: 3, end: 6 }], ['m3', { start: 7, end: 9 }],
  ['m4', { start: 10, end: 12 }], ['m5', { start: 13, end: 15 }], ['m6', { start: 16, end: 18 }],
]);
const action = (decisions, id) => decisions.find((d) => d.id === id)?.action;

test('a message is dropped only when its L0 range overlaps an evicted unit', () => {
  const decisions = planDecisions({
    messages, index, evicted: [{ nodeId: 'n1', start: 3, end: 9, summary: null }],
    protectTail: 2, summaries: false,
  });
  assert.equal(action(decisions, 'm2'), 'drop');
  assert.equal(action(decisions, 'm3'), 'drop');
  assert.equal(action(decisions, 'm4'), 'keep', 'outside the evicted span');
});

test('the task statement and the working tail are never dropped, whatever the assembler says', () => {
  const decisions = planDecisions({
    messages, index, evicted: [{ nodeId: 'n1', start: 1, end: 18, summary: null }],
    protectTail: 2, summaries: false,
  });
  assert.equal(action(decisions, 'm1'), 'keep', 'first message is the task statement');
  assert.equal(action(decisions, 'm5'), 'keep', 'protected tail');
  assert.equal(action(decisions, 'm6'), 'keep', 'protected tail');
  assert.deepEqual(['m2', 'm3', 'm4'].map((id) => action(decisions, id)), ['drop', 'drop', 'drop']);
});

test('a message with no L0 range yet is kept, because nothing is known about it', () => {
  const partial = new Map(index);
  partial.delete('m3');
  const decisions = planDecisions({
    messages, index: partial, evicted: [{ nodeId: 'n1', start: 1, end: 18, summary: null }],
    protectTail: 1, summaries: false,
  });
  assert.equal(action(decisions, 'm3'), 'keep');
});

test('with no index at all every message is kept — an un-indexed run must not evict blind', () => {
  const decisions = planDecisions({
    messages, index: null, evicted: [{ nodeId: 'n1', start: 1, end: 18, summary: null }],
    protectTail: 1, summaries: false,
  });
  assert.ok(decisions.every((d) => d.action === 'keep'));
});

test('summaries fold the unit once and drop the rest; a tool-carrying message is never folded', () => {
  const withTools = [msg('m1'), msg('m2', { hasTools: true }), msg('m3'), msg('m4'), msg('m5'), msg('m6')];
  const decisions = planDecisions({
    messages: withTools, index, evicted: [{ nodeId: 'n1', start: 3, end: 9, summary: 'gist of n1' }],
    protectTail: 2, summaries: true,
  });
  // m2 carries a tool call and its result, so it is keep-or-drop only: folding it to text
  // would separate the call from the result.
  assert.equal(action(decisions, 'm2'), 'drop');
  assert.equal(action(decisions, 'm3'), 'fold');
  assert.equal(decisions.find((d) => d.id === 'm3').text, 'gist of n1');
});

test('one unit folds into exactly one message, so a summary is never repeated', () => {
  const decisions = planDecisions({
    messages, index, evicted: [{ nodeId: 'n1', start: 1, end: 15, summary: 'gist' }],
    protectTail: 1, summaries: true,
  });
  assert.equal(decisions.filter((d) => d.action === 'fold').length, 1);
});

test('applyDecisions mutates the array in place, because the hook discards a return value', () => {
  const live = [
    { info: { id: 'a', role: 'user' }, parts: [{ type: 'text', text: 'first' }] },
    { info: { id: 'b', role: 'assistant' }, parts: [{ type: 'text', text: 'second' }] },
    { info: { id: 'c', role: 'assistant' }, parts: [{ type: 'text', text: 'third' }] },
  ];
  const same = live;
  const result = applyDecisions(live, [{ id: 'b', action: 'drop' }]);
  assert.equal(live, same, 'the same array object must survive');
  assert.deepEqual(live.map((m) => m.info.id), ['a', 'c']);
  assert.equal(result.dropped, 1);
});

test('a fold rewrites the text part in place and leaves exactly one part', () => {
  const live = [{ info: { id: 'a' }, parts: [{ type: 'text', text: 'long original' }, { type: 'text', text: 'more' }] }];
  const result = applyDecisions(live, [{ id: 'a', action: 'fold', text: 'gist' }]);
  assert.equal(live[0].parts.length, 1);
  assert.equal(live[0].parts[0].text, 'gist');
  assert.equal(result.folded, 1);
});

test('dropping several messages removes exactly those, whatever their order in the decision list', () => {
  const live = ['a', 'b', 'c', 'd'].map((id) => ({ info: { id }, parts: [{ type: 'text', text: id }] }));
  applyDecisions(live, [{ id: 'c', action: 'drop' }, { id: 'a', action: 'drop' }, { id: 'zz', action: 'drop' }]);
  assert.deepEqual(live.map((m) => m.info.id), ['b', 'd']);
});

test('the arm defaults to inert, so a misconfigured run cannot silently evict', () => {
  assert.equal(ARM.trigger, 'off');
});


test('the plugin module exports exactly one thing, or opencode registers NO hooks at all', () => {
  // opencode's loader runs `for (const x of Object.values(module))` and calls each export
  // as a plugin factory, throwing "Plugin export is not a function" on anything that is
  // not one — and a throw there aborts the load, swallowed into its log. A second export
  // (even a perfectly good helper) is called with the plugin context and takes the whole
  // arm down to a silent control.
  const keys = Object.keys(plugin);
  assert.deepEqual(keys, ['server'], `plugin exports ${keys.join(', ')}`);
  assert.equal(typeof plugin.server, 'function');
});

test('every export of the plugin survives being called the way opencode calls it', async () => {
  // Opencode passes (pluginContext, options) where options is undefined for a string spec.
  for (const [name, value] of Object.entries(plugin)) {
    const hooks = await value({ client: {}, directory: '/tmp', worktree: '/tmp' }, undefined);
    assert.equal(typeof hooks, 'object', `${name} must return a hook map`);
  }
});

test('the plugin registers the assembly hook and nothing that has hung opencode before', async () => {
  const hooks = await plugin.server({}, undefined);
  assert.deepEqual(Object.keys(hooks), ['experimental.chat.messages.transform']);
  // `chat.params` alone hung opencode at init in this repo's own run.
  assert.equal(hooks['chat.params'], undefined);
});

test('a misconfigured arm is refused rather than silently reduced to its control', () => {
  const base = { ...ARM, trigger: 'soft' };
  // `CT_CT_WINDOW=50k` -> NaN -> windowForTurn returns NaN -> the keep-everything path.
  assert.ok(validateArm({ ...base, softWindow: Number('50k') }).some((p) => p.includes('CT_CT_WINDOW')));
  // A NaN reserve makes `evictableTotal > NaN` false inside assembleFlex: nothing is ever
  // evicted and nothing is ever logged.
  assert.ok(validateArm({ ...base, replyReserve: Number('x') }).some((p) => p.includes('CT_CT_REPLY_RESERVE')));
  assert.ok(validateArm({ ...base, cadenceN: 0 }).some((p) => p.includes('CT_CT_CADENCE_N')));
  assert.ok(validateArm({ ...base, trigger: 'sofft' }).some((p) => p.includes('CT_CT_TRIGGER')));
  assert.ok(validateArm({ ...base, softWindow: 200_000 }).some((p) => p.includes('exceeds')));
  assert.deepEqual(validateArm(base), []);
});

test('a fold the message shape cannot take is recorded, so a summaries arm cannot look inert by accident', () => {
  const toolOnly = [msg('m1'), msg('m2', { hasTools: true }), msg('m3', { hasTools: true }), msg('m4')];
  const decisions = planDecisions({
    messages: toolOnly, index, evicted: [{ nodeId: 'n1', start: 3, end: 9, summary: 'gist' }],
    protectTail: 1, summaries: true,
  });
  const wanted = decisions.filter((d) => d.foldWanted);
  assert.equal(wanted.length, 1, 'the unit wanted a fold and no message could take one');
  assert.equal(wanted[0].action, 'drop');
});

test('the plugin never mutates the host message object it folds, only the array slot', () => {
  const original = { info: { id: 'a' }, parts: [{ type: 'text', text: 'original' }] };
  const live = [original];
  applyDecisions(live, [{ id: 'a', action: 'fold', text: 'gist' }]);
  assert.equal(original.parts[0].text, 'original', 'the session store holds this object too');
  assert.equal(live[0].parts[0].text, 'gist');
});

test('decisions with no id are ignored instead of colliding on `undefined`', () => {
  const live = [
    { info: { id: 'task' }, parts: [{ type: 'text', text: 'the task' }] },
    { info: {}, parts: [{ type: 'text', text: 'no id' }] },
  ];
  applyDecisions(live, [{ action: 'drop' }, { id: null, action: 'drop' }]);
  assert.equal(live.length, 2, 'an id-less decision must not delete an id-less message');
});

test('the sidecar ingests a message only once it can gain no further events', () => {
  // The guard that matters: a tool part settles when it runs, a text part only when the
  // message completes, and the mapper emits the text event FIRST — so ingesting early
  // inserts an event in front of one already appended, and L0 is append-only.
  const source = readFileSync(new URL('./ct-sidecar.mjs', import.meta.url), 'utf8');
  assert.match(source, /function ingestable\(message\)/);
  assert.ok(!/mapped\.events\.slice\(/.test(source), 'no whole-document slice may drive appends');
});
