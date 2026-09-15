/**
 * Unit tests for the anchor-dedup index (node:test, stdlib — no deps).
 * Run: node --test experiments/context-dedup/anchor-index.test.mjs
 *
 * Every firing test asserts BOTH that an anchor fired AND that it was truthful,
 * so none can pass against an implementation that anchors indiscriminately —
 * a lying anchor is exactly the failure mode `report-readloop.md` recorded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeAnchorIndex, normalizeContent, contentHash, bashReadTargets,
  normPath, anchorText, placeboText,
} from './anchor-index.mjs';

const BIG = (tag) => `# ${tag}\n` + Array.from({ length: 40 }, (_, i) => `line ${i} of ${tag} with enough text to clear the minChars floor`).join('\n');

/** Drives the index the way runAgent does: hook(messages, turn) then reducer(). */
function driver(opts) {
  const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'T' }];
  const idx = makeAnchorIndex({ verify: 'full', ...opts });
  let turn = 0;
  const step = (name, args, out) => {
    idx.hook(messages, turn++);
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${turn}`, function: { name, arguments: JSON.stringify(args) } }] });
    const res = idx.reducer({ name, args, out });
    messages.push({ role: 'tool', tool_call_id: `c${turn}`, content: res });
    return res;
  };
  return { idx, step, messages };
}

test('normalization makes the Read line-number gutter irrelevant', () => {
  const raw = '# Title\nalpha\nbeta';
  const gutter = '1\t# Title\n2\talpha\n3\tbeta';
  assert.equal(normalizeContent(raw), normalizeContent(gutter));
  assert.equal(contentHash(raw), contentHash(gutter));
});

test('normPath keys on the tail after context-tree/, across two machines', () => {
  assert.equal(normPath('/Users/danielbyrne/GitHub/rpm/context-tree/reports/algorithm.md'), 'reports/algorithm.md');
  assert.equal(normPath('/home/realdanielbyrne/GitHub/context-tree/reports/algorithm.md'), 'reports/algorithm.md');
});

test('bashReadTargets finds cat/head/tail/sed targets', () => {
  assert.deepEqual(bashReadTargets('cat spec/01.md'), ['spec/01.md']);
  assert.deepEqual(bashReadTargets('head -20 spec/02.md'), ['spec/02.md']);
  assert.deepEqual(bashReadTargets('sed -n 1,50p spec/03.md'), ['spec/03.md']);
  assert.deepEqual(bashReadTargets('python3 -m unittest'), []);
});

test('an exact re-read fires a TRUTHFUL anchor and shrinks the result', () => {
  const { idx, step } = driver({ arm: 'anchor' });
  const body = BIG('spec');
  const first = step('read_file', { path: 'spec/01.md' }, body);
  const second = step('read_file', { path: 'spec/01.md' }, body);
  assert.equal(first, body, 'first read must be served verbatim');
  assert.notEqual(second, body, 'second read must be substituted');
  assert.match(second, /Remember our earlier conversation/);
  const fired = idx.events.filter((e) => e.fired);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].anchor_truthful, true);
  assert.equal(fired[0].kind, 'duplicate-unchanged');
  assert.ok(second.length < body.length / 2, 'anchor must be much smaller than the payload');
});

test('baseline arm records the event but never substitutes', () => {
  const { idx, step } = driver({ arm: 'baseline' });
  const body = BIG('spec');
  step('read_file', { path: 'spec/01.md' }, body);
  const second = step('read_file', { path: 'spec/01.md' }, body);
  assert.equal(second, body);
  assert.equal(idx.events.filter((e) => e.fired).length, 0);
  assert.equal(idx.events.length, 1, 'the would-fire event is still recorded');
});

test('write-then-read fires: the written content is resident in tool_call args', () => {
  const { idx, step } = driver({ arm: 'anchor' });
  const body = BIG('module');
  step('write_file', { path: 'money.py', content: body }, 'wrote money.py (900 bytes)');
  const back = step('read_file', { path: 'money.py' }, body);
  assert.match(back, /Remember our earlier conversation/);
  assert.equal(idx.events[0].kind, 'write-then-read');
  assert.equal(idx.events[0].anchor_truthful, true);
});

test('a ranged sub-read of a resident file fires as partial-overlap', () => {
  const { idx, step } = driver({ arm: 'anchor' });
  const body = BIG('spec');
  step('read_file', { path: 'spec/01.md' }, body);
  const slice = body.split('\n').slice(5, 30).join('\n');
  const out = step('read_file', { path: 'spec/01.md', offset: 5, limit: 25 }, slice);
  assert.match(out, /Remember our earlier conversation/);
  assert.equal(idx.events[0].kind, 'partial-overlap');
});

test('a SUPERSET read does NOT fire — those bytes are genuinely new', () => {
  const { idx, step } = driver({ arm: 'anchor' });
  const part = BIG('spec');
  step('read_file', { path: 'spec/01.md', offset: 0, limit: 40 }, part);
  const whole = part + '\n' + BIG('extra');
  const out = step('read_file', { path: 'spec/01.md' }, whole);
  assert.equal(out, whole, 'new bytes must be served');
  assert.equal(idx.events.filter((e) => e.fired).length, 0);
});

test('an intervening edit makes the resident copy STALE and suppresses the anchor', () => {
  const { idx, step } = driver({ arm: 'anchor', requireUnedited: true });
  const body = BIG('money');
  step('read_file', { path: 'money.py' }, body);
  step('edit_file', { path: 'money.py', old_str: 'line 3', new_str: 'line 3 CHANGED' }, 'edited money.py');
  const out = step('read_file', { path: 'money.py' }, body);
  assert.equal(out, body, 'a stale anchor is a lie — serve the content');
  const ev = idx.events.find((e) => e.kind === 'read-then-edited');
  assert.ok(ev, 'the event is still recorded for accounting');
  assert.equal(ev.fired, false);
  assert.equal(ev.suppressed, 'stale');
});

test('anchor-diff DOES fire on the edited case and names the resident edits', () => {
  const { idx, step } = driver({ arm: 'anchor-diff' });
  const body = BIG('money');
  step('read_file', { path: 'money.py' }, body);
  step('edit_file', { path: 'money.py', old_str: 'line 3', new_str: 'line 3 CHANGED' }, 'edited money.py');
  const out = step('read_file', { path: 'money.py' }, body);
  assert.match(out, /You have since edited it 1 time/);
  assert.match(out, /line 3 CHANGED/, 'the edit hunk must be named');
  const ev = idx.events.find((e) => e.kind === 'read-then-edited');
  assert.equal(ev.fired, true);
  assert.equal(ev.anchor_truthful, true);
});

test('cross-tool duplicate: cat after read_file fires', () => {
  const { idx, step } = driver({ arm: 'anchor' });
  const body = BIG('spec');
  step('read_file', { path: 'spec/01.md' }, body);
  const out = step('run_bash', { command: 'cat spec/01.md' }, body);
  assert.match(out, /Remember our earlier conversation/);
  assert.equal(idx.events[0].fired, true);
});

test('content below minChars is never anchored — the anchor would not pay', () => {
  const { idx, step } = driver({ arm: 'anchor', minChars: 200 });
  step('read_file', { path: 'tiny.txt' }, 'ok');
  const out = step('read_file', { path: 'tiny.txt' }, 'ok');
  assert.equal(out, 'ok');
  assert.equal(idx.events.length, 0);
});

test('placebo is length-matched to the anchor within 4 chars', () => {
  const rec = { path: 'spec/01.md', firstTurn: 3, captureText: '# Conventions\nbody text here' };
  const a = anchorText(rec, 'duplicate-unchanged');
  const d = placeboText(a.length);
  assert.ok(Math.abs(a.length - d.length) <= 4, `anchor ${a.length} vs placebo ${d.length}`);
  assert.doesNotMatch(d, /spec\/01\.md|Remember|earlier|conversation/, 'placebo must carry no referent');
});

test('passive mode records every would-fire event and substitutes nothing', () => {
  const { idx, step } = driver({ arm: 'anchor', passive: true });
  const body = BIG('spec');
  step('read_file', { path: 'spec/01.md' }, body);
  const out = step('read_file', { path: 'spec/01.md' }, body);
  assert.equal(out, body);
  assert.equal(idx.stats().fires, 0);
  assert.equal(idx.stats().would_fire, 1);
});

test('residency_false_count stays 0 under append-only — nonzero is a harness bug', () => {
  const { idx, step } = driver({ arm: 'anchor' });
  const body = BIG('spec');
  step('read_file', { path: 'spec/01.md' }, body);
  step('read_file', { path: 'spec/01.md' }, body);
  assert.equal(idx.stats().residency_false_count, 0);
});

// ── regressions found by adversarial design review ──────────────────────────

test('anchor-topk REFUSES to substitute when the result would be larger than the content', () => {
  // A 2185-char module splits into 3 chunks at 800/100. At the old DEFAULT k=3 every
  // chunk came back and, with the overlap, the "reduction" was 2601 chars — 19% BIGGER
  // than the content. Arm C silently became "arm none plus a preamble".
  const mod = '# module\n' + Array.from({ length: 40 }, (_, i) => `def fn${i}(a, b):\n    return a*${i} + b  # step ${i}`).join('\n');
  const { idx, step } = driver({ arm: 'anchor-topk', topK: 3 });
  step('read_file', { path: 'physics.py' }, mod);
  const out = step('read_file', { path: 'physics.py' }, mod);
  assert.equal(out, mod, 'must serve the content rather than substitute something bigger');
  const ev = idx.events.at(-1);
  assert.equal(ev.degenerate_topk, true);
  assert.equal(ev.fired, false);
  assert.equal(ev.suppressed, 'topk-degenerate');
});

test('anchor-topk substitutes a genuine reduction at a non-degenerate k', () => {
  const mod = '# module\n' + Array.from({ length: 40 }, (_, i) => `def fn${i}(a, b):\n    return a*${i} + b  # step ${i}`).join('\n');
  const { idx, step } = driver({ arm: 'anchor-topk', topK: 1 });
  step('read_file', { path: 'physics.py' }, mod);
  const out = step('read_file', { path: 'physics.py' }, mod);
  assert.notEqual(out, mod);
  assert.ok(out.length < mod.length, `substitution ${out.length} must be smaller than ${mod.length}`);
  const ev = idx.events.at(-1);
  assert.equal(ev.fired, true);
  assert.equal(ev.degenerate_topk, false);
  assert.ok(ev.topk_coverage > 0 && ev.topk_coverage < 1, `coverage ${ev.topk_coverage} must be a real fraction`);
});

test('a CLIPPED resident copy is never anchored — the anchor would assert a falsehood', () => {
  // coding-harness/lib.mjs:30 appends this sentinel when a result exceeds 2000 chars.
  // Only the prefix is resident, so "the full text is above" is a lie.
  const clipped = 'x'.repeat(2000) + '\n…[5231 chars truncated]';
  const { idx, step } = driver({ arm: 'anchor' });
  step('read_file', { path: 'big.md' }, clipped);
  const out = step('read_file', { path: 'big.md' }, clipped);
  assert.equal(out, clipped, 'a clipped fragment must be served, never anchored');
  const ev = idx.events.at(-1);
  assert.equal(ev.partial_residency, true);
  assert.equal(ev.fired, false);
  assert.equal(ev.suppressed, 'clipped-residency');
});

test('a bash `cat FILE` sets path, so containment applies to bash reads too', () => {
  const body = BIG('spec');
  const { idx, step } = driver({ arm: 'anchor' });
  step('read_file', { path: 'spec/01.md' }, body);
  const slice = body.split('\n').slice(3, 20).join('\n');
  const out = step('run_bash', { command: 'sed -n 3,20p spec/01.md' }, slice);
  assert.match(out, /Remember our earlier conversation/, 'a sub-range via bash must fire as partial-overlap');
  assert.equal(idx.events.at(-1).kind, 'partial-overlap');
});
