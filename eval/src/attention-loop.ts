/** Opt-in experimental arm. Original producer responses remain in L0/L2;
 * policy-selected payloads are a separately recorded model-facing view. */
import {
  appendEvent, detectAttentionSignals, excerptAround, isRederivable, openTaskStore, selectAttention, selectPayload, TreeRetriever,
  type AttentionPolicy, type AttentionReference, type AttentionSignal, type AttentionUnit, type ChatMessage,
  type CompletionRequest, type CompletionResult, type ModelProvider, type PayloadMode,
  type TaskStore, type ToolCallRequest, type TraceEventInput,
} from '@context-tree/core';
import { HANDLERS, type ToolContext, type ToolName } from '@context-tree/mcp';
import { countTokens } from 'gpt-tokenizer';
import type { ArmArgs, ArmOutput } from './loop.js';
import { COMPLETION_NUDGE, completionGateOpen } from './loop.js';
import type { LangfuseRunHandle } from './langfuse.js';
import type { RunCapture } from './capture.js';
import type { TokenTotals, TurnRecord } from './types.js';
import { addTotals } from './metrics.js';
import { renderToolResult } from './transcript.js';
import { CONTEXT_TOOL_SCHEMAS, HARNESS_TOOL_SCHEMAS, executeHarnessTool, isContextTool, pathOf, type ToolCallOutcome } from './tools.js';

export interface AttentionProfile {
  version: 1;
  id: string;
  payload: { mode: PayloadMode; excerptChars: number; anchor: 'first' | 'rarest'; producers?: ('context' | 'read_file')[] };
  attention?: AttentionPolicy;
  ledger?: boolean;
}

const object = (input: unknown, where: string): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error(`${where} must be an object`);
  return input as Record<string, unknown>;
};
const keys = (input: Record<string, unknown>, allowed: string[], where: string): void => {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`${where}: unknown key ${key}`);
};

/** Validate before opening a store or spending live tokens. No implicit profile
 * or fitted parameter is installed by parsing. */
export function parseAttentionProfile(input: unknown): AttentionProfile {
  const profile = object(input, 'policyProfile');
  keys(profile, ['version', 'id', 'payload', 'attention', 'ledger'], 'policyProfile');
  if (profile.version !== 1 || typeof profile.id !== 'string' || !profile.id.trim()) throw new Error('policyProfile requires version 1 and a nonempty id');
  const payload = object(profile.payload, 'policyProfile.payload');
  keys(payload, ['mode', 'excerptChars', 'anchor', 'producers'], 'policyProfile.payload');
  if (typeof payload.mode !== 'string' || !['excerpt', 'whole', 'structural'].includes(payload.mode)) throw new Error('payload.mode must be excerpt, whole or structural');
  if (!Number.isSafeInteger(payload.excerptChars) || (payload.excerptChars as number) <= 0) throw new Error('payload.excerptChars must be a positive integer');
  if (payload.anchor !== 'first' && payload.anchor !== 'rarest') throw new Error('payload.anchor must be first or rarest');
  const producers = payload.producers === undefined ? ['context'] : payload.producers;
  if (!Array.isArray(producers) || producers.length === 0 || producers.some((producer) => producer !== 'context' && producer !== 'read_file') || new Set(producers).size !== producers.length) {
    throw new Error('payload.producers must be a nonempty unique array containing context and/or read_file');
  }
  if (profile.ledger !== undefined && typeof profile.ledger !== 'boolean') throw new Error('policyProfile.ledger must be boolean');
  let attention: AttentionPolicy | undefined;
  if (profile.attention !== undefined) {
    const policy = object(profile.attention, 'policyProfile.attention');
    const switches = ['excludeIrrelevant', 'pinPlan', 'demandExpansion', 'sufficiencyGate', 'topicShiftReset'];
    keys(policy, [...switches, 'recency', 'priority', 'breadth', 'evictRederivable'], 'policyProfile.attention');
    if (policy.evictRederivable !== undefined) {
      const evict = object(policy.evictRederivable, 'attention.evictRederivable');
      keys(evict, ['minCadenceTurns'], 'attention.evictRederivable');
      if (!Number.isSafeInteger(evict.minCadenceTurns) || (evict.minCadenceTurns as number) < 0) {
        throw new Error('attention.evictRederivable.minCadenceTurns must be a nonnegative integer');
      }
    }
    for (const name of switches) if (policy[name] !== undefined && typeof policy[name] !== 'boolean') throw new Error(`attention.${name} must be boolean`);
    if (policy.recency !== undefined && (typeof policy.recency !== 'string' || !['exchange', 'subtask', 'all'].includes(policy.recency))) throw new Error('attention.recency must be exchange, subtask or all');
    if (policy.priority !== undefined) {
      const priority = object(policy.priority, 'attention.priority');
      keys(priority, ['boost', 'halfLifeTurns', 'calibrationId'], 'attention.priority');
      if (typeof priority.boost !== 'number' || !Number.isFinite(priority.boost) || priority.boost < 0
        || typeof priority.halfLifeTurns !== 'number' || !Number.isFinite(priority.halfLifeTurns) || priority.halfLifeTurns <= 0
        || typeof priority.calibrationId !== 'string' || !priority.calibrationId.trim()) throw new Error('attention.priority requires nonnegative boost, positive halfLifeTurns and calibrationId');
    }
    if (policy.breadth !== undefined) {
      const breadth = object(policy.breadth, 'attention.breadth');
      keys(breadth, ['relevanceMass', 'calibrationId'], 'attention.breadth');
      if (typeof breadth.relevanceMass !== 'number' || !(breadth.relevanceMass > 0 && breadth.relevanceMass <= 1)
        || typeof breadth.calibrationId !== 'string' || !breadth.calibrationId.trim()) throw new Error('attention.breadth requires relevanceMass in (0, 1] and calibrationId');
    }
    attention = JSON.parse(JSON.stringify(policy)) as AttentionPolicy;
  }
  return {
    version: 1, id: profile.id,
    payload: { mode: payload.mode as PayloadMode, excerptChars: payload.excerptChars as number, anchor: payload.anchor, producers: [...producers] as ('context' | 'read_file')[] },
    ...(attention === undefined ? {} : { attention }),
    ...(profile.ledger === undefined ? {} : { ledger: profile.ledger as boolean }),
  };
}

export type AttentionModelCall = (args: {
  provider: ModelProvider; request: CompletionRequest; turnIndex: number;
  runHandle: LangfuseRunHandle; usage: TokenTotals; capture?: RunCapture; window?: number;
}) => Promise<{ result: CompletionResult; record: TurnRecord }>;

export interface AttentionRepeatGuard {
  (call: ToolCallRequest, execute: () => Promise<ToolCallOutcome>): Promise<ToolCallOutcome>;
  endTurn(): boolean;
}

interface TranscriptEntry {
  unit: AttentionUnit;
  message: ChatMessage;
  originalBlob: string;
  messageBlob: string;
  selectedPayloadBlob?: string;
  selectionId?: string;
}

const append = (handle: TaskStore, event: TraceEventInput) => appendEvent(handle, event).event;

export type AttentionDeclaration =
  | { kind: 'plan'; source_seq: number }
  | { kind: 'subtask'; id: string; state: 'begin' }
  | { kind: 'relevance'; unit_seqs: number[]; scope_seq: number; evidence_seqs: number[]; value: 'relevant' | 'irrelevant' };

/** Optional explicit convention inside existing annotation/user-message text.
 * Ordinary prose is not a declaration. Invalid claimed declarations fail closed. */
export function parseAttentionDeclaration(text: string): AttentionDeclaration | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null || !('attention_v1' in parsed)) return null;
  const declaration = object(parsed.attention_v1, 'attention_v1');
  const seq = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
  if (declaration.kind === 'plan') {
    keys(declaration, ['kind', 'source_seq'], 'plan declaration');
    if (!seq(declaration.source_seq)) throw new Error('plan source_seq must be an existing positive L0 sequence');
  } else if (declaration.kind === 'subtask') {
    keys(declaration, ['kind', 'id', 'state'], 'subtask declaration');
    if (typeof declaration.id !== 'string' || !declaration.id.trim() || declaration.state !== 'begin') throw new Error('subtask requires an explicit id and begin state');
  } else if (declaration.kind === 'relevance') {
    keys(declaration, ['kind', 'unit_seqs', 'scope_seq', 'evidence_seqs', 'value'], 'relevance declaration');
    if (!seq(declaration.scope_seq) || !Array.isArray(declaration.unit_seqs) || !declaration.unit_seqs.length || !declaration.unit_seqs.every(seq)
      || !Array.isArray(declaration.evidence_seqs) || !declaration.evidence_seqs.length || !declaration.evidence_seqs.every(seq)
      || typeof declaration.value !== 'string' || !['relevant', 'irrelevant'].includes(declaration.value)) throw new Error('relevance requires explicit unit/scope/evidence sequences and a value');
  } else throw new Error('unknown attention_v1 declaration kind');
  return declaration as unknown as AttentionDeclaration;
}

/** A rebuildable L0 projection. No model calls; no plan inferred from file names
 * or commands. Only an explicit user message may declare negative relevance. */
export function projectAttentionPrefix(handle: TaskStore, units: readonly AttentionUnit[], turn: number, asOfSeq = handle.trace.lastSeq(), deliveredPayloads: ReadonlyMap<number, string> = new Map()) {
  const events = [...handle.trace.read({ from: 1, to: asOfSeq })];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const readArgs = (ref?: string): Record<string, unknown> => {
    if (ref === undefined) return {};
    try { const value: unknown = JSON.parse(handle.blobs.getText(ref)); return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}; } catch { return {}; }
  };
  const eventText = (seq: number): string => {
    const event = bySeq.get(seq);
    if (event === undefined) return '';
    const ref = 'output_blob' in event ? event.output_blob : 'blob' in event ? event.blob : undefined;
    return ref === undefined ? '' : handle.blobs.getText(ref);
  };
  const sourcePath = (seq: number): string | undefined => {
    const event = bySeq.get(seq);
    const call = event?.type === 'tool_result' ? bySeq.get(event.call_seq) : event;
    return call?.type === 'tool_call' ? call.path ?? pathOf(readArgs(call.args_blob)) : undefined;
  };
  const declarations: { seq: number; type: string; declaration: AttentionDeclaration }[] = [];
  const rejected: { seq: number; reason: string }[] = [];
  for (const event of events) {
    if (event.type !== 'manual_annotation' && event.type !== 'user_message') continue;
    try {
      const declaration = parseAttentionDeclaration(handle.blobs.getText(event.blob));
      if (declaration === null) continue;
      if (declaration.kind === 'plan') {
        const source = bySeq.get(declaration.source_seq);
        if (declaration.source_seq >= event.seq || (source?.type !== 'assistant_message' && source?.type !== 'user_message')) throw new Error('plan must point to an earlier assistant/user source artifact');
      }
      if (declaration.kind === 'relevance') {
        if (declaration.value === 'irrelevant' && event.type !== 'user_message') throw new Error('negative relevance requires user_message provenance');
        if ([...declaration.unit_seqs, ...declaration.evidence_seqs, declaration.scope_seq].some((seq) => seq >= event.seq || !bySeq.has(seq))) throw new Error('relevance coordinates must refer to existing earlier L0');
      }
      declarations.push({ seq: event.seq, type: event.type, declaration });
    } catch (error) { rejected.push({ seq: event.seq, reason: String(error) }); }
  }
  const subtasks = declarations.filter((entry) => entry.declaration.kind === 'subtask');
  const activeSubtask = subtasks.at(-1);
  const plan = declarations.filter((entry) => entry.declaration.kind === 'plan').at(-1);
  const planSeq = plan?.declaration.kind === 'plan' ? plan.declaration.source_seq : undefined;
  const scopedRelevance = declarations.filter((entry) => entry.declaration.kind === 'relevance' && entry.declaration.scope_seq === activeSubtask?.seq);
  const references: AttentionReference[] = [];
  let sourceTurn = -1;
  let mappedFetches = 0;
  let mappedEdits = 0;
  let mappedSupersessions = 0;
  const spanUnits = (nodeId: unknown, before: number) => {
    if (typeof nodeId !== 'string') return [];
    const node = handle.store.getNode(nodeId);
    if (node?.span_start_seq == null) return [];
    const end = Math.min(before - 1, node.span_end_seq ?? before - 1, asOfSeq);
    return events.filter((event) => event.seq >= node.span_start_seq! && event.seq <= end);
  };
  for (const event of events) {
    if (event.type === 'assistant_message') sourceTurn++;
    if (event.type === 'tool_result' && event.error === undefined) {
      const call = bySeq.get(event.call_seq);
      if (call?.type !== 'tool_call') continue;
      const args = readArgs(call.args_blob);
      const path = sourcePath(event.seq);
      if (['write_file', 'edit_file'].includes(call.tool) && path !== undefined) {
        const matched = events.filter((prior) => prior.seq < call.seq && sourcePath(prior.seq) === path);
        for (const prior of matched) references.push({ unitId: `l0:${prior.seq}`, seq: event.seq, turn: Math.max(0, sourceTurn), kind: 'edit' });
        if (matched.length) mappedEdits++;
      }
      if ((call.tool === 'context_fetch' || call.tool === 'context_peek') && deliveredPayloads.has(event.seq)) {
        let data: Record<string, unknown> = {};
        try { data = object(JSON.parse(deliveredPayloads.get(event.seq)!), 'delivered fetch'); } catch { /* Partial/non-JSON payload cannot establish source exposure. */ }
        const text = typeof data.text === 'string' ? data.text : '';
        const matched = spanUnits(args.branch_id ?? args.node_id, call.seq).filter((prior) => {
          const raw = eventText(prior.seq);
          const inReturnedSpan = call.tool === 'context_peek' || (Array.isArray(data.spans) && data.spans.some((span: unknown) => {
            if (typeof span !== 'object' || span === null) return false;
            const bounds = span as Record<string, unknown>;
            return typeof bounds.start === 'number' && typeof bounds.end === 'number' && prior.seq >= bounds.start && prior.seq <= bounds.end;
          }));
          return inReturnedSpan && raw.length > 0 && text.includes(raw);
        });
        for (const prior of matched) references.push({ unitId: `l0:${prior.seq}`, seq: event.seq, turn: Math.max(0, sourceTurn), kind: 'fetch' });
        if (matched.length) mappedFetches++;
      }
    }
    if (event.type === 'manual_annotation' && event.link_kind === 'superseded_by') {
      const matched = spanUnits(event.node_id, event.seq);
      for (const prior of matched) references.push({ unitId: `l0:${prior.seq}`, seq: event.seq, turn: Math.max(0, sourceTurn), kind: 'supersede' });
      if (matched.length) mappedSupersessions++;
    }
  }
  /**
   * The tool that produced the content at this L0 seq, if any. A unit is a
   * message; the message may be a tool result, in which case its provenance is
   * the originating tool_call. Assistant and user messages have no tool.
   */
  const producingTool = (seq: number): string | undefined => {
    const event = bySeq.get(seq);
    if (event?.type === 'tool_result') return bySeq.get(event.call_seq)?.type === 'tool_call'
      ? (bySeq.get(event.call_seq) as { tool: string }).tool : undefined;
    return event?.type === 'tool_call' ? event.tool : undefined;
  };
  const projected = units.map((unit) => {
    const relevant = scopedRelevance.filter((entry) => entry.declaration.kind === 'relevance' && entry.declaration.unit_seqs.includes(unit.seq)).at(-1);
    const subtask = subtasks.filter((entry) => entry.seq <= unit.seq).at(-1);
    // Deterministic from L0, no labels: this is what makes the
    // dependency-tracking arm runnable where the relevance-label arms were not.
    const rederivable = isRederivable(producingTool(unit.seq));
    return {
      ...unit,
      ...(rederivable === undefined ? {} : { rederivable }),
      ...(unit.seq !== planSeq || unit.role === 'task' || unit.role === 'steering' ? {} : { role: 'plan' as const }),
      ...(subtask?.declaration.kind === 'subtask' ? { phaseId: subtask.declaration.id } : {}),
      ...(relevant?.declaration.kind === 'relevance' ? { relevance: { value: relevant.declaration.value, turn, sourceSeq: relevant.seq, reason: `explicit ${relevant.type} declaration at L0 ${relevant.seq}` } } : {}),
    };
  });
  return {
    units: projected, references, planSeq, subtaskStartSeq: activeSubtask?.seq,
    activePhaseId: activeSubtask?.declaration.kind === 'subtask' ? activeSubtask.declaration.id : undefined,
    evidence: { planArtifacts: planSeq === undefined ? 0 : 1, subtaskBoundaries: subtasks.length, scopedRelevanceDeclarations: scopedRelevance.length, mappedFetches, mappedEdits, mappedSupersessions, referenceEdges: references.length, rejectedDeclarations: rejected,
      rederivableUnits: projected.filter((unit) => unit.rederivable === true).length,
      transientUnits: projected.filter((unit) => unit.rederivable === false).length,
      unclassifiedUnits: projected.filter((unit) => unit.rederivable === undefined).length },
  };
}

/** Admit only scored, uniquely mapped L0 search hits. Unscored, duplicate,
 * external and unmapped hits remain unchanged; this never labels them irrelevant.
 * Relevance mass is measured over this producer's returned pool, not all L0. */
export function selectSearchAdmission(input: {
  handle: TaskStore; original: string; asOfSeq: number; turn: number; query: string;
  excerptChars: number; anchor: 'first' | 'rarest'; availableTokens: number;
  policy: AttentionPolicy; signals: readonly AttentionSignal[];
  deliveredPayloads?: ReadonlyMap<number, string>;
}) {
  const { handle, policy } = input;
  const enabled = policy.breadth !== undefined || policy.priority !== undefined || policy.demandExpansion !== undefined;
  let data: Record<string, unknown>;
  try { data = object(JSON.parse(input.original), 'search response'); } catch {
    return { text: input.original, attention: null, reason: 'unsupported_response', evidence: { scoredCandidates: 0, unknownCandidates: 0 } };
  }
  if (!enabled || !Array.isArray(data.hits)) return { text: input.original, attention: null, reason: enabled ? 'no_hits_array' : 'policy_disabled', evidence: { scoredCandidates: 0, unknownCandidates: Array.isArray(data.hits) ? data.hits.length : 0 } };
  const sourceSeqs = new Set([...handle.trace.read({ from: 1, to: input.asOfSeq })].map((event) => event.seq));
  const seqCounts = new Map<number, number>();
  for (const hit of data.hits) if (typeof hit === 'object' && hit !== null && Number.isSafeInteger(hit.seq)) seqCounts.set(hit.seq, (seqCounts.get(hit.seq) ?? 0) + 1);
  const known = new Map<number, AttentionUnit>();
  data.hits.forEach((hit: unknown, index: number) => {
    if (typeof hit !== 'object' || hit === null) return;
    const row = hit as Record<string, unknown>;
    if (typeof row.seq !== 'number' || !sourceSeqs.has(row.seq) || seqCounts.get(row.seq) !== 1 || typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score <= 0) return;
    known.set(index, { id: `l0:${row.seq}`, seq: row.seq, state: 'candidate', relevanceScore: row.score,
      tokens: countTokens(`,${JSON.stringify(hit)}`), fingerprints: typeof row.path === 'string' ? [row.path] : [] });
  });
  const unknownHits = data.hits.filter((_, index) => !known.has(index));
  const fixedTokens = countTokens(JSON.stringify({ ...data, hits: unknownHits }));
  const terms = input.query.split(/\s+/).filter(Boolean);
  const controlEnvelope = Math.min(input.availableTokens, countTokens(excerptAround(input.original, terms, input.excerptChars, input.anchor)));
  const demand = { kind: 'explicit' as const, budgetTokens: Math.max(0, controlEnvelope - fixedTokens), expandedBudgetTokens: Math.max(0, input.availableTokens - fixedTokens) };
  const projection = projectAttentionPrefix(handle, [...known.values()], input.turn, input.asOfSeq, input.deliveredPayloads);
  const attention = selectAttention({ units: projection.units, references: projection.references, asOfSeq: input.asOfSeq, turn: input.turn,
    queryFingerprints: terms, activePhaseId: projection.activePhaseId, subtaskStartSeq: projection.subtaskStartSeq,
    signals: input.signals, demand, policy });
  const selectedIds = new Set(attention.selectedIds);
  const hits = data.hits.filter((_, index) => !known.has(index) || selectedIds.has(known.get(index)!.id));
  return {
    text: known.size === 0 ? input.original : JSON.stringify({ ...data, hits }), attention,
    reason: known.size === 0 ? 'no_unique_scored_l0_hits' : 'scored_source_pool',
    evidence: { ...projection.evidence, scoredCandidates: known.size, unknownCandidates: unknownHits.length },
    envelope: { source: 'measured_configured_excerpt_and_actual_physical_headroom', controlEnvelope, fixedTokens, demand },
  };
}

/** Uses the native stopping contract and an injected common model/physical-window
 * guard. This arm introduces neither reply limits nor occupancy-based eviction. */
export async function runAttentionArm(args: ArmArgs, deps: {
  callModel: AttentionModelCall; guard: AttentionRepeatGuard; system: string;
}): Promise<ArmOutput> {
  const profile = parseAttentionProfile(args.options.policyProfile);
  const window = args.options.window;
  if (window === undefined || !Number.isSafeInteger(window) || window <= 0) throw new Error('attention arm requires the physical model window');
  const handle = openTaskStore(args.config);
  const entries: TranscriptEntry[] = [];
  const deliveredPayloads = new Map<number, string>();
  const ledger: { sourceSeq: number; tool: string; command?: string; path?: string; outcome: 'success' | 'error'; originalBlob: string }[] = [];
  let signals: AttentionSignal[] = [];
  let focusFingerprints: string[] = [];
  /** Cadence state lives here so selectAttention stays a pure function. */
  let lastEvictionTurn: number | undefined;
  let toolWorkDone = false;
  let completionConfirmed = false;
  const tools = [...HARNESS_TOOL_SCHEMAS, ...CONTEXT_TOOL_SCHEMAS];
  const nativeCache = process.env.EVAL_NATIVE_CACHE === '1';
  const ts = () => new Date().toISOString();
  const makeRequest = (messages: ChatMessage[]): CompletionRequest => ({
    model: args.options.model, system: deps.system, messages, tools,
    ...(args.options.temperature == null ? {} : { temperature: args.options.temperature }),
    ...(nativeCache ? { systemCacheBreakpoint: true } : {}),
  });
  const addMessage = (sourceSeq: number, message: ChatMessage, originalBlob: string, exchangeId: string, role?: AttentionUnit['role'], path?: string): TranscriptEntry => {
    args.capture.blob(handle.blobs.getText(originalBlob));
    const entry: TranscriptEntry = {
      unit: { id: `l0:${sourceSeq}`, seq: sourceSeq, tokens: countTokens(JSON.stringify(message)), state: 'resident', fingerprints: path === undefined ? [] : [path], exchangeId, role },
      message, originalBlob, messageBlob: args.capture.blob(JSON.stringify(message)),
    };
    entries.push(entry);
    return entry;
  };
  args.capture.record('attention_profile', { profile, tools: tools.map((tool) => tool.name), systemBlob: args.capture.blob(deps.system), physicalWindow: window });
  try {
    const taskBlob = handle.blobs.put(args.scenario.task);
    const taskEvent = append(handle, { type: 'user_message', ts: ts(), blob: taskBlob });
    addMessage(taskEvent.seq, { role: 'user', content: args.scenario.task }, taskBlob, 'task', 'task');
    for (let turnIndex = 0; turnIndex < args.options.maxTurns; turnIndex++) {
      if (Date.now() >= args.deadlineMs) return { status: 'time_cap', finalText: '' };
      const projection = projectAttentionPrefix(handle, entries.map((entry) => entry.unit), turnIndex, handle.trace.lastSeq(), deliveredPayloads);
      const attention = selectAttention({
        units: projection.units, references: projection.references, activePhaseId: projection.activePhaseId,
        subtaskStartSeq: projection.subtaskStartSeq, asOfSeq: handle.trace.lastSeq(), turn: turnIndex,
        queryFingerprints: focusFingerprints, signals, currentExchangeId: `turn:${turnIndex - 1}`,
        lastEvictionTurn, policy: profile.attention,
      });
      // Record the turn an eviction actually happened, not the turn it was
      // merely permitted: the cadence must count from real prefix damage.
      if (attention.mechanism.evictedRederivableUnits > 0) lastEvictionTurn = turnIndex;
      const selectedIds = new Set(attention.selectedIds);
      const selectedEntries = entries.filter((entry) => selectedIds.has(entry.unit.id));
      const messages = selectedEntries.map((entry) => ({ ...entry.message }));
      if (profile.ledger === true && ledger.length > 0) messages.push({ role: 'user', content: `[Recorded action outcomes; sourceSeq refers to L0]\n${JSON.stringify(ledger)}` });
      if (nativeCache && messages.length > 0) messages[messages.length - 1] = { ...messages.at(-1)!, cacheBreakpoint: true };
      const request = makeRequest(messages);
      const requestTokens = countTokens(JSON.stringify(request));
      args.capture.record('attention_turn', {
        turn: turnIndex, asOfSeq: handle.trace.lastSeq(), profileId: profile.id, attention,
        requestTokens, occupancy: requestTokens / window, ledgerEntries: profile.ledger === true ? ledger.length : 0,
        mechanismApplied: (profile.ledger === true && ledger.length > 0) || selectedEntries.length < entries.length,
        evidence: projection.evidence,
        mechanismEligibility: {
          h1: projection.evidence.scopedRelevanceDeclarations > 0,
          h3: projection.evidence.planArtifacts > 0,
          h6Subtask: projection.evidence.subtaskBoundaries > 0,
          priority: projection.evidence.referenceEdges > 0,
          h4Signals: signals.length,
          h2h5: 'evaluated on actual scored search responses; see attention_admission events',
        },
      });
      let response: Awaited<ReturnType<AttentionModelCall>>;
      try {
        response = await deps.callModel({ provider: args.provider, request, turnIndex, runHandle: args.runHandle, usage: args.usage, capture: args.capture, window });
      } catch (error) {
        args.capture.record('attention_send_failed', { turn: turnIndex, requestTokens, physicalWindow: window, error: String(error), deliveryAcknowledged: false });
        throw error;
      }
      const { result, record } = response;
      args.turns.push(record);
      Object.assign(args.usage, addTotals(args.usage, result.usage));
      args.capture.record('attention_delivery', { turn: turnIndex, entries: selectedEntries.map((entry) => ({ id: entry.unit.id, sourceSeq: entry.unit.seq, originalBlob: entry.originalBlob, messageBlob: entry.messageBlob, selectedPayloadBlob: entry.selectedPayloadBlob, selectionId: entry.selectionId })) });
      for (const entry of selectedEntries) deliveredPayloads.set(entry.unit.seq, handle.blobs.getText(entry.selectedPayloadBlob ?? entry.originalBlob));
      const assistantBlob = handle.blobs.put(result.text);
      const assistant = append(handle, { type: 'assistant_message', ts: ts(), blob: assistantBlob });
      addMessage(assistant.seq, { role: 'assistant', content: result.text }, assistantBlob, `turn:${turnIndex}`);
      signals = detectAttentionSignals(result.text, assistant.seq);
      focusFingerprints = result.toolCalls.flatMap((call) => [
        ...(pathOf(call.input) === undefined ? [] : [pathOf(call.input)!]),
        ...(typeof call.input.query === 'string' ? call.input.query.split(/\s+/).filter(Boolean) : []),
      ]);
      args.capture.record('attention_signals', { turn: turnIndex, sourceSeq: assistant.seq, sourceBlob: assistantBlob, signals, source: 'assistant_message' });
      if (result.toolCalls.length === 0) {
        // Same gate, same wording, same once-per-run semantics as every other
        // arm (loop.ts COMPLETION_NUDGE) so a bare reply is not an arm effect.
        if (completionGateOpen(toolWorkDone, completionConfirmed)) {
          completionConfirmed = true;
          const nudgeBlob = handle.blobs.put(COMPLETION_NUDGE);
          const nudgeEvent = append(handle, { type: 'user_message', ts: ts(), blob: nudgeBlob });
          addMessage(nudgeEvent.seq, { role: 'user', content: COMPLETION_NUDGE }, nudgeBlob, `turn:${turnIndex}`, 'steering');
          continue;
        }
        return { status: 'completed', finalText: result.text };
      }
      toolWorkDone = true;
      for (const call of result.toolCalls) {
        const contextTool = isContextTool(call.name);
        const payloadProducer = contextTool ? 'context' : call.name === 'read_file' ? 'read_file' : null;
        let producerTruncated = false;
        let executed = false;
        const outcome = await deps.guard(call, async () => {
          executed = true;
          if (!contextTool) return executeHarnessTool(args.sandbox, call.name, call.input);
          // Tool backend avoids a duplicate call/result pair; this loop owns
          // exact original event capture for every tool uniformly.
          const toolCtx: ToolContext = { config: args.config, handle, retriever: new TreeRetriever({ store: handle.store, trace: handle.trace, blobs: handle.blobs }), mode: 'tool-backend' };
          const raw = await HANDLERS[call.name as ToolName](toolCtx, call.input);
          producerTruncated = raw.ok && typeof raw.data === 'object' && raw.data !== null && (raw.data as Record<string, unknown>).truncated === true;
          return { output: raw.ok ? JSON.stringify(raw.data) : `error ${raw.error.code}: ${raw.error.message}`, isError: !raw.ok };
        });
        const originalBlob = handle.blobs.put(outcome.output);
        args.capture.blob(outcome.output);
        if (outcome.postContent !== undefined) args.capture.blob(outcome.postContent);
        const callEvent = append(handle, {
          type: 'tool_call', ts: ts(), tool: call.name, parent_seq: assistant.seq,
          args_blob: handle.blobs.put(JSON.stringify(call.input)), path: pathOf(call.input),
          blob: outcome.postContent === undefined ? undefined : handle.blobs.put(outcome.postContent),
        });
        const resultEvent = append(handle, {
          type: 'tool_result', ts: ts(), call_seq: callEvent.seq, output_blob: originalBlob,
          ...(outcome.isError ? { error: outcome.output } : {}),
          ...(producerTruncated ? { truncated: true } : {}),
        });
        let selectedOutput = outcome.output;
        let selectionId: string | undefined;
        if (executed && payloadProducer !== null && profile.payload.producers!.includes(payloadProducer)) {
          const baseMessages = entries.map((entry) => entry.message);
          if (profile.ledger === true && ledger.length > 0) baseMessages.push({ role: 'user', content: `[Recorded action outcomes; sourceSeq refers to L0]\n${JSON.stringify(ledger)}` });
          const withPayload = (text: string) => makeRequest([...baseMessages, { role: 'user', content: renderToolResult(call, { ...outcome, output: text }) }]);
          const baseTokens = countTokens(JSON.stringify(withPayload('')));
          const availableTokens = Math.max(0, window - baseTokens - 1);
          const admission = call.name === 'context_search' && !outcome.isError ? selectSearchAdmission({
            handle, original: outcome.output, asOfSeq: callEvent.seq - 1, turn: turnIndex,
            query: typeof call.input.query === 'string' ? call.input.query : '', excerptChars: profile.payload.excerptChars,
            anchor: profile.payload.anchor, availableTokens, policy: profile.attention ?? {}, signals, deliveredPayloads,
          }) : undefined;
          const payloadInput = admission?.text ?? outcome.output;
          const payloadInputBlob = handle.blobs.put(payloadInput);
          args.capture.blob(payloadInput);
          const selection = selectPayload({
            original: { text: payloadInput, blobId: payloadInputBlob, producerTruncated },
            mode: profile.payload.mode, availableTokens,
            tokenizer: { count: (text) => Math.max(0, countTokens(JSON.stringify(withPayload(text))) - baseTokens) },
            excerpt: { chars: profile.payload.excerptChars, terms: typeof call.input.query === 'string' ? call.input.query.split(/\s+/) : [], anchor: profile.payload.anchor },
          });
          // Unsupported structure or overflow is not an experimental success.
          // Deliver the unchanged control response; the common send guard may
          // reject it physically, and that failed send is retained explicitly.
          const fallback = selection.status !== 'ready';
          selectedOutput = fallback ? outcome.output : selection.text!;
          selectionId = selection.selectionId;
          const selectedPayloadBlob = handle.blobs.put(selectedOutput);
          args.capture.blob(selectedOutput);
          if (admission !== undefined) args.capture.record('attention_admission', {
            turn: turnIndex, callId: call.id, sourceSeq: resultEvent.seq, asOfSeq: callEvent.seq - 1,
            originalBlob, admissionBlob: payloadInputBlob, selectedPayloadBlob,
            ...admission, text: undefined, mechanismApplied: !fallback && payloadInput !== outcome.output,
            deliveryAcknowledged: false, pool: 'returned_context_search_hits',
          });
          args.capture.record('attention_payload', {
            turn: turnIndex, tool: call.name, callId: call.id, callSeq: callEvent.seq, sourceSeq: resultEvent.seq,
            originalBlob, payloadInputBlob, selectedPayloadBlob, originalChars: outcome.output.length, selectedChars: selectedOutput.length,
            selection, fallback: fallback ? 'unchanged_control' : null,
            mechanismApplied: !fallback && selectedOutput !== outcome.output,
            payloadMechanismApplied: !fallback && selectedOutput !== payloadInput,
            boundary: contextTool ? 'serialized_context_tool_producer_response' : 'read_file_producer_response',
            producer: payloadProducer, deliveryAcknowledged: false,
          });
        }
        const entry = addMessage(resultEvent.seq, { role: 'user', content: renderToolResult(call, { ...outcome, output: selectedOutput }) }, originalBlob, `turn:${turnIndex}`, 'history', pathOf(call.input));
        if (selectionId !== undefined) {
          entry.selectionId = selectionId;
          entry.selectedPayloadBlob = handle.blobs.put(selectedOutput);
        }
        args.capture.record('attention_tool', { turn: turnIndex, callId: call.id, name: call.name, inputBlob: args.capture.blob(JSON.stringify(call.input)), callSeq: callEvent.seq, resultSeq: resultEvent.seq, originalBlob, messageBlob: entry.messageBlob, isError: outcome.isError, executed });
        if (executed && ['run_command', 'write_file', 'edit_file'].includes(call.name)) ledger.push({
          sourceSeq: resultEvent.seq, tool: call.name, path: pathOf(call.input),
          ...(typeof call.input.command === 'string' ? { command: call.input.command } : {}),
          outcome: outcome.isError ? 'error' : 'success', originalBlob,
        });
      }
      if (deps.guard.endTurn()) return { status: 'stalled', finalText: '' };
    }
    return { status: 'turn_cap', finalText: '' };
  } finally {
    handle.close();
  }
}
