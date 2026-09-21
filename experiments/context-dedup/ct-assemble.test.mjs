/**
 * The assembly arm's two halves, tested where they can go wrong silently:
 * the trigger (which window each turn gets) and the verdicts (which messages the
 * plugin is told to drop), plus the plugin's in-place contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ceilingOf, evictCallFor, policyFromEnv, validatePolicy } from './oc-plugin/policy.mjs';
import { applyDecisions } from './oc-plugin/apply-decisions.mjs';
import { armDisagreements, effectiveArm } from './swebench-opencode.mjs';

// The verdict planner moved into the package with the rest of the pipeline (D22); these
// cases stay here because they are about opencode's message shape.
const { planVerdicts } = await import(pathToFileURL(new URL('../../packages/mcp/dist/index.js', import.meta.url).pathname).href);
const planDecisions = ({ messages, index, evicted, protectTail, summaries }) =>
  planVerdicts(messages, index ?? null, evicted.filter((u) => u.start !== null && u.start !== undefined).map((u) => ({ summary: null, ...u })), protectTail, !!summaries);
import * as plugin from './oc-plugin/ct-assemble-plugin.mjs';

const SOFT = 50_347;
const HARD = 151_040;
const policy = (trigger, cadenceN = 5) => policyFromEnv({ CT_CT_TRIGGER: trigger, CT_CT_WINDOW: String(SOFT), CT_CT_HARD_WINDOW: String(HARD), CT_CT_CADENCE_N: String(cadenceN) });
const windowOf = (trigger, turn, hostTokens = 1000) => evictCallFor(policy(trigger), turn, hostTokens)?.window_tokens ?? null;

test('the trigger is WHETHER the plugin calls context_evict, and at what window', () => {
  // `off` makes no call at all: eviction is sticky, so no call leaves the prompt as it was.
  assert.equal(windowOf('off', 1), null);
  assert.equal(windowOf('hard', 1), HARD);
  assert.equal(windowOf('soft', 1), SOFT);
  // Reserve = reply + the head the plugin cannot see, and it rides on the call.
  assert.equal(evictCallFor(policy('soft'), 7, 1000).reserve_tokens, 8192 + 12_000);
  assert.equal(evictCallFor(policy('soft'), 7, 1000).turn, 7);
});

test('cadence is the ABSENCE of the call on off turns (U19)', () => {
  const fired = [0, 1, 2, 3, 4, 5, 6, 9, 10].map((t) => windowOf('cadence', t));
  // Turn 0 never fires: a cadence that evicts before there is history is not a cadence.
  assert.deepEqual(fired, [null, null, null, null, null, SOFT, null, null, SOFT]);
});

test('the floor fires under every arm when the host prompt alone would overflow, and says it is the floor', () => {
  const over = ceilingOf(policy('off')) + 1;
  assert.deepEqual(evictCallFor(policy('off'), 3, over), { window_tokens: HARD, reserve_tokens: 20_192, turn: 3, floor: true });
  assert.equal(evictCallFor(policy('cadence'), 3, over).floor, true);
  assert.equal(evictCallFor(policy('soft'), 3, over).floor, false, 'an arm that already fires is not the floor');
  assert.equal(ceilingOf(policy('off')), HARD - 12_000 - 8192);
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

test('the policy defaults to inert, so a run that loses its environment is the control', () => {
  assert.equal(policyFromEnv({}).trigger, 'off');
  assert.equal(evictCallFor(policyFromEnv({}), 5, 1000), null);
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

test('a misconfigured policy is refused rather than silently reduced to its control', () => {
  const env = { CT_CT_TRIGGER: 'soft' };
  const bad = (extra) => validatePolicy(policyFromEnv({ ...env, ...extra }));
  // `CT_CT_WINDOW=50k` -> NaN -> a window that evicts nothing, with nothing logged.
  assert.ok(bad({ CT_CT_WINDOW: '50k' }).some((p) => p.includes('CT_CT_WINDOW')));
  assert.ok(bad({ CT_CT_REPLY_RESERVE: 'x' }).some((p) => p.includes('CT_CT_REPLY_RESERVE')));
  assert.ok(bad({ CT_CT_HEAD_TOKENS: '-1' }).some((p) => p.includes('CT_CT_HEAD_TOKENS')));
  assert.ok(bad({ CT_CT_CADENCE_N: '0' }).some((p) => p.includes('CT_CT_CADENCE_N')));
  assert.ok(bad({ CT_CT_TRIGGER: 'sofft' }).some((p) => p.includes('CT_CT_TRIGGER')));
  assert.ok(bad({ CT_CT_WINDOW: '200000' }).some((p) => p.includes('exceeds')));
  assert.deepEqual(bad({}), []);
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

/**
 * The knobs reach the sidecar through five hops; when one dropped them the sidecar ran on
 * its own defaults (`trigger: off`, which never evicts) while the cell recorded the arm
 * that was asked for. The cell now carries the sidecar's own account of what it booted.
 */
test('an arm that booted on different settings than were asked for is reported, not recorded as the arm', () => {
  const asked = { CT_CT_TRIGGER: 'soft', CT_CT_WINDOW: '50347', CT_CT_SUMMARIES: '0', CT_CT_ANCHOR: '3', CT_CT_W_DORMANCY: '2' };
  const ready = { pipeline: { anchor: 3, weights: { priority: 2, recency: 1, refRecency: 0.5, dormancy: 2 } }, neutral_phases: ['other'], contract: 'v1' };
  const loaded = { policy: { trigger: 'soft', softWindow: 50_347, summaries: false } };
  assert.deepEqual(armDisagreements(asked, effectiveArm(ready, loaded)), []);

  // The exact failure G0 found: the env never arrived, so the process ran its own defaults.
  const found = armDisagreements(asked, effectiveArm(ready, { policy: { ...loaded.policy, trigger: 'off' } }));
  assert.equal(found.length, 1);
  assert.match(found[0], /CT_CT_TRIGGER: asked "soft", sidecar booted "off"/);
  // The two halves travel separately, so each can go missing separately.
  assert.match(armDisagreements(asked, effectiveArm({ ...ready, pipeline: { ...ready.pipeline, anchor: 4 } }, loaded))[0], /CT_CT_ANCHOR/);
});

test('a sidecar that never reported ready, or a plugin that never loaded, is a disagreement', () => {
  // Absent evidence must never read as confirmation.
  assert.equal(effectiveArm(undefined, { policy: {} }), null);
  assert.equal(effectiveArm({ pipeline: {} }, undefined), null);
  assert.deepEqual(armDisagreements({ CT_CT_TRIGGER: 'soft' }, null).length, 1);
});

test('summaries, numbers and phase lists are compared after casting, not as strings', () => {
  const asked = { CT_CT_SUMMARIES: '1', CT_CT_DRIFT_K: '5', CT_CT_NEUTRAL_PHASES: 'none' };
  assert.deepEqual(armDisagreements(asked, { summaries: true, driftK: 5, neutralPhases: '' }), []);
  assert.equal(armDisagreements(asked, { summaries: false, driftK: 5, neutralPhases: 'other' }).length, 2);
});
