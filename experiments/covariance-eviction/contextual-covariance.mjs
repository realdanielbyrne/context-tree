/**
 * H2b — CONTEXTUAL COVARIANCE: does a unit's HISTORICAL co-activation with what the agent
 * is doing right now predict that the unit is about to be needed — and is that a different
 * thing from the unit simply RESEMBLING what the agent is doing right now?
 *
 * WHY THIS EXISTS. H2 keyed covariance on file paths, found that 80% of turns name exactly
 * one file, and concluded that a pairwise co-reference statistic is starved on agent
 * transcripts. The first half of that is a real finding; the second half over-generalised
 * from one keying to covariance as such. Measured on the same transcripts:
 *
 *     keying        features/turn   turns able to form a same-turn pair
 *     files              1.02                14.3%
 *     fingerprints       9.97                94.1%
 *     lexical           53.44                98.8%
 *
 * So `files` is starved and the other two are not. H2b re-poses the hypothesis on a dense
 * keying and, more importantly, on a different relation.
 *
 * THE REFRAME. H2 scored unit-against-unit. H2b scores every resident unit against the
 * CURRENT TURN, which is structurally what attention does:
 *
 *     score(u, t) = agg over f in features(u)\\Q,  g in Q\\features(u)  of  phi_H(f, g)
 *
 * with Q the hot window's features and H the history strictly before it. Read as eviction
 * it answers "what is safe to drop"; read in reverse it answers "what is worth pulling
 * back", which is the admission channel D-EV4 said relevance belongs to. The endpoint here
 * is an EVICTION endpoint (keep-needed recall at a budget); the admission reading is
 * available from the same scores but is NOT what is measured.
 *
 * ⚠️ THE CONTROL THIS EXPERIMENT LIVES OR DIES ON. Relevance-to-recent was already tested
 * as an eviction signal and LOST — D-EV4 weights it ZERO, because a dormant unit does not
 * resemble the recent window and so a relevance rule deletes exactly the unit that is about
 * to return. "Covariance with the current turn" could trivially be that same signal wearing
 * new clothes. Two things separate them here, and both are load-bearing:
 *
 *   1. `relevance` is an ARM, not an afterthought: plain Jaccard overlap between the unit's
 *      features and the hot window's, with NO history whatsoever. The decisive contrast is
 *      tcov vs relevance. Their rank correlation is reported and a relabelling threshold is
 *      pre-registered.
 *   2. The pairing EXCLUDES SHARED FEATURES. Only f in features(u)\\Q pairs with g in
 *      Q\\features(u), so a unit gets no credit at all for features it shares with the hot
 *      window — that is relevance, and it is removed by construction rather than adjusted
 *      for afterwards. `tcov-inclusive` keeps the shared features and is reported as the
 *      sensitivity arm: if only the inclusive form works, the working part IS relevance.
 *
 * THE OTHER FAILURE MODE. With 10-53 dense features per turn, phi can SATURATE: if
 * everything co-occurs with everything, the score is near-constant across units and the arm
 * is inert. This project has shipped exactly that failure once (`__init__` linking every
 * unit to every other). So the saturation diagnostics from H1 are carried over and GATE:
 * the phi distribution, the share of candidates pinned at the per-turn ceiling, and the
 * share of turns on which the score takes <= 2 distinct values.
 *
 * WHAT IS HELD FIXED from the previous experiments, deliberately: the `needed` label is
 * still behavioural and still FILE-based (the agent issued a tool call naming one of the
 * unit's files within H turns), the metric is still keep-needed recall at a budget plus
 * per-turn AUC, the non-monotonic subset is still needed-and-long-idle, intervals are still
 * moving-block bootstraps within session, and the primary budget is pre-specified at M=32.
 * Keeping a FILE label while sweeping to LEXICAL features is not an oversight — it is the
 * least circular pairing available: the signal and the label then share no vocabulary.
 *
 * Offline, CPU only, no model calls.
 *
 * Rerun:
 *   node experiments/covariance-eviction/contextual-covariance.mjs
 *   CT_H2B_SPACES=files,fp,lex CT_H2B_L=3 CT_TAG=v1 node experiments/covariance-eviction/contextual-covariance.mjs
 */
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureFiles, parseSession } from './transcript.mjs';
import {
  emptyCounts, pushTurn, unionSets, contextualCovariance,
  minMax, dispersion, medianOf,
} from './signals.mjs';
import {
  auc, spearman, recallAtBudget, blockBootstrapValues, pairedDeltaValues, meanOf, makeRng,
  holm,
} from './metrics.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

// ── parameters ───────────────────────────────────────────────────────────────
const SPACES = (process.env.CT_H2B_SPACES || 'files,fp,lex').split(',');
const K = +(process.env.CT_H2B_K || 5);          // hot window, API turns
const L = +(process.env.CT_H2B_L || 3);          // episode dilation, API turns
const M_SHRINK = +(process.env.CT_H2B_M || 2);   // low-support shrinkage. PLACEHOLDER.
const AGG = process.env.CT_H2B_AGG || 'max';
const H = +(process.env.CT_H2B_H || 3);          // label horizon
const D_DORMANT = +(process.env.CT_H2B_D || 10);
const START = +(process.env.CT_H2B_START || 20);
const MIN_CAND = +(process.env.CT_H2B_MIN_CAND || 8);
const MAX_CAND = +(process.env.CT_H2B_MAX_CAND || 200);
const BUDGETS = (process.env.CT_H2B_BUDGETS || '16,32,64').split(',').map(Number);
const PRIMARY_M = +(process.env.CT_H2B_PRIMARY || 32);
const BOOT = +(process.env.CT_H2B_BOOT || 400);
const BLOCK = +(process.env.CT_H2B_BLOCK || 10);
/**
 * Dormancy thresholds for the non-monotonic subset. D only changes which rows COUNT as
 * needed, never the scores, so the whole sweep comes free from one pass — and it has to be
 * swept, because D=10 is inherited from an experiment whose "turn" was 2.2x shorter and
 * §8 of the report shows the D=10 subset behaving as though it is not isolating real
 * dormancy (positional recency is its best keeper, which is the opposite of what D-EV4
 * describes).
 */
const D_SWEEP = (process.env.CT_H2B_D_SWEEP || '10,15,20,25,35,50').split(',').map(Number);
const TAG = process.env.CT_TAG || 'v1';
/**
 * Two caps that exist for tractability, both stated rather than hidden.
 * `DF_MAX` drops a feature present in more than this share of a session's turns. Such a
 * feature has a near-degenerate margin and phi already scores it ~0, so dropping it is
 * close to lossless and removes the dominant cost term.
 * `FEAT_CAP` keeps at most this many features per turn, chosen RAREST-FIRST by document
 * frequency — the informative end. Never binds for `files`.
 */
const DF_MAX = +(process.env.CT_H2B_DF_MAX || 0.5);
const FEAT_CAP = +(process.env.CT_H2B_FEAT_CAP || 24);
/** Pre-registered gates. */
const SUPPORT_GATE = 0.55;          // same derivation as H2: median candidate has a non-empty table
const FLATNESS_GATE = 0.50;         // inert if the score is <=2-valued on more than half the turns
const RELABEL_GATE = 0.80;          // |Spearman| vs relevance at or above this = a relabelling

const overlaps = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
const jaccard = (a, b) => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
};

/** Rarest-first feature selection, with document frequency computed over the session. */
function selectFeatures(rawPerTurn) {
  const T = rawPerTurn.length;
  const df = new Map();
  for (const S of rawPerTurn) for (const x of S) df.set(x, (df.get(x) || 0) + 1);
  const kept = [];
  let dropped = 0, capped = 0;
  for (const S of rawPerTurn) {
    const ok = [...S].filter((x) => df.get(x) / T <= DF_MAX);
    dropped += S.size - ok.length;
    if (ok.length > FEAT_CAP) {
      ok.sort((a, b) => df.get(a) - df.get(b));
      capped += 1;
    }
    kept.push(new Set(ok.slice(0, FEAT_CAP)));
  }
  return { kept, dropped_high_df: dropped, turns_capped: capped, vocabulary: df.size };
}

/**
 * Build the per-decision candidate table for ONE session in ONE feature space.
 * Candidates are past turns that referenced at least one FILE (so the label is defined);
 * their FEATURES come from the space under test.
 */
function buildBlocks(parsed, space, rng) {
  const turns = parsed.turns;
  const T = turns.length;
  // `fp-nopath` is the decisive discriminator between two readings of any fp result:
  // "historical co-activation predicts reuse" versus "file paths predict file references".
  // The label is a FILE reference, so path-bearing tokens share the label's vocabulary.
  // Stripping them leaves the identifier classes (camelCase, PascalCase, UPPER_SNAKE,
  // back-quoted symbols) and answers whether the signal survives without that overlap.
  const stripPaths = (S0) => new Set([...S0].filter((x) => !/[/\\]/.test(x) && !/\.[A-Za-z0-9]{1,5}$/.test(x)));
  const rawFeat = turns.map((t) => (
    space === 'files' ? t.files
      : space === 'fp' ? t.fp
        : space === 'fp-nopath' ? stripPaths(t.fp)
          : t.lex));
  const sel = selectFeatures(rawFeat);
  const feat = sel.kept;
  const fileLog = turns.map((t) => t.files);

  const referencing = [];
  for (let i = 0; i < T; i += 1) if (fileLog[i].size > 0) referencing.push(i);

  const counts = emptyCounts();       // dilated history, for phi
  const counts1 = emptyCounts();      // same-turn history, for the un-dilatable support figure
  let pushed = 0;
  const dilatedAt = (s) => unionSets(feat.slice(Math.max(0, s - L + 1), s + 1));

  const blocks = [];
  const phiSample = [];
  for (let t = START; t < T - H; t += 1) {
    if (fileLog[t].size === 0) continue;
    const histEnd = Math.max(0, t - K);
    while (pushed < histEnd) { pushTurn(counts, dilatedAt(pushed)); pushTurn(counts1, feat[pushed]); pushed += 1; }
    const Q = unionSets(feat.slice(histEnd, t));
    if (Q.size === 0) continue;
    const C = referencing.filter((u) => u < t).slice(-MAX_CAND);
    if (C.length < MIN_CAND) continue;
    const future = unionSets(fileLog.slice(t, t + H));

    const rows = C.map((u) => {
      const F = feat[u];
      const Fu = fileLog[u];
      let lastRef = u;
      for (let s = t - 1; s > u; s -= 1) if (overlaps(Fu, fileLog[s])) { lastRef = s; break; }
      return { u, age: t - u, idle: t - lastRef, F, needed: overlaps(Fu, future) };
    });

    // ── the two covariance forms and the relevance control ──────────────────
    const scoreCov = (F, exclude) =>
      contextualCovariance(counts, Q, F, { m: M_SHRINK, agg: AGG, exclude, counts1 });

    for (const r of rows) {
      const ex = scoreCov(r.F, true);
      const inc = scoreCov(r.F, false);
      r.tcovRaw = ex.score; r.support = ex.support; r.support1 = ex.support1; r.pairs = ex.pairs;
      r.tcovIncRaw = inc.score;
      r.relevance = jaccard(r.F, Q);
      if (phiSample.length < 40000 && ex.vals.length) {
        for (const v of ex.vals) { if (rng() < 0.02 && phiSample.length < 40000) phiSample.push(v); }
      }
    }

    const fill = (xs) => { const m = medianOf(xs); return xs.map((x) => (x === null || !Number.isFinite(x) ? m : x)); };
    const nTcov = minMax(fill(rows.map((r) => r.tcovRaw)));
    const nTcovInc = minMax(fill(rows.map((r) => r.tcovIncRaw)));
    const nRel = minMax(rows.map((r) => r.relevance));
    const nAge = minMax(rows.map((r) => -r.age));
    const nIdle = minMax(rows.map((r) => -r.idle));
    const rnd = rows.map(() => rng());
    rows.forEach((r, i) => {
      r.sig = { recency: nAge[i], idle: nIdle[i], relevance: nRel[i], tcov: nTcov[i], tcovInc: nTcovInc[i], random: rnd[i] };
      r.nonMono = r.needed && r.idle > D_DORMANT;
      r.nonMonoAt = Object.fromEntries(D_SWEEP.map((d) => [d, r.needed && r.idle > d]));
    });
    blocks.push({ t, rows, qSize: Q.size });
  }
  return { blocks, featureStats: sel, phiSample };
}

const SCORERS = {
  tcov: (r) => r.sig.tcov,
  'tcov-inclusive': (r) => r.sig.tcovInc,
  relevance: (r) => r.sig.relevance,
  'recency-only': (r) => r.sig.recency,
  'idle-only': (r) => r.sig.idle,
  random: (r) => r.sig.random,
};
const NEEDED_ALL = (r) => r.needed;
const NEEDED_NM = (r) => r.nonMono;
const orderOf = (b, sc) => b.rows.map((r, i) => [sc(r), i]).sort((x, y) => (y[0] - x[0]) || (x[1] - y[1])).map(([, i]) => i);
const posOf = (b, sc) => { const o = orderOf(b, sc); const p = new Array(o.length); o.forEach((i, r) => { p[i] = r; }); return p; };
const recallSeries = (blocks, sc, M, need) =>
  blocks.map((b) => recallAtBudget(b.rows.map((r) => ({ score: sc(r), needed: need(r) })), M));
const aucSeries = (blocks, sc) =>
  blocks.map((b) => auc(b.rows.map(sc), b.rows.map((r) => (r.needed ? 1 : 0))));

function analyseSpace(space, sessions) {
  const rng = makeRng(0xC0FFEE);
  const per = sessions.map((s) => {
    const r = buildBlocks(s.parsed, space, rng);
    return { name: s.name, ...r };
  }).filter((s) => s.blocks.length > 0);
  const pooled = per.flatMap((s) => s.blocks);
  if (pooled.length === 0) return null;
  const bounds = []; { let acc = 0; for (const s of per) { acc += s.blocks.length; bounds.push(acc); } }
  const OPT = { B: BOOT, blockLen: BLOCK };
  const bb = (v, seed) => blockBootstrapValues(v, { ...OPT, seed }, bounds);
  const pd = (a, b, seed) => pairedDeltaValues(a, b, { ...OPT, seed }, bounds);
  const allRows = pooled.flatMap((b) => b.rows);

  // ── VALIDITY, reported before any contrast ──────────────────────────────
  const supported1 = allRows.filter((r) => r.support1 > 0).length;
  const supportedL = allRows.filter((r) => r.support > 0).length;
  const scorable = allRows.filter((r) => r.tcovRaw !== null).length;
  const nonzero = allRows.filter((r) => r.tcovRaw !== null && Math.abs(r.tcovRaw) > 1e-12).length;

  // saturation: per-turn dispersion of the raw score, and how many candidates sit at the ceiling
  const disp = pooled.map((b) => dispersion(b.rows.map((r) => r.tcovRaw)));
  const ceilingShare = pooled.map((b) => {
    const v = b.rows.map((r) => r.sig.tcov);
    const mx = Math.max(...v);
    return mx <= 0 ? null : v.filter((x) => x >= 0.99 * mx).length / v.length;
  });
  const phis = per.flatMap((s) => s.phiSample).sort((a, b) => a - b);
  const q = (p) => (phis.length ? +phis[Math.min(phis.length - 1, Math.round(p * (phis.length - 1)))].toFixed(4) : null);

  const validity = {
    feature_space: space,
    decision_turns: pooled.length,
    candidate_rows: allRows.length,
    label_base_rate: +(allRows.filter((r) => r.needed).length / allRows.length).toFixed(4),
    nonmonotonic_rows: allRows.filter((r) => r.nonMono).length,
    mean_features_per_turn: +meanOf(per.flatMap((s) => s.featureStats.kept.map((x) => x.size))).toFixed(2),
    vocabulary: per.reduce((a, s) => a + s.featureStats.vocabulary, 0),
    features_dropped_high_df: per.reduce((a, s) => a + s.featureStats.dropped_high_df, 0),
    turns_hitting_feature_cap: per.reduce((a, s) => a + s.featureStats.turns_capped, 0),
    mean_pairs_scored_per_candidate: +meanOf(allRows.map((r) => r.pairs)).toFixed(1),
    // SUPPORT — the H2 gate, evaluated on same-turn co-activation so dilation cannot move it
    support_share_same_turn: +(supported1 / allRows.length).toFixed(4),
    support_share_at_L: +(supportedL / allRows.length).toFixed(4),
    support_gate: SUPPORT_GATE,
    support_gate_passed: supported1 / allRows.length >= SUPPORT_GATE,
    scorable_share: +(scorable / allRows.length).toFixed(4),
    nonzero_share: +(nonzero / allRows.length).toFixed(4),
    // SATURATION — the opposite failure. An arm whose score is near-constant is inert.
    phi_quantiles: { p05: q(0.05), p25: q(0.25), p50: q(0.50), p75: q(0.75), p95: q(0.95), n_sampled: phis.length },
    share_phi_abs_ge_0p3: phis.length ? +(phis.filter((x) => Math.abs(x) >= 0.3).length / phis.length).toFixed(4) : null,
    mean_distinct_scores_per_turn: +meanOf(disp.map((d) => d.distinct)).toFixed(2),
    mean_score_cv: +(meanOf(disp.map((d) => d.cv)) ?? 0).toFixed(4),
    share_turns_near_flat: +(disp.filter((d) => d.distinct <= 2).length / disp.length).toFixed(4),
    mean_share_at_per_turn_ceiling: +(meanOf(ceilingShare) ?? 0).toFixed(4),
    flatness_gate: FLATNESS_GATE,
    flatness_gate_passed: (disp.filter((d) => d.distinct <= 2).length / disp.length) <= FLATNESS_GATE,
  };
  validity.interpretable = validity.support_gate_passed && validity.flatness_gate_passed;

  // ── binding share ───────────────────────────────────────────────────────
  const binding = {};
  for (const M of BUDGETS) {
    binding[`M=${M}`] = { binding_share: +(pooled.filter((b) => b.rows.length > M).length / pooled.length).toFixed(4) };
  }

  // ── headline table ──────────────────────────────────────────────────────
  const names = Object.keys(SCORERS);
  const series = {};
  const table = names.map((name) => {
    const sc = SCORERS[name];
    const a = bb(aucSeries(pooled, sc), 101);
    const row = { scorer: name, auc: a.point === null ? null : +a.point.toFixed(4), auc_ci: a.lo === null ? null : [+a.lo.toFixed(4), +a.hi.toFixed(4)] };
    for (const M of BUDGETS) {
      const all = recallSeries(pooled, sc, M, NEEDED_ALL);
      const nm = recallSeries(pooled, sc, M, NEEDED_NM);
      series[`${name}|${M}|all`] = all; series[`${name}|${M}|nm`] = nm;
      const ra = bb(all, 200 + M), rn = bb(nm, 300 + M);
      row[`recall@${M}`] = ra.point === null ? null : +ra.point.toFixed(4);
      row[`recall@${M}_ci`] = ra.lo === null ? null : [+ra.lo.toFixed(4), +ra.hi.toFixed(4)];
      row[`recall@${M}_nonmonotonic`] = rn.point === null ? null : +rn.point.toFixed(4);
      row[`recall@${M}_nonmonotonic_ci`] = rn.lo === null ? null : [+rn.lo.toFixed(4), +rn.hi.toFixed(4)];
    }
    return row;
  });

  // ── contrasts. THE DECISIVE ONE IS tcov vs relevance. ───────────────────
  let contrasts = [];
  const pair = (tn, cn, M, variant, label, primary = false) => {
    const d = pd(series[`${tn}|${M}|${variant}`], series[`${cn}|${M}|${variant}`], 777);
    contrasts.push({
      metric: label, treatment: tn, control: cn, budget: M, is_primary: primary,
      paired_turns: d.n, block_len: d.blockLen, lag1_autocorr: d.lag1 === null ? null : +d.lag1.toFixed(3),
      delta: d.point === null ? null : +d.point.toFixed(4),
      ci95: d.lo === null ? null : [+d.lo.toFixed(4), +d.hi.toFixed(4)],
      excludes_zero: d.lo !== null && (d.lo > 0 || d.hi < 0),
      clears_pre_registered_0p03: d.lo !== null && d.lo > 0.03,
      // a REAL two-sided bootstrap p-value (twice the smaller tail mass of the replicate
      // distribution), so the Holm step-down below is doing arithmetic on something
      p: d.p ?? null,
    });
  };
  for (const M of BUDGETS) {
    pair('tcov', 'relevance', M, 'nm', 'recall_nonmonotonic', M === PRIMARY_M);
    pair('tcov', 'recency-only', M, 'nm', 'recall_nonmonotonic');
    pair('tcov', 'idle-only', M, 'nm', 'recall_nonmonotonic');
    pair('tcov', 'random', M, 'nm', 'recall_nonmonotonic');
    pair('tcov', 'relevance', M, 'all', 'recall');
    pair('tcov-inclusive', 'tcov', M, 'nm', 'recall_nonmonotonic');
  }
  contrasts = holm(contrasts, 0.05, 'p');

  // ── DORMANCY SWEEP: how the ranking changes as the subset deepens ───────
  // Free, because D re-labels rows without touching any score.
  const dormancy = D_SWEEP.map((d) => {
    const need = (r) => r.nonMonoAt[d];
    const rows = allRows.filter(need).length;
    const ser = {};
    for (const name of names) ser[name] = recallSeries(pooled, SCORERS[name], PRIMARY_M, need);
    const rec = Object.fromEntries(names.map((n) => {
      const b = bb(ser[n], 4000 + d);
      return [n, b.point === null ? null : +b.point.toFixed(4)];
    }));
    const contrast = (tn, cn) => {
      const dd = pd(ser[tn], ser[cn], 5000 + d);
      return { delta: dd.point === null ? null : +dd.point.toFixed(4),
        ci95: dd.lo === null ? null : [+dd.lo.toFixed(4), +dd.hi.toFixed(4)],
        excludes_zero: dd.lo !== null && (dd.lo > 0 || dd.hi < 0), turns: dd.n };
    };
    const best = Object.entries(rec).filter(([, v]) => v !== null).sort((a, b2) => b2[1] - a[1])[0];
    return { D: d, needed_rows: rows, budget: PRIMARY_M, recall: rec,
      best_scorer: best ? best[0] : null,
      tcov_vs_relevance: contrast('tcov', 'relevance'),
      tcov_vs_random: contrast('tcov', 'random'),
      tcov_vs_recency: contrast('tcov', 'recency-only'),
      tcov_vs_idle: contrast('tcov', 'idle-only') };
  });

  // ── relabelling check, on the POLICY ORDERING over ALL turns ────────────
  const rankCorr = {};
  for (const a of names) for (const b of names) {
    if (a >= b) continue;
    const rs = pooled.map((blk) => spearman(posOf(blk, SCORERS[a]), posOf(blk, SCORERS[b]))).filter((x) => x !== null);
    rankCorr[`${a} vs ${b}`] = rs.length ? +meanOf(rs).toFixed(4) : null;
  }
  const relabelR = rankCorr['relevance vs tcov'] ?? rankCorr['tcov vs relevance'];
  validity.spearman_tcov_vs_relevance = relabelR;
  validity.relabelling_gate = RELABEL_GATE;
  validity.is_a_relabelling_of_relevance = relabelR !== null && Math.abs(relabelR) >= RELABEL_GATE;

  return { validity, binding, table, contrasts, dormancy_sweep: dormancy, rank_correlation: rankCorr, per_session: per.map((s) => ({ session: s.name, decision_turns: s.blocks.length })) };
}

function main() {
  if (BUDGETS.some((M) => M >= MAX_CAND)) {
    console.error(`REFUSING: a budget >= MAX_CAND=${MAX_CAND} never binds.`);
    process.exit(2);
  }
  const sessions = fixtureFiles().map((f) => ({
    name: basename(f).replace('claude-code-', '').replace('.jsonl', ''),
    parsed: parseSession(f, { includeBash: true, withFingerprints: true, withLexical: true }),
  }));
  console.error(`corpus: ${sessions.map((s) => `${s.name}(${s.parsed.nTurns}t)`).join(' ')}`);

  const results = {};
  for (const space of SPACES) {
    console.error(`\n--- feature space: ${space} ---`);
    const r = analyseSpace(space, sessions);
    if (!r) { console.error('  no usable decisions'); continue; }
    results[space] = r;
    const v = r.validity;
    console.error(`  features/turn ${v.mean_features_per_turn}  vocab ${v.vocabulary}  pairs/candidate ${v.mean_pairs_scored_per_candidate}`);
    console.error(`  SUPPORT same-turn ${(100 * v.support_share_same_turn).toFixed(1)}% (gate ${(100 * SUPPORT_GATE).toFixed(0)}%) -> ${v.support_gate_passed ? 'PASS' : 'FAIL'}`);
    console.error(`  SATURATION distinct/turn ${v.mean_distinct_scores_per_turn}  at-ceiling ${(100 * v.mean_share_at_per_turn_ceiling).toFixed(1)}%  near-flat ${(100 * v.share_turns_near_flat).toFixed(1)}% -> ${v.flatness_gate_passed ? 'PASS' : 'FAIL'}`);
    console.error(`  -> ${v.interpretable ? 'INTERPRETABLE' : 'NOT INTERPRETABLE'}`);
  }

  const out = {
    manifest: {
      run_id: `contextual-covariance-${TAG}-${Date.now()}`,
      experiment: 'covariance-eviction / H2b — contextual covariance (unit vs current turn) across feature spaces',
      commit: gitSha(), date: nowISO(),
      params: { spaces: SPACES, K, L, m: M_SHRINK, agg: AGG, H, D_DORMANT, START, MIN_CAND, MAX_CAND,
        budgets: BUDGETS, primary_budget: PRIMARY_M, bootstrap: BOOT, block_len: BLOCK,
        df_max: DF_MAX, feature_cap: FEAT_CAP,
        gates: { support: SUPPORT_GATE, flatness: FLATNESS_GATE, relabelling: RELABEL_GATE } },
      question: 'Does a resident unit\'s HISTORICAL co-activation with the current turn predict that the unit '
        + 'is about to be needed, and is that different from the unit merely RESEMBLING the current turn?',
      falsification: `H2b is REJECTED if, in every feature space that passes both gates, tcov fails to beat `
        + `RELEVANCE on non-monotonic recall at the pre-specified primary budget M=${PRIMARY_M} with a paired `
        + `95% moving-block interval excluding 0; or if |Spearman(tcov, relevance)| >= ${RELABEL_GATE}, in which `
        + 'case it is the signal D-EV4 already measured as worst, under a new name.',
      endpoint_reading: 'The endpoint is an EVICTION endpoint (keep-needed recall at a budget). The same scores '
        + 'read in reverse give an ADMISSION ranking, which is where D-EV4 said relevance belongs — but admission '
        + 'is NOT measured here and no claim about it follows from these numbers.',
      caveats: [
        'The `needed` label is FILE-based while the feature spaces sweep to lexical tokens. That is deliberate and makes the lexical arm the LEAST circular of the three; the fingerprint arm is the most, since its features and the label share a vocabulary of paths.',
        'Features are capped (rarest-first by document frequency) and high-document-frequency features dropped, for tractability. Both are reported; phi already scores a near-universal feature ~0, so the drop is close to lossless but it is not free.',
        'Candidates are past turns that referenced at least one FILE, so the label is defined. Turns that touched no file are not candidates in any arm.',
        'A feature space can pass the support gate purely because its features are promiscuous. The saturation block is what distinguishes that from a real signal, and both gates must pass.',
        'C0: four transcripts, one repository, one author; the largest supplies most decisions. Per-session decision counts are reported.',
      ],
    },
    by_space: results,
  };
  const path = writeResults('covariance-eviction', `results-contextual-covariance-${TAG}.json`, out);

  // ── console summary ─────────────────────────────────────────────────────
  console.error('\n=== H2b CONTEXTUAL COVARIANCE ===');
  console.error('\n  GATES (reported before any contrast)');
  console.error('  space  feat/turn  support(same-turn)  gate  distinct/turn  at-ceiling  near-flat  gate  VERDICT');
  for (const [s, r] of Object.entries(results)) {
    const v = r.validity;
    console.error(`  ${s.padEnd(6)} ${String(v.mean_features_per_turn).padStart(9)}  ${(100 * v.support_share_same_turn).toFixed(1).padStart(17)}%  `
      + `${(v.support_gate_passed ? 'PASS' : 'FAIL').padEnd(4)}  ${String(v.mean_distinct_scores_per_turn).padStart(13)}  `
      + `${(100 * v.mean_share_at_per_turn_ceiling).toFixed(1).padStart(9)}%  ${(100 * v.share_turns_near_flat).toFixed(1).padStart(8)}%  `
      + `${(v.flatness_gate_passed ? 'PASS' : 'FAIL').padEnd(4)}  ${v.interpretable ? 'INTERPRETABLE' : 'NOT INTERPRETABLE'}`);
  }
  for (const [s, r] of Object.entries(results)) {
    const v = r.validity;
    console.error(`\n  --- ${s} ---  phi quantiles p05..p95: ${[v.phi_quantiles.p05, v.phi_quantiles.p25, v.phi_quantiles.p50, v.phi_quantiles.p75, v.phi_quantiles.p95].join(' / ')}`
      + `  |phi|>=0.3: ${(100 * (v.share_phi_abs_ge_0p3 ?? 0)).toFixed(1)}%`);
    if (!v.interpretable) { console.error('    gates not passed — contrasts withheld from the console'); continue; }
    console.error('    scorer            auc [ci]                 r@32    nonmono@32');
    for (const row of r.table) {
      console.error(`    ${row.scorer.padEnd(16)} ${String(row.auc).padStart(6)} [${row.auc_ci[0]}, ${row.auc_ci[1]}]   ${String(row['recall@32']).padStart(6)}   ${String(row['recall@32_nonmonotonic']).padStart(8)}`);
    }
    console.error(`    RELABELLING CHECK  Spearman(tcov, relevance) = ${v.spearman_tcov_vs_relevance}  (gate ${RELABEL_GATE}) -> ${v.is_a_relabelling_of_relevance ? 'IS A RELABELLING' : 'distinct'}`);
    console.error(`    DORMANCY SWEEP at M=${PRIMARY_M} (D only re-labels rows; scores are unchanged):`);
    console.error('      D   rows   tcov  relev  recncy   idle  random   best        tcov-relev            tcov-random');
    for (const d of r.dormancy_sweep) {
      const f = (c) => `${String(c.delta).padStart(7)} ${JSON.stringify(c.ci95)}${c.excludes_zero ? '*' : ' '}`;
      console.error(`      ${String(d.D).padStart(2)} ${String(d.needed_rows).padStart(6)}  ${String(d.recall.tcov).padStart(5)}  `
        + `${String(d.recall.relevance).padStart(5)}  ${String(d.recall['recency-only']).padStart(6)}  ${String(d.recall['idle-only']).padStart(5)}  `
        + `${String(d.recall.random).padStart(6)}  ${String(d.best_scorer).padEnd(10)}  ${f(d.tcov_vs_relevance)}  ${f(d.tcov_vs_random)}`);
    }
    console.error('    contrasts (moving block, Holm):');
    for (const c of r.contrasts) {
      if (c.metric !== 'recall_nonmonotonic') continue;
      console.error(`      ${c.is_primary ? '*' : ' '}@${String(c.budget).padStart(3)} ${c.treatment.padEnd(15)} - ${c.control.padEnd(13)} = ${String(c.delta).padStart(8)}  ci ${JSON.stringify(c.ci95)} ${c.excludes_zero ? 'EXCLUDES 0' : ''}`);
    }
  }
  console.error(`\n  written: ${path}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
export { buildBlocks, analyseSpace, jaccard, SCORERS };
