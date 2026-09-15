/**
 * Unit tests for the PURE parts of the SWE-bench task module: the grading logic and the
 * "the prompt must not leak the graded tests" assertion. node:test + node:assert only.
 *
 *   node --test experiments/context-dedup/ab-tasks/swebench.test.mjs
 *
 * Each test is written so a plausible BROKEN implementation fails it:
 *  - grading on pytest's exit code instead of per-test outcomes -> `MISSING` cases fail
 *  - a leak check that only looks for full node ids -> the bare-name case fails
 *  - a leak check that only looks at the task text -> the system-prompt case fails
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  testFnName, testPatchTargets, assertNoTestLeak, parsePytestOutcomes, gradeOutcomes, failedIds, asList,
  maxIdenticalStreak, djangoLabel, parseDjangoOutcomes, importName, pythonPathFor, djangoTestModules,
} from './swebench.mjs';

const F2P = ['test_requests.py::TestRequests::test_binary_put'];
const P2P = ['test_requests.py::TestRequests::test_links', 'test_requests.py::UtilsTestCase::test_is_ipv4_address'];

test('asList accepts the dataset JSON-string form and a real array', () => {
  assert.deepEqual(asList('["a","b"]'), ['a', 'b']);
  assert.deepEqual(asList(['a']), ['a']);
});

test('testFnName strips the module/class path and pytest parametrisation', () => {
  assert.equal(testFnName('test_requests.py::TestRequests::test_binary_put'), 'test_binary_put');
  assert.equal(testFnName('tests/t.py::test_x[1-2]'), 'test_x');
  assert.equal(testFnName('test_x'), 'test_x');
});

test('testPatchTargets lists the post-image paths of a multi-file diff', () => {
  const diff = [
    'diff --git a/test_requests.py b/test_requests.py',
    '--- a/test_requests.py',
    '+++ b/test_requests.py',
    '@@ -1 +1,2 @@',
    '+x',
    'diff --git a/tests/new_test.py b/tests/new_test.py',
    '--- /dev/null',
    '+++ b/tests/new_test.py',
    '@@ -0,0 +1 @@',
    '+y',
  ].join('\n');
  assert.deepEqual(testPatchTargets(diff), ['test_requests.py', 'tests/new_test.py']);
});

test('testPatchTargets ignores /dev/null post-images (file deletions)', () => {
  const diff = ['--- a/gone.py', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'].join('\n');
  assert.deepEqual(testPatchTargets(diff), []);
});

// ------------------------------- leak assertion -------------------------------

test('assertNoTestLeak passes on a clean problem statement', () => {
  const text = 'Request with binary payload fails due to calling to_native_string.\nThis works with 2.8.1 but not 2.9.';
  assert.equal(assertNoTestLeak({ text, f2p: F2P, p2p: P2P }), true);
});

test('assertNoTestLeak throws when the text carries a FAIL_TO_PASS node id', () => {
  assert.throws(
    () => assertNoTestLeak({ text: `make ${F2P[0]} green`, f2p: F2P, p2p: P2P }),
    /LEAKS/,
  );
});

test('assertNoTestLeak throws on the BARE test function name, not just the node id', () => {
  // A prompt saying "see test_binary_put" contains no node id at all; a checker that only
  // does `text.includes(id)` lets this through.
  assert.throws(
    () => assertNoTestLeak({ text: 'the regression is covered by test_binary_put', f2p: F2P, p2p: P2P }),
    /test name: test_binary_put/,
  );
});

test('assertNoTestLeak throws when a PASS_TO_PASS node id appears', () => {
  assert.throws(() => assertNoTestLeak({ text: `do not break ${P2P[1]}`, f2p: F2P, p2p: P2P }), /LEAKS/);
});

test('assertNoTestLeak throws when the gold patch body is echoed', () => {
  const gold = ['--- a/requests/models.py', '+++ b/requests/models.py',
    '+        if isinstance(data, basestring) or hasattr(data, "read"):'].join('\n');
  assert.throws(
    () => assertNoTestLeak({ text: 'hint: if isinstance(data, basestring) or hasattr(data, "read"):', f2p: F2P, p2p: [], goldPatch: gold }),
    /patch line/,
  );
});

test('assertNoTestLeak allows the verbatim issue to quote patch lines, but not the harness text', () => {
  // xarray-4094: the reporter's reproducer is copied into the test patch. Rejecting it biases
  // the sample toward code-free issues; the same line in HARNESS text is still a leak.
  const testPatch = ['--- a/t.py', '+++ b/t.py', '+    data = xr.Dataset({"a": arr, "b": arr})'].join('\n');
  const statement = 'Repro:\n    data = xr.Dataset({"a": arr, "b": arr})\n';
  assert.equal(assertNoTestLeak({ text: 'You are a software engineer.', statement, f2p: F2P, p2p: [], testPatch }), true);
  assert.throws(() => assertNoTestLeak({ text: 'hint: data = xr.Dataset({"a": arr, "b": arr})', statement: '', f2p: F2P, p2p: [], testPatch }), /patch line/);
});

test('assertNoTestLeak still forbids a failing-test id or name inside the verbatim issue', () => {
  assert.throws(() => assertNoTestLeak({ text: 'harness', statement: `see ${F2P[0]}`, f2p: F2P, p2p: [] }), /test id/);
  assert.throws(() => assertNoTestLeak({ text: 'harness', statement: 'broken since test_binary_put was added', f2p: F2P, p2p: [] }), /test name/);
});

test('assertNoTestLeak does not fire on short incidental patch lines', () => {
  const gold = ['--- a/x.py', '+++ b/x.py', '+import os', '-    pass'].join('\n');
  assert.equal(assertNoTestLeak({ text: 'import os is used everywhere', f2p: [], p2p: [], goldPatch: gold }), true);
});

// ------------------------------- pytest parsing -------------------------------

const SUMMARY = `
.F                                                                       [100%]
=========================== short test summary info ============================
PASSED test_requests.py::TestRequests::test_links
FAILED test_requests.py::TestRequests::test_binary_put - UnicodeDecodeError: 'ascii' codec...
ERROR test_requests.py::UtilsTestCase::test_is_ipv4_address - ImportError
1 failed, 1 passed, 1 error in 0.31s
`;

test('parsePytestOutcomes reads per-test outcomes out of the -rA summary', () => {
  const o = parsePytestOutcomes(SUMMARY);
  assert.equal(o.get('test_requests.py::TestRequests::test_links'), 'PASSED');
  assert.equal(o.get('test_requests.py::TestRequests::test_binary_put'), 'FAILED');
  assert.equal(o.get('test_requests.py::UtilsTestCase::test_is_ipv4_address'), 'ERROR');
  assert.equal(o.size, 3);
});

test('parsePytestOutcomes handles parametrised ids containing spaces and " - "', () => {
  // A whitespace-token parser records "tests/t.py::test_x[a" and the graded id comes back
  // MISSING, failing a correct fix.
  const id = 'tests/t.py::test_x[a b - c]';
  const out = `PASSED ${id}\nFAILED tests/t.py::test_y[1 2] - AssertionError: nope\n`;
  const o = parsePytestOutcomes(out, [id, 'tests/t.py::test_y[1 2]']);
  assert.equal(o.get(id), 'PASSED');
  assert.equal(o.get('tests/t.py::test_y[1 2]'), 'FAILED');
  assert.equal(gradeOutcomes([id], o).all, true);
});

test('parsePytestOutcomes matches ids SWE-bench recorded truncated at a space (its own parser convention)', () => {
  // requests-6028's P2P ids end at the first space inside the brackets. An exact-prefix-only
  // matcher reports every one of them MISSING and fails the gold patch.
  const truncated = 'tests/test_utils.py::test__parse_content_type_header[application/json;';
  const out = 'PASSED tests/test_utils.py::test__parse_content_type_header[application/json; charset=utf-8-expected0]\n'
    + 'FAILED tests/test_utils.py::test_other[a b] - AssertionError: x\n';
  const o = parsePytestOutcomes(out, [truncated, 'tests/test_utils.py::test_other[a']);
  assert.equal(o.get(truncated), 'PASSED');
  assert.equal(o.get('tests/test_utils.py::test_other[a'), 'FAILED');
});

test('parsePytestOutcomes does not let a longer id satisfy a shorter one', () => {
  const o = parsePytestOutcomes('PASSED t.py::test_ab\n', ['t.py::test_a']);
  assert.equal(o.get('t.py::test_a'), undefined);
});

test('parsePytestOutcomes returns nothing for a collection error (no summary section)', () => {
  const o = parsePytestOutcomes('ERROR: file or directory not found: test_requests.py\n');
  assert.equal(o.size, 0);
});

// ------------------------------- grading -------------------------------

test('gradeOutcomes passes only when every requested test PASSED', () => {
  const o = parsePytestOutcomes('PASSED a::t1\nPASSED a::t2\n');
  const g = gradeOutcomes(['a::t1', 'a::t2'], o);
  assert.equal(g.all, true);
  assert.deepEqual(failedIds(g), []);
});

test('gradeOutcomes FAILS when a requested test was never collected (MISSING)', () => {
  // This is the case an exit-code grader gets wrong: pytest can exit 0 on a subset.
  const o = parsePytestOutcomes('PASSED a::t1\n');
  const g = gradeOutcomes(['a::t1', 'a::t2'], o);
  assert.equal(g.all, false);
  assert.deepEqual(failedIds(g), ['a::t2 [MISSING]']);
});

test('gradeOutcomes FAILS on a failed test and names it', () => {
  const g = gradeOutcomes(['a::t1'], parsePytestOutcomes('FAILED a::t1 - boom'));
  assert.equal(g.all, false);
  assert.deepEqual(failedIds(g), ['a::t1 [FAILED]']);
});

test('gradeOutcomes treats SKIPPED as not-passed', () => {
  const g = gradeOutcomes(['a::t1'], parsePytestOutcomes('SKIPPED a::t1'));
  assert.equal(g.all, false);
});

test('gradeOutcomes on an empty id list is not a pass', () => {
  assert.equal(gradeOutcomes([], new Map()).all, false);
});

// ------------------------------- django runner -------------------------------

test('djangoLabel converts SWE-bench repr ids to runtests labels and passes dotted ids through', () => {
  assert.equal(djangoLabel('test_foo (queries.tests.Queries1Tests)'), 'queries.tests.Queries1Tests.test_foo');
  assert.equal(djangoLabel('queries.tests.Queries1Tests.test_foo'), 'queries.tests.Queries1Tests.test_foo');
});

test('parseDjangoOutcomes reads the pre-3.11 form, the 3.11+ form and a docstring on the next line', () => {
  const out = [
    'test_a (app.tests.Case) ... ok',
    'test_b (app.tests.Case.test_b) ... FAIL',
    'test_c (app.tests.Case)',
    'A docstring explaining the test. ... ok',
    'test_d (app.tests.Case) ... skipped "needs db"',
    'test_e (app.tests.Case) ... ERROR',
    '======================================================================',
    'FAIL: test_b (app.tests.Case.test_b)',
  ].join('\n');
  const o = parseDjangoOutcomes(out);
  assert.equal(o.get('test_a (app.tests.Case)'), 'PASSED');
  assert.equal(o.get('test_b (app.tests.Case)'), 'FAILED', '3.11+ repeats the method name inside the parens');
  assert.equal(o.get('test_c (app.tests.Case)'), 'PASSED', 'status on the docstring line');
  assert.equal(o.get('test_d (app.tests.Case)'), 'SKIPPED');
  assert.equal(o.get('test_e (app.tests.Case)'), 'ERROR');
  assert.equal(gradeOutcomes(['test_a (app.tests.Case)', 'test_z (app.tests.Case)'], o).all, false, 'unreported test is MISSING');
});

test('parseDjangoOutcomes keys a docstring-named test by its docstring, as SWE-bench records it', () => {
  // django-10097: 13 F2P ids are docstrings. A parser keyed only on `test_x (Case)` reports
  // every one of them MISSING and fails a correct fix.
  const out = [
    'test_username (auth_tests.test_management.CreatesuperuserManagementCommandTestCase)',
    "The system username is used if --username isn't provided. ... ok",
  ].join('\n');
  const o = parseDjangoOutcomes(out);
  assert.equal(o.get("The system username is used if --username isn't provided."), 'PASSED');
  assert.equal(o.get('test_username (auth_tests.test_management.CreatesuperuserManagementCommandTestCase)'), 'PASSED');
});

test('djangoTestModules derives runnable modules from the test patch paths', () => {
  const patch = ['+++ b/tests/auth_tests/test_management.py', '+++ b/tests/queries/tests.py', '+++ b/django/db/models/query.py', '+++ b/tests/queries/__init__.py'].join('\n');
  assert.deepEqual(djangoTestModules(patch), ['auth_tests.test_management', 'queries.tests']);
});

test('testFnName extracts the method from a django repr id', () => {
  assert.equal(testFnName('test_foo (queries.tests.Queries1Tests)'), 'test_foo');
});

test('importName maps distribution names that differ from the import name', () => {
  assert.equal(importName('scikit-learn/scikit-learn'), 'sklearn');
  assert.equal(importName('django/django'), 'django');
});

test('pythonPathFor adds src/ and lib/ only when they exist, workspace first', () => {
  assert.equal(pythonPathFor('/w', (p) => p === '/w/src'), '/w:/w/src');
  assert.equal(pythonPathFor('/w', (p) => p === '/w/lib'), '/w:/w/lib');
  assert.equal(pythonPathFor('/w', () => false), '/w');
});

// ------------------------------- liveness metric -------------------------------

test('maxIdenticalStreak finds the longest consecutive run, not the total count', () => {
  const c = (arg, name = 'run_bash') => ({ name, arg });
  // total repeats of "a" = 5, but the longest CONSECUTIVE run is 3
  assert.equal(maxIdenticalStreak([c('a'), c('a'), c('b'), c('a'), c('a'), c('a')]), 3);
});

test('maxIdenticalStreak distinguishes tool name as well as argument', () => {
  assert.equal(maxIdenticalStreak([{ name: 'read_file', arg: 'x' }, { name: 'run_bash', arg: 'x' }]), 1);
});

test('maxIdenticalStreak of an empty trace is 0', () => {
  assert.equal(maxIdenticalStreak([]), 0);
});

// ------------------------- the real instance, end to end -------------------------

test('the constructed prompt for the pinned instance leaks nothing', async (t) => {
  const mod = await import('./swebench.mjs');
  const task = mod.default;
  if (!task || task.name.includes('UNAVAILABLE')) return t.skip('SWE-bench dataset not provisioned on this host');
  assert.equal(assertNoTestLeak({ text: `${task.system}\n${task.task}`, f2p: task.f2p, p2p: task.p2p }), true);
  assert.ok(task.task.includes('--- issue report ---'));
  assert.ok(task.system.includes(task.python), 'the interpreter path must be explicit in the system prompt');
});
