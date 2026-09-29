/**
 * Per-task state shared by every tool and both transports.
 *
 * The real state is three rulings, kept apart because three stages make them: the FOLDS
 * (what the segmenter folded — read from the L0 ledger, D26), the ASSEMBLY (how `assemble`
 * reduces a unit) and the EVICTED set (what `evict` removed, which overrules the rest). All
 * are sticky — a unit stays as ruled until `restore` — so a turn on which a policy makes no
 * ruling leaves the prompt exactly as it was, instead of re-admitting everything and
 * rewriting the cached prefix.
 *
 * Units are built ONCE per state of the trace. The drift classifier folds each call's
 * observations into its running statistics, so re-classifying an unchanged trace (an
 * agent calling `classify` twice, or `units` then `evict`) would count one observation
 * twice and shift every later z-score.
 */
import {
  DriftClassifier,
  HeuristicTokenizer,
  KEEP,
  blocksOf,
  deriveTurns,
  foldView,
  foldsFrom,
  hostContent,
  mapFlexUnits,
  parseSummaryBlob,
  renderEvent,
  splitText,
  stubOf,
  type Block,
  type BlockState,
  type Disposition,
  type Fold,
  type StubBlob,
  type DriftResult,
  type EnsembleUnit,
  type FlexUnit,
  type NodeId,
  type PhaseType,
  type Tokenizer,
  type TraceEvent,
  type TreeNode,
} from '@context-tree/core';
import { createGravityState, type GravityState } from './gravity.js';
import { PIPELINE_DEFAULTS, type PipelineParams } from './params.js';
import { summaryLine } from './tools/render-summary.js';
import type { ToolContext } from './types.js';

/** A unit as every stage sees it — the same object for classification, retention and retrieval. */
export interface SessionUnit {
  /** A turn id (`turn:<seq>`) or, in `unit: 'phase'` mode, the phase node's id. */
  readonly id: string;
  readonly phase: TreeNode;
  readonly startSeq: number;
  readonly endSeq: number;
  /** The host's id for the message this turn is, when the importer recorded it. */
  readonly hostId: string | null;
  /** Opens with the user speaking. The first such unit is the task statement. */
  readonly fromUser: boolean;
  readonly hasTools: boolean;
  readonly flex: FlexUnit;
  readonly drift: DriftResult;
  /** Sized by what the host sends (`hostContent`), raw, so it is the number a host plugin gets for the same message. */
  readonly tokens: number;
  /** What the host sends for it NOW, with its blocks folded as the ledger says. */
  readonly shownTokens: number;
  /** Its blocks, in order: the stub ids inside this unit. */
  readonly blocks: readonly Block[];
  /** `splitText(raw)` under the session's chunk options — the sub-unit retrieval ranks and reduction keeps. */
  readonly chunks: number;
}

export interface Snapshot {
  readonly lastSeq: number;
  readonly units: readonly SessionUnit[];
  readonly corpus: readonly EnsembleUnit[];
  readonly blocks: readonly Block[];
  readonly folds: readonly Fold[];
  /** stub id -> what the block shows. */
  readonly view: ReadonlyMap<number, BlockState>;
}

export interface Session {
  /** The host's turn clock. Tools that take a `turn` move it forward, never back. */
  turn: number;
  readonly params: PipelineParams;
  readonly tokenizer: Tokenizer;
  readonly classifier: DriftClassifier;
  /** `reduce` rulings from `assemble`; folds live in the ledger, not here. */
  readonly assembly: Map<string, Disposition>;
  readonly evicted: Set<string>;
  /** The last query `assemble` was given; ranks what a reduction keeps when decisions are rendered later. */
  query: string | undefined;
  /** unit id -> the turn the agent last touched a file that unit wrote. */
  readonly referenced: Map<string, number>;
  scannedSeq: number;
  snapshot: Snapshot | null;
  /** κ and what the model did turn to turn (D27). */
  readonly gravity: GravityState;
}

export function createSession(params: PipelineParams = PIPELINE_DEFAULTS): Session {
  return {
    turn: 0,
    params,
    tokenizer: new HeuristicTokenizer(),
    classifier: new DriftClassifier(),
    assembly: new Map(),
    evicted: new Set(),
    query: undefined,
    referenced: new Map(),
    scannedSeq: 0,
    snapshot: null,
    gravity: createGravityState(),
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

interface Span {
  readonly id: string;
  readonly phase: TreeNode;
  readonly startSeq: number;
  readonly endSeq: number;
  readonly hostId: string | null;
  readonly fromUser: boolean;
}

function phaseSpans(phases: readonly TreeNode[], events: readonly TraceEvent[], lastSeq: number): Span[] {
  return phases.flatMap((phase) => {
    if (phase.span_start_seq === null) return [];
    const startSeq = phase.span_start_seq;
    const endSeq = phase.status === 'open' ? lastSeq : (phase.span_end_seq ?? startSeq);
    return [{ id: phase.id, phase, startSeq, endSeq, hostId: null, fromUser: events[startSeq - 1]?.type === 'user_message' }];
  });
}

function turnSpans(phases: readonly TreeNode[], events: readonly TraceEvent[], lastSeq: number): Span[] {
  const owners = phaseSpans(phases, events, lastSeq);
  return deriveTurns(events).flatMap((turn) => {
    const owner = owners.find((p) => p.startSeq <= turn.startSeq && turn.startSeq <= p.endSeq);
    if (owner === undefined) return [];
    return [{ id: turn.id, phase: owner.phase, startSeq: turn.startSeq, endSeq: turn.endSeq, hostId: turn.hostId ?? null, fromUser: turn.fromUser }];
  });
}

/**
 * A unit that wrote a file is "referenced" again when a LATER call touches that path.
 * Incremental: re-scanning from seq 1 would stamp the current turn on every unit that
 * ever wrote a file, which is a flag, not an observation of the agent coming back.
 */
function trackReferences(session: Session, spans: readonly Span[], events: readonly TraceEvent[], fileTools: readonly string[]): void {
  const writer = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'tool_call' || event.path === undefined) continue;
    const span = spans.find((s) => s.startSeq <= event.seq && event.seq <= s.endSeq);
    if (span === undefined) continue;
    const previous = writer.get(event.path);
    if (event.seq > session.scannedSeq && previous !== undefined && previous !== span.id) session.referenced.set(previous, session.turn);
    if (fileTools.includes(event.tool)) writer.set(event.path, span.id);
  }
  session.scannedSeq = events.at(-1)?.seq ?? session.scannedSeq;
}

export async function sessionUnits(ctx: ToolContext): Promise<Snapshot> {
  const session = sessionOf(ctx);
  const { store, trace, blobs } = ctx.handle;
  const lastSeq = trace.lastSeq();
  if (session.snapshot?.lastSeq === lastSeq) return session.snapshot;

  const events = lastSeq >= 1 ? [...trace.read({ from: 1, to: lastSeq })] : [];
  const phases = store.nodesInCreationOrder().filter((n) => n.kind === 'phase' && n.status !== 'superseded');
  const spans = session.params.unit === 'turn' ? turnSpans(phases, events, lastSeq) : phaseSpans(phases, events, lastSeq);
  trackReferences(session, spans, events, ctx.config.fileTools);

  const entries = spans.map((span, order) => {
    const slice = events.slice(span.startSeq - 1, span.endSeq);
    return {
      nodeId: span.id as NodeId,
      order,
      rawText: slice.map((event) => renderEvent(event, blobs)).join('\n'),
      wrote: slice.some((e) => e.type === 'tool_call' && e.path !== undefined && ctx.config.fileTools.includes(e.tool)),
      // Never referenced -> 0, in the SAME clock as `turn`; a creation index here would mix units into turns.
      lastReferencedTurn: session.referenced.get(span.id) ?? 0,
    };
  });
  const mapped = await mapFlexUnits(entries, { classifier: session.classifier, k: session.params.driftK, tau: session.params.driftTau });
  const chunkOptions = { chunkSize: session.params.chunkSize, chunkOverlap: session.params.chunkOverlap };

  const blocks = blocksOf(events, blobs, session.tokenizer);
  const folds = foldsFrom(events);
  const view = foldView(blocks, folds, {
    stub: (fold) => JSON.parse(blobs.getText(fold.blob)) as StubBlob,
    summary: (fold) => {
      const text = summaryLine(fold, parseSummaryBlob(blobs.getText(fold.blob)));
      return { text, tokens: session.tokenizer.count(text) };
    },
  });
  const units = spans.map((span, i): SessionUnit => {
    const flex = mapped.units[i]!;
    const slice = events.slice(span.startSeq - 1, span.endSeq);
    const hasTools = slice.some((e) => e.type === 'tool_call');
    const tokens = slice.flatMap((e) => hostContent(e, blobs)).reduce((n, text) => n + session.tokenizer.count(text), 0);
    const own = blocks.filter((b) => span.startSeq <= b.fromSeq && b.toSeq <= span.endSeq);
    const shownTokens = own.reduce((n, b) => n + (view.get(b.stub)?.tokens ?? b.tokens), 0);
    return { ...span, hasTools, flex, drift: mapped.drift[i]!, tokens, shownTokens, blocks: own, chunks: splitText(flex.raw, chunkOptions).length };
  });
  session.snapshot = { lastSeq, units, corpus: mapped.corpus, blocks, folds, view };
  return session.snapshot;
}

const residues = new WeakMap<Session, Map<string, number | null>>();

/** The residue of a block if it were stubbed now, or null when it already is folded or could not shrink. A block's stub is a pure function of its span, so it is computed once. */
export function residueOf(ctx: ToolContext, snapshot: Snapshot, block: Block): number | null {
  const session = sessionOf(ctx);
  const state = snapshot.view.get(block.stub);
  if (state === undefined || state.kind !== 'raw') return null;
  const params = { foldReasoning: session.params.foldReasoning, foldReasoningTail: session.params.foldReasoningTail };
  const key = `${String(block.fromSeq)}:${String(block.toSeq)}:${String(block.followedByText)}:${params.foldReasoning}:${String(params.foldReasoningTail)}`;
  let cache = residues.get(session);
  if (cache === undefined) residues.set(session, (cache = new Map()));
  if (cache.has(key)) return cache.get(key)!;
  const stub = stubOf(block, ctx.handle.trace.all(), ctx.handle.blobs, session.tokenizer, params);
  const residue = stub.parts.length === 0 ? null : stub.tokens;
  cache.set(key, residue);
  return residue;
}

const EVICTED: Disposition = Object.freeze({ kind: 'drop', why: 'evicted' });

/**
 * A unit's ruling outside the ledger: gone, or reduced by assembly, or kept. Folds are read
 * from the view per block, not from here.
 */
export function dispositionOf(session: Session, unit: Pick<SessionUnit, 'id'>): Disposition {
  if (session.evicted.has(unit.id)) return EVICTED;
  return session.assembly.get(unit.id) ?? KEEP;
}

/** Tokens the host sends for a unit under every ruling: 0 when evicted, else its folded size, or assembly's reduction if smaller. */
export function unitShownTokens(session: Session, unit: SessionUnit): number {
  const ruling = dispositionOf(session, unit);
  if (ruling.kind === 'drop') return 0;
  if (ruling.kind === 'reduce') return Math.min(ruling.tokens, unit.shownTokens);
  return unit.shownTokens;
}

export interface UnitView {
  id: string;
  phase_id: NodeId;
  phase_type: PhaseType | null;
  from_seq: number;
  to_seq: number;
}

/** How a tool names a unit to a caller: enough to `fetch` it (`branch_id` + `from`/`to`) or `restore` it (`id`). */
export const viewOf = (unit: SessionUnit): UnitView => ({
  id: unit.id,
  phase_id: unit.phase.id,
  phase_type: unit.phase.phase_type,
  from_seq: unit.startSeq,
  to_seq: unit.endSeq,
});
