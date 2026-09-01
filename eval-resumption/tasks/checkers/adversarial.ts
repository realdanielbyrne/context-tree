/**
 * Checkers for the ten `adversarial` tasks — four `stale-summary`, three
 * `contradiction`, three `fetch-not-needed` (§15).
 *
 * The stale checkers report `staleSummaryIncident` whenever a superseded marker
 * appears, which is §15's organization-quality metric, and fail the run only
 * when the answer names the superseded state *and never reaches the current
 * one*. Mentioning that a module was replaced is not following a stale summary;
 * working on it as if it still existed is.
 *
 * The contradiction checkers assert the identifier only the LATER branch can
 * supply — an answer that resolved the contradiction the wrong way cannot
 * produce it — and hand the remaining question ("does it say which version it
 * is acting on, and why?") to the rubric rather than faking a script check for
 * something that is genuinely a judgement.
 *
 * The frugality checkers lean on `expect.maxToolCalls` / `expect.forbidsTool`,
 * which the harness's own checker enforces. §18 row 1 names over-fetching as a
 * failure mode beside under-fetching; a benchmark that punished only the second
 * would drive the retrieval policy straight into the first.
 */
import { checkerFor } from './grade.js';

// ── stale-summary ──────────────────────────────────────────────────────────

export const adv01StaleRetryModule = checkerFor({
  what: 'works on scheduleRetry in backoff.ts, the module that replaced the deleted retry.ts',
  staleIsFatal: true,
});

export const adv02StaleSlowThreshold = checkerFor({
  what: 'uses SLOW_REQUEST_MS at 45ms, not the 200ms SLOW_MS the first branch accurately described',
  staleIsFatal: true,
});

export const adv03StaleGreenSuite = checkerFor({
  what: 'reports the suite as red on the leap-second case, not the green run the earlier branch recorded',
  staleIsFatal: true,
});

export const adv04StaleConfigPath = checkerFor({
  what: 'edits config/app.toml, the file that replaced the app.json the first branch created',
  staleIsFatal: true,
});

// ── contradiction ──────────────────────────────────────────────────────────

export const adv05ContradictionPayoutUnits = checkerFor({
  what: 'normalizes amount_usd_decimal from the captured response, not the amount_minor the confident earlier branch argued for',
  judged: ['states which branch it is acting on and why the other one is superseded'],
});

export const adv06ContradictionJobsRoute = checkerFor({
  what: 'calls /v2/jobs/search from the deployed spec, not the /v1/jobs the in-repo doc still advertises',
  judged: ['states which branch it is acting on and why the other one is superseded'],
});

export const adv07ContradictionWriteTable = checkerFor({
  what: 'inserts into TimecardEntry, the grantable base table, not the TimecardHeader view every query reads',
  judged: ['states which branch it is acting on and why the other one is superseded'],
});

// ── fetch-not-needed ───────────────────────────────────────────────────────

export const adv08FrugalSingleBranch = checkerFor({
  what: 'answers the upload cap from the one branch it was given, spending no retrieval call to do it',
});

export const adv09FrugalActiveBranch = checkerFor({
  what: 'reads the failing assertion out of the active branch it was already handed, with no search',
});

export const adv10FrugalLastRun = checkerFor({
  what: 'reports the last run from the active verification branch without fetching either older branch',
});
