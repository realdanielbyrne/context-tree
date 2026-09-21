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
} from '@context-tree/core';

/**
 * Which stage reads the parameter — and therefore which tool takes it as an argument.
 * `[]` means fixed when the server starts, because it shapes the cached snapshot.
 */
export type Stage = 'assemble' | 'evict';

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
  { key: 'protection', env: 'CT_CT_PROTECTION', stages: ['evict'], kind: 'enum', values: ['soft', 'hard'], default: 'soft',
    describe: 'soft: the recency anchor is a score bonus that yields when the budget cannot otherwise be met. hard: anchored units are never touched.' },
  { key: 'anchor', env: 'CT_CT_ANCHOR', stages: ['assemble', 'evict'], kind: 'int', min: 0, default: DEFAULT_ANCHOR,
    describe: 'Recency anchor A: the last A units are protected, most strongly the newest.' },
  { key: 'protectionBonus', env: 'CT_CT_PROTECTION_BONUS', stages: ['evict'], kind: 'number', min: 0, default: W.priority,
    describe: 'Score added to the newest unit under soft protection, halving with distance. On the same scale as the weights, so an anchored unit can be outscored; a value above their sum makes the anchor yield only last.' },
  { key: 'summaries', env: 'CT_CT_SUMMARIES', stages: ['assemble'], kind: 'bool', default: false,
    describe: 'Assembly represents a closed phase outside the anchor by its summary, when it has one.' },
  { key: 'softTargetFrac', env: 'CT_CT_SOFT_TARGET_FRAC', stages: ['assemble'], kind: 'number', min: 0, max: 1, default: DEFAULT_SOFT_TARGET_FRAC,
    describe: 'Sizes the per-unit budget b = (f·W − reserve) ÷ (A + 1); a raw unit over b is reduced to it.' },
  { key: 'reducer', env: 'CT_CT_REDUCER', stages: ['assemble'], kind: 'enum', values: ['chunk', 'summarize', 'none'], default: 'chunk',
    describe: 'How assembly shrinks a unit over the per-unit budget; none disables reduce-on-overflow.' },
  { key: 'topK', env: 'CT_CT_TOPK', stages: ['evict'], kind: 'int', min: 0, default: 5,
    describe: 'Retrieval hits ranked for the current query; they count only when wRelevance > 0.' },
  { key: 'wPriority', env: 'CT_CT_W_PRIORITY', stages: ['evict'], kind: 'number', min: 0, default: W.priority, describe: 'Score weight: wrote a file / co-occurrence, decayed.' },
  { key: 'wRecency', env: 'CT_CT_W_RECENCY', stages: ['evict'], kind: 'number', min: 0, default: W.recency, describe: 'Score weight: creation order.' },
  { key: 'wRefRecency', env: 'CT_CT_W_REFRECENCY', stages: ['evict'], kind: 'number', min: 0, default: W.refRecency, describe: 'Score weight: how recently the agent came back to it.' },
  { key: 'wDormancy', env: 'CT_CT_W_DORMANCY', stages: ['evict'], kind: 'number', min: 0, default: W.dormancy, describe: 'Score weight (subtracted): topic drift from the recent work.' },
  { key: 'wRelevance', env: 'CT_CT_W_RELEVANCE', stages: ['evict'], kind: 'number', min: 0, default: 0,
    describe: 'Score weight: rank among the topK retrieval hits. 0 (the offline sweep\'s optimum) skips retrieval entirely.' },
  { key: 'priorityHalfLife', env: 'CT_CT_PRIORITY_HALFLIFE', stages: ['evict'], kind: 'number', min: 0, exclusiveMin: true, default: DEFAULT_PRIORITY_HALFLIFE,
    describe: 'Half-life, in turns, of priority and of anchor protection.' },
  { key: 'headroomTokens', env: 'CT_CT_EVICT_HEADROOM', stages: ['evict'], kind: 'int', min: 0, default: 0,
    describe: 'Extra tokens freed beyond the budget when a ruling fires, so it does not fire again next turn.' },
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
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
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
