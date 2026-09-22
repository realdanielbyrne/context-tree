/**
 * The assembly arm's two halves, tested where they can go wrong silently:
 * the trigger (which window each turn gets) and the verdicts (which messages the
 * plugin is told to drop), plus the plugin's in-place contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRIGGERS, assembleWindowFor, ceilingOf, evictCallFor, policyFromEnv, reserveOf, validatePolicy } from './oc-plugin/policy.mjs';
import { applyDecisions } from './oc-plugin/apply-decisions.mjs';
import { armDisagreements, effectiveArm } from './swebench-opencode.mjs';

import * as plugin from './oc-plugin/ct-assemble-plugin.mjs';

const SOFT = 50_347;
const HARD = 151_040;
const policy = (trigger, cadenceN = 5) => policyFromEnv({ CT_CT_TRIGGER: trigger, CT_CT_WINDOW: String(SOFT), CT_CT_HARD_WINDOW: String(HARD), CT_CT_CADENCE_N: String(cadenceN) });
const windowOf = (trigger, turn, hostTokens = 1000) => evictCallFor(policy(trigger), turn, hostTokens)?.window_tokens ?? null;

test('the trigger is WHETHER the plugin calls evict, and at what window', () => {
  // `off` makes no call at all: eviction is sticky, so no call leaves the prompt as it was.
  assert.equal(windowOf('off', 1), null);
  assert.equal(windowOf('hard', 1), HARD);
  assert.equal(windowOf('soft', 1), SOFT);
  // Reserve = reply + the head the plugin cannot see, and it rides on the call.
  assert.equal(evictCallFor(policy('soft'), 7, 1000).reserve_tokens, 8192 + 12_000);
  assert.equal(evictCallFor(policy('soft'), 7, 1000).turn, 7);
});

test('cadence left the plugin: it is the fold policy\'s (CT_CT_FOLD_TRIGGER), and the plugin does not know it', () => {
  assert.equal(TRIGGERS.includes('cadence'), false);
  assert.ok(validatePolicy(policyFromEnv({ CT_CT_TRIGGER: 'cadence' })).some((p) => p.includes('CT_CT_TRIGGER')));
});

test('the floor fires under every arm when the host prompt alone would overflow, and says it is the floor', () => {
  const over = ceilingOf(policy('off')) + 1;
  assert.deepEqual(evictCallFor(policy('off'), 3, over), { window_tokens: HARD, reserve_tokens: 20_192, turn: 3, floor: true });
  assert.equal(evictCallFor(policy('cadence'), 3, over).floor, true);
  assert.equal(evictCallFor(policy('soft'), 3, over).floor, false, 'an arm that already fires is not the floor');
  assert.equal(ceilingOf(policy('off')), HARD - 12_000 - 8192);
});

test('a treatment turn assembles at the arm\'s own window; the control assembles nothing — unless it folds on its own', () => {
  assert.equal(assembleWindowFor(policy('off')), null);
  assert.equal(assembleWindowFor(policy('soft')), SOFT);
  assert.equal(assembleWindowFor(policy('hard')), HARD);
  // The think arm: eviction off, the segmenter folds reasoning by age — assemble and fold still run.
  assert.equal(assembleWindowFor(policyFromEnv({ CT_CT_TRIGGER: 'off', CT_CT_FOLD_REASONING_AFTER: '3' })), SOFT);
  assert.equal(assembleWindowFor(policyFromEnv({ CT_CT_TRIGGER: 'off', CT_CT_FOLD_TRIGGER: 'pressure' })), SOFT);
  assert.equal(evictCallFor(policyFromEnv({ CT_CT_TRIGGER: 'off', CT_CT_FOLD_TRIGGER: 'pressure' }), 3, 1000), null);
  assert.equal(reserveOf(policy('soft'), SOFT), 20_192);
  assert.equal(reserveOf(policy('soft'), 100), 99, 'a reserve can never swallow the window');
});

test('the G0 gate assembles every turn and never evicts, whatever the trigger says', () => {
  const gate = policyFromEnv({ CT_G0_DROP_FIRST: '1', CT_CT_TRIGGER: 'soft' });
  assert.equal(assembleWindowFor(gate), HARD);
  assert.equal(evictCallFor(gate, 5, 10_000_000), null);
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

test('a text edit rewrites the first text part in place and removes the rest', () => {
  const live = [{ info: { id: 'a' }, parts: [{ type: 'text', text: 'long original' }, { type: 'text', text: 'more' }] }];
  const result = applyDecisions(live, [{ id: 'a', action: 'edit', edits: [{ part: 'text', text: 'gist' }] }]);
  assert.equal(live[0].parts.length, 1);
  assert.equal(live[0].parts[0].text, 'gist');
  assert.equal(result.edited, 1);
  assert.equal(result.text_edited, 2);
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
  assert.ok(bad({ CT_CT_TRIGGER: 'sofft' }).some((p) => p.includes('CT_CT_TRIGGER')));
  assert.ok(bad({ CT_CT_WINDOW: '200000' }).some((p) => p.includes('exceeds')));
  assert.deepEqual(bad({}), []);
});

test('a tool edit swaps the n-th tool part\'s OUTPUT in place — the part, its call and its result stay put', () => {
  const tool = (output) => ({ type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'a' }, output } });
  const host = { info: { id: 'b', role: 'assistant' }, parts: [{ type: 'text', text: 'looking' }, tool('AAAA'.repeat(100)), tool('BBBB'.repeat(100))] };
  const live = [{ info: { id: 'a', role: 'user' }, parts: [{ type: 'text', text: 'task' }] }, host];
  const result = applyDecisions(live, [{ id: 'b', action: 'edit', edits: [{ part: 'tool', index: 1, text: 'B…' }] }]);
  assert.equal(result.outputs_edited, 1);
  assert.equal(live.length, 2);
  assert.deepEqual(live[1].parts.map((p) => p.state?.output ?? p.text), ['looking', 'AAAA'.repeat(100), 'B…']);
  assert.deepEqual(live[1].parts[2].state.input, { filePath: 'a' }, 'the call is untouched');
  // The host's own objects are what the session store and the graded export reference.
  assert.equal(host.parts[2].state.output, 'BBBB'.repeat(100));
  assert.notEqual(live[1], host);
});

test('an edit that names no existing part changes nothing and counts nothing', () => {
  const live = [{ info: { id: 'b', role: 'assistant' }, parts: [{ type: 'text', text: 'no tools here' }] }];
  const before = live[0];
  assert.equal(applyDecisions(live, [{ id: 'b', action: 'edit', edits: [{ part: 'tool', index: 0, text: 'x' }] }]).edited, 0);
  assert.equal(live[0], before);
});

test('the plugin never mutates the host message object it edits, only the array slot', () => {
  const original = { info: { id: 'a' }, parts: [{ type: 'text', text: 'original' }] };
  const live = [original];
  applyDecisions(live, [{ id: 'a', action: 'edit', edits: [{ part: 'text', text: 'gist' }] }]);
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
  const ready = { pipeline: { anchor: 3, wDormancy: 2 }, neutral_phases: ['other'], contract: 'v1' };
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

test('booleans, numbers and phase lists are compared after casting, not as strings', () => {
  const asked = { CT_CT_FOLD_SUMMARIES: '1', CT_CT_DRIFT_K: '5', CT_CT_NEUTRAL_PHASES: 'none' };
  assert.deepEqual(armDisagreements(asked, { foldSummaries: true, driftK: 5, neutralPhases: '' }), []);
  assert.equal(armDisagreements(asked, { foldSummaries: false, driftK: 5, neutralPhases: 'other' }).length, 2);
});

test('a stub is edits: the reasoning part removed, the output tagged; text and the call stay', () => {
  const tool = { type: 'tool', tool: 'read', state: { input: { filePath: 'a.py' }, output: 'long output' } };
  const original = { info: { id: 'b' }, parts: [{ type: 'reasoning', text: 'thinking…' }, { type: 'text', text: 'Let me read a.py' }, tool] };
  const live = [{ info: { id: 'a' }, parts: [{ type: 'text', text: 'task' }] }, original];
  const result = applyDecisions(live, [{ id: 'b', action: 'edit', edits: [{ part: 'reasoning', text: null }, { part: 'tool', index: 0, text: '[folded · recall: fetch {"stub":3}]' }] }]);
  assert.deepEqual(result, { dropped: 0, edited: 1, reasoning_edited: 1, reasoning_replaced: 0, text_edited: 0, outputs_edited: 1, parts_removed: 1, tools_removed: 0 });
  assert.deepEqual(live[1].parts.map((p) => p.type), ['text', 'tool']);
  assert.equal(live[1].parts[1].state.output, '[folded · recall: fetch {"stub":3}]');
  assert.deepEqual(live[1].parts[1].state.input, { filePath: 'a.py' });
  // The host's own object is what the session store and the grading export hold.
  assert.equal(original.parts.length, 3);
  assert.equal(tool.state.output, 'long output');
});

test('a reasoning part is replaced in place (the think rule); a carrier replaces it and removes the tool parts', () => {
  const mk = () => ({ info: { id: 'b' }, parts: [{ type: 'reasoning', text: 'long thinking' }, { type: 'tool', tool: 'read', state: { input: {}, output: 'out' } }] });
  const think = [mk()];
  const thought = applyDecisions(think, [{ id: 'b', action: 'edit', edits: [{ part: 'reasoning', text: '[folded thinking] tail' }] }]);
  assert.deepEqual(think[0].parts.map((p) => p.text ?? p.state.output), ['[folded thinking] tail', 'out']);
  assert.deepEqual([thought.reasoning_edited, thought.reasoning_replaced, thought.tools_removed], [1, 1, 0]);
  const carrier = [mk()];
  const carried = applyDecisions(carrier, [{ id: 'b', action: 'edit', edits: [{ part: 'reasoning', text: '[summary m9 …]' }, { part: 'tool', index: 0, text: null }] }]);
  assert.deepEqual([carried.reasoning_replaced, carried.tools_removed, carried.parts_removed], [1, 1, 1]);
  assert.deepEqual(carrier[0].parts.map((p) => p.type), ['reasoning']);
  assert.equal(carrier[0].parts[0].text, '[summary m9 …]');
});

test('a message left with no reasoning, text or tool part is removed: an empty message is not a message', () => {
  const live = [{ info: { id: 'a' }, parts: [{ type: 'text', text: 'task' }] }, { info: { id: 'b' }, parts: [{ type: 'reasoning', text: 'hm' }, { type: 'step-finish' }] }];
  assert.equal(applyDecisions(live, [{ id: 'b', action: 'edit', edits: [{ part: 'reasoning', text: null }] }]).edited, 1);
  assert.equal(live.length, 1);
});
