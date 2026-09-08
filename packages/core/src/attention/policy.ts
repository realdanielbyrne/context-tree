import type { AttentionSignal } from './signals.js';

/** All coordinates/evidence are derived from an L0 prefix by the caller. */
export interface AttentionUnit {
  id: string;
  seq: number;
  tokens: number;
  state: 'resident' | 'candidate';
  fingerprints: readonly string[];
  role?: 'task' | 'plan' | 'steering' | 'history';
  phaseId?: string;
  exchangeId?: string;
  /** Nonnegative score from the existing ranker; absent means unknown. */
  relevanceScore?: number;
  /** Exclusion requires current-turn evidence, not absence of lexical overlap. */
  relevance?: { value: 'relevant' | 'irrelevant'; turn: number; sourceSeq: number; reason: string };
}

export interface AttentionReference {
  unitId: string;
  seq: number;
  turn: number;
  kind: 'fetch' | 'reference' | 'edit' | 'supersede';
}

/** Absent switches are off. Fitted values require a calibration artifact ID;
 * this module contains no operating target, occupancy trigger, or fitted default. */
export interface AttentionPolicy {
  excludeIrrelevant?: boolean;
  pinPlan?: boolean;
  recency?: 'exchange' | 'subtask' | 'all';
  priority?: { boost: number; halfLifeTurns: number; calibrationId: string };
  breadth?: { relevanceMass: number; calibrationId: string };
  demandExpansion?: boolean;
  sufficiencyGate?: boolean;
  topicShiftReset?: boolean;
}

export interface AttentionInput {
  units: readonly AttentionUnit[];
  asOfSeq: number;
  turn: number;
  queryFingerprints: readonly string[];
  taskFingerprints?: readonly string[];
  planFingerprints?: readonly string[];
  activePhaseId?: string;
  currentExchangeId?: string;
  subtaskStartSeq?: number;
  references?: readonly AttentionReference[];
  /** Signals from the latest assistant message only. New user steering should
   * clear them. The caller provides text-derived observations, never approval. */
  signals?: readonly AttentionSignal[];
  demand?: { kind: 'explicit' | 'exploratory'; budgetTokens: number; expandedBudgetTokens?: number };
  policy?: AttentionPolicy;
}

export type AttentionDisposition = 'selected' | 'excluded_irrelevant' | 'deferred_no_demand'
  | 'deferred_sufficiency' | 'deferred_mass' | 'deferred_budget';

export interface AttentionAudit {
  id: string;
  seq: number;
  relevance: number;
  priority: number;
  category: 'pinned' | 'active' | 'dormant' | 'unrelated' | 'unknown';
  protected: boolean;
  recurrenceRestored: boolean;
  disposition: AttentionDisposition;
  evidenceSeq: number | null;
}

export interface AttentionResult {
  configuration: AttentionPolicy;
  /** Stable creation order, regardless of admission rank. */
  selectedIds: string[];
  audit: AttentionAudit[];
  mechanism: {
    excludedTokens: number;
    recurrenceRestorations: number;
    protectedUnits: number;
    priorityChangedOrder: boolean;
    massDeferredUnits: number;
    sufficiencyDeferredUnits: number;
    demandExtraTokens: number;
    topicShiftReset: boolean;
  };
}

const nonnegative = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
};

export function selectAttention(input: AttentionInput): AttentionResult {
  const policy = input.policy ?? {};
  if (policy.priority !== undefined) {
    nonnegative(policy.priority.boost, 'priority.boost');
    if (!Number.isFinite(policy.priority.halfLifeTurns) || policy.priority.halfLifeTurns <= 0 || !policy.priority.calibrationId.trim()) {
      throw new RangeError('priority requires a positive half-life and calibrationId');
    }
  }
  if (policy.breadth !== undefined && (!(policy.breadth.relevanceMass > 0 && policy.breadth.relevanceMass <= 1) || !policy.breadth.calibrationId.trim())) {
    throw new RangeError('breadth requires relevanceMass in (0, 1] and calibrationId');
  }
  if (input.demand !== undefined) {
    nonnegative(input.demand.budgetTokens, 'demand.budgetTokens');
    if (input.demand.expandedBudgetTokens !== undefined) nonnegative(input.demand.expandedBudgetTokens, 'demand.expandedBudgetTokens');
  }
  const ids = new Set<string>();
  for (const unit of input.units) {
    if (ids.has(unit.id)) throw new Error(`duplicate attention unit: ${unit.id}`);
    ids.add(unit.id);
    nonnegative(unit.tokens, 'unit.tokens');
    if (unit.relevanceScore !== undefined) nonnegative(unit.relevanceScore, 'unit.relevanceScore');
    if (unit.seq > input.asOfSeq || (unit.relevance?.sourceSeq ?? 0) > input.asOfSeq) throw new Error('attention units must belong to the supplied L0 prefix');
  }
  const fingerprints = new Set([...input.queryFingerprints, ...input.taskFingerprints ?? [], ...input.planFingerprints ?? []]);
  const references = (input.references ?? []).filter((r) => r.seq <= input.asOfSeq && r.turn <= input.turn);
  const signals = (input.signals ?? []).filter((s) => s.sourceSeq <= input.asOfSeq);
  const topicShift = policy.topicShiftReset === true && signals.some((s) => s.kind === 'topic_shift');
  const latestSignal = [...signals].sort((a, b) => b.sourceSeq - a.sourceSeq || b.start - a.start)[0];
  const sufficient = policy.sufficiencyGate === true && (latestSignal?.kind === 'sufficiency' || latestSignal?.kind === 'research_done');
  const rows = input.units.map((unit) => {
    const refs = references.filter((r) => r.unitId === unit.id);
    const matched = unit.fingerprints.some((f) => fingerprints.has(f));
    const evidence = unit.relevance?.turn === input.turn ? unit.relevance : undefined;
    const irrelevant = evidence?.value === 'irrelevant' && evidence.reason.trim().length > 0;
    const recent = policy.recency === 'all'
      || (policy.recency === 'exchange' && (input.currentExchangeId === undefined || unit.exchangeId === undefined || unit.exchangeId === input.currentExchangeId))
      || (policy.recency === 'subtask' && (input.subtaskStartSeq === undefined || unit.seq >= input.subtaskStartSeq));
    const protectedUnit = unit.role === 'task' || unit.role === 'steering' || (policy.pinPlan === true && unit.role === 'plan') || recent;
    const recurrenceRestored = irrelevant && matched;
    const exclude = policy.excludeIrrelevant === true && irrelevant && !matched && !protectedUnit;
    const active = input.activePhaseId !== undefined && unit.phaseId === input.activePhaseId;
    let priority = 0;
    if (policy.priority !== undefined && !topicShift && !refs.some((r) => r.kind === 'supersede')) {
      const { boost, halfLifeTurns } = policy.priority;
      priority = refs.reduce((sum, r) => sum + boost * 2 ** (-(input.turn - r.turn) / halfLifeTurns), 0);
    }
    const audit: AttentionAudit = {
      id: unit.id, seq: unit.seq, relevance: unit.relevanceScore ?? (matched ? 1 : 0), priority,
      category: protectedUnit ? 'pinned' : active ? 'active' : irrelevant && !matched ? 'unrelated' : refs.length > 0 ? 'dormant' : 'unknown',
      protected: protectedUnit, recurrenceRestored, evidenceSeq: evidence?.sourceSeq ?? null,
      disposition: exclude ? 'excluded_irrelevant' : unit.state === 'resident' ? 'selected' : 'deferred_no_demand',
    };
    return { unit, audit };
  });
  const candidates = rows.filter((row) => row.unit.state === 'candidate' && row.audit.disposition !== 'excluded_irrelevant');
  const mass = candidates.reduce((sum, row) => sum + row.audit.relevance, 0);
  if (mass > 0) for (const row of candidates) row.audit.relevance /= mass;
  const byRelevance = [...candidates].sort((a, b) => Number(b.audit.protected) - Number(a.audit.protected) || b.audit.relevance - a.audit.relevance || a.unit.seq - b.unit.seq || a.unit.id.localeCompare(b.unit.id));
  const ranked = [...candidates].sort((a, b) => Number(b.audit.protected) - Number(a.audit.protected) || (b.audit.relevance + b.audit.priority) - (a.audit.relevance + a.audit.priority) || a.unit.seq - b.unit.seq || a.unit.id.localeCompare(b.unit.id));
  const priorityChangedOrder = ranked.some((row, index) => row.unit.id !== byRelevance[index]?.unit.id);
  const baselineBudget = input.demand?.budgetTokens ?? 0;
  const budget = policy.demandExpansion === true && input.demand?.kind === 'explicit'
    ? Math.max(baselineBudget, input.demand.expandedBudgetTokens ?? baselineBudget) : baselineBudget;
  let admittedTokens = 0;
  let admittedMass = 0;
  for (const row of ranked) {
    if (input.demand === undefined) continue;
    if (sufficient && input.demand.kind === 'exploratory' && !row.audit.protected) {
      row.audit.disposition = 'deferred_sufficiency';
    } else if (policy.breadth !== undefined && mass > 0 && admittedMass >= policy.breadth.relevanceMass && !row.audit.protected) {
      row.audit.disposition = 'deferred_mass';
    } else if (admittedTokens + row.unit.tokens > budget) {
      row.audit.disposition = 'deferred_budget';
    } else {
      row.audit.disposition = 'selected';
      admittedTokens += row.unit.tokens;
      admittedMass += row.audit.relevance;
    }
  }
  const audit = rows.map((row) => row.audit).sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  return {
    configuration: { ...policy, ...(policy.priority === undefined ? {} : { priority: { ...policy.priority } }), ...(policy.breadth === undefined ? {} : { breadth: { ...policy.breadth } }) },
    selectedIds: audit.filter((row) => row.disposition === 'selected').map((row) => row.id), audit,
    mechanism: {
      excludedTokens: rows.filter((row) => row.audit.disposition === 'excluded_irrelevant').reduce((sum, row) => sum + row.unit.tokens, 0),
      recurrenceRestorations: audit.filter((row) => row.recurrenceRestored).length,
      protectedUnits: audit.filter((row) => row.protected).length,
      priorityChangedOrder,
      massDeferredUnits: audit.filter((row) => row.disposition === 'deferred_mass').length,
      sufficiencyDeferredUnits: audit.filter((row) => row.disposition === 'deferred_sufficiency').length,
      demandExtraTokens: Math.max(0, admittedTokens - baselineBudget), topicShiftReset: topicShift,
    },
  };
}
