/**
 * §7 unstructured-trace fallback: lexical TextTiling over message text.
 *
 * Runs only when a trace carries zero `tool_call` events, which §7 says agent
 * traces almost never do. Ruling C7: the similarity measure is **lexical**
 * (bag-of-words cosine between adjacent sliding windows), not embedding-based —
 * §7.1/D15 makes the ingestion path hermetic, and embeddings mean a network
 * call. Boundaries are therefore reproducible from L0 alone (D8).
 *
 * Every phase it emits is typed `other`: with no tool names there is no signal
 * for a phase type, and inventing one would be a guess the tree can't audit.
 */
import type {
  NodeKey,
  PhaseType,
  Segmentation,
  TraceEvent,
  TreeOp,
} from '../contracts/index.js';
import { TASK_KEY, phaseKey, phaseTitle } from './keys.js';

/** Messages per comparison window. Small: traces are short when they hit this path. */
const WINDOW = 3;

const FALLBACK_PHASE: PhaseType = 'other';

/** What the fallback needs from `SegmentConfig` plus the caller-owned text resolver. */
export interface TextFallbackOptions {
  taskTitle: string;
  /** L0 holds blob refs, not text, so the caller resolves L2 — that keeps `segment()` pure. */
  textOf?: (event: TraceEvent) => string;
}

export function segmentByText(
  events: readonly TraceEvent[],
  options: TextFallbackOptions,
): Segmentation {
  const first = events[0];
  if (first === undefined) throw new Error('segmentByText: empty event list');

  const starts = options.textOf ? changepoints(events, options.textOf) : new Set<number>();

  const ops: TreeOp[] = [{
    op: 'open',
    key: TASK_KEY,
    parent: null,
    kind: 'task',
    title: options.taskTitle,
    phase_type: null,
    start_seq: first.seq,
  }];
  const nodeOrder: NodeKey[] = [TASK_KEY];

  let phases = 0;
  let openKey: NodeKey | null = null;
  let prevSeq = first.seq;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (i > 0) ops.push({ op: 'extend', key: TASK_KEY, seq: event.seq });

    if (i === 0 || starts.has(i)) {
      if (openKey !== null) ops.push({ op: 'close', key: openKey, end_seq: prevSeq });
      const key = phaseKey(phases);
      phases += 1;
      ops.push({
        op: 'open',
        key,
        parent: TASK_KEY,
        kind: 'phase',
        title: phaseTitle(FALLBACK_PHASE, phases),
        phase_type: FALLBACK_PHASE,
        start_seq: event.seq,
      });
      nodeOrder.push(key);
      openKey = key;
    } else {
      ops.push({ op: 'extend', key: openKey!, seq: event.seq });
    }
    prevSeq = event.seq;
  }

  if (openKey !== null) ops.push({ op: 'close', key: openKey, end_seq: prevSeq });
  ops.push({ op: 'close', key: TASK_KEY, end_seq: prevSeq });

  return {
    ops,
    nodeOrder,
    stats: {
      events: events.length,
      phases,
      fileNodes: 0,
      unmappedTools: [],
      usedTextFallback: true,
    },
  };
}

/**
 * Event indices that start a new segment. A gap qualifies when its window
 * similarity is a local minimum below the classic TextTiling cutoff
 * (mean - sd/2) and is at least one window away from the previous boundary.
 */
function changepoints(
  events: readonly TraceEvent[],
  textOf: (event: TraceEvent) => string,
): Set<number> {
  const bags = events.map((event) => bagOf(textOf(event)));
  const starts = new Set<number>();
  if (bags.length < WINDOW * 2) return starts;

  const gaps: number[] = [];
  for (let g = WINDOW; g <= bags.length - WINDOW; g += 1) {
    gaps.push(cosine(merge(bags, g - WINDOW, g), merge(bags, g, g + WINDOW)));
  }

  const mean = gaps.reduce((sum, v) => sum + v, 0) / gaps.length;
  const variance = gaps.reduce((sum, v) => sum + (v - mean) ** 2, 0) / gaps.length;
  const cutoff = mean - Math.sqrt(variance) / 2;

  let lastGap = -WINDOW;
  for (let i = 0; i < gaps.length; i += 1) {
    const score = gaps[i]!;
    const left = gaps[i - 1] ?? Infinity;
    const right = gaps[i + 1] ?? Infinity;
    if (score < cutoff && score <= left && score <= right && i - lastGap >= WINDOW) {
      starts.add(i + WINDOW);
      lastGap = i;
    }
  }
  return starts;
}

/**
 * Token counts. No stopword list: the cutoff is *relative* to this trace's own
 * mean, so a constant lexical floor shifts every gap equally and a hand-picked
 * word list would be one more thing to keep deterministic.
 */
function bagOf(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (token.length < 2) continue;
    bag.set(token, (bag.get(token) ?? 0) + 1);
  }
  return bag;
}

function merge(bags: readonly Map<string, number>[], from: number, to: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = from; i < to; i += 1) {
    for (const [token, count] of bags[i]!) out.set(token, (out.get(token) ?? 0) + count);
  }
  return out;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [token, count] of a) dot += count * (b.get(token) ?? 0);
  const normA = Math.sqrt([...a.values()].reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt([...b.values()].reduce((sum, v) => sum + v * v, 0));
  return normA === 0 || normB === 0 ? 0 : dot / (normA * normB);
}
