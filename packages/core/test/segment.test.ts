import { describe, expect, it } from 'vitest';
import type { PhaseType, Segmentation, TraceEvent, TreeOp } from '../src/contracts/index.js';
import { resolveConfig } from '../src/config.js';
import { type SegmentOptions, TASK_KEY, fileKey, phaseKey, segment } from '../src/segment/index.js';

// ---------------------------------------------------------------------------
// Fixture builders. Seqs are assigned by position: L0 is gap-free and strictly
// increasing, so index+1 is the only legal numbering.
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const BLOB = 'f'.repeat(64);

type Draft = (seq: number) => TraceEvent;

function build(drafts: readonly Draft[]): TraceEvent[] {
  return drafts.map((draft, i) => draft(i + 1));
}

const user = (): Draft => (seq) => ({ seq, type: 'user_message', ts: TS, blob: BLOB });
const assistant = (): Draft => (seq) => ({ seq, type: 'assistant_message', ts: TS, blob: BLOB });
const result = (): Draft => (seq) => ({ seq, type: 'tool_result', ts: TS, call_seq: seq - 1 });
const call =
  (tool: string, path?: string): Draft =>
  (seq) =>
    path === undefined
      ? { seq, type: 'tool_call', ts: TS, tool }
      : { seq, type: 'tool_call', ts: TS, tool, path };
const boundary =
  (to: PhaseType): Draft =>
  (seq) => ({ seq, type: 'segment_boundary', ts: TS, from: null, to });

function options(partial: Partial<SegmentOptions> = {}): SegmentOptions {
  // Segment against the real §7 defaults, so a defaults change fails here too.
  // `toolPhase` merges over them exactly as `resolveConfig` does in production.
  const base = resolveConfig();
  return { ...base, ...partial, toolPhase: { ...base.toolPhase, ...(partial.toolPhase ?? {}) } };
}

type OpenOp = Extract<TreeOp, { op: 'open' }>;

const opens = (s: Segmentation): OpenOp[] =>
  s.ops.filter((op): op is OpenOp => op.op === 'open');
const phaseTypes = (s: Segmentation): (PhaseType | null)[] =>
  opens(s).filter((op) => op.kind === 'phase').map((op) => op.phase_type);
const phaseTitles = (s: Segmentation): string[] =>
  opens(s).filter((op) => op.kind === 'phase').map((op) => op.title);

/** `[start, end]` per phase, in open order — `close` carries the end (§7). */
const phaseSpans = (s: Segmentation): [number, number][] =>
  opens(s)
    .filter((op) => op.kind === 'phase')
    .map((op) => {
      const closed = s.ops.find((other) => other.op === 'close' && other.key === op.key);
      return [op.start_seq, closed?.op === 'close' ? closed.end_seq : op.start_seq];
    });

/**
 * One realistic Claude Code turn: read around, edit twice, shell out, run tests.
 * 10 events -> phases diagnosis, implementation, verification (Bash is neutral).
 */
function turn(nth: number): Draft[] {
  const path = `src/mod${nth % 3}.ts`;
  return [
    user(),
    assistant(),
    call('Read', path),
    call('Grep'),
    result(),
    call('Edit', path),
    call('Edit', path),
    call('Bash'),
    call('run_tests'),
    result(),
  ];
}

const FIXTURE_400: TraceEvent[] = build(
  Array.from({ length: 40 }, (_, i) => turn(i)).flat(),
);

// ---------------------------------------------------------------------------

describe('segment — §16 M1 acceptance', () => {
  it('produces the expected phase sequence over a 400-event fixture, because the tree shape IS the product', () => {
    const s = segment(FIXTURE_400, options());

    expect(FIXTURE_400).toHaveLength(400);
    expect(s.stats.events).toBe(400);
    // Read/Grep -> diagnosis, Edit -> implementation, Bash absorbed, run_tests -> verification.
    expect(phaseTypes(s)).toEqual(
      Array.from({ length: 40 }, () => ['diagnosis', 'implementation', 'verification']).flat(),
    );
    expect(s.stats.phases).toBe(120);
    // Titles must disambiguate repeats or Zone B reads as 40 identical headings (§10).
    expect(phaseTitles(s).slice(0, 5)).toEqual([
      'diagnosis',
      'implementation',
      'verification',
      'diagnosis (2)',
      'implementation (2)',
    ]);
  });

  it('spans the root over every event so the task node is never narrower than L0', () => {
    const s = segment(FIXTURE_400, options());
    const root = opens(s).find((op) => op.kind === 'task');
    expect(root?.start_seq).toBe(1);
    expect(s.ops.at(-1)).toEqual({ op: 'close', key: TASK_KEY, end_seq: 400 });
    expect(s.nodeOrder[0]).toBe(TASK_KEY);
    expect(s.nodeOrder[1]).toBe(phaseKey(0));
  });

  it('segments 400 events in under 5 ms, because §7.1 puts ingestion inline on the turn path', () => {
    const cfg = options();
    for (let i = 0; i < 3; i += 1) segment(FIXTURE_400, cfg); // warm up the JIT
    let best = Infinity;
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      segment(FIXTURE_400, cfg);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(5);
  });

  it('is bit-identical across runs, which is what makes an L1 rebuild an audit rather than a guess (D1/D8)', () => {
    const a = segment(FIXTURE_400, options());
    const b = segment(FIXTURE_400, options());
    expect(a).toEqual(b);
    // "Bit-identical" means the serialized form matches, not just deep equality:
    // key order and numeric formatting have to agree too.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // No hashes, no timestamps, no ULIDs in keys — that is why the above holds.
    expect(a.nodeOrder.every((key) => !/\d{13}|[0-9a-f]{16}/.test(key))).toBe(true);
  });
});

describe('segment — neutral phases (Ruling C6)', () => {
  const drafts = [call('Read'), call('Edit', 'a.ts'), call('Bash'), call('Bash'), call('Edit', 'a.ts')];

  it('absorbs a neutral tool into the open phase, or read-shaped traces shatter into one-event phases', () => {
    const s = segment(build(drafts), options());
    expect(phaseTypes(s)).toEqual(['diagnosis', 'implementation']);
    // The absorbed tool is still recorded under the phase it landed in.
    expect(s.ops).toContainEqual({ op: 'tool', key: phaseKey(1), tool: 'Bash' });
  });

  it('opens a phase for a neutral tool when nothing is open yet, so no event is orphaned', () => {
    const s = segment(build([call('Bash'), call('Bash')]), options());
    expect(phaseTypes(s)).toEqual(['other']);
    expect(s.stats.phases).toBe(1);
  });

  it('restores the literal §7 rule when neutralPhases is [], so C6 is an opt-out not a hardcode', () => {
    const s = segment(build(drafts), options({ neutralPhases: [] }));
    expect(phaseTypes(s)).toEqual(['diagnosis', 'implementation', 'other', 'implementation']);
  });

  it('treats any configured phase as neutral, proving the branch is config-driven and not cased on "other"', () => {
    // `diagnosis` neutral: the trailing Read must be absorbed by implementation.
    const s = segment(
      build([call('Read'), call('Edit', 'a.ts'), call('Read'), call('Grep')]),
      options({ neutralPhases: ['diagnosis'] }),
    );
    expect(phaseTypes(s)).toEqual(['diagnosis', 'implementation']);
    expect(s.ops).toContainEqual({ op: 'tool', key: phaseKey(1), tool: 'Grep' });
  });
});

describe('segment — tool mapping (§18: tool-name drift)', () => {
  it('routes an unmapped tool to `other` and records it, because a new harness must never crash ingestion', () => {
    const s = segment(
      build([call('FrobnicateWidget'), call('FrobnicateWidget'), call('mcp__x__do')]),
      options(),
    );
    expect(phaseTypes(s)).toEqual(['other']);
    // Deduped, first-seen order: this list is a config-gap report, not a log.
    expect(s.stats.unmappedTools).toEqual(['FrobnicateWidget', 'mcp__x__do']);
  });

  it('honours a remapped tool name so a harness can re-type its phases without a code change (§7)', () => {
    const s = segment(build([call('Bash'), call('Read')]), options({ toolPhase: { Bash: 'verification' } }));
    expect(phaseTypes(s)).toEqual(['verification', 'diagnosis']);
    expect(s.stats.unmappedTools).toEqual([]);
  });
});

describe('segment — file nodes (§7)', () => {
  it('extends one file node when a path is re-edited in a phase, because spans accumulate per file', () => {
    const s = segment(
      build([call('Edit', 'src/a.ts'), call('Edit', 'src/b.ts'), call('Edit', 'src/a.ts')]),
      options(),
    );
    const fileOpens = opens(s).filter((op) => op.kind === 'file');
    expect(fileOpens.map((op) => op.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(fileOpens.map((op) => op.title)).toEqual(['a.ts', 'b.ts']);
    expect(s.stats.fileNodes).toBe(2);
    expect(s.ops).toContainEqual({ op: 'extend', key: fileKey(0, 'src/a.ts'), seq: 3 });
  });

  it('opens a fresh file node for the same path in a later phase, keeping a node inside one phase span', () => {
    const s = segment(
      build([call('Edit', 'src/a.ts'), call('run_tests'), call('Edit', 'src/a.ts')]),
      options(),
    );
    expect(s.nodeOrder).toEqual([
      TASK_KEY,
      phaseKey(0),
      fileKey(0, 'src/a.ts'),
      phaseKey(1),
      phaseKey(2),
      fileKey(2, 'src/a.ts'),
    ]);
  });

  it('does not make a file node for a non-fileTool path, or every Read would forge an edit node', () => {
    const s = segment(build([call('Read', 'src/a.ts'), call('Grep', 'src/a.ts')]), options());
    expect(opens(s).filter((op) => op.kind === 'file')).toEqual([]);
    expect(s.stats.fileNodes).toBe(0);
  });

  it('closes a file node before its phase, so ingest never closes a parent ahead of its child', () => {
    const s = segment(build([call('Edit', 'src/a.ts'), call('run_tests')]), options());
    const closes = s.ops.filter((op) => op.op === 'close').map((op) => op.key);
    expect(closes).toEqual([fileKey(0, 'src/a.ts'), phaseKey(0), phaseKey(1), TASK_KEY]);
  });

  it('ends a phase at its own last event, not at the event that opened the next one', () => {
    const s = segment(build([call('Edit', 'a.ts'), call('run_tests')]), options());
    expect(s.ops).toContainEqual({ op: 'close', key: phaseKey(0), end_seq: 1 });
    expect(s.ops).toContainEqual({ op: 'open', key: phaseKey(1), parent: TASK_KEY, kind: 'phase', title: 'verification', phase_type: 'verification', start_seq: 2 });
  });
});

describe('segment — explicit host boundaries (§7)', () => {
  it('opens a new phase on segment_boundary even when the type is unchanged, because the host knows what tool names cannot', () => {
    const s = segment(
      build([call('Edit', 'a.ts'), boundary('implementation'), call('Edit', 'a.ts')]),
      options(),
    );
    expect(phaseTypes(s)).toEqual(['implementation', 'implementation']);
    expect(s.stats.phases).toBe(2);
    // A second file node, since the boundary really did end the first phase.
    expect(s.stats.fileNodes).toBe(2);
  });

  it('types the phase from the host-supplied `to`, a type no tool in this trace maps to', () => {
    const s = segment(build([call('Read'), boundary('delivery'), call('Read')]), options());
    expect(phaseTypes(s)).toEqual(['diagnosis', 'delivery', 'diagnosis']);
    expect(phaseTitles(s)).toEqual(['diagnosis', 'delivery', 'diagnosis (2)']);
    // The boundary event opens the new phase; it does not trail the old one.
    const delivery = opens(s).filter((op) => op.kind === 'phase')[1];
    expect(delivery?.start_seq).toBe(2);
    expect(s.ops).toContainEqual({ op: 'close', key: phaseKey(0), end_seq: 1 });
  });
});

describe('segment — messages (§7)', () => {
  it('attaches messages to the open phase without opening one, since a phase is a tool-activity interval', () => {
    const s = segment(build([call('Edit', 'a.ts'), user(), assistant(), result()]), options());
    expect(s.stats.phases).toBe(1);
    for (const seq of [2, 3, 4]) {
      expect(s.ops).toContainEqual({ op: 'extend', key: phaseKey(0), seq });
    }
  });

  /**
   * §8 writes the root summary from its child summaries, never from raw events,
   * so an event under no phase reaches no summary — and the events before the
   * first tool call are the user's task statement. A resumed agent could read
   * every branch summary in Zone B and still not know what it was asked to do
   * (§9's unknown-unknowns failure; §15's benchmark turns on exactly this).
   */
  it('gives the pre-tool opening messages to the first phase, because an event in no phase reaches no summary (§8)', () => {
    const s = segment(build([user(), assistant(), call('Edit', 'a.ts')]), options());
    const phaseOpen = opens(s).find((op) => op.kind === 'phase');

    expect(phaseOpen?.start_seq).toBe(1);
    // Adopted, not re-typed: the phase is still typed by the tool that opened
    // it, and no extra phase was invented from a run with no tool signal.
    expect(phaseTypes(s)).toEqual(['implementation']);
    expect(s.stats.phases).toBe(1);
    // The span convention holds for the adopted run: `open` covers seq 1, every
    // later event under the node emits one `extend`.
    expect(s.ops).toContainEqual({ op: 'extend', key: phaseKey(0), seq: 2 });
    expect(s.ops).toContainEqual({ op: 'extend', key: phaseKey(0), seq: 3 });
  });

  it('leaves a tool-first trace exactly where it was, so adopting the leading run never renumbers a phase (D16)', () => {
    const s = segment(build([call('Edit', 'a.ts'), user(), call('run_tests')]), options());
    expect(opens(s).filter((op) => op.kind === 'phase').map((op) => op.start_seq)).toEqual([1, 3]);
    // The opening event still emits no `extend` of its own.
    expect(s.ops).not.toContainEqual({ op: 'extend', key: phaseKey(0), seq: 1 });
  });

  it('covers every event with exactly one phase span — the property that makes "no event misses a summary" checkable', () => {
    for (const events of [build([user(), assistant(), call('Edit', 'a.ts'), result(), call('run_tests')]), FIXTURE_400]) {
      const s = segment(events, options());
      const spans = phaseSpans(s);
      expect(spans[0]?.[0]).toBe(events[0]?.seq);
      expect(spans.at(-1)?.[1]).toBe(events.at(-1)?.seq);
      // Contiguous and non-overlapping: phase i ends on the event before phase
      // i+1 opens, so the union is the whole log with no gap to fall into.
      for (let i = 1; i < spans.length; i += 1) expect(spans[i]?.[0]).toBe((spans[i - 1]?.[1] ?? 0) + 1);
    }
  });
});

describe('segment — §7 text fallback (Ruling C7)', () => {
  const LEXICAL = [
    'the connection pool leaks socket handles under load',
    'socket handles leak when the pool retries a timeout',
    'pool timeout retries leak more handles under load',
    'the leak grows with pool size and socket retries',
    'handles leak; the pool never closes a timed socket',
    'pool leak reproduced: sockets and handles under load',
    'draft the release notes and tag the changelog version',
    'changelog version bump goes in the release notes draft',
    'tag the release, then publish notes from the changelog',
    'publish the changelog draft with the version tag notes',
    'release notes published; changelog tagged for version',
    'the published release notes match the changelog draft',
  ];

  const talk = (): TraceEvent[] =>
    build(LEXICAL.map((_, i) => (i % 2 === 0 ? user() : assistant())));

  const textOf = (event: TraceEvent): string => LEXICAL[event.seq - 1] ?? '';

  it('splits a tool-less trace at a lexical changepoint, with no embedding call (§7.1/D15 hermeticity)', () => {
    const s = segment(talk(), options({ textOf }));
    expect(s.stats.usedTextFallback).toBe(true);
    expect(s.stats.phases).toBe(2);
    // The vocabulary switches at index 6 -> seq 7.
    expect(opens(s).filter((op) => op.kind === 'phase').map((op) => op.start_seq)).toEqual([1, 7]);
    // No tool signal exists, so claiming a phase type would be a guess.
    expect(phaseTypes(s)).toEqual(['other', 'other']);
    expect(phaseTitles(s)).toEqual(['other', 'other (2)']);
  });

  it('is deterministic too — the fallback is lexical precisely so it can be replayed (D8)', () => {
    const a = segment(talk(), options({ textOf }));
    const b = segment(talk(), options({ textOf }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('yields one phase for a trace shorter than two windows, instead of dividing by zero gaps', () => {
    const short = build([user(), assistant(), user()]);
    const s = segment(short, options({ textOf }));
    expect(s.stats).toEqual({
      events: 3,
      phases: 1,
      fileNodes: 0,
      unmappedTools: [],
      usedTextFallback: true,
    });
  });

  it('yields one `other` phase with no text resolver, because L0 holds blob refs and never text', () => {
    const s = segment(talk(), options());
    expect(s.stats.usedTextFallback).toBe(true);
    expect(s.stats.phases).toBe(1);
    expect(s.ops.at(-1)).toEqual({ op: 'close', key: TASK_KEY, end_seq: 12 });
  });

  it('never runs when a single tool call is present, since structural signal beats lexical guessing (D1)', () => {
    const s = segment(build([user(), call('Edit', 'a.ts'), assistant()]), options({ textOf }));
    expect(s.stats.usedTextFallback).toBe(false);
    expect(phaseTypes(s)).toEqual(['implementation']);
  });
});

describe('segment — degenerate input', () => {
  it('returns no ops for an empty trace: a task with no turns yet is legal, not an error', () => {
    const s = segment([], options());
    expect(s).toEqual({
      ops: [],
      nodeOrder: [],
      stats: { events: 0, phases: 0, fileNodes: 0, unmappedTools: [], usedTextFallback: false },
    });
  });

  it('handles a one-event trace by opening and closing the root on the same seq', () => {
    const s = segment(build([call('Edit', 'a.ts')]), options());
    expect(s.ops.filter((op) => op.op === 'close')).toEqual([
      { op: 'close', key: fileKey(0, 'a.ts'), end_seq: 1 },
      { op: 'close', key: phaseKey(0), end_seq: 1 },
      { op: 'close', key: TASK_KEY, end_seq: 1 },
    ]);
  });
});
