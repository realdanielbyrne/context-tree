/**
 * The 30 task traces (§15: 10 fresh / 10 resumed-mid-task / 10 adversarial).
 *
 * EVERY TRACE HERE IS SYNTHETIC — written in this file, never derived from a
 * real transcript (see `build.ts` for why that is not negotiable).
 *
 * A scenario owns three things that have to agree with each other, which is
 * exactly why they live in one place:
 *
 *  - `events`   — the recorded session (L0 + L2 after `materializeTrace`);
 *  - `phases`   — the phase sequence §7's segmenter must produce from it. A
 *                 task that depends on "the diagnosis branch" is silently
 *                 unmeasurable if ingestion produced no diagnosis branch, so
 *                 `tasks.test.ts` asserts this sequence exactly;
 *  - `golden`   — the correct END state of each file the task turns on, which
 *                 the checkers and the judge read as ground truth.
 *
 * Two conventions the whole set relies on:
 *
 *  1. **The buried fact.** Every `resumed` scenario turns on one distinctive
 *     token that lives in a NON-ACTIVE branch (`buried`). An agent that never
 *     recovers that branch cannot produce it, which is what makes the task
 *     measure state recovery rather than fluency.
 *  2. **No task asserts `requiresTool`.** Only arm D is given tools (`arms.ts`),
 *     so "must call `context_fetch`" would fail arms A/B/C by construction and
 *     hand D a free win on §15's success-rate gap. The retrieval requirement is
 *     therefore expressed as CONTENT the tree can only supply through a fetch,
 *     which every arm is free to satisfy its own way.
 */
import type { PhaseType } from '@context-tree/core';
import type { GoldenFile, TaskEvent } from '../harness/task-spec.js';
import { buildTrace } from './build.js';

export interface Scenario {
  /** Matches the task id that uses it, so `<id>.jsonl` is the fixture path. */
  id: string;
  /** Lines written into the fixture file's `//` header. */
  header: string[];
  /** The exact `phase_type` sequence §7 must produce, in creation order. */
  phases: PhaseType[];
  /** Correct end state of the files this task turns on. */
  golden: GoldenFile[];
  events: TaskEvent[];
}

// ── fresh (10) ─────────────────────────────────────────────────────────────

/**
 * A `fresh` session is the OPENING of a task: the request, a little reading,
 * no edits yet. §15 calls these "measures whether the tree helps or merely does
 * not hurt" — with one short branch there is nothing to fetch, so a tree that
 * costs a run anything here is costing it for nothing.
 *
 * Their `golden` is the TARGET state, not a recorded one. That is the one place
 * the set's "every golden path has a file node" invariant does not apply, and
 * `tasks.test.ts` scopes it out explicitly rather than weakening it everywhere.
 */
interface FreshSpec {
  id: string;
  what: string;
  ask: string;
  path: string;
  before: string;
  needle: string;
  hits: string;
  shell?: [string, string];
  observation: string;
  golden: string;
}

function freshScenario(spec: FreshSpec): Scenario {
  const trace = buildTrace().user(spec.ask).read(spec.path, spec.before).grep(spec.needle, spec.hits);
  if (spec.shell !== undefined) trace.shell(spec.shell[0], spec.shell[1]);
  trace.say(spec.observation);
  return {
    id: spec.id,
    header: [`Fresh session: ${spec.what}.`, 'The request plus a short read-only look; no edits yet.'],
    phases: ['diagnosis'],
    golden: [{ path: spec.path, content: spec.golden }],
    events: trace.events(),
  };
}

const FRESH: readonly Scenario[] = [
  freshScenario({
    id: 'fresh-01-invoice-rounding',
    what: 'invoice line totals drift by a cent',
    ask: 'invoice totals are a cent off when a line has tax; find it and say what the fix is',
    path: 'src/pricing/invoice.ts',
    before: 'export function lineTotal(cents: number, taxRate: number): number {\n  return Math.round(cents * (1 + taxRate));\n}',
    needle: 'lineTotal',
    hits: 'src/pricing/invoice.ts:1\nsrc/billing/statement.ts:88',
    observation: 'lineTotal rounds once at the end, so tax is computed on an unrounded base.',
    golden:
      'export function lineTotal(cents: number, taxRate: number): number {\n  const base = Math.round(cents);\n  return base + Math.round(base * taxRate);\n}',
  }),
  freshScenario({
    id: 'fresh-02-csv-quotes',
    what: 'the CSV importer splits inside quoted fields',
    ask: 'imported vendor names lose everything after the first comma; work out why',
    path: 'src/import/csv.ts',
    before: 'export function parseRow(line: string): string[] {\n  return line.split(",");\n}',
    needle: 'parseRow',
    hits: 'src/import/csv.ts:1\nsrc/import/vendors.ts:22',
    observation: 'parseRow splits on every comma, including the ones inside double-quoted fields.',
    golden:
      'export function parseRow(line: string): string[] {\n  return (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((cell) =>\n    cell.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, \'"\'),\n  );\n}',
  }),
  freshScenario({
    id: 'fresh-03-retry-jitter',
    what: 'every client retries in lockstep',
    ask: 'the vendor API 429s us in waves; look at the retry delay and say what to change',
    path: 'src/net/retry.ts',
    before: 'export function nextDelayMs(attempt: number): number {\n  return 2 ** attempt * 250;\n}',
    needle: 'nextDelayMs',
    hits: 'src/net/retry.ts:1\nsrc/net/client.ts:64',
    shell: ['rg -c "nextDelayMs" src | wc -l', '2'],
    observation: 'nextDelayMs is pure exponential with no jitter, so every client retries on the same tick.',
    golden:
      'export function nextDelayMs(attempt: number, rand = Math.random): number {\n  const ceiling = Math.min(2 ** attempt * 250, 30_000);\n  return Math.round(ceiling * (0.5 + rand() * 0.5));\n}',
  }),
  freshScenario({
    id: 'fresh-04-timezone-shift',
    what: 'shift end times land an hour early after a DST change',
    ask: 'crew shifts that cross the DST boundary end an hour early; find the cause',
    path: 'src/time/shift.ts',
    before:
      'export function shiftEnd(startUtc: Date, hours: number): Date {\n  return new Date(startUtc.getTime() + hours * 3_600_000);\n}',
    needle: 'shiftEnd',
    hits: 'src/time/shift.ts:1\nsrc/time/timecard.ts:41',
    observation: 'shiftEnd adds wall-clock milliseconds, which is an hour short across a spring-forward.',
    golden:
      'export function shiftEnd(startUtc: Date, hours: number, zone: string): Date {\n  const local = new Date(startUtc.toLocaleString("en-US", { timeZone: zone }));\n  local.setHours(local.getHours() + hours);\n  return new Date(local.toISOString());\n}',
  }),
  freshScenario({
    id: 'fresh-05-pagination-offset',
    what: 'the last page of every list repeats a row',
    ask: 'paginated equipment lists repeat one row per page boundary; work out the off-by-one',
    path: 'src/api/paginate.ts',
    before:
      'export function pageSlice<T>(rows: T[], page: number, size: number): T[] {\n  return rows.slice(page * size - 1, page * size + size);\n}',
    needle: 'pageSlice',
    hits: 'src/api/paginate.ts:1\nsrc/api/equipment.ts:57',
    observation: 'pageSlice starts a page one row early, so each page repeats the previous page tail.',
    golden:
      'export function pageSlice<T>(rows: T[], page: number, size: number): T[] {\n  const start = (page - 1) * size;\n  return rows.slice(start, start + size);\n}',
  }),
  freshScenario({
    id: 'fresh-06-cache-key-collision',
    what: 'two different queries share one cache entry',
    ask: 'the report cache serves the wrong tenant occasionally; look at how keys are built',
    path: 'src/cache/key.ts',
    before:
      'export function cacheKey(parts: Record<string, string>): string {\n  return Object.values(parts).join("");\n}',
    needle: 'cacheKey',
    hits: 'src/cache/key.ts:1\nsrc/report/run.ts:19',
    observation: 'cacheKey concatenates values with no separator and drops the key names, so {a:"bc"} and {ab:"c"} collide.',
    golden:
      'export function cacheKey(parts: Record<string, string>): string {\n  return Object.keys(parts)\n    .sort()\n    .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(parts[name] ?? "")}`)\n    .join("&");\n}',
  }),
  freshScenario({
    id: 'fresh-07-zero-coerced-null',
    what: 'a zero-valued numeric field arrives as null',
    ask: 'meter readings of exactly 0 come back as null from the API; find where',
    path: 'src/db/rows.ts',
    before:
      'export function toCamel(row: Record<string, unknown>): Record<string, unknown> {\n  const out: Record<string, unknown> = {};\n  for (const [key, value] of Object.entries(row)) out[camel(key)] = value || null;\n  return out;\n}',
    needle: 'toCamel',
    hits: 'src/db/rows.ts:1\nsrc/db/equipment.ts:73',
    observation: 'toCamel uses `value || null`, which turns a legitimate 0 (and "") into null.',
    golden:
      'export function toCamel(row: Record<string, unknown>): Record<string, unknown> {\n  const out: Record<string, unknown> = {};\n  for (const [key, value] of Object.entries(row)) out[camel(key)] = value ?? null;\n  return out;\n}',
  }),
  freshScenario({
    id: 'fresh-08-slug-unicode',
    what: 'non-ASCII job names slug to an empty string',
    ask: 'jobs with accented names get an empty slug and collide; find the cause',
    path: 'src/text/slug.ts',
    before:
      'export function slugify(name: string): string {\n  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}',
    needle: 'slugify',
    hits: 'src/text/slug.ts:1\nsrc/jobs/create.ts:31',
    observation: 'slugify strips every non-ASCII character before folding accents, so an all-accented name becomes "".',
    golden:
      'export function slugify(name: string): string {\n  const folded = name.normalize("NFKD").replace(/\\p{Diacritic}/gu, "").toLowerCase();\n  const slug = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n  return slug === "" ? "job" : slug;\n}',
  }),
  freshScenario({
    id: 'fresh-09-concurrency-cap',
    what: 'a worker pool ignores its own cap',
    ask: 'the vendor pull opens hundreds of sockets despite a cap of 8; work out why',
    path: 'src/queue/pool.ts',
    before:
      'export async function runPool<T>(jobs: Array<() => Promise<T>>, cap = 8): Promise<T[]> {\n  return Promise.all(jobs.map((job) => job()));\n}',
    needle: 'runPool',
    hits: 'src/queue/pool.ts:1\nsrc/sync/vendors.ts:12',
    shell: ['node -e "console.log(process.env.POOL_CAP)"', 'undefined'],
    observation: 'runPool takes a cap and never reads it; Promise.all starts every job at once.',
    golden:
      'export async function runPool<T>(jobs: Array<() => Promise<T>>, cap = 8): Promise<T[]> {\n  const out: T[] = new Array<T>(jobs.length);\n  let next = 0;\n  const worker = async (): Promise<void> => {\n    while (next < jobs.length) {\n      const index = next++;\n      out[index] = await (jobs[index] as () => Promise<T>)();\n    }\n  };\n  await Promise.all(Array.from({ length: Math.min(cap, jobs.length) }, worker));\n  return out;\n}',
  }),
  freshScenario({
    id: 'fresh-10-log-redaction',
    what: 'a bearer token reaches the logs',
    ask: 'support pasted a log line with a live token in it; find what failed to redact',
    path: 'src/log/redact.ts',
    before:
      'export function redact(line: string): string {\n  return line.replace(/password=\\S+/g, "password=***");\n}',
    needle: 'redact',
    hits: 'src/log/redact.ts:1\nsrc/log/http.ts:26',
    observation: 'redact only knows the password= form; Authorization headers and api keys pass through untouched.',
    golden:
      'export function redact(line: string): string {\n  return line\n    .replace(/password=\\S+/gi, "password=***")\n    .replace(/authorization:\\s*\\S+/gi, "authorization: ***")\n    .replace(/\\b(sk|pk)-[A-Za-z0-9]{8,}\\b/g, "***");\n}',
  }),
];

// ── resumed (10) ───────────────────────────────────────────────────────────

/**
 * A `resumed` session was interrupted mid-flight. §15 makes these the point of
 * the whole benchmark, so each one turns on `buried`: a distinctive token that
 * exists ONLY in a branch that is not the active one. The active branch is the
 * last phase — a failing test run, a half-applied edit, an open review comment —
 * and reading it alone is not enough to finish the task.
 */
interface ResumedSpec {
  id: string;
  what: string;
  /** The token that lives only in the non-active branch this task turns on. */
  buried: string;
  phases: PhaseType[];
  golden: GoldenFile[];
  events: TaskEvent[];
}

function resumedScenario(spec: ResumedSpec): Scenario {
  return {
    id: spec.id,
    header: [
      `Resumed session: ${spec.what}.`,
      `Interrupted mid-flight; the state it turns on ("${spec.buried}") lives in a non-active branch.`,
    ],
    phases: spec.phases,
    golden: spec.golden,
    events: spec.events,
  };
}

const LEDGER_GOLDEN = [
  'import { LEDGER_EPOCH_2019 } from "./epoch.js";',
  '',
  'export function postingDate(raw: Date): Date {',
  '  return raw < LEDGER_EPOCH_2019 ? LEDGER_EPOCH_2019 : raw;',
  '}',
].join('\n');

const RATE_GOLDEN = [
  'export function rateWindow(headers: Headers): number {',
  '  const raw = headers.get("X-Rate-Window");',
  '  return raw === null ? 60 : Number.parseInt(raw, 10);',
  '}',
].join('\n');

const PAYOUT_GOLDEN = [
  'export const PAYOUT_TABLE = "payouts_v3";',
  '',
  'export function payoutInsert(): string {',
  '  return `INSERT INTO ${PAYOUT_TABLE} (job_id, cents) VALUES (@jobId, @cents)`;',
  '}',
].join('\n');

const TZ_GOLDEN = [
  'export function importArgs(legacy: boolean): string[] {',
  '  return legacy ? ["--legacy-tz"] : [];',
  '}',
].join('\n');

const DRIVER_GOLDEN = [
  'export const DRIVER_VERSION = "0.5.12";',
  '',
  'export function assertDriver(found: string): void {',
  '  if (found !== DRIVER_VERSION) throw new Error(`driver ${found} != ${DRIVER_VERSION}`);',
  '}',
].join('\n');

const FLAG_GOLDEN = [
  'export const ROUNDING_FLAG = "billing.rounding.v2";',
  '',
  'export function roundingEnabled(flags: Set<string>): boolean {',
  '  return flags.has(ROUNDING_FLAG);',
  '}',
].join('\n');

const DLQ_GOLDEN = [
  'export const DEAD_LETTER_QUEUE = "invoice-retry-dlq";',
  '',
  'export function deadLetter(id: string): { queue: string; id: string } {',
  '  return { queue: DEAD_LETTER_QUEUE, id };',
  '}',
].join('\n');

const SEED_GOLDEN = [
  'export const FIXTURE_SEED = 20240117;',
  '',
  'export function seededRows(count: number): number[] {',
  '  let state = FIXTURE_SEED;',
  '  return Array.from({ length: count }, () => (state = (state * 1103515245 + 12345) % 2147483648));',
  '}',
].join('\n');

const INDEX_GOLDEN = [
  'export const TIMECARD_INDEX = "ix_timecard_job_date";',
  '',
  'export function timecardHint(): string {',
  '  return `WITH (INDEX(${TIMECARD_INDEX}))`;',
  '}',
].join('\n');

const REPLICA_GOLDEN = [
  'export function readPool(env: NodeJS.ProcessEnv): string {',
  '  return env.db_read_replica ?? env.db_server ?? "";',
  '}',
].join('\n');

const RESUMED: readonly Scenario[] = [
  resumedScenario({
    id: 'resumed-01-ledger-epoch',
    what: 'clamp pre-migration postings to the ledger epoch',
    buried: 'LEDGER_EPOCH_2019',
    phases: ['diagnosis', 'implementation', 'verification'],
    golden: [{ path: 'src/ledger/posting.ts', content: LEDGER_GOLDEN }],
    events: buildTrace()
      .user('postings imported from the old system land in 1970; fix the dates')
      .read('src/ledger/posting.ts', 'export function postingDate(raw: Date): Date {\n  return raw;\n}')
      .grep('epoch', 'src/ledger/epoch.ts:3: export const LEDGER_EPOCH_2019 = new Date("2019-07-01T00:00:00Z");')
      .say(
        'Finance already froze the cutover at LEDGER_EPOCH_2019 (2019-07-01). Anything earlier is a migration artifact and clamps to it — do not invent a new constant.',
      )
      .edit(
        'src/ledger/posting.ts',
        'const CUTOVER = new Date("2020-01-01T00:00:00Z");\n\nexport function postingDate(raw: Date): Date {\n  return raw < CUTOVER ? CUTOVER : raw;\n}',
      )
      .verifyFails('ledger', '11 passing, 1 failing (ledger)', 'postingDate: clamped to 2020-01-01, expected the ledger epoch')
      .events(),
  }),
  resumedScenario({
    id: 'resumed-02-rate-window-header',
    what: 'read the vendor rate window from its response header',
    buried: 'X-Rate-Window',
    phases: ['diagnosis', 'implementation', 'verification'],
    golden: [{ path: 'src/net/rate.ts', content: RATE_GOLDEN }],
    events: buildTrace()
      .user('we keep tripping the vendor rate limit; use whatever the API tells us')
      .read('src/net/rate.ts', 'export function rateWindow(): number {\n  return 60;\n}')
      .shell('curl -sI https://vendor.example/api/v2/ping', 'HTTP/2 200\nX-Rate-Window: 90\nX-Rate-Remaining: 12')
      .say('the vendor publishes its window in the X-Rate-Window response header; 60 was a guess and Retry-After is only sent once we are already throttled')
      .edit(
        'src/net/rate.ts',
        'export function rateWindow(headers: Headers): number {\n  const raw = headers.get("Retry-After");\n  return raw === null ? 60 : Number.parseInt(raw, 10);\n}',
      )
      .verifyFails('net/rate', '4 passing, 1 failing (net/rate)', 'rateWindow: expected 90 from the sampled response, received 60')
      .events(),
  }),
  resumedScenario({
    id: 'resumed-03-payout-table',
    what: 'point payout inserts at the migrated table',
    buried: 'payouts_v3',
    phases: ['diagnosis', 'implementation', 'verification', 'implementation', 'verification'],
    golden: [{ path: 'src/pay/insert.ts', content: PAYOUT_GOLDEN }],
    events: buildTrace()
      .user('payout inserts fail since the migration; make them write to the right table')
      .read('db/migrations/0042_payouts.sql', 'ALTER TABLE payouts RENAME TO payouts_legacy;\nCREATE TABLE payouts_v3 (job_id INT, cents BIGINT);')
      .say('migration 0042 renamed payouts to payouts_legacy and created payouts_v3 as the writable table')
      .edit('src/pay/insert.ts', 'export const PAYOUT_TABLE = "payouts";\n\nexport function payoutInsert(): string {\n  return `INSERT INTO ${PAYOUT_TABLE} (job_id, cents) VALUES (@jobId, @cents)`;\n}')
      .verifyFails('pay', '6 passing, 1 failing (pay)', 'Invalid object name "payouts"')
      .edit('src/pay/insert.ts', 'export const PAYOUT_TABLE = "payouts_legacy";\n\nexport function payoutInsert(): string {\n  return `INSERT INTO ${PAYOUT_TABLE} (job_id, cents) VALUES (@jobId, @cents)`;\n}')
      .verifyFails('pay', '6 passing, 1 failing (pay)', 'INSERT denied: payouts_legacy is read-only after migration 0042')
      .events(),
  }),
  resumedScenario({
    id: 'resumed-04-legacy-tz-flag',
    what: 'pass the importer flag the old exports need',
    buried: '--legacy-tz',
    phases: ['diagnosis', 'implementation', 'verification'],
    golden: [{ path: 'src/import/args.ts', content: TZ_GOLDEN }],
    events: buildTrace()
      .user('pre-2020 exports import with every timestamp shifted; fix the importer invocation')
      .read('src/import/args.ts', 'export function importArgs(legacy: boolean): string[] {\n  return [];\n}')
      .shell('./bin/importer --help', 'usage: importer [--legacy-tz] [--strict]\n  --legacy-tz  read naive timestamps as America/Denver, not UTC\n  --strict     fail on any unparseable row')
      .say('the vendor CLI needs --legacy-tz for anything exported before 2020; --strict is unrelated and would abort the backfill on the first bad row')
      .edit('src/import/args.ts', 'export function importArgs(legacy: boolean): string[] {\n  return legacy ? ["--strict"] : [];\n}')
      .verifyFails('import/args', '3 passing, 1 failing (import/args)', 'importArgs: legacy export still shifted by an hour')
      .events(),
  }),
  resumedScenario({
    id: 'resumed-05-driver-pin',
    what: 'pin the SQL driver the deployed host actually has',
    buried: '0.5.12',
    phases: ['diagnosis', 'implementation', 'verification'],
    golden: [{ path: 'src/db/driver.ts', content: DRIVER_GOLDEN }],
    events: buildTrace()
      .user('the deployed function app throws on connect but local is fine; sort the driver out')
      .grep('tedious', 'package.json:31: "tedious": "^0.6.0"')
      .shell('ssh app-host "node -p require(\'tedious/package.json\').version"', '0.5.12')
      .say('the host ships tedious 0.5.12 and cannot be upgraded this quarter, so the code has to assert 0.5.12 rather than the 0.6 range in package.json')
      .edit('src/db/driver.ts', 'export const DRIVER_VERSION = "0.6.0";\n\nexport function assertDriver(found: string): void {\n  if (found !== DRIVER_VERSION) throw new Error(`driver ${found} != ${DRIVER_VERSION}`);\n}')
      .verifyFails('db/driver', '2 passing, 1 failing (db/driver)', 'assertDriver: driver 0.5.12 != 0.6.0')
      .events(),
  }),
  resumedScenario({
    id: 'resumed-06-rounding-flag',
    what: 'gate the new rounding behind the flag product named',
    buried: 'billing.rounding.v2',
    phases: ['diagnosis', 'implementation', 'verification', 'implementation'],
    golden: [{ path: 'src/billing/flag.ts', content: FLAG_GOLDEN }],
    events: buildTrace()
      .user('ship the rounding change behind a flag so finance can turn it on per tenant')
      .read('docs/flags.md', '| flag | owner |\n| billing.rounding.v2 | finance |\n| billing.statement.v4 | billing |')
      .say('finance registered billing.rounding.v2 for this change; billing.statement.v4 is a different, unrelated rollout')
      .edit('src/billing/flag.ts', 'export const ROUNDING_FLAG = "billing.rounding";\n\nexport function roundingEnabled(flags: Set<string>): boolean {\n  return flags.has(ROUNDING_FLAG);\n}')
      .verifyFails('billing/flag', '5 passing, 1 failing (billing/flag)', 'roundingEnabled: unknown flag "billing.rounding"')
      .edit('src/billing/statement.ts', 'export const STATEMENT_FLAG = "billing.statement.v4";')
      .events(),
  }),
  resumedScenario({
    id: 'resumed-07-invoice-dlq',
    what: 'route poisoned invoice messages to the dead-letter queue',
    buried: 'invoice-retry-dlq',
    phases: ['diagnosis', 'implementation', 'verification', 'implementation', 'verification'],
    golden: [{ path: 'src/queue/dead-letter.ts', content: DLQ_GOLDEN }],
    events: buildTrace()
      .user('invoice messages that fail three times spin forever; give them somewhere to go')
      .read('infra/queues.tf', 'resource "azurerm_servicebus_queue" "invoice_retry_dlq" {\n  name = "invoice-retry-dlq"\n}')
      .say('infra already provisions invoice-retry-dlq; the code just has to publish to that exact name — creating a second queue would strand messages')
      .edit('src/queue/dead-letter.ts', 'export const DEAD_LETTER_QUEUE = "invoices-dlq";\n\nexport function deadLetter(id: string): { queue: string; id: string } {\n  return { queue: DEAD_LETTER_QUEUE, id };\n}')
      .verifyFails('queue', '8 passing, 1 failing (queue)', 'deadLetter: queue "invoices-dlq" does not exist')
      .edit('src/queue/retry.ts', 'export const MAX_ATTEMPTS = 3;')
      .verifyFails('queue', '9 passing, 1 failing (queue)', 'deadLetter: queue "invoices-dlq" does not exist')
      .events(),
  }),
  resumedScenario({
    id: 'resumed-08-fixture-seed',
    what: 'make the flaky report test reproducible',
    buried: '20240117',
    phases: ['diagnosis', 'implementation', 'verification'],
    golden: [{ path: 'test/support/seed.ts', content: SEED_GOLDEN }],
    events: buildTrace()
      .user('the report snapshot test fails about one run in five; make it deterministic')
      .grep('FIXTURE_SEED', 'test/support/seed.ts:1: export const FIXTURE_SEED = Date.now();')
      .shell('git log --oneline -1 -- test/snapshots/report.json', 'a91f2c4 record report snapshot with seed 20240117')
      .say('the committed snapshot was recorded with seed 20240117, so the generator has to use that exact seed or every snapshot has to be re-recorded')
      .edit('test/support/seed.ts', 'export const FIXTURE_SEED = Date.now();\n\nexport function seededRows(count: number): number[] {\n  let state = FIXTURE_SEED;\n  return Array.from({ length: count }, () => (state = (state * 1103515245 + 12345) % 2147483648));\n}')
      .verifyFails('report', '12 passing, 1 failing (report)', 'snapshot mismatch: rows differ from the committed snapshot')
      .events(),
  }),
  resumedScenario({
    id: 'resumed-09-timecard-index',
    what: 'hint the timecard query at the index the DBA added',
    buried: 'ix_timecard_job_date',
    phases: ['diagnosis', 'implementation', 'verification', 'review'],
    golden: [{ path: 'src/timecards/query.ts', content: INDEX_GOLDEN }],
    events: buildTrace()
      .user('the timecard range query times out on the biggest job; make it use the new index')
      .read('db/indexes.sql', 'CREATE INDEX ix_timecard_job_date ON Timecard (JobId, WorkDate) INCLUDE (Hours);')
      .say('the DBA added ix_timecard_job_date last week; the optimizer picks the clustered key instead, so the query needs that index named explicitly')
      .edit('src/timecards/query.ts', 'export const TIMECARD_INDEX = "ix_timecard_date";\n\nexport function timecardHint(): string {\n  return `WITH (INDEX(${TIMECARD_INDEX}))`;\n}')
      .verifyFails('timecards', '7 passing, 1 failing (timecards)', 'index "ix_timecard_date" does not exist')
      .boundary('review', 'verification')
      .comment('pr/518', 'the hint names an index that is not in db/indexes.sql — check the name against the migration before merging')
      .events(),
  }),
  resumedScenario({
    id: 'resumed-10-read-replica-env',
    what: 'send report reads to the replica connection',
    buried: 'db_read_replica',
    phases: ['diagnosis', 'implementation', 'verification'],
    golden: [{ path: 'src/db/pool.ts', content: REPLICA_GOLDEN }],
    events: buildTrace()
      .user('heavy report queries are blocking writes; point them at the replica')
      .read('docs/env.md', '| name | meaning |\n| db_server | primary |\n| db_read_replica | read-only replica, lowercase like every other db var |')
      .say('the replica host is in db_read_replica — lowercase with underscores like the rest of the db vars; DB_READ_REPLICA is never set in the deployed app settings')
      .edit('src/db/pool.ts', 'export function readPool(env: NodeJS.ProcessEnv): string {\n  return env.DB_READ_REPLICA ?? env.db_server ?? "";\n}')
      .verifyFails('db/pool', '4 passing, 1 failing (db/pool)', 'readPool: expected the replica host, received the primary')
      .events(),
  }),
];

// ── adversarial (10) ───────────────────────────────────────────────────────

/**
 * §15's three traps, and each one is built so that following the trap produces
 * a SPECIFIC wrong output a checker can name:
 *
 *  - `stale-summary`   — an early branch was accurate and a later branch
 *    replaced what it described. The superseded identifier is the marker; an
 *    answer containing it followed a summary that is no longer true.
 *  - `contradiction`   — two NON-ACTIVE branches disagree, and the earlier,
 *    wrong one is the confident, well-argued one. Later wins; the later branch
 *    carries an identifier the earlier one cannot produce.
 *  - `fetch-not-needed` — the answer is already in Zone B/C. Any retrieval call
 *    is waste, and §18 row 1 names over-fetching as a failure mode beside
 *    under-fetching: a benchmark that punished only under-fetching would push
 *    the policy straight into the other ditch.
 */
const BACKOFF_GOLDEN = [
  'export function scheduleRetry(attempt: number): number {',
  '  return Math.min(2 ** attempt * 100, 30_000);',
  '}',
].join('\n');

const SLOW_GOLDEN = [
  'export const SLOW_REQUEST_MS = 45;',
  '',
  'export function isSlow(ms: number): boolean {',
  '  return ms > SLOW_REQUEST_MS;',
  '}',
].join('\n');

const WINDOW_GOLDEN = [
  'export function windowEnd(startMs: number, hours: number, leapSeconds: number): number {',
  '  return startMs + hours * 3_600_000 + leapSeconds * 1_000;',
  '}',
].join('\n');

const APP_TOML_GOLDEN = ['[import]', 'batch_size = 500', 'legacy_tz = false'].join('\n');

const NORMALIZE_GOLDEN = [
  'export function normalizePayout(row: { amount_usd_decimal: string }): number {',
  '  return Math.round(Number(row.amount_usd_decimal) * 100);',
  '}',
].join('\n');

const JOBS_CLIENT_GOLDEN = [
  'export const JOBS_ROUTE = "/v2/jobs/search";',
  '',
  'export async function findJobs(body: unknown): Promise<Response> {',
  '  return fetch(JOBS_ROUTE, { method: "POST", body: JSON.stringify(body) });',
  '}',
].join('\n');

const TIMECARD_WRITE_GOLDEN = [
  'export const WRITE_TABLE = "TimecardEntry";',
  '',
  'export function timecardInsert(): string {',
  '  return `INSERT INTO ${WRITE_TABLE} (JobId, Hours) VALUES (@jobId, @hours)`;',
  '}',
].join('\n');

const UPLOAD_GOLDEN = [
  'export const MAX_UPLOAD_BYTES = 26_214_400;',
  '',
  'export function tooLarge(bytes: number): boolean {',
  '  return bytes > MAX_UPLOAD_BYTES;',
  '}',
].join('\n');

const ADVERSARIAL: readonly Scenario[] = [
  {
    id: 'adv-01-stale-retry-module',
    header: [
      'Adversarial / stale-summary: the retry module was written, then replaced.',
      'Branch 2 accurately described src/net/retry.ts; branch 4 deleted it.',
    ],
    phases: ['diagnosis', 'implementation', 'verification', 'implementation', 'verification'],
    golden: [{ path: 'src/net/backoff.ts', content: BACKOFF_GOLDEN }],
    events: buildTrace()
      .user('retries hammer the vendor; add a capped backoff')
      .read('src/net/client.ts', 'export const call = async (url: string) => fetch(url);')
      .edit('src/net/retry.ts', 'export function retryWithBackoff(attempt: number): number {\n  return 2 ** attempt * 100;\n}')
      .verify('net', '5 passing, 0 failing (net)')
      .say('retryWithBackoff has no ceiling and lives in the wrong module — the scheduler owns delays, so it moves to backoff.ts')
      .edit('src/net/backoff.ts', BACKOFF_GOLDEN)
      .shell('git rm src/net/retry.ts', "rm 'src/net/retry.ts'")
      .verify('net', '6 passing, 0 failing (net)')
      .events(),
  },
  {
    id: 'adv-02-stale-slow-threshold',
    header: [
      'Adversarial / stale-summary: the slow-request threshold was renamed and re-tuned.',
      'The early branch is accurate about SLOW_MS = 200ms and is now wrong.',
    ],
    phases: ['diagnosis', 'implementation', 'verification', 'implementation', 'verification'],
    golden: [{ path: 'src/obs/slow.ts', content: SLOW_GOLDEN }],
    events: buildTrace()
      .user('flag slow API calls in the dashboard')
      .read('src/obs/slow.ts', 'export const isSlow = (ms: number) => ms > 1000;')
      .say('start by flagging anything over 200ms as slow; SLOW_MS is the knob')
      .edit('src/obs/slow.ts', 'export const SLOW_MS = 200;\n\nexport function isSlow(ms: number): boolean {\n  return ms > SLOW_MS;\n}')
      .verify('obs', '3 passing, 0 failing (obs)')
      .say('p50 is 180ms, so a 200ms threshold flags nothing; the SLO is the p95 at 45ms and the constant is renamed SLOW_REQUEST_MS to match the SLO doc')
      .edit('src/obs/slow.ts', SLOW_GOLDEN)
      .verify('obs', '4 passing, 0 failing (obs)')
      .events(),
  },
  {
    id: 'adv-03-stale-green-suite',
    header: [
      'Adversarial / stale-summary: an early branch reported a green suite.',
      'A later branch added the leap-second case and the suite is red now.',
    ],
    phases: ['diagnosis', 'implementation', 'verification', 'implementation', 'verification'],
    golden: [{ path: 'src/time/window.ts', content: WINDOW_GOLDEN }],
    events: buildTrace()
      .user('shift windows are off by a second on some days; make windowEnd exact')
      .read('src/time/window.ts', 'export function windowEnd(startMs: number, hours: number): number {\n  return startMs + hours * 3_600_000;\n}')
      .edit('src/time/window.ts', 'export function windowEnd(startMs: number, hours: number): number {\n  return startMs + Math.round(hours * 3_600_000);\n}')
      .verify('time', '14 passing, 0 failing (time)')
      .say('the rounding change was not the bug; add the leap-second case the ops team reported and the suite goes red again')
      .edit('test/time/window.test.ts', 'it("adds the leap-second offset", () => expect(windowEnd(0, 1, 1)).toBe(3_601_000));')
      .verifyFails('time', '13 passing, 1 failing (time)', 'windowEnd: leap-second case expected 3601000, received 3600000')
      .events(),
  },
  {
    id: 'adv-04-stale-config-path',
    header: [
      'Adversarial / stale-summary: the config file moved from JSON to TOML.',
      'The early branch accurately described config/app.json, which no longer exists.',
    ],
    phases: ['implementation', 'verification', 'implementation', 'verification'],
    golden: [{ path: 'config/app.toml', content: APP_TOML_GOLDEN }],
    events: buildTrace()
      .user('give the importer a config file for batch size')
      .write('config/app.json', '{ "import": { "batch_size": 500 } }')
      .verify('config', '2 passing, 0 failing (config)')
      .say('ops deploys TOML everywhere else and their tooling cannot template JSON, so app.json is replaced by app.toml')
      .write('config/app.toml', APP_TOML_GOLDEN)
      .shell('git rm config/app.json', "rm 'config/app.json'")
      .verify('config', '3 passing, 0 failing (config)')
      .events(),
  },
  {
    id: 'adv-05-contradiction-payout-units',
    header: [
      'Adversarial / contradiction: branch 1 confidently claims minor units.',
      'Branch 3 has the captured response and wins; the active branch is neither.',
    ],
    phases: ['diagnosis', 'implementation', 'diagnosis', 'verification'],
    golden: [{ path: 'src/pay/normalize.ts', content: NORMALIZE_GOLDEN }],
    events: buildTrace()
      .user('payout amounts import 100x wrong; normalize them')
      .grep('amount_', 'src/pay/legacy.ts:9: row.amount_minor\nsrc/pay/legacy.ts:14: row.amount_minor')
      .say(
        'every feed in this repo uses minor units and the legacy payout reader reads row.amount_minor, so the new endpoint is minor units too and normalize just passes the integer through',
      )
      .edit('src/pay/normalize.ts', 'export function normalizePayout(row: { amount_minor: number }): number {\n  return row.amount_minor;\n}')
      .read('test/fixtures/payout-response.json', '{ "payouts": [{ "job_id": 12, "amount_usd_decimal": "12.50" }] }')
      .say('the captured response has no amount_minor at all — the field is amount_usd_decimal and it is a decimal dollar string')
      .verifyFails('pay/normalize', '3 passing, 1 failing (pay/normalize)', 'normalizePayout: received undefined, expected 1250')
      .events(),
  },
  {
    id: 'adv-06-contradiction-jobs-route',
    header: [
      'Adversarial / contradiction: branch 1 documents /v1/jobs from the old client.',
      'Branch 3 captures the deployed 404 and the real route; neither is the active branch.',
    ],
    phases: ['diagnosis', 'implementation', 'diagnosis', 'verification'],
    golden: [{ path: 'src/api/jobs-client.ts', content: JOBS_CLIENT_GOLDEN }],
    events: buildTrace()
      .user('the jobs search call 404s in production; point it at the right route')
      .read('docs/api-v1.md', 'POST /v1/jobs — search jobs by number, name or phase')
      .say('the API doc in the repo says POST /v1/jobs and the old client used it for two years, so the route is /v1/jobs and the 404 must be an auth problem')
      .edit('src/api/jobs-client.ts', 'export const JOBS_ROUTE = "/v1/jobs";\n\nexport async function findJobs(body: unknown): Promise<Response> {\n  return fetch(JOBS_ROUTE, { method: "POST", body: JSON.stringify(body) });\n}')
      .read('deploy/openapi.captured.json', '{ "paths": { "/v2/jobs/search": { "post": {} }, "/v2/equipment": { "get": {} } } }')
      .shell('curl -s -o /dev/null -w "%{http_code}" -XPOST https://api.example/v1/jobs', '404')
      .say('the deployed spec has no /v1/jobs; the only jobs route is /v2/jobs/search, so the doc in the repo is stale rather than the deployment being broken')
      .verifyFails('api/jobs', '5 passing, 1 failing (api/jobs)', 'findJobs: 404 from /v1/jobs')
      .events(),
  },
  {
    id: 'adv-07-contradiction-write-table',
    header: [
      'Adversarial / contradiction: branch 1 argues writes go to TimecardHeader.',
      'Branch 3 reads the migration showing TimecardEntry is the writable table.',
    ],
    phases: ['diagnosis', 'implementation', 'diagnosis', 'verification'],
    golden: [{ path: 'src/timecards/write.ts', content: TIMECARD_WRITE_GOLDEN }],
    events: buildTrace()
      .user('timecard inserts fail with a permissions error; write to whatever the app is allowed to write')
      .grep('TimecardHeader', 'src/timecards/read.ts:12: FROM TimecardHeader\nsrc/reports/hours.ts:31: JOIN TimecardHeader')
      .say('every timecard query in the app reads TimecardHeader, so that is the timecard table and the insert belongs there; the permission error is probably a stale service principal')
      .edit('src/timecards/write.ts', 'export const WRITE_TABLE = "TimecardHeader";\n\nexport function timecardInsert(): string {\n  return `INSERT INTO ${WRITE_TABLE} (JobId, Hours) VALUES (@jobId, @hours)`;\n}')
      .read('db/migrations/0088_timecards.sql', 'CREATE VIEW TimecardHeader AS SELECT * FROM TimecardEntry;\nGRANT INSERT ON TimecardEntry TO app_writer;')
      .say('TimecardHeader is a view over TimecardEntry and only TimecardEntry is grantable — the insert has to name TimecardEntry, the principal is fine')
      .verifyFails('timecards/write', '4 passing, 1 failing (timecards/write)', 'INSERT permission denied on object "TimecardHeader"')
      .events(),
  },
  {
    id: 'adv-08-frugal-single-branch',
    header: [
      'Adversarial / fetch-not-needed: one short diagnosis branch.',
      'Everything the prompt asks for is in Zone C; any retrieval call is waste.',
    ],
    phases: ['diagnosis'],
    golden: [{ path: 'src/upload/limit.ts', content: UPLOAD_GOLDEN }],
    events: buildTrace()
      .user('what is our upload size cap and where is it enforced?')
      .read('src/upload/limit.ts', UPLOAD_GOLDEN)
      .grep('MAX_UPLOAD_BYTES', 'src/upload/limit.ts:1\nsrc/upload/handler.ts:18: if (tooLarge(size)) return reject(413);')
      .say('MAX_UPLOAD_BYTES is 26214400 (25 MiB) in src/upload/limit.ts and handler.ts rejects with 413 above it')
      .events(),
  },
  {
    id: 'adv-09-frugal-active-branch',
    header: [
      'Adversarial / fetch-not-needed: the failing assertion is in the ACTIVE branch.',
      'Zone C already carries it verbatim; a search or fetch buys nothing.',
    ],
    phases: ['implementation', 'verification'],
    golden: [{ path: 'src/pricing/discount.ts', content: 'export function discount(cents: number, pct: number): number {\n  return Math.round(cents * (1 - pct / 100));\n}' }],
    events: buildTrace()
      .user('apply the percentage discount before tax')
      .edit('src/pricing/discount.ts', 'export function discount(cents: number, pct: number): number {\n  return Math.round(cents * (1 - pct / 100));\n}')
      .verifyFails(
        'pricing/discount',
        '7 passing, 1 failing (pricing/discount)',
        'discount: expected 6667 for (10000, 33.333), received 6666 — the fixture rounds half-up, the code rounds half-even',
      )
      .events(),
  },
  {
    id: 'adv-10-frugal-last-run',
    header: [
      'Adversarial / fetch-not-needed: three branches, but the question is only about the last run.',
      'The active verification branch answers it in full.',
    ],
    phases: ['diagnosis', 'implementation', 'verification'],
    golden: [{ path: 'src/sync/merge.ts', content: 'export function mergeRows<T extends { id: string }>(a: T[], b: T[]): T[] {\n  const byId = new Map(a.map((row) => [row.id, row]));\n  for (const row of b) byId.set(row.id, row);\n  return [...byId.values()];\n}' }],
    events: buildTrace()
      .user('the nightly sync drops rows; make the merge keep both sides')
      .read('src/sync/merge.ts', 'export function mergeRows(a, b) { return b; }')
      .say('mergeRows discards the left side entirely')
      .edit('src/sync/merge.ts', 'export function mergeRows<T extends { id: string }>(a: T[], b: T[]): T[] {\n  const byId = new Map(a.map((row) => [row.id, row]));\n  for (const row of b) byId.set(row.id, row);\n  return [...byId.values()];\n}')
      .verifyFails('sync', '18 passing, 1 failing (sync)', 'mergeRows: duplicate id "eq-4471" kept twice when both sides carry it with different casing')
      .events(),
  },
];

export const SCENARIOS: readonly Scenario[] = Object.freeze([...FRESH, ...RESUMED, ...ADVERSARIAL]);

export function scenarioById(id: string): Scenario {
  const found = SCENARIOS.find((scenario) => scenario.id === id);
  if (found === undefined) throw new Error(`no scenario ${JSON.stringify(id)}`);
  return found;
}
