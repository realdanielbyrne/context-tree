/**
 * What `fold` and `evict` both need to compute the pull (D27): each live unit's
 * irrelevance, the context's mass, κ — and, for adaptive κ, what the model did since the
 * last turn. Both tools read the SAME irrelevance, so a block is never relevant to one stage
 * and not to the other.
 */
import { adaptKappa, covarianceScores, ensembleRetrieve, irrelevanceOf, scoreUnits, unitSignals, type KappaSignals, type TraceEvent } from '@context-tree/core';
import type { PipelineParams } from './params.js';
import type { Session, SessionUnit } from './session.js';

export interface GravityState {
  /** Adaptive κ; null until the first adaptive turn. */
  kappa: number | null;
  adaptedTurn: number;
  scannedSeq: number;
  /** tool call key -> the last turn it was made on. */
  readonly calls: Map<string, number>;
  readonly foldedAt: Map<number, number>;
  readonly unfoldedAt: Map<number, number>;
  /** Churn this stage caused, counted into the next turn's κ. */
  thrash: number;
  /** The last evict needed the fit guarantee. */
  overflow: boolean;
  lastSignals: KappaSignals & { recall: number; repeat: number; foldedRead: number };
}

export const createGravityState = (): GravityState => ({
  kappa: null, adaptedTurn: 0, scannedSeq: 0, calls: new Map(), foldedAt: new Map(), unfoldedAt: new Map(), thrash: 0, overflow: false,
  lastSignals: { starvation: 0, thrash: 0, overflow: 0, recall: 0, repeat: 0, foldedRead: 0 },
});

/** 1 for the newest live unit, halving every `halfLife` units back, 0 outside the anchor. */
export const protectionAt = (fromNewest: number, params: PipelineParams): number =>
  fromNewest < params.anchor ? Math.pow(0.5, fromNewest / params.priorityHalfLife) : 0;

export async function relevanceRanks(session: Session, live: readonly SessionUnit[], params: PipelineParams, query: string | undefined): Promise<ReadonlyMap<string, number>> {
  if (params.wRelevance === 0 || params.topK === 0 || query === undefined || query.trim() === '') return new Map();
  const hits = await ensembleRetrieve(query, live.map((u) => ({ id: u.id, text: u.flex.raw })), undefined, {
    topK: params.topK,
    rrfK: session.params.rrfK,
    chunk: { chunkSize: session.params.chunkSize, chunkOverlap: session.params.chunkOverlap },
  });
  return new Map(hits.map((hit, rank) => [hit.unitId, 1 - rank / params.topK]));
}

/** unit id -> irrelevance e ∈ [0,1]: 1 − the retention score (weights, relevance, protection bonus), min-max over the live units. */
export async function irrelevance(session: Session, live: readonly SessionUnit[], pinned: ReadonlySet<string>, params: PipelineParams, turn: number): Promise<Map<string, number>> {
  const signals = unitSignals(live.map((u) => u.flex), turn, params.priorityHalfLife);
  if (params.wCovariance > 0) {
    covarianceScores(live.map((u) => u.flex.fingerprints), { k: params.covarianceK, m: params.covarianceM }).forEach((c, i) => { signals[i] = { ...signals[i]!, covariance: c }; });
  }
  const relevance = await relevanceRanks(session, live, params, session.query);
  const base = scoreUnits(signals, { priority: params.wPriority, recency: params.wRecency, refRecency: params.wRefRecency, dormancy: params.wDormancy, covariance: params.wCovariance });
  const protection = live.map((_, i) => protectionAt(live.length - 1 - i, params));
  const scores = live.map((u, i) => base[i]! + params.wRelevance * (relevance.get(u.id) ?? 0) + (params.protection === 'soft' ? params.protectionBonus * protection[i]! : 0));
  const walled = live.map((u, i) => pinned.has(u.id) || (params.protection === 'hard' && protection[i]! > 0));
  const e = irrelevanceOf(scores, walled);
  return new Map(live.map((u, i) => [u.id, e[i]!]));
}

/** Σ e·raw ÷ B over the live units: the context's irrelevance mass, the same for every stage this turn. */
export const contextMass = (live: readonly SessionUnit[], e: ReadonlyMap<string, number>, budget: number): number =>
  live.reduce((n, u) => n + ((e.get(u.id) ?? 0) * u.blocks.reduce((t, b) => t + b.tokens, 0)) / budget, 0);

const RECALL = /(^|[_\-.])(fetch|search|peek)$/;

/**
 * What the model did since the last scan, as the three κ signals. Starvation: a recall call,
 * the same call again within `repeatWindow` turns, or a file call on a path whose earlier
 * call is folded away. Read from L0; no model call.
 */
export function observe(state: GravityState, events: readonly TraceEvent[], foldedPaths: ReadonlySet<string>, turn: number, params: PipelineParams): GravityState['lastSignals'] {
  let recall = 0;
  let repeat = 0;
  let foldedRead = 0;
  for (const event of events) {
    if (event.seq <= state.scannedSeq || event.type !== 'tool_call') continue;
    if (RECALL.test(event.tool)) recall += 1;
    const key = [event.tool, event.args_blob ?? '', event.command ?? '', event.path ?? ''].join('\u0000');
    const last = state.calls.get(key);
    if (last !== undefined && turn - last <= params.repeatWindow) repeat += 1;
    state.calls.set(key, turn);
    if (event.path !== undefined && foldedPaths.has(event.path)) foldedRead += 1;
  }
  state.scannedSeq = events.at(-1)?.seq ?? state.scannedSeq;
  const signals = { recall, repeat, foldedRead, starvation: recall + repeat + foldedRead, thrash: state.thrash, overflow: state.overflow ? 1 : 0 };
  state.thrash = 0;
  state.overflow = false;
  return signals;
}

/** κ for this turn: the row under `fixed`; moved once per turn under `adaptive`. */
export function kappaFor(state: GravityState, params: PipelineParams, turn: number, observed: () => GravityState['lastSignals']): number {
  if (params.gravityMode === 'fixed') return params.gravityK;
  let kappa = state.kappa ?? params.gravityK;
  if (turn > state.adaptedTurn) {
    state.lastSignals = observed();
    kappa = adaptKappa(kappa, state.lastSignals, { eta: params.gravityEta, min: params.gravityKMin, max: params.gravityKMax });
    state.adaptedTurn = turn;
  }
  state.kappa = kappa;
  return kappa;
}
