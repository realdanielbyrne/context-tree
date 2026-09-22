/**
 * Segmentation from a set of CUTS: one `other` phase per run of events between cuts.
 *
 * Used by every boundary strategy that is not the tool-phase state machine — the §7
 * unstructured-trace fallback (a trace with zero `tool_call` events, tiled over events)
 * and the selectable `tiling` / `drift` strategies (tiled over blocks). Every phase it
 * emits is typed `other`: with no tool names there is no signal for a phase type, and
 * inventing one would be a guess the tree can't audit. The cuts themselves come from
 * `boundary.ts`; this file only turns them into tree ops.
 */
import type {
  NodeKey,
  PhaseType,
  Segmentation,
  TraceEvent,
  TreeOp,
} from '../contracts/index.js';
import { TASK_KEY, phaseKey, phaseTitle } from './keys.js';

const FALLBACK_PHASE: PhaseType = 'other';

export interface TextSegmentOptions {
  taskTitle: string;
  /** Event indices that start a new phase; 0 is implied. */
  starts: ReadonlySet<number>;
  usedTextFallback: boolean;
}

export function segmentByCuts(events: readonly TraceEvent[], options: TextSegmentOptions): Segmentation {
  const first = events[0];
  if (first === undefined) throw new Error('segmentByCuts: empty event list');
  const { starts } = options;

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
    if (event.type === 'fold' || event.type === 'unfold') continue;
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
      usedTextFallback: options.usedTextFallback,
    },
  };
}
