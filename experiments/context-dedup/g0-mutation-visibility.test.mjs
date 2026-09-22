/**
 * The G0 gate's two halves: what the sidecar drops, and what the wire records have to show
 * before the gate may say PASS.
 *
 * A gate that passes on weak evidence is worse than no gate — it licenses every arm that
 * follows it. Each test below is a way the gate was, or could be, satisfied by something
 * other than the splice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { g0Decisions } from './ct-sidecar.mjs';
import { gradeG0 } from './g0-mutation-visibility.mjs';

const messages = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));

const FOLD = 'Continue the task. Harness marker: CTG0FOLD-xyz';

test('the gate edits nothing before three messages', () => {
  // Turn one: the array is the task statement alone. There is nothing to edit that leaves a
  // request worth sending, so these turns are the within-run control.
  assert.deepEqual(g0Decisions(messages(1), FOLD), [{ id: 'm0', action: 'keep' }]);
  assert.deepEqual(g0Decisions(messages(2), FOLD).map((d) => d.action), ['keep', 'keep']);
});

test('the gate FOLDS the task statement rather than splicing it, so a user message survives', () => {
  // Splicing it produced `500 Jinja Exception: No user query found in messages` — opencode's
  // loop has exactly one user message. A rejected request cannot answer the gate's question.
  const fired = g0Decisions(messages(3), FOLD);
  assert.deepEqual(fired[0], { id: 'm0', action: 'edit', unit: 'g0', edits: [{ part: 'text', text: FOLD }], g0: true });
  assert.deepEqual(fired.slice(1).map((d) => d.action), ['keep', 'keep']);
});

test('the gate also splices an assistant message, which is what the arms actually do', () => {
  const fired = g0Decisions(messages(4), FOLD);
  assert.equal(fired[0].action, 'edit');
  // Index 1 is an assistant message: its tool calls and results travel together inside it,
  // so removing it can never orphan a result.
  assert.deepEqual(fired[1], { id: 'm1', action: 'drop', unit: 'g0', g0: true });
  assert.deepEqual(fired.slice(2).map((d) => d.action), ['keep', 'keep']);
});

test('without replacement text the gate declines to edit rather than folding to nothing', () => {
  // A fold to an empty string would blank the task statement and look like a working gate.
  assert.deepEqual(g0Decisions(messages(5), '').map((d) => d.action), ['keep', 'keep', 'keep', 'keep', 'keep']);
});

const arm = (over = {}) => ({
  tag: 't', conversations: 4, present: 1, missing: 3, echoed: 0, rejected: 0, gaps: 0,
  before_first_drop: 1, before_all_marked: true, after_first_drop: 3, after_all_clean: true,
  after_all_replaced: true, replacement_seen: 3,
  plugin_loaded: true, plugin_turns: 4, plugin_errors: 0, fold_turns: 3, drop_turns: 3,
  reduce_turns: 2, after_first_reduce: 2, after_all_reduced: true, reduce_seen: 2,
  stub_turns: 2, after_first_stub: 2, after_all_stubbed: true, stub_seen: 2,
  think_turns: 2, after_first_think: 2, after_all_thought: true, think_seen: 2,
  carrier_turns: 2, after_first_carrier: 2, after_all_carried: true, carrier_seen: 2,
  sidecar_g0_rows: 3, sidecar_assembles: 4, ...over,
});
const control = (over = {}) => arm({
  tag: 'control', present: 4, missing: 0, fold_turns: 0, drop_turns: 0, sidecar_g0_rows: 0,
  before_first_drop: 4, after_first_drop: 0, after_all_clean: false, after_all_replaced: false,
  replacement_seen: 0, reduce_turns: 0, after_first_reduce: 0, after_all_reduced: false, reduce_seen: 0,
  stub_turns: 0, after_first_stub: 0, after_all_stubbed: false, stub_seen: 0,
  think_turns: 0, after_first_think: 0, after_all_thought: false, think_seen: 0,
  carrier_turns: 0, after_first_carrier: 0, after_all_carried: false, carrier_seen: 0, ...over,
});

test('G0 passes only when the control holds the marker and the treatment loses it in order', () => {
  const verdict = gradeG0({ control: control(), treatment: arm() });
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.reasons, []);
  assert.deepEqual(verdict.voids, []);
  assert.equal(verdict.exact, true);
});

test('a treatment that never spliced cannot pass, however clean the wire looks', () => {
  const verdict = gradeG0({ control: control(), treatment: arm({ drop_turns: 0, sidecar_g0_rows: 0, sidecar_assembles: 0 }) });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' '), /never spliced/);
});

test('a treatment that kept the marker after splicing is the failure G0 exists to catch', () => {
  const verdict = gradeG0({ control: control(), treatment: arm({ after_all_clean: false, missing: 0, present: 4 }) });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' '), /did not reach the provider/);
});

test('an unmarked request that is not ordered after a splice cannot carry the verdict', () => {
  // The hole worth closing: a subagent session or a retry produces one marker-free request
  // while every spliced request still carries the marker. Existentially that reads as PASS.
  const verdict = gradeG0({
    control: control(),
    treatment: arm({ missing: 1, present: 3, after_all_clean: false }),
  });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' '), /kept the original marker on a request made after the edit/);
});

test('a treatment that lost the marker BEFORE splicing indicts something other than the splice', () => {
  const verdict = gradeG0({ control: control(), treatment: arm({ before_all_marked: false }) });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' '), /BEFORE it edited/);
});

test('a control that loses the marker by itself voids the gate rather than passing it', () => {
  // Without this the gate would credit the splice for a message opencode dropped on its own.
  const verdict = gradeG0({ control: control({ missing: 2, present: 2 }), treatment: arm() });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' '), /must never go missing without the splice/);
});

test('a run too short to make a mediated request after the splice is not a pass', () => {
  const verdict = gradeG0({ control: control(), treatment: arm({ after_first_drop: 0, after_all_clean: false }) });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' '), /ended too early/);
});

test('a control with too little traffic is not evidence of anything', () => {
  const verdict = gradeG0({ control: control({ conversations: 1, present: 1 }), treatment: arm() });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' '), /needs >= 2/);
});

/**
 * VOID is a third outcome, not a flavour of FAIL: each of these says the gate could not ask
 * its question. Reporting them as FAIL sends someone hunting opencode's serializer.
 */
test('an echoed marker voids the gate instead of reporting a discarded splice', () => {
  // One `echo CTG0-…` in a shell command puts the marker in a message the gate never drops,
  // after which every request carries it and the wire can no longer answer.
  const verdict = gradeG0({ control: control(), treatment: arm({ echoed: 2 }) });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.void, true);
  assert.deepEqual(verdict.reasons, []);
  assert.match(verdict.voids.join(' '), /reproduced the marker/);
});

test('a plugin that never imported is named as such, not reported as a failed splice', () => {
  // The first defect G0 found: a missing sibling module, no opencode log line, zero hooks.
  const verdict = gradeG0({
    control: control({ plugin_loaded: false }),
    treatment: arm({ plugin_loaded: false, fold_turns: 0, drop_turns: 0, sidecar_assembles: 0 }),
  });
  assert.equal(verdict.void, true);
  assert.match(verdict.voids.join(' '), /never imported/);
});

test('a sidecar that never entered the gate path is named, not blamed on the splice', () => {
  // The second defect G0 found: CT_G0_DROP_FIRST never reached the sidecar, which then
  // assembled normally and dropped nothing. Identical symptom, different fix.
  const verdict = gradeG0({
    control: control(),
    treatment: arm({ fold_turns: 0, drop_turns: 0, sidecar_g0_rows: 0, sidecar_assembles: 11 }),
  });
  assert.equal(verdict.void, true);
  assert.match(verdict.voids.join(' '), /never entered the gate path/);
});

test('missing wire rows and rejected requests void the gate', () => {
  // The relay numbers its rows, so a gap is visible rather than reading as "no requests".
  assert.match(gradeG0({ control: control({ gaps: 2 }), treatment: arm() }).voids.join(' '), /wire rows are missing/);
  // A 400 says nothing about what the provider would have read.
  assert.match(gradeG0({ control: control(), treatment: arm({ rejected: 3 }) }).voids.join(' '), /rejected 3 requests/);
});

test('the replacement text must ARRIVE, not merely the original vanish', () => {
  // Removal alone could be opencode's own doing. Text that exists nowhere but the plugin's
  // replacement can only be on the wire because the edited array was the one serialized.
  const verdict = gradeG0({ control: control(), treatment: arm({ after_all_replaced: false }) });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(' '), /replacement text never reached the provider/);
});

test('a replacement that shows up in the control was never unique to the plugin', () => {
  const verdict = gradeG0({ control: control({ replacement_seen: 2 }), treatment: arm() });
  assert.equal(verdict.void, true);
  assert.match(verdict.voids.join(' '), /not unique to the plugin/);
});

test('an in-place output reduction that never reaches the wire fails the gate', () => {
  assert.match(gradeG0({ control: control(), treatment: arm({ reduce_turns: 0 }) }).reasons.join(' '), /never reduced/);
  assert.match(gradeG0({ control: control(), treatment: arm({ after_all_reduced: false }) }).reasons.join(' '), /reduced tool output never reached/);
  assert.match(gradeG0({ control: control({ reduce_seen: 1 }), treatment: arm() }).voids.join(' '), /reduced-output text appeared/);
  assert.match(gradeG0({ control: control(), treatment: arm({ stub_turns: 0 }) }).reasons.join(' '), /never stubbed/);
  assert.match(gradeG0({ control: control(), treatment: arm({ after_all_stubbed: false }) }).reasons.join(' '), /stub tag never reached/);
  assert.match(gradeG0({ control: control({ stub_seen: 1 }), treatment: arm() }).voids.join(' '), /stub tag's text appeared/);
});

test('the gate makes every edit an arm makes, one per tool-bearing message, each with its own marker', () => {
  const messages = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `m${i}`, hasTools: i >= 3 }));
  const all = g0Decisions(messages, 'FOLD', 'REDUCED', 'STUB', 'THINK', 'CARRIER');
  const edit = (i) => all[i].edits;
  assert.deepEqual(edit(3), [{ part: 'tool', index: 0, text: 'REDUCED' }]);
  assert.deepEqual(edit(4), [{ part: 'reasoning', text: null }, { part: 'tool', index: 0, text: 'STUB' }]);
  assert.deepEqual(edit(5), [{ part: 'reasoning', text: 'THINK' }]);
  assert.deepEqual(edit(6), [{ part: 'reasoning', text: 'CARRIER' }, { part: 'tool', index: 0, text: null }]);
  assert.equal(all[7].action, 'keep');
  // Each case waits for enough messages, and never lands on a message without tools.
  assert.ok(g0Decisions(messages.slice(0, 4), 'FOLD', 'REDUCED').every((d) => d.action !== 'edit' || d.id === 'm0'));
  assert.ok(g0Decisions(messages, 'FOLD').slice(2).every((d) => d.action === 'keep'));
});

test('a stub turn is not a think turn: the think and carrier cases are dated from their own counters', () => {
  // The live FAIL of 2026-09-21: the stub case removes a reasoning part one request before the think
  // case replaces one, and dating "first think" from `reasoning_edited` put a marker-free request in its window.
  assert.match(gradeG0({ control: control(), treatment: arm({ after_all_thought: false }) }).reasons.join(' '), /replaced reasoning never reached/);
  const v = gradeG0({ control: control(), treatment: arm({ carrier_turns: 0, after_first_carrier: 0, after_all_carried: false }) });
  assert.match(v.reasons.join(' '), /never carried a summary/);
});

test('the task statement recalled through a tool voids the gate rather than failing it', () => {
  // 2026-09-21: the agent called fetch on the task node; the original marker came back inside a
  // tool output the gate never edits and rode on every later request beside the replacement.
  const v = gradeG0({ control: control(), treatment: arm({ recalled: 1, after_all_clean: false, present: 16, missing: 6 }) });
  assert.equal(v.pass, false);
  assert.match(v.voids.join(' '), /recalled the task statement/);
  // With a clean wire the recall changes nothing.
  assert.deepEqual(gradeG0({ control: control(), treatment: arm({ recalled: 1 }) }).voids, []);
});
