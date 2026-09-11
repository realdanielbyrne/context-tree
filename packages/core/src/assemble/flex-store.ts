/**
 * Flex store-adapter — the convergence point (spec stages 1–3 wiring).
 *
 * Turns L1/L0 store state into the two things the settled subsystems consume:
 *   - `FlexUnit[]` + `FlexHead` for `assembleFlex` (stage 2), and
 *   - `EnsembleUnit[]` corpus for `ensembleRetrieve` (stage 3),
 * running the drift classifier (stage 1) to attach dormancy. The classifier
 * degrades to lexical-only drift when no embedder is supplied, so this runs
 * offline. `reports/session-handoff.md`.
 *
 * `mapFlexUnits` is the pure mapping (fingerprints, dormancy, priority signals);
 * `buildFlexSource` is the thin glue that reads the store and reuses the exact
 * L0-span read `ZoneAssembler` used (so a unit's raw text is identical).
 */
import type { BlobStore, NodeId, TraceLog, TreeNode, TreeStore } from '../contracts/index.js';
import { renderEvent, renderSummaryBlock } from './format.js';
import { extractFingerprints } from '../retrieve/lexical.js';
import { embedInBatches } from '../models/embeddings.js';
import type { SummaryEmbedder } from '../retrieve/types.js';
import type { EnsembleUnit } from '../retrieve/ensemble.js';
import { DriftClassifier, type ClassifyUnit } from '../classify/index.js';
import type { FlexHead, FlexUnit } from './flex.js';

/** One unit's already-extracted text, before signal computation. */
export interface FlexEntry {
  nodeId: NodeId;
  /** Creation-order index; higher = newer. Entries are supplied in ascending order. */
  order: number;
  rawText: string;
  summaryText?: string;
  /** The phase wrote a file or was fetched → priority boost. */
  wrote: boolean;
  /** Turn of last reference (for reference-recency + priority decay). Defaults to `order`. */
  lastReferencedTurn?: number;
}

export interface MapFlexOptions {
  /** When supplied, the classifier uses semantic + lexical drift; omit → lexical-only. */
  embed?: SummaryEmbedder;
  /** Reuse a session-scoped classifier to keep causal z-stats across turns. */
  classifier?: DriftClassifier;
  /** Drift recent-window size (units). Defaults to the classifier's `DRIFT_K`. */
  k?: number;
}

/**
 * Map extracted entries → `FlexUnit`s (with dormancy) + the retrieval corpus. Pure
 * aside from the optional embedder call. Fingerprints come from the unit's raw text
 * plus its summary; dormancy from the drift classifier over those fingerprints (and
 * embeddings, if `embed` is given).
 */
export async function mapFlexUnits(
  entries: readonly FlexEntry[],
  options: MapFlexOptions = {},
): Promise<{ units: FlexUnit[]; corpus: EnsembleUnit[] }> {
  const fingerprints = entries.map((e) =>
    extractFingerprints(`${e.rawText}\n${e.summaryText ?? ''}`),
  );

  const classifyUnits: ClassifyUnit[] = entries.map((_, i) => ({ fingerprints: fingerprints[i]! }));
  if (options.embed !== undefined && entries.length > 0) {
    // Validated + bounded-batched: a malformed embedder throws rather than silently
    // leaving some units without a vector (which would degrade the whole batch to
    // lexical-only). Absent embedder is the intentional lexical-only path.
    const vectors = await embedInBatches(options.embed, entries.map((e) => e.summaryText ?? e.rawText));
    entries.forEach((_, i) => {
      classifyUnits[i]!.embedding = vectors[i];
    });
  }
  const classifier = options.classifier ?? new DriftClassifier();
  const drift = classifier.classify(classifyUnits, options.k);

  const units: FlexUnit[] = entries.map((e, i) => ({
    nodeId: e.nodeId,
    order: e.order,
    fingerprints: fingerprints[i]!,
    wrote: e.wrote,
    lastReferencedTurn: e.lastReferencedTurn ?? e.order,
    dormancy: drift[i]!.dormancy,
    raw: e.rawText,
    ...(e.summaryText !== undefined ? { summary: e.summaryText } : {}),
  }));
  const corpus: EnsembleUnit[] = entries.map((e) => ({ id: e.nodeId, text: e.rawText }));
  return { units, corpus };
}

export interface FlexSourceDeps {
  store: TreeStore;
  trace: TraceLog;
  blobs: BlobStore;
}

export interface FlexSourceOptions extends MapFlexOptions {
  /** Frozen-head system contract (byte-stable across turns). */
  system: string;
  steering?: string;
}

export interface FlexSource {
  head: FlexHead;
  units: FlexUnit[];
  corpus: EnsembleUnit[];
}

/** Read a node's raw text out of L0 — the same span read `ZoneAssembler` used. */
export function readNodeText(node: TreeNode, trace: TraceLog, blobs: BlobStore): string {
  if (node.span_start_seq === null) return '';
  const from = node.span_start_seq;
  const recorded = node.span_end_seq ?? from;
  const to = node.status === 'open' ? Math.max(recorded, trace.lastSeq()) : recorded;
  const parts: string[] = [];
  for (const event of trace.read({ from, to })) parts.push(renderEvent(event, blobs));
  return parts.join('\n');
}

/**
 * Build the flex source from the store: the frozen head (system + steering + ALL
 * user prompts, append-only, in L0 order) and the phase-node units in creation order.
 */
export async function buildFlexSource(
  deps: FlexSourceDeps,
  options: FlexSourceOptions,
): Promise<FlexSource> {
  const { store, trace, blobs } = deps;

  const userPrompts: string[] = [];
  const lastSeq = trace.lastSeq();
  if (lastSeq >= 1) {
    for (const event of trace.read({ from: 1, to: lastSeq })) {
      if (event.type === 'user_message') userPrompts.push(renderEvent(event, blobs));
    }
  }
  const head: FlexHead = {
    system: options.system,
    ...(options.steering !== undefined ? { steering: options.steering } : {}),
    userPrompts,
  };

  const phases = store
    .nodesInCreationOrder()
    .filter((n) => n.kind === 'phase' && n.status !== 'superseded');
  const entries: FlexEntry[] = phases.map((node, order) => {
    const summary = store.currentSummary(node.id);
    const wrote =
      store.descendants(node.id).some((d) => d.kind === 'file') ||
      (node.meta_json.spans?.length ?? 0) > 0;
    return {
      nodeId: node.id,
      order,
      rawText: readNodeText(node, trace, blobs),
      // Render the summary WITH its rehydration pointers (files+spans, symbols,
      // tests, PR/ticket) — the spec's "summary must carry rehydration pointers".
      ...(summary !== null ? { summaryText: renderSummaryBlock(node, summary, node.kind === 'task') } : {}),
      wrote,
      lastReferencedTurn: order,
    };
  });

  const { units, corpus } = await mapFlexUnits(entries, options);
  return { head, units, corpus };
}
