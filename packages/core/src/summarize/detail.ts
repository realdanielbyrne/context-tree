/**
 * §8 branch detail — the raw text a leaf summary is written from, and the
 * tree-derived facts that summary's rehydration pointers must agree with.
 *
 * Detail is assembled from L0 + L2 only: L1 stores coordinates, not content
 * (§6), so the seq range on a node plus the blob store is the whole input. The
 * file spans handed to the model come from the file nodes' `meta_json` —
 * tree-sitter's output (D9) — and are the only spans ever stored, because §9
 * calls these spans verifiable and one invented span makes every rehydration
 * pointer untrustworthy.
 */
import type {
  BlobRef,
  BlobStore,
  SymbolSpan,
  TraceEvent,
  TraceLog,
  TreeNode,
  TreeStore,
} from '../contracts/index.js';

/** Everything the tree already knows about a branch. The model is told these, never asked for them. */
export interface BranchFacts {
  /** Exact spans under this branch, deduped, in file-node creation order. */
  spans: SymbolSpan[];
  symbols: string[];
  /** Every path the tree says this branch touched — the whitelist a model's `files` is checked against. */
  paths: Set<string>;
  tools: string[];
}

export interface DetailSources {
  /** L0. Absent => the branch is described by its coordinates alone. */
  trace?: TraceLog;
  /** L2. Absent => payload refs are named but not resolved. */
  blobs?: BlobStore;
}

/**
 * Per-blob read cap. A single tool-output blob runs to megabytes, and a leaf
 * summary that costs more to produce than the detail it replaces is not a
 * saving — so the head of each payload is read, never the whole thing.
 */
const BLOB_PREFIX_BYTES = 4_096;

/**
 * The smaller cap for a call's arguments. Arguments say *what was asked* (which
 * suite, which pattern, which path) in a line or two, so they are cheap and
 * worth having; §10's Zone C budget is finite, and the facts §8 wants pointers
 * to live in the output, not the request.
 */
const ARGS_PREFIX_BYTES = 1_024;

export function branchFacts(store: TreeStore, node: TreeNode): BranchFacts {
  const spans: SymbolSpan[] = [];
  const seenSpans = new Set<string>();
  const symbols: string[] = [];
  const paths = new Set<string>();
  const tools: string[] = [];

  for (const current of [node, ...store.descendants(node.id)]) {
    const meta = current.meta_json;
    if (typeof meta.path === 'string') paths.add(meta.path);
    for (const span of meta.spans ?? []) {
      paths.add(span.path);
      const key = `${span.path}:${span.start_line}-${span.end_line}:${span.symbol ?? ''}`;
      if (seenSpans.has(key)) continue;
      seenSpans.add(key);
      spans.push(span);
    }
    for (const symbol of meta.symbols ?? []) if (!symbols.includes(symbol)) symbols.push(symbol);
    for (const tool of meta.tools ?? []) if (!tools.includes(tool)) tools.push(tool);
  }
  return { spans, symbols, paths, tools };
}

/** The `{{detail}}` interpolation for the leaf prompt: coordinates first, then the L0 events they index. */
export function renderBranchDetail(
  store: TreeStore,
  node: TreeNode,
  facts: BranchFacts,
  sources: DetailSources,
): string {
  const sections = [renderCoordinates(store, node, facts)];
  const trace = sources.trace;
  if (trace === undefined) {
    // Degrade visibly, not silently: the model must know it is summarizing an
    // outline so it does not report detail it was never shown.
    sections.unshift('NOTE: no L0 trace log was supplied; this branch is described by its coordinates only.');
    return sections.join('\n\n');
  }
  const from = node.span_start_seq;
  if (from !== null) {
    const to = node.span_end_seq ?? trace.lastSeq();
    const rendered: string[] = [];
    for (const event of trace.read({ from, to })) rendered.push(renderEvent(event, sources.blobs));
    if (rendered.length > 0) sections.push(`EVENTS (L0 ${from}..${to}):\n${rendered.join('\n\n')}`);
  }
  return sections.join('\n\n');
}

function renderCoordinates(store: TreeStore, node: TreeNode, facts: BranchFacts): string {
  const lines = [
    'BRANCH COORDINATES (from the tree; authoritative — do not contradict these):',
    `node: ${node.id} kind=${node.kind} phase=${node.phase_type ?? 'none'} status=${node.status}`,
    `L0 span: ${node.span_start_seq ?? 'unset'}..${node.span_end_seq ?? 'unset'}`,
  ];
  if (facts.tools.length > 0) lines.push(`tools used: ${facts.tools.join(', ')}`);
  if (facts.spans.length > 0) {
    lines.push('files touched (tree-sitter spans):');
    for (const span of facts.spans) lines.push(`  - ${formatSpan(span)}`);
  }
  const paths = [...facts.paths].filter((path) => !facts.spans.some((span) => span.path === path));
  for (const path of paths) lines.push(`  - ${path} (no span recorded)`);
  const children = store.children(node.id);
  if (children.length > 0) {
    lines.push('child nodes:');
    for (const child of children) lines.push(`  - ${child.id} ${child.kind} ${child.title}`);
  }
  return lines.join('\n');
}

function formatSpan(span: SymbolSpan): string {
  const symbol = span.symbol === undefined ? '' : ` ${span.symbol}`;
  const kind = span.kind === undefined ? '' : ` [${span.kind}]`;
  const degraded = span.degraded === true ? ' (diff-hunk fallback, no grammar)' : '';
  return `${span.path}:${span.start_line}-${span.end_line}${symbol}${kind}${degraded}`;
}

function renderEvent(event: TraceEvent, blobs: BlobStore | undefined): string {
  const head = `[${event.seq}] ${event.type}`;
  switch (event.type) {
    case 'user_message':
    case 'assistant_message':
    case 'manual_annotation':
      return `${head}\n${payload(blobs, event.blob)}`;
    case 'tool_call': {
      const path = event.path === undefined ? '' : ` path=${event.path}`;
      const lines = [`${head} ${event.tool}${path}`];
      // The arguments are the only record of what was *asked for* — the suite
      // name a `tests[]` pointer is written from (§8), the pattern a later
      // search would have to guess at. Rendering the tool name alone throws
      // that away while still paying for the event.
      if (event.args_blob !== undefined) {
        lines.push(`args: ${payload(blobs, event.args_blob, ARGS_PREFIX_BYTES)}`);
      }
      if (event.blob !== undefined) lines.push(payload(blobs, event.blob));
      return lines.join('\n');
    }
    case 'tool_result': {
      const lines = [`${head} call=${event.call_seq}${event.truncated === true ? ' (truncated)' : ''}`];
      // Error AND output, never one instead of the other. A failing test run
      // carries its reason in `output_blob`; returning the `error` string alone
      // reaches the model as a result with no failure text in it, and §8's
      // `tests: [{name, status, detail}]` pointer cannot be written from
      // nothing — "which test failed" is the fact a resumed agent needs most
      // (§9's unknown-unknowns mitigation is the metadata, so a fact that never
      // reaches the summarizer can never be asked for).
      if (event.error !== undefined) lines.push(`error: ${event.error}`);
      if (event.output_blob !== undefined) lines.push(payload(blobs, event.output_blob));
      return lines.join('\n');
    }
    case 'segment_boundary':
      return `${head} ${event.from ?? 'none'} -> ${event.to}`;
  }
}

function payload(blobs: BlobStore | undefined, ref: BlobRef, maxBytes = BLOB_PREFIX_BYTES): string {
  // A missing blob is not degradable (D8: L1 is a function of L0 + L2), so the
  // store's throw is left to propagate — it surfaces as a failed outcome.
  if (blobs === undefined) return `(payload ${ref.slice(0, 12)}; no blob store supplied)`;
  const text = blobs.getTextPrefix(ref, maxBytes);
  const total = blobs.size(ref);
  if (total <= maxBytes) return text;
  // Marked, never silent: a truncated payload the model reads as a whole one is
  // how a summary comes to report "the suite passed" from the head of a run
  // whose failures were past the cap.
  return `${text}\n… [truncated: first ${maxBytes} of ${total} bytes; fetch the branch for the rest]`;
}
