/**
 * Checkers for the ten `fresh` tasks (§15).
 *
 * A fresh task starts from nothing, so there is no recovered state to grade:
 * what a pass means is that the agent landed on the right file and named a
 * symbol that really exists in its end state. That is deliberately a low bar —
 * §15 uses these to measure whether the tree HELPS or merely DOES NOT HURT, and
 * a bar only arm A can clear would measure the task, not the context regime.
 *
 * Four of the ten also carry `expect.maxToolCalls`, which is where the
 * "does not hurt" question actually bites: with one short branch there is
 * nothing to retrieve, so every call is spend with no answer behind it.
 */
import { checkerFor } from './grade.js';

export const fresh01InvoiceRounding = checkerFor({
  what: 'names src/pricing/invoice.ts and lineTotal as the rounding site',
});

export const fresh02CsvQuotes = checkerFor({
  what: 'names src/import/csv.ts and parseRow as the quote-unaware splitter',
});

export const fresh03RetryJitter = checkerFor({
  what: 'names src/net/retry.ts and nextDelayMs as the lockstep backoff',
});

export const fresh04TimezoneShift = checkerFor({
  what: 'names src/time/shift.ts and shiftEnd as the wall-clock arithmetic',
});

export const fresh05PaginationOffset = checkerFor({
  what: 'names src/api/paginate.ts and pageSlice as the off-by-one',
});

export const fresh06CacheKeyCollision = checkerFor({
  what: 'names src/cache/key.ts and cacheKey as the ambiguous key builder',
});

export const fresh07ZeroCoercedNull = checkerFor({
  what: 'names src/db/rows.ts and toCamel as the place a zero becomes null',
});

export const fresh08SlugUnicode = checkerFor({
  what: 'names src/text/slug.ts and slugify as the non-ASCII stripper',
});

export const fresh09ConcurrencyCap = checkerFor({
  what: 'names src/queue/pool.ts and runPool as the cap that is never read',
});

export const fresh10LogRedaction = checkerFor({
  what: 'names src/log/redact.ts and redact as the incomplete redaction',
});
