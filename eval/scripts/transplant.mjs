#!/usr/bin/env node
/**
 * Loop-9 cross-model context transplant (Design C, `eval/fixtures/transplant/JUDGE-VERDICT.md`).
 *
 * One large-model trace is frozen once, reorganized into a tree once, and then
 * *replayed* to two small-window models that never saw it. The question the
 * design asks is the null hypothesis: does the ORGANIZATION carry recall, or
 * would any compaction of the same bytes do as well? So every arm gets the same
 * frozen substrate, the same question set, the same epoch — and the compaction
 * baseline is pinned to the tree's leaf model, output cap, AND total prompt
 * budget, because a compaction baseline that is cheaper is not a baseline.
 *
 * Forked from `recall-probe.mjs` (Graft 1) minus its synthetic store builders:
 * the store here is read from disk, never built, never re-summarized. What
 * carries over verbatim is the plumbing that matters — `HANDLERS` dispatch
 * against a TaskStore-shaped handle, `TreeRetriever` with no embedder (lexical
 * beam fallback, always), `MeteredProvider` + `InMemoryCostMeter`, and the
 * `buildPrompt`/turn loop shape.
 *
 *   --phase gates          the zero-live-token verification checklist (items 1-14)
 *   --phase prep           literal extraction -> strata -> questions.json
 *   --phase prep-overflow  literals below the WIDEST tested tail's boundary -> questions-overflow.json
 *   --phase run            one (model, W, arm) cell
 *   --phase verdict        MEAN score / tokens / turns per (arm, stratum, model)
 *
 * Hermeticity, restated because it is the whole experiment: `--phase gates` and
 * the offline half of `--phase prep` read only L0, L2, L1 and a local BPE table.
 * The paraphrase batch and every arm are live and gated behind `--allow-live`
 * (prep) or an explicit `--phase run` (arms). Nothing here re-ingests or
 * re-summarizes: `manifest.json` is the freeze line and a store sha mismatch
 * against it is a hard stop, not a warning.
 *
 * Budgets are NOT hand-tuned (D19). They derive from the target window W as
 * fixed fractions, each divided by the measured heuristic->BPE ratio, so the
 * one number a reviewer has to trust is a token count they can recompute
 * offline. `EVAL_LAZY_TOKENS` is exported from that derivation rather than
 * being a constant anyone edits (Graft 6: `eval/src/loop.ts` is not touched).
 *
 * Usage:
 *   node eval/scripts/transplant.mjs --phase gates --scenario s1
 *   node eval/scripts/transplant.mjs --phase prep  --scenario s1 [--allow-live]
 *   node eval/scripts/transplant.mjs --phase run   --scenario s1 --window 16384 \
 *        --arm tree --model qwen/qwen-2.5-72b-instruct --reps 5
 *   TRANSPLANT_SMOKE=1 node eval/scripts/transplant.mjs --phase run --scenario s1
 *   node eval/scripts/transplant.mjs --phase verdict --scenario s1
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnthropicProvider,
  CostCapExceededError,
  DEFAULT_EMBED_MODEL,
  ExactTokenizer,
  FsBlobStore,
  HeuristicTokenizer,
  InMemoryCostMeter,
  JsonlTraceLog,
  MeteredProvider,
  ModelCallError,
  OPENROUTER_BASE_URL,
  OpenRouterProvider,
  TreeRetriever,
  ZoneAssembler,
  addUsage,
  composeRootSummary,
  createEmbeddingClientFromKeys,
  ingest,
  loadApiKeys,
  loadConfig,
  loadDotEnv,
  openStore,
  openTaskStore,
  priceFor,
  renderEvent,
  storePaths,
  systemContract,
  toMessages,
} from '@context-tree/core';
// `renderSummaryBlock` is not on core's public surface (it is an assembler
// internal); the root-keep derivation has to size the block the assembler
// will actually emit, so it is imported from the built module directly.
import { renderSummaryBlock, truncateToTokens } from '../../packages/core/dist/assemble/format.js';
import { ANNOTATE, CONTEXT_FETCH, CONTEXT_PEEK, CONTEXT_SEARCH, HANDLERS, toCallToolResult } from '@context-tree/mcp';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
// Loop-9b item 2 Step 5: `tree-semantic`'s embedder needs a raw client to wrap
// with a usage meter (`createEmbeddingClientFromKeys` accepts an injected
// `client`, same seam `embed-store.mjs` uses) — never printed, never logged.
import OpenAI from 'openai';
import { CONTEXT_TOOL_SCHEMAS } from '../dist/tools.js';
import { exactMatchJudge } from '../dist/scoring.js';

// ── paths ────────────────────────────────────────────────────────────────
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURES = join(REPO, 'eval/fixtures/transplant');

// ── the frozen constants of the experiment ───────────────────────────────
/** Verbatim from the verdict's Step 3. `W` is reported as given, never rounded. */
export const WINDOWS = Object.freeze([16_384, 32_768, 65_536, 98_304, 131_072, 163_840, 200_000, 1_000_000]);
/** Graft 3's portability sweep. 200k is the published 200,000-token class. */
export const NESTING_WINDOWS = Object.freeze([8_192, 16_384, 32_768, 65_536, 200_000]);
/** D19 fractions of W. They sum to 1.00; each is divided by the measured ratio. */
export const FRACTIONS = Object.freeze({ reply: 0.05, zoneA: 0.1, zoneB: 0.2, zoneC: 0.2, lazy: 0.35, slack: 0.1 });
const SLACK_REFLOOR_ABOVE = 1.15;
const SLACK_REFLOORED = 0.15;
const SLACK_MITIGATION = 0.2;
const RATIO_KILL = 1.6;
/** truncate-tail keeps `0.85 W / ratio - reply`; the 0.85 is the verdict's. */
const K_FRACTION = 0.85;

const MODELS = Object.freeze(['qwen/qwen-2.5-72b-instruct', 'openai/gpt-3.5-turbo']);
// glm-5.3-flash is a reasoning model and returned its text outside
// `message.content`, which core maps to '' (openrouter.ts:158) — the empty-
// question incident. DeepSeek's chat flash answers in `content`; still a third
// family relative to the claude summaries and the qwen/openai answerers.
const PARAPHRASE_MODEL = 'deepseek/deepseek-v4-flash';
const COMPACT_MODEL = 'claude-haiku-4-5-20251001';
const COMPACT_MODEL_OR = 'anthropic/claude-haiku-4.5';
const MAX_SUMMARY_TOKENS = 1_024;
const ROOT_KEEP = 40;
const REPS = 5;
const SPANNING_REPS = 3;
const MAX_TURNS = 40;
/**
 * The window share reserved so a reply fits beside the prompt. This is
 * arithmetic on W, not a limit on the model: `FRACTIONS.reply` of the window,
 * with NO absolute clamp. The clamp used to be 800, which dominated every
 * window above 16k and made the derivation decorative — and on a model that
 * reasons before answering, 800 tokens of budget could be spent thinking, so
 * the reply came back empty and was graded a wrong answer.
 */
const CAP_USD_PER_MODEL = 15.0;
/** The step-4 compaction build is a THIRD bucket, not part of an answerer's cell. */
const CAP_USD_COMPACTION = 1.0;
/** Above this share of skipped chunks the baseline is degraded, and says so. */
const MAX_SKIPPED_CHUNK_FRACTION = 0.25;
const CAP_USD_TOTAL = 30.0;
/**
 * Per-message chat-format overhead the raw text count cannot see (role tags and
 * separators) plus the reply priming, and a flat margin on top. Deliberately
 * generous: the cost of over-reserving is a slightly shorter tool result, and
 * the cost of under-reserving is an HTTP 400 that voids the run.
 */
const MESSAGE_OVERHEAD_TOKENS = 4;
const REQUEST_PRIMING_TOKENS = 8;
const REQUEST_MARGIN_TOKENS = 64;
/** Safe upper bound on chars-per-token for the pre-cut; see `capToolResult`. */
const CHARS_PER_TOKEN_CEILING = 8;
const SMOKE_N = 3;

const PRIMARY_STRATA = Object.freeze(['head', 'tail', 'deep']);
const EXPLORATORY_STRATA = Object.freeze(['spanning']);
const Q_PER_STRATUM = 3;
/** Candidates drawn per stratum, so a rejected literal has a replacement. */
const POOL_DEPTH = 12;
/** Paraphrase attempts per literal before the literal itself is discarded. */
const PARAPHRASE_ATTEMPTS = 2;
/**
 * How deep in `context_search`'s own ranking a question's source must appear
 * for the question to count as answerable-by-retrieval.
 *
 * DERIVED, not chosen: it is the handler's own result limit, `retrieval.limit`
 * from the loaded config. That is the list the model actually receives, so it
 * is the only bound at which "the search CAN surface the source" is a claim
 * about this experiment rather than about a number someone picked. A tighter
 * constant (Graft 4 proposed 5) fails 9 of 12 questions while the model would
 * have seen all of them, so it does not measure answerability — it measures
 * the constant. A looser one is unreachable.
 *
 * The vacuity that graft was aimed at is real but is a REPORTING problem: when
 * the ranked candidate pool is no larger than the limit, passing proves
 * nothing. So the gate reports the pool size, marks itself `vacuous` when the
 * pool does not exceed the limit, and prints the strict top-3 and top-5 counts
 * as diagnostics. Ranks are recorded per question either way, which is what
 * the rank-versus-score correlation actually needs.
 */
function selfRetrievalTopK(scenario) {
  const limit = scenario.config?.retrieval?.limit;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw new Error(`retrieval.limit must be a positive number to derive the g15 threshold, got ${String(limit)}`);
  }
  return limit;
}
/** Reported alongside the derived threshold, never used to pass or fail. */
const SELF_RETRIEVAL_STRICT_KS = Object.freeze([3, 5]);
/** A literal with less surrounding prose than this cannot be paraphrased into a question. */
const MIN_CONTEXT_CHARS = 200;
/** Floors for a usable question — see `questionTextValid`. */
const MIN_QUESTION_CHARS = 20;
const MIN_QUESTION_WORDS = 4;
const CONTEXT_WINDOW_CHARS = 600;
/**
 * What the PARAPHRASER sees — the containing event rendered whole, capped.
 * A 200-char window gives it nothing to anchor on, which is how "how many
 * characters were omitted when it was truncated" got written about a trace
 * holding hundreds of truncations. An anchor needs neighbours to name.
 */
const WIDE_CONTEXT_CHARS = 750;

export const ARM_IDS = Object.freeze([
  'naive-full',
  'truncate-tail',
  'compact-rolling',
  'tree',
  'tree-wide',
  'tree-static',
  'memgpt',
  // Loop-9b item 2 (`eval/plans/loop9b-item2-judge-verdict.md` §4 Step 6). Each
  // isolates ONE variable against `tree`; none combine this loop. See the
  // wiring table at `handlersForArm` below.
  'tree-slice',
  'tree-thin',
  'tree-verbatim',
  'tree-semantic',
  // DS-STAR iter 2: grep raw event blobs for the query, then fetch raw events.
  // Summaries locate the branch (beam/vector search); this arm tests whether
  // raw-content search does better — the "two-stage" candidate.
  'tree-grep',
  // DS-STAR retrieval pass §7 item 1: tree prompt + raw recent events filling
  // the remaining headroom. The ONE variable vs `tree`: raw tail events in the
  // prompt. Same handlers, same contract, same rootKeep.
  'tree-tail-v2',
  // DS-STAR iter 2: tree-tail without tools. Eliminates stall failure mode
  // while keeping Zone B summaries as passive context alongside raw events.
  'tree-tail-static',
  // DS-STAR iter 3: tree-tail with headline-only Zone B (first sentence + metadata
  // pointers, ~80% smaller). Tests episodic-index hypothesis: summaries as topic
  // markers, not content paraphrases. No tools.
  'tree-tail-headline',
  // The ceiling probe. Identical to `tree-tail-v2` except `context_search`
  // returns the question's OWN source branch as the top hit — retrieval made
  // perfect by fiat. It answers the one question that decides whether ranking
  // and truncation work is worth doing at all: given the right branch, handed
  // over on the first call, does the model produce the right answer? A score
  // here is the ceiling every real retrieval path is working toward; a zero
  // here means the bottleneck is downstream of retrieval and no amount of
  // search or narrowing work can pay off. NEVER a scored arm — it cheats by
  // construction, and its number is a diagnostic, not a result.
  'tree-oracle',
  // The oracle showed ranking is the binding constraint: handed the right
  // branch, the model answers at roughly the full-context rate; left to its own
  // search it thrashes — reformulating a near-identical query and being handed
  // back a near-identical list, five to eight turns of it. This arm changes ONE
  // thing against `tree-tail-v2`: a repeated search inside one run returns the
  // NEXT group of unseen candidates rather than the same group again, and the
  // group grows to fill the live headroom when there is room for it. Rank is
  // unchanged; what changes is that a second look costs the model new
  // information instead of the same information.
  'tree-escalate',
  // The oracle's residual, traced. On the deep set the ranker puts the right
  // branch at rank 1-2 for four of five questions, and the model fetches it on
  // only 16 of 25 runs. The reason is visible the moment the hit list is
  // rendered: a phase hit carries `title`, `kind` and whatever `meta.files` /
  // `meta.symbols` its summary happened to record, and for the branch that
  // matters those are EMPTY — it reads as `phase/diagnosis "diagnosis"`, a
  // label with no content, sitting above hits that read as `file "loop.ts"`.
  // The ranker scored that branch on 425 extracted fingerprints, `armArgs` and
  // `options` among them, and none of them reach the model. So the model is
  // asked to choose without the evidence the ranking was made from, and it
  // reliably chooses the hit that at least names something.
  //
  // The ONE variable against `tree-tail-v2`: each hit carries the fingerprints
  // of that node which MATCH the query. Ranking, limit, contract, fetch,
  // narrowing and the append cap are untouched.
  //
  // REJECTED 2026-09-03, retained so the negative result stays reproducible.
  // The mechanism fired on 25 of 25 runs (`hitKeywordK` median 16) and changed
  // selection not at all: 18/25 correct branches against the baseline's 18/25,
  // in the same batch. What it did change is effort — 609,073 input tokens
  // against 460,389 (+32%), 4 stalls against 2, and on the one question the
  // baseline answered reliably it went from 3 turns and 4/5 to 5-9 turns and
  // 0/5 while still fetching the right branch every time. Extra legible leads
  // are leads the model follows; the diagnosis that the correct hit renders
  // illegibly is sound, and making it legible is not the repair.
  'tree-hit-keywords',
]);

/** Arms whose MEAN enters the primary verdict. `naive-full` is a precondition. */
const SCORED_ARMS = Object.freeze(['truncate-tail', 'compact-rolling', 'tree']);

/** Checklist item ids from the verdict's VERIFICATION CHECKLIST, in order. */
export const GATE_IDS = Object.freeze([
  'g1-trace-sha',
  'g2-hermetic-import',
  'g3-ismeta-skipped',
  'g4-unmapped-tools',
  'g5-rebuild-determinism',
  'g6-native-exceeds-window',
  'g7-bpe-ratio',
  'g8-over-budget',
  'g9-zone-b-nesting',
  'g10-prefix-stability',
  'g11-literal-uniqueness',
  'g12-leakage-gate',
  'g13-manifest-hashed',
  'g14-cost-cap',
  'g15-self-retrieval',
]);

const heuristic = new HeuristicTokenizer();
/** §17's exact tokenizer, behind core's wrapper: a local cl100k table, no API. */
export const exact = new ExactTokenizer('cl100k_base/gpt-tokenizer', (text) => countTokens(text));

// ── small pure helpers ───────────────────────────────────────────────────
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const escapeRe = (s) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What code produced a result file. Two batches of this pass ran hours apart
 * against different working-tree state and nothing in either file discriminates
 * them, so the pre/post labelling of the narrowing fix rests on the author's
 * record rather than on evidence. The git SHA alone is not enough — both ran
 * against UNCOMMITTED state — so the two files that decide retrieval behaviour
 * are hashed directly.
 */
function codeFingerprint() {
  const hashOf = (rel) => {
    const path = join(REPO, rel);
    return existsSync(path) ? sha256File(path).slice(0, 12) : null;
  };
  let git = null;
  try {
    git = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim().slice(0, 12);
  } catch {
    git = null;
  }
  return {
    git,
    retriever: hashOf('packages/core/src/retrieve/retriever.ts'),
    transplant: hashOf('eval/scripts/transplant.mjs'),
  };
}

/** Non-overlapping occurrence count — the strict reading of "exactly once". */
export function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

/**
 * Everything the provider will bill as prompt for one request, in cl100k.
 *
 * `tools` is counted separately and on purpose: the native tool list is NOT in
 * `system`, so a count over system+messages alone understates the request by
 * the whole schema payload. (On this harness the schemas are billed twice —
 * once as Zone A text via `toolSchemasText`, once as the native list — which is
 * the house pattern `recall-probe.mjs` and `eval/src/loop.ts` both use. Left
 * alone here because changing Zone A's bytes is a D5 decision, not a bug fix,
 * but it is real and it is why the 16k tree arm had so little headroom.)
 */
export function requestTokens({ system, messages, tools = [] }, tokenizer = exact) {
  let total = tokenizer.count(system ?? '') + REQUEST_PRIMING_TOKENS;
  for (const message of messages) total += tokenizer.count(message.content) + MESSAGE_OVERHEAD_TOKENS;
  if (tools.length > 0) total += tokenizer.count(JSON.stringify(tools));
  return total;
}

/**
 * Caps one appended tool result to the real headroom left in the window.
 *
 * Zones are budgeted; the DYNAMIC append was not, and that is what produced a
 * 400 on gpt-3.5 (`maximum context length is 16385, requested about 17209`) —
 * a `context_search` result rode on top of a prompt already sized to the
 * window. This budgets it against what is actually left:
 *
 *   headroom = W − tokens(request so far) − maxReplyTokens − margin − prefix
 *
 * Arm-neutral by construction: it lives on the shared append path, so any arm
 * that ever appends a result is covered, not just `tree`. It never touches a
 * zone or a budget — a truncated result is visibly marked (core's elision), so
 * a model that lost detail can see that it did and search again.
 */
/**
 * The headroom one appended tool result has, in the tokenizer the provider
 * bills. Extracted so a handler can narrow to the SAME number this function
 * would cut at: when the retriever's relevance-aware cut is sized by the real
 * remaining space, `capToolResult` finds nothing left to take, and the double
 * truncation — a relevance-centred band re-cut front-first — cannot happen.
 */
export function appendHeadroom({ prefix, system, messages, tools, window, maxReplyTokens }, tokenizer = exact) {
  const spent = requestTokens({ system, messages, tools }, tokenizer);
  return window - spent - maxReplyTokens - REQUEST_MARGIN_TOKENS - tokenizer.count(prefix) - MESSAGE_OVERHEAD_TOKENS;
}

export function capToolResult({ text, prefix, system, messages, tools, window, maxReplyTokens }, tokenizer = exact) {
  const headroom = appendHeadroom({ prefix, system, messages, tools, window, maxReplyTokens }, tokenizer);
  if (headroom <= 0) {
    return { text: '', before: null, after: 0, truncated: null, beforeExact: false, droppedChars: text.length, headroom };
  }
  // Pre-cut by CHARACTERS before any BPE counting. cl100k's merge loop is
  // superlinear in the length of an unbroken run, so counting a payload with
  // one is pathologically slow — measured: 500 KB of varied text counts in
  // 10 ms, 500 KB of a single repeated character takes 84 s. Real tool output
  // is varied, but a `context_fetch` over a minified bundle or a base64 line
  // is not, so this is a live-path guard and not just a fast test.
  //
  // Safe because no token spans fewer than one character: a prefix of
  // `headroom * CHARS_PER_TOKEN_CEILING` chars still holds at least `headroom`
  // tokens, so cutting there first cannot change the answer, only the work.
  const preCut =
    text.length > headroom * CHARS_PER_TOKEN_CEILING ? text.slice(0, headroom * CHARS_PER_TOKEN_CEILING) : text;
  // When a pre-cut happened the original was never counted, so the token figure
  // is a lower bound and says so; the CHARACTER figure is always exact.
  const beforeExact = preCut.length === text.length;
  const before = tokenizer.count(preCut);
  const capped = truncateToTokens(preCut, headroom, tokenizer);
  const after = tokenizer.count(capped);
  return {
    text: capped,
    before,
    after,
    beforeExact,
    truncated: beforeExact ? before - after : null,
    droppedChars: text.length - capped.length,
    headroom,
  };
}

// ── window derivation (D19) ──────────────────────────────────────────────
/**
 * Budgets as fractions of W divided by the measured heuristic->BPE ratio.
 *
 * The division is the whole point. The assembler counts with
 * `HeuristicTokenizer`, the provider bills cl100k, and those two disagree by a
 * measurable factor on *this* corpus. Handing the assembler `0.20 * W` would
 * mean the real prompt is `0.20 * W * ratio` — off by however far the heuristic
 * drifts. Handing it `0.20 * W / ratio` makes the real prompt `0.20 * W`,
 * which is the number the window is expressed in.
 *
 * A re-floored slack is paid for out of Zone C, never Zone B: shrinking B
 * drops branch summaries, and whether branch summaries carry recall is the
 * claim under test — the baseline must not be handed the answer.
 */
export function deriveBudgets(windowTokens, ratio, options = {}) {
  if (!(windowTokens > 0)) throw new Error(`window must be > 0, got ${windowTokens}`);
  if (!(ratio > 0)) throw new Error(`ratio must be > 0, got ${ratio}`);
  const slackFraction =
    options.slackFraction ?? (ratio > SLACK_REFLOOR_ABOVE ? SLACK_REFLOORED : FRACTIONS.slack);
  const zoneCFraction = FRACTIONS.zoneC - (slackFraction - FRACTIONS.slack);
  if (zoneCFraction <= 0) throw new Error(`slack ${slackFraction} leaves no Zone C`);
  const per = (fraction) => Math.floor((fraction * windowTokens) / ratio);
  const reply = per(FRACTIONS.reply);
  const budgets = {
    window: windowTokens,
    ratio,
    slackFraction,
    zoneCFraction,
    reply,
    zoneA: per(FRACTIONS.zoneA),
    zoneB: per(FRACTIONS.zoneB),
    zoneC: per(zoneCFraction),
    lazy: per(FRACTIONS.lazy),
    slack: per(slackFraction),
    /** truncate-tail's keep window, in heuristic tokens. */
    K: Math.floor((K_FRACTION * windowTokens) / ratio) - reply,
    /**
     * `maxTokens` is a provider-native count, so it is NOT divided by the
     * ratio — there is nothing to convert. Purely the window's reply share, so
     * a bigger window buys a longer answer instead of hitting a constant.
     */
    maxReplyTokens: Math.floor(FRACTIONS.reply * windowTokens),
  };
  // D19 extended: `rootKeep` is derived from the window too, not fixed at 40.
  // The predicate is injected and receives the budgets it must fit inside, so
  // the ladder walk stays a pure function of "does this rung pass" while the
  // decision of what passing MEANS lives with the thing that can assemble.
  if (options.fitsRoot !== undefined) {
    Object.assign(budgets, deriveRootKeep((keep) => options.fitsRoot(keep, budgets), options.ladder));
  }
  return budgets;
}

/** D17's keep ladder, largest first — the derivation walks it downward. */
export const ROOT_KEEP_LADDER = Object.freeze([40, 16, 12, 8, 6, 4, 2]);

/**
 * R6 ablation. `tree` walks the keep ladder LARGEST-first, which maximises
 * root headline coverage; `tree-wide` walks it SMALLEST-first, which maximises
 * visible branch summaries. Measured at W=32768: largest-passing stops at
 * keep16 (2 branches visible) while keep2 leaves room for 11 — so the two arms
 * differ in exactly one variable, Zone B composition, over the same frozen
 * store, the same questions, and the same epoch.
 *
 * A separate arm rather than a flag on `tree`, so a verdict can put both in one
 * table from one results directory without re-running any baseline.
 */
export const ARM_ROOT_LADDER = Object.freeze({
  tree: ROOT_KEEP_LADDER,
  'tree-static': ROOT_KEEP_LADDER,
  'tree-wide': Object.freeze([...ROOT_KEEP_LADDER].reverse()),
  // The loop-9b item-2 arms each change ONE thing against `tree`; Zone B
  // composition is not that thing, so they inherit `tree`'s ladder exactly.
  // Sharing the ladder is what makes the contrast attributable: a different
  // rootKeep would move the visible branch set and confound the variable.
  'tree-slice': ROOT_KEEP_LADDER,
  'tree-thin': ROOT_KEEP_LADDER,
  'tree-verbatim': ROOT_KEEP_LADDER,
  'tree-semantic': ROOT_KEEP_LADDER,
  'tree-grep': ROOT_KEEP_LADDER,
});

/** Arms whose Zone B is tree-shaped and therefore need a per-arm root pin. */
export const TREE_ARMS = Object.freeze([
  'tree',
  'tree-wide',
  'tree-static',
  'tree-slice',
  'tree-thin',
  'tree-verbatim',
  'tree-semantic',
  'tree-grep',
  'tree-tail-v2',
  'tree-tail-static',
  'tree-tail-headline',
  'tree-oracle',
  'tree-escalate',
  'tree-hit-keywords',
]);

export function ladderFor(arm) {
  return ARM_ROOT_LADDER[arm] ?? ROOT_KEEP_LADDER;
}

/**
 * `rootKeep` derived per window (D19 extended to D17's cap): the LARGEST rung
 * for which `fits(keep)` holds.
 *
 * A fixed `rootKeep = 40` is the same category of mistake D19 was written to
 * kill: a constant tuned against one window. Measured on the loop-9 store, the
 * rendered root block at keep=40 is 6,917 heuristic tokens — larger than the
 * whole 16k Zone B budget (3,850). The assembler's rule-4 valve cannot save
 * that: the root is deliberately exempt from dropping (`assembler.ts:245-252`),
 * so it drops all 21 branch summaries and *still* reports `overBudget`.
 *
 * What "fits" means is deliberately NOT a share constant. An earlier draft
 * capped the root at half of Zone B, which is a number invented to stand in
 * for the property actually wanted — and tuning it afterwards to rescue a cell
 * would be reverse-engineering a constant to rescue a result. The property
 * wanted is exactly gate 8's invariant, so the caller supplies a predicate
 * that ASSEMBLES the real prompt at that keep and asks it directly:
 * `overBudget == []` and at least one branch summary survived. Two rules
 * collapse into one — wherever this returns a keep, gate 8 provably passes.
 *
 * If no rung passes, the cell is genuinely dead and says so: the same shape as
 * the ratio kill gate, never a forced fit.
 */
export function deriveRootKeep(fits, ladder = ROOT_KEEP_LADDER) {
  const rootLadder = [];
  for (const keep of ladder) {
    const outcome = fits(keep);
    const row = { keep, ...(typeof outcome === 'object' && outcome !== null ? outcome : { ok: outcome === true }) };
    rootLadder.push(row);
    if (row.ok === true) return { rootKeep: keep, rootLadder, rootKeepOk: true, ...rootDetail(row) };
  }
  return { rootKeep: null, rootLadder, rootKeepOk: false, ...rootDetail(rootLadder.at(-1)) };
}

/** The reportable numbers off one ladder rung, whether it passed or not. */
function rootDetail(row) {
  return {
    rootBlockTokens: row?.rootBlockTokens ?? null,
    branchesSurviving: row?.branchesSurviving ?? null,
    branchSeqRange: row?.branchSeqRange ?? null,
    overBudget: row?.overBudget ?? null,
  };
}

/** `ratio > 1.6` is a stated kill condition; between 1.15 and 1.6 slack re-floors. */
export function ratioVerdict(ratio) {
  if (ratio > RATIO_KILL) {
    return { ok: false, action: 'mitigate-or-drop-16k', slackFraction: SLACK_MITIGATION };
  }
  return {
    ok: true,
    action: ratio > SLACK_REFLOOR_ABOVE ? 'slack-refloored-to-0.15' : 'slack-stays-0.10',
    slackFraction: ratio > SLACK_REFLOOR_ABOVE ? SLACK_REFLOORED : FRACTIONS.slack,
  };
}

// ── L0 / L2 access over a frozen store ───────────────────────────────────
/** Blob refs in sha order — a deterministic enumeration of L2, independent of L0. */
export function blobRefsOf(blobsRoot) {
  const refs = [];
  for (const dir of readdirSync(blobsRoot).sort()) {
    const dirPath = join(blobsRoot, dir);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const file of readdirSync(dirPath).sort()) refs.push(dir + file);
  }
  return refs.sort();
}

/**
 * The ratio sample, defined once so it is reproducible: every L2 blob, in sha
 * order, newline-joined. Not "a representative sample" chosen by taste — the
 * whole payload, which is the only sample nobody has to argue about.
 */
export function l0Sample(blobs, blobsRoot) {
  return blobRefsOf(blobsRoot)
    .map((ref) => blobs.getText(ref))
    .join('\n');
}

/**
 * The rendered size and sha of the root block at every rung of the keep
 * ladder, cached on disk and keyed by the leaf-summary sha it is a function of.
 *
 * The cache is not an optimization, it is a correctness property of a frozen
 * fixture. `composeRootSummary` skips the write only when the composed text
 * equals the CURRENT one (D3: versions are appended, never overwritten), so a
 * naive ladder walk appends one root version per rung per call — measured at
 * +33 versions per gate run. Deriving the ladder once and re-reading it makes
 * repeat runs write only when a window genuinely changes the keep.
 */
function rootLadderFor(scenario) {
  const root = scenario.store.root();
  const leafSha = sha256(leafSummaryDump(scenario.store));
  const path = join(scenario.artifacts, 'root-ladder.json');
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    if (cached.leaf_summaries_sha256 === leafSha) return cached.rungs;
  }
  const rungs = {};
  for (const keep of ROOT_KEEP_LADDER) {
    composeRootSummary(scenario.store, root.id, undefined, keep);
    const summary = scenario.store.currentSummary(root.id);
    rungs[keep] = {
      tokens: summary === null ? 0 : heuristic.count(renderSummaryBlock(root, summary, true)),
      sha256: summary === null ? null : sha256(summary.text),
    };
  }
  writeFileSync(path, `${JSON.stringify({ leaf_summaries_sha256: leafSha, rungs }, null, 2)}\n`);
  return rungs;
}

/**
 * Composes the root at `rootKeep` and returns its summary + sha — a no-op when
 * the store already holds exactly those bytes, which is what keeps a re-run
 * from appending a version that says nothing new.
 */
function composeRootAt(scenario, rootKeep, expectedSha) {
  const root = scenario.store.root();
  const current = scenario.store.currentSummary(root.id);
  if (current !== null && expectedSha !== undefined && sha256(current.text) === expectedSha) {
    return { summary: current, sha256: expectedSha };
  }
  composeRootSummary(scenario.store, root.id, undefined, rootKeep ?? ROOT_KEEP_LADDER.at(-1));
  const summary = scenario.store.currentSummary(root.id);
  return { summary, sha256: summary === null ? null : sha256(summary.text) };
}

/**
 * The budgets for one window, with `rootKeep` derived and the store LEFT
 * composed at that keep — every caller downstream (assembly, gates, arms) then
 * reads a root that matches the budget it was sized against.
 */
export function budgetsFor(scenario, windowTokens, ratio, slackFraction, arm = 'tree') {
  const rungs = rootLadderFor(scenario);
  // The predicate IS gate 8, run against the real assembly. Nothing is
  // modelled: the prompt is built at this keep and asked whether it fits and
  // whether anything but the root survived in Zone B.
  const fitsRoot = (keep, budgets) => {
    const { prompt } = assembleTreeAt(scenario, budgets, keep, { withTools: true, expectedSha: rungs[keep]?.sha256 });
    const branches = prompt.blocks.filter((b) => b.zone === 'B' && !b.id.startsWith('B:root'));
    const nodeIds = [...new Set(branches.map((b) => b.nodeId).filter((id) => id !== undefined))];
    return {
      ok: prompt.budgets.overBudget.length === 0 && nodeIds.length >= 1,
      rootBlockTokens: rungs[keep]?.tokens ?? null,
      branchesSurviving: nodeIds.length,
      branchSeqRange: seqRangeOf(scenario.store, nodeIds),
      overBudget: [...prompt.budgets.overBudget],
      zoneB: prompt.budgets.zoneB,
    };
  };
  // The ONLY thing the ablation varies: which end of the ladder is walked.
  // `tree` takes the largest passing keep (most root headlines); `tree-wide`
  // takes the smallest (most visible branch summaries).
  const ladder = ladderFor(arm);
  const budgets = deriveBudgets(windowTokens, ratio, { slackFraction, fitsRoot, ladder });
  const chosen = rungs[budgets.rootKeep ?? ladder.at(-1)];
  const { sha256: rootSummarySha } = composeRootAt(scenario, budgets.rootKeep, chosen?.sha256);
  return { ...budgets, arm, rootSummarySha };
}

/**
 * The branch nodes Zone B actually shows for one (window, arm), with their L0
 * spans. Visibility is the whole question the R6 ablation asks: a `tail` fact
 * at seq 720-731 is answerable from Zone B only if a VISIBLE branch's span
 * contains it, and the newest branch alone starts at 732.
 */
function visibleBranchesAt(scenario, budgets, arm) {
  if (budgets.rootKeep === null) return { arm, branches: [], covers: () => false };
  const { prompt } = assembleTreeAt(scenario, budgets, budgets.rootKeep, {
    withTools: arm !== 'tree-static',
    expectedSha: budgets.rootSummarySha,
  });
  const ids = [
    ...new Set(
      prompt.blocks
        .filter((b) => b.zone === 'B' && !b.id.startsWith('B:root'))
        .map((b) => b.nodeId)
        .filter((id) => id !== undefined),
    ),
  ];
  const branches = ids
    .map((id) => scenario.store.getNode(id))
    .filter((n) => n !== null)
    .map((n) => ({ id: n.id, from: n.span_start_seq, to: n.span_end_seq }));
  return {
    arm,
    branches,
    /** True only if EVERY seq in [from, to] sits inside some visible branch. */
    covers: (from, to) => {
      for (let seq = from; seq <= to; seq += 1) {
        if (!branches.some((b) => b.from <= seq && seq <= b.to)) return false;
      }
      return true;
    },
  };
}

/** L0 span covered by a set of branch nodes — where visibility actually ends. */
function seqRangeOf(store, nodeIds) {
  const nodes = nodeIds.map((id) => store.getNode(id)).filter((n) => n !== null);
  if (nodes.length === 0) return null;
  return {
    from: Math.min(...nodes.map((n) => n.span_start_seq)),
    to: Math.max(...nodes.map((n) => n.span_end_seq)),
  };
}

/**
 * Query rewriter: extracts searchable terms from a natural-language query
 * using a cheap model when regex extraction finds nothing distinctive.
 * Returns an array of grep-worthy phrases.
 */
function buildQueryRewriter() {
  const keys = loadApiKeys();
  const apiKey = keys.openrouter ?? keys.openai;
  if (!apiKey) return undefined;
  const viaOpenRouter = keys.openai === undefined;
  const client = new OpenAI({ apiKey, baseURL: viaOpenRouter ? OPENROUTER_BASE_URL : undefined });
  const model = 'z-ai/glm-5.3-flash';
  return async (query) => {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Extract 3-5 distinctive searchable phrases from the user\'s query. Return ONLY a JSON array of strings. Each string should be a specific term, file path, identifier, or short phrase that would uniquely identify the relevant content in a codebase trace. No explanation.' },
        { role: 'user', content: query },
      ],
      max_tokens: 200,
      temperature: 0,
    });
    const text = response.choices?.[0]?.message?.content ?? '[]';
    try { const arr = JSON.parse(text); return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.length >= 2) : []; }
    catch { return []; }
  };
}

/** The read-only ToolContext the §9 handlers expect, over the frozen store. */
function toolContextFor(scenario) {
  return {
    config: scenario.config,
    handle: {
      config: scenario.config,
      paths: scenario.paths,
      trace: scenario.trace,
      blobs: scenario.blobs,
      store: scenario.store,
      close() {},
    },
    retriever: new TreeRetriever({ store: scenario.store, blobs: scenario.blobs, trace: scenario.trace, rewrite: buildQueryRewriter() }),
  };
}

/**
 * Loop-9b item 2 Step 5: `tree-semantic`'s `ToolContext`, over a COPY of the
 * store with a real embedder wired — the frozen fixture is NEVER opened for
 * writing (D15/G8's freeze). Mirrors `eval/scripts/embed-store.mjs`'s
 * copy-then-embed pattern exactly, so the same offline check G6 runs is the
 * same code path a live `tree-semantic` cell would use.
 *
 * Embedding calls are metered locally (calls + reported tokens) rather than
 * through the answerer `InMemoryCostMeter`s in `meters`, because embeddings
 * are billed on a different rate table (`priceFor(DEFAULT_EMBED_MODEL)`) and
 * are not an answering-model spend — the caller folds the dollar figure into
 * its own cap/report.
 */
async function buildSemanticToolCtx(scenario) {
  const keys = loadApiKeys();
  const apiKey = keys.openai ?? keys.openrouter;
  if (apiKey === undefined) {
    throw new Error('tree-semantic requires OPENAI_API_KEY or OPENROUTER_API_KEY to embed a store copy');
  }
  const viaOpenRouter = keys.openai === undefined;
  const copyRoot = mkdtempSync(join(tmpdir(), 'ct-transplant-semantic-'));
  const storeCopy = join(copyRoot, 'store');
  // A copy of the working store (itself already a copy of the fixture since
  // `openScenario` stopped writing the original) because embedSummaries writes
  // L3 rows and this arm must not perturb the store the other arms read.
  cpSync(scenario.storeRoot, storeCopy, { recursive: true });
  const paths = storePaths(storeCopy);
  const trace = new JsonlTraceLog(paths.trace);
  const blobs = new FsBlobStore(paths.blobs);
  const store = openStore(paths.db);
  const usage = { calls: 0, tokens: 0 };
  const rawClient = new OpenAI({ apiKey, baseURL: viaOpenRouter ? OPENROUTER_BASE_URL : undefined });
  const meteredClient = {
    embeddings: {
      create: async (params) => {
        const response = await rawClient.embeddings.create(params);
        usage.calls += 1;
        usage.tokens += response.usage?.total_tokens ?? 0;
        return response;
      },
    },
  };
  const embed = createEmbeddingClientFromKeys({
    keys,
    baseURL: viaOpenRouter ? OPENROUTER_BASE_URL : undefined,
    client: meteredClient,
  });
  const retriever = new TreeRetriever({ store, blobs, trace, embed });
  const embedResult = await retriever.embedSummaries();
  const price = priceFor(DEFAULT_EMBED_MODEL);
  const usd = (usage.tokens / 1_000_000) * price.price.input;
  console.log(
    `  [tree-semantic] embedded ${embedResult.embedded.length} summary(ies) into a store COPY at ${storeCopy} ` +
      `(${usage.calls} call(s), ${usage.tokens} token(s), ~$${usd.toFixed(6)} at ${price.matched ?? '(fallback rate)'} pricing)`,
  );
  return {
    toolCtx: {
      config: scenario.config,
      handle: { config: scenario.config, paths, trace, blobs, store, close() {} },
      retriever,
    },
    usage,
    usd,
    cleanup() {
      store.close();
      trace.close();
      rmSync(copyRoot, { recursive: true, force: true });
    },
  };
}

/** The one ratio measurement, so every phase reads the same number. */
export function measureRatio(scenario) {
  const sample = l0Sample(scenario.blobs, scenario.paths.blobs);
  return exact.count(sample) / heuristic.count(sample);
}

/** What `naive-full` would send: every L0 event rendered, in seq order. */
export function renderNativeTranscript(events, blobs) {
  return events.map((event) => renderEvent(event, blobs)).join('\n\n');
}

/** Node dump the store sha is taken over — coordinates only, never content. */
export function nodeDump(store) {
  return JSON.stringify(
    store.nodesInCreationOrder().map((n) => ({
      id: n.id,
      parent_id: n.parent_id,
      kind: n.kind,
      title: n.title,
      phase_type: n.phase_type ?? null,
      span_start_seq: n.span_start_seq,
      span_end_seq: n.span_end_seq,
      status: n.status ?? null,
    })),
  );
}

/**
 * Opens the scenario. `mutable: false` (the default for every phase that
 * composes a root) works on a COPY, so the frozen fixture is read-only by
 * construction.
 *
 * Why a copy. The freeze covers L0, the node dump and the LEAF summaries, and
 * the root is pinned per window by `root_by_window` — but composing a root
 * WRITES a version, `currentSummary` returns the newest, and each window and
 * arm composes at a different keep. So the root node accumulated 1,546 versions
 * over this experiment's runs, and any script that read the root without
 * composing first got whatever the previous run happened to leave. That is not
 * hypothetical: the caching experiment's session table could not be reproduced
 * hours later because six root versions had been appended in between, moving
 * every Zone B number it had measured.
 *
 * Copying is cheap (one SQLite file plus a directory of blob hardlinks would do;
 * a plain recursive copy is simpler and this store is small) and it makes the
 * hazard structural rather than a rule someone has to remember.
 */
export function openScenario(scenarioId, { mutable = false } = {}) {
  const dir = join(FIXTURES, scenarioId);
  const src = join(dir, 'trace.src.jsonl');
  const frozenRoot = join(dir, 'store');
  if (!existsSync(frozenRoot)) throw new Error(`scenario ${scenarioId}: no store at ${frozenRoot}`);
  let storeRoot = frozenRoot;
  let scratch = null;
  if (!mutable) {
    scratch = mkdtempSync(join(tmpdir(), `ct-transplant-${scenarioId}-`));
    storeRoot = join(scratch, 'store');
    cpSync(frozenRoot, storeRoot, { recursive: true });
  }
  const paths = storePaths(storeRoot);
  const config = { ...loadConfig(REPO), root: storeRoot };
  const trace = new JsonlTraceLog(paths.trace);
  const blobs = new FsBlobStore(paths.blobs);
  const store = openStore(paths.db);
  const traceSha = existsSync(src) ? sha256File(src) : null;
  const artifacts = join(dir, traceSha === null ? 'no-src' : traceSha.slice(0, 12));
  mkdirSync(artifacts, { recursive: true });
  return {
    id: scenarioId,
    dir,
    src,
    storeRoot,
    /** The fixture itself, for hashing — never written when `mutable` is false. */
    frozenRoot,
    paths,
    config,
    trace,
    blobs,
    store,
    traceSha,
    traceBytes: existsSync(src) ? statSync(src).size : null,
    artifacts,
    close() {
      store.close();
      trace.close();
      if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/** Every stored summary body, keyed by node — the leakage gate's corpus. */
function summaryBodies(store) {
  const out = new Map();
  for (const node of store.nodesInCreationOrder()) {
    const summary = store.currentSummary(node.id);
    if (summary !== null) out.set(node.id, summary.text);
  }
  return out;
}

/**
 * The LEAF summary rows the freeze covers. Deliberately excludes the task
 * root: once `rootKeep` is derived per window (D19 extended), the root gains
 * one deterministic version per distinct keep, so a whole-store summary hash
 * would flag every window switch as a freeze violation. The leaves are the
 * invariant — their shas never change after Step 1 — and the root is pinned
 * per window instead, by `root_by_window` in the manifest.
 */
function leafSummaryDump(store) {
  const rootId = store.root()?.id ?? null;
  const rows = [];
  for (const node of store.nodesInCreationOrder()) {
    if (node.id === rootId) continue;
    const summary = store.currentSummary(node.id);
    if (summary !== null) rows.push({ node_id: node.id, version: summary.version, model: summary.model, text: summary.text });
  }
  return JSON.stringify(rows);
}

// ── manifest (Graft 2) ───────────────────────────────────────────────────
export function buildManifest(scenario, extra = {}) {
  const configPath = join(REPO, 'context-tree.config.json');
  return {
    scenario: scenario.id,
    trace: { path: `eval/fixtures/transplant/${scenario.id}/trace.src.jsonl`, sha256: scenario.traceSha, bytes: scenario.traceBytes },
    store: {
      path: `eval/fixtures/transplant/${scenario.id}/store`,
      trace_jsonl_sha256: sha256File(scenario.paths.trace),
      node_dump_sha256: sha256(nodeDump(scenario.store)),
      // Step 1 freezes node_summaries too, so the LEAF rows are hashed. The
      // consequence is deliberate: the summarize pass changes this sha, which
      // forces `--phase prep` to be re-run before any arm — which is also the
      // only point at which the `deep` stratum can be cut. The root is not in
      // here; it is pinned per window by `root_by_window` below.
      leaf_summaries_sha256: sha256(leafSummaryDump(scenario.store)),
      summaries: summaryBodies(scenario.store).size,
      nodes: scenario.store.nodesInCreationOrder().length,
      l0_events: scenario.trace.lastSeq(),
      blobs: blobRefsOf(scenario.paths.blobs).length,
    },
    // The toolPhase map is part of the epoch: change it and the segmentation
    // changes, so it is hashed like the trace is.
    config: { path: 'context-tree.config.json', sha256: sha256File(configPath) },
    gates: [...GATE_IDS],
    models: { answerers: [...MODELS], paraphraser: PARAPHRASE_MODEL, compaction: COMPACT_MODEL },
    /** W verbatim — the numbers the design named, not a rounded restatement. */
    windows: [...WINDOWS],
    fractions: { ...FRACTIONS },
    caps: { per_model_usd: CAP_USD_PER_MODEL, total_usd: CAP_USD_TOTAL, max_summary_tokens: MAX_SUMMARY_TOKENS, root_keep: ROOT_KEEP },
    ...extra,
  };
}

/**
 * Per-window root pin: the derived `rootKeep` and the sha of the root summary
 * it composes to. This is what replaces a whole-store summary hash now that
 * the root is versioned per window (D19 extended) — the leaves stay invariant,
 * the root is pinned once per W.
 */
function rootByWindow(scenario, ratio, slackFraction, windows = WINDOWS) {
  const out = {};
  for (const w of windows) {
    // Keyed window -> arm. `tree-static` shares `tree`'s ladder and therefore
    // its pin, so only the two distinct ladders are recorded.
    out[String(w)] = {};
    for (const arm of ['tree', 'tree-wide']) {
      const budgets = budgetsFor(scenario, w, ratio, slackFraction, arm);
      out[String(w)][arm] = {
        rootKeep: budgets.rootKeep,
        rootBlockTokens: budgets.rootBlockTokens,
        branchesSurviving: budgets.branchesSurviving,
        branchSeqRange: budgets.branchSeqRange,
        rootSummarySha: budgets.rootSummarySha,
        zoneB: budgets.zoneB,
      };
    }
  }
  return out;
}

function manifestPath(scenario) {
  return join(scenario.artifacts, 'manifest.json');
}

function readManifest(scenario) {
  const path = manifestPath(scenario);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/**
 * The freeze line. Step 1 says no re-ingest and no re-summarize after the
 * manifest is written, for any arm at any W — so a store that no longer hashes
 * to the manifest is a stopped experiment, not a warning to scroll past.
 */
function assertFrozen(scenario, options = {}) {
  const manifest = readManifest(scenario);
  if (manifest === null) throw new Error(`no manifest at ${manifestPath(scenario)} — run --phase prep first`);
  const now = buildManifest(scenario);
  for (const key of ['trace_jsonl_sha256', 'node_dump_sha256', 'leaf_summaries_sha256']) {
    if (manifest.store[key] !== now.store[key]) {
      throw new Error(
        `FREEZE VIOLATION: store.${key} is ${now.store[key]} but the manifest says ${manifest.store[key]} — ` +
          'the store was re-ingested or re-summarized after the freeze; every arm run against it is off-epoch',
      );
    }
  }
  if (manifest.config.sha256 !== now.config.sha256) {
    throw new Error('FREEZE VIOLATION: context-tree.config.json changed after the freeze (toolPhase is part of the epoch)');
  }
  // The root is versioned per window, so it is pinned per window: composing at
  // the recorded keep must reproduce the recorded bytes. That keeps the freeze
  // meaningful for the one summary the derivation is allowed to re-mint.
  if (options.window !== undefined) {
    const perArm = manifest.root_by_window?.[String(options.window)];
    if (perArm === undefined) {
      throw new Error(`no root_by_window entry for W=${options.window} in the manifest — re-run --phase prep`);
    }
    // EVERY arm's pin is verified, not just the one about to run: the pins are
    // all functions of the same leaf summaries, so if one has drifted they all
    // have, and a run that checked only its own would report a clean epoch
    // while its sibling arm silently ran off one.
    if (perArm.rootKeep !== undefined) {
      throw new Error(
        `manifest root_by_window[${options.window}] is the pre-ablation flat shape (one pin, no arm dimension). ` +
          'Re-run `--phase prep` (offline is enough) to record per-arm pins for tree and tree-wide.',
      );
    }
    for (const [arm, recorded] of Object.entries(perArm)) {
      const { sha256: actual } = composeRootAt(scenario, recorded.rootKeep, recorded.rootSummarySha);
      if (actual !== recorded.rootSummarySha) {
        throw new Error(
          `FREEZE VIOLATION: ${arm} root at W=${options.window} (rootKeep=${recorded.rootKeep}) composes to ${actual} ` +
            `but the manifest says ${recorded.rootSummarySha} — the leaf summaries changed under it`,
        );
      }
    }
  }
  return manifest;
}

// ── question extraction (Step 2, offline half) ───────────────────────────
/**
 * Candidate answer literals. Five shapes, each anchored so a partial match
 * cannot pass: paths, long hex digests, multi-digit numbers, camel/snake
 * identifiers, and short quoted phrases (the "quoted decisions" of the spec).
 */
const LITERAL_PATTERNS = Object.freeze([
  ['path', /(?:[\w.@~-]+)?(?:\/[\w.@+-]+){1,}\.[A-Za-z][\w]{0,4}/g],
  ['hex', /\b[0-9a-f]{8,64}\b/g],
  ['number', /\b\d{2,}(?:[.,]\d{3})*(?:\.\d+)?\b/g],
  ['ident', /\b(?:[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+|[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)\b/g],
  ['quoted', /"([^"\n]{8,80})"/g],
]);

/** Markup, shell redirection and quoting inside a literal disqualify it. */
const MARKUP_RE = /[<>{}|\\"=&$`]/;
/** A literal sitting inside rendered HTML is a report fragment, not a fact. */
const HTML_NEIGHBOURHOOD_RE = /<\/?[a-z][\w-]*[\s>/]|&[a-z]{2,6};/i;

/**
 * Shape filter. The spec asks for "numbers, paths, identifiers, quoted
 * decisions", and a regex sweep over a real trace also yields
 * `">15.4%</td><td class="` and `2>/dev/null || python3 -c "`. Those are not
 * answer keys: no paraphraser can turn one into a question in plain words, and
 * no model can be expected to reproduce it verbatim — grading them would
 * measure transcription, not recall. So the filter is part of the extractor,
 * not a taste judgement applied afterwards.
 */
export function looksLikeAnswerKey(record) {
  const { literal, kind, context } = record;
  if (MARKUP_RE.test(literal)) return false;
  if (HTML_NEIGHBOURHOOD_RE.test(context)) return false;
  switch (kind) {
    case 'quoted':
      return /^[A-Za-z][\w ,.\-/():']{7,}$/.test(literal) && literal.split(/\s+/).length >= 3;
    case 'path':
      return /^[\w.@~-]{2,}(?:\/[\w.@+-]+)+\.[A-Za-z]\w{0,4}$/.test(literal);
    case 'number':
      return /^\d{3,}(?:[.,]\d{3})*(?:\.\d+)?$/.test(literal);
    case 'ident':
      return literal.length >= 6;
    default:
      return true;
  }
}

/**
 * Every once-only literal in L0, with the coordinates that make it an answer
 * key: the seq it occurs at and the phase node whose span covers that seq.
 *
 * Uniqueness is checked against the whole rendered transcript, not per-event —
 * a literal that is unique inside its own turn but repeated three phases later
 * is not an answer key, it is a coin flip.
 */
export function extractLiterals(events, blobs, store) {
  const rendered = events.map((event) => renderEvent(event, blobs));
  const whole = rendered.join('\n\n');
  const phases = store.nodesInCreationOrder().filter((n) => n.kind === 'phase');
  const phaseOf = (seq) => phases.find((p) => p.span_start_seq <= seq && seq <= p.span_end_seq) ?? null;

  const seen = new Map();
  for (let i = 0; i < events.length; i += 1) {
    const text = rendered[i] ?? '';
    for (const [kind, pattern] of LITERAL_PATTERNS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(text);
      while (match !== null) {
        const literal = (match[1] ?? match[0]).trim();
        if (literal.length >= 4 && !seen.has(literal)) {
          const at = match.index;
          const context = text.slice(Math.max(0, at - CONTEXT_WINDOW_CHARS), at + literal.length + CONTEXT_WINDOW_CHARS);
          const wideContext = text.slice(Math.max(0, at - WIDE_CONTEXT_CHARS), at + literal.length + WIDE_CONTEXT_CHARS);
          const phase = phaseOf(events[i].seq);
          seen.set(literal, {
            literal,
            kind,
            seq: events[i].seq,
            node_id: phase?.id ?? null,
            phase_type: phase?.phase_type ?? null,
            context,
            wide_context: wideContext,
            occurrences: 0,
          });
        }
        match = pattern.exec(text);
      }
    }
  }
  for (const record of seen.values()) record.occurrences = countOccurrences(whole, record.literal);
  const wellShaped = [...seen.values()].filter(looksLikeAnswerKey);
  return {
    whole,
    all: [...seen.values()],
    wellShaped,
    onceOnly: wellShaped.filter((r) => r.occurrences === 1 && r.context.length >= MIN_CONTEXT_CHARS),
  };
}

/**
 * The seq at which `truncate-tail`'s keep window opens: walk L0 newest-first,
 * charging heuristic tokens, and stop when K is spent. Everything at or after
 * that seq is visible to truncation at THIS K (the `tail` stratum); everything
 * before it is not (the `head` stratum). Stratifying on the token boundary
 * rather than an event count makes the cut reproducible — but note the boundary
 * is non-increasing in K, so "outside the tail" holds only at the K passed in,
 * NOT at every window. See the correction in `runPrep`.
 */
export function truncationBoundarySeq(events, blobs, K, tokenizer = heuristic) {
  let spent = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const cost = tokenizer.count(renderEvent(events[i], blobs));
    if (spent + cost > K) return events[i].seq + 1;
    spent += cost;
  }
  return events.length === 0 ? 1 : events[0].seq;
}

/**
 * Deterministic pick: sort by `sha256(literal)` and take the first `n` that sit
 * in distinct phase nodes. Sha order is arbitrary but fixed — it is not
 * position-biased the way "first n in seq order" is, and it is reproducible the
 * way a seeded RNG is not across engines.
 */
export function pickDeterministic(pool, n, { distinctNodes = true, exclude = new Set() } = {}) {
  const sorted = [...pool]
    .filter((candidate) => !exclude.has(candidate.literal))
    .sort((a, b) => (sha256(a.literal) < sha256(b.literal) ? -1 : 1));
  const picked = [];
  const usedNodes = new Set();
  for (const candidate of sorted) {
    if (picked.length === n) break;
    if (distinctNodes && candidate.node_id !== null && usedNodes.has(candidate.node_id)) continue;
    if (candidate.node_id !== null) usedNodes.add(candidate.node_id);
    picked.push(candidate);
  }
  // Spreading across branches is a preference, not a constraint: the `tail`
  // pool is by construction the newest ~15k tokens, which is one or two phases,
  // so insisting on three distinct branches there would silently return two
  // questions and quietly shrink the stratum the design pre-registered at 3.
  //
  // CORRECTION (2026-09-03): the comment above `truncationBoundarySeq` used to
  // claim that stratifying on the token boundary makes `head` mean "provably
  // outside the baseline's view". It does not. The boundary is non-increasing
  // in K, so a fact outside the SMALLEST window's tail can sit well inside a
  // wider window's tail — and the whole prior pass was aimed by trusting that
  // sentence. `head` means "outside the tail at the K it was cut for", nothing
  // more. Use `--phase prep-overflow --ref-window W` to cut a stratum that is
  // outside the tail at W and every narrower window.
  if (picked.length < n) {
    for (const candidate of sorted) {
      if (picked.length === n) break;
      if (!picked.includes(candidate)) picked.push(candidate);
    }
  }
  return picked;
}

/** Word n-grams over case-folded, punctuation-stripped text. */
export function ngramSet(text, n = 3) {
  const words = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0);
  const grams = new Set();
  for (let i = 0; i + n <= words.length; i += 1) grams.add(words.slice(i, i + n).join(' '));
  return grams;
}

/**
 * The leakage gate, with the carve-out that makes it usable: a question is
 * rejected for sharing a 3-gram with its source phase's stored summary *after
 * the answer literal is removed from the question*. Without the carve-out the
 * gate rejects every question that must contain its own answer token — which is
 * most of them, since a paraphrase of "we capped it at 50" mentions 50.
 */
export function leakageGate({ question, summaryText, answerLiterals = [], n = 3 }) {
  let stripped = question;
  for (const literal of answerLiterals) stripped = stripped.split(literal).join(' ');
  const summary = ngramSet(summaryText, n);
  const shared = [...ngramSet(stripped, n)].filter((gram) => summary.has(gram));
  return { ok: shared.length === 0, shared };
}

/**
 * Grading is `exactMatchJudge` (normalized substring) per answer literal,
 * conjoined, plus a boundary-tolerant regex per literal so a model that writes
 * "50 records" and one that writes "50." both pass. No model is called: the
 * paraphraser wrote the questions and must never also grade them.
 */
export function answerRegexesFor(literals) {
  return literals.map((literal) => `(?<![\\w])${escapeRe(literal)}(?![\\w])`);
}

export function gradeAnswer(finalText, question) {
  const literals = question.answer_literals;
  const perLiteral = literals.map((literal, i) => ({
    literal,
    exact_match: exactMatchJudge(finalText, literal).success === true,
    regex: new RegExp(question.answer_regexes[i], 'i').test(finalText),
  }));
  const matched = perLiteral.every((r) => r.regex || r.exact_match);
  return { score: matched ? 1 : 0, success: matched, perLiteral };
}

/**
 * One candidate -> one question record. Shared by the offline cut (which fills
 * `literals.json`) and the live redraw loop (which may reach deeper into the
 * pool when a literal is discarded), so the two can never drift.
 */
export function buildSelectedItem(item, stratum) {
  const spanning = stratum === 'spanning';
  const literals = spanning ? [item.literal, item.pair.literal] : [item.literal];
  return {
    stratum,
    exploratory: EXPLORATORY_STRATA.includes(stratum),
    node_id: item.node_id,
    node_ids: spanning ? [item.node_id, item.pair.node_id] : [item.node_id],
    seq: item.seq,
    kind: item.kind,
    answer_literals: literals,
    answer_regexes: answerRegexesFor(literals),
    source_context: spanning ? `${item.context}\n---\n${item.pair.context}` : item.context,
    // What the paraphraser reads: wider, so it can name a disambiguating
    // anchor from the surrounding L0 rather than describing the fact alone.
    wide_context: spanning ? `${item.wide_context}\n---\n${item.pair.wide_context}` : item.wide_context,
  };
}

// ── statistics, pre-registered (Graft 4) ─────────────────────────────────
/** C's binomial form: n = 16 p̄(1−p̄) / Δ². */
export function binomialN(pBar, delta) {
  if (!(delta > 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil((16 * pBar * (1 - pBar)) / (delta * delta));
}

/** B's pooled-σ two-proportion form at α=.05 / power .80, as the cross-check. */
export function pooledSigmaN(pA, pB) {
  const delta = Math.abs(pA - pB);
  if (!(delta > 0)) return Number.POSITIVE_INFINITY;
  const pooled = (pA + pB) / 2;
  return Math.ceil((2 * (1.959_964 + 0.841_621) ** 2 * pooled * (1 - pooled)) / (delta * delta));
}

/** Escalate on the LARGER of the two forms, capped at 20, one escalation only. */
export function escalationN(pTree, pCompact, cap = 20) {
  const delta = Math.abs(pTree - pCompact);
  const pBar = (pTree + pCompact) / 2;
  const binomial = binomialN(pBar, delta);
  const pooled = pooledSigmaN(pTree, pCompact);
  const required = Math.max(binomial, pooled);
  return { binomial, pooled, required, capped: Math.min(cap, required), delta, pBar };
}

/** Deterministic bootstrap (LCG) — the CI must be identical on a re-run. */
export function bootstrapCI(treeScores, compactScores, { iterations = 2_000, seed = 1, alpha = 0.05 } = {}) {
  if (treeScores.length === 0 || compactScores.length === 0) return null;
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  const draws = [];
  for (let i = 0; i < iterations; i += 1) {
    let a = 0;
    let b = 0;
    for (let j = 0; j < treeScores.length; j += 1) a += treeScores[Math.floor(next() * treeScores.length)];
    for (let j = 0; j < compactScores.length; j += 1) b += compactScores[Math.floor(next() * compactScores.length)];
    draws.push(a / treeScores.length - b / compactScores.length);
  }
  draws.sort((x, y) => x - y);
  const lo = draws[Math.floor((alpha / 2) * iterations)];
  const hi = draws[Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))];
  return { point: mean(treeScores) - mean(compactScores), lo, hi, crossesZero: lo <= 0 && hi >= 0 };
}

// ── prompt assembly (forked from recall-probe's buildPrompt) ─────────────
const QA_ADDENDUM = [
  '',
  '# Answering this question',
  "You are being asked a single question about this task's recorded history.",
  'The answer IS in the recorded events. If you cannot see it in the context above:',
  '1. Call context_search with keywords from the question to find the right branch.',
  '2. Call context_fetch with the branch_id from the search result to read the raw events.',
  '3. The fetched content contains the answer — read it carefully and extract the literal.',
  'Do NOT say "I don\'t have context" or give up. The events are recorded; use the tools to find them.',
  'When you are ready, reply with your final answer in plain text and make NO further tool call.',
].join('\n');

const FLAT_SYSTEM = [
  'You are resuming a software task from a record of an earlier session. The record below is',
  'all you have; there are no tools and no filesystem.',
  '',
  '# Answering this question',
  "You are being asked a single question about that session's history. Answer from the record.",
  'Reply with your final answer in plain text. If the record does not contain the answer, say so.',
].join('\n');

/**
 * Loop-9b item 2 Step 4 (Graft 1): which contract text an arm's Zone A
 * carries. `tree-verbatim`'s ONE variable IS the contract text (v3's rule-2
 * replacement + narrow-fetch removal); every other tree-family arm gets
 * `v1`, overridable by `EVAL_CONTRACT_VERSION` so a re-run can pin every
 * control arm's epoch. `v2` (loop9-item3's Zone-A trim candidate) is never
 * selected here.
 */
export function contractVersionFor(arm) {
  if (arm === 'tree-verbatim') return 'v3';
  return process.env.EVAL_CONTRACT_VERSION ?? 'v1';
}

function treeSystemTextFor(arm) {
  return systemContract(contractVersionFor(arm)) + QA_ADDENDUM;
}

/** Default contract text — the module-level constant every gate below assembles against. */
const TREE_SYSTEM = treeSystemTextFor('tree');
/** Zone A's schemas as one byte-stable string — the four §9 tools (§9, D5). */
const TOOL_SCHEMAS_TEXT = JSON.stringify(CONTEXT_TOOL_SCHEMAS);

/**
 * Loop-9b item 2 Steps 2/3 (R8/R9) made `HANDLERS[CONTEXT_FETCH]`/
 * `[CONTEXT_SEARCH]` default to the NEW product behavior — `depth: 'full'`,
 * snippet + pointer-meta search hits — for EVERY caller, including a real MCP
 * host. That is a real, permanent product change, not an eval-only toggle. So
 * the `tree`/`tree-wide`/`tree-static` CONTROL arms and `tree-verbatim`
 * (whose one variable is contract text, not the tool surface) must reproduce
 * the PRE-change surface, or they would silently absorb Step 2/3's variable
 * and no arm would isolate it. `tree-slice`/`tree-thin` get the real,
 * upgraded handlers untouched — that reproduced-legacy surface is what makes
 * each of them the ONE step-2-or-3 variable against `tree`. `tree-semantic`
 * also gets the legacy surface (Step 6: "old surface, contract v1"), so its
 * one variable is purely which retriever answers `search()` — lexical
 * (no `embed`) for every legacy arm, vector for `tree-semantic` alone (Step 5).
 *
 * | Arm            | Variable vs `tree`                          | Surface | Contract |
 * |----------------|----------------------------------------------|---------|----------|
 * | `tree`         | control (Step 1 logging only)                 | legacy  | v1       |
 * | `tree-wide`    | root-fold ladder order (standing R6 ablation) | legacy  | v1       |
 * | `tree-static`  | no tools at all (Zone A sizing control)       | legacy  | v1       |
 * | `tree-slice`   | fetch default + addressable unit (Step 2)     | REAL    | v1       |
 * | `tree-thin`    | search hit is coordinates, not content (Step 3)| REAL   | v1       |
 * | `tree-verbatim`| Zone A policy text only (Step 4, Graft 1)     | legacy  | v3       |
 * | `tree-semantic`| search ranks by meaning, not lexical (Step 5) | legacy  | v1       |
 */
const LEGACY_SURFACE_ARMS = new Set(['tree', 'tree-wide', 'tree-static', 'tree-verbatim', 'tree-semantic', 'tree-tail', 'tree-tail-v2', 'tree-tail-static', 'tree-tail-headline', 'tree-oracle', 'tree-escalate', 'tree-hit-keywords']);
/**
 * The share of one turn's live headroom a search result may occupy. Search
 * locates; fetch is what carries content, so a result list that eats the space
 * the fetch needs defeats its own purpose. A quarter leaves the fetch three
 * times what the list costs.
 */
const SEARCH_RESULT_HEADROOM_SHARE = 0.25;
/** Arms whose fetch is a raw, narrowed L0 replay sized by the live headroom. */
const RAW_NARROWED_FETCH_ARMS = new Set(['tree-tail-v2', 'tree-oracle', 'tree-escalate', 'tree-hit-keywords']);

/** Tokens shorter than this decide nothing and match everything. */
const KEYWORD_MIN_TOKEN = 3;

const tokensOf = (text) =>
  new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= KEYWORD_MIN_TOKEN),
  );

/**
 * The retriever builds its fingerprint index lazily on first search; a warmup
 * query is how the Zone B headline path reaches it too.
 */
function fingerprintCacheOf(retriever) {
  if (retriever.fingerprintCache === undefined) retriever.beamSearch('warmup', { limit: 1 });
  return retriever.fingerprintCache ?? new Map();
}

/**
 * A node's fingerprints that share tokens with the query, ranked for DISPLAY.
 *
 * Two things make ranking by raw overlap wrong here. The cache is not the clean
 * keyword set the term implies — on the measured store one branch holds 425
 * entries of which 72 carry whitespace and the largest is 4,998 characters of
 * raw source — and a slab that size contains more query tokens than any
 * identifier does, so raw overlap sorts the slabs to the top and buries
 * `deadlineMs` beneath them. Whitespace-bearing entries are dropped because a
 * fingerprint is defined as a path, identifier or symbol; the rest are ranked
 * by the FRACTION of their own tokens the query accounts for, so a fingerprint
 * that is entirely the thing being asked about outranks a long path that
 * mentions it once. Ties break toward the shorter, more specific entry.
 *
 * (That the cache holds raw slabs at all is an extractor defect, not a display
 * one; it is filtered here and left recorded rather than fixed in passing.)
 */
function matchedFingerprints(fingerprints, nodeId, queryTokens) {
  const own = fingerprints.get(nodeId);
  if (own === undefined) return [];
  const scored = [];
  for (const fingerprint of own) {
    if (/\s/.test(fingerprint)) continue;
    const tokens = tokensOf(fingerprint);
    if (tokens.size === 0) continue;
    let overlap = 0;
    for (const token of tokens) if (queryTokens.has(token)) overlap += 1;
    if (overlap > 0) scored.push({ fingerprint, density: overlap / tokens.size, overlap });
  }
  scored.sort(
    (a, b) => b.density - a.density || b.overlap - a.overlap || a.fingerprint.length - b.fingerprint.length,
  );
  return scored.map((entry) => entry.fingerprint);
}

/** The pre-Step-3 hit shape (full `text`, full `meta`), off the SAME ranked hits `contextSearch` used. */
async function legacySearchHits(ctx, input) {
  const limit = ctx.config.retrieval.limit;
  const tree = await ctx.retriever.search(input.query, { kind: input.kind, limit });
  return tree.hits.map((hit) => ({
    node_id: hit.nodeId,
    kind: hit.kind,
    title: hit.title,
    phase_type: hit.phaseType,
    path: hit.path ?? null,
    summary_version: hit.version,
    score: hit.score,
    meta: hit.meta,
    text: hit.text,
  }));
}

/**
 * Per-arm handler table. `HANDLERS` is `@context-tree/mcp`'s real, shared
 * table (Steps 2/3 behavior); a legacy-surface arm gets a wrapper that
 * defaults an omitted `depth` back to `'summary'` and reconstructs a
 * full-text/full-meta search hit from the SAME `ctx.retriever.search()` call
 * the real handler already makes — so `tree-semantic`'s wrapped search still
 * runs the vector path when `ctx.retriever` was built with an `embed`.
 */
/**
 * Tool schemas per arm. tree-tail-v2 strips the `depth` parameter from
 * context_fetch so the model always gets full content (semantically narrowed
 * to fit the window). Other arms keep the standard schemas.
 */
function toolSchemasForArm(arm) {
  if (RAW_NARROWED_FETCH_ARMS.has(arm)) {
    return CONTEXT_TOOL_SCHEMAS.map((tool) => {
      if (tool.name !== CONTEXT_FETCH) return tool;
      const params = { ...tool.inputSchema };
      if (params.properties) {
        const { depth, ...rest } = params.properties;
        params.properties = rest;
      }
      return { ...tool, inputSchema: params,
        description: tool.description.replace(/Reach for it BEFORE EDITING/, 'Returns the full raw events of a branch, narrowed to the most relevant section when the branch is large. Reach for it BEFORE EDITING') };
    });
  }
  return CONTEXT_TOOL_SCHEMAS;
}

export function handlersForArm(arm) {
  if (arm === 'tree-grep') {
    return {
      ...HANDLERS,
      [CONTEXT_SEARCH]: async (ctx, input) => {
        const limit = ctx.config.retrieval.limit;
        const result = ctx.retriever.grepEvents(input?.query ?? '', { kind: input?.kind, limit });
        const hits = result.hits.map((hit) => ({
          node_id: hit.nodeId,
          kind: hit.kind,
          title: hit.title,
          phase_type: hit.phaseType,
          path: hit.path ?? null,
          summary_version: hit.version,
          score: hit.score,
          meta: hit.meta ? { files: hit.meta.files, symbols: hit.meta.symbols, node_ids: hit.meta.node_ids } : null,
        }));
        return { ok: true, data: { query: input?.query, path: 'grep', fallback: null, hits, candidates: [], provenance: [], unavailable: [] } };
      },
    };
  }
  if (!LEGACY_SURFACE_ARMS.has(arm)) return HANDLERS;
  // tree-tail-v2: raw fetch with semantic narrowing (not summary-only).
  // Track the last search query so fetch can use it to center the narrowing band.
  if (RAW_NARROWED_FETCH_ARMS.has(arm)) {
    let lastSearchQuery = '';
    return {
      ...HANDLERS,
      [CONTEXT_SEARCH]: async (ctx, input) => {
        lastSearchQuery = input?.query ?? '';
        // The oracle: hand back the question's own source branch, ranked first,
        // and nothing else. `_oracleNodeIds` is set per question by the runner.
        // Everything downstream — fetch, narrowing, the append cap, the
        // contract — is byte-identical to `tree-tail-v2`, so the ONLY variable
        // is whether ranking found the branch.
        if (arm === 'tree-oracle') {
          const ids = ctx._oracleNodeIds ?? [];
          const hits = ids.flatMap((nodeId) => {
            const node = ctx.handle.store.getNode(nodeId);
            if (node === null || node === undefined) return [];
            const summary = ctx.handle.store.currentSummary(nodeId);
            return [{
              node_id: nodeId,
              kind: node.kind,
              title: node.title,
              phase_type: node.phase_type ?? null,
              path: typeof node.meta_json?.path === 'string' ? node.meta_json.path : null,
              summary_version: summary?.version ?? null,
              score: 1,
              meta: summary?.meta ?? null,
            }];
          });
          return { ok: true, data: { query: input?.query, path: 'oracle', fallback: null, hits, candidates: [], provenance: [], unavailable: [] } };
        }
        // Show the model what the ranker ranked on. A phase hit otherwise
        // renders as its title and whatever `meta.files`/`meta.symbols` the
        // summarizer happened to record, which for a phase node is routinely
        // nothing at all — so the model chooses between a hit reading
        // `phase/diagnosis "diagnosis"` and one reading `file "loop.ts"` and
        // picks the one that names something, however it was ranked. The
        // fingerprints are already extracted, already cached, and are the exact
        // evidence the score was computed from; only the MATCHING ones are
        // attached, so a 967-fingerprint branch costs a line, not a page.
        if (arm === 'tree-hit-keywords') {
          const outcome = await HANDLERS[CONTEXT_SEARCH](ctx, input);
          if (!outcome.ok || !Array.isArray(outcome.data?.hits)) return outcome;
          const fingerprints = fingerprintCacheOf(ctx.retriever);
          const queryTokens = tokensOf(input?.query ?? '');
          const ranked = outcome.data.hits.map((hit) => matchedFingerprints(fingerprints, hit.node_id, queryTokens));
          // How many per hit is not a choice to make in advance: take the most
          // that fits, measured on the rendered bytes in the tokenizer the
          // provider bills. The budget is the WHOLE live headroom, not a share
          // of it — rule 5, narrow to the budget the appending caller will
          // actually enforce. A share of it is what made the first version of
          // this arm a silent no-op: the bare 20-hit list is already 5,203
          // tokens against a 1,649-token quarter-share, so no keyword count
          // ever fit and the handler returned the baseline list unchanged.
          const budget = Math.max(0, ctx._liveHeadroom ?? 0);
          const render = (k) =>
            outcome.data.hits.map((hit, i) => (k > 0 && ranked[i].length > 0 ? { ...hit, keywords: ranked[i].slice(0, k) } : hit));
          let hits = outcome.data.hits;
          let chosen = 0;
          let low = 1;
          let high = ranked.reduce((m, list) => Math.max(m, list.length), 0);
          while (low <= high) {
            const k = Math.floor((low + high) / 2);
            const candidate = render(k);
            if (exact.count(JSON.stringify(candidate)) <= budget) {
              hits = candidate;
              chosen = k;
              low = k + 1;
            } else {
              high = k - 1;
            }
          }
          // The mechanism has to be visible in the row, or a null result cannot
          // be told apart from a mechanism that never fired — which is exactly
          // what the first version of this arm did.
          ctx._hitKeywordK = [...(ctx._hitKeywordK ?? []), chosen];
          return { ok: true, data: { ...outcome.data, hits } };
        }
        if (arm !== 'tree-escalate') return HANDLERS[CONTEXT_SEARCH](ctx, input);
        // Escalating search. Rank is whatever the retriever says; the change is
        // that the Nth search in a run returns the Nth group of UNSEEN
        // candidates. Group size is derived, never fixed: hits are admitted
        // while their measured rendered cost stays inside the share of the live
        // headroom a search result is allowed, floored at one so a search
        // always answers with something.
        const state = ctx._searchState ?? { seen: new Set(), calls: 0 };
        ctx._searchState = state;
        state.calls += 1;
        const base = ctx.config.retrieval.limit;
        // Deep enough that later groups exist to escalate INTO: without this the
        // second search re-ranks the same `base` rows and escalation is a no-op.
        const outcome = await HANDLERS[CONTEXT_SEARCH](ctx, { ...(input ?? {}), limit: base * 4 });
        if (!outcome.ok || !Array.isArray(outcome.data?.hits)) return outcome;
        const unseen = outcome.data.hits.filter((hit) => !state.seen.has(hit.node_id));
        const budget = Math.max(0, Math.floor((ctx._liveHeadroom ?? 0) * SEARCH_RESULT_HEADROOM_SHARE));
        const group = [];
        let spent = 0;
        for (const hit of unseen) {
          const cost = exact.count(JSON.stringify(hit));
          if (group.length > 0 && spent + cost > budget) break;
          group.push(hit);
          spent += cost;
          if (group.length === base * 2) break;
        }
        for (const hit of group) state.seen.add(hit.node_id);
        return {
          ok: true,
          data: {
            ...outcome.data,
            hits: group,
            // The model cannot tell an exhausted index from a narrow one
            // unless it is told which it is looking at.
            escalation: { call: state.calls, returned: group.length, already_seen: state.seen.size - group.length, more_available: unseen.length > group.length },
          },
        };
      },
      [CONTEXT_FETCH]: async (ctx, input) => {
        const args = input ?? {};
        const branchId = args.branch_id;
        if (!branchId) return { ok: false, error: { message: 'branch_id is required' } };
        try {
          // The real space left THIS turn, not half of a build-time estimate.
          // `_liveHeadroomHeuristic` is set per tool call by the turn loop, so
          // the retriever's relevance-centred cut is sized by exactly what the
          // append path would otherwise take back.
          const headroom = ctx._liveHeadroomHeuristic ?? Math.floor((ctx._headroom ?? 20000) / 2);
          const fetched = ctx.retriever.fetchBranch(branchId, {
            depth: 'full',
            file: args.file,
            from: args.from,
            to: args.to,
            maxTokens: headroom,
            query: lastSearchQuery,
          });
          return { ok: true, data: {
            branch_id: fetched.nodeId, kind: fetched.kind, title: fetched.title,
            phase_type: fetched.phaseType, depth: fetched.depth, file: fetched.file ?? null,
            summary_version: fetched.summaryVersion, meta: fetched.meta,
            nodes: fetched.nodes, spans: fetched.spans, events: fetched.events, text: fetched.text,
          }};
        } catch (error) {
          return { ok: false, error: { message: error.message } };
        }
      },
    };
  }
  return {
    ...HANDLERS,
    [CONTEXT_FETCH]: (ctx, input) => HANDLERS[CONTEXT_FETCH](ctx, { depth: 'summary', ...(input ?? {}) }),
    [CONTEXT_SEARCH]: async (ctx, input) => {
      const outcome = await HANDLERS[CONTEXT_SEARCH](ctx, input);
      if (!outcome.ok) return outcome;
      return { ok: true, data: { ...outcome.data, hits: await legacySearchHits(ctx, input ?? {}) } };
    },
  };
}

/**
 * `annotate` is in Zone A because the design's Zone-A sizing and Step 5 smoke
 * are both specified over the four-tool contract — but its handler re-runs the
 * hermetic ingest pipeline, which would re-mint node ids on a store Step 1
 * froze. Offering it and refusing it is the only way to hold both rules: the
 * schema is present for sizing and for the smoke's parseable-args question,
 * and a model that actually calls it gets an error instead of a mutated epoch.
 */
const FROZEN_ANNOTATE_REFUSAL = Object.freeze({
  ok: false,
  error: {
    code: 'invalid_input',
    message:
      'annotate is disabled in the transplant harness: L1 was frozen at Step 1 and annotate re-runs ingestion, ' +
      'which would re-mint node ids mid-experiment. Use context_search / context_fetch / context_peek.',
  },
});

/**
 * Assembles at an EXPLICIT keep — the primitive the rootKeep derivation walks
 * the ladder with, and which `buildTreePrompt` is the guarded wrapper around.
 * Split out precisely so the derivation can test the real thing rather than a
 * model of it.
 */
function assembleTreeAt(scenario, budgets, rootKeep, { withTools, expectedSha, systemText = TREE_SYSTEM }) {
  // Routed through `composeRootAt` so an already-composed root is a no-op
  // rather than another appended version (D3 keeps every one of them).
  composeRootAt(scenario, rootKeep, expectedSha);
  const assembler = new ZoneAssembler({
    store: scenario.store,
    blobs: scenario.blobs,
    trace: scenario.trace,
    tokenizer: heuristic,
    systemContract: systemText,
    budgets: { zoneB: budgets.zoneB, zoneC: budgets.zoneC },
  });
  const prompt = assembler.assemble({ toolSchemasText: withTools ? TOOL_SCHEMAS_TEXT : '' });
  return { assembler, prompt };
}

function buildTreePrompt(scenario, budgets, { withTools, systemText }) {
  if (budgets.rootKeep === null || budgets.rootKeep === undefined) {
    throw new Error(
      `W=${budgets.window}: no rootKeep on the ladder [${ROOT_KEEP_LADDER.join(', ')}] produces a Zone B that fits ` +
        `${budgets.zoneB} tokens with at least one branch summary surviving — this cell is dead, publish the ` +
        'surviving windows and record the reason (do not force the fit)',
    );
  }
  return assembleTreeAt(scenario, budgets, budgets.rootKeep, {
    withTools,
    expectedSha: budgets.rootSummarySha,
    ...(systemText === undefined ? {} : { systemText }),
  });
}

/** truncate-tail: newest L0 events whose cumulative heuristic cost fits K. */
function buildTruncatedTail(scenario, budgets) {
  const events = scenario.trace.all();
  const from = truncationBoundarySeq(events, scenario.blobs, budgets.K);
  const kept = events.filter((event) => event.seq >= from);
  return { text: renderNativeTranscript(kept, scenario.blobs), fromSeq: from, events: kept.length };
}

// ── gates (checklist items 1-14) ─────────────────────────────────────────
function pass(id, detail, data = {}) {
  return { id, status: 'PASS', detail, ...data };
}
function fail(id, detail, data = {}) {
  return { id, status: 'FAIL', detail, ...data };
}
function defer(id, detail, data = {}) {
  return { id, status: 'DEFER', detail, ...data };
}

/** Copies L0+L2 to a scratch root and re-derives L1 from them alone (D8, D15). */
function rederive(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-transplant-rederive-'));
  try {
    mkdirSync(join(dir, 'store'), { recursive: true });
    cpSync(scenario.paths.trace, join(dir, 'store', 'trace.jsonl'));
    cpSync(scenario.paths.blobs, join(dir, 'store', 'blobs'), { recursive: true });
    const handle = openTaskStore({ ...scenario.config, root: join(dir, 'store') });
    try {
      const { stats } = ingest({ handle });
      return { stats, dump: nodeDump(handle.store) };
    } finally {
      handle.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── loop-9b item 2, Step 7: the G0-G9 gates ──────────────────────────────
// `eval/plans/loop9b-item2-judge-verdict.md` §4 Step 7. Separate id space
// from `GATE_IDS` (g1-g15, the standing checklist) — these gate the loop-9b
// item-2 change set specifically and are additive to it.
export const G_GATE_IDS = Object.freeze([
  'G0-no-literal-in-summary',
  'G1-search-payload-size',
  'G2-index-read-hermetic',
  'G3-range-clamping',
  'G4-meta-parity',
  'G4b-no-trace-typed-failure',
  'G5-zone-a-stability',
  'G6-semantic-rank-offline',
  'G7-tool-call-logging',
  'G8-freeze-holds',
  'G9-visibility-table',
]);

/** G0 — J1's premise, recomputed each loop: no answer literal/regex in ANY summary version, ever. */
export function checkG0NoLiteralInSummaries(store, questions, hasSummaries) {
  if (!hasSummaries) return defer('G0-no-literal-in-summary', 'node_summaries is empty — run after the summarize pass');
  if (questions === null) return defer('G0-no-literal-in-summary', 'no questions.json — run --phase prep --allow-live');
  let checked = 0;
  const hits = [];
  for (const node of store.nodesInCreationOrder()) {
    for (const summary of store.summaryVersions(node.id)) {
      checked += 1;
      const haystack = `${summary.text}\n${JSON.stringify(summary.meta)}`;
      for (const q of questions) {
        for (const literal of q.answer_literals ?? []) {
          if (haystack.includes(literal)) hits.push(`${q.id}: literal ${JSON.stringify(literal)} in ${node.id}@v${summary.version}`);
        }
        for (const re of q.answer_regexes ?? []) {
          if (new RegExp(re).test(haystack)) hits.push(`${q.id}: regex ${JSON.stringify(re)} in ${node.id}@v${summary.version}`);
        }
      }
    }
  }
  return hits.length === 0
    ? pass(
        'G0-no-literal-in-summary',
        `0 hits over ${checked} summary version row(s) x ${questions.length} question(s) — a context_fetch that ` +
          'returns a summary cannot score on this question set, by construction',
      )
    : fail('G0-no-literal-in-summary', hits.slice(0, 10).join('; '));
}

/** G1 — the context_search payload arithmetic (J4), as a measurement instead of an estimate. */
async function checkG1SearchPayloadSize(ctx, hasSummaries) {
  if (!hasSummaries) return defer('G1-search-payload-size', 'node_summaries is empty — nothing for context_search to rank');
  const outcome = await HANDLERS[CONTEXT_SEARCH](ctx, { query: 'implementation' });
  if (!outcome.ok) return fail('G1-search-payload-size', `context_search failed: ${outcome.error.message}`);
  const tokens = exact.count(JSON.stringify(outcome.data));
  const leakedSnippets = outcome.data.hits.filter((h) => typeof h.snippet === 'string' || typeof h.text === 'string');
  const ok = tokens <= 5_000 && leakedSnippets.length === 0;
  return (ok ? pass : fail)(
    'G1-search-payload-size',
    `${tokens} cl100k tokens over ${outcome.data.hits.length} hit(s) at limit=${ctx.config.retrieval.limit} ` +
      `(threshold 5000; leaked snippet/text fields: ${leakedSnippets.length}; pre-fix was 9673 tok)`,
    { tokens },
  );
}

/** G2 — `depth:'index'` is deterministic, in-span, capped, and reads zero blob text (D15 hermeticity). */
function checkG2IndexRead(scenario, hasSummaries) {
  if (!hasSummaries) return defer('G2-index-read-hermetic', 'node_summaries is empty — nothing summarized to index');
  const calls = { full: 0, prefix: 0 };
  const spiedBlobs = {
    root: scenario.blobs.root,
    put: (c) => scenario.blobs.put(c),
    digest: (c) => scenario.blobs.digest(c),
    pathFor: (r) => scenario.blobs.pathFor(r),
    has: (r) => scenario.blobs.has(r),
    size: (r) => scenario.blobs.size(r),
    get: (r) => {
      calls.full += 1;
      return scenario.blobs.get(r);
    },
    getText: (r) => {
      calls.full += 1;
      return scenario.blobs.getText(r);
    },
    getTextPrefix: (r, n) => {
      calls.prefix += 1;
      return scenario.blobs.getTextPrefix(r, n);
    },
  };
  const retriever = new TreeRetriever({ store: scenario.store, blobs: spiedBlobs, trace: scenario.trace });
  const problems = [];
  let checked = 0;
  for (const node of scenario.store.nodesInCreationOrder()) {
    if (node.span_start_seq === null) continue;
    checked += 1;
    const first = retriever.fetchBranch(node.id, { depth: 'index' });
    const second = retriever.fetchBranch(node.id, { depth: 'index' });
    if (first.text !== second.text) problems.push(`${node.id}: index text differs across two calls`);
    const rows = first.text.length === 0 ? 0 : first.text.split('\n').length;
    if (rows > 121) problems.push(`${node.id}: ${rows} rows exceeds the 120-row + elision cap`);
    const nodeEnd = node.span_end_seq ?? node.span_start_seq;
    for (const span of first.spans) {
      if (span.start < node.span_start_seq || span.end > nodeEnd) {
        problems.push(`${node.id}: index span [${span.start},${span.end}] outside the node's own span`);
      }
    }
  }
  if (calls.full !== 0 || calls.prefix !== 0) {
    problems.push(`index read touched blob content: ${calls.full} full + ${calls.prefix} prefix call(s) (must be L0+stat only)`);
  }
  return problems.length === 0
    ? pass('G2-index-read-hermetic', `${checked} node(s): index deterministic, in-span, capped at 120 rows, zero blob-text reads`)
    : fail('G2-index-read-hermetic', problems.slice(0, 10).join('; '));
}

/** G3 — from/to clamping: over-wide == no range, disjoint == empty (no throw), and the partition identity. */
function checkG3RangeClamping(scenario, hasSummaries) {
  if (!hasSummaries) return defer('G3-range-clamping', 'node_summaries is empty — nothing to clamp a range over');
  const retriever = new TreeRetriever({ store: scenario.store, blobs: scenario.blobs, trace: scenario.trace });
  const node = scenario.store
    .nodesInCreationOrder()
    .find((n) => n.span_start_seq !== null && (n.span_end_seq ?? n.span_start_seq) > n.span_start_seq + 1);
  if (node === undefined) return defer('G3-range-clamping', 'no node with a >=3-event span to partition');
  const start = node.span_start_seq;
  const end = node.span_end_seq ?? node.span_start_seq;
  const full = retriever.fetchBranch(node.id, { depth: 'full' });
  const overWide = retriever.fetchBranch(node.id, { depth: 'full', from: start - 1_000, to: end + 1_000 });
  const disjointFrom = end + 1_000;
  const disjoint = retriever.fetchBranch(node.id, { depth: 'full', from: disjointFrom, to: disjointFrom + 5 });
  const mid = Math.floor((start + end) / 2);
  const partA = retriever.fetchBranch(node.id, { depth: 'full', to: mid });
  const partB = retriever.fetchBranch(node.id, { depth: 'full', from: mid + 1 });
  const joined = [partA.text, partB.text].filter((t) => t.length > 0).join('\n\n');

  const problems = [];
  if (overWide.text !== full.text) problems.push('an over-wide range differs from no range');
  if (disjoint.text !== '' || disjoint.spans.length !== 0) problems.push('a disjoint range did not yield empty text/spans');
  if (joined !== full.text) problems.push('concatenating a partition of the span is not byte-identical to depth:full');
  return problems.length === 0
    ? pass(
        'G3-range-clamping',
        `node ${node.id} [${start}-${end}]: over-wide==full, disjoint==empty (no throw), ` +
          `partition [${start}-${mid}]+[${mid + 1}-${end}] concatenates byte-identical to depth:'full'`,
      )
    : fail('G3-range-clamping', problems.join('; '));
}

/** G4 — meta parity across depths (2h's removal of the `meta: null` special case). */
function checkG4MetaParity(scenario, hasSummaries) {
  if (!hasSummaries) return defer('G4-meta-parity', 'node_summaries is empty — nothing summarized to compare');
  const retriever = new TreeRetriever({ store: scenario.store, blobs: scenario.blobs, trace: scenario.trace });
  const problems = [];
  let checked = 0;
  for (const node of scenario.store.nodesInCreationOrder()) {
    if (scenario.store.currentSummary(node.id) === null) continue;
    checked += 1;
    const full = retriever.fetchBranch(node.id, { depth: 'full' });
    const summary = retriever.fetchBranch(node.id, { depth: 'summary' });
    if (JSON.stringify(full.meta) !== JSON.stringify(summary.meta)) {
      problems.push(`${node.id}: fetch(full).meta != fetch(summary).meta`);
    }
  }
  return problems.length === 0
    ? pass('G4-meta-parity', `${checked} summarized node(s): fetch(depth:'full').meta deep-equals fetch(depth:'summary').meta`)
    : fail('G4-meta-parity', problems.join('; '));
}

/** G4b — a trace-less retriever's default (now 'full') fetch is a typed tool failure, not a crash. */
async function checkG4bNoTraceTypedFailure(ctx) {
  const node = ctx.handle.store.root();
  if (node === null) return defer('G4b-no-trace-typed-failure', 'no root node to fetch');
  const noTraceCtx = { ...ctx, retriever: new TreeRetriever({ store: ctx.handle.store, blobs: ctx.handle.blobs }) };
  const outcome = await HANDLERS[CONTEXT_FETCH](noTraceCtx, { branch_id: node.id });
  if (outcome.ok) return fail('G4b-no-trace-typed-failure', 'expected a failure (default depth is full and needs a trace), got success');
  return outcome.error.code === 'unavailable'
    ? pass('G4b-no-trace-typed-failure', `typed failure, not a crash: ${outcome.error.code} — "${outcome.error.message.slice(0, 90)}"`)
    : fail('G4b-no-trace-typed-failure', `expected error code 'unavailable', got '${outcome.error.code}'`);
}

/** G5 — Zone A refits after Steps 2-4: rootKeep unchanged vs the frozen manifest, g8/g9/g10 PASS, contract v3 has 3 rules. */
function checkG5ZoneAStability(scenario, table, armTable, results) {
  const manifest = readManifest(scenario);
  if (manifest?.root_by_window === undefined) {
    return defer('G5-zone-a-stability', 'no manifest.root_by_window to compare rootKeep against — run --phase prep first');
  }
  const problems = [];
  for (const w of WINDOWS) {
    for (const arm of ['tree', 'tree-wide']) {
      const frozenKeep = manifest.root_by_window[String(w)]?.[arm]?.rootKeep ?? null;
      const liveKeep = armTable[w]?.[arm]?.rootKeep ?? null;
      if (frozenKeep !== liveKeep) problems.push(`W=${w}/${arm}: rootKeep ${frozenKeep} -> ${liveKeep} after the schema/contract edits`);
    }
    if ((table[w]?.overBudget ?? []).length > 0) problems.push(`W=${w}: overBudget=${table[w].overBudget.join(',')}`);
  }
  for (const id of ['g8-over-budget', 'g9-zone-b-nesting', 'g10-prefix-stability']) {
    const gate = results.find((r) => r.id === id);
    if (gate?.status !== 'PASS') problems.push(`${id}=${gate?.status ?? 'MISSING'}`);
  }
  const v3RuleCount = (systemContract('v3').match(/^\d+\.\s/gm) ?? []).length;
  if (v3RuleCount !== 3) problems.push(`contract v3 has ${v3RuleCount} numbered rules, expected 3`);
  const zoneAv1 = heuristic.count(systemContract('v1') + TOOL_SCHEMAS_TEXT);
  const zoneAv3 = heuristic.count(systemContract('v3') + TOOL_SCHEMAS_TEXT);
  return problems.length === 0
    ? pass(
        'G5-zone-a-stability',
        `rootKeep unchanged at W=${WINDOWS.join(',')} for tree+tree-wide; g8/g9/g10 PASS; contract v3 has 3 rules; ` +
          `Zone A heuristic tokens v1=${zoneAv1} v3=${zoneAv3} (never raised to fit the prose)`,
      )
    : fail('G5-zone-a-stability', problems.join('; '));
}

/**
 * G6 — the semantic question answered offline (Graft 4): embed a COPY of the
 * frozen store (never the fixture itself — D15/G8), recompute all self-
 * retrieval ranks on the vector path at `topK = 5`, and compare against the
 * lexical g15 ranks already computed over the SAME questions. Kill condition
 * (`JUDGE-VERDICT.md` Graft 4): vector strict-top-5 < 4/12, or vector median
 * rank >= lexical's median -> `tree-semantic` stays registered but disabled
 * for the live batch and this offline table is published as the result.
 * Spends real money (an embeddings call, sub-cent) — the one live call this
 * pass is permitted to make.
 */
async function checkG6SemanticRankOffline(scenario, questions, lexicalRows) {
  if (questions === null) return defer('G6-semantic-rank-offline', 'no questions.json — run --phase prep --allow-live');
  const keys = loadApiKeys();
  if (keys.openai === undefined && keys.openrouter === undefined) {
    return defer('G6-semantic-rank-offline', 'no OPENAI_API_KEY/OPENROUTER_API_KEY — cannot embed a store copy');
  }
  let semantic;
  try {
    semantic = await buildSemanticToolCtx(scenario);
  } catch (error) {
    return defer('G6-semantic-rank-offline', `embedding a store copy failed: ${error.message}`);
  }
  try {
    const rows = [];
    for (const q of questions) {
      const usable = questionTextValid(q.question);
      rows.push(
        usable.ok
          ? { id: q.id, ...(await selfRetrieval(q, semantic.toolCtx, { topK: 999, rootId: scenario.store.root()?.id ?? null })) }
          : { id: q.id, ok: false, rank: null, ranked: 0 },
      );
    }
    const vectorRanks = rows.map((r) => r.rank).filter((r) => r !== null);
    const lexicalRanks = (lexicalRows ?? []).map((r) => r.rank).filter((r) => r !== null);
    const median = (xs) => {
      if (xs.length === 0) return null;
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    };
    const strictTop5 = vectorRanks.filter((r) => r <= 5).length;
    const vectorMedian = median(vectorRanks);
    const lexicalMedian = median(lexicalRanks);
    const killed =
      strictTop5 < 4 || (vectorMedian !== null && lexicalMedian !== null && vectorMedian >= lexicalMedian);
    return defer(
      'G6-semantic-rank-offline',
      `vector strict-top-5 ${strictTop5}/${rows.length}, vector median rank ${vectorMedian ?? 'n/a'} vs lexical ` +
        `median rank ${lexicalMedian ?? 'n/a'} — ` +
        (killed
          ? 'KILLED: tree-semantic stays disabled for the live batch; this offline rank table is the semantic result'
          : 'PASSES the kill condition: tree-semantic is eligible for the live batch, still not run here'),
      { rows, strictTop5, vectorMedian, lexicalMedian, killed },
    );
  } finally {
    semantic.cleanup();
  }
}

/**
 * G7 — the mocked six-turn loop: `call.input` reaches the row verbatim,
 * `hitIds` is populated per search, `headroom` is recorded per append,
 * derived `searchQueries`/`fetchedIds` match a replayed fixture, and
 * `literalInToolResult` splits a `depth:'full'` fetch from a `depth:'summary'`
 * one of the SAME branch — the assertion that makes the whole mechanism
 * analysis falsifiable rather than a just-so story.
 */
export async function checkG7ToolCallLogging() {
  const NODE = 'n_g7_probe';
  const LITERAL = 'sentinel_g7_9182';
  const budgets = { window: 32_768, maxReplyTokens: 800, zoneC: 4_096 };
  const built = {
    system: 'g7 system',
    messages: [{ role: 'user', content: 'g7 context' }],
    tools: [{ name: CONTEXT_SEARCH }, { name: CONTEXT_FETCH }],
    handlers: {
      [CONTEXT_SEARCH]: async () => ({ ok: true, data: { hits: [{ node_id: NODE }] } }),
      [CONTEXT_FETCH]: async (_ctx, input) => ({
        ok: true,
        data: { text: input.depth === 'full' ? `full detail: ${LITERAL}` : 'a lossy paraphrase, no literal here' },
      }),
    },
    toolCtx: {},
  };

  let turn = 0;
  const fullProvider = {
    id: 'g7-full',
    async complete(request) {
      turn += 1;
      const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
      if (turn === 1) {
        return {
          text: '',
          model: request.model,
          usage,
          toolCalls: [{ id: 'c1', name: CONTEXT_SEARCH, input: { query: 'g7 probe' } }],
          stopReason: 'tool_use',
        };
      }
      if (turn === 2) {
        return {
          text: '',
          model: request.model,
          usage,
          toolCalls: [{ id: 'c2', name: CONTEXT_FETCH, input: { branch_id: NODE, depth: 'full' } }],
          stopReason: 'tool_use',
        };
      }
      return { text: 'done', model: request.model, usage, toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const r = await runOneReplicate(null, built, 'g7 question', 'g7-model', fullProvider, budgets, [LITERAL]);

  const problems = [];
  if (r.toolCalls?.length !== 2) problems.push(`expected 2 logged tool calls, got ${r.toolCalls?.length}`);
  const [c1, c2] = r.toolCalls ?? [];
  if (c1?.input?.query !== 'g7 probe') problems.push('call.input was not logged verbatim for the search call');
  if (!Array.isArray(c1?.hitIds) || c1.hitIds[0] !== NODE) problems.push('hitIds was not populated for a search call');
  if (typeof c1?.headroom !== 'number' || typeof c2?.headroom !== 'number') problems.push('headroom was not recorded per append');
  if (r.searchQueries.join(',') !== 'g7 probe' || r.fetchedIds.join(',') !== NODE) {
    problems.push('derived searchQueries/fetchedIds do not match the replayed fixture');
  }
  if (r.literalInToolResult !== true) problems.push("literalInToolResult did not flip true on the depth:'full' fetch");

  // The SAME branch, fetched at depth:'summary' only — literalInToolResult must stay false.
  let turn2 = 0;
  const summaryOnlyProvider = {
    id: 'g7-summary',
    async complete(request) {
      turn2 += 1;
      const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
      if (turn2 === 1) {
        return {
          text: '',
          model: request.model,
          usage,
          toolCalls: [{ id: 'c1', name: CONTEXT_FETCH, input: { branch_id: NODE, depth: 'summary' } }],
          stopReason: 'tool_use',
        };
      }
      return { text: 'done', model: request.model, usage, toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const r2 = await runOneReplicate(null, built, 'g7 question 2', 'g7-model', summaryOnlyProvider, budgets, [LITERAL]);
  if (r2.literalInToolResult !== false) problems.push('literalInToolResult was true for a depth:"summary"-only fetch of the same branch');
  if (r.zoneCTokens !== budgets.zoneC) problems.push('zoneCTokens on the row did not carry deriveBudgets\' zoneC');

  return problems.length === 0
    ? pass(
        'G7-tool-call-logging',
        'mocked loop: call.input verbatim, hitIds populated, headroom recorded per append, searchQueries/' +
          'fetchedIds derived correctly, literalInToolResult splits full-depth from summary-depth fetches',
      )
    : fail('G7-tool-call-logging', problems.join('; '));
}

/** G8 — the freeze holds: this pass writes L3 in a copy only (never the fixture) and never touches nodes/node_summaries. */
export function checkG8FreezeHolds(results) {
  const ids = ['g1-trace-sha', 'g5-rebuild-determinism', 'g13-manifest-hashed'];
  const problems = ids
    .filter((id) => results.find((r) => r.id === id)?.status !== 'PASS')
    .map((id) => `${id}=${results.find((r) => r.id === id)?.status ?? 'MISSING'}`);
  return problems.length === 0
    ? pass(
        'G8-freeze-holds',
        'g1 (trace sha), g5 (L1 rebuild determinism) and g13 (manifest hash) all PASS — nodes/node_summaries ' +
          'untouched by this pass; G6 never populates L3 outside a store copy',
      )
    : defer('G8-freeze-holds', problems.join('; '));
}

/** G9 — Graft 3's free substitute for the head escalation: is each primary question already visible in Zone B, under tree AND tree-wide? */
export function checkG9VisibilityTable(scenario, armTable, questions) {
  if (questions === null) return defer('G9-visibility-table', 'no questions.json — run --phase prep --allow-live');
  const primary = questions.filter((q) => PRIMARY_STRATA.includes(q.stratum));
  const rows = primary.map((q) => {
    const visible = {};
    for (const w of WINDOWS) {
      const arms = {};
      for (const arm of ['tree', 'tree-wide']) {
        const range = armTable[w]?.[arm]?.branchSeqRange;
        arms[arm] = range !== null && range !== undefined && q.seq >= range.from && q.seq <= range.to;
      }
      visible[w] = arms;
    }
    return { id: q.id, stratum: q.stratum, seq: q.seq, visible };
  });
  console.log(
    "\n=== G9 visibility table (Graft 3) — is each primary question's source already visible in Zone B? ===",
  );
  console.log(`| question | stratum | seq | ${WINDOWS.flatMap((w) => ['tree', 'tree-wide'].map((a) => `${a}@${w}`)).join(' | ')} |`);
  for (const row of rows) {
    console.log(
      `| ${row.id} | ${row.stratum} | ${row.seq} | ` +
        WINDOWS.flatMap((w) => ['tree', 'tree-wide'].map((a) => row.visible[w][a])).join(' | ') +
        ' |',
    );
  }
  // Reported as data, not pass/fail (the spec: "produces a table") — the free
  // substitute for the pre-registered head escalation between tree/tree-wide.
  return {
    id: 'G9-visibility-table',
    status: 'INFO',
    detail: `${rows.length} primary question(s) checked under tree + tree-wide at W=${WINDOWS.join(',')}`,
    rows,
  };
}

async function runGates(scenario, options) {
  const results = [];
  const summaries = summaryBodies(scenario.store);
  const hasSummaries = summaries.size > 0;
  const events = scenario.trace.all();

  // 1 — trace sha + byte length recorded.
  if (scenario.traceSha === null) {
    results.push(fail('g1-trace-sha', `no trace.src.jsonl at ${scenario.src}`));
  } else {
    results.push(
      pass('g1-trace-sha', `sha256=${scenario.traceSha} bytes=${scenario.traceBytes}`, {
        sha256: scenario.traceSha,
        bytes: scenario.traceBytes,
      }),
    );
  }

  // 2 + 4 + 5 — one offline re-derivation answers three questions: it ran with
  // no network (hermetic), it named no unmapped tool, and it produced the same
  // node ids and spans as the frozen L1.
  let rederived = null;
  try {
    rederived = rederive(scenario);
    results.push(
      pass('g2-hermetic-import', `ingest() re-derived L1 from L0+L2+tree-sitter alone: ${rederived.stats.events} events, ${rederived.stats.phases} phases`),
    );
    results.push(
      rederived.stats.unmappedTools.length === 0
        ? pass('g4-unmapped-tools', 'unmapped tools -> "other" list is empty')
        : fail('g4-unmapped-tools', `unmapped: ${rederived.stats.unmappedTools.join(', ')} — add them to toolPhase`),
    );
    const frozenDump = nodeDump(scenario.store);
    results.push(
      rederived.dump === frozenDump
        ? pass('g5-rebuild-determinism', `node ids + spans identical after re-derivation (${sha256(frozenDump).slice(0, 12)})`)
        : fail('g5-rebuild-determinism', 're-derived L1 differs from the frozen L1 — L1 is not a function of L0+L2'),
    );
  } catch (error) {
    results.push(fail('g2-hermetic-import', `ingest() threw: ${error.message}`));
    results.push(defer('g4-unmapped-tools', 're-derivation failed'));
    results.push(defer('g5-rebuild-determinism', 're-derivation failed'));
  }

  // 3 — isMeta lines counted as skipped, zero imported as user turns.
  if (scenario.traceSha === null) {
    results.push(defer('g3-ismeta-skipped', 'no trace.src.jsonl to map'));
  } else {
    const { mapClaudeCodeTranscript } = await import(join(REPO, 'packages/cli/dist/index.js'));
    const dir = mkdtempSync(join(tmpdir(), 'ct-transplant-map-'));
    try {
      const lines = readFileSync(scenario.src, 'utf8').split('\n');
      const scratch = new FsBlobStore(join(dir, 'blobs'));
      const mapped = mapClaudeCodeTranscript(lines, { startSeq: 0, blobs: scratch });
      const metaTexts = new Set();
      for (const raw of lines) {
        if (raw.trim().length === 0) continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        if (parsed?.isMeta === true) metaTexts.add(JSON.stringify(parsed.message?.content ?? null));
      }
      const imported = mapped.events
        .filter((event) => event.type === 'user_message')
        .map((event) => scratch.getText(event.blob));
      const leaked = imported.filter((text) => [...metaTexts].some((meta) => meta.includes(text) && text.length > 0));
      results.push(
        metaTexts.size === 0
          ? fail('g3-ismeta-skipped', 'no isMeta:true lines in the source — the assertion is vacuous, check the substrate')
          : leaked.length === 0
            ? pass('g3-ismeta-skipped', `${metaTexts.size} isMeta line(s) counted into skipped=${mapped.skipped}; 0 imported as user turns`)
            : fail('g3-ismeta-skipped', `${leaked.length} isMeta payload(s) reached L0 as user turns`),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 6 — the native transcript, in real cl100k tokens, exceeds both windows.
  const native = renderNativeTranscript(events, scenario.blobs);
  const nativeExact = exact.count(native);
  const nativeHeuristic = heuristic.count(native);
  const overAll = WINDOWS.every((w) => nativeExact > w);
  results.push(
    (overAll ? pass : fail)(
      'g6-native-exceeds-window',
      `native transcript = ${nativeExact} cl100k tokens (heuristic ${nativeHeuristic}); ` +
        WINDOWS.map((w) => `${(nativeExact / w).toFixed(2)}x W=${w}`).join(', '),
      { nativeExact, nativeHeuristic, nativeChars: native.length },
    ),
  );

  // 7 — the ratio, the slack re-floor, and the kill condition.
  const sample = l0Sample(scenario.blobs, scenario.paths.blobs);
  const sampleHeuristic = heuristic.count(sample);
  const sampleExact = exact.count(sample);
  const ratio = sampleExact / sampleHeuristic;
  const verdict = ratioVerdict(ratio);
  results.push(
    (verdict.ok ? pass : fail)(
      'g7-bpe-ratio',
      `ratio = ${sampleExact}/${sampleHeuristic} = ${ratio.toFixed(6)} over all ${blobRefsOf(scenario.paths.blobs).length} L2 blobs; ` +
        `${verdict.action}${verdict.ok ? '' : ` (kill condition ratio > ${RATIO_KILL})`}`,
      { ratio, sampleExact, sampleHeuristic, slackFraction: verdict.slackFraction },
    ),
  );

  // The derived budget table — printed here because every later gate reads it.
  // Budgets per window, with `rootKeep` derived (D19 extended) — the store is
  // left composed at the LAST window's keep, so every consumer below composes
  // its own before assembling.
  const table = {};
  const armTable = {};
  for (const w of WINDOWS) {
    armTable[w] = {};
    for (const arm of ['tree', 'tree-wide']) armTable[w][arm] = budgetsFor(scenario, w, ratio, verdict.slackFraction, arm);
    table[w] = armTable[w].tree;
  }

  // 8 — overBudget == [] at both W with the derived budgets, AND at least one
  // branch summary survives. The second half is not decoration: the root is
  // exempt from rule-4 dropping, so a root that eats Zone B leaves a "passing"
  // prompt whose Zone B is root-only — a flattened summary wearing the tree's
  // costs, and the `tail` stratum would be scored against it as if it were a
  // tree. The derived `rootKeep` is what makes room; this asserts it worked.
  const survivors = {};
  if (!hasSummaries) {
    results.push(defer('g8-over-budget', 'node_summaries is empty — Zone B has no content to size; run after the summarize pass'));
  } else {
    const problems = [];
    const parts = [];
    for (const w of WINDOWS) {
      for (const arm of ['tree', 'tree-wide']) {
        const budgets = armTable[w][arm];
        if (budgets.rootKeep === null) {
          problems.push(
            `W=${w}/${arm}: no rootKeep produces a Zone B fitting ${budgets.zoneB} tokens with a branch summary ` +
              `surviving (root ${budgets.rootBlockTokens} tok, ${budgets.branchesSurviving} branch(es)) — cell is dead`,
          );
          continue;
        }
        const { prompt } = buildTreePrompt(scenario, budgets, { withTools: true });
        const branchBlocks = prompt.blocks.filter((b) => b.zone === 'B' && !b.id.startsWith('B:root'));
        const count = new Set(branchBlocks.map((b) => b.nodeId ?? b.id)).size;
        survivors[`${w}/${arm}`] = count;
        if (prompt.budgets.overBudget.length > 0) problems.push(`W=${w}/${arm}: overBudget=${prompt.budgets.overBudget.join(',')}`);
        if (count < 1) problems.push(`W=${w}/${arm}: Zone B is root-only — 0 branch summaries survived`);
        parts.push(`W=${w}/${arm} -> ${count}/${summaries.size - 1} (keep${budgets.rootKeep}, root ${budgets.rootBlockTokens} tok)`);
      }
    }
    results.push(
      problems.length === 0
        ? pass('g8-over-budget', `overBudget == [] for every (W, arm); branch summaries surviving: ${parts.join(', ')}`, { survivors: { ...survivors } })
        : fail('g8-over-budget', problems.join('; '), { survivors: { ...survivors } }),
    );
  }

  // 9 — Zone B nesting across the portability sweep (Graft 3, D5).
  //
  // Originally written as a PREFIX-subset check, which is the wrong shape and
  // would have failed for a healthy reason: rule-4 degradation drops the
  // OLDEST branches first, so a smaller window keeps the NEWEST branches — its
  // branch list is a contiguous SUFFIX of the larger window's, not a prefix.
  // (Measured: at W=65536 root+branches exceed the Zone B budget and the two
  // oldest branches drop.) The root block is excluded outright: `rootKeep` is
  // now derived per window, so the root legitimately differs between them.
  // What still must hold is that the tree grows newest-aligned and in creation
  // order, which is exactly what a contiguous suffix asserts.
  const nesting = [];
  const dead = [];
  if (!hasSummaries) {
    results.push(defer('g9-zone-b-nesting', 'node_summaries is empty — the nesting sweep would be vacuously true'));
  } else {
    const problems = [];
    for (const arm of ['tree', 'tree-wide']) {
    for (const w of NESTING_WINDOWS) {
      const budgets = budgetsFor(scenario, w, ratio, verdict.slackFraction, arm);
      if (budgets.rootKeep === null) {
        // A dead window renders no Zone B at all, so it is not a nesting
        // counter-example — it is a missing row. Named here, adjudicated by
        // gate 8 for the primary windows.
        dead.push(`${arm}@W=${w} (zoneB ${budgets.zoneB}; no keep leaves a branch; root ${budgets.rootBlockTokens} tok)`);
        continue;
      }
      const { prompt } = buildTreePrompt(scenario, budgets, { withTools: true });
      nesting.push({
        arm,
        w,
        rootKeep: budgets.rootKeep,
        rootBlockTokens: budgets.rootBlockTokens,
        branchIds: prompt.blocks.filter((b) => b.zone === 'B' && !b.id.startsWith('B:root')).map((b) => b.id),
        overBudget: prompt.budgets.overBudget,
      });
    }
    }
    // Nesting is asserted WITHIN an arm: the two arms walk opposite ends of
    // the ladder, so their Zone Bs are not expected to nest into each other.
    for (const arm of ['tree', 'tree-wide']) {
      const rows = nesting.filter((r) => r.arm === arm);
      for (let i = 0; i < rows.length - 1; i += 1) {
        if (!isContiguousSuffix(rows[i].branchIds, rows[i + 1].branchIds)) {
          problems.push(`${arm}: W=${rows[i].w} branch list is not a contiguous suffix of W=${rows[i + 1].w}`);
        }
      }
    }
    for (const row of nesting) {
      if (row.overBudget.length > 0) problems.push(`${row.arm} W=${row.w} overBudget=${row.overBudget.join(',')}`);
    }
    results.push(
      problems.length === 0
        ? pass(
            'g9-zone-b-nesting',
            'Zone B branch lists nest newest-aligned across W ∈ ' +
              `{${nesting.map((r) => `${r.arm}@${r.w}:${r.branchIds.length}b/keep${r.rootKeep}`).join(', ')}}; ` +
              'creation order intact, root excluded (derived per window)' +
              (dead.length === 0 ? '' : ` — DEAD, no Zone B renders: ${dead.join(', ')}`),
            { nesting: nesting.map(({ arm, w, rootKeep, rootBlockTokens, branchIds }) => ({ arm, w, rootKeep, rootBlockTokens, branches: branchIds.length })) },
          )
        : fail('g9-zone-b-nesting', problems.join('; ')),
    );
  }

  // 10 — mocked-LLM dry run: the Zone A+B prefix is byte-identical across reps
  // and across questions within an arm, and a fetch result lands after Zone C.
  const liveWindow = WINDOWS.find((w) => table[w].rootKeep !== null);
  if (!hasSummaries) {
    results.push(defer('g10-prefix-stability', 'node_summaries is empty — no Zone B prefix to compare'));
  } else if (liveWindow === undefined) {
    results.push(defer('g10-prefix-stability', 'every primary window is dead (no rootKeep fits) — nothing assembles to compare'));
  } else {
    const budgets = table[liveWindow];
    const prefixes = new Set();
    for (let rep = 0; rep < 3; rep += 1) {
      const { assembler, prompt } = buildTreePrompt(scenario, budgets, { withTools: true });
      const zoneAB = prompt.system + ' ' + prompt.blocks.filter((b) => b.zone === 'B').map((b) => b.text).join('\n\n');
      prefixes.add(sha256(zoneAB));
      if (rep === 0) {
        assembler.appendTail({ id: 'probe', text: 'FETCHED-PROBE', ephemeral: true });
        const withTail = assembler.assemble({ toolSchemasText: TOOL_SCHEMAS_TEXT, tail: assembler.tailEntries() });
        const zones = withTail.blocks.map((b) => b.zone);
        const lastC = zones.lastIndexOf('C');
        const firstTail = zones.indexOf('tail');
        if (firstTail !== -1 && lastC !== -1 && firstTail < lastC) prefixes.add('TAIL-BEFORE-ZONE-C');
      }
    }
    results.push(
      prefixes.size === 1
        ? pass('g10-prefix-stability', `Zone A+B prefix byte-identical across 3 assemblies at W=${liveWindow} (${[...prefixes][0].slice(0, 12)}); tail appends after Zone C`)
        : fail('g10-prefix-stability', `prefix is not stable: ${[...prefixes].join(' / ')}`),
    );
  }

  // 11 — every answer literal occurs exactly once in L0.
  const literalsPath = join(scenario.artifacts, 'literals.json');
  const questionsPath = join(scenario.artifacts, 'questions.json');
  const literalsFile = existsSync(literalsPath) ? JSON.parse(readFileSync(literalsPath, 'utf8')) : null;
  if (literalsFile === null) {
    results.push(defer('g11-literal-uniqueness', `no literals.json at ${literalsPath} — run --phase prep`));
  } else {
    const bad = [];
    // Uniqueness has two halves and only one of them was checked. String
    // uniqueness in L0 (below) says the answer key is unambiguous; ONE
    // LITERAL, ONE QUESTION (further below) says two strata are not quietly
    // asking about the same fact — `deep` is a subset of `head`, so without
    // this s1-q01-head and s1-q07-deep both asked about the same file path.
    const owner = new Map();
    // questions.json supersedes literals.json's pre-paraphrase selection: the
    // paraphrase loop discards and redraws literals, renumbering ids, so
    // unioning the two lists reports phantom sharing between a stale id and
    // its shifted successor. The cross-strata check only needs the FINAL set.
    const items = existsSync(questionsPath)
      ? JSON.parse(readFileSync(questionsPath, 'utf8')).questions
      : (literalsFile.selected ?? []);
    for (const item of items) {
      for (const literal of item.answer_literals ?? []) {
        const n = countOccurrences(native, literal);
        if (n !== 1) bad.push(`${JSON.stringify(literal)} occurs x${n} in L0`);
        const previous = owner.get(literal);
        if (previous !== undefined && previous !== item.id) {
          bad.push(`${JSON.stringify(literal)} is shared by ${previous} and ${item.id}`);
        }
        owner.set(literal, item.id);
      }
    }
    results.push(
      bad.length === 0
        ? pass(
            'g11-literal-uniqueness',
            `${items.length} item(s): every answer literal occurs exactly once in L0 and belongs to exactly one question`,
          )
        : fail('g11-literal-uniqueness', [...new Set(bad)].join('; ')),
    );
  }

  // 12 — leakage gate + the deep stratum's defining property.
  if (!hasSummaries) {
    results.push(defer('g12-leakage-gate', 'node_summaries is empty — nothing to leak against; run after the summarize pass'));
  } else if (!existsSync(questionsPath)) {
    results.push(defer('g12-leakage-gate', `no questions.json at ${questionsPath} — run --phase prep --allow-live`));
  } else {
    const questions = JSON.parse(readFileSync(questionsPath, 'utf8'));
    const problems = [];
    if (questions.questions.length === 0) problems.push('questions.json holds no questions at all');
    for (const q of questions.questions) {
      // The gate is only meaningful if it had something to gate. An empty
      // question shares no 3-gram with anything, so the leakage check passed
      // all 12 empty records and the batch that followed was void. Assert the
      // INPUT first: a vacuous pass is a failure, not a pass.
      const usable = questionTextValid(q.question);
      if (!usable.ok) {
        problems.push(`${q.id}: leakage gate input is trivial — ${usable.reason}`);
        continue;
      }
      const summary = summaries.get(q.node_id) ?? '';
      const gate = leakageGate({ question: q.question, summaryText: summary, answerLiterals: q.answer_literals });
      if (!gate.ok) problems.push(`${q.id}: shares ${JSON.stringify(gate.shared[0])}`);
      if (q.stratum === 'deep') {
        for (const literal of q.answer_literals) {
          for (const body of summaries.values()) {
            if (body.includes(literal)) problems.push(`${q.id}: deep literal ${JSON.stringify(literal)} appears in a summary`);
          }
        }
      }
    }
    results.push(
      problems.length === 0
        ? pass(
            'g12-leakage-gate',
            `${questions.questions.length} question(s), all non-trivial (>= ${MIN_QUESTION_CHARS} chars, >= ${MIN_QUESTION_WORDS} words): ` +
              'zero 3-gram overlap (answer literal excluded); deep literals absent from every summary',
          )
        : fail('g12-leakage-gate', problems.join('; ')),
    );
  }

  // 13 — manifest + question set hashed; the grader makes no model call.
  const manifest = readManifest(scenario);
  if (manifest === null) {
    results.push(defer('g13-manifest-hashed', `no manifest.json at ${manifestPath(scenario)} — run --phase prep`));
  } else if (!existsSync(questionsPath)) {
    results.push(
      defer('g13-manifest-hashed', 'manifest present but questions.json is not — the question-set sha cannot be checked yet', {
        manifest_gates: manifest.gates?.length ?? 0,
      }),
    );
  } else {
    const qsha = sha256File(questionsPath);
    results.push(
      manifest.questions?.sha256 === qsha
        ? pass('g13-manifest-hashed', `question-set sha ${qsha.slice(0, 12)} matches the manifest; grader = exactMatchJudge + regex, zero model calls`)
        : fail('g13-manifest-hashed', `questions.json hashes to ${qsha.slice(0, 12)} but the manifest says ${String(manifest.questions?.sha256).slice(0, 12)}`),
    );
  }

  // 14 — cost-cap plumbing: force a synthetic overspend and assert the throw.
  const meter = new InMemoryCostMeter({ capUsd: 0.000_001 });
  let fired = false;
  try {
    meter.record('claude-opus-5', { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
    meter.assertUnderCap('claude-opus-5');
  } catch (error) {
    fired = error instanceof CostCapExceededError;
  }
  results.push(
    fired
      ? pass('g14-cost-cap', `CostCapExceededError fires past the cap (meter recorded $${meter.totalUsd().toFixed(2)})`)
      : fail('g14-cost-cap', 'a synthetic overspend did NOT raise CostCapExceededError — the per-model cap is not wired'),
  );

  // 15 — every question can retrieve its own source (see `selfRetrieval`).
  // `g15Rows` is kept for G6 below: the lexical-vs-vector rank comparison
  // reads the SAME questions' lexical ranks computed here.
  let g15Rows = null;
  if (!existsSync(questionsPath)) {
    results.push(defer('g15-self-retrieval', `no questions.json at ${questionsPath} — run --phase prep --allow-live`));
  } else {
    const questions = JSON.parse(readFileSync(questionsPath, 'utf8')).questions;
    const toolCtx = toolContextFor(scenario);
    const rootId = scenario.store.root()?.id ?? null;
    const topK = selfRetrievalTopK(scenario);
    const rows = [];
    for (const q of questions) {
      const usable = questionTextValid(q.question);
      rows.push(
        usable.ok
          ? { id: q.id, ...(await selfRetrieval(q, toolCtx, { rootId, topK })) }
          : { id: q.id, ok: false, rank: null, top: [], reason: `unusable question text (${usable.reason})` },
      );
    }
    const failed = rows.filter((r) => !r.ok);
    // The threshold is the handler's own `retrieval.limit` (see
    // `selfRetrievalTopK`), so a pass means "the model would have received the
    // source in its result list". That is a real claim only when the search
    // ranks MORE candidates than it returns; when it does not, passing is
    // vacuous and the detail says so instead of implying a finding. The
    // strict counts below are diagnostics on the same ranks, never a verdict.
    // The denominator is what the search RETURNS, not what the store holds.
    const branchCount = Math.max(0, ...rows.map((r) => r.ranked ?? 0));
    const strictCounts = SELF_RETRIEVAL_STRICT_KS.map(
      (k) => `top-${k}: ${rows.filter((r) => r.rank !== null && r.rank <= k).length}/${rows.length}`,
    );
    const vacuous = topK >= branchCount;
    const strictNote =
      ` | strict ${strictCounts.join(', ')}` +
      (vacuous
        ? ` | WARNING: the derived threshold ${topK} (retrieval.limit) >= ${branchCount} ranked result(s), so every ` +
          'returned result passes; this gate proves the source is reachable, not that the referent is unique'
        : '');
    const data = {
      selfRetrieval: rows,
      topK,
      topKSource: 'config retrieval.limit',
      strict: Object.fromEntries(SELF_RETRIEVAL_STRICT_KS.map((k) => [k, rows.filter((r) => r.rank !== null && r.rank <= k).length])),
      branchCount,
      vacuous,
    };
    results.push(
      failed.length === 0
        ? pass(
            'g15-self-retrieval',
            `all ${rows.length} question(s) retrieve their own source within the ${topK} result(s) the model receives ` +
              `(ranks: ${rows.map((r) => r.rank).join(', ')}; task root excluded)${strictNote}`,
            data,
          )
        : fail(
            'g15-self-retrieval',
            `${failed.length}/${rows.length} question(s) cannot retrieve their own source: ` +
              failed.map((r) => `${r.id} (${r.reason})`).join('; ') + strictNote,
            data,
          ),
    );
  }

  // ── report ─────────────────────────────────────────────────────────────
  const wanted = options.gates === undefined ? null : new Set(options.gates.split(',').map((s) => s.trim()));
  const shown = results.filter((r) => wanted === null || wanted.has(r.id));

  console.log(`\n=== OFFLINE GATES — scenario ${scenario.id} (${scenario.traceSha?.slice(0, 12) ?? 'no-src'}) ===`);
  for (const r of shown) console.log(`[${r.status}] ${r.id}: ${r.detail}`);

  console.log('\n=== DERIVED BUDGET TABLE (D19: fractions of W ÷ measured ratio) ===');
  console.log(`ratio = ${ratio.toFixed(6)}  slack fraction = ${verdict.slackFraction}  (${verdict.action})`);
  console.log('| W | zoneA | zoneB | zoneC | lazy | reply | slack | K (truncate-tail) | maxTokens | rootKeep | root block | branches |');
  console.log('| --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |');
  for (const w of WINDOWS) {
    const b = table[w];
    console.log(
      `| ${w} | ${b.zoneA} | ${b.zoneB} | ${b.zoneC} | ${b.lazy} | ${b.reply} | ${b.slack} | ${b.K} | ${b.maxReplyTokens} | ` +
        `${b.rootKeep ?? 'DEAD'} | ${b.rootBlockTokens} | ${b.branchesSurviving ?? 0} |`,
    );
  }
  console.log('\n=== rootKeep ladder (assembled Zone B at each rung: root tok / branches surviving / overBudget) ===');
  for (const w of WINDOWS) {
    console.log(
      `W=${w} zoneB ${table[w].zoneB}: ` +
        table[w].rootLadder
          .map((r) => `keep${r.keep}=${r.rootBlockTokens}tok/${r.branchesSurviving}b${r.overBudget?.length ? `/over:${r.overBudget.join('+')}` : ''}${r.ok ? ' <-' : ''}`)
          .join(' '),
    );
  }

  // ── R6: visible-branch coverage per (W, arm) ─────────────────────────
  // The ablation's whole question. A `tail` fact lives at seq >= the
  // truncation boundary; the NEWEST branch alone does not reach back that far,
  // so whether an arm can answer from Zone B at all is a question about which
  // branches are visible, not about how the root is folded.
  const boundarySeq = truncationBoundarySeq(events, scenario.blobs, table[Math.min(...WINDOWS)].K);
  const phases = scenario.store.nodesInCreationOrder().filter((n) => n.kind === 'phase');
  const newest = phases.at(-1);
  const tailGap = { from: boundarySeq, to: (newest?.span_start_seq ?? boundarySeq) - 1 };
  console.log('\n=== R6 VISIBLE-BRANCH COVERAGE (tree vs tree-wide) ===');
  console.log(
    `truncation boundary: seq >= ${boundarySeq} is the tail stratum; the newest branch starts at ` +
      `${newest?.span_start_seq}, so seq ${tailGap.from}-${tailGap.to} is tail content OUTSIDE the newest branch`,
  );
  console.log('| W | arm | rootKeep | root tok | branches | visible seq range | covers tail gap ' + `${tailGap.from}-${tailGap.to}` + ' |');
  console.log('| --: | --- | --: | --: | --: | --- | --- |');
  const coverage = [];
  for (const w of WINDOWS) {
    for (const arm of ['tree', 'tree-wide']) {
      const budgets = armTable[w][arm];
      const view = visibleBranchesAt(scenario, budgets, arm);
      const spans = view.branches.map((b) => `${b.from}-${b.to}`);
      const covers = tailGap.to >= tailGap.from ? view.covers(tailGap.from, tailGap.to) : true;
      coverage.push({ w, arm, rootKeep: budgets.rootKeep, branches: view.branches.length, spans, coversTailGap: covers });
      console.log(
        `| ${w} | ${arm} | ${budgets.rootKeep ?? 'DEAD'} | ${budgets.rootBlockTokens} | ${view.branches.length} | ` +
          `${budgets.branchSeqRange?.from ?? '-'}-${budgets.branchSeqRange?.to ?? '-'} | ${covers ? 'YES' : 'NO'} |`,
      );
    }
  }
  for (const w of WINDOWS) {
    const t = coverage.find((c) => c.w === w && c.arm === 'tree');
    const tw = coverage.find((c) => c.w === w && c.arm === 'tree-wide');
    if (t.rootKeep === tw.rootKeep) {
      console.log(
        `W=${w}: tree and tree-wide derive the SAME keep (${t.rootKeep}) — the ablation is a NO-OP at this window. ` +
          `Neither covers seq ${tailGap.from}-${tailGap.to}, so a tail loss here is about branch GRANULARITY ` +
          '(the newest branch simply starts too late), not fold order, and no ladder direction can fix it.',
      );
    } else if (t.coversTailGap && tw.coversTailGap) {
      console.log(
        `W=${w}: BOTH arms already cover seq ${tailGap.from}-${tailGap.to} (tree ${t.branches} branches, ` +
          `tree-wide ${tw.branches}). Visibility is therefore NOT the tail constraint at this window — a tail loss ` +
          'here cannot be explained by the fact being absent from Zone B, and widening will not repair it.',
      );
    } else if (tw.coversTailGap) {
      console.log(`W=${w}: tree-wide covers the tail gap (${t.branches} -> ${tw.branches} branches) where tree does not`);
    } else {
      console.log(
        `W=${w}: tree-wide widens ${t.branches} -> ${tw.branches} branches but STILL does not cover seq ` +
          `${tailGap.from}-${tailGap.to} — the ablation cannot fix the tail stratum at this window`,
      );
    }
  }

  // Diagnostic, not a rule: the derivation stops at the LARGEST passing rung,
  // which maximises root headline coverage — but a headline is a pointer and a
  // branch summary is content, and a smaller keep frees Zone B for more of the
  // latter. Walking the rest of the ladder shows what that choice cost, so the
  // tradeoff is a number in the artifact rather than an assumption.
  console.log('\n=== rootKeep tradeoff (rungs BELOW the chosen one; diagnostic only) ===');
  for (const w of WINDOWS) {
    if (table[w].rootKeep === null) continue;
    const below = ROOT_KEEP_LADDER.filter((k) => k < table[w].rootKeep);
    const rows = below.map((keep) => {
      const { prompt } = assembleTreeAt(scenario, table[w], keep, { withTools: true });
      const branches = new Set(prompt.blocks.filter((b) => b.zone === 'B' && !b.id.startsWith('B:root')).map((b) => b.nodeId));
      return `keep${keep}=${branches.size}b`;
    });
    console.log(
      `W=${w} chosen keep${table[w].rootKeep} -> ${table[w].branchesSurviving} branches` +
        (rows.length === 0 ? ' (lowest rung)' : `; below: ${rows.join(' ')}`),
    );
    // Leave the store composed at the window's own keep again.
    composeRootAt(scenario, table[w].rootKeep, table[w].rootSummarySha);
  }

  // Does the smallest cell survive? Zone A is MEASURED, not assumed, and the
  // comparison is made in cl100k — the currency the window is denominated in.
  // Zone A's heuristic count is printed beside it because that is what the
  // assembler sees, and the two disagree by exactly the ratio measured above.
  const zoneAHeuristic = heuristic.count(TREE_SYSTEM) + heuristic.count(TOOL_SCHEMAS_TEXT);
  const zoneAExact = exact.count(TREE_SYSTEM) + exact.count(TOOL_SCHEMAS_TEXT);
  console.log('\n=== 16k CELL SURVIVAL (cl100k — the window own currency) ===');
  console.log(`Zone A measured: ${zoneAExact} cl100k / ${zoneAHeuristic} heuristic tokens (system contract + 4 tool schemas)`);
  for (const w of WINDOWS) {
    const b = table[w];
    const allowance = Math.floor(FRACTIONS.zoneA * w);
    const abc = zoneAExact + Math.round((b.zoneB + b.zoneC) * ratio);
    const spent = abc + b.maxReplyTokens;
    // Two independent ways a cell dies, and both must be reported or the
    // headline contradicts gate 8: the window can be too small for the zones,
    // OR Zone B can be too small for a root block that is exempt from
    // dropping. On this substrate it is the second that bites.
    const windowFits = zoneAExact <= allowance && spent <= w;
    const rootFits = b.rootKeep !== null;
    console.log(
      `W=${w}: zoneA ${zoneAExact} <= ${FRACTIONS.zoneA}*W = ${allowance} -> ${zoneAExact <= allowance}; ` +
        `A+B+C = ${abc} + ${b.maxReplyTokens} reply = ${spent} <= ${w} -> ${spent <= w} (headroom ${w - spent}); ` +
        `rootKeep ${b.rootKeep ?? `NONE (smallest keep leaves ${b.branchesSurviving} branches)`}` +
        `${b.rootKeep === null ? '' : ` (root ${b.rootBlockTokens} tok, ${b.branchesSurviving} branches visible, seq ${b.branchSeqRange?.from}-${b.branchSeqRange?.to})`} ` +
        `=> ${windowFits && rootFits ? 'SURVIVES' : rootFits ? 'DOES NOT FIT (window)' : 'DEAD (root block cannot fit half of Zone B)'}`,
    );
  }

  const failures = results.filter((r) => r.status === 'FAIL');
  const deferred = results.filter((r) => r.status === 'DEFER');
  console.log(
    `\n${results.length - failures.length - deferred.length} PASS / ${failures.length} FAIL / ${deferred.length} DEFER` +
      (deferred.length > 0 ? ` (deferred: ${deferred.map((r) => r.id).join(', ')})` : ''),
  );
  writeFileSync(join(scenario.artifacts, 'gates.json'), `${JSON.stringify({ ratio, table, results }, null, 2)}\n`);
  return { results, ratio, table, slackFraction: verdict.slackFraction };
}

/**
 * `small` must be a CONTIGUOUS, newest-aligned suffix of `large` — the shape
 * Zone B actually nests in once rule-4 drops the oldest branches first. Set
 * inclusion is not enough (a reorder is the D5 cache killer) and a prefix is
 * the wrong end of the list.
 */
export function isContiguousSuffix(small, large) {
  if (small.length > large.length) return false;
  const offset = large.length - small.length;
  for (let i = 0; i < small.length; i += 1) if (small[i] !== large[offset + i]) return false;
  return true;
}

/**
 * g15 — question self-retrieval. Zero tokens.
 *
 * `g11` proves an answer literal is unique as a STRING in L0. That is not the
 * property a question needs: it needs its REFERENT to be unique in the world
 * the model is searching. The two came apart badly — "How many characters were
 * omitted from the excerpt when it was truncated for length?" has a
 * string-unique answer (`2650`) and hundreds of equally valid referents, and
 * qwen duly found a different truncation, reasoned correctly, and scored 0.
 * The recall probe never hit this because its planted fact was unique in KIND;
 * a real trace is repetitive by nature.
 *
 * So this asks the harness's OWN retrieval — the same `context_search` beam the
 * tree arm calls — to find the question's source from the question text alone.
 * A question whose source is not in the top `topK` (the caller derives it
 * from `retrieval.limit`, the list length the model actually receives) is
 * unanswerable-by-retrieval BY CONSTRUCTION, and no arm result computed from it
 * means anything.
 *
 * The task root is excluded from the ranking: it is every question's ancestor,
 * it ranks first for essentially any query (measured: rank 1 for all 12), and
 * it is never a source node. Leaving it in would silently spend a third of the
 * budget on a result that cannot be the answer.
 */
export async function selfRetrieval(question, toolCtx, options = {}) {
  const { topK, rootId = null, search = HANDLERS[CONTEXT_SEARCH] } = options;
  if (typeof topK !== 'number') throw new Error('selfRetrieval needs an explicit topK — derive it from config retrieval.limit');
  const outcome = await search(toolCtx, { query: question.question });
  if (!outcome.ok) return { ok: false, rank: null, top: [], reason: `context_search failed: ${outcome.error?.message ?? 'unknown'}` };
  const ranked = (outcome.data.candidates ?? [])
    .map((candidate) => candidate.node_id)
    .filter((id) => id !== rootId);
  const wanted = new Set(question.node_ids ?? [question.node_id]);
  const top = ranked.slice(0, topK);
  const rank = ranked.findIndex((id) => wanted.has(id));
  return {
    ok: rank !== -1 && rank < topK,
    rank: rank === -1 ? null : rank + 1,
    /** How many results the search actually returned — the real denominator. */
    ranked: ranked.length,
    top,
    reason:
      rank === -1
        ? `source ${[...wanted].join('/')} absent from ${ranked.length} ranked result(s)`
        : rank < topK
          ? null
          : `source ranked ${rank + 1}, outside top ${topK}`,
  };
}

// ── prep (Step 2) ────────────────────────────────────────────────────────
/**
 * A usable question has actual text in it. Stated as a predicate because the
 * batch that voided the experiment was NOT a wrong answer — it was an empty
 * string that every downstream check accepted: `''` shares no 3-gram with any
 * summary, so the leakage gate passed it, printed `[ok]`, and 180 scored runs
 * then asked two models nothing at all. A check that can pass on garbage is
 * worse than no check, so the same predicate is enforced at three layers:
 * here at prep, again at gate 12, and once more before a question is ever sent.
 */
export function questionTextValid(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not a string' };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length < MIN_QUESTION_CHARS) return { ok: false, reason: `only ${trimmed.length} chars (min ${MIN_QUESTION_CHARS})` };
  if (trimmed.split(/\s+/).length < MIN_QUESTION_WORDS) return { ok: false, reason: `only ${trimmed.split(/\s+/).length} words (min ${MIN_QUESTION_WORDS})` };
  return { ok: true, reason: null };
}

const ANCHOR_RULES = [
  '- ANCHOR IT. The question must name something distinctive from the surrounding excerpt — a file',
  '  name, the activity underway, an adjacent decision — so that exactly ONE moment in a long',
  '  session could be the one being asked about. A question like "how many characters were omitted',
  '  when it was truncated?" is useless: a real session truncates hundreds of things.',
  '- The anchor must come from the excerpt itself, not from the fact. Never include the fact.',
  '- QUOTE ANCHORS VERBATIM. Copy the distinctive identifiers exactly as the excerpt spells them —',
  '  file names, function or symbol names, flag names, script names, proper nouns. Do NOT paraphrase',
  '  the anchor: "the marathon script" finds nothing if the excerpt says marathon.mjs; write',
  '  marathon.mjs. Paraphrase everything else about the question, never the identifiers.',
  '- Someone searching the session with your question as the search query must land on THIS moment.',
].join('\n');

const PARAPHRASE_RETRY_INSTRUCTIONS = [
  'Your previous question was rejected. Write a better one.',
  'Output ONE plain-text question and nothing else — no preamble, no reasoning, no JSON, no blank reply.',
  'It must be at least one full sentence, must not contain the fact itself, and above all it must be',
  'SPECIFIC ENOUGH TO IDENTIFY ONE MOMENT in a long session:',
  ANCHOR_RULES,
].join('\n');


const PARAPHRASE_INSTRUCTIONS = [
  'You are writing ONE recall question for a memory benchmark.',
  '',
  'Below is a verbatim excerpt from an engineering session, and one FACT from inside it.',
  'Write a single question whose only correct answer is that fact.',
  '',
  'Rules:',
  '- Describe the situation in your own plain words, the way a colleague who was not there would',
  '  ask about it. Do not copy phrasing wholesale.',
  ANCHOR_RULES,
  '- Do not include the fact itself in the question.',
  '- One or two sentences. Output the question and nothing else.',
].join('\n');

async function runPrep(scenario, options) {
  const events = scenario.trace.all();
  const summaries = summaryBodies(scenario.store);
  const ratio = measureRatio(scenario);
  const verdict = ratioVerdict(ratio);
  if (!verdict.ok) {
    throw new Error(`KILL GATE: heuristic->BPE ratio ${ratio.toFixed(4)} exceeds ${RATIO_KILL} — see Step 3 mitigation before proceeding`);
  }
  // Strata are cut against the SMALLEST window's K, which keeps the question set
  // one frozen artifact.
  //
  // What this does NOT give you, despite what this comment claimed until
  // 2026-09-03: `head` is not "provably outside the baseline's view". The
  // boundary is non-increasing in K, so cutting at the smallest window's K is
  // the WEAKEST such guarantee — a `head` fact can sit inside a wider window's
  // tail, and three of them did (seq 558 is inside the tail from W=65,536 up).
  // A whole pass was aimed by trusting the old sentence. For a stratum that is
  // outside the tail at W and every narrower window, use `--phase prep-overflow
  // --ref-window W`.
  const budgets = budgetsFor(scenario, Math.min(...WINDOWS), ratio, verdict.slackFraction);
  const boundary = truncationBoundarySeq(events, scenario.blobs, budgets.K);
  const rootPins = summaries.size === 0 ? {} : rootByWindow(scenario, ratio, verdict.slackFraction);
  for (const [w, perArm] of Object.entries(rootPins)) {
    for (const [arm, pin] of Object.entries(perArm)) {
      console.log(
        `root pin W=${w}/${arm}: rootKeep=${pin.rootKeep ?? 'DEAD'} root ${pin.rootBlockTokens} tok, ` +
          `${pin.branchesSurviving} branch summaries visible (seq ${pin.branchSeqRange?.from ?? '-'}-${pin.branchSeqRange?.to ?? '-'}), zoneB ${pin.zoneB}`,
      );
    }
  }

  const { onceOnly, all, wellShaped } = extractLiterals(events, scenario.blobs, scenario.store);
  console.log(
    `candidates: ${all.length} distinct literals -> ${wellShaped.length} well-shaped -> ${onceOnly.length} once-only with >= ${MIN_CONTEXT_CHARS} chars of context`,
  );
  console.log(`truncate-tail boundary: seq >= ${boundary} is visible to truncation at W=${Math.min(...WINDOWS)} (K=${budgets.K})`);

  const head = onceOnly.filter((r) => r.seq < boundary);
  const tail = onceOnly.filter((r) => r.seq >= boundary);
  const deepPending = summaries.size === 0;
  const deep = deepPending
    ? []
    : head.filter((r) => ![...summaries.values()].some((body) => body.includes(r.literal)));

  // ONE literal, ONE question. `deep` is a subset of `head` by construction
  // (a head fact absent from every summary), so without an explicit carry-over
  // the same literal is drawn twice — observed: s1-q01-head and s1-q07-deep
  // both asked about `../src/trace/index.js`. Strata are therefore cut in a
  // fixed order, each excluding everything already claimed.
  const claimed = new Set();
  const strata = {};
  const pools = {};
  for (const [stratum, source] of [['head', head], ['tail', tail], ['deep', deep]]) {
    // The pool is deeper than the cut: a question whose literal fails the
    // self-retrieval gate twice is discarded and the NEXT candidate drawn,
    // which needs candidates to draw.
    pools[stratum] = pickDeterministic(source, POOL_DEPTH, { exclude: claimed });
    strata[stratum] = pools[stratum].slice(0, Q_PER_STRATUM);
    for (const item of pools[stratum]) claimed.add(item.literal);
  }
  // `spanning` is exploratory (Graft 5): two literals from two DIFFERENT
  // phases, so answering it needs at least a two-branch hop. Pre-registered as
  // exploratory here so it cannot be promoted into the primary verdict later.
  // Its literals are disjoint from the primary strata's — an exploratory probe
  // that re-asks a scored question's answer is not an independent probe.
  const spanPool = pickDeterministic(head, POOL_DEPTH * 2, { exclude: claimed });
  const spanningPool = [];
  for (let i = 0; i + 1 < spanPool.length; i += 2) spanningPool.push({ ...spanPool[i], pair: spanPool[i + 1] });
  pools.spanning = spanningPool;
  const spanning = spanningPool.slice(0, Q_PER_STRATUM);

  const selected = [];
  let n = 0;
  for (const stratum of [...PRIMARY_STRATA, ...EXPLORATORY_STRATA]) {
    const pool = stratum === 'spanning' ? spanning : strata[stratum];
    for (const item of pool) {
      n += 1;
      selected.push({ ...buildSelectedItem(item, stratum), id: `${scenario.id}-q${String(n).padStart(2, '0')}-${stratum}` });
    }
  }

  const literalsFile = {
    scenario: scenario.id,
    trace_sha256: scenario.traceSha,
    ratio,
    boundary_seq: boundary,
    K: budgets.K,
    counts: { distinct: all.length, once_only: onceOnly.length, head: head.length, tail: tail.length, deep: deep.length },
    deep_pending: deepPending,
    selected,
    /** Deeper candidate lists, so a literal rejected by g15 has a successor. */
    pools: Object.fromEntries(
      Object.entries(pools).map(([stratum, list]) => [
        stratum,
        list.map((item) => ({
          literal: item.literal,
          pair: item.pair?.literal ?? null,
          kind: item.kind,
          seq: item.seq,
          node_id: item.node_id,
        })),
      ]),
    ),
  };
  writeFileSync(join(scenario.artifacts, 'literals.json'), `${JSON.stringify(literalsFile, null, 2)}\n`);
  // Carry an intact question pin forward. Re-running the offline half to pick
  // up a new pin shape must not silently unpin the question set — that would
  // turn a bookkeeping refresh into a freeze break.
  const previous = readManifest(scenario);
  const questionsPathNow = join(scenario.artifacts, 'questions.json');
  const questionsPin =
    previous?.questions !== undefined && existsSync(questionsPathNow) && sha256File(questionsPathNow) === previous.questions.sha256
      ? { questions: previous.questions }
      : {};
  writeFileSync(
    manifestPath(scenario),
    `${JSON.stringify(buildManifest(scenario, { ratio, root_by_window: rootPins, literals: { sha256: sha256(JSON.stringify(literalsFile)) }, ...questionsPin }), null, 2)}\n`,
  );
  console.log(
    `strata: head=${strata.head.length} tail=${strata.tail.length} deep=${strata.deep.length} spanning=${spanning.length}` +
      (deepPending ? ' (deep is EMPTY: node_summaries has no rows yet)' : ''),
  );
  console.log(`wrote ${join(scenario.artifacts, 'literals.json')} and ${manifestPath(scenario)}`);

  if (deepPending) {
    console.log(
      '\nThe `deep` stratum is defined as "absent from EVERY stored summary", so it cannot be cut before\n' +
        'the summarize pass. Re-run `--phase prep` after summarization to fill it.',
    );
  }
  if (options.allowLive !== true) {
    console.log(
      '\nSTOPPED after literal extraction: the paraphrase batch is LIVE (`z-ai/glm-5.3-flash`).\n' +
        'Re-run with --allow-live to write questions.json.',
    );
    return;
  }

  // ── live: one small paraphrase batch, third model family ───────────────
  loadDotEnv();
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
  if (!apiKey && process.env.TRANSPLANT_MOCK !== '1') {
    throw new Error('OPENROUTER_API_KEY is not set — the paraphrase batch needs it');
  }
  // Regeneration rounds: up to 4 strata x POOL_DEPTH draws x PARAPHRASE_ATTEMPTS
  // at ~$0.0002 each. The cap is headroom, not a target.
  const meter = new InMemoryCostMeter({ capUsd: 0.5 });
  const provider =
    process.env.TRANSPLANT_MOCK === '1'
      ? new MeteredProvider(mockParaphraser(), meter)
      : new MeteredProvider(new OpenRouterProvider({ apiKey }), meter);
  const questions = [];
  const toolCtx = toolContextFor(scenario);
  const rootId = scenario.store.root()?.id ?? null;
  const unusable = [];
  const discarded = [];

  /** One paraphrase attempt, fully validated: text, leakage, and self-retrieval. */
  const attemptOne = async (item, attempt) => {
    const result = await provider.complete({
      model: PARAPHRASE_MODEL,
      messages: [
        {
          role: 'user',
          content:
            `${attempt === 1 ? PARAPHRASE_INSTRUCTIONS : PARAPHRASE_RETRY_INSTRUCTIONS}` +
            `\n\n# Excerpt\n${item.wide_context ?? item.source_context}\n\n# Fact\n${item.answer_literals.join(' AND ')}`,
        },
      ],
      maxTokens: 1_024,
    });
    const question = (result.text ?? '')
      .trim()
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? '';
    const diagnostics = {
      attempt,
      model: result.model,
      stopReason: result.stopReason,
      rawTextLength: (result.text ?? '').length,
      usage: result.usage,
    };
    const valid = questionTextValid(question);
    if (!valid.ok) return { ok: false, question, why: `text: ${valid.reason}`, diagnostics };
    // Leakage: the anchor must be RAW L0 phrasing, never summary phrasing.
    const gate = leakageGate({
      question,
      summaryText: summaries.get(item.node_id) ?? '',
      answerLiterals: item.answer_literals,
    });
    if (!gate.ok) return { ok: false, question, why: `leakage: shares ${JSON.stringify(gate.shared[0])}`, diagnostics, gate };
    // g15, applied at prep so a bad question never reaches a scored batch.
    const retrieval = await selfRetrieval({ ...item, question }, toolCtx, { rootId });
    if (!retrieval.ok) return { ok: false, question, why: `self-retrieval: ${retrieval.reason}`, diagnostics, gate, retrieval };
    return { ok: true, question, gate, retrieval, diagnostics };
  };

  // Draw a literal, try to paraphrase it into a question that clears all three
  // checks; if it cannot after PARAPHRASE_ATTEMPTS, discard the LITERAL (not
  // just the wording) and draw the next candidate from the same stratum's
  // pool. `g15 + leakage` define the corridor: findable from the question,
  // not lifted from the summary.
  for (const stratum of [...PRIMARY_STRATA, ...EXPLORATORY_STRATA]) {
    const pool = (pools[stratum] ?? []).map((item) => buildSelectedItem(item, stratum));
    let placed = 0;
    for (const item of pool) {
      if (placed === Q_PER_STRATUM) break;
      let outcome = null;
      for (let attempt = 1; attempt <= PARAPHRASE_ATTEMPTS && (outcome === null || !outcome.ok); attempt += 1) {
        outcome = await attemptOne(item, attempt);
      }
      if (!outcome.ok) {
        discarded.push({
          literal: item.answer_literals.join(' + '),
          stratum,
          why: outcome.why,
          rank: outcome.retrieval?.rank ?? null,
        });
        console.log(`  [discarded ${stratum}] ${JSON.stringify(item.answer_literals)} — ${outcome.why}`);
        continue;
      }
      placed += 1;
      questions.push({
        ...item,
        id: `${scenario.id}-q${String(questions.length + 1).padStart(2, '0')}-${stratum}`,
        question: outcome.question,
        leakage: outcome.gate,
        self_retrieval: { rank: outcome.retrieval.rank, top: outcome.retrieval.top },
        rejected: false,
      });
      console.log(`  ${stratum} ${placed}/${Q_PER_STRATUM} [ok, source at rank ${outcome.retrieval.rank}] ${outcome.question.slice(0, 100)}`);
    }
    if (placed < Q_PER_STRATUM) {
      unusable.push({ stratum, placed, needed: Q_PER_STRATUM, poolDepth: pool.length });
    }
  }

  if (unusable.length > 0) {
    // Loud, and nothing is written: a partial question set silently shrinks a
    // pre-registered stratum, which is the same class of failure as an empty one.
    throw new Error(
      `prep could not fill every stratum — questions.json NOT written.\n` +
        unusable.map((u) => `  ${u.stratum}: ${u.placed}/${u.needed} placed from a pool of ${u.poolDepth}`).join('\n') +
        `\n${discarded.length} literal(s) discarded:\n` +
        discarded.map((d) => `  ${d.stratum} ${JSON.stringify(d.literal)}: ${d.why}`).join('\n') +
        `\n\nPer-stratum self-retrieval ranks of the discarded literals:\n` +
        [...new Set(discarded.map((d) => d.stratum))]
          .map((stratum) => {
            const ranks = discarded.filter((d) => d.stratum === stratum && d.rank !== null).map((d) => d.rank);
            const absent = discarded.filter((d) => d.stratum === stratum && d.rank === null).length;
            return `  ${stratum}: ranks [${ranks.join(', ')}]${absent > 0 ? `, ${absent} absent from the ranking` : ''}`;
          })
          .join('\n') +
        '\n\nIf one stratum is systematically far down the ranking while others place at 1-3, the constraint is ' +
        "that BRANCH, not the literals: `context_search` indexes SUMMARY text, so a question anchored in raw L0 " +
        'can only retrieve a branch whose summary kept that phrasing. The leakage gate forbids reusing summary ' +
        'phrasing and g15 requires retrieving through it — a real corridor, and it can be narrow. Raising ' +
        'POOL_DEPTH only helps when the ranks are near the threshold.',
    );
  }
  const kept = questions.filter((q) => !q.rejected);
  const file = { scenario: scenario.id, trace_sha256: scenario.traceSha, paraphraser: PARAPHRASE_MODEL, ratio, questions: kept, rejected: questions.filter((q) => q.rejected) };
  const path = join(scenario.artifacts, 'questions.json');
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  writeFileSync(
    manifestPath(scenario),
    `${JSON.stringify(buildManifest(scenario, { ratio, root_by_window: rootPins, literals: { sha256: sha256(JSON.stringify(literalsFile)) }, questions: { sha256: sha256File(path), count: kept.length } }), null, 2)}\n`,
  );
  console.log(`\nkept ${kept.length}/${questions.length} questions -> ${path} (paraphrase spend $${meter.totalUsd().toFixed(4)})`);
}

const OVERFLOW_Q_COUNT = 5;
const OVERFLOW_POOL_DEPTH = 15;

/**
 * `head` (in `--phase prep`) is cut against the SMALLEST tested window's K
 * (16,384) so it is one frozen artifact — but `boundary` is non-increasing in
 * K, so a literal outside the smallest window's tail is NOT guaranteed to be
 * outside a WIDER window's tail (a bigger K walks further back before its
 * budget is spent, pulling more of the trace into view). The live pass found
 * exactly that: `head` questions the naive-full ground truth answers easily
 * also score on `truncate-tail` at W=32,768/65,536, because they sit inside
 * the wider tail after all.
 *
 * This phase cuts a SEPARATE stratum, `overflow`, against the WIDEST tested
 * tail window's K. Because boundary(K) is non-increasing in K, a literal
 * outside THAT boundary is outside every narrower tested window's tail too —
 * the guarantee `head` was meant to give, now actually true at both W=32,768
 * and W=65,536. Written to its own `questions-overflow.json` rather than
 * appended to the frozen `questions.json`/`manifest.json` pair, so the
 * existing freeze (Graft 2) is untouched.
 */
async function runPrepOverflow(scenario, options) {
  const events = scenario.trace.all();
  const summaries = summaryBodies(scenario.store);
  const ratio = measureRatio(scenario);
  const verdict = ratioVerdict(ratio);
  if (!verdict.ok) {
    throw new Error(`KILL GATE: heuristic->BPE ratio ${ratio.toFixed(4)} exceeds ${RATIO_KILL} — see Step 3 mitigation before proceeding`);
  }
  const refWindow = Number.parseInt(options.refWindow ?? '65536', 10);
  if (!WINDOWS.includes(refWindow)) throw new Error(`--ref-window must be one of ${WINDOWS.join(', ')}`);
  const budgets = budgetsFor(scenario, refWindow, ratio, verdict.slackFraction);
  const boundary = truncationBoundarySeq(events, scenario.blobs, budgets.K);
  console.log(`overflow boundary: seq < ${boundary} is unreachable by truncate-tail's raw tail at W=${refWindow} (K=${budgets.K})`);

  const existingPath = join(scenario.artifacts, 'questions.json');
  const claimed = new Set(
    existsSync(existingPath)
      ? JSON.parse(readFileSync(existingPath, 'utf8')).questions.flatMap((q) => q.answer_literals)
      : [],
  );

  const { onceOnly } = extractLiterals(events, scenario.blobs, scenario.store);
  const candidates = onceOnly.filter((r) => r.seq < boundary && !claimed.has(r.literal));
  console.log(`candidates: ${onceOnly.length} once-only literal(s) -> ${candidates.length} below the overflow boundary and unclaimed by questions.json`);
  if (candidates.length === 0) {
    throw new Error(
      `no once-only literal sits below seq ${boundary} at W=${refWindow} (K=${budgets.K}) — the trace is too short ` +
        'for the overflow regime at this window, or every candidate there is already claimed by questions.json',
    );
  }
  const pool = pickDeterministic(candidates, OVERFLOW_POOL_DEPTH, { exclude: claimed });
  const selected = pool.map((item, i) => ({
    ...buildSelectedItem(item, 'overflow'),
    id: `${scenario.id}-qo${String(i + 1).padStart(2, '0')}-overflow`,
  }));

  const overflowFile = {
    scenario: scenario.id,
    trace_sha256: scenario.traceSha,
    ratio,
    ref_window: refWindow,
    boundary_seq: boundary,
    K: budgets.K,
    counts: { once_only: onceOnly.length, overflow_pool: candidates.length },
    selected,
  };
  writeFileSync(join(scenario.artifacts, 'literals-overflow.json'), `${JSON.stringify(overflowFile, null, 2)}\n`);
  console.log(`pool: ${selected.length} candidate(s) ready for paraphrasing -> ${join(scenario.artifacts, 'literals-overflow.json')}`);

  if (options.allowLive !== true) {
    console.log(
      '\nSTOPPED after literal extraction: the paraphrase batch is LIVE (`deepseek/deepseek-v4-flash`).\n' +
        'Re-run with --allow-live to write questions-overflow.json.',
    );
    return;
  }

  loadDotEnv();
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
  if (!apiKey && process.env.TRANSPLANT_MOCK !== '1') {
    throw new Error('OPENROUTER_API_KEY is not set — the paraphrase batch needs it');
  }
  const meter = new InMemoryCostMeter({ capUsd: 0.5 });
  const provider =
    process.env.TRANSPLANT_MOCK === '1'
      ? new MeteredProvider(mockParaphraser(), meter)
      : new MeteredProvider(new OpenRouterProvider({ apiKey }), meter);
  const toolCtx = toolContextFor(scenario);
  const rootId = scenario.store.root()?.id ?? null;

  const attemptOne = async (item, attempt) => {
    let result;
    try {
      result = await provider.complete({
        model: PARAPHRASE_MODEL,
        messages: [
          {
            role: 'user',
            content:
              `${attempt === 1 ? PARAPHRASE_INSTRUCTIONS : PARAPHRASE_RETRY_INSTRUCTIONS}` +
              `\n\n# Excerpt\n${item.wide_context ?? item.source_context}\n\n# Fact\n${item.answer_literals.join(' AND ')}`,
          },
        ],
        maxTokens: 1_024,
      });
    } catch (error) {
      // A reasoning model can burn the whole completion budget on hidden
      // reasoning tokens and emit no text (finish_reason=length) — a property
      // of this excerpt+model pairing, not a retryable transport error. Treat
      // it as a failed attempt so the caller draws the next pool candidate
      // instead of crashing the batch.
      return { ok: false, question: '', why: `model-error: ${error.message}` };
    }
    const question = (result.text ?? '')
      .trim()
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? '';
    const valid = questionTextValid(question);
    if (!valid.ok) return { ok: false, question, why: `text: ${valid.reason}` };
    const gate = leakageGate({ question, summaryText: summaries.get(item.node_id) ?? '', answerLiterals: item.answer_literals });
    if (!gate.ok) return { ok: false, question, why: `leakage: shares ${JSON.stringify(gate.shared[0])}` };
    const retrieval = await selfRetrieval({ ...item, question }, toolCtx, { rootId, topK: selfRetrievalTopK(scenario) });
    if (!retrieval.ok) return { ok: false, question, why: `self-retrieval: ${retrieval.reason}` };
    return { ok: true, question, gate, retrieval };
  };

  const kept = [];
  const discarded = [];
  for (const item of selected) {
    if (kept.length === OVERFLOW_Q_COUNT) break;
    let outcome = null;
    for (let attempt = 1; attempt <= PARAPHRASE_ATTEMPTS && (outcome === null || !outcome.ok); attempt += 1) {
      outcome = await attemptOne(item, attempt);
    }
    if (!outcome.ok) {
      discarded.push({ literal: item.answer_literals.join(' + '), why: outcome.why });
      console.log(`  [discarded] ${JSON.stringify(item.answer_literals)} — ${outcome.why}`);
      continue;
    }
    kept.push({ ...item, question: outcome.question, leakage: outcome.gate, self_retrieval: { rank: outcome.retrieval.rank, top: outcome.retrieval.top }, rejected: false });
    console.log(`  ${kept.length}/${OVERFLOW_Q_COUNT} [ok, source at rank ${outcome.retrieval.rank}] ${outcome.question.slice(0, 100)}`);
  }
  if (kept.length < OVERFLOW_Q_COUNT) {
    throw new Error(
      `prep-overflow could not fill the overflow stratum — questions-overflow.json NOT written.\n` +
        `${kept.length}/${OVERFLOW_Q_COUNT} placed from a pool of ${selected.length}.\n` +
        discarded.map((d) => `  ${JSON.stringify(d.literal)}: ${d.why}`).join('\n'),
    );
  }
  const outPath = join(scenario.artifacts, options.out ?? 'questions-overflow.json');
  const outFile = { scenario: scenario.id, trace_sha256: scenario.traceSha, paraphraser: PARAPHRASE_MODEL, ref_window: refWindow, boundary_seq: boundary, K: budgets.K, questions: kept, rejected: discarded };
  writeFileSync(outPath, `${JSON.stringify(outFile, null, 2)}\n`);
  console.log(`\nkept ${kept.length}/${selected.length} overflow questions -> ${outPath} (paraphrase spend $${meter.totalUsd().toFixed(4)})`);
}

// ── run (Steps 4-6) ──────────────────────────────────────────────────────
/**
 * Answering spend per model bucket, as the meters measured it. Every cost
 * figure in the multi-index report was reverse-engineered from `usage` against
 * a list price because this was never written down; persisting it makes the
 * next one auditable rather than plausible. Compaction buckets are excluded —
 * they are a build cost, already reported as `compactionBuildUsd`.
 */
function answeringSpend(meters) {
  const out = {};
  for (const [bucket, meter] of meters) {
    if (bucket.startsWith('compaction:')) continue;
    out[bucket] = Number(meter.totalUsd().toFixed(6));
  }
  return out;
}

function providerFor(bucket, meters, capUsd = CAP_USD_PER_MODEL) {
  if (!meters.has(bucket)) meters.set(bucket, new InMemoryCostMeter({ capUsd }));
  if (process.env.TRANSPLANT_MOCK === '1') {
    return new MeteredProvider(mockProvider(), meters.get(bucket));
  }
  loadDotEnv();
  // Direct Anthropic provider for claude models — faster, no OpenRouter middleman.
  if (bucket.startsWith('claude-') || bucket.startsWith('anthropic/claude-')) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      return new MeteredProvider(new AnthropicProvider({ apiKey }), meters.get(bucket));
    }
  }
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  return new MeteredProvider(new OpenRouterProvider({ apiKey }), meters.get(bucket));
}

/**
 * Offline paraphraser. Echoes a distinctive phrase from the excerpt so the
 * generated question actually retrieves its own source — which is what makes
 * this a real exercise of the prep loop rather than a smoke test of it.
 */
function mockParaphraser() {
  return {
    id: 'transplant-mock-paraphraser',
    async complete(request) {
      const excerpt = request.messages[0]?.content ?? '';
      const body = excerpt.slice(excerpt.indexOf('# Excerpt'), excerpt.indexOf('# Fact'));
      const words = body.split(/\s+/).filter((w) => /^[A-Za-z][\w./-]{5,}$/.test(w));
      const anchor = words.slice(0, 12).join(' ');
      return {
        text: `While working on ${anchor} — what value did the session settle on at that point?`,
        model: request.model,
        usage: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0 },
        toolCalls: [],
        stopReason: 'end_turn',
      };
    },
  };
}

/**
 * Offline stand-in: one `context_search` call, then a plain answer. `tool_calls`
 * is what `MockProvider` cannot express, and the tool turn is exactly the path
 * under test, so this is a local stub rather than a core mock.
 */
function mockProvider() {
  let turn = 0;
  return {
    id: 'transplant-mock',
    async complete(request) {
      turn += 1;
      const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
      if (turn === 1 && (request.tools ?? []).length > 0) {
        return {
          text: '',
          model: request.model,
          usage,
          toolCalls: [{ id: 'call_1', name: CONTEXT_SEARCH, input: { query: 'mock probe' } }],
          stopReason: 'tool_use',
        };
      }
      return { text: 'mock answer', model: request.model, usage, toolCalls: [], stopReason: 'end_turn' };
    },
  };
}

/**
 * Step 4's rolling compaction artifact: one per (trace, W), question-independent
 * and frozen. Model, output cap and total prompt budget are the TREE's — a
 * compaction baseline that is allowed a bigger prompt or a stronger summarizer
 * is measuring the budget, not the organization.
 */
/**
 * A valid rolling summary is a document, not a turn of conversation: it has
 * real length (a 196k-token session cannot honestly compress below this) and
 * does not end by asking the user something.
 */
export function compactionSummaryValid(text) {
  return text.length >= 600 && !text.endsWith('?');
}

async function buildCompactionArtifact(scenario, budgets, meters) {
  // A mocked build must never be freezable as the real baseline, for the same
  // reason mocked runs land in `results-mock/`.
  const path = join(
    scenario.artifacts,
    `compact-${budgets.window}${process.env.TRANSPLANT_MOCK === '1' ? '.mock' : ''}.json`,
  );
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    // A frozen artifact is not automatically a valid one: the W=16384 file on
    // disk predates the floor and holds a 169-char conversational fragment.
    // Loading it silently is how a broken baseline reaches a scored batch.
    if (!compactionSummaryValid(cached.summary ?? '')) {
      throw new Error(
        `compaction artifact ${path} is not a valid baseline (${(cached.summary ?? '').length} chars) — ` +
          'delete it and let --phase run rebuild it; a broken baseline makes every arm comparison meaningless',
      );
    }
    return cached;
  }
  // Its OWN ledger. Billing the build to whichever answering model happened to
  // trigger the lazy build made a $0.38 one-off look like per-question spend on
  // qwen; a baseline's construction cost is a real number and belongs in a
  // bucket of its own, not smeared across the arm it serves.
  const bucket = `compaction:W${budgets.window}`;
  const provider = providerFor(bucket, meters, CAP_USD_COMPACTION);
  const events = scenario.trace.all();
  const chunkBudget = Math.floor((0.5 * budgets.window) / budgets.ratio);
  const chunks = [];
  let current = [];
  let spent = 0;
  for (const event of events) {
    const text = renderEvent(event, scenario.blobs);
    const cost = heuristic.count(text);
    if (spent + cost > chunkBudget && current.length > 0) {
      chunks.push(current);
      current = [];
      spent = 0;
    }
    current.push(text);
    spent += cost;
  }
  if (current.length > 0) chunks.push(current);

  let running = '(no earlier summary)';
  const skippedChunks = [];
  for (const chunk of chunks) {
    const result = await provider.complete({
      model: COMPACT_MODEL_OR,
      messages: [
        {
          role: 'user',
          content: [
            'You are maintaining a rolling summary of a long engineering session so it can be resumed later.',
            'Rewrite the running summary so it also covers the new chunk. Keep concrete coordinates —',
            'file paths, symbol names, numbers, decisions, open questions. Prose only.',
            'Output ONLY the complete updated summary. Do not address the user, ask questions, or offer',
            'options — you are writing a document, not holding a conversation. Begin directly with the',
            'summary content.',
            'If the new chunk adds little, output the complete running summary again with only minor',
            'additions — always output the full document.',
            '',
            '# Running summary so far',
            running,
            '',
            '# New chunk',
            chunk.join('\n\n'),
          ].join('\n'),
        },
      ],
      maxTokens: MAX_SUMMARY_TOKENS,
    });
    // A conversational reply here poisons every later chunk (the observed
    // failure: a 169-char question fragment standing in for 196k tokens of
    // session). Floor + no-trailing-question, one corrective retry, then loud.
    let candidate = result.text.trim();
    if (!compactionSummaryValid(candidate)) {
      const retry = await provider.complete({
        model: COMPACT_MODEL_OR,
        messages: [
          {
            role: 'user',
            content: [
              'Your previous output was not a summary. Output ONLY the complete updated rolling',
              'summary document — several paragraphs of prose covering BOTH the running summary and',
              'the new chunk, with file paths, symbol names, numbers, decisions, and open questions.',
              'No questions to the user. No offers. No preamble.',
              '',
              '# Running summary so far',
              running,
              '',
              '# New chunk',
              chunk.join('\n\n'),
            ].join('\n'),
          },
        ],
        maxTokens: MAX_SUMMARY_TOKENS,
      });
      candidate = retry.text.trim();
      if (!compactionSummaryValid(candidate)) {
        // Neither die nor accept: KEEP the last good summary, record the gap,
        // and continue. Dying mid-build throws away every chunk already paid
        // for, and accepting a 234-char reply poisons every later chunk. A
        // skipped chunk is honest and cheap here because the compact arm also
        // carries a verbatim tail that overlaps the newest content anyway —
        // and the gap is recorded, so no reader has to guess.
        const index = chunks.indexOf(chunk) + 1;
        skippedChunks.push({ chunk: index, of: chunks.length, chars: candidate.length });
        console.log(
          `[compaction W=${budgets.window}] SKIPPED chunk ${index}/${chunks.length}: still not a summary after the ` +
            `corrective retry (${candidate.length} chars) — keeping the previous running summary and continuing`,
        );
        continue;
      }
    }
    running = candidate;
  }
  // Skipping keeps the build alive; it must not become a way to accept an
  // invalid baseline. If every chunk (or every chunk that mattered) was
  // skipped, `running` is still the placeholder — an artifact that summarises
  // nothing. Both rules hold together only if the FINAL document is checked.
  if (!compactionSummaryValid(running)) {
    throw new Error(
      `compaction build W=${budgets.window}: the final rolling summary is not a document ` +
        `(${running.length} chars after ${skippedChunks.length}/${chunks.length} skipped chunks) — refusing to freeze a broken baseline`,
    );
  }
  if (skippedChunks.length > chunks.length * MAX_SKIPPED_CHUNK_FRACTION) {
    console.log(
      `[compaction W=${budgets.window}] WARNING: ${skippedChunks.length}/${chunks.length} chunks skipped — ` +
        'this baseline is missing a large share of the session and should be treated as degraded, not representative',
    );
  }
  const snapshot = meters.get(bucket).snapshot();
  const artifact = {
    window: budgets.window,
    chunks: chunks.length,
    chunk_budget: chunkBudget,
    /** The id actually called, and the spec id it stands for on this provider. */
    model: COMPACT_MODEL_OR,
    model_spec: COMPACT_MODEL,
    max_summary_tokens: MAX_SUMMARY_TOKENS,
    /** Chunks whose model output never became a summary; their content is absent. */
    skipped_chunks: skippedChunks,
    build: {
      usd: snapshot.totalUsd,
      calls: snapshot.entries.reduce((n, e) => n + e.calls, 0),
      entries: snapshot.entries,
      bucket,
    },
    summary: running,
  };
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    `built compaction artifact W=${budgets.window} $${snapshot.totalUsd.toFixed(4)} ` +
      `(${chunks.length} chunks x ${chunkBudget} tok, ${artifact.build.calls} calls on ${COMPACT_MODEL_OR}, maxSummaryTokens=${MAX_SUMMARY_TOKENS})` +
      (skippedChunks.length === 0 ? '' : `; SKIPPED ${skippedChunks.length} chunk(s): ${skippedChunks.map((c) => `${c.chunk}/${c.of}`).join(', ')}`),
  );
  return artifact;
}

function truncateToBudget(text, budget) {
  if (heuristic.count(text) <= budget) return text;
  // Newest-first is the whole point of a verbatim tail, so cut from the head.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (heuristic.count(text.slice(mid)) > budget) lo = mid + 1;
    else hi = mid;
  }
  return text.slice(lo);
}

export async function buildArm(scenario, arm, budgets, artifacts) {
  switch (arm) {
    case 'naive-full': {
      return { system: FLAT_SYSTEM, context: renderNativeTranscript(scenario.trace.all(), scenario.blobs), tools: [] };
    }
    case 'truncate-tail': {
      const tail = buildTruncatedTail(scenario, budgets);
      return { system: FLAT_SYSTEM, context: tail.text, tools: [], meta: { fromSeq: tail.fromSeq, events: tail.events } };
    }
    case 'compact-rolling': {
      if (artifacts.compaction === undefined) {
        throw new Error('compact-rolling: the step-4 artifact was not built — that is an explicit step in --phase run');
      }
      const artifact = artifacts.compaction;
      const tail = buildTruncatedTail(scenario, budgets);
      const context = truncateToBudget(
        `# Rolling summary of the earlier session\n${artifact.summary}\n\n# Verbatim tail\n${tail.text}`,
        budgets.zoneB + budgets.zoneC,
      );
      return { system: FLAT_SYSTEM, context, tools: [], meta: { chunks: artifact.chunks } };
    }
    case 'tree-tail-v2':
    case 'tree-oracle':
    case 'tree-escalate':
    case 'tree-hit-keywords':
    case 'tree-tail-static':
    case 'tree-tail-headline': {
      // DS-STAR search-ranking epoch: tree prompt + raw recent events.
      // tree-tail-v2: tools + keyword headlines + fingerprint search + grep + rewriter (full stack).
      // tree-tail-static: no tools + verbose summaries (isolates tool contribution).
      // tree-tail-headline: legacy; same as tree-tail-v2 (retained for backward compat).
      const withTools = arm !== 'tree-tail-static';
      const { assembler, prompt } = buildTreePrompt(scenario, budgets, { withTools, systemText: treeSystemTextFor('tree') });
      // Keyword headlines for all tool-bearing arms: replace prose with fingerprints.
      if (arm === 'tree-tail-v2' || arm === 'tree-tail-headline' || arm === 'tree-oracle' || arm === 'tree-escalate' || arm === 'tree-hit-keywords') {
        // Keyword-list headlines: replace prose with fingerprints extracted from
        // raw events. Each headline = heading + metadata lines + keyword fingerprints.
        // No first-sentence prose — the keywords ARE the headline.
        const retriever = toolContextFor(scenario).retriever;
        const fingerprints = retriever['fingerprintCache'] ?? (() => {
          retriever.beamSearch('warmup', { limit: 1 }); // trigger lazy cache
          return retriever['fingerprintCache'] ?? new Map();
        })();
        for (const block of prompt.blocks) {
          if (block.zone !== 'B' || block.id.startsWith('B:links:')) continue;
          const lines = block.text.split('\n');
          const heading = lines[0];
          const metaLines = lines.filter((l) => /^(files|symbols|tests|artifacts|decisions|open questions|fetchable nodes):/.test(l));
          // Extract node id from block id (B:<nodeId>)
          const nodeId = block.id.startsWith('B:') ? block.id.slice(2) : null;
          const fps = nodeId ? fingerprints.get(nodeId) : null;
          const kwLine = fps && fps.size > 0 ? `keywords: ${[...fps].slice(0, 30).join(', ')}` : '';
          block.text = [heading, ...metaLines, kwLine].filter(Boolean).join('\n');
          block.tokens = heuristic.count(block.text);
        }
        prompt.budgets.zoneB = prompt.blocks.filter((b) => b.zone === 'B').reduce((s, b) => s + b.tokens, 0);
        prompt.budgets.total = prompt.budgets.zoneA + prompt.budgets.zoneB + prompt.budgets.zoneC + prompt.budgets.tail;
      }
      const treeMessages = toMessages(prompt);
      const used = prompt.budgets.total;
      const headroom = Math.max(0, budgets.window - used - budgets.maxReplyTokens);
      const allEvents = scenario.trace.all();
      const tailBoundary = truncationBoundarySeq(allEvents, scenario.blobs, headroom);
      const tailEvents = allEvents.filter((e) => e.seq >= tailBoundary);
      const tailText = tailEvents.length > 0
        ? `# Verbatim recent events (most recent portion of the session trace)\n${renderNativeTranscript(tailEvents, scenario.blobs)}`
        : '';
      const tailTokens = heuristic.count(tailText);
      const messagesWithTail = tailText
        ? [...treeMessages, { role: 'user', content: tailText }]
        : treeMessages;
      return {
        system: prompt.system,
        messages: messagesWithTail,
        tools: withTools ? toolSchemasForArm(arm) : [],
        assembler,
        handlers: withTools ? handlersForArm(arm) : {},
        meta: {
          zoneB: prompt.budgets.zoneB,
          zoneC: prompt.budgets.zoneC,
          overBudget: prompt.budgets.overBudget,
          contractVersion: contractVersionFor(arm),
          legacySurface: LEGACY_SURFACE_ARMS.has(arm),
          tailEvents: tailEvents.length,
          tailTokens,
          tailFromSeq: tailBoundary,
          headroom,
        },
      };
    }
    case 'tree':
    case 'tree-wide':
    case 'tree-static':
    case 'tree-slice':
    case 'tree-thin':
    case 'tree-verbatim':
    case 'tree-semantic':
    case 'tree-grep': {
      // Every tree-shaped arm assembles the SAME prompt from the SAME store at
      // the SAME rootKeep. What differs is exactly one of three things, and the
      // wiring table at `handlersForArm` says which per arm:
      //   - the tool surface behind the handlers (`handlersForArm`)
      //   - the Zone A contract text (`treeSystemTextFor`)
      //   - the retriever's ranking, i.e. whether L3 vectors exist (`toolCtx`)
      // `tree-wide` still differs only in the rootKeep already derived into
      // `budgets`; `tree-static` still differs only in withholding the tools.
      const withTools = arm !== 'tree-static';
      const systemText = treeSystemTextFor(arm);
      const { assembler, prompt } = buildTreePrompt(scenario, budgets, { withTools, systemText });
      const semantic = arm === 'tree-semantic' ? await buildSemanticToolCtx(scenario) : undefined;
      return {
        system: prompt.system,
        messages: toMessages(prompt),
        tools: withTools ? CONTEXT_TOOL_SCHEMAS : [],
        assembler,
        handlers: handlersForArm(arm),
        // Overrides the caller's frozen-store context for this arm only; the
        // copy it points at carries L3, so `context_search` takes the vector
        // path (`retriever.ts`: an embedder plus a populated index replaces the
        // lexical beam). Every other arm keeps the lexical ranking.
        ...(semantic === undefined ? {} : { toolCtx: semantic.toolCtx, semantic }),
        meta: {
          zoneB: prompt.budgets.zoneB,
          zoneC: prompt.budgets.zoneC,
          overBudget: prompt.budgets.overBudget,
          contractVersion: contractVersionFor(arm),
          legacySurface: LEGACY_SURFACE_ARMS.has(arm),
          ...(semantic === undefined ? {} : { embedUsd: semantic.usd, embedCalls: semantic.usage.calls, embedTokens: semantic.usage.tokens }),
        },
      };
    }
    case 'memgpt':
      // R2, the named plug point. Deliberately a throw, not a stub that scores
      // zero: an unimplemented arm reported as 0.00 is a fabricated baseline.
      throw new Error(
        "arm 'memgpt' is not implemented — this is the R2 plug point. It runs over the same frozen manifest + " +
          'questions.json; implement it here and add it to ARM_IDS-scored arms.',
      );
    default:
      throw new Error(`unknown arm "${arm}" — known: ${ARM_IDS.join(', ')}`);
  }
}

const SMOKE_QUESTION =
  'Before answering anything else, call context_search once with a query of your choice, then reply with the id of the first result.';

export async function runOneReplicate(scenario, built, question, model, provider, budgets, replyMode = 'fixed-ceiling') {
  // Last line of defence. 180 scored runs once asked two models the empty
  // string and dutifully recorded 0/1 for the small talk that came back; a run
  // that cannot state its own question is not a data point.
  const asked = questionTextValid(question);
  if (!asked.ok) throw new Error(`refusing to run with an unusable question (${asked.reason}): ${JSON.stringify(question)}`);
  const messages =
    built.messages !== undefined
      ? [...built.messages, { role: 'user', content: question }]
      : [
          { role: 'user', content: built.context },
          { role: 'user', content: question },
        ];
  const searchQueries = [];
  const fetchedIds = [];
  const fetchedDepths = []; // Record depth argument for each context_fetch
  // Per-REPLICATE search state. The handler closures are built once per arm,
  // so anything they remember would otherwise leak across runs and make a
  // replicate depend on the one before it.
  if (built.toolCtx !== undefined) {
    built.toolCtx._searchState = { seen: new Set(), calls: 0 };
    built.toolCtx._hitKeywordK = [];
  }
  /**
   * One record per model call, `TurnRecord`-shaped (`eval/src/types.ts`) plus
   * the derived `promptTokens` and zone budget decomposition. This is the
   * context-size series: the whole claim is that the tree's prompt stays flat
   * where a baseline's grows, and that is only visible per turn. Pure
   * bookkeeping on usage the provider already returned — it costs no extra call.
   */
  const turnRecords = [];
  /** cl100k tokens dropped by the window cap on appended results (0 for most). */
  let resultTokensTruncated = 0;
  /** Always exact, even where the token figure had to be a lower bound. */
  let resultCharsTruncated = 0;
  let resultsTruncated = 0;
  let resultTruncationEstimated = 0;
  let annotateRefused = 0;
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let finalText = '';
  let status = 'turn_cap';
  let turns = 0;
  const started = Date.now();
  let lastToolSig = '';
  let stallCount = 0;
  const STALL_LIMIT = 3;

  const hasAssembler = built.assembler !== undefined;

  for (let turn = 1; turn <= (built.tools.length > 0 ? MAX_TURNS : 1); turn += 1) {
    turns = turn;
    const turnStarted = Date.now();

    let maxTokens;
    if (replyMode === 'no-limit') {
      maxTokens = undefined;
    } else if (replyMode === 'allowance') {
      const assembled = built.assembler?.assemble({ toolSchemasText: built.tools.length > 0 ? TOOL_SCHEMAS_TEXT : '' });
      maxTokens = assembled?.budgets?.replyAllowance ?? budgets.maxReplyTokens;
    } else {
      maxTokens = budgets.maxReplyTokens;
    }

    const result = await provider.complete({
      model,
      system: built.system,
      messages,
      ...(built.tools.length > 0 ? { tools: built.tools } : {}),
      maxTokens,
    });
    usage = addUsage(usage, result.usage);

    // Capture zone budget decomposition for this turn (tree arms only)
    let zoneBudgets = null;
    if (hasAssembler) {
      const assembled = built.assembler.assemble({ toolSchemasText: built.tools.length > 0 ? TOOL_SCHEMAS_TEXT : '' });
      zoneBudgets = {
        zoneA: assembled.budgets.zoneA,
        zoneB: assembled.budgets.zoneB,
        zoneC: assembled.budgets.zoneC,
        tail: assembled.budgets.tail,
        total: assembled.budgets.total,
        overBudget: assembled.budgets.overBudget,
      };
    }

    turnRecords.push({
      index: turn,
      turn,
      latencyMs: Date.now() - turnStarted,
      usage: { ...result.usage },
      // Everything the provider billed as prompt, however it was cached.
      promptTokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
      input: result.usage.input,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      output: result.usage.output,
      toolCalls: result.toolCalls.map((call) => call.name),
      stopReason: result.stopReason ?? null,
      // Instrumentation bundle (Step 5):
      zoneBudgets,
      fetchedDepths: [], // populated below per turn
      nonAgentModelCalls: 0, // leaf summarizer calls happen at ingestion, not during run
    });
    messages.push({ role: 'assistant', content: result.text.length > 0 ? result.text : '(invoking tool)' });
    if (result.toolCalls.length === 0) {
      finalText = result.text;
      status = 'completed';
      break;
    }
    // Track depths for context_fetch calls in this turn
    const turnFetchedDepths = [];
    for (const call of result.toolCalls) {
      if (call.name === CONTEXT_SEARCH && typeof call.input.query === 'string') searchQueries.push(call.input.query);
      if (call.name === CONTEXT_FETCH && typeof call.input.branch_id === 'string') {
        fetchedIds.push(call.input.branch_id);
        if (typeof call.input.depth === 'string') {
          turnFetchedDepths.push(call.input.depth);
          fetchedDepths.push({ turn, branchId: call.input.branch_id, depth: call.input.depth });
        }
      }
      let outcome;
      if (call.name === ANNOTATE) {
        annotateRefused += 1;
        outcome = FROZEN_ANNOTATE_REFUSAL;
      } else {
        // The space this result will actually have, computed against the
        // conversation as it stands THIS turn — not the build-time estimate the
        // narrowing used to divide by two and hope. A handler that narrows to
        // this number is the only cut in the path.
        if (built.toolCtx !== undefined) {
          const live = appendHeadroom({
            prefix: `[tool_result ${call.name}] `,
            system: built.system,
            messages,
            tools: built.tools,
            window: budgets.window,
            maxReplyTokens: budgets.maxReplyTokens,
          });
          built.toolCtx._liveHeadroom = live;
          // The retriever counts in heuristic tokens; this budget is in the
          // tokenizer the provider bills. Same conversion the zone budgets use
          // (D19): a heuristic count H bills at ~H*ratio, so H may be as large
          // as live/ratio and still fit.
          built.toolCtx._liveHeadroomHeuristic = Math.floor(live / budgets.ratio);
        }
        // `built.handlers` defaults to the real MCP table; overridable so the
        // window-cap path can be driven with a synthetic oversized result.
        const handler = (built.handlers ?? HANDLERS)[call.name];
        outcome = handler
          ? await handler(built.toolCtx, call.input)
          : { ok: false, error: { code: 'invalid_input', message: `unknown tool: ${call.name}` } };
      }
      // Strip duplicate summary text from search results — Zone B already
      // shows the summaries, so repeating them in the appended result wastes
      // the window. Keep coordinates (node_id, title, score, meta) only.
      if (call.name === CONTEXT_SEARCH && outcome.ok && Array.isArray(outcome.data?.hits)) {
        outcome = {
          ...outcome,
          data: {
            ...outcome.data,
            hits: outcome.data.hits.map(({ snippet, text: _text, ...rest }) => rest),
          },
        };
      }
      const text = toCallToolResult(outcome).content[0]?.text ?? '';
      // Budget the append against what is actually left in the window.
      const prefix = `[tool_result ${call.name}] `;
      const capped = capToolResult({
        text,
        prefix,
        system: built.system,
        messages,
        tools: built.tools,
        window: budgets.window,
        maxReplyTokens: budgets.maxReplyTokens,
      });
      if (capped.droppedChars > 0) {
        resultsTruncated += 1;
        resultCharsTruncated += capped.droppedChars;
        if (capped.truncated === null) resultTruncationEstimated += 1;
        else resultTokensTruncated += capped.truncated;
      }
      messages.push({ role: 'user', content: prefix + capped.text });
    }
    if (turnFetchedDepths.length > 0 && turnRecords.length > 0) {
      turnRecords[turnRecords.length - 1].fetchedDepths = turnFetchedDepths;
    }
    // Stall detection: 3 consecutive turns with identical tool-call signatures.
    const sig = result.toolCalls.map((c) => c.name).sort().join(',');
    if (sig === lastToolSig) {
      stallCount += 1;
      if (stallCount >= STALL_LIMIT) { status = 'stalled'; break; }
    } else {
      stallCount = 0;
    }
    lastToolSig = sig;
  }
  return {
    status,
    modelTurns: turns,
    finalText,
    searched: searchQueries.length > 0,
    fetched: fetchedIds.length > 0,
    searchQueries,
    fetchedIds,
    fetchedDepths, // Instrumentation: depth argument for each context_fetch call
    // Keywords attached per hit, per search call. All-zero means the mechanism
    // never fired and the arm ran as its own baseline.
    hitKeywordK: built.toolCtx?._hitKeywordK ?? [],
    annotateRefused,
    resultTokensTruncated,
    resultCharsTruncated,
    resultsTruncated,
    resultTruncationEstimated,
    /** What the provider was handed on the LAST turn, in cl100k — the number the 400 was about. */
    peakRequestTokens: requestTokens({ system: built.system, messages, tools: built.tools }),
    usage,
    /** `RunResult.turns: TurnRecord[]` — same field name, same shape (§15). */
    turns: turnRecords,
    durationMs: Date.now() - started,
  };
}

async function runArms(scenario, options) {
  const smoke = process.env.TRANSPLANT_SMOKE === '1';
  const window = Number.parseInt(options.window ?? String(WINDOWS[0]), 10);
  if (!WINDOWS.includes(window)) throw new Error(`--window must be one of ${WINDOWS.join(', ')}`);
  // Checks the freeze AND leaves the store composed at this window's root, so
  // every arm below reads the root the manifest pinned.
  const manifest = assertFrozen(scenario, { window });
  const ratio = manifest.ratio ?? measureRatio(scenario);
  const budgets = budgetsFor(scenario, window, ratio, ratioVerdict(ratio).slackFraction);
  // Graft 6: the derived value is EXPORTED, never hand-edited into loop.ts.
  process.env.EVAL_LAZY_TOKENS = String(budgets.lazy);
  console.log(
    `derived: EVAL_LAZY_TOKENS=${budgets.lazy} --zone-b-budget=${budgets.zoneB} --zone-c-budget=${budgets.zoneC} ` +
      `K=${budgets.K} rootKeep=${budgets.rootKeep} (root ${budgets.rootBlockTokens} tok, ${budgets.branchesSurviving} branches ` +
      `seq ${budgets.branchSeqRange?.from}-${budgets.branchSeqRange?.to}) maxTokens=${budgets.maxReplyTokens}`,
  );

  const models = options.model === undefined ? [...MODELS] : [options.model];
  const arms = options.arm === undefined ? [...SCORED_ARMS] : options.arm.split(',').map((s) => s.trim());
  const reps = Number.parseInt(options.reps ?? String(REPS), 10);
  const meters = new Map();

  const questionsPath = join(scenario.artifacts, options.questionsFile ?? 'questions.json');
  let questions;
  if (smoke) {
    questions = [{ id: 'smoke', stratum: 'smoke', question: SMOKE_QUESTION, answer_literals: [], answer_regexes: [], node_id: null }];
  } else {
    if (!existsSync(questionsPath)) throw new Error(`no questions.json at ${questionsPath} — run --phase prep --allow-live`);
    questions = JSON.parse(readFileSync(questionsPath, 'utf8')).questions;
    if (options.stratum !== undefined) questions = questions.filter((q) => q.stratum === options.stratum);
    // Pre-flight, before a single token is spent: an unusable question set
    // should abort the batch, not produce one error row per run. (Layer (c)
    // inside `runOneReplicate` stays as the last-resort guard for a question
    // that reaches it by some other path.)
    const unusable = questions
      .map((q) => ({ id: q.id, ...questionTextValid(q.question) }))
      .filter((q) => !q.ok);
    if (questions.length === 0) throw new Error(`no questions to run from ${questionsPath}`);
    if (unusable.length > 0) {
      throw new Error(
        `${unusable.length}/${questions.length} question(s) in ${questionsPath} are unusable — refusing to run:\n` +
          unusable.map((q) => `  ${q.id}: ${q.reason}`).join('\n') +
          '\nRe-run `--phase prep --allow-live`; it now fails loudly rather than writing empty questions.',
      );
    }
  }

  const retriever = new TreeRetriever({ store: scenario.store, blobs: scenario.blobs, trace: scenario.trace });
  const toolCtx = {
    config: scenario.config,
    handle: { config: scenario.config, paths: scenario.paths, trace: scenario.trace, blobs: scenario.blobs, store: scenario.store, close() {} },
    retriever,
  };

  // Step 4 is an EXPLICIT step, not a side effect of the first compact-rolling
  // call: built once, before any answering model is touched, so its cost lands
  // in its own ledger line and its own console line.
  const artifacts = {};
  if (arms.includes('compact-rolling')) {
    artifacts.compaction = await buildCompactionArtifact(scenario, budgets, meters);
    // `build: null` is the explicit cost-unattributed marker on an artifact
    // built before the build had its own ledger; treat it like a missing one.
    if (artifacts.compaction.build == null) {
      console.log(
        `compaction artifact W=${window} loaded from disk with NO build-cost record (cost-unattributed` +
          `${artifacts.compaction.observed_meter_delta_usd === undefined ? '' : `; observed meter delta $${artifacts.compaction.observed_meter_delta_usd}`})`,
      );
    } else {
      console.log(`compaction artifact W=${window} ready; build $${artifacts.compaction.build.usd.toFixed(4)} (${artifacts.compaction.build.bucket})`);
    }
  }
  const compactionBuildUsd = artifacts.compaction?.build?.usd ?? null;
  const compactionSkippedChunks = artifacts.compaction?.skipped_chunks ?? [];
  if (compactionSkippedChunks.length > 0) {
    console.log(
      `compaction artifact W=${window} has ${compactionSkippedChunks.length} SKIPPED chunk(s) ` +
        `(${compactionSkippedChunks.map((c) => `${c.chunk}/${c.of}`).join(', ')}) — that content is absent from the baseline summary`,
    );
  }

  // Hoisted so incremental writes can land results as each run completes.
  const out = join(scenario.artifacts, process.env.TRANSPLANT_MOCK === '1' ? 'results-mock' : 'results');
  mkdirSync(out, { recursive: true });
  const replyTag = options.replyMode !== undefined ? `-reply-${options.replyMode}` : '';
  const questionsTag = options.questionsFile !== undefined ? `-${options.questionsFile.replace(/\.json$/, '')}` : '';
  const name = `${smoke ? 'smoke' : 'run'}-W${window}-${arms.join('+')}${replyTag}${questionsTag}-${models.map((m) => m.replaceAll('/', '_')).join('+')}.json`;

  const rows = [];
  for (const model of models) {
    const provider = providerFor(model, meters);
    for (const arm of arms) {
      // Only the tree arms have an arm-dependent budget (their rootKeep); the
      // window, K, zone sizes and reply cap are shared, so the baselines are
      // byte-for-byte what they were before this arm existed.
      const armBudgets = TREE_ARMS.includes(arm)
        ? budgetsFor(scenario, window, ratio, ratioVerdict(ratio).slackFraction, arm)
        : budgets;
      if (TREE_ARMS.includes(arm)) {
        console.log(
          `  [${arm}] rootKeep=${armBudgets.rootKeep} root=${armBudgets.rootBlockTokens} tok, ` +
            `${armBudgets.branchesSurviving} branch summaries visible ` +
            `(seq ${armBudgets.branchSeqRange?.from ?? '-'}-${armBudgets.branchSeqRange?.to ?? '-'})`,
        );
      }
      // `toolCtx` first so an arm that builds its OWN context (tree-semantic,
      // whose store copy carries L3) overrides it rather than being clobbered.
      const armResult = await buildArm(scenario, arm, armBudgets, artifacts);
      // Pass headroom to toolCtx so narrowing-aware fetch can size its band.
      const armToolCtx = { ...toolCtx, _headroom: armResult.meta?.headroom ?? 20000 };
      const built = { toolCtx: armToolCtx, ...armResult };
      const n = smoke ? SMOKE_N : questions[0]?.exploratory === true ? SPANNING_REPS : reps;
      // `naive-full` at small windows is a PRECONDITION (context-death evidence).
      // At windows large enough to hold the trace, run all questions and reps so
      // the ground-truth score is comparable to other arms.
      const nativeFitsWindow = arm === 'naive-full' && options.window >= 200000;
      const armQuestions = arm === 'naive-full' && !nativeFitsWindow ? questions.slice(0, 1) : questions;
      const armReps = arm === 'naive-full' && !nativeFitsWindow ? 1 : n;
      // Reply mode from --reply-mode applies to tree arms only. Baselines
      // (truncate-tail, compact-rolling, naive-full) always use no-limit because
      // reasoning models spend a tight maxReplyTokens on thinking and return
      // empty completions — the exact bug this experiment is measuring.
      const replyMode = TREE_ARMS.includes(arm) ? (options.replyMode ?? 'no-limit') : 'no-limit';
      for (const question of armQuestions) {
        // The oracle arm's search returns THIS question's source branch. Set
        // per question, never read by any other arm.
        built.toolCtx._oracleNodeIds = question.node_ids ?? (question.node_id == null ? [] : [question.node_id]);
        for (let rep = 1; rep <= armReps; rep += 1) {
          try {
            let r;
            for (let attempt = 1; attempt <= 2; attempt += 1) {
              try {
                r = await runOneReplicate(scenario, built, question.question, model, provider, armBudgets, replyMode);
                break;
              } catch (error) {
                // A malformed provider body is transient and costs the run;
                // one retry converts a lost cell into a data point. Anything
                // else propagates to the classifier below untouched.
                const kind = classifyRunError(error);
                if (!kind.retryable || attempt === 2) throw error;
                console.log(`  ${arm}/${model}/${question.id}#${rep}: ${kind.status}, retrying once`);
              }
            }
            // A run the HARNESS stopped has no answer to grade. `runOneReplicate`
            // returns `status: 'turn_cap'` with `finalText: ''` when the model
            // was still calling tools at MAX_TURNS, and grading '' scores it 0
            // — a wrong answer the model never gave, which then enters the
            // arm's MEAN. Measured in the committed W=32768 fixtures: 7 of 60
            // tree-wide rows and 2 of 157 primary tree rows, one of them on the
            // tail stratum that feeds the pre-registered regression check.
            // `cost_cap` rows in this same loop already push `score: null`; this
            // is that rule applied to the other harness-imposed stop, and it is
            // the same correction `eval/src/loop.ts` took on 2026-09-02.
            //
            // Unlike the live suite there is no filesystem to inspect here: the
            // grader matches the model's final text, so a stopped run cannot
            // have passed. `null` is the only honest value, never `0`.
            const gradable = r.status !== 'turn_cap' && r.status !== 'time_cap' && r.status !== 'stalled';
            const grade =
              smoke || question.answer_literals.length === 0 || !gradable
                ? { score: null, success: null }
                : gradeAnswer(r.finalText, question);
            rows.push({ scenario: scenario.id, model, arm, window, question: question.id, stratum: question.stratum, rep, ...r, ...grade });
            console.log(
              `  ${arm}/${model}/${question.id}#${rep}: ${r.status} turns=${r.modelTurns} searched=${r.searched} fetched=${r.fetched} ` +
                `score=${grade.score ?? '-'} tok=${r.usage.input + r.usage.output} req=${r.peakRequestTokens} ` +
                `cut=${r.resultTokensTruncated} $${meters.get(model).totalUsd().toFixed(4)}`,
            );
            // Incremental write so progress is visible and a failing run can be killed early.
            writeFileSync(
              join(out, name),
              `${JSON.stringify({ budgets, code: codeFingerprint(), answeringUsd: answeringSpend(meters), compactionBuildUsd, compactionSkippedChunks, compaction: artifacts.compaction?.build ?? null, rows, partial: true }, null, 2)}\n`,
            );
          } catch (error) {
            if (error instanceof CostCapExceededError) {
              console.log(`[cost cap] ${model} stopped at $${meters.get(model).totalUsd().toFixed(4)} (cap $${CAP_USD_PER_MODEL})`);
              rows.push({ scenario: scenario.id, model, arm, window, question: question.id, stratum: question.stratum, rep, status: 'cost_cap', score: null });
              break;
            }
            // Step 5's routing signal: unparseable tool args mean this model's
            // tree arm runs as `tree-static` and `deep` is UNTESTABLE for it.
            const kind = classifyRunError(error);
            console.log(
              `  ${arm}/${model}/${question.id}#${rep}: ${kind.status} ${error.message.slice(0, 160)}` +
                (kind.hint === null ? '' : `\n    -> ${kind.hint}`),
            );
            rows.push({
              scenario: scenario.id,
              model,
              arm,
              window,
              question: question.id,
              stratum: question.stratum,
              rep,
              status: kind.status,
              error: error.message,
              errorHint: kind.hint,
              // Without a stack the last one took a full offline reproduction
              // to locate; three frames would have named it immediately.
              errorStack: (error.stack ?? '').split('\n').slice(0, 4).join('\n'),
              score: null,
            });
          }
          const total = [...meters.values()].reduce((sum, m) => sum + m.totalUsd(), 0);
          if (total > CAP_USD_TOTAL) throw new Error(`total spend $${total.toFixed(2)} exceeded the $${CAP_USD_TOTAL} cap`);
        }
      }
      // The semantic arm embedded a COPY of the store into a temp directory;
      // release it once its cell is done rather than leaving one per (model,
      // arm) behind for the run.
      built.semantic?.cleanup();
    }
  }

  const truncatedTotal = rows.reduce((n, r) => n + (r.resultTokensTruncated ?? 0), 0);
  const truncatedRuns = rows.filter((r) => (r.resultsTruncated ?? 0) > 0).length;
  writeFileSync(
    join(out, name),
    `${JSON.stringify({ budgets, code: codeFingerprint(), answeringUsd: answeringSpend(meters), compactionBuildUsd, compactionSkippedChunks, compaction: artifacts.compaction?.build ?? null, rows, partial: false }, null, 2)}\n`,
  );
  console.log(
    `\nwrote ${join(out, name)}; answering spend ${[...meters]
      .filter(([bucket]) => !bucket.startsWith('compaction:'))
      .map(([m, meter]) => `${m}=$${meter.totalUsd().toFixed(4)}`)
      .join(' ')}` + `; compaction build $${compactionBuildUsd === null ? 'unattributed' : compactionBuildUsd.toFixed(4)}`,
  );
  const truncatedChars = rows.reduce((n, r) => n + (r.resultCharsTruncated ?? 0), 0);
  const estimated = rows.reduce((n, r) => n + (r.resultTruncationEstimated ?? 0), 0);
  console.log(
    `window cap: ${truncatedRuns}/${rows.length} run(s) had an appended result truncated, ` +
      `${truncatedTotal} cl100k token(s) / ${truncatedChars} char(s) dropped in total` +
      (estimated > 0 ? ` (${estimated} of them pre-cut, so the token figure is a lower bound)` : ''),
  );
}

/** Median of a numeric array — the per-turn central line for the charts. */
export function median(xs) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Chart-ready context-growth series per (arm, model, W): every rep's own
 * prompt-token-by-turn line, plus the per-turn median across reps. Median, not
 * mean, because a single run that flails to the turn cap should not bend the
 * central line — the same reason the §15 tables report medians.
 */
export function contextGrowthSeries(rows) {
  const cells = new Map();
  for (const row of rows) {
    if (!Array.isArray(row.turns) || row.turns.length === 0) continue;
    const key = `${row.model}|${row.window}|${row.arm}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(row);
  }
  const out = [];
  for (const [key, group] of [...cells].sort()) {
    const [model, window, arm] = key.split('|');
    const reps = group.map((row) => ({
      question: row.question,
      stratum: row.stratum,
      rep: row.rep,
      points: row.turns.map((t) => ({
        turn: t.turn ?? t.index,
        promptTokens: t.promptTokens,
        input: t.input,
        cacheRead: t.cacheRead,
        cacheWrite: t.cacheWrite,
        output: t.output,
      })),
    }));
    const maxTurn = Math.max(...reps.map((r) => r.points.length));
    const medianByTurn = [];
    for (let turn = 1; turn <= maxTurn; turn += 1) {
      const at = reps.map((r) => r.points.find((p) => p.turn === turn)).filter((p) => p !== undefined);
      medianByTurn.push({
        turn,
        n: at.length,
        promptTokens: median(at.map((p) => p.promptTokens)),
        output: median(at.map((p) => p.output)),
      });
    }
    out.push({ model, window: Number.parseInt(window, 10), arm, reps, medianByTurn });
  }
  return out;
}

/**
 * Names a failed run instead of recording a bare message.
 *
 * The batch-2 tree arm lost 14 of 60 runs at W=32768 to
 * `Cannot read properties of undefined (reading '0')` — sporadic, per-call,
 * and untraceable from the row. It is not harness code: the §9 handlers were
 * exercised offline against every node kind (and a bogus id) without a throw.
 * It is `packages/core/src/models/openrouter.ts:153`, which reads
 * `response.choices[0]` and only THEN checks `choice === undefined` — so a
 * body with no `choices` key at all throws before the guard can fire.
 * Classified (and retried once) here rather than patched there because core is
 * outside this harness's remit; the one-line fix is `response.choices?.[0]`.
 */
export function classifyRunError(error) {
  const message = error?.message ?? String(error);
  if (/Cannot read properties of undefined \(reading '0'\)/.test(message)) {
    return {
      status: 'provider_bad_response',
      retryable: true,
      hint:
        'OpenRouter returned a body with no `choices` array. packages/core/src/models/openrouter.ts:153 ' +
        'indexes `response.choices[0]` BEFORE its `choice === undefined` guard, so the guard never fires. ' +
        'One-line fix: `const choice = response.choices?.[0];`',
    };
  }
  if (error instanceof CostCapExceededError) return { status: 'cost_cap', retryable: false, hint: null };
  if (error instanceof ModelCallError) return { status: 'model_call_error', retryable: false, hint: null };
  return { status: 'error', retryable: false, hint: null };
}

// ── verdict (Step 6's reporting half) ────────────────────────────────────
function runVerdict(scenario) {
  const dir = join(scenario.artifacts, 'results');
  if (!existsSync(dir)) throw new Error(`no results under ${dir}`);
  const rows = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json') || file.startsWith('smoke-')) continue;
    rows.push(...JSON.parse(readFileSync(join(dir, file), 'utf8')).rows);
  }
  const cells = new Map();
  for (const row of rows) {
    const key = `${row.model}|${row.window}|${row.arm}|${row.stratum}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(row);
  }

  console.log('\n=== MEAN score / tokens / turns per (model, W, arm, stratum) ===');
  console.log('| model | W | arm | stratum | n | MEAN score | tokens | turns | ms | fetched |');
  console.log('| --- | --: | --- | --- | --: | --: | --: | --: | --: | --: |');
  for (const [key, group] of [...cells].sort()) {
    const [model, window, arm, stratum] = key.split('|');
    const scored = group.filter((r) => typeof r.score === 'number').map((r) => r.score);
    const tok = group.filter((r) => r.usage).map((r) => r.usage.input + r.usage.output);
    console.log(
      `| ${model} | ${window} | ${arm} | ${stratum} | ${group.length} | ${mean(scored)?.toFixed(3) ?? '-'} | ` +
        `${mean(tok)?.toFixed(0) ?? '-'} | ${mean(group.map((r) => r.modelTurns ?? 0))?.toFixed(2) ?? '-'} | ` +
        `${mean(group.map((r) => r.durationMs ?? 0))?.toFixed(0) ?? '-'} | ${group.filter((r) => r.fetched).length}/${group.length} |`,
    );
  }

  // ── context size vs turn ───────────────────────────────────────────────
  // The line charts baseline and tree are plotted on: one series per rep plus
  // the per-turn median, so a growing baseline and a flat tree land on the
  // same axes. Derived entirely from the persisted `turns: TurnRecord[]`.
  const series = contextGrowthSeries(rows);
  const seriesPath = join(scenario.artifacts, 'context-growth.json');
  writeFileSync(seriesPath, `${JSON.stringify(series, null, 2)}\n`);
  console.log('\n=== context size vs turn (median promptTokens; per-rep series in context-growth.json) ===');
  console.log('| model | W | arm | reps | median promptTokens by turn |');
  console.log('| --- | --: | --- | --: | --- |');
  for (const cell of series) {
    console.log(`| ${cell.model} | ${cell.window} | ${cell.arm} | ${cell.reps.length} | ${cell.medianByTurn.map((p) => p.promptTokens).join(', ')} |`);
  }
  console.log(`wrote ${seriesPath}`);

  console.log('\n=== tree − compact-rolling, bootstrap 95% CI + pre-registered escalation ===');
  for (const model of new Set(rows.map((r) => r.model))) {
    for (const window of new Set(rows.map((r) => r.window))) {
      for (const stratum of PRIMARY_STRATA) {
        const pick = (arm) =>
          rows.filter((r) => r.model === model && r.window === window && r.arm === arm && r.stratum === stratum && typeof r.score === 'number').map((r) => r.score);
        const tree = pick('tree').length > 0 ? pick('tree') : pick('tree-static');
        const compact = pick('compact-rolling');
        // R6: the ablation is reported beside the primary contrast, from the
        // same results directory and the same epoch — one variable, Zone B
        // composition, so a difference here is attributable to it and nothing
        // else. Reported whenever the cells exist; absent otherwise.
        const wide = pick('tree-wide');
        if (wide.length > 0 && tree.length > 0) {
          const ablation = bootstrapCI(wide, tree);
          console.log(
            `${model} W=${window} ${stratum}: R6 tree-wide − tree = ${ablation.point.toFixed(3)} ` +
              `CI [${ablation.lo.toFixed(3)}, ${ablation.hi.toFixed(3)}] ` +
              `${ablation.crossesZero ? 'crosses 0 (no detectable effect of Zone B width)' : 'clear of 0'}`,
          );
        }
        if (tree.length === 0 || compact.length === 0) continue;
        const ci = bootstrapCI(tree, compact);
        const esc = escalationN(mean(tree), mean(compact));
        console.log(
          `${model} W=${window} ${stratum}: Δ=${ci.point.toFixed(3)} CI [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] ` +
            `${ci.crossesZero ? `CROSSES 0 -> escalate to n=${esc.capped} (binomial ${esc.binomial}, pooled-σ ${esc.pooled})` : 'does not cross 0'}`,
        );
        // §15.2's numeric criteria, stated as the criteria and not as a hint.
        const truncate = rows
          .filter((r) => r.model === model && r.window === window && r.arm === 'truncate-tail' && r.stratum === stratum && typeof r.score === 'number')
          .map((r) => r.score);
        if (stratum === 'head') console.log(`  §15.2 head: tree ${mean(tree).toFixed(3)} >= compact ${mean(compact).toFixed(3)} + 0.25 -> ${mean(tree) >= mean(compact) + 0.25}`);
        if (stratum === 'tail' && truncate.length > 0) {
          const ok = mean(tree) >= mean(truncate) - 0.05;
          console.log(`  §15.2 tail: tree ${mean(tree).toFixed(3)} >= truncate ${mean(truncate).toFixed(3)} − 0.05 -> ${ok}${ok ? '' : ' (REGRESSION, not a tradeoff)'}`);
        }
      }
    }
  }
}

// ── cli ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [flag, inline] = arg.slice(2).split('=');
    const key = flag.replaceAll(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (inline !== undefined) options[key] = inline;
    else if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else options[key] = true;
  }
  return options;
}

/**
 * Guarded so the pure functions above can be imported by `eval/test/` without
 * the import opening a store, reading a manifest, or spending anything.
 */
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const options = parseArgs(process.argv.slice(2));
  const scenario = openScenario(options.scenario ?? 's1');
  try {
    switch (options.phase ?? 'gates') {
      case 'gates':
        await runGates(scenario, options);
        break;
      case 'prep':
        await runPrep(scenario, options);
        break;
      case 'prep-overflow':
        await runPrepOverflow(scenario, options);
        break;
      case 'run':
        await runArms(scenario, options);
        break;
      case 'verdict':
        runVerdict(scenario);
        break;
      default:
        throw new Error(`unknown --phase "${options.phase}" — one of gates|prep|prep-overflow|run|verdict`);
    }
  } finally {
    scenario.close();
  }
}
