/**
 * OFFLINE REPLAY — the GPU-free arm for BOTH covariance hypotheses.
 *
 * WHY OFFLINE FIRST, AND WHY IT IS NOT A CONSOLATION PRIZE. Every live result on this
 * project that varied WHICH context is kept has come back null: selection signal
 * p=0.70, reference-vs-positional recency p=1.000 at n=13, needle position 180/180,
 * eviction cadence p=0.54 once achieved peak is controlled. The gate that would tell
 * us whether the live harness can see selection at all (backlog item 0) ran and was
 * VOIDED — its control arm wrote zero files in 10 of 10 runs, which is a derailed
 * agent, not a performance floor. Spending GPU hours on a fifth "does signal X beat
 * signal Y" live run before that gate resolves would buy a fifth uninterpretable null.
 *
 * So the offline arm carries the falsifiable weight here, on the same corpus and the
 * same metric family the recurrence result was originally won on
 * (`assembler-weighting/report-assembler-weighting.md`): keep-needed recall at a
 * budget, overall and on the NON-MONOTONIC subset (needed AND long-idle), which is the
 * safety-critical case and the one H2 exists for.
 *
 * FOUR THINGS THIS FIXES RELATIVE TO THE EXPERIMENT IT EXTENDS.
 *  1. THE CLOCK. `tier1-idle-predicts-cold.mjs` advanced its turn counter on every
 *     JSONL assistant *line*; a Claude message is split one line per content block, so
 *     645 lines were read as 645 turns where 331 API turns happened (1.95-2.30x across
 *     these fixtures, measured). Every turn-denominated parameter inherits that error.
 *     `transcript.mjs` advances on `message.id` instead.
 *  2. THE LABEL. Ground truth is BEHAVIOURAL — the agent actually issued a tool call
 *     naming one of the unit's files within the next H turns — not identifier overlap.
 *     The original offline win used an identifier-overlap proxy and said so; this is a
 *     strictly less circular label for the same question.
 *  3. THE INTERVAL. Confidence intervals are a MOVING-BLOCK bootstrap over turns,
 *     resampled within sessions. Two levels of dependence have to be handled: candidates
 *     inside one turn share a hot set, a candidate pool and a label horizon (so the unit
 *     is the turn, not the row), and consecutive TURNS are themselves autocorrelated at
 *     lag 1 by +0.42 to +0.51 (so the resample must be blocked, not i.i.d.). An earlier
 *     version of this file got the second half wrong while calling it a block bootstrap,
 *     which made every interval 1.3-1.6x too narrow.
 *  4. THE HELD-OUT SPLIT. The incremental-value test trains on one session and scores
 *     the others, so a signal cannot win by memorising one session's file graph.
 *
 * WHAT IT REPORTS, MAPPED TO THE TWO DESIGNS:
 * ⚠️ ESTIMAND. Every recall number below is MACRO-averaged: the mean of per-turn recall,
 * weighting each decision turn equally. `assembler-weighting.mjs` MICRO-averages
 * (sum hit / sum need), weighting a turn by how many needed units it has. The two
 * disagree on this corpus — sometimes on SIGN — so a number here is NOT comparable with
 * a number in that report. The like-for-like comparison against the published result
 * lives in `replicate-assembler-weighting.mjs`, which reproduces the original's estimand
 * exactly and varies only the turn clock.
 *
 *   H1  ratio sweep over rho = w_edit : w_recurrence (the constant `flex.ts:268`
 *       hardcodes at 2 by summing before normalising), crossed with directed vs
 *       undirected recurrence (the tested form vs the shipped one);
 *       plus the SATURATION diagnostic — how much the shipped undirected
 *       co-occurrence actually varies across a buffer, computed on the promiscuous
 *       identifier fingerprints the shipped path really uses as well as on clean file
 *       paths. A signal that does not vary cannot be ablated, only removed.
 *   H2  TCOV against every incumbent on recall and held-out AUC; the SUPPORT
 *       diagnostic (how many candidate/hot file pairs have any co-activation history
 *       at all — the validity gate); and the Spearman matrix against recency and idle,
 *       which is the pre-registered non-relabelling check.
 *
 * COST: zero model calls, zero GPU. Runs on CPU in about a minute.
 *
 * Rerun:
 *   node experiments/covariance-eviction/offline-replay.mjs
 *   CT_COV_BASH=0 CT_TAG=nobash node experiments/covariance-eviction/offline-replay.mjs
 */
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureFiles, parseSession } from './transcript.mjs';
import {
  emptyCounts, pushTurn, unionSets, scoreAgainstHot, supportOf,
  recurrenceCounts, minMax, dispersion, neutralize, medianOf,
} from './signals.mjs';
import {
  auc, spearman, recallAtBudget, blockBootstrapValues, pairedDeltaValues, meanOf,
  fitLogistic, predictLogit, autocorr, wilson95,
} from './metrics.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

// ── parameters. Every one is either swept below or flagged as a placeholder. ──
// ⚠️ THE TURN-DENOMINATED PARAMETERS ARE NOT "THE SAME AS assembler-weighting".
// They are numerically equal to its constants, but its "turn" is a JSONL parse-line and
// this file's is an API turn — measured inflation 2.1-2.3x on these fixtures. Copying
// the numbers across therefore does NOT preserve the original's intent; it silently
// halves every window. The intent-preserving values are roughly K=2, H=1, D=4, START=9.
// The defaults below are kept at the original's numerals so the two analyses can be
// diffed, and `CT_COV_K/H/D/START` exist so the rescaled configuration can be run —
// DESIGN-H1 §9 reports that the recurrence contrast is sensitive to this choice.
const K = +(process.env.CT_COV_K || 5);            // hot window, in API turns. SWEEP.
const L = +(process.env.CT_COV_L || 3);            // dilation, in API turns. SWEEP. PLACEHOLDER.
const M_SHRINK = +(process.env.CT_COV_M || 2);     // low-support shrinkage. SWEEP. PLACEHOLDER.
const AGG = process.env.CT_COV_AGG || 'max';       // aggregator. SWEEP.
const H = +(process.env.CT_COV_H || 3);            // label horizon, in API turns. SWEEP.
const D_DORMANT = +(process.env.CT_COV_D || 10);   // non-monotonic threshold, in API turns. SWEEP.
const START = +(process.env.CT_COV_START || 20);   // burn-in, in API turns.
const MIN_CAND = +(process.env.CT_COV_MIN_CAND || 8);
/** Buffer depth: an eviction buffer holds a bounded number of units, not the whole
 *  session, so candidates are the most recent MAX_CAND referencing turns. PLACEHOLDER
 *  — it is a proxy for the live buffer depth (~40 units on `longbuild`) and is swept
 *  only coarsely here. */
const MAX_CAND = +(process.env.CT_COV_MAX_CAND || 200);
/** The identifier-fingerprint saturation diagnostic is O(N^2 x |fp|); sampled, not skipped. */
const FP_STRIDE = +(process.env.CT_COV_FP_STRIDE || 20);
const FP_CAND = +(process.env.CT_COV_FP_CAND || 64);
const BUDGETS = (process.env.CT_COV_BUDGETS || '16,32,64').split(',').map(Number);
/** Priority-decay half-life, from `flex.ts` DEFAULT_PRIORITY_HALFLIFE = DEFAULT_ANCHOR = 4. */
const HALFLIFE = +(process.env.CT_COV_HALFLIFE || 4);
/** Moving-block bootstrap block length, in turns. 1 reproduces the (wrong) i.i.d. scheme. */
const BLOCK = +(process.env.CT_COV_BLOCK || 10);
const BOOT = +(process.env.CT_COV_BOOT || 400);
const TAG = process.env.CT_TAG || 'v1';
const INCLUDE_BASH = process.env.CT_COV_BASH !== '0';

const overlaps = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };

/**
 * Build every decision turn's candidate table for one session.
 * A candidate is a PAST TURN that referenced at least one file — units are turns, the
 * same granularity `assembler-weighting` used, so the recall numbers are comparable.
 */
function buildBlocks(parsed, params) {
  const { turns } = parsed;
  const T = turns.length;
  const refLog = turns.map((t) => t.files);
  const referencing = [];
  for (let i = 0; i < T; i += 1) if (turns[i].files.size > 0) referencing.push(i);

  const counts = emptyCounts();           // incremental over dilated history [0, t-K)
  const counts1 = emptyCounts();          // the same history at L=1, for the honest support figure
  let pushed = 0;                          // number of history turns folded in
  const dilatedAt = (s) => unionSets(refLog.slice(Math.max(0, s - params.L + 1), s + 1));

  const blocks = [];
  for (let t = START; t < T - H; t += 1) {
    if (turns[t].files.size === 0) continue;
    const histEnd = Math.max(0, t - K);
    while (pushed < histEnd) { pushTurn(counts, dilatedAt(pushed)); pushTurn(counts1, refLog[pushed]); pushed += 1; }
    const hot = unionSets(refLog.slice(histEnd, t));
    if (hot.size === 0) continue;

    const C = referencing.filter((u) => u < t).slice(-MAX_CAND);
    if (C.length < MIN_CAND) continue;

    // TWO LABEL FAMILIES, reported side by side rather than one chosen silently.
    //  `needed`   BEHAVIOURAL — the agent issued a tool call naming one of this unit's
    //             FILES within the next H turns. Less circular, and the thing an
    //             eviction policy is actually trying not to lose.
    //  `neededFp` IDENTIFIER OVERLAP — the proxy `assembler-weighting` used to win the
    //             recurrence result. Kept because H1 is a claim about THAT result, and a
    //             re-measurement under a different label cannot confirm or refute it.
    //             Note it is the more circular of the two: the recurrence signal is
    //             built from the same fingerprint-overlap relation the label is.
    const future = unionSets(refLog.slice(t, t + H));
    const futureFp = unionSets(turns.slice(t, t + H).map((x) => x.fp));

    const rows = C.map((u) => {
      const F = turns[u].files;
      let lastRef = u;
      for (let s = t - 1; s > u; s -= 1) if (overlaps(F, refLog[s])) { lastRef = s; break; }
      return {
        u,
        age: t - u,
        idle: t - lastRef,
        wrote: turns[u].wrote.size > 0 ? 1 : 0,
        files: F,
        fp: turns[u].fp,
        needed: overlaps(F, future),
        neededFp: overlaps(turns[u].fp, futureFp),
      };
    });

    // ---- signals ----
    const { undirected: recUnd, directed: recDir } = recurrenceCounts(rows.map((r) => r.files));
    // The fingerprint diagnostic is the expensive one (hundreds of promiscuous tokens
    // per unit) and is only needed as a DISPERSION statistic, so it is measured on a
    // strided subsample of decision turns over a shallower buffer. Sampling affects
    // its precision, not its meaning.
    // Sampled (the fingerprint sets are large) and computed over the SAME candidate
    // slice as the file-path row, so the two dispersion rows are like-for-like. An
    // earlier version compared 154 candidates against 59 and read the difference as a
    // property of the fingerprints.
    const doFp = (blocks.length % FP_STRIDE) === 0;
    const fpSlice = rows.slice(-FP_CAND);
    const recUndFp = doFp ? recurrenceCounts(fpSlice.map((r) => r.fp)).undirected : null;
    const recUndFileMatched = doFp ? recurrenceCounts(fpSlice.map((r) => r.files)).undirected : null;
    const tcov = rows.map((r) => scoreAgainstHot(counts, hot, r.files, { m: params.m, agg: params.agg }));
    // support diagnostic: co-activation history behind each candidate's best hot pair
    const support = rows.map((r) => {
      let best = 0;
      for (const f of r.files) for (const g of hot) { if (r.files.has(g)) continue; best = Math.max(best, supportOf(counts, f, g)); }
      return best;
    });
    // The SAME-TURN (L=1) support, reported next to the dilated one. Dilation inflates
    // co-activation mechanically — consecutive L=3 windows share 2/3 of their content —
    // so quoting a support figure without its L is quoting a number the parameter made.
    const support1 = rows.map((r) => {
      let best = 0;
      for (const f of r.files) for (const g of hot) { if (r.files.has(g)) continue; best = Math.max(best, supportOf(counts1, f, g)); }
      return best;
    });

    // TRUE shipped algebra: the raw sum times decay, normalised AFTER — `flex.ts:268`
    // feeding `eviction.ts:79`. Not the same function as `2*minMax(edit) + minMax(rec)`.
    const rawShipped = rows.map((r, i) => ((r.wrote ? 2 : 0) + recUnd[i]) * Math.pow(0.5, Math.max(0, r.idle) / HALFLIFE));
    const nShippedTrue = minMax(rawShipped);

    const nAge = minMax(rows.map((r) => -r.age));       // higher = newer
    const nIdle = minMax(rows.map((r) => -r.idle));     // higher = referenced more recently
    const nRecUnd = minMax(recUnd);
    const nRecDir = minMax(recDir);
    const nEdit = minMax(rows.map((r) => r.wrote));
    const nTcov = minMax(neutralize(tcov));   // same rule the policy path uses

    rows.forEach((r, i) => {
      r.sig = {
        recency: nAge[i],
        idle: nIdle[i],
        recUndirected: nRecUnd[i],
        recDirected: nRecDir[i],
        edit: nEdit[i],
        tcov: nTcov[i],
        shippedTrue: nShippedTrue[i],
      };
      r.shippedRaw = rawShipped[i];
      r.tcovRaw = tcov[i];
      r.support = support[i];
      r.support1 = support1[i];
      r.recUndFile = recUnd[i];
      r.nonMono = r.needed && r.idle > D_DORMANT;
      r.nonMonoFp = r.neededFp && r.idle > D_DORMANT;
    });
    blocks.push({ t, rows, hotSize: hot.size, nCand: rows.length,
      fpRecurrence: recUndFp, fileRecurrenceMatched: recUndFileMatched });
  }
  return blocks;
}

// ── scorers under comparison ────────────────────────────────────────────────
const SCORERS = {
  'recency-only': (r) => r.sig.recency,
  'idle-only': (r) => r.sig.idle,
  'recurrence-undirected': (r) => r.sig.recUndirected,
  'recurrence-directed': (r) => r.sig.recDirected,
  'edit-only': (r) => r.sig.edit,
  // ⚠️ NOT the shipped priority — this is `splitPriority(rho=2)`, the normalise-then-mix
  // form the shipped code cannot express. Kept under its own name because the H1 ratio
  // sweep lives on this form, and renamed so nothing else mistakes it for the incumbent.
  'split-priority-rho2': (r) => 2 * r.sig.edit + r.sig.recUndirected,
  // The ACTUAL shipped algebra: minMax((2*wrote + R_raw) * decay).
  'shipped-priority-true': (r) => r.sig.shippedTrue,
  tcov: (r) => r.sig.tcov,
};

/**
 * Keep-needed recall at budget M. The ranking is always over ALL candidates — the
 * policy does not get to see the subset — and `neededFn` only redefines which kept
 * units count as a hit. That is what makes `NEEDED_NONMONO` the safety-critical
 * number: the same decision, scored on the dormant-return case alone.
 *
 * Everything below is computed as a PER-TURN SERIES first and only then averaged, so
 * the bootstrap resamples turns rather than re-deriving a pooled statistic 400 times.
 * That is the correct resampling unit (candidates inside a turn are not independent)
 * and it is also what makes the sweep finish.
 */
const NEEDED_ALL = (r) => r.needed;
const NEEDED_NONMONO = (r) => r.nonMono;
const NEEDED_FP = (r) => r.neededFp;
const NEEDED_FP_NONMONO = (r) => r.nonMonoFp;

const recallSeries = (blocks, score, M, neededFn) =>
  blocks.map((b) => recallAtBudget(b.rows.map((r) => ({ score: score(r), needed: neededFn(r) })), M));

const aucSeries = (blocks, score) =>
  blocks.map((b) => auc(b.rows.map(score), b.rows.map((r) => (r.needed ? 1 : 0))));

function main() {
  const params = { K, L, m: M_SHRINK, agg: AGG };
  const files = fixtureFiles();
  const sessions = [];
  for (const f of files) {
    const parsed = parseSession(f, { includeBash: INCLUDE_BASH, withFingerprints: true });
    const blocks = buildBlocks(parsed, params);
    if (blocks.length === 0) { console.error(`skip ${basename(f)} — no usable decision turns`); continue; }
    sessions.push({ name: basename(f).replace('claude-code-', '').replace('.jsonl', ''), file: f, parsed, blocks });
    console.error(`${basename(f)}: turns=${parsed.nTurns} refs=${parsed.nRefs} decision-turns=${blocks.length}`);
  }
  if (sessions.length === 0) throw new Error('no usable sessions');
  const pooled = sessions.flatMap((s) => s.blocks);
  const allRows = pooled.flatMap((b) => b.rows);
  // Session boundaries, so the moving-block bootstrap never splices two transcripts.
  const BOUNDS = [];
  { let acc = 0; for (const ss of sessions) { acc += ss.blocks.length; BOUNDS.push(acc); } }
  const BOOTOPTS = { B: BOOT, blockLen: BLOCK };
  const bb = (values, seed) => blockBootstrapValues(values, { ...BOOTOPTS, seed }, BOUNDS);
  const pd = (a, b, seed) => pairedDeltaValues(a, b, { ...BOOTOPTS, seed }, BOUNDS);

  // ---- the cap must BIND for a recall-at-budget contrast to mean anything ----
  const binding = {};
  for (const M of BUDGETS) {
    const share = pooled.filter((b) => b.rows.length > M).length / Math.max(1, pooled.length);
    binding[`M=${M}`] = { binding_share: +share.toFixed(4), refused: M >= MAX_CAND };
  }
  const refusedBudgets = BUDGETS.filter((M) => M >= MAX_CAND);
  if (refusedBudgets.length) {
    console.error(`REFUSING budgets ${refusedBudgets.join(',')}: M >= MAX_CAND=${MAX_CAND} means the cap `
      + 'never binds and every arm scores recall 1.0. Lower CT_COV_BUDGETS or raise CT_COV_MAX_CAND.');
    process.exit(2);
  }

  // ── validity gates ────────────────────────────────────────────────────────
  const nonNull = allRows.filter((r) => r.tcovRaw !== null).length;
  const nonZero = allRows.filter((r) => r.tcovRaw !== null && Math.abs(r.tcovRaw) > 1e-12).length;
  const supported = allRows.filter((r) => r.support > 0).length;
  const supported1 = allRows.filter((r) => r.support1 > 0).length;
  const supportMed = (() => {
    const v = allRows.map((r) => r.support).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  })();
  const validity = {
    decision_turns: pooled.length,
    candidate_rows: allRows.length,
    label_base_rate: +(allRows.filter((r) => r.needed).length / Math.max(1, allRows.length)).toFixed(4),
    nonmonotonic_rows: allRows.filter((r) => r.nonMono).length,
    // "scorable" only means "had at least one eligible pair" — a score of exactly 0
    // counts. The non-zero share is the number that says how often the signal SAYS
    // anything, and it is the one to quote.
    tcov_scorable_share: +(nonNull / Math.max(1, allRows.length)).toFixed(4),
    tcov_nonzero_share: +(nonZero / Math.max(1, allRows.length)).toFixed(4),
    tcov_supported_share_at_L: +(supported / Math.max(1, allRows.length)).toFixed(4),
    // THE HONEST FIGURE. Dilation manufactures co-activation: consecutive L=3 windows
    // share 2/3 of their content, so the dilated share is partly the parameter's doing.
    // The gate is therefore evaluated on SAME-TURN support, which no parameter inflates.
    tcov_supported_share_same_turn: +(supported1 / Math.max(1, allRows.length)).toFixed(4),
    tcov_support_median: supportMed,
    dilation_L: params.L,
    // PRE-REGISTERED, and now with a stated basis rather than a round number. The gate
    // is set so that the MEDIAN candidate has a non-empty 2x2 table: below 50% of rows
    // with any co-activation history, more than half of every contrast is phi fitted on
    // an empty table. A margin is enforced because a point that only just clears is the
    // "gamed by parameters" case the design warns about and nothing else prevents.
    support_gate_min_share: 0.50,
    support_gate_margin: 0.05,
    interpretable_H2: (supported1 / Math.max(1, allRows.length)) >= 0.55,
    support_gate_basis: 'evaluated on SAME-TURN (L=1) support so the dilation parameter cannot move it; '
      + 'threshold 0.50 = the median candidate has a non-empty contingency table, plus a 0.05 margin.',
    support_histogram: (() => {
      const h = { '0': 0, '1': 0, '2': 0, '3-5': 0, '6-10': 0, '11+': 0 };
      for (const r of allRows) {
        const a = r.support;
        h[a === 0 ? '0' : a === 1 ? '1' : a === 2 ? '2' : a <= 5 ? '3-5' : a <= 10 ? '6-10' : '11+'] += 1;
      }
      return h;
    })(),
  };

  // ── H1: can the shipped recurrence term even be ablated? ──────────────────
  const satOf = (vectorsOf) => {
    const per = pooled.map(vectorsOf).filter((v) => v !== null && v !== undefined).map(dispersion);
    if (per.length === 0) return null;
    return {
      sampled_turns: per.length,
      mean_distinct_values_per_turn: +meanOf(per.map((d) => d.distinct)).toFixed(2),
      mean_candidates_per_turn: +meanOf(per.map((d) => d.n)).toFixed(1),
      mean_cv: +(meanOf(per.map((d) => d.cv)) ?? 0).toFixed(4),
      // the collapse metric: share of turns where the term takes <= 2 distinct values,
      // i.e. per-turn min-max normalization leaves it binary or entirely flat
      share_turns_near_flat: +(per.filter((d) => d.distinct <= 2).length / per.length).toFixed(4),
      share_turns_near_flat_ci95: wilson95(per.filter((d) => d.distinct <= 2).length, per.length),
      share_turns_fully_flat: +(per.filter((d) => d.distinct <= 1).length / per.length).toFixed(4),
      share_turns_fully_flat_ci95: wilson95(per.filter((d) => d.distinct <= 1).length, per.length),
    };
  };
  const h1_saturation = {
    // All three rows are computed over the SAME sampled turns and the SAME candidate
    // slice, so they are like-for-like. An earlier version compared a 154-candidate pool
    // against a 59-candidate one and read the difference as a property of the inputs.
    recurrence_on_file_paths_full_pool: satOf((b) => b.rows.map((r) => r.recUndFile)),
    recurrence_on_file_paths_matched_pool: satOf((b) => b.fileRecurrenceMatched),
    recurrence_on_identifier_fingerprints_AS_SHIPPED: satOf((b) => b.fpRecurrence),
    // THE TERM THE SHIPPED CODE ACTUALLY RANKS BY, which no earlier version measured.
    shipped_priority_after_decay_and_normalization: satOf((b) => b.rows.map((r) => r.shippedRaw)),
    note: 'CORRECTED. An earlier note claimed a flat recurrence term is "deleted" by minMaxNormalize. '
      + 'It is not: `eviction.ts:79` normalises the PRODUCT `(2*wrote + coOccurrence) * decay`, not '
      + '`coOccurrence`. With R constant the term does not vanish — it becomes `c * decay`, which for '
      + 'non-writing units is a LIVE ranking signal that would be absent if R were zero. A saturated R '
      + 'CHANGES WHAT THE TERM RANKS BY (it mixes in decay); it does not switch the term off. The row '
      + 'to read for the shipped behaviour is shipped_priority_after_decay_and_normalization.',
    fingerprint_extractor: 'packages/core/src/retrieve/lexical.ts extractFingerprints, transcribed exactly. '
      + 'It matches NEITHER `__init__` NOR `parse_line` (no snake_case rule). The __init__ regression '
      + 'belongs to experiments/coding-harness/lib.mjs:82, a different extractor.',
    input_fidelity_caveat: 'The shipped path feeds extractFingerprints the full rawText + summaryText '
      + 'including tool results; this replay feeds assistant text + 1200 chars of each tool_use input, '
      + 'capped at 400 fingerprints. Fewer, shorter inputs mean FEWER co-occurrences, so this is if '
      + 'anything conservative about saturation — but it is not the shipped input.',
  };

  // ── H1: the ratio sweep the shipped form cannot express ───────────────────
  //
  // ⚠️ THE USEFUL RANGE IS rho IN [0,1], AND THIS IS AN IDENTITY, NOT AN EMPIRICAL
  // FINDING. `sig.edit = minMax(wrote)` over a binary vector is exactly {0,1} and
  // `sig.rec` lies in [0,1], so for any rho > 1 the score `rho*e + r` is LEXICOGRAPHIC
  // in (e, r) and the induced ordering cannot change with rho. rho = 2, 4 and 8 are
  // provably the same arm. The first version of this sweep listed them as separate
  // points and read their identical recall as "saturation"; it is arithmetic.
  // `ordering_identity_vs_rho2` measures it rather than asserting it.
  const RHOS = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, 2];
  const RHO_REF = 2;                                    // the shipped ratio
  const scoreRho = (rho, key) => (r) => rho * r.sig.edit + r.sig[key];
  const orderOf = (b, sc) => b.rows.map((r, i) => [sc(r), i])
    .sort((x, y) => (y[0] - x[0]) || (x[1] - y[1])).map(([, i]) => i);
  const identityVs = (rho, key) => {
    const ref = (b) => orderOf(b, scoreRho(RHO_REF, key));
    let same = 0;
    for (const b of pooled) {
      const a = orderOf(b, scoreRho(rho, key)).join(',');
      if (a === ref(b).join(',')) same += 1;
    }
    return +(same / Math.max(1, pooled.length)).toFixed(4);
  };

  const h1_ratio_sweep = [];
  const h1_ratio_contrasts = [];
  for (const label of ['file-reference', 'identifier-overlap']) {
    const NEED = label === 'file-reference' ? NEEDED_ALL : NEEDED_FP;
    const NEED_NM = label === 'file-reference' ? NEEDED_NONMONO : NEEDED_FP_NONMONO;
    for (const directed of [false, true]) {
      const key = directed ? 'recDirected' : 'recUndirected';
      const refSeries = recallSeries(pooled, scoreRho(RHO_REF, key), 32, NEED);
      for (const rho of RHOS) {
        const sc = scoreRho(rho, key);
        const all = recallSeries(pooled, sc, 32, NEED);
        const r32 = bb(all, 401);
        const rNm = bb(recallSeries(pooled, sc, 32, NEED_NM), 402);
        const ident = identityVs(rho, key);
        h1_ratio_sweep.push({
          label, directed, rho,
          ordering_identity_vs_rho2: ident,
          recall_at_32: r32.point === null ? null : +r32.point.toFixed(4),
          recall_at_32_ci: r32.lo === null ? null : [+r32.lo.toFixed(4), +r32.hi.toFixed(4)],
          recall_at_32_nonmonotonic: rNm.point === null ? null : +rNm.point.toFixed(4),
        });
        // THE CONTRAST THE FALSIFICATION ACTUALLY REQUIRES: paired rho-vs-rho, which the
        // first version pre-registered and then never computed (it reported per-rho
        // marginal CIs, from which no "beats rho=2 by +0.03" statement follows).
        if (rho !== RHO_REF) {
          const d = pd(all, refSeries, 403);
          h1_ratio_contrasts.push({
            label, directed, rho, vs: RHO_REF, budget: 32,
            ordering_identity_vs_rho2: ident,
            delta: d.point === null ? null : +d.point.toFixed(4),
            ci95: d.lo === null ? null : [+d.lo.toFixed(4), +d.hi.toFixed(4)],
            clears_pre_registered_0p03: d.lo !== null && d.lo > 0.03,
            note: ident === 1 ? 'IDENTICAL ARM by construction — not an independent comparison' : null,
          });
        }
      }
    }
  }

  // ── headline table: every scorer, every budget, block-bootstrap CIs ───────
  const names = Object.keys(SCORERS);
  const series = {};      // cached per-turn series, reused by the contrasts below
  const table = names.map((name) => {
    const sc = SCORERS[name];
    const row = { scorer: name };
    const a = bb(aucSeries(pooled, sc), 101);
    row.auc = a.point === null ? null : +a.point.toFixed(4);
    row.auc_ci = a.lo === null ? null : [+a.lo.toFixed(4), +a.hi.toFixed(4)];
    for (const M of BUDGETS) {
      const all = recallSeries(pooled, sc, M, NEEDED_ALL);
      const nm = recallSeries(pooled, sc, M, NEEDED_NONMONO);
      const fpAll = recallSeries(pooled, sc, M, NEEDED_FP);
      series[`${name}|${M}|all`] = all;
      series[`${name}|${M}|nm`] = nm;
      series[`${name}|${M}|fp`] = fpAll;
      const rf = bb(fpAll, 700 + M);
      row[`recall@${M}_identifier_label`] = rf.point === null ? null : +rf.point.toFixed(4);
      const ra = bb(all, 200 + M);
      const rn = bb(nm, 300 + M);
      row[`recall@${M}`] = ra.point === null ? null : +ra.point.toFixed(4);
      row[`recall@${M}_ci`] = ra.lo === null ? null : [+ra.lo.toFixed(4), +ra.hi.toFixed(4)];
      row[`recall@${M}_nonmonotonic`] = rn.point === null ? null : +rn.point.toFixed(4);
      row[`recall@${M}_nonmonotonic_ci`] = rn.lo === null ? null : [+rn.lo.toFixed(4), +rn.hi.toFixed(4)];
      row[`recall@${M}_nonmonotonic_turns`] = rn.n;
    }
    return row;
  });

  // ── pre-registered paired contrasts (turn-paired, so difficulty cancels) ──
  const contrasts = [];
  const pair = (treatment, control, M, variant, label) => {
    const d = pd(series[`${treatment}|${M}|${variant}`], series[`${control}|${M}|${variant}`], 777);
    contrasts.push({
      metric: label, treatment, control, budget: M, paired_turns: d.n,
      block_len: d.blockLen, lag1_autocorr: d.lag1 === null ? null : +d.lag1.toFixed(3),
      binding_share: binding[`M=${M}`].binding_share,
      delta: d.point === null ? null : +d.point.toFixed(4),
      ci95: d.lo === null ? null : [+d.lo.toFixed(4), +d.hi.toFixed(4)],
      excludes_zero: d.lo !== null && (d.lo > 0 || d.hi < 0),
      // the margin `assembler-weighting` pre-registered for "this term earns its weight"
      clears_pre_registered_0p03: d.lo !== null && d.lo > 0.03,
    });
  };
  for (const M of BUDGETS) {
    pair('tcov', 'recency-only', M, 'all', 'recall');
    pair('tcov', 'idle-only', M, 'all', 'recall');
    pair('tcov', 'recency-only', M, 'nm', 'recall_nonmonotonic');
    pair('tcov', 'idle-only', M, 'nm', 'recall_nonmonotonic');
    pair('recurrence-directed', 'recurrence-undirected', M, 'all', 'recall');
    pair('recurrence-undirected', 'shipped-priority-true', M, 'all', 'recall');
    pair('split-priority-rho2', 'shipped-priority-true', M, 'all', 'recall');
    // H1 continuity: under the ORIGINAL identifier-overlap label, does recurrence still
    // beat recency the way `assembler-weighting` reported? If it does not, the finding
    // this hypothesis is about did not survive the corrected turn clock, and the ratio
    // question is moot before it is asked.
    // MACRO-averaged, on a 4-session corpus with a bounded candidate pool — NOT the
    // published comparison. `replicate-assembler-weighting.mjs` is the like-for-like one.
    pair('recurrence-undirected', 'recency-only', M, 'fp', 'recall_identifier_label_MACRO');
    pair('recurrence-directed', 'recency-only', M, 'fp', 'recall_identifier_label_MACRO');
  }

  // ── H2 deployable shape: rank-blend of tcov with positional recency ───────
  // Pure TCOV discards recency, which the record says is PROTECTIVE (D-EV3), so the
  // arm that could actually deploy is the blend. alpha=0 must reproduce recency-only
  // exactly — that identity is the sweep's own floor check, and if it fails the blend
  // is mis-wired rather than merely losing.
  const ALPHAS = [0, 0.1, 0.25, 0.5, 0.75, 1];
  const blendScores = (b, alpha) => {
    const idx = b.rows.map((_, i) => i);
    const posRank = new Map();
    [...idx].sort((x, y) => (b.rows[y].sig.recency - b.rows[x].sig.recency) || (x - y)).forEach((i, r) => posRank.set(i, r));
    const covRank = new Map();
    [...idx].sort((x, y) => (b.rows[y].sig.tcov - b.rows[x].sig.tcov) || (b.rows[y].sig.recency - b.rows[x].sig.recency)).forEach((i, r) => covRank.set(i, r));
    return idx.map((i) => -(alpha * covRank.get(i) + (1 - alpha) * posRank.get(i)));
  };
  const blendSeries = (alpha, M, neededFn) => pooled.map((b) => {
    const sc = blendScores(b, alpha);
    return recallAtBudget(b.rows.map((r, i) => ({ score: sc[i], needed: neededFn(r) })), M);
  });
  const h2_blend_sweep = [];
  const base0 = {};
  for (const M of BUDGETS) {
    base0[`all${M}`] = blendSeries(0, M, NEEDED_ALL);
    base0[`nm${M}`] = blendSeries(0, M, NEEDED_NONMONO);
  }
  for (const alpha of ALPHAS) {
    const row = { alpha };
    for (const M of BUDGETS) {
      const all = blendSeries(alpha, M, NEEDED_ALL);
      const nm = blendSeries(alpha, M, NEEDED_NONMONO);
      const a = bb(all, 500 + M);
      const n = bb(nm, 600 + M);
      row[`recall@${M}`] = a.point === null ? null : +a.point.toFixed(4);
      row[`recall@${M}_nonmonotonic`] = n.point === null ? null : +n.point.toFixed(4);
      // PAIRED against the alpha=0 series with an interval, not a subtraction of two
      // already-rounded point estimates. The first version reported the latter and read
      // a +0.026 difference as clean when it sat well inside its own +/-0.05 half-width.
      if (alpha > 0) {
        const da = pd(all, base0[`all${M}`], 800 + M);
        const dn = pd(nm, base0[`nm${M}`], 900 + M);
        row[`delta_recall@${M}_vs_recency`] = da.point === null ? null : +da.point.toFixed(4);
        row[`delta_recall@${M}_ci`] = da.lo === null ? null : [+da.lo.toFixed(4), +da.hi.toFixed(4)];
        row[`delta_nonmono@${M}_vs_recency`] = dn.point === null ? null : +dn.point.toFixed(4);
        row[`delta_nonmono@${M}_ci`] = dn.lo === null ? null : [+dn.lo.toFixed(4), +dn.hi.toFixed(4)];
        row[`delta_nonmono@${M}_excludes_zero`] = dn.lo !== null && (dn.lo > 0 || dn.hi < 0);
      }
    }
    h2_blend_sweep.push(row);
  }

  // ── non-relabelling check: mean per-turn Spearman against the incumbents ──
  //
  // ⚠️ Computed on the POLICY ORDERING, not on the raw score vector. `spearman` returns
  // null when a score vector has zero variance, so scoring the raw vectors silently
  // DROPPED the 175/1151 turns where tcov is flat — and on exactly those turns the rank
  // function falls back to the recency tie-break, i.e. correlation 1. Excluding them
  // biased the headline downward. Ordering positions are always a permutation, so this
  // version has nothing to drop.
  const rankCorr = {};
  const rankCorrScoreOnly = {};
  for (const a of names) {
    for (const b of names) {
      if (a >= b) continue;
      const posOf = (blk, sc) => { const o = orderOf(blk, sc); const p = new Array(o.length); o.forEach((i, r) => { p[i] = r; }); return p; };
      const rs = pooled.map((blk) => spearman(posOf(blk, SCORERS[a]), posOf(blk, SCORERS[b]))).filter((x) => x !== null);
      rankCorr[`${a} vs ${b}`] = rs.length ? +meanOf(rs).toFixed(4) : null;
      const raw = pooled.map((blk) => spearman(blk.rows.map(SCORERS[a]), blk.rows.map(SCORERS[b]))).filter((x) => x !== null);
      rankCorrScoreOnly[`${a} vs ${b}`] = { value: raw.length ? +meanOf(raw).toFixed(4) : null, turns_used: raw.length, turns_total: pooled.length };
    }
  }

  // ── PER-SESSION contrasts, because pooling is what made an earlier claim wrong ──
  //
  // The non-replication headline ("recurrence loses to recency") was read off the POOLED
  // corpus at M=16. `session-5` alone is 65% of the decision turns and is not one of the
  // two sessions the original result was measured on, and the original's headline budget
  // was M=64. Restricted to the original's own corpus at its own budget the same contrast
  // contains zero. Per-session rows are emitted so that can never be hidden by pooling
  // again, and `original_corpus` names the subset the original claim is about.
  const ORIGINAL_SESSIONS = new Set(['session', 'session-2']);
  const perSession = [];
  for (const ss of sessions) {
    for (const M of BUDGETS) {
      for (const [tn, cn, variant] of [
        ['recurrence-undirected', 'recency-only', 'fp'],
        ['recurrence-directed', 'recency-only', 'fp'],
        ['tcov', 'recency-only', 'nm'],
      ]) {
        const need = variant === 'fp' ? NEEDED_FP : NEEDED_NONMONO;
        const A = recallSeries(ss.blocks, SCORERS[tn], M, need);
        const Bs = recallSeries(ss.blocks, SCORERS[cn], M, need);
        const d = pairedDeltaValues(A, Bs, { ...BOOTOPTS, seed: 555 });
        perSession.push({
          session: ss.name, in_original_corpus: ORIGINAL_SESSIONS.has(ss.name),
          treatment: tn, control: cn, label: variant === 'fp' ? 'identifier-overlap' : 'non-monotonic',
          budget: M, turns: d.n,
          delta: d.point === null ? null : +d.point.toFixed(4),
          ci95: d.lo === null ? null : [+d.lo.toFixed(4), +d.hi.toFixed(4)],
          excludes_zero: d.lo !== null && (d.lo > 0 || d.hi < 0),
        });
      }
    }
  }
  // and the same contrasts restricted to the original two sessions, pooled
  const origBlocks = sessions.filter((x) => ORIGINAL_SESSIONS.has(x.name));
  const origBounds = [];
  { let acc = 0; for (const ss of origBlocks) { acc += ss.blocks.length; origBounds.push(acc); } }
  const origPooled = origBlocks.flatMap((x) => x.blocks);
  const originalCorpus = [];
  for (const M of BUDGETS) {
    for (const tn of ['recurrence-undirected', 'recurrence-directed']) {
      const A = recallSeries(origPooled, SCORERS[tn], M, NEEDED_FP);
      const Bs = recallSeries(origPooled, SCORERS['recency-only'], M, NEEDED_FP);
      const d = pairedDeltaValues(A, Bs, { ...BOOTOPTS, seed: 556 }, origBounds);
      originalCorpus.push({
        sessions: origBlocks.map((x) => x.name), treatment: tn, control: 'recency-only',
        label: 'identifier-overlap', budget: M, turns: d.n,
        delta: d.point === null ? null : +d.point.toFixed(4),
        ci95: d.lo === null ? null : [+d.lo.toFixed(4), +d.hi.toFixed(4)],
        excludes_zero: d.lo !== null && (d.lo > 0 || d.hi < 0),
      });
    }
  }

  // ── cross-session incremental value of tcov, held out ─────────────────────
  const BASE = ['recency', 'idle', 'recUndirected', 'edit'];
  const featOf = (r, keys) => keys.map((k) => r.sig[k]);
  const incremental = [];
  const TRAIN_CAP = +(process.env.CT_COV_TRAIN_CAP || 40000);
  if (sessions.length >= 2) {
    for (const held of sessions) {
      const trainAll = sessions.filter((s) => s !== held).flatMap((s) => s.blocks.flatMap((b) => b.rows));
      if (trainAll.length < 200 || held.blocks.length < 20) continue;
      // Systematic thinning (every n-th row), not random sampling: it keeps the turn
      // composition of the training set and reruns identically.
      const step = Math.max(1, Math.ceil(trainAll.length / TRAIN_CAP));
      const trainRows = trainAll.filter((_, i) => i % step === 0);
      const y = trainRows.map((r) => (r.needed ? 1 : 0));
      const wBase = fitLogistic(trainRows.map((r) => featOf(r, BASE)), y, { iters: 20 });
      const wPlus = fitLogistic(trainRows.map((r) => featOf(r, [...BASE, 'tcov'])), y, { iters: 20 });
      if (!wBase || !wPlus) continue;
      const sBase = aucSeries(held.blocks, (r) => predictLogit(wBase, featOf(r, BASE)));
      const sPlus = aucSeries(held.blocks, (r) => predictLogit(wPlus, featOf(r, [...BASE, 'tcov'])));
      const d = pairedDeltaValues(sPlus, sBase, { ...BOOTOPTS, seed: 999 });
      incremental.push({
        held_out_session: held.name,
        train_rows: trainRows.length, test_turns: held.blocks.length,
        auc_base: +(meanOf(sBase) ?? NaN).toFixed(4),
        auc_plus_tcov: +(meanOf(sPlus) ?? NaN).toFixed(4),
        delta_auc: d.point === null ? null : +d.point.toFixed(4),
        ci95: d.lo === null ? null : [+d.lo.toFixed(4), +d.hi.toFixed(4)],
        excludes_zero: d.lo !== null && d.lo > 0,
        coef_tcov: +wPlus[wPlus.length - 1].toFixed(4),
      });
    }
  }

  const out = {
    manifest: {
      run_id: `covariance-offline-${TAG}-${Date.now()}`,
      experiment: 'covariance-eviction / offline replay (H1 recurrence ablation, H2 temporal covariance)',
      commit: gitSha(), date: nowISO(),
      corpus: sessions.map((s) => ({ session: s.name, turns: s.parsed.nTurns, assistant_lines: s.parsed.nAssistantLines, refs: s.parsed.nRefs, bash_refs: s.parsed.nBashRefs, decision_turns: s.blocks.length })),
      params: { K, L, m: M_SHRINK, agg: AGG, H, D_DORMANT, START, MIN_CAND, MAX_CAND, budgets: BUDGETS, bootstrap: BOOT, include_bash: INCLUDE_BASH },
      estimand: 'MACRO-averaged recall (mean of per-turn recall). assembler-weighting MICRO-averages '
        + '(sum hit / sum need); the two disagree on this corpus, sometimes on sign. Numbers here are NOT '
        + 'comparable with that report — see results-replicate-assembler-weighting.json for the like-for-like run.',
      question: 'H1: does the recurrence half of the shipped priority term carry the offline win it was credited with, and does its hardcoded 2:1 ratio against the edit boost matter? H2: does pairwise temporal co-reference with the currently-hot file set predict which dormant units return, better than positional or reference recency?',
      falsification: 'H1 REJECTED if (a) the shipped undirected recurrence is near-flat on real buffers (share_turns_near_flat > 0.5), which makes the term unablatable rather than mis-weighted, or (b) no rho in the sweep beats the shipped rho=2 by more than the pre-registered +0.03 recall margin. H2 REJECTED if tcov does not beat BOTH recency-only and idle-only on non-monotonic recall by a margin whose 95% turn-block-bootstrap interval excludes 0, at any budget — or if held-out delta-AUC over the 4-signal base set has an interval containing 0.',
      caveats: [
        'OFFLINE SIGNAL VALIDATION ONLY. It tests whether a backward statistic predicts a forward reference; it says nothing about task success or cost. The live arm is `ab-covariance.mjs` and is GATED on backlog item 0 resolving.',
        'OFF-POLICY: the fixtures were produced by a frontier Claude model with a different toolset. The reuse structure of a Qwen-27B run on `longbuild` may differ, and that is exactly the transfer the live arm would test.',
        'The label is "a tool call named one of this unit\'s files within H turns". That is behavioural, but still observational: a unit can be USED without being re-named (the model reasons from what it already read), which biases every signal here in the same direction.',
        'BASH PATH EXTRACTION is a regex over a command string and is the least trustworthy input. Bash is 831 of 1,481 tool calls in this corpus, so excluding it is not neutral either; re-run with CT_COV_BASH=0 for the sensitivity arm.',
        'Candidates are capped at the most recent MAX_CAND referencing turns as a stand-in for a bounded eviction buffer. It is a placeholder, not a fitted value.',
        'These fixtures largely FIT their window — they are not the overflow corpus. The regime this project cares about is one these sessions never entered.',
        'C0 applies in the offline direction too: 4 sessions from one repository and one author, and session-5 alone is 65% of the decision turns — hence the per-session and original-corpus-only breakdowns.',
        'The turn-denominated parameters (K, H, D_DORMANT, START) are numerically the original experiment\'s but are measured on a 2.1-2.3x different clock, so they are NOT its parameters. The contrast is sensitive to them; sweep before quoting.',
        'Recall here is MACRO-averaged (mean of per-turn recall). The published recurrence result is MICRO-averaged. They disagree on sign on this corpus.',
      ],
    },
    validity,
    h1: { saturation: h1_saturation, ratio_sweep: h1_ratio_sweep, ratio_contrasts: h1_ratio_contrasts,
      per_session: perSession, original_corpus_only: originalCorpus },
    binding_share: binding,
    // The gate is stamped ON the H2 payload, not only in a sibling validity block. An
    // earlier version left `h2.contrasts[0]` reading `{delta, ci95, excludes_zero:true}`
    // with nothing on it to stop a later reader quoting it as a finding.
    [validity.interpretable_H2 ? 'h2' : 'h2_UNINTERPRETABLE_INSUFFICIENT_SUPPORT']: {
      interpretable: validity.interpretable_H2,
      gate: validity.interpretable_H2 ? null
        : `same-turn support ${(validity.tcov_supported_share_same_turn * 100).toFixed(1)}% < gate 55% — `
          + 'every contrast below is phi fitted mostly on empty tables. NOT a null.',
      table: table.map((r) => ({ ...r, interpretable: validity.interpretable_H2 })),
      contrasts: contrasts.map((r) => ({ ...r, interpretable: validity.interpretable_H2 })),
      blend_sweep: h2_blend_sweep.map((r) => ({ ...r, interpretable: validity.interpretable_H2 })),
      rank_correlation: rankCorr,
      rank_correlation_score_space_FILTERED: rankCorrScoreOnly,
      incremental_value: incremental.map((r) => ({ ...r, interpretable: validity.interpretable_H2 })),
    },
    sensitivity_note: 'Every H2 parameter (K, L, m, agg) enters block construction, so each sweep point is a separate tagged run: '
      + 'for L in 1 2 3 5; do CT_COV_L=$L CT_TAG=L$L node experiments/covariance-eviction/offline-replay.mjs; done — likewise CT_COV_K, CT_COV_M, CT_COV_AGG. '
      + 'No value in `params` above is a fitted default; DESIGN-H2 states which sweep has to run before any of them is quoted as one.',
  };

  const path = writeResults('covariance-eviction', `results-offline-${TAG}.json`, out);

  // ── console report ────────────────────────────────────────────────────────
  console.error(`\n=== OFFLINE COVARIANCE REPLAY  (K=${K} L=${L} m=${M_SHRINK} agg=${AGG} H=${H} block=${BLOCK}) ===`);
  console.error(`  decision turns ${validity.decision_turns}  candidate rows ${validity.candidate_rows}  `
    + `label base rate ${(validity.label_base_rate * 100).toFixed(1)}%  non-monotonic rows ${validity.nonmonotonic_rows}`);
  console.error('  cap binds: ' + BUDGETS.map((M) => `M=${M} ${(binding[`M=${M}`].binding_share * 100).toFixed(1)}%`).join('  '));
  console.error(`  H2 VALIDITY: tcov scorable ${(validity.tcov_scorable_share * 100).toFixed(1)}%  `
    + `NON-ZERO ${(validity.tcov_nonzero_share * 100).toFixed(1)}%  `
    + `support @L=${L} ${(validity.tcov_supported_share_at_L * 100).toFixed(1)}%  `
    + `SAME-TURN ${(validity.tcov_supported_share_same_turn * 100).toFixed(1)}% (gate 55%)  `
    + `-> ${validity.interpretable_H2 ? 'INTERPRETABLE' : 'INSUFFICIENT SUPPORT — the H2 contrasts are NOT a null'}`);

  console.error('\n  H1 saturation — how much does each candidate term VARY across a buffer?');
  for (const [k, v] of Object.entries(h1_saturation)) {
    if (typeof v !== 'object' || v === null) continue;
    console.error(`    ${k.padEnd(52)} n=${String(v.sampled_turns).padStart(4)}  distinct/turn ${String(v.mean_distinct_values_per_turn).padStart(6)}  `
      + `cv ${String(v.mean_cv).padStart(7)}  flat ${(v.share_turns_fully_flat * 100).toFixed(1)}% ci[${(v.share_turns_fully_flat_ci95[0] * 100).toFixed(1)},${(v.share_turns_fully_flat_ci95[1] * 100).toFixed(1)}]  `
      + `near-flat ${(v.share_turns_near_flat * 100).toFixed(1)}%`);
  }
  const S1_GATE = 0.50;
  const shipRow = h1_saturation.recurrence_on_identifier_fingerprints_AS_SHIPPED;
  console.error(`    -> S1 gate is "near-flat on MORE THAN ${S1_GATE * 100}% of turns": measured `
    + `${(shipRow.share_turns_near_flat * 100).toFixed(1)}% -> ${shipRow.share_turns_near_flat > S1_GATE ? 'S1 FIRES' : 'S1 DID NOT FIRE'}`);

  console.error('\n  H1 ratio sweep  rho = w_edit : w_recurrence  (rho>1 is LEXICOGRAPHIC — identical arms)');
  console.error('    label              dir   rho   ident-vs-rho2   recall@32   nonmono@32');
  for (const r of h1_ratio_sweep) {
    console.error(`    ${r.label.padEnd(18)} ${(r.directed ? 'dir' : 'und').padEnd(4)} ${String(r.rho).padStart(5)}   `
      + `${String(r.ordering_identity_vs_rho2).padStart(13)}   ${String(r.recall_at_32).padStart(9)}   ${String(r.recall_at_32_nonmonotonic).padStart(10)}`);
  }
  console.error('\n  H1 paired rho-vs-rho2 contrasts (the falsification the design requires):');
  for (const c of h1_ratio_contrasts) {
    if (c.ordering_identity_vs_rho2 === 1) continue;    // identical arm, nothing to test
    console.error(`    ${c.label.padEnd(18)} ${(c.directed ? 'dir' : 'und').padEnd(4)} rho=${String(c.rho).padStart(5)}  `
      + `delta=${String(c.delta).padStart(8)}  ci ${JSON.stringify(c.ci95)}  ${c.clears_pre_registered_0p03 ? 'CLEARS +0.03' : ''}`);
  }

  console.error('\n  scorers (moving-block bootstrap, L=' + BLOCK + ' turns, within session):');
  console.error('    scorer                        auc [ci]                 r@32    nonmono@32   r@32(idlabel)');
  for (const r of table) {
    console.error(`    ${r.scorer.padEnd(26)} ${String(r.auc).padStart(6)} [${r.auc_ci[0]}, ${r.auc_ci[1]}]   `
      + `${String(r['recall@32']).padStart(6)}   ${String(r['recall@32_nonmonotonic']).padStart(8)}   ${String(r['recall@32_identifier_label']).padStart(10)}`);
  }

  console.error('\n  pre-registered paired contrasts (turn-paired, moving block):');
  for (const c of contrasts) {
    console.error(`    ${c.metric.padEnd(24)} @${String(c.budget).padStart(3)}  ${c.treatment.padEnd(22)} - ${c.control.padEnd(22)} `
      + `= ${String(c.delta).padStart(8)}  ci ${JSON.stringify(c.ci95)}  ${c.excludes_zero ? 'EXCLUDES 0' : ''} ${c.clears_pre_registered_0p03 ? 'CLEARS +0.03' : ''}`);
  }

  console.error('\n  H1 ON THE ORIGINAL CORPUS ONLY (sessions 1+2, the two the result was measured on):');
  for (const c of originalCorpus) {
    console.error(`    M=${String(c.budget).padStart(3)}  ${c.treatment.padEnd(22)} - recency-only  = ${String(c.delta).padStart(8)}  `
      + `ci ${JSON.stringify(c.ci95)}  ${c.excludes_zero ? 'EXCLUDES 0' : 'CONTAINS 0'}`);
  }

  console.error('\n  H2 blend sweep (alpha=0 is recency-only), paired vs alpha=0 with intervals:');
  console.error('    alpha   r@32   nonmono@32   delta-nonmono@32 [ci]');
  for (const r of h2_blend_sweep) {
    const d = r['delta_nonmono@32_vs_recency'];
    console.error(`    ${String(r.alpha).padStart(5)}  ${String(r['recall@32']).padStart(6)}   ${String(r['recall@32_nonmonotonic']).padStart(10)}   `
      + `${d === undefined ? '        —' : String(d).padStart(8)} ${r['delta_nonmono@32_ci'] ? JSON.stringify(r['delta_nonmono@32_ci']) : ''} ${r['delta_nonmono@32_excludes_zero'] ? 'EXCLUDES 0' : ''}`);
  }

  console.error('\n  non-relabelling check — mean per-turn Spearman on the POLICY ORDERING:');
  for (const [k, v] of Object.entries(rankCorr)) console.error(`    ${k.padEnd(56)} ${v}`);

  if (incremental.length) {
    console.error('\n  held-out incremental value of tcov over {recency, idle, recurrence, edit}:');
    for (const i of incremental) {
      console.error(`    held out ${i.held_out_session.padEnd(10)} auc ${i.auc_base} -> ${i.auc_plus_tcov}  `
        + `delta ${String(i.delta_auc).padStart(8)} ci ${JSON.stringify(i.ci95)} ${i.excludes_zero ? 'EXCLUDES 0' : ''}  coef ${i.coef_tcov}`);
    }
  }
  console.error(`\n  written: ${path}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
export { buildBlocks, SCORERS };
