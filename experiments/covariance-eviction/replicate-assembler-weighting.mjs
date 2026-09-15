/**
 * THE DISAMBIGUATOR — does the recurrence result survive the TURN-CLOCK FIX, holding
 * everything else constant?
 *
 * WHY THIS EXISTS. An earlier version of this experiment reported that the
 * `assembler-weighting` recurrence win "does not replicate", on the strength of a
 * re-measurement that differed from the original in at least six ways at once:
 *
 *   | | original | the re-measurement |
 *   |---|---|---|
 *   | unit | one JSONL parse-line (user OR assistant) | one API turn (grouped by message.id) |
 *   | candidate pool | unbounded (median 281-292) | capped at the last 200 |
 *   | label fingerprints | backticked + lowercased paths, NO snake_case | different regex family |
 *   | text source | included tool_result text as its own unit | assistant text + 1200 chars of tool_use input |
 *   | corpus | sessions 1, 2 | sessions 1, 2, 3, 5 — and session-5 alone is 65% of the turns |
 *   | headline budget | M = 64 | M = 16 was quoted |
 *
 * A contrast that moves six things cannot attribute a change to any one of them, and on
 * the original's own two sessions at its own budget the same contrast turned out to
 * contain zero. So the non-replication was withdrawn and replaced by this: the original
 * harness, its own corpus, its own signals, its own metric, with EXACTLY ONE variable —
 * whether a "turn" is a JSONL line or an API turn.
 *
 * WHY THE CLOCK IS WORTH ONE EXPERIMENT ON ITS OWN. `assembler-weighting/lib.mjs:40`
 * pushes one `turns[]` entry per parsed JSONL line. A Claude assistant message is split
 * across several lines, one per content block, and tool results arrive as their own
 * `user` lines. Measured here, that inflates the clock 2.1-2.3x. Every turn-denominated
 * parameter in the original rides on it: `K_RECENT=5`, `H=3`, `D_DORMANT=10`,
 * `START=20`. If the finding is robust to a 2.3x clock rescale it is a finding about
 * reuse structure; if it is not, it is partly a finding about JSONL formatting.
 *
 * WHAT IS HELD FIXED: the signal definitions, the fingerprint regexes, the text
 * extraction, the `needed` label, the recall-at-M metric and the candidate pool are all
 * the original's, reimplemented here line-for-line from `assembler-weighting/lib.mjs`
 * rather than imported, because the clock change has to reach inside `parse()`.
 *
 * Offline, CPU only, no model calls.
 *
 * Rerun:
 *   node experiments/covariance-eviction/replicate-assembler-weighting.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from '../rung-1-live-probe/lib.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';
import { movingBlockBootstrap, movingBlockBootstrapRatio, meanOf } from './metrics.mjs';

/** The original's parameters, unchanged (`assembler-weighting/lib.mjs:11`). */
const PARAMS = { K_RECENT: 5, H: 3, D_DORMANT: 10, START: 20 };
const M_LIST = [8, 16, 32, 64];
const BOOT = +(process.env.CT_COV_BOOT || 400);
const BLOCK = +(process.env.CT_COV_BLOCK || 10);

const sessionPath = (n) => join(REPO, `packages/cli/test/fixtures/claude-code-session${n === '1' ? '' : '-2'}.jsonl`);

/** The original's fingerprint regexes (`assembler-weighting/lib.mjs:14`), verbatim. */
const RX = {
  path: /[\w-]+(?:\/[\w.-]+)*\.[a-z]{1,5}\b/gi,
  back: /`([^`]+)`/g,
  camel: /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g,
  pascal: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,
  upper: /\b[A-Z][A-Z0-9_]{3,}\b/g,
};
function fingerprint(text) {
  const fp = new Set();
  for (const m of text.matchAll(RX.path)) fp.add(m[0].toLowerCase());
  for (const m of text.matchAll(RX.back)) if (m[1].length >= 3 && m[1].length < 40) fp.add(m[1]);
  for (const rx of [RX.camel, RX.pascal, RX.upper]) for (const m of text.matchAll(rx)) fp.add(m[0]);
  return fp;
}

/** The original's per-line text extraction, verbatim. */
function lineText(e, byId) {
  const arr = Array.isArray(e.message?.content) ? e.message.content : [];
  if (e.type === 'assistant') {
    let text = arr.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    for (const b of arr) {
      if (b.type === 'tool_use') {
        if (b.id) byId[b.id] = b.name;
        text += ` ${(b.input?.file_path || '')} ${JSON.stringify(b.input || {}).slice(0, 800)}`;
      }
    }
    return text;
  }
  const tr = arr.find((b) => b.type === 'tool_result');
  if (tr) {
    let o = tr.content;
    if (Array.isArray(o)) o = o.map((x) => x.text || '').join('');
    return String(o || '').slice(0, 800);
  }
  return (typeof e.message.content === 'string'
    ? e.message.content
    : arr.filter((b) => b.type === 'text').map((b) => b.text).join(' ')).slice(0, 800);
}

/**
 * `clock: 'line'`  — the original: one unit per JSONL line.
 * `clock: 'api'`   — the fix: a unit is one API turn. A new assistant `message.id` opens
 *                    a turn; subsequent assistant lines with the same id, and the
 *                    `user`/tool_result lines that answer it, merge into it. Text is
 *                    concatenated, so the SAME characters reach `fingerprint()` in both
 *                    arms — only their grouping changes.
 */
function parse(path, clock) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const byId = {};
  const units = [];
  let lastId = null;
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const text = lineText(e, byId);
    if (clock === 'line') { units.push(text); continue; }
    const id = e.message?.id;
    const opensTurn = e.type === 'assistant' && id && id !== lastId;
    if (opensTurn) { lastId = id; units.push(text); }
    else if (units.length === 0) units.push(text);
    else units[units.length - 1] += ` ${text}`;
  }
  return units.map((text, i) => ({ i, fp: fingerprint(text) })).filter((t) => t.fp.size > 0 || true);
}

const overlap = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
const upTo = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; } return lo; };

/** The original's per-turn signal build (`assembler-weighting/lib.mjs:51`), verbatim apart from the clock. */
function buildTurnData(path, clock, params = PARAMS) {
  const { K_RECENT, H, D_DORMANT, START } = params;
  const turns = parse(path, clock).filter((t) => t.fp.size > 0 || t.fp.size === 0);
  const T = turns.length;
  const cand = turns.filter((t) => t.fp.size > 0).map((t) => t.i);
  const refs = {};
  for (const u of cand) {
    const r = [];
    for (let j = u + 1; j < T; j += 1) if (overlap(turns[u].fp, turns[j].fp)) r.push(j);
    refs[u] = r;
  }
  const unionRecent = (t) => { const s = new Set(); for (let r = Math.max(0, t - K_RECENT); r < t; r += 1) for (const x of turns[r].fp) s.add(x); return s; };
  const jacc = (a, b) => { let inter = 0; for (const x of a) if (b.has(x)) inter += 1; return inter / (a.size + b.size - inter || 1); };

  const perTurn = [];
  for (let t = START; t < T; t += 1) {
    if (turns[t].fp.size === 0) continue;
    const C = cand.filter((u) => u < t);
    if (C.length < 8) continue;
    const uni = unionRecent(t);
    const raw = C.map((u) => {
      const r = refs[u];
      const nBefore = upTo(r, t);
      const lastRef = nBefore > 0 ? r[nBefore - 1] : u;
      return {
        u, prio: nBefore, dorm: t - lastRef, age: t - u, rel: jacc(turns[u].fp, uni),
        neededH: r.slice(nBefore).some((x) => x < t + H),
        dormant: t - lastRef > D_DORMANT,
      };
    });
    const mm = (key) => { const vs = raw.map((x) => x[key]); const lo = Math.min(...vs), hi = Math.max(...vs); return (v) => (hi > lo ? (v - lo) / (hi - lo) : 0); };
    const nAge = mm('age'), nPrio = mm('prio'), nDorm = mm('dorm'), nRel = mm('rel');
    for (const x of raw) { x.rec = 1 - nAge(x.age); x.relN = nRel(x.rel); x.prioN = nPrio(x.prio); x.refrec = 1 - nDorm(x.dorm); }
    perTurn.push({ t, raw, nCand: C.length });
  }
  return { nUnits: T, nCand: cand.length, perTurn };
}

const ARMS = {
  'recency-only': (x) => x.rec,
  'relevance-only': (x) => x.relN,
  'priority-only': (x) => x.prioN,
  'refrec-only': (x) => x.refrec,
};

/**
 * Per-turn (hit, need) counts at budget M. Both averagings are derived from this:
 *   MICRO (the original's estimand): sum(hit) / sum(need) over all turns.
 *   MACRO: the mean of per-turn hit/need.
 * Keeping the counts rather than the ratio is what lets the replication report the
 * original's number AND the one the rest of this experiment uses, from one pass.
 */
function recallCounts(perTurn, score, M, nonmono = false) {
  return perTurn.map(({ raw }) => {
    const need = raw.filter((x) => x.neededH && (!nonmono || x.dormant));
    if (need.length === 0) return { hit: 0, need: 0, ratio: null };
    const kept = new Set([...raw].sort((a, b) => score(b) - score(a)).slice(0, M).map((x) => x.u));
    const hit = need.filter((x) => kept.has(x.u)).length;
    return { hit, need: need.length, ratio: hit / need.length };
  });
}

function main() {
  const rows = [];
  const contrasts = [];
  for (const sess of ['1', '2']) {
    for (const clock of ['line', 'api']) {
      const d = buildTurnData(sessionPath(sess), clock);
      const medCand = [...d.perTurn.map((p) => p.nCand)].sort((a, b) => a - b)[Math.floor(d.perTurn.length / 2)] ?? null;
      for (const M of M_LIST) {
        const counts = {};
        for (const [name, sc] of Object.entries(ARMS)) {
          counts[name] = recallCounts(d.perTurn, sc, M, false);
          const nm = recallCounts(d.perTurn, sc, M, true);
          const micro = (cs) => { const n = cs.reduce((s, x) => s + x.hit, 0), dd = cs.reduce((s, x) => s + x.need, 0); return dd > 0 ? n / dd : null; };
          rows.push({
            session: sess, clock, arm: name, M,
            units: d.nUnits, eval_turns: d.perTurn.length, median_candidates: medCand,
            recall_micro: +(micro(counts[name]) ?? NaN).toFixed(4),        // the ORIGINAL's estimand
            recall_macro: +(meanOf(counts[name].map((x) => x.ratio)) ?? NaN).toFixed(4),
            nonmono_recall_micro: +(micro(nm) ?? NaN).toFixed(4),
          });
        }
        // THE CONTRAST THE ORIGINAL'S HEADLINE IS: priority-only vs recency-only.
        // `needed` is the SAME set for both arms, so the micro delta is a clean ratio of
        // sums with a shared denominator, and the macro delta is the mean of per-turn
        // differences. Both are bootstrapped over the same blocks.
        const paired = counts['priority-only'].map((x, i) => ({
          num: x.hit - counts['recency-only'][i].hit, need: x.need,
          macro: x.ratio === null ? null : x.ratio - counts['recency-only'][i].ratio,
        }));
        const bMicro = movingBlockBootstrapRatio([paired], (x) => x.num, (x) => x.need, { B: BOOT, seed: 4242, blockLen: BLOCK });
        const bMacro = movingBlockBootstrap([paired.map((x) => x.macro)], { B: BOOT, seed: 4242, blockLen: BLOCK });
        contrasts.push({
          session: sess, clock, M, turns: bMacro.n,
          micro_delta: bMicro.point === null ? null : +bMicro.point.toFixed(4),
          micro_ci95: bMicro.lo === null ? null : [+bMicro.lo.toFixed(4), +bMicro.hi.toFixed(4)],
          micro_clears_0p03: bMicro.lo !== null && bMicro.lo > 0.03,
          macro_delta: bMacro.point === null ? null : +bMacro.point.toFixed(4),
          macro_ci95: bMacro.lo === null ? null : [+bMacro.lo.toFixed(4), +bMacro.hi.toFixed(4)],
          macro_clears_0p03: bMacro.lo !== null && bMacro.lo > 0.03,
        });
      }
    }
  }

  // the one question this file exists to answer, per session and budget
  const clockEffect = [];
  for (const sess of ['1', '2']) {
    for (const M of M_LIST) {
      const L = contrasts.find((c) => c.session === sess && c.clock === 'line' && c.M === M);
      const A = contrasts.find((c) => c.session === sess && c.clock === 'api' && c.M === M);
      clockEffect.push({
        session: sess, M,
        // MICRO is the original's estimand; the verdict is stated on it.
        line_micro: L.micro_delta, line_micro_ci: L.micro_ci95, line_micro_clears: L.micro_clears_0p03,
        api_micro: A.micro_delta, api_micro_ci: A.micro_ci95, api_micro_clears: A.micro_clears_0p03,
        survives_clock_fix: L.micro_clears_0p03 && A.micro_clears_0p03,
        sign_flip_micro: Math.sign(L.micro_delta) !== Math.sign(A.micro_delta),
        // MACRO is reported alongside because the two disagree, sometimes on sign.
        line_macro: L.macro_delta, line_macro_ci: L.macro_ci95,
        api_macro: A.macro_delta, api_macro_ci: A.macro_ci95,
        micro_macro_disagree_on_sign: Math.sign(L.micro_delta) !== Math.sign(L.macro_delta),
      });
    }
  }

  const out = {
    manifest: {
      run_id: `replicate-assembler-weighting-${Date.now()}`,
      experiment: 'covariance-eviction / does the recurrence win survive the turn-clock fix? (one variable)',
      commit: gitSha(), date: nowISO(),
      params: { ...PARAMS, budgets: M_LIST, bootstrap: BOOT, block_len: BLOCK, sessions: ['1', '2'] },
      question: "Holding the original's corpus, signals, fingerprints, text extraction, label and metric "
        + 'fixed, does priority-only still beat recency-only when a "turn" is an API turn rather than a JSONL line?',
      falsification: "The original's pre-registered margin: a signal earns its weight iff it lifts recall over "
        + 'recency-only by >= 0.03. `survives_clock_fix` is true only when that holds under BOTH clocks.',
      caveats: [
        'This is a re-analysis of the SAME two transcripts the original used, not an independent replication. It shares every bias of the identifier-overlap label.',
        "The label is circular by construction: `prio` counts prior fingerprint overlaps and `needed` is a future fingerprint overlap, the same relation on two time windows. That is the original's design, reproduced deliberately so the clock is the only change.",
        'Intervals are moving-block bootstraps over turns (lag-1 autocorrelation is substantial); the original reported point estimates with no interval at all, so a difference from its published numbers may be within noise it never quantified.',
        'The api clock CONCATENATES the text of the lines it merges, so a merged unit has a larger fingerprint set. That is intrinsic to the fix, not a confound to remove: an API turn really does contain all of it.',
      ],
    },
    clock_effect: clockEffect, contrasts, rows,
  };
  const path = writeResults('covariance-eviction', 'results-replicate-assembler-weighting.json', out);

  console.error('\n=== DOES THE RECURRENCE WIN SURVIVE THE TURN-CLOCK FIX? ===');
  console.error('  (original corpus, original signals, original metric; ONE variable: line-clock vs API-turn clock)\n');
  console.error('  MICRO-averaged recall (sum hit / sum need) — the estimand the published result uses');
  console.error('  sess clock  units  evalT  medCand   M   recency  priority  relevance  refrec   nonmono(prio)');
  for (const r of rows.filter((x) => x.arm === 'priority-only')) {
    const g = (a) => rows.find((x) => x.session === r.session && x.clock === r.clock && x.M === r.M && x.arm === a);
    console.error(`  ${r.session}    ${r.clock.padEnd(5)} ${String(r.units).padStart(5)}  ${String(r.eval_turns).padStart(5)}  `
      + `${String(r.median_candidates).padStart(6)}  ${String(r.M).padStart(3)}   ${String(g('recency-only').recall_micro).padStart(6)}  `
      + `${String(r.recall_micro).padStart(8)}  ${String(g('relevance-only').recall_micro).padStart(9)}  ${String(g('refrec-only').recall_micro).padStart(6)}   ${r.nonmono_recall_micro}`);
  }
  console.error('\n  priority-only MINUS recency-only, MICRO (the published estimand), moving-block intervals:');
  console.error('    sess   M   line-clock (original)      api-clock (corrected)      verdict');
  for (const c of clockEffect) {
    const f = (v, ci) => `${String(v).padStart(7)} ${JSON.stringify(ci)}`.padEnd(26);
    console.error(`    ${c.session}    ${String(c.M).padStart(3)}  ${f(c.line_micro, c.line_micro_ci)} ${f(c.api_micro, c.api_micro_ci)} `
      + `${c.survives_clock_fix ? 'SURVIVES THE CLOCK FIX' : c.line_micro_clears ? 'LOST TO THE CLOCK FIX' : 'never cleared +0.03 under either clock'}${c.sign_flip_micro ? ' (SIGN FLIP)' : ''}`);
  }
  console.error('\n  the SAME contrast MACRO-averaged (mean of per-turn recall) — reported because it disagrees:');
  console.error('    sess   M   line-clock                 api-clock                  micro/macro sign disagreement');
  for (const c of clockEffect) {
    const f = (v, ci) => `${String(v).padStart(7)} ${JSON.stringify(ci)}`.padEnd(26);
    console.error(`    ${c.session}    ${String(c.M).padStart(3)}  ${f(c.line_macro, c.line_macro_ci)} ${f(c.api_macro, c.api_macro_ci)} ${c.micro_macro_disagree_on_sign ? 'YES' : 'no'}`);
  }
  console.error(`\n  written: ${path}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
export { buildTurnData, parse, recallCounts };
