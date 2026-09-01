/**
 * The §15 task set: 30 tasks, 10 per group, authored here and materialized to
 * the three `.json` files the harness loads.
 *
 * The JSON on disk is the artifact `loadTasks()` reads, and this file is where
 * it comes from — because a task's `golden` has to agree with the edits in its
 * trace, and the two drift the moment they are maintained as unrelated hand-
 * written JSON. `scenarios.ts` owns the trace and the golden state together;
 * this file adds only what is a *task* concern: the prompt, what a correct run
 * asserts, and which checker grades it.
 *
 * Three set-wide decisions worth stating once here rather than 30 times:
 *
 *  - **No task asserts `requiresTool`.** Only arm D is given the §9 tools
 *    (`arms.ts`), so "must call `context_fetch`" fails arms A/B/C by
 *    construction and hands D §15's success-rate gap for free. Retrieval is
 *    required as CONTENT that only lives in a branch the agent has to recover.
 *  - **`answerOmits` is unused.** It is a substring test, and a correct answer
 *    that says "not the old `amount_minor` field" would fail it. Wrongness is
 *    asserted positively instead: the identifier only the right resolution can
 *    produce.
 *  - **`maxToolCalls` appears on the three `fetch-not-needed` traps and on four
 *    `fresh` tasks.** §18 row 1 names over-fetching as a failure mode beside
 *    under-fetching; a set that only punished under-fetching would push the
 *    policy into the opposite ditch.
 */
import { SCENARIOS, scenarioById, type Scenario } from '../fixtures/scenarios.js';
import type { TaskExpectations, TaskKind, TrapKind } from '../harness/task-spec.js';
import { checkerExportName } from './checkers/grade.js';

export interface TaskFile {
  /** File name under `eval/tasks/`. */
  name: string;
  tasks: Record<string, unknown>[];
}

interface TaskSpec {
  id: string;
  kind: TaskKind;
  trap?: TrapKind;
  title: string;
  prompt: string;
  expect: TaskExpectations;
  /** Module path, resolved against `eval/tasks/`. */
  checkerModule: string;
  notes: string;
}

/**
 * One task object with its keys in a fixed order, so a regeneration is
 * byte-identical (the same D1/D8 determinism the fixtures are held to).
 */
function task(spec: TaskSpec): Record<string, unknown> {
  const scenario: Scenario = scenarioById(spec.id);
  const out: Record<string, unknown> = {
    id: spec.id,
    kind: spec.kind,
  };
  if (spec.trap !== undefined) out.trap = spec.trap;
  out.title = spec.title;
  out.trace = { fixture: `../fixtures/traces/${spec.id}.jsonl` };
  out.golden = scenario.golden.map((file) => ({ path: file.path, content: file.content }));
  out.prompt = spec.prompt;
  out.expect = spec.expect;
  out.checker = { module: spec.checkerModule, export: checkerExportName(spec.id) };
  out.notes = spec.notes;
  return out;
}

const FRESH_CHECKER = './checkers/fresh.js';
const RESUMED_CHECKER = './checkers/resumed.js';
const ADVERSARIAL_CHECKER = './checkers/adversarial.js';

/** The shared instruction shape: every fresh task asks for the same thing. */
function freshPrompt(subject: string): string {
  return `Pick this up from the start. ${subject} Name the file and the function that is wrong, and say what the corrected implementation has to do.`;
}

const FRESH: TaskSpec[] = [
  {
    id: 'fresh-01-invoice-rounding',
    kind: 'fresh',
    title: 'invoice line totals drift by a cent',
    prompt: freshPrompt('Invoice lines with tax come out a cent low.'),
    expect: {},
    checkerModule: FRESH_CHECKER,
    notes: 'Baseline: one short diagnosis branch, nothing to retrieve. A tree that costs anything here costs it for nothing.',
  },
  {
    id: 'fresh-02-csv-quotes',
    kind: 'fresh',
    title: 'CSV importer splits inside quoted fields',
    prompt: freshPrompt('Vendor names lose everything after the first comma on import.'),
    expect: { maxToolCalls: 3 },
    checkerModule: FRESH_CHECKER,
    notes: 'Tool-capped: the whole session is one branch, so more than a look or two is spend with no answer behind it.',
  },
  {
    id: 'fresh-03-retry-jitter',
    kind: 'fresh',
    title: 'clients retry in lockstep',
    prompt: freshPrompt('The vendor API rate-limits us in synchronized waves.'),
    expect: {},
    checkerModule: FRESH_CHECKER,
    notes: 'Includes a neutral Bash turn, so the fresh set also covers Ruling C6 rather than only clean diagnosis runs.',
  },
  {
    id: 'fresh-04-timezone-shift',
    kind: 'fresh',
    title: 'shift end times land an hour early across DST',
    prompt: freshPrompt('Crew shifts that cross a DST boundary end an hour early.'),
    expect: {},
    checkerModule: FRESH_CHECKER,
    notes: 'Domain reasoning with no recorded state to recover — pure "does the tree hurt" measurement.',
  },
  {
    id: 'fresh-05-pagination-offset',
    kind: 'fresh',
    title: 'every page repeats the previous page tail',
    prompt: freshPrompt('Paginated equipment lists repeat one row at each page boundary.'),
    expect: { maxToolCalls: 3 },
    checkerModule: FRESH_CHECKER,
    notes: 'Tool-capped for the same reason as fresh-02; the answer is in the read output the agent already has.',
  },
  {
    id: 'fresh-06-cache-key-collision',
    kind: 'fresh',
    title: 'two queries share one cache entry',
    prompt: freshPrompt('The report cache occasionally serves another tenant’s result.'),
    expect: {},
    checkerModule: FRESH_CHECKER,
    notes: 'The bug is visible only by reading the key builder, which is in the one branch the agent is handed.',
  },
  {
    id: 'fresh-07-zero-coerced-null',
    kind: 'fresh',
    title: 'a zero meter reading arrives as null',
    prompt: freshPrompt('Meter readings of exactly 0 come back from the API as null.'),
    expect: { maxToolCalls: 3 },
    checkerModule: FRESH_CHECKER,
    notes: 'Tool-capped. Also the falsy-coercion case, which a summary is likely to paraphrase away — a useful contrast with arm C.',
  },
  {
    id: 'fresh-08-slug-unicode',
    kind: 'fresh',
    title: 'accented job names slug to an empty string',
    prompt: freshPrompt('Jobs whose names are entirely accented characters all get the same empty slug.'),
    expect: {},
    checkerModule: FRESH_CHECKER,
    notes: 'Fresh diagnosis where the fix has two parts (fold, then fall back); the checker grades the file and symbol, the rubric grades completeness.',
  },
  {
    id: 'fresh-09-concurrency-cap',
    kind: 'fresh',
    title: 'a worker pool ignores its own cap',
    prompt: freshPrompt('The vendor pull opens hundreds of sockets even though the pool takes a cap of 8.'),
    expect: {},
    checkerModule: FRESH_CHECKER,
    notes: 'The defect is an unused parameter, which is exactly the kind of detail a flattened summary drops.',
  },
  {
    id: 'fresh-10-log-redaction',
    kind: 'fresh',
    title: 'a bearer token reaches the logs',
    prompt: freshPrompt('A support ticket contains a log line with a live API token in it.'),
    expect: { maxToolCalls: 3 },
    checkerModule: FRESH_CHECKER,
    notes: 'Tool-capped. Fourth and last of the frugality-instrumented fresh tasks.',
  },
];

/** Every resumed task is handed the same framing: the run stopped, finish it. */
function resumePrompt(state: string): string {
  return `You are resuming this task. ${state} Say exactly what the code has to use, why that is the right value, and what is left to do.`;
}

const RESUMED: TaskSpec[] = [
  {
    id: 'resumed-01-ledger-epoch',
    kind: 'resumed',
    title: 'clamp pre-migration postings to the ledger epoch',
    prompt: resumePrompt('The last test run says postingDate clamps to the wrong date.'),
    expect: { answerContains: ['LEDGER_EPOCH_2019'] },
    checkerModule: RESUMED_CHECKER,
    notes: 'The cutover constant was settled in the diagnosis branch and never reached the edit. The active verification branch reports the symptom and not the decision.',
  },
  {
    id: 'resumed-02-rate-window-header',
    kind: 'resumed',
    title: 'read the rate window from the vendor response header',
    prompt: resumePrompt('The last test run says rateWindow returns the fallback instead of the sampled value.'),
    expect: { answerContains: ['X-Rate-Window'] },
    checkerModule: RESUMED_CHECKER,
    notes: 'The header name appears only in the diagnosis branch (a captured curl response). The edit reached for Retry-After, which is a plausible wrong answer.',
  },
  {
    id: 'resumed-03-payout-table',
    kind: 'resumed',
    title: 'point payout inserts at the migrated table',
    prompt: resumePrompt('Two edits have been tried and the insert still fails.'),
    expect: { answerContains: ['payouts_v3'] },
    checkerModule: RESUMED_CHECKER,
    notes: 'Five phases, and the right table name is in the first one. Both later attempts are wrong in different ways, so guessing from the active branch cannot land it.',
  },
  {
    id: 'resumed-04-legacy-tz-flag',
    kind: 'resumed',
    title: 'pass the importer the flag old exports need',
    prompt: resumePrompt('The last run still shows legacy exports shifted by an hour.'),
    expect: { answerContains: ['--legacy-tz'] },
    checkerModule: RESUMED_CHECKER,
    notes: 'The CLI help text with both flags is in the diagnosis branch; the edit picked the other flag. Distinguishing them requires that branch.',
  },
  {
    id: 'resumed-05-driver-pin',
    kind: 'resumed',
    title: 'pin the SQL driver the deployed host has',
    prompt: resumePrompt('The assertion in the last run fails with a version mismatch.'),
    expect: { answerContains: ['0.5.12'] },
    checkerModule: RESUMED_CHECKER,
    notes: 'The host version exists only in the diagnosis branch. package.json advertises the range the edit used, so the repo itself argues for the wrong answer.',
  },
  {
    id: 'resumed-06-rounding-flag',
    kind: 'resumed',
    title: 'gate rounding behind the registered flag',
    prompt: resumePrompt('The active branch is a half-finished edit to a different flag file.'),
    expect: { answerContains: ['billing.rounding.v2'] },
    checkerModule: RESUMED_CHECKER,
    notes: 'The active branch is an implementation phase about an unrelated flag — the strongest form of the trap, because the last thing that happened is a distraction.',
  },
  {
    id: 'resumed-07-invoice-dlq',
    kind: 'resumed',
    title: 'route poisoned invoices to the provisioned queue',
    prompt: resumePrompt('The queue suite still fails on a queue that does not exist.'),
    expect: { answerContains: ['invoice-retry-dlq'] },
    checkerModule: RESUMED_CHECKER,
    notes: 'The provisioned queue name is in the infra read at the start. Inventing a plausible name is exactly the failure this measures.',
  },
  {
    id: 'resumed-08-fixture-seed',
    kind: 'resumed',
    title: 'make the snapshot test reproducible',
    prompt: resumePrompt('The snapshot still mismatches on every run.'),
    expect: { answerContains: ['20240117'] },
    checkerModule: RESUMED_CHECKER,
    notes: 'A bare number is the least summarizable kind of fact, which is the point: a flattened summary keeps the shape of the decision and drops the value.',
  },
  {
    id: 'resumed-09-timecard-index',
    kind: 'resumed',
    title: 'hint the timecard query at the new index',
    prompt: resumePrompt('The active branch is a review comment saying the index name is wrong.'),
    expect: { answerContains: ['ix_timecard_job_date'] },
    checkerModule: RESUMED_CHECKER,
    notes: 'Uses an explicit segment_boundary into a review phase, so the set covers that §7 path. The reviewer names the problem and not the answer.',
  },
  {
    id: 'resumed-10-read-replica-env',
    kind: 'resumed',
    title: 'send report reads to the replica connection',
    prompt: resumePrompt('The last run says the pool still returns the primary host.'),
    expect: { answerContains: ['db_read_replica'] },
    checkerModule: RESUMED_CHECKER,
    notes: 'Case matters and the wrong case is the conventional-looking one, so an agent reconstructing from habit rather than from the branch gets it wrong.',
  },
];

const ADVERSARIAL: TaskSpec[] = [
  {
    id: 'adv-01-stale-retry-module',
    kind: 'adversarial',
    trap: 'stale-summary',
    title: 'the retry module that no longer exists',
    prompt:
      'You are resuming this task. Add a jitter term to the retry delay. Say which file and function you are changing and what the new delay computation is.',
    expect: { answerContains: ['scheduleRetry'], staleMarkers: ['retryWithBackoff', 'src/net/retry.ts'] },
    checkerModule: ADVERSARIAL_CHECKER,
    notes: 'Branch 2 accurately described retry.ts. Branch 4 moved the logic to backoff.ts and deleted it, so following branch 2 edits a file that is gone.',
  },
  {
    id: 'adv-02-stale-slow-threshold',
    kind: 'adversarial',
    trap: 'stale-summary',
    title: 'the slow-request threshold that was re-tuned',
    prompt:
      'You are resuming this task. Add a second threshold for "very slow" at four times the current one. Name the constant you are building on and its value.',
    expect: { answerContains: ['SLOW_REQUEST_MS'], staleMarkers: ['SLOW_MS', '200ms'] },
    checkerModule: ADVERSARIAL_CHECKER,
    notes: 'The trap has a wrong ACTION attached: four times the stale 200ms is 800ms, four times the current 45ms is 180ms. The two answers are not confusable.',
  },
  {
    id: 'adv-03-stale-green-suite',
    kind: 'adversarial',
    trap: 'stale-summary',
    title: 'the suite that was green two branches ago',
    prompt:
      'You are resuming this task. Report the current state of the time suite and say what still has to change before it can ship.',
    expect: { answerContains: ['leap-second'], staleMarkers: ['14 passing', '0 failing'] },
    checkerModule: ADVERSARIAL_CHECKER,
    notes: 'Stale GREEN is the dangerous direction: an agent that trusts the earlier branch reports a shippable suite that is in fact red.',
  },
  {
    id: 'adv-04-stale-config-path',
    kind: 'adversarial',
    trap: 'stale-summary',
    title: 'the config file that changed format',
    prompt:
      'You are resuming this task. Add a retry-count setting to the importer config. Name the file you are editing and the exact lines you are adding.',
    expect: { answerContains: ['app.toml'], staleMarkers: ['app.json'] },
    checkerModule: ADVERSARIAL_CHECKER,
    notes: 'Following the stale branch produces JSON syntax written into a file that no longer exists — a wrong action a checker can name, not just a wrong belief.',
  },
  {
    id: 'adv-05-contradiction-payout-units',
    kind: 'adversarial',
    trap: 'contradiction',
    title: 'minor units versus decimal dollars',
    prompt:
      'You are resuming this task. Two branches disagree about the payout amount field. Decide which one is right, say which field to read and how to convert it, and say why the other branch is wrong.',
    expect: { answerContains: ['amount_usd_decimal'] },
    checkerModule: ADVERSARIAL_CHECKER,
    notes: 'The wrong side is the plausible one: it argues from a real repo-wide convention and every other feed really does use minor units. The right side is one captured response.',
  },
  {
    id: 'adv-06-contradiction-jobs-route',
    kind: 'adversarial',
    trap: 'contradiction',
    title: 'the documented route versus the deployed one',
    prompt:
      'You are resuming this task. Two branches disagree about the jobs search route. Decide which one is right, give the route to call, and say why the other branch is wrong.',
    expect: { answerContains: ['/v2/jobs/search'] },
    checkerModule: ADVERSARIAL_CHECKER,
    notes: 'The wrong side is the in-repo API doc, which is the source an agent is trained to trust. The right side is the captured deployed spec.',
  },
  {
    id: 'adv-07-contradiction-write-table',
    kind: 'adversarial',
    trap: 'contradiction',
    title: 'the table every query reads versus the one writes are granted on',
    prompt:
      'You are resuming this task. Two branches disagree about which table the insert should name. Decide which one is right, give the table, and say why the other branch is wrong.',
    expect: { answerContains: ['TimecardEntry'] },
    checkerModule: ADVERSARIAL_CHECKER,
    notes: 'The wrong side has weight of evidence on it (every read in the app names the view). The right side is one migration file showing the view and the grant.',
  },
  {
    id: 'adv-08-frugal-single-branch',
    kind: 'adversarial',
    trap: 'fetch-not-needed',
    title: 'one branch, no reason to fetch',
    prompt:
      'You are resuming this task. State the upload size cap, the constant that holds it, and the status code the handler returns above it.',
    expect: { answerContains: ['413'], maxToolCalls: 0 },
    checkerModule: ADVERSARIAL_CHECKER,
    notes: 'The whole session is one branch, so it is entirely inside Zone C. Every retrieval call here is spend with no information behind it.',
  },
  {
    id: 'adv-09-frugal-active-branch',
    kind: 'adversarial',
    trap: 'fetch-not-needed',
    title: 'the failing assertion is already in front of you',
    prompt:
      'You are resuming this task. The discount suite has one failure. State the expected and received values and what the disagreement is about.',
    expect: { answerContains: ['6667'], forbidsTool: ['context_search'], maxToolCalls: 0 },
    checkerModule: ADVERSARIAL_CHECKER,
    notes: 'The answer is the active branch verbatim. `context_search` is forbidden by name because searching for something already in Zone C is the specific waste being measured.',
  },
  {
    id: 'adv-10-frugal-last-run',
    kind: 'adversarial',
    trap: 'fetch-not-needed',
    title: 'three branches, one relevant',
    prompt:
      'You are resuming this task. Report only what the most recent test run says: which case failed and which identifier it names.',
    expect: { answerContains: ['eq-4471'], forbidsTool: ['context_fetch'], maxToolCalls: 0 },
    checkerModule: ADVERSARIAL_CHECKER,
    notes: 'Older branches exist and are irrelevant, which is the harder frugality case: the tree offers something to fetch and the prompt scopes it out.',
  },
];

export const TASK_FILES: readonly TaskFile[] = Object.freeze([
  { name: 'fresh.json', tasks: FRESH.map(task) },
  { name: 'resumed.json', tasks: RESUMED.map(task) },
  { name: 'adversarial.json', tasks: ADVERSARIAL.map(task) },
]);

/** Ids in group order — used to assert the set covers every scenario exactly once. */
export const TASK_IDS: readonly string[] = Object.freeze([
  ...FRESH.map((spec) => spec.id),
  ...RESUMED.map((spec) => spec.id),
  ...ADVERSARIAL.map((spec) => spec.id),
]);

/** Scenario ids the task set does not use — must be empty, or a fixture is orphaned. */
export function unusedScenarios(): string[] {
  return SCENARIOS.filter((scenario) => !TASK_IDS.includes(scenario.id)).map((scenario) => scenario.id);
}
