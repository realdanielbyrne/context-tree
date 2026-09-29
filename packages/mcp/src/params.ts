/**
 * THE parameter registry. Every tunable of the pipeline is one row here, and
 * everything else derives from it: the `PipelineParams` type, environment parsing and
 * validation, the tools' argument schemas (so `describe` IS the documentation an agent
 * reads), `GET /v1/params`, and — outside this package, through `describeParams` —
 * the experiment harness's forwarded keys and knob tables. A parameter that is not a
 * row here does not exist; nothing restates this list.
 *
 * Every default is PROVISIONAL in core (hand-set or borrowed, never swept), which is
 * why each is a parameter at all.
 */
import { z, type ZodRawShape, type ZodType } from 'zod';
import {
  DEFAULT_ANCHOR,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_EVICTION_WEIGHTS,
  DEFAULT_PRIORITY_HALFLIFE,
  DEFAULT_RRF_K,
  DEFAULT_SOFT_TARGET_FRAC,
  DRIFT_K,
  DRIFT_TAU,
  type BoundaryConfig,
} from '@context-tree/core';

/**
 * Which stage reads the parameter — and therefore which tool takes it as an argument.
 * `[]` means fixed when the server starts, because it shapes the cached snapshot.
 */
export type Stage = 'assemble' | 'fold' | 'evict' | 'summarize';

interface Base {
  readonly key: string;
  readonly env: string;
  readonly stages: readonly Stage[];
  readonly describe: string;
}
interface NumberSpec extends Base {
  readonly kind: 'number' | 'int';
  readonly default: number;
  /** Inclusive lower bound; `exclusiveMin` when the bound itself is invalid. */
  readonly min: number;
  readonly exclusiveMin?: boolean;
  readonly max?: number;
}
interface EnumSpec extends Base {
  readonly kind: 'enum';
  readonly values: readonly string[];
  readonly default: string;
}
interface BoolSpec extends Base {
  readonly kind: 'bool';
  readonly default: boolean;
}
export type ParamSpec = NumberSpec | EnumSpec | BoolSpec;

const W = DEFAULT_EVICTION_WEIGHTS;

export const PIPELINE_PARAMS = [
  { key: 'unit', env: 'CT_CT_UNIT', stages: [], kind: 'enum', values: ['turn', 'phase'], default: 'turn',
    describe: 'What the pipeline retains or drops: a turn (one host message) or a whole phase.' },
  { key: 'protection', env: 'CT_CT_PROTECTION', stages: ['fold', 'evict'], kind: 'enum', values: ['soft', 'hard'], default: 'soft',
    describe: 'soft: the recency anchor is a score bonus that yields when the budget cannot otherwise be met. hard: anchored units are never touched.' },
  { key: 'anchor', env: 'CT_CT_ANCHOR', stages: ['assemble', 'fold', 'evict'], kind: 'int', min: 0, default: DEFAULT_ANCHOR,
    describe: 'Recency anchor A: the last A units are protected, most strongly the newest.' },
  { key: 'protectionBonus', env: 'CT_CT_PROTECTION_BONUS', stages: ['fold', 'evict'], kind: 'number', min: 0, default: W.priority,
    describe: 'Score added to the newest unit under soft protection, halving with distance. On the same scale as the weights, so an anchored unit can be outscored; a value above their sum makes the anchor yield only last.' },
  { key: 'softTargetFrac', env: 'CT_CT_SOFT_TARGET_FRAC', stages: ['assemble'], kind: 'number', min: 0, max: 1, default: DEFAULT_SOFT_TARGET_FRAC,
    describe: 'Sizes the per-unit budget b = (f·W − reserve) ÷ (A + 1); a raw unit over b is reduced to it.' },
  { key: 'reducer', env: 'CT_CT_REDUCER', stages: ['assemble'], kind: 'enum', values: ['chunk', 'summarize', 'none'], default: 'chunk',
    describe: 'How assembly shrinks a unit over the per-unit budget; none disables reduce-on-overflow.' },
  { key: 'gravityK', env: 'CT_CT_GRAVITY_K', stages: ['fold', 'evict'], kind: 'number', min: 0, exclusiveMin: true, default: 1,
    describe: 'κ, the scale of the pull g = κ·M·m/d² (m = a block\'s irrelevance × its raw tokens ÷ budget, M = the context\'s total, d = distance from the window as a fraction of the budget). Under gravityMode fixed only g/κ matters against the breakpoints, so κ and the breakpoints trade one for one; under adaptive it is where κ starts.' },
  { key: 'gravityMode', env: 'CT_CT_GRAVITY_MODE', stages: ['fold', 'evict'], kind: 'enum', values: ['fixed', 'adaptive'], default: 'fixed',
    describe: 'fixed: κ stays at gravityK. adaptive: κ falls when the model shows it lacks context (a recall call, the same call returning the same result again, a read of something folded away) or when folds churn, and rises on a turn that needed the fit guarantee.' },
  { key: 'gFold', env: 'CT_CT_G_FOLD', stages: ['fold'], kind: 'number', min: 0, default: Number.POSITIVE_INFINITY,
    describe: 'Breakpoint: a block folds once its pull reaches this. Infinity = nothing folds.' },
  { key: 'gUnfold', env: 'CT_CT_G_UNFOLD', stages: ['fold'], kind: 'number', min: 0, default: 0,
    describe: 'Breakpoint: a folded block comes back once its pull falls below this, and only if it would stay below it with its raw form back in. Below gFold, so a block does not flap.' },
  { key: 'gSummarize', env: 'CT_CT_G_SUMMARIZE', stages: ['fold'], kind: 'number', min: 0, default: Number.POSITIVE_INFINITY,
    describe: 'Breakpoint: a run of two or more consecutive folded blocks, each pulled this hard, is asked to be summarized. Infinity = no summaries.' },
  { key: 'gUnsummarize', env: 'CT_CT_G_UNSUMMARIZE', stages: ['fold'], kind: 'number', min: 0, default: 0,
    describe: 'Breakpoint: a summary is retired, and its blocks show as stubs again, once every block it covers is pulled less than this.' },
  { key: 'gDelete', env: 'CT_CT_G_DELETE', stages: ['evict'], kind: 'number', min: 0, default: Number.POSITIVE_INFINITY,
    describe: 'Breakpoint: a unit is deleted once its whole pull (irrelevance × raw tokens) reaches this. Infinity = deletion only by the fit guarantee, which keeps the prompt under the budget.' },
  { key: 'gravityEta', env: 'CT_CT_GRAVITY_ETA', stages: ['fold'], kind: 'number', min: 0, default: 0.25,
    describe: 'Adaptive κ: κ ← κ·exp(η·(overflow − starvation − thrash)), each signal counted once per turn.' },
  { key: 'gravityKMin', env: 'CT_CT_GRAVITY_K_MIN', stages: ['fold'], kind: 'number', min: 0, exclusiveMin: true, default: 0.1, describe: 'Adaptive κ: lower bound.' },
  { key: 'gravityKMax', env: 'CT_CT_GRAVITY_K_MAX', stages: ['fold'], kind: 'number', min: 0, exclusiveMin: true, default: 10, describe: 'Adaptive κ: upper bound.' },
  { key: 'repeatWindow', env: 'CT_CT_REPEAT_WINDOW', stages: ['fold'], kind: 'int', min: 1, default: 5,
    describe: 'Adaptive κ: turns within which the same tool call with the same result counts as the model repeating itself, and a fold then unfold as churn.' },
  { key: 'foldReasoning', env: 'CT_CT_FOLD_REASONING', stages: ['fold'], kind: 'enum', values: ['keep', 'tail', 'drop'], default: 'tail',
    describe: 'What a folded reasoning block shows: its last foldReasoningTail tokens under a tag, nothing, or all of it. One followed by the model\'s own text always folds to nothing — that text is its summary.' },
  { key: 'foldReasoningTail', env: 'CT_CT_FOLD_REASONING_TAIL', stages: ['fold'], kind: 'int', min: 0, default: 120,
    describe: 'Tokens of a reasoning block\'s end kept when it folds: the conclusion sits there.' },
  { key: 'summaryRatio', env: 'CT_CT_SUMMARY_RATIO', stages: ['summarize'], kind: 'number', min: 0, exclusiveMin: true, default: 0.1,
    describe: 'A summary counts only if its tokens are at most this fraction of the tokens it summarizes; otherwise the stubs stand.' },
  { key: 'summaryMaxTokens', env: 'CT_CT_SUMMARY_MAX_TOKENS', stages: ['summarize'], kind: 'int', min: 0, default: 0, describe: 'Output cap for one summary call; 0 = none. A thinking model spends a small cap on reasoning and answers nothing (the summary gate of 2026-09-22: 17 of 24 calls empty at 2048).' },
  { key: 'topK', env: 'CT_CT_TOPK', stages: ['fold', 'evict'], kind: 'int', min: 0, default: 5,
    describe: 'Retrieval hits ranked for the current query; they count only when wRelevance > 0.' },
  { key: 'wPriority', env: 'CT_CT_W_PRIORITY', stages: ['fold', 'evict'], kind: 'number', min: 0, default: W.priority, describe: 'Score weight: wrote a file / co-occurrence, decayed.' },
  { key: 'wRecency', env: 'CT_CT_W_RECENCY', stages: ['fold', 'evict'], kind: 'number', min: 0, default: W.recency, describe: 'Score weight: creation order.' },
  { key: 'wRefRecency', env: 'CT_CT_W_REFRECENCY', stages: ['fold', 'evict'], kind: 'number', min: 0, default: W.refRecency, describe: 'Score weight: how recently the agent came back to it.' },
  { key: 'wDormancy', env: 'CT_CT_W_DORMANCY', stages: ['fold', 'evict'], kind: 'number', min: 0, default: W.dormancy, describe: 'Score weight (subtracted): topic drift from the recent work.' },
  { key: 'wRelevance', env: 'CT_CT_W_RELEVANCE', stages: ['fold', 'evict'], kind: 'number', min: 0, default: 0,
    describe: 'Score weight: rank among the topK retrieval hits. 0 (the offline sweep\'s optimum) skips retrieval entirely.' },
  { key: 'priorityHalfLife', env: 'CT_CT_PRIORITY_HALFLIFE', stages: ['fold', 'evict'], kind: 'number', min: 0, exclusiveMin: true, default: DEFAULT_PRIORITY_HALFLIFE,
    describe: 'Half-life, in turns, of priority and of anchor protection.' },
  { key: 'boundary', env: 'CT_CT_BOUNDARY', stages: [], kind: 'enum', values: ['toolPhase', 'tiling', 'drift'], default: 'toolPhase',
    describe: 'Where the transcript is cut into segments: the tool-phase state machine, TextTiling between blocks, or causal lexical drift.' },
  { key: 'boundaryWindow', env: 'CT_CT_BOUNDARY_WINDOW', stages: [], kind: 'int', min: 1, default: 3, describe: 'Blocks per comparison window for tiling and drift.' },
  { key: 'boundaryThreshold', env: 'CT_CT_BOUNDARY_THRESHOLD', stages: [], kind: 'number', min: 0, default: 0.5,
    describe: 'tiling: cut below mean − t·sd of the gap similarities. drift: cut above a z-score of t.' },
  { key: 'boundaryTopK', env: 'CT_CT_BOUNDARY_TOPK', stages: [], kind: 'int', min: 0, default: 0, describe: 'Keep only the K strongest cuts; 0 keeps every cut over the threshold.' },
  { key: 'wCovariance', env: 'CT_CT_W_COVARIANCE', stages: ['fold', 'evict'], kind: 'number', min: 0, default: 0,
    describe: 'Score weight: historical co-activation of a block\'s identifiers with the hot window\'s. 0 (untested live, U3) skips it.' },
  { key: 'covarianceK', env: 'CT_CT_COVARIANCE_K', stages: ['fold', 'evict'], kind: 'int', min: 1, default: 5, describe: 'Covariance: blocks in the hot window.' },
  { key: 'covarianceM', env: 'CT_CT_COVARIANCE_M', stages: ['fold', 'evict'], kind: 'number', min: 0, default: 2, describe: 'Covariance: low-support shrinkage phi × a ÷ (a + m).' },
  { key: 'driftK', env: 'CT_CT_DRIFT_K', stages: [], kind: 'int', min: 1, default: DRIFT_K, describe: 'Drift classifier: size of the recent window, in units.' },
  { key: 'driftTau', env: 'CT_CT_DRIFT_TAU', stages: [], kind: 'number', min: 0, default: DRIFT_TAU, describe: 'Drift classifier: z-drift above which a unit is dormant.' },
  { key: 'rrfK', env: 'CT_CT_RRF_K', stages: [], kind: 'number', min: 0, exclusiveMin: true, default: DEFAULT_RRF_K, describe: 'Rank-fusion constant.' },
  { key: 'chunkSize', env: 'CT_CT_CHUNK_SIZE', stages: [], kind: 'int', min: 1, default: DEFAULT_CHUNK_SIZE,
    describe: 'Chunk size, in characters. A chunk is the one sub-unit: retrieval ranks it and reduction keeps it.' },
  { key: 'chunkOverlap', env: 'CT_CT_CHUNK_OVERLAP', stages: [], kind: 'int', min: 0, default: DEFAULT_CHUNK_OVERLAP, describe: 'Chunk overlap, in characters.' },
] as const satisfies readonly ParamSpec[];

type Spec = (typeof PIPELINE_PARAMS)[number];
type ValueOf<S> = S extends { kind: 'enum'; values: readonly (infer V)[] } ? V : S extends { kind: 'bool' } ? boolean : number;

export type PipelineParams = { readonly [S in Spec as S['key']]: ValueOf<S> };

/** The segmenter's cut rule, as `resolveConfig` takes it. */

export const boundaryOf = (p: Pick<PipelineParams, 'boundary' | 'boundaryWindow' | 'boundaryThreshold' | 'boundaryTopK'>): BoundaryConfig =>
  ({ strategy: p.boundary, window: p.boundaryWindow, threshold: p.boundaryThreshold, topK: p.boundaryTopK });

export const PIPELINE_DEFAULTS = Object.freeze(
  Object.fromEntries(PIPELINE_PARAMS.map((p) => [p.key, p.default])),
) as PipelineParams;

const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function problemWith(spec: ParamSpec, value: unknown): string | null {
  switch (spec.kind) {
    case 'bool':
      return typeof value === 'boolean' ? null : 'must be 0 or 1';
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? null : `must be ${spec.values.join('|')}`;
    case 'int':
    case 'number': {
      // A breakpoint may be Infinity (the rung never fires); nothing else may be.
      if (typeof value !== 'number' || Number.isNaN(value) || (!Number.isFinite(value) && !(value === Number.POSITIVE_INFINITY && spec.kind === 'number' && spec.max === undefined))) return 'must be a number';
      if (spec.kind === 'int' && !Number.isInteger(value)) return 'must be an integer';
      if (spec.exclusiveMin === true ? value <= spec.min : value < spec.min) return `must be ${spec.exclusiveMin === true ? '>' : '>='} ${String(spec.min)}`;
      if (spec.max !== undefined && value > spec.max) return `must be <= ${String(spec.max)}`;
      return null;
    }
  }
}

function fromText(spec: ParamSpec, raw: string): unknown {
  switch (spec.kind) {
    case 'bool': return raw === '1' ? true : raw === '0' ? false : raw;
    case 'enum': return raw;
    case 'int':
    case 'number': return Number(raw);
  }
}

/**
 * Server defaults from the environment. A value that does not parse is an ERROR, never a
 * silent fall-back: `CT_CT_ANCHOR=three` reading as the default would run an experiment
 * under a setting nobody asked for, with nothing logged.
 */
export function pipelineFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): PipelineParams {
  const out: Record<string, unknown> = { ...PIPELINE_DEFAULTS };
  const problems: string[] = [];
  for (const spec of PIPELINE_PARAMS) {
    const raw = env[spec.env];
    if (raw === undefined || raw === '') continue;
    const value = fromText(spec, raw);
    const problem = problemWith(spec, value);
    if (problem === null) out[spec.key] = value;
    else problems.push(`${spec.env} ${problem}, got "${raw}"`);
  }
  if (problems.length > 0) throw new RangeError(`pipeline misconfigured: ${problems.join('; ')}`);
  return out as unknown as PipelineParams;
}

function schemaOf(spec: ParamSpec): ZodType {
  switch (spec.kind) {
    case 'bool': return z.boolean();
    case 'enum': return z.enum(spec.values as [string, ...string[]]);
    case 'int':
    case 'number':
      return z.number().superRefine((value, ctx) => {
        const problem = problemWith(spec, value);
        if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
      });
  }
}

const readBy = (spec: ParamSpec, stage: Stage): boolean => spec.stages.includes(stage);

/** A stage's parameters, as optional tool arguments named in snake_case. */
export const stageArgsShape = (stage: Stage): ZodRawShape =>
  Object.fromEntries(
    PIPELINE_PARAMS.filter((p) => readBy(p, stage)).map((p) => [snake(p.key), schemaOf(p).optional().describe(`${p.describe} Default ${String(p.default)}.`)]),
  );

/** Server params with one call's overrides applied. `args` has already passed `stageArgsShape(stage)`. */
export function withOverrides(params: PipelineParams, stage: Stage, args: Readonly<Record<string, unknown>>): PipelineParams {
  const out: Record<string, unknown> = { ...params };
  for (const spec of PIPELINE_PARAMS) {
    const value = args[snake(spec.key)];
    if (readBy(spec, stage) && value !== undefined) out[spec.key] = value;
  }
  return out as unknown as PipelineParams;
}

/** The registry as data, for `GET /v1/params` and any harness that must not restate it. */
export function describeParams(current: PipelineParams = PIPELINE_DEFAULTS): readonly (ParamSpec & { argument: string | null; value: unknown })[] {
  return PIPELINE_PARAMS.map((p) => ({ ...p, argument: p.stages.length > 0 ? snake(p.key) : null, value: current[p.key] }));
}
