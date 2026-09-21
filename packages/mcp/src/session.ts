/**
 * Per-task state the pipeline tools share, and the defaults they fall back to.
 *
 * The stages are tools (`tools/`), and tools are plain functions of a context,
 * so whatever must survive from one call to the next lives here: the turn
 * clock, the classifier's causal statistics, which units the agent came back
 * to, and — the one piece of real state — WHICH UNITS ARE EVICTED. Eviction is
 * sticky: a unit stays out until `context_restore` brings it back. A policy that
 * simply does not call `context_evict` this turn therefore leaves the prompt
 * exactly as it was, instead of re-admitting everything and rewriting the cached
 * prefix.
 */
import {
  DEFAULT_ANCHOR,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_EVICTION_WEIGHTS,
  DEFAULT_PRIORITY_HALFLIFE,
  DEFAULT_REDUCER,
  DEFAULT_RRF_K,
  DEFAULT_SOFT_TARGET_FRAC,
  DRIFT_K,
  DRIFT_TAU,
  DriftClassifier,
  HeuristicTokenizer,
  mapFlexUnits,
  readNodeText,
  type DriftResult,
  type EnsembleUnit,
  type EvictionWeights,
  type FlexUnit,
  type NodeId,
  type ReducerName,
  type Tokenizer,
  type TreeNode,
} from '@context-tree/core';
import type { ToolContext } from './types.js';

/**
 * Every value here is PROVISIONAL in core — hand-set or borrowed, not swept — which
 * is why each is a parameter: a default for the server, and an argument on the tool
 * that uses it.
 */
export interface PipelineDefaults {
  /** Recency anchor `A`: the last A units are never evictable. */
  anchor: number;
  weights: EvictionWeights;
  priorityHalfLife: number;
  /** Extra tokens freed beyond the limit when eviction fires. */
  evictHeadroomTokens: number;
  /** Sizes the reduce-on-overflow per-unit budget; no longer an eviction trigger. */
  softTargetFrac: number;
  reducer: ReducerName;
  driftK: number;
  driftTau: number;
  rrfK: number;
  chunkSize: number;
  chunkOverlap: number;
  /** Trailing host messages `context_verdicts` never drops. */
  protectTail: number;
}

export const PIPELINE_DEFAULTS: Readonly<PipelineDefaults> = Object.freeze({
  anchor: DEFAULT_ANCHOR,
  weights: DEFAULT_EVICTION_WEIGHTS,
  priorityHalfLife: DEFAULT_PRIORITY_HALFLIFE,
  evictHeadroomTokens: 0,
  softTargetFrac: DEFAULT_SOFT_TARGET_FRAC,
  reducer: DEFAULT_REDUCER,
  driftK: DRIFT_K,
  driftTau: DRIFT_TAU,
  rrfK: DEFAULT_RRF_K,
  chunkSize: DEFAULT_CHUNK_SIZE,
  chunkOverlap: DEFAULT_CHUNK_OVERLAP,
  protectTail: 6,
});

const ENV_NUMBERS: Readonly<Record<string, (d: PipelineDefaults, v: number) => void>> = Object.freeze({
  CT_CT_ANCHOR: (d, v) => { d.anchor = v; },
  CT_CT_PRIORITY_HALFLIFE: (d, v) => { d.priorityHalfLife = v; },
  CT_CT_EVICT_HEADROOM: (d, v) => { d.evictHeadroomTokens = v; },
  CT_CT_SOFT_TARGET_FRAC: (d, v) => { d.softTargetFrac = v; },
  CT_CT_DRIFT_K: (d, v) => { d.driftK = v; },
  CT_CT_DRIFT_TAU: (d, v) => { d.driftTau = v; },
  CT_CT_RRF_K: (d, v) => { d.rrfK = v; },
  CT_CT_CHUNK_SIZE: (d, v) => { d.chunkSize = v; },
  CT_CT_CHUNK_OVERLAP: (d, v) => { d.chunkOverlap = v; },
  CT_CT_PROTECT_TAIL: (d, v) => { d.protectTail = v; },
  CT_CT_W_PRIORITY: (d, v) => { d.weights = { ...d.weights, priority: v }; },
  CT_CT_W_RECENCY: (d, v) => { d.weights = { ...d.weights, recency: v }; },
  CT_CT_W_REFRECENCY: (d, v) => { d.weights = { ...d.weights, refRecency: v }; },
  CT_CT_W_DORMANCY: (d, v) => { d.weights = { ...d.weights, dormancy: v }; },
});

export const PIPELINE_ENV_KEYS: readonly string[] = Object.freeze([...Object.keys(ENV_NUMBERS), 'CT_CT_REDUCER']);

/**
 * Server defaults from the environment. A value that does not parse is an ERROR,
 * never a silent fall-back: `CT_CT_ANCHOR=three` reading as the default would run an
 * experiment under a setting nobody asked for, with nothing logged.
 */
export function pipelineFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): PipelineDefaults {
  const out: PipelineDefaults = { ...PIPELINE_DEFAULTS, weights: { ...PIPELINE_DEFAULTS.weights } };
  const problems: string[] = [];
  for (const [key, set] of Object.entries(ENV_NUMBERS)) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) problems.push(`${key} must be a non-negative number, got "${raw}"`);
    else set(out, value);
  }
  const reducer = env['CT_CT_REDUCER'];
  if (reducer !== undefined && reducer !== '') {
    if (reducer === 'chunk' || reducer === 'summarize') out.reducer = reducer;
    else problems.push(`CT_CT_REDUCER must be chunk|summarize, got "${reducer}"`);
  }
  if (!Number.isInteger(out.anchor)) problems.push(`CT_CT_ANCHOR must be an integer, got ${String(out.anchor)}`);
  if (!Number.isInteger(out.protectTail) || out.protectTail < 1) problems.push(`CT_CT_PROTECT_TAIL must be an integer >= 1, got ${String(out.protectTail)}`);
  if (out.softTargetFrac > 1) problems.push(`CT_CT_SOFT_TARGET_FRAC must be in [0, 1], got ${String(out.softTargetFrac)}`);
  if (out.priorityHalfLife <= 0) problems.push('CT_CT_PRIORITY_HALFLIFE must be > 0');
  if (problems.length > 0) throw new RangeError(`pipeline misconfigured: ${problems.join('; ')}`);
  return out;
}

/** One unit as the tools see it: the node, its text, and this turn's classification. */
export interface SessionUnit {
  node: TreeNode;
  unit: FlexUnit;
  drift: DriftResult;
  tokens: number;
}

interface Snapshot {
  lastSeq: number;
  units: SessionUnit[];
  corpus: EnsembleUnit[];
}

export interface Session {
  /** The host's turn clock. Tools that take a `turn` argument move it forward, never back. */
  turn: number;
  readonly classifier: DriftClassifier;
  readonly tokenizer: Tokenizer;
  readonly pipeline: PipelineDefaults;
  /** nodeId -> the turn the agent last came back to a file that unit wrote. */
  readonly referenced: Map<NodeId, number>;
  scannedSeq: number;
  readonly evicted: Set<NodeId>;
  /**
   * Host message id -> the L0 seq range it produced. Supplied by whatever feeds L0
   * from a live host; `null` means no adapter is attached and `context_verdicts` has
   * nothing to map.
   */
  messageIndex: ReadonlyMap<string, { start: number; end: number }> | null;
  snapshot: Snapshot | null;
}

export function createSession(pipeline: PipelineDefaults = PIPELINE_DEFAULTS): Session {
  return {
    turn: 0,
    classifier: new DriftClassifier(),
    tokenizer: new HeuristicTokenizer(),
    pipeline,
    referenced: new Map(),
    scannedSeq: 0,
    evicted: new Set(),
    messageIndex: null,
    snapshot: null,
  };
}

export function sessionOf(ctx: ToolContext): Session {
  ctx.session ??= createSession();
  return ctx.session;
}

export function advanceTurn(session: Session, turn: number | undefined): number {
  if (turn !== undefined && turn > session.turn) session.turn = turn;
  return session.turn;
}

/**
 * A unit that wrote a file is "referenced" again when a LATER tool call touches that
 * path. Incremental on purpose: re-scanning from seq 1 each turn would stamp the
 * current turn on every unit that ever touched a file — a "wrote a file" flag, not an
 * observation of the agent coming back to something.
 */
function trackReferences(ctx: ToolContext, session: Session): void {
  const { store, trace } = ctx.handle;
  const last = trace.lastSeq();
  if (last <= session.scannedSeq) return;
  const owner = new Map<string, NodeId>();
  for (const node of store.nodesInCreationOrder()) {
    const path = node.kind === 'file' ? (node.meta_json as { path?: string }).path : undefined;
    if (path !== undefined && node.parent_id !== null) owner.set(path, node.parent_id);
  }
  for (const event of trace.read({ from: session.scannedSeq + 1, to: last })) {
    if (event.type !== 'tool_call' || event.path === undefined) continue;
    const unit = owner.get(event.path);
    if (unit !== undefined) session.referenced.set(unit, session.turn);
  }
  session.scannedSeq = last;
}

/**
 * The units, classified ONCE per state of the trace. The classifier folds each
 * call's drifts into its running statistics, so re-classifying an unchanged trace —
 * an agent calling `context_classify` twice, or `context_units` then
 * `context_evict` — would count the same observation again and shift every later
 * z-score.
 */
export async function sessionUnits(ctx: ToolContext): Promise<{ units: SessionUnit[]; corpus: EnsembleUnit[] }> {
  const session = sessionOf(ctx);
  const { store, trace, blobs } = ctx.handle;
  const lastSeq = trace.lastSeq();
  if (session.snapshot?.lastSeq === lastSeq) return session.snapshot;

  trackReferences(ctx, session);
  const phases = store.nodesInCreationOrder().filter((n) => n.kind === 'phase' && n.status !== 'superseded');
  const entries = phases.map((node, order) => {
    const summary = store.currentSummary(node.id);
    const wrote =
      store.descendants(node.id).some((d) => d.kind === 'file') || (node.meta_json.spans?.length ?? 0) > 0;
    return {
      nodeId: node.id,
      order,
      rawText: readNodeText(node, trace, blobs),
      ...(summary !== null ? { summaryText: summary.text } : {}),
      wrote,
      // Never referenced -> 0, in the SAME clock as `turn`. Falling back to the unit's
      // creation index would mix a unit count into a turn count.
      lastReferencedTurn: session.referenced.get(node.id) ?? 0,
    };
  });
  const mapped = await mapFlexUnits(entries, {
    classifier: session.classifier,
    k: session.pipeline.driftK,
    tau: session.pipeline.driftTau,
  });
  const units = mapped.units.map((unit, i) => ({
    node: phases[i]!,
    unit,
    drift: mapped.drift[i]!,
    tokens: session.tokenizer.count(unit.raw),
  }));
  session.snapshot = { lastSeq, units, corpus: mapped.corpus };
  return session.snapshot;
}
