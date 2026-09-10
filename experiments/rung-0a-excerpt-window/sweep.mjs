/**
 * ============================================================================
 * EXPERIMENT: Rung 0a — D-a excerpt-window sweep  (offline, zero model calls)
 * ============================================================================
 *
 * Source plan: reports/hypothesis-test-ladder.md §"Rung 0 · 0a".
 * Results go to: reports/metrics/excerpt-window-0a/results.json
 *
 * WHAT THIS TESTS
 * ---------------
 * Defect D-a (hand-off item 1): a correctly RANKED event can be selected by
 * context_search and still not contain the answer, because the fixed-size
 * excerpt window is too narrow and/or anchored at the wrong place. If true, the
 * retrieval UNIT's excerpt is the defect — not the ranking.
 *
 * THE SWEEP
 * ---------
 *   every recovered query
 *     × excerptChars ∈ {500, 1000, 2000, 4000}
 *     × anchor ∈ {first, rarest, matched-line-span}
 *   metric: fraction of queries whose answer_literals appear inside the excerpt,
 *           and the excerpt size (chars / est. tokens) that cost.
 *   'first' and 'rarest' are the SHIPPED excerptAround anchors
 *   (packages/core/src/retrieve/excerpt.ts). 'matched-line-span' is a candidate
 *   repair implemented only here (product ships no experiment code — D20).
 *
 * FALSIFICATION (fixed BEFORE the run, do not renegotiate after):
 *   If the literal-present rate at the SHIPPED setting (excerptChars=1000,
 *   anchor=first) is already ≥ 90%, the excerpt window is not the defect and
 *   hand-off item 1a is closed — SUBJECT to the upper-bound caveat below.
 *
 * HONEST CAVEAT — the recoverable `text` is OPTIMISTIC.
 *   The live path runs excerptAround over renderEvent(fullEvent): a whole tool
 *   output / file read, often tens of KB. That store (eval/ s1 trace) was
 *   deleted at 7d459f9. What survives in git is each question row's inline
 *   `wide_context` — an answer-windowed slice ≤ ~2.1 KB. Excerpting a small,
 *   roughly answer-centred window loses the answer far LESS often than
 *   excerpting a real multi-KB event. So every present-rate here is an UPPER
 *   BOUND on production. Consequence for the falsification: a ≥90% rate here
 *   does NOT close item 1a; only a rate BELOW 90% is conclusive (the defect
 *   reproduces even on optimistic data).
 *
 * DEGENERATE-NULL TRAP (recorded prior failure):
 *   A payload handed empty anchor terms makes every anchor identical, so the
 *   sweep measures nothing yet looks like a clean negative. We derive terms the
 *   way the shipped findRelevantCenter does (extractQueryFingerprints, then a
 *   4+char word fallback) and REPORT, per query, the non-empty-term count and
 *   the term-present-in-text count next to every cell.
 *
 * RERUN
 * -----
 *   node experiments/rung-0a-excerpt-window/sweep.mjs
 *   Requires: packages/core built (pnpm --filter @context-tree/core build) so
 *   dist/retrieve/excerpt.js exists; and `git` (to recover the fixtures from
 *   commit 7d459f9^ if they are not already under the cache dir). No network,
 *   no provider, deterministic — same commit ⇒ byte-identical results.json.
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CACHE = join(HERE, 'fixtures'); // recovered question sets live beside the script
const OUT_DIR = join(REPO, 'reports', 'metrics', 'excerpt-window-0a');
const FIXTURE_COMMIT = '7d459f9^';
const FIXTURE_BASE = 'eval/fixtures/transplant/s1/e1b289c32f40';
const FILES = ['questions.json', 'questions-deep.json', 'questions-overflow.json'];
const CHARS = [500, 1000, 2000, 4000];
const ANCHORS = ['first', 'rarest', 'matched-line-span'];
const SHIPPED = { chars: 1000, anchor: 'first' };

const { excerptAround } = await import(
  join(REPO, 'packages', 'core', 'dist', 'retrieve', 'excerpt.js')
).catch((e) => {
  console.error('Could not import excerptAround. Build core first:\n  pnpm --filter @context-tree/core build\n', e.message);
  process.exit(1);
});

function gitSha() {
  try { return execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim(); }
  catch { return null; }
}

function ensureFixtures() {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  for (const f of FILES) {
    const dst = join(CACHE, f);
    if (existsSync(dst)) continue;
    const stem = f.replace('.json', '');
    const blob = execSync(`git show ${FIXTURE_COMMIT}:${FIXTURE_BASE}/${stem}.json`, { cwd: REPO, maxBuffer: 1 << 24 });
    writeFileSync(dst, blob);
  }
}

// --- Term derivation, replicated verbatim from packages/core/src/retrieve/retriever.ts ---
// extractQueryFingerprints (retriever.ts:801) with the default 'legacy' mode
// (RetrieverDeps.retrievalCenterFingerprintMode ?? 'legacy', retriever.ts:122),
// then the empty-terms word fallback inside findRelevantCenter (retriever.ts:686).
const BACKTICK_Q = /`([^`]+)`/g;
const QUOTED_Q = /['"]([^'"]{3,})['"]/g;
const FILE_PATH_Q = /[\w\-.]+(?:\/[\w\-.]+)+/g;
const CAMEL_Q = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g;
const PASCAL_Q = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;
const UPPER_SNAKE_Q = /\b[A-Z][A-Z0-9_]{3,}\b/g;
const STOP = new Set(['what', 'when', 'where', 'which', 'that', 'this', 'from', 'with', 'they', 'their',
  'there', 'were', 'have', 'been', 'about', 'only', 'also', 'after', 'before', 'into', 'does', 'most',
  'more', 'than', 'then', 'each', 'both', 'such', 'over', 'even', 'same', 'other', 'could', 'would',
  'should', 'will', 'being', 'under', 'the', 'and', 'for', 'not', 'was', 'are', 'but', 'how', 'its']);

function extractQueryFingerprints(query) {
  const seen = new Set(); const out = [];
  const add = (s) => { if (s.length >= 3 && !seen.has(s)) { seen.add(s); out.push(s); } };
  for (const m of query.matchAll(BACKTICK_Q)) add(m[1]);
  for (const m of query.matchAll(QUOTED_Q)) add(m[1]);
  for (const m of query.matchAll(FILE_PATH_Q)) add(m[0]);
  for (const m of query.matchAll(CAMEL_Q)) add(m[0]);
  for (const m of query.matchAll(PASCAL_Q)) add(m[0]);
  for (const m of query.matchAll(UPPER_SNAKE_Q)) add(m[0]);
  return out;
}

function deriveTerms(query) {
  const legacy = extractQueryFingerprints(query);
  if (legacy.length > 0) return { terms: legacy, source: 'fingerprint' };
  const fallback = query.split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()));
  return { terms: fallback, source: fallback.length > 0 ? 'word-fallback' : 'empty' };
}

// --- The third anchor the sweep adds (candidate repair; not in shipped code, D20). ---
// matched-line-span: centre the window on the midpoint of the earliest→latest
// matched-term occurrence, then snap the window start back to a line boundary.
// Falls back to head when no term occurs (matching excerptAround's fallback).
function excerptMatchedLineSpan(text, terms, chars) {
  if (text.length <= chars) return text;
  const lower = text.toLowerCase();
  let lo = -1, hi = -1;
  for (const raw of terms) {
    const term = String(raw).toLowerCase();
    if (!term) continue;
    let idx = lower.indexOf(term);
    while (idx >= 0) {
      if (lo < 0 || idx < lo) lo = idx;
      const endHere = idx + term.length;
      if (endHere > hi) hi = endHere;
      idx = lower.indexOf(term, idx + term.length);
    }
  }
  if (lo < 0) {
    const end = Math.min(text.length, chars);
    return `${text.slice(0, end)}${end < text.length ? '…' : ''}`;
  }
  const center = Math.floor((lo + hi) / 2);
  let start = Math.max(0, center - Math.floor(chars / 2));
  if (start + chars > text.length) start = Math.max(0, text.length - chars);
  const nl = text.lastIndexOf('\n', start);
  if (nl >= 0 && start - nl <= 200) start = nl + 1;
  const end = Math.min(text.length, start + chars);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function excerpt(text, terms, chars, anchor) {
  if (anchor === 'matched-line-span') return excerptMatchedLineSpan(text, terms, chars);
  return excerptAround(text, terms, chars, anchor); // 'first' | 'rarest' — shipped
}

/** De-duped question rows across the three payload-bearing files. */
function loadQueries() {
  const rows = [];
  const seen = new Set();
  const perFile = {};
  for (const f of FILES) {
    const d = JSON.parse(readFileSync(join(CACHE, f), 'utf8'));
    const qs = d.questions ?? [];
    perFile[f] = qs.length;
    for (const q of qs) {
      const key = `${q.id}::${q.wide_context ?? ''}`;
      if (seen.has(key)) continue; // dedupe exact-duplicate rows across deep/overflow
      seen.add(key);
      rows.push({ file: f, ...q });
    }
  }
  return { rows, perFile };
}

/** One query's cells: allPresent/anyPresent/size per (excerptChars × anchor). */
function sweepQuery(q) {
  const text = q.wide_context ?? '';
  const literals = q.answer_literals ?? [];
  const { terms, source } = deriveTerms(q.question ?? '');
  const lowerText = text.toLowerCase();
  const termsInText = terms.filter((t) => lowerText.includes(String(t).toLowerCase()));
  const cells = {};
  for (const chars of CHARS) {
    for (const anchor of ANCHORS) {
      const ex = excerpt(text, terms, chars, anchor);
      cells[`${chars}|${anchor}`] = {
        allPresent: literals.length > 0 && literals.every((l) => ex.includes(l)),
        anyPresent: literals.some((l) => ex.includes(l)),
        excerptChars: ex.length, estTokens: Math.round(ex.length / 4),
      };
    }
  }
  return {
    id: q.id, file: q.file, kind: q.kind, stratum: q.stratum,
    wideContextChars: text.length, literals: literals.length,
    termCount: terms.length, termSource: source, termsInTextCount: termsInText.length,
    terms, cells,
  };
}

/** Present-rate and mean excerpt size for every (excerptChars × anchor) cell. */
function aggregate(perQuery) {
  const agg = {};
  const nQ = perQuery.length;
  for (const chars of CHARS) {
    for (const anchor of ANCHORS) {
      const k = `${chars}|${anchor}`;
      let all = 0, any = 0, sz = 0;
      for (const q of perQuery) {
        const c = q.cells[k];
        if (c.allPresent) all++;
        if (c.anyPresent) any++;
        sz += c.excerptChars;
      }
      agg[k] = {
        allPresentRate: +(all / nQ).toFixed(4), allPresentCount: all,
        anyPresentRate: +(any / nQ).toFixed(4), anyPresentCount: any,
        meanExcerptChars: Math.round(sz / nQ), meanEstTokens: Math.round(sz / nQ / 4),
      };
    }
  }
  return agg;
}

/** Full run record incl. manifest, falsification verdict, corpus stats, cells. */
function buildManifest(perQuery, agg, perFile) {
  const nQ = perQuery.length;
  const shippedKey = `${SHIPPED.chars}|${SHIPPED.anchor}`;
  const shippedRate = agg[shippedKey].allPresentRate;
  return {
    runId: process.env.RUN_ID ?? `excerpt-window-0a-${new Date().toISOString().slice(0, 10)}`,
    armId: 'excerpt-window-sweep@v1',
    rung: '0a',
    hypothesis: 'D-a — excerpt window/anchor loses the answer of a correctly ranked event',
    offline: true, model: null, judge: 'literal-substring-match (answer_literals)',
    window_W: 'N/A — offline excerpt sweep has no prompt window; excerptChars is the swept variable',
    commit: gitSha(),
    fixtureCommit: FIXTURE_COMMIT,
    date: new Date().toISOString(),
    falsification: {
      condition: `allPresentRate at shipped (excerptChars=${SHIPPED.chars}, anchor=${SHIPPED.anchor}) >= 0.90`,
      shippedKey, shippedAllPresentRate: shippedRate,
      met: shippedRate >= 0.90,
      caveat: 'text=wide_context is answer-windowed (<=~2.1KB), so this rate is an UPPER BOUND on production. A rate >=0.90 does NOT close item 1a; only a rate <0.90 is conclusive.',
    },
    corpus: {
      files: perFile, rawRows: Object.values(perFile).reduce((a, b) => a + b, 0),
      dedupedRows: nQ,
      queriesWithNonEmptyTerms: perQuery.filter((q) => q.termCount > 0).length,
      queriesWithTermInText: perQuery.filter((q) => q.termsInTextCount > 0).length,
      wideContextCharsMax: Math.max(...perQuery.map((q) => q.wideContextChars)),
      wideContextCharsMin: Math.min(...perQuery.map((q) => q.wideContextChars)),
    },
    aggregate: agg,
    perQuery,
  };
}

function printSummary(out) {
  const { corpus: c, aggregate: agg, falsification: fx } = out;
  console.log(`corpus: raw=${c.rawRows} deduped=${c.dedupedRows} | non-empty-terms=${c.queriesWithNonEmptyTerms}/${c.dedupedRows} | term-in-text=${c.queriesWithTermInText}/${c.dedupedRows}`);
  console.log(`wide_context chars: min=${c.wideContextCharsMin} max=${c.wideContextCharsMax}`);
  console.log('\nallPresentRate (mean est.tokens) per cell:');
  console.log('chars'.padEnd(7) + ANCHORS.map((a) => a.padStart(22)).join(''));
  for (const chars of CHARS) {
    const cellsStr = ANCHORS.map((anchor) => {
      const cell = agg[`${chars}|${anchor}`];
      return `${(cell.allPresentRate * 100).toFixed(1)}% (${cell.meanEstTokens}t)`.padStart(22);
    }).join('');
    console.log(String(chars).padEnd(7) + cellsStr);
  }
  console.log(`\nSHIPPED cell ${fx.shippedKey}: allPresentRate=${(fx.shippedAllPresentRate * 100).toFixed(1)}%  (falsification >=90%: ${fx.met ? 'MET' : 'NOT MET'})`);
  console.log('NOTE: rate is an UPPER BOUND (answer-windowed text); a MET result does not close item 1a.');
}

function main() {
  ensureFixtures();
  const { rows, perFile } = loadQueries();
  const perQuery = rows.map(sweepQuery);
  const agg = aggregate(perQuery);
  const out = buildManifest(perQuery, agg, perFile);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(out, null, 2));
  printSummary(out);
  console.log(`\nwrote ${join('reports', 'metrics', 'excerpt-window-0a', 'results.json')}`);
}

main();
