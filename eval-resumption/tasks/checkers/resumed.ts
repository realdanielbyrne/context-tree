/**
 * Checkers for the ten `resumed` tasks (§15's centre of gravity).
 *
 * Each one grades two things and nothing else:
 *  - the golden state — did the answer land on the file the task had to end at;
 *  - the BURIED FACT (`expect.answerContains`) — a token that exists only in a
 *    branch that is not the active one. The active branch is a failing test run
 *    or a half-applied edit; it says what is wrong and never says what the
 *    session had already decided to do about it.
 *
 * That is why these are content assertions rather than `requiresTool`. Only arm
 * D is handed the §9 tools, so a tool requirement would fail arms A/B/C by
 * construction and hand D §15's success-rate gap for free. Requiring the fact
 * instead lets every arm satisfy it however its context allows: A reads it in
 * the transcript, B misses it once it falls out of the window, C keeps it only
 * if the flatten happened to, and D has to fetch the branch.
 */
import { checkerFor } from './grade.js';

export const resumed01LedgerEpoch = checkerFor({
  what: 'clamps to LEDGER_EPOCH_2019, the cutover the diagnosis branch settled, not the 2020 date the edit guessed',
});

export const resumed02RateWindowHeader = checkerFor({
  what: 'reads X-Rate-Window, the header the sampled response carried, not the Retry-After the edit reached for',
});

export const resumed03PayoutTable = checkerFor({
  what: 'writes to payouts_v3, the table migration 0042 created, not either name the two failed edits tried',
});

export const resumed04LegacyTzFlag = checkerFor({
  what: 'passes --legacy-tz, the flag the CLI help documented, not the --strict the edit substituted',
});

export const resumed05DriverPin = checkerFor({
  what: 'pins 0.5.12, the driver the deployed host actually has, not the 0.6.0 the edit asserted',
});

export const resumed06RoundingFlag = checkerFor({
  what: 'uses billing.rounding.v2, the flag finance registered, not the truncated name the edit used',
});

export const resumed07InvoiceDlq = checkerFor({
  what: 'publishes to invoice-retry-dlq, the queue infra already provisions, not the invented invoices-dlq',
});

export const resumed08FixtureSeed = checkerFor({
  what: 'uses seed 20240117, the seed the committed snapshot was recorded with, not a fresh clock value',
});

export const resumed09TimecardIndex = checkerFor({
  what: 'names ix_timecard_job_date, the index in the migration, not the ix_timecard_date the edit invented',
});

export const resumed10ReadReplicaEnv = checkerFor({
  what: 'reads db_read_replica in the lowercase form the deployment sets, not the uppercase spelling the edit used',
});
