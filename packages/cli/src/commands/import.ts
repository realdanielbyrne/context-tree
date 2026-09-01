/**
 * §16 M1's other half: get a real trace into L0 + L2 so the segmenter has
 * something to segment.
 *
 * Two input shapes, one rule. A file already in L0 format is validated event by
 * event with core's own `parseTraceEvent` — the same validator `trace.jsonl`
 * itself goes through, so an import can never introduce a record the log would
 * have rejected. A Claude Code transcript is mapped onto L0 first (see
 * `claude-code.ts`).
 *
 * Failures are per line and non-fatal unless `--strict`: with a real transcript
 * a handful of unmappable lines is the normal case, and refusing the whole
 * import over one of them would make the command useless exactly when it is
 * needed. Nothing is appended until every line has been read, so `--strict`
 * leaves L0 untouched.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ingest,
  openTaskStore,
  parseTraceEvent,
  type BlobStore,
  type IngestStats,
  type Seq,
  type ToolCallEvent,
  type ToolResultEvent,
  type TraceEvent,
  type TraceEventInput,
} from '@context-tree/core';
import { mapClaudeCodeTranscript, type LineFailure } from '../claude-code.js';
import { configFor, cwdOf, type GlobalOptions } from '../context.js';
import { CliError } from '../errors.js';
import { report, type Io } from '../io.js';

export interface ImportOptions extends GlobalOptions {
  /** Read the file as a Claude Code session transcript instead of L0. */
  fromClaudeCode?: boolean;
  /** Fail on the first bad line instead of importing what parsed. */
  strict?: boolean;
}

export interface ImportResult {
  source: string;
  root: string;
  format: 'l0' | 'claude-code';
  /** Events appended to L0. */
  events: number;
  /** Lines carrying nothing L0 represents. */
  skipped: number;
  failures: LineFailure[];
  blobs: { written: number; copied: number; missing: number };
  stats: IngestStats;
}

/** L2 refs are bare sha256 hex — anything else cannot name a blob. */
const BLOB_REF = /^[0-9a-f]{64}$/;

const BLOB_FIELDS = ['blob', 'args_blob', 'output_blob'] as const;

export function importCommand(file: string, opts: ImportOptions, io: Io): ImportResult {
  const config = configFor(opts);
  const source = resolve(cwdOf(opts), file);
  if (!existsSync(source)) throw new CliError(`no such trace file: ${source}`);
  const lines = readFileSync(source, 'utf8').split('\n');

  const handle = openTaskStore(config);
  try {
    const startSeq = handle.trace.lastSeq();
    const mapped =
      opts.fromClaudeCode === true
        ? mapClaudeCodeTranscript(lines, { startSeq, blobs: handle.blobs })
        : mapL0Trace(lines, startSeq);

    if (opts.strict === true && mapped.failures.length > 0) {
      const first = mapped.failures[0] as LineFailure;
      throw new CliError(
        `--strict: ${mapped.failures.length} line(s) failed, nothing imported; ` +
          `first at line ${first.line}: ${first.error}`,
      );
    }

    // A transcript's payloads were written to L2 as it was mapped; an L0 file
    // carries refs only, so its blobs come from a `blobs/` directory beside it
    // (how a store moves between machines). L2 is content-addressed and
    // write-once, so a blob nothing ends up referencing is inert.
    const blobs = hydrateBlobs(mapped.events, handle.blobs, dirname(source));
    handle.trace.appendAll(mapped.events);
    const { stats } = ingest({ handle });

    const result: ImportResult = {
      source,
      root: config.root,
      format: opts.fromClaudeCode === true ? 'claude-code' : 'l0',
      events: mapped.events.length,
      skipped: mapped.skipped,
      failures: mapped.failures,
      blobs: { written: mapped.blobsWritten, ...blobs },
      stats,
    };
    report(io, opts.json, result, humanLines(result));
    return result;
  } finally {
    handle.close();
  }
}

interface MappedTrace {
  events: TraceEventInput[];
  failures: LineFailure[];
  skipped: number;
  blobsWritten: number;
}

/**
 * Validates an L0 file line by line and renumbers it onto the end of this
 * store's log.
 *
 * Renumbering is not cosmetic: L0 seqs must be gap-free and monotonic, so an
 * import into a non-empty log — or one that dropped a bad line — has to rewrite
 * the `call_seq`/`parent_seq` back-references too. A `tool_result` whose call
 * did not survive is itself unmappable and reported; a `parent_seq` is only a
 * provenance hint, so it is dropped rather than failing the event.
 */
function mapL0Trace(lines: readonly string[], startSeq: Seq): MappedTrace {
  const events: TraceEventInput[] = [];
  const failures: LineFailure[] = [];
  const seqMap = new Map<Seq, Seq>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = lines[index] ?? '';
    if (raw.trim().length === 0) continue;

    let event: TraceEvent;
    try {
      event = parseTraceEvent(raw);
    } catch (error) {
      failures.push({ line, error: (error as Error).message });
      continue;
    }
    const seq = startSeq + events.length + 1;
    const remapped = renumber(event, seq, seqMap);
    if (typeof remapped === 'string') {
      failures.push({ line, error: remapped });
      continue;
    }
    seqMap.set(event.seq, seq);
    events.push(remapped);
  }

  return { events, failures, skipped: 0, blobsWritten: 0 };
}

/** The renumbered event, or the reason it cannot be represented in this log. */
function renumber(
  event: TraceEvent,
  seq: Seq,
  seqMap: ReadonlyMap<Seq, Seq>,
): TraceEventInput | string {
  switch (event.type) {
    case 'tool_result': {
      const callSeq = seqMap.get(event.call_seq);
      if (callSeq === undefined) {
        return `tool_result references seq ${event.call_seq}, which was not imported`;
      }
      const mapped: TraceEventInput<ToolResultEvent> = { ...event, seq, call_seq: callSeq };
      return mapped;
    }
    case 'tool_call': {
      const mapped: TraceEventInput<ToolCallEvent> = { ...event, seq };
      if (event.parent_seq !== undefined) {
        const parent = seqMap.get(event.parent_seq);
        if (parent === undefined) delete mapped.parent_seq;
        else mapped.parent_seq = parent;
      }
      return mapped;
    }
    default:
      return { ...event, seq };
  }
}

function hydrateBlobs(
  events: readonly TraceEventInput[],
  blobs: BlobStore,
  sourceDir: string,
): { copied: number; missing: number } {
  const beside = join(sourceDir, 'blobs');
  let copied = 0;
  let missing = 0;
  for (const ref of blobRefs(events)) {
    if (!BLOB_REF.test(ref)) {
      missing += 1;
      continue;
    }
    if (blobs.has(ref)) continue;
    const candidate = join(beside, ref.slice(0, 2), ref.slice(2));
    if (!existsSync(candidate)) {
      missing += 1;
      continue;
    }
    blobs.put(readFileSync(candidate));
    copied += 1;
  }
  return { copied, missing };
}

function blobRefs(events: readonly TraceEventInput[]): string[] {
  const refs = new Set<string>();
  for (const event of events) {
    const record = event as unknown as Record<string, unknown>;
    for (const field of BLOB_FIELDS) {
      const value = record[field];
      if (typeof value === 'string') refs.add(value);
    }
  }
  return [...refs];
}

function humanLines(result: ImportResult): string[] {
  const lines = [`imported ${result.events} event(s) from ${result.source} into ${result.root}`];
  if (result.skipped > 0) lines.push(`skipped ${result.skipped} line(s) with no L0 event`);
  if (result.failures.length > 0) {
    lines.push(`${result.failures.length} line(s) failed:`);
    for (const failure of result.failures) lines.push(`  line ${failure.line}: ${failure.error}`);
  }
  if (result.blobs.missing > 0) {
    // Missing payloads are why a node can end up span-less; say so rather than
    // letting the user discover an empty summary later.
    lines.push(`${result.blobs.missing} referenced blob(s) missing from L2 — those nodes lose their detail`);
  }
  lines.push(
    `tree: ${result.stats.nodes} node(s), ${result.stats.phases} phase(s), ` +
      `${result.stats.fileNodes} file node(s), ${result.stats.spans} span(s)`,
  );
  if (result.stats.unresolvedAnnotations > 0) {
    // Same reason as `rebuild`: an imported §9 note the replay could not place
    // on a node is lost, and L1 is only ever derived from L0 (D8), so nothing
    // else will surface it later.
    lines.push(
      `${result.stats.unresolvedAnnotations} annotation(s) could not be replayed onto a node ` +
        '(unknown node_id, missing L2 body, or unknown link target) — those notes/edges are not in the tree',
    );
  }
  if (result.stats.unmappedTools.length > 0) {
    // §18: tool-name drift degrades to `other`. Naming the tools is what makes
    // it fixable via `toolPhase` in the config.
    lines.push(`unmapped tools -> "other": ${result.stats.unmappedTools.join(', ')}`);
  }
  return lines;
}
