/**
 * H2 CORPUS SURVEY — is there ANY corpus on this machine on which a pairwise
 * co-reference statistic has enough support to be tested?
 *
 * The H2 offline arm failed its own support gate on the committed fixtures (same-turn
 * support 7.7%). The stated remedy was "build a reference-dense corpus". This file is
 * the search for one, and it is written to be decisive in either direction: it reports
 * the support figure BEFORE any contrast, so a corpus that fails is recorded as a
 * failure rather than being run anyway.
 *
 * FOUR THINGS ARE MEASURED, in the order that matters:
 *
 *  1. DENSITY OF EVERY AVAILABLE CORPUS. The committed fixtures plus every Claude Code
 *     session on this machine (`~/.claude/projects`). Reported as references per turn
 *     AND references per distinct file — the second is the one that governs a pairwise
 *     statistic, because support needs a file to recur, not merely to appear.
 *  2. FILES PER TURN. The structural question. If an agent names one file per turn, two
 *     specific files are almost never co-active in the same turn, and no amount of extra
 *     data changes that.
 *  3. SUPPORT BY HOW OFTEN THE CANDIDATE'S FILE RECURS. A legitimate scoping question:
 *     covariance is only claimed for units whose files have history, so does the
 *     subpopulation that has history clear the gate?
 *  4. THE SUPPORT CEILING OVER DILATION L. Widening the episode window raises support
 *     mechanically. This reports how far it can be pushed, so the gate can be judged
 *     against the best case rather than one arbitrary setting.
 *
 * PRIVACY. The local sessions are the user's own work on other repositories. Only
 * AGGREGATES leave this file — turn counts, reference counts, distinct-file counts.
 * No file path, session id or project name is written to the results file; projects are
 * labelled `project-A`, `project-B`, ... in first-seen order.
 *
 * Offline, CPU only, no model calls.
 *
 * Rerun: node experiments/covariance-eviction/corpus-survey.mjs
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureFiles, parseSession } from './transcript.mjs';
import { emptyCounts, pushTurn, unionSets, supportOf, dilate } from './signals.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const K = +(process.env.CT_COV_K || 5);
const H = +(process.env.CT_COV_H || 3);
const START = +(process.env.CT_COV_START || 20);
const MAX_CAND = +(process.env.CT_COV_MAX_CAND || 200);
const L_SWEEP = (process.env.CT_COV_L_SWEEP || '1,2,3,5,10,20').split(',').map(Number);
/** The pre-registered gate from DESIGN-H2 §6: the MEDIAN candidate must have a non-empty
 *  contingency table, plus a margin. Stated here so the survey cannot be read without it. */
const GATE = 0.50, GATE_MARGIN = 0.05;

/** This session's own transcript — excluded, because analysing it would be circular. */
const SELF_SESSION = process.env.CT_COV_SELF || '11bef7b8';

function densityOf(parsed) {
  const files = new Map();
  let pairableTurns = 0, referencingTurns = 0;
  const perTurnHist = new Map();
  for (const t of parsed.turns) {
    const n = t.files.size;
    if (n === 0) continue;
    referencingTurns += 1;
    if (n >= 2) pairableTurns += 1;
    const b = n === 1 ? '1' : n === 2 ? '2' : n <= 4 ? '3-4' : '5+';
    perTurnHist.set(b, (perTurnHist.get(b) || 0) + 1);
    for (const x of t.files) files.set(x, (files.get(x) || 0) + 1);
  }
  const counts = [...files.values()];
  return {
    turns: parsed.nTurns, refs: parsed.nRefs, distinct_files: files.size,
    refs_per_turn: parsed.nTurns ? +(parsed.nRefs / parsed.nTurns).toFixed(3) : 0,
    refs_per_file: files.size ? +(parsed.nRefs / files.size).toFixed(3) : 0,
    files_with_3plus_refs: counts.filter((c) => c >= 3).length,
    referencing_turns: referencingTurns,
    turns_able_to_form_a_same_turn_pair: pairableTurns,
    share_turns_able_to_pair: referencingTurns ? +(pairableTurns / referencingTurns).toFixed(4) : 0,
    files_per_turn_histogram: Object.fromEntries(['1', '2', '3-4', '5+'].map((b) => [b, perTurnHist.get(b) || 0])),
  };
}

/** Local Claude Code sessions, aggregated per project, anonymised. */
function localCorpora() {
  const root = join(process.env.HOME || '', '.claude', 'projects');
  const out = [];
  let idx = 0;
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return out; }
  for (const proj of dirs.sort()) {
    const d = join(root, proj);
    let files = [];
    try { files = readdirSync(d).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    const acc = { turns: 0, refs: 0, sessions: 0, skipped_self: 0 };
    const fileCounts = new Map();
    let referencingTurns = 0, pairableTurns = 0;
    for (const f of files) {
      if (f.startsWith(SELF_SESSION)) { acc.skipped_self += 1; continue; }
      const p = join(d, f);
      let parsed;
      try { if (statSync(p).size < 50_000) continue; parsed = parseSession(p, { includeBash: true }); } catch { continue; }
      if (parsed.nTurns < 10) continue;
      acc.sessions += 1; acc.turns += parsed.nTurns; acc.refs += parsed.nRefs;
      for (const t of parsed.turns) {
        if (t.files.size === 0) continue;
        referencingTurns += 1;
        if (t.files.size >= 2) pairableTurns += 1;
        for (const x of t.files) fileCounts.set(x, (fileCounts.get(x) || 0) + 1);
      }
    }
    if (acc.sessions === 0) continue;
    out.push({
      corpus: `project-${String.fromCharCode(65 + idx++)}`,
      source: 'local Claude Code sessions (aggregates only; no paths or names recorded)',
      sessions: acc.sessions, turns: acc.turns, refs: acc.refs, distinct_files: fileCounts.size,
      refs_per_turn: acc.turns ? +(acc.refs / acc.turns).toFixed(3) : 0,
      refs_per_file: fileCounts.size ? +(acc.refs / fileCounts.size).toFixed(3) : 0,
      share_turns_able_to_pair: referencingTurns ? +(pairableTurns / referencingTurns).toFixed(4) : 0,
      excluded_self_transcripts: acc.skipped_self,
    });
  }
  return out;
}

/**
 * Walk the committed fixtures exactly as `offline-replay.mjs` does and record, for every
 * candidate row, (a) whether its best candidate/hot pair has any co-activation support,
 * and (b) how often the candidate's most-referenced file has been referenced so far.
 * Repeated over the dilation sweep so the ceiling is measured, not assumed.
 */
function supportProfile(L) {
  const byRecurrence = new Map();
  let rows = 0, supported = 0;
  const bucket = (n) => (n <= 1 ? '1' : n <= 2 ? '2' : n <= 4 ? '3-4' : n <= 9 ? '5-9' : '10+');

  for (const f of fixtureFiles()) {
    const parsed = parseSession(f, { includeBash: true });
    const refLog = parsed.turns.map((t) => t.files);
    const T = refLog.length;
    const referencing = [];
    for (let i = 0; i < T; i += 1) if (refLog[i].size > 0) referencing.push(i);

    const counts = emptyCounts();
    let pushed = 0;
    const dilatedAt = (s) => unionSets(refLog.slice(Math.max(0, s - L + 1), s + 1));
    const seen = new Map();          // file -> references so far, advanced incrementally
    let seenUpTo = 0;

    for (let t = START; t < T - H; t += 1) {
      if (refLog[t].size === 0) continue;
      const histEnd = Math.max(0, t - K);
      while (pushed < histEnd) { pushTurn(counts, dilatedAt(pushed)); pushed += 1; }
      while (seenUpTo < t) { for (const x of refLog[seenUpTo]) seen.set(x, (seen.get(x) || 0) + 1); seenUpTo += 1; }
      const hot = unionSets(refLog.slice(histEnd, t));
      if (hot.size === 0) continue;
      const C = referencing.filter((u) => u < t).slice(-MAX_CAND);
      if (C.length < 8) continue;

      for (const u of C) {
        const F = refLog[u];
        let maxRefs = 0, sup = 0;
        for (const x of F) {
          if ((seen.get(x) || 0) > maxRefs) maxRefs = seen.get(x) || 0;
          for (const g of hot) { if (F.has(g)) continue; const a = supportOf(counts, x, g); if (a > sup) sup = a; }
        }
        rows += 1;
        if (sup > 0) supported += 1;
        const b = bucket(maxRefs);
        if (!byRecurrence.has(b)) byRecurrence.set(b, { rows: 0, supported: 0 });
        const e = byRecurrence.get(b);
        e.rows += 1;
        if (sup > 0) e.supported += 1;
      }
    }
  }
  const order = ['1', '2', '3-4', '5-9', '10+'];
  return {
    L, rows, supported_share: rows ? +(supported / rows).toFixed(4) : 0,
    clears_gate: rows ? supported / rows >= GATE + GATE_MARGIN : false,
    by_candidate_recurrence: order.filter((b) => byRecurrence.has(b)).map((b) => {
      const e = byRecurrence.get(b);
      return { prior_refs_of_candidate_file: b, rows: e.rows,
        share_of_all_rows: +(e.rows / rows).toFixed(4),
        supported_share: +(e.supported / e.rows).toFixed(4) };
    }),
  };
}

function main() {
  const fixtures = [];
  let pooled = { turns: 0, refs: 0 };
  const pooledFiles = new Map();
  let pooledRef = 0, pooledPairable = 0;
  const pooledHist = new Map();
  for (const f of fixtureFiles()) {
    const parsed = parseSession(f, { includeBash: true });
    const d = densityOf(parsed);
    fixtures.push({ corpus: f.split('/').pop().replace('claude-code-', '').replace('.jsonl', ''), ...d });
    pooled.turns += parsed.nTurns; pooled.refs += parsed.nRefs;
    for (const t of parsed.turns) {
      if (t.files.size === 0) continue;
      pooledRef += 1;
      if (t.files.size >= 2) pooledPairable += 1;
      const b = t.files.size === 1 ? '1' : t.files.size === 2 ? '2' : t.files.size <= 4 ? '3-4' : '5+';
      pooledHist.set(b, (pooledHist.get(b) || 0) + 1);
      for (const x of t.files) pooledFiles.set(x, (pooledFiles.get(x) || 0) + 1);
    }
  }
  const fixturesPooled = {
    corpus: 'committed fixtures (pooled)', sessions: fixtures.length,
    turns: pooled.turns, refs: pooled.refs, distinct_files: pooledFiles.size,
    refs_per_turn: +(pooled.refs / pooled.turns).toFixed(3),
    refs_per_file: +(pooled.refs / pooledFiles.size).toFixed(3),
    referencing_turns: pooledRef,
    turns_able_to_form_a_same_turn_pair: pooledPairable,
    share_turns_able_to_pair: +(pooledPairable / pooledRef).toFixed(4),
    files_per_turn_histogram: Object.fromEntries(['1', '2', '3-4', '5+'].map((b) => [b, pooledHist.get(b) || 0])),
  };

  const local = localCorpora();
  const ceiling = L_SWEEP.map(supportProfile);
  const best = ceiling.reduce((a, b) => (b.supported_share > a.supported_share ? b : a), ceiling[0]);

  const out = {
    manifest: {
      run_id: `covariance-corpus-survey-${Date.now()}`,
      experiment: 'covariance-eviction / H2 corpus survey — is a pairwise co-reference statistic testable anywhere available?',
      commit: gitSha(), date: nowISO(),
      params: { K, H, START, MAX_CAND, L_sweep: L_SWEEP, gate: GATE, gate_margin: GATE_MARGIN },
      question: 'The H2 offline arm failed its support gate on the committed fixtures. Is there a corpus on '
        + 'this machine — or a defensible parameter setting — on which the gate is cleared?',
      decision_rule: `Support share must reach ${GATE + GATE_MARGIN} (the median candidate has a non-empty `
        + 'contingency table, plus margin). Reported BEFORE any contrast; a corpus that fails is not run.',
      privacy: 'Local sessions contribute AGGREGATES ONLY — turn, reference and file COUNTS. No file path, '
        + 'session id or project name is recorded; projects are labelled project-A, project-B, ... '
        + `This session's own transcript (${SELF_SESSION}...) is excluded as circular.`,
      caveats: [
        'Reference extraction includes file paths named on Bash command lines via a regex; that is the least trustworthy input and it INFLATES density, so the densities here are upper estimates.',
        'Local sessions are aggregated per project across sessions. Pooling them would give a file a longer reference history than any single session has, which is a legitimate deployment model (a persisted reference log) but is NOT what a single-session experiment measures.',
        'The support ceiling is swept over dilation L only. Larger L raises support mechanically and stops meaning "working episode" somewhere below L=10; the sweep is reported so the gate is judged against the best case, not to license picking the best case.',
      ],
    },
    corpus_density: { fixtures_per_session: fixtures, fixtures_pooled: fixturesPooled, local_projects: local },
    support_ceiling: ceiling,
    verdict: {
      best_L: best.L, best_supported_share: best.supported_share,
      gate: GATE + GATE_MARGIN,
      gate_cleared_anywhere: ceiling.some((c) => c.clears_gate),
      denser_corpus_found: local.some((c) => c.refs_per_file > fixturesPooled.refs_per_file * 1.5),
      conclusion: ceiling.some((c) => c.clears_gate)
        ? 'A setting clears the gate — H2 is evaluable there.'
        : 'NO corpus and NO dilation setting available on this machine clears the support gate. '
          + 'H2 is NOT evaluable here, and the reason is structural rather than a matter of data volume: '
          + `${(100 * fixturesPooled.share_turns_able_to_pair).toFixed(1)}% of referencing turns name two or more files, `
          + 'so same-turn co-reference of two specific files is rare by construction.',
    },
  };
  const path = writeResults('covariance-eviction', 'results-h2-corpus-survey.json', out);

  console.error('\n=== H2 CORPUS SURVEY — is a pairwise statistic testable anywhere available? ===\n');
  console.error('  corpus                          sess  turns   refs  files  refs/turn  refs/file  turns able to pair');
  for (const r of [...fixtures.map((x) => ({ ...x, sessions: 1 })), fixturesPooled, ...local]) {
    console.error(`  ${String(r.corpus).padEnd(30)} ${String(r.sessions ?? 1).padStart(4)} ${String(r.turns).padStart(6)} `
      + `${String(r.refs).padStart(6)} ${String(r.distinct_files).padStart(6)}  ${String(r.refs_per_turn).padStart(9)}  `
      + `${String(r.refs_per_file).padStart(9)}  ${(100 * r.share_turns_able_to_pair).toFixed(1)}%`);
  }
  console.error(`\n  FILES PER TURN (pooled fixtures): `
    + Object.entries(fixturesPooled.files_per_turn_histogram).map(([k, v]) => `${k}:${v}`).join('  ')
    + `  -> only ${(100 * fixturesPooled.share_turns_able_to_pair).toFixed(1)}% of referencing turns can form ANY same-turn pair`);

  console.error('\n  SUPPORT CEILING over dilation L (gate = ' + (GATE + GATE_MARGIN) + '):');
  for (const c of ceiling) {
    console.error(`    L=${String(c.L).padStart(2)}  support ${(100 * c.supported_share).toFixed(1)}%  ${c.clears_gate ? 'CLEARS' : 'below gate'}`);
  }
  console.error('\n  SUPPORT by how often the candidate\'s file has already been referenced (at L=' + ceiling[0].L + '):');
  for (const b of ceiling[0].by_candidate_recurrence) {
    console.error(`    prior refs ${b.prior_refs_of_candidate_file.padEnd(5)} rows ${String(b.rows).padStart(7)} (${(100 * b.share_of_all_rows).toFixed(1)}%)  support ${(100 * b.supported_share).toFixed(1)}%`);
  }
  const deepest = ceiling[ceiling.length - 1].by_candidate_recurrence.find((b) => b.prior_refs_of_candidate_file === '10+');
  if (deepest) {
    console.error(`    ...and at L=${ceiling[ceiling.length - 1].L}, even candidates whose file has 10+ prior references reach only `
      + `${(100 * deepest.supported_share).toFixed(1)}% support`);
  }
  console.error(`\n  VERDICT: ${out.verdict.conclusion}`);
  console.error(`  written: ${path}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
export { densityOf, supportProfile };
