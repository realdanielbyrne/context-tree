/**
 * §7 segmentation engine (D1) — a single O(n) pass over L0 that emits tree ops.
 *
 * Pure by construction: no store, no clock, no ULIDs, no filesystem, no network
 * (§7.1/D15). That purity is what makes the M1 acceptance ("bit-identical across
 * runs") a thing a test can assert at all, and what lets a segmenter change be
 * validated by deleting L1 and replaying L0 (D8).
 *
 * Span convention for `ingest/`: `open` already covers its own `start_seq`, so
 * the opening event emits no `extend` for that node. Every later event under a
 * node emits one, and `close` carries the last seq the node covered.
 */
import type {
  NodeKey,
  PhaseType,
  Segmentation,
  SegmentConfig,
  Seq,
  TraceEvent,
  TreeOp,
} from '../contracts/index.js';
import { TASK_KEY, fileKey, fileTitle, phaseKey, phaseTitle } from './keys.js';
import { DEFAULT_BOUNDARY } from '../contracts/segment.js';
import { cutsOf, tilingCuts } from './boundary.js';
import { segmentByCuts } from './text-fallback.js';
import { deriveTurns } from './turns.js';

export interface SegmentOptions extends SegmentConfig {
  /**
   * Resolves an event's message text for the §7 unstructured-trace fallback.
   * Optional because L0 stores blob refs, not text: L2 access belongs to the
   * caller, so the segmenter stays pure. Absent => one `other` phase.
   */
  textOf?: (event: TraceEvent) => string;
}

/** The phase node currently accepting events, plus its per-phase file nodes. */
interface OpenPhase {
  key: NodeKey;
  index: number;
  phaseType: PhaseType;
  /** path -> file node key. Scoped here because §7 reuses a file node per phase. */
  files: Map<string, NodeKey>;
}

export function segment(
  events: readonly TraceEvent[],
  config: SegmentOptions,
): Segmentation {
  const first = events[0];
  if (first === undefined) {
    // An empty trace is a legal state (a task DB before its first turn), not an error.
    return {
      ops: [],
      nodeOrder: [],
      stats: { events: 0, phases: 0, fileNodes: 0, unmappedTools: [], usedTextFallback: false },
    };
  }
  const boundary = config.boundary ?? DEFAULT_BOUNDARY;
  if (boundary.strategy !== 'toolPhase' && config.textOf !== undefined) {
    // A text strategy cuts between BLOCKS (turns), never inside one.
    const textOf = config.textOf;
    const turns = deriveTurns(events);
    const cuts = cutsOf(turns.map((t) => events.slice(t.startSeq - first.seq, t.endSeq - first.seq + 1).map(textOf).join('\n')), boundary);
    const starts = new Set([...cuts].map((i) => turns[i]!.startSeq - first.seq));
    return segmentByCuts(events, { taskTitle: config.taskTitle, starts, usedTextFallback: false });
  }
  if (!events.some((event) => event.type === 'tool_call')) {
    // §7 unstructured-trace fallback: TextTiling over events, the classic constants.
    const starts = config.textOf === undefined ? new Set<number>() : tilingCuts(events.map(config.textOf), { window: 3, threshold: 0.5, topK: 0 });
    return segmentByCuts(events, { taskTitle: config.taskTitle, starts, usedTextFallback: true });
  }

  const ops: TreeOp[] = [];
  const nodeOrder: NodeKey[] = [];
  // Sets, not `includes`: the pass must stay O(n) for a 400+ event trace (§16 M1).
  const neutral = new Set<PhaseType>(config.neutralPhases);
  const fileTools = new Set<string>(config.fileTools);
  // Compiled once, not per event: the pass stays O(n) in events, O(rules) per
  // shell event, and the rule list is a fixed handful (D21).
  const commandRules = (config.toolPhaseByCommand ?? []).map((rule) => ({
    re: new RegExp(rule.pattern),
    phase: rule.phase,
  }));
  const unmappedTools: string[] = [];
  const unmappedSeen = new Set<string>();
  const toolsSeen = new Map<NodeKey, Set<string>>();
  const typeOrdinals = new Map<PhaseType, number>();

  let phases = 0;
  let fileNodes = 0;
  let open: OpenPhase | null = null;
  /** Seq of the previous event — where a phase's span ends when the next one opens. */
  let prevSeq: Seq = first.seq;
  /**
   * The trace's own start, held until the first phase opens so that phase can
   * adopt it, then null forever.
   *
   * WHY (§8). A phase node used to open on the first `tool_call`, which left
   * every event before it — the opening user message, the task statement —
   * inside the task root and inside no phase. §8 builds the root summary from
   * its *child summaries*, never from raw events (raw events at the root is
   * §15's arm C baseline), so those events reached no summary at all: a resumed
   * agent could read every branch summary in Zone B and still not know what it
   * had been asked to do, which is exactly §9's unknown-unknowns failure and
   * the fact §15's benchmark turns on.
   *
   * The fix is the smallest one §7 allows. §7 types a phase from tool activity
   * and says messages attach to the open phase; it says nothing about where the
   * FIRST phase begins, because there is no earlier phase to own those events.
   * Starting it at the trace's first event makes phase spans partition L0 — no
   * event outside a phase, so no event outside a summary — while keeping the
   * phase sequence, count, types, keys and node ids (D16) byte-identical for
   * every trace, including one that opens with a tool call, where this is the
   * opening event's own seq. Inventing an extra leading phase would instead
   * type a phase from no tool signal and renumber every node downstream.
   */
  let pendingStart: Seq | null = first.seq;
  /** Seqs of that leading run, replayed onto the first phase when it opens. */
  const pendingExtends: Seq[] = [];

  const openPhase = (phaseType: PhaseType, startSeq: Seq): OpenPhase => {
    const index = phases;
    phases += 1;
    const ordinal = (typeOrdinals.get(phaseType) ?? 0) + 1;
    typeOrdinals.set(phaseType, ordinal);
    const key = phaseKey(index);
    const adopted = pendingStart;
    ops.push({
      op: 'open',
      key,
      parent: TASK_KEY,
      kind: 'phase',
      title: phaseTitle(phaseType, ordinal),
      phase_type: phaseType,
      start_seq: adopted ?? startSeq,
    });
    nodeOrder.push(key);
    if (adopted !== null) {
      pendingStart = null;
      // The span convention holds for the adopted run too: `open` covers
      // `start_seq`, every later event under the node emits one `extend`.
      for (const seq of pendingExtends) ops.push({ op: 'extend', key, seq });
      pendingExtends.length = 0;
      if (startSeq !== adopted) ops.push({ op: 'extend', key, seq: startSeq });
    }
    return { key, index, phaseType, files: new Map() };
  };

  /** Deepest first, so `ingest/` never closes a parent before its children. */
  const closePhase = (phase: OpenPhase, endSeq: Seq): void => {
    for (const key of phase.files.values()) ops.push({ op: 'close', key, end_seq: endSeq });
    ops.push({ op: 'close', key: phase.key, end_seq: endSeq });
  };

  /** One `tool` op per (node, tool) pair — `meta_json.tools` is first-seen order. */
  const noteTool = (key: NodeKey, tool: string): void => {
    let seen = toolsSeen.get(key);
    if (seen === undefined) {
      seen = new Set<string>();
      toolsSeen.set(key, seen);
    }
    if (seen.has(tool)) return;
    seen.add(tool);
    ops.push({ op: 'tool', key, tool });
  };

  ops.push({
    op: 'open',
    key: TASK_KEY,
    parent: null,
    kind: 'task',
    title: config.taskTitle,
    phase_type: null,
    start_seq: first.seq,
  });
  nodeOrder.push(TASK_KEY);

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (i > 0) ops.push({ op: 'extend', key: TASK_KEY, seq: event.seq });

    switch (event.type) {
      case 'tool_call': {
        const mapped = config.toolPhase[event.tool];
        if (mapped === undefined && !unmappedSeen.has(event.tool)) {
          // §18: tool-name drift must degrade, never crash.
          unmappedSeen.add(event.tool);
          unmappedTools.push(event.tool);
        }
        // D21: one shell tool name covers every phase, so the command decides
        // when the harness gives us one. No match falls back to the name map.
        const byCommand = event.command === undefined
          ? undefined
          : commandRules.find((rule) => rule.re.test(event.command as string))?.phase;
        const phaseType = byCommand ?? mapped ?? 'other';

        let phase: OpenPhase;
        if (open === null) {
          phase = openPhase(phaseType, event.seq);
        } else if (!neutral.has(phaseType) && open.phaseType !== phaseType) {
          // The literal §7 rule, but only for non-neutral phases (Ruling C6):
          // read-shaped tools dominate real traces and all map to `other`, which
          // would shatter the tree into one-event phases if it opened nodes.
          closePhase(open, prevSeq);
          phase = openPhase(phaseType, event.seq);
        } else {
          phase = open;
          ops.push({ op: 'extend', key: phase.key, seq: event.seq });
        }
        open = phase;

        noteTool(TASK_KEY, event.tool);
        noteTool(phase.key, event.tool);

        if (event.path !== undefined && fileTools.has(event.tool)) {
          const existing = phase.files.get(event.path);
          if (existing === undefined) {
            const key = fileKey(phase.index, event.path);
            ops.push({
              op: 'open',
              key,
              parent: phase.key,
              kind: 'file',
              title: fileTitle(event.path),
              phase_type: null,
              start_seq: event.seq,
              path: event.path,
            });
            nodeOrder.push(key);
            phase.files.set(event.path, key);
            fileNodes += 1;
            noteTool(key, event.tool);
          } else {
            // §7: re-edits of one path append spans to the same file node.
            ops.push({ op: 'extend', key: existing, seq: event.seq });
            noteTool(existing, event.tool);
          }
        }
        break;
      }

      case 'segment_boundary': {
        // The host knows something tool names don't, so this wins outright —
        // even when `to` matches the open phase's type.
        if (open !== null) closePhase(open, prevSeq);
        open = openPhase(event.to, event.seq);
        break;
      }

      default: {
        // §7: messages, results and annotations attach to the open phase. They
        // never open one — a phase is a *tool-activity* interval. Before the
        // first phase exists they are held, not dropped, and the first phase to
        // open adopts them (see `pendingStart`).
        if (open !== null) ops.push({ op: 'extend', key: open.key, seq: event.seq });
        else if (i > 0) pendingExtends.push(event.seq);
        break;
      }
    }
    prevSeq = event.seq;
  }

  if (open !== null) closePhase(open, prevSeq);
  ops.push({ op: 'close', key: TASK_KEY, end_seq: prevSeq });

  return {
    ops,
    nodeOrder,
    stats: { events: events.length, phases, fileNodes, unmappedTools, usedTextFallback: false },
  };
}
