/**
 * §10 block text rendering + the one degradation primitive Zone C needs.
 *
 * Everything here is a pure function of its arguments (plus L2 reads, which are
 * write-once). That matters for D5: a block's text must be reproducible from the
 * same L1 row + L2 blobs on every turn, or the cached prefix moves for reasons
 * nobody can see.
 */
import type {
  BlobStore,
  NodeLink,
  NodeSummary,
  SymbolSpan,
  Tokenizer,
  TraceEvent,
  TreeNode,
} from '../contracts/index.js';

function spanLabel(span: SymbolSpan): string {
  const parts = [`${span.path}:${span.start_line}-${span.end_line}`];
  if (span.symbol !== undefined) parts.push(`(${span.symbol})`);
  if (span.degraded === true) parts.push('[line-span only]');
  return parts.join(' ');
}

function seqRange(node: TreeNode): string {
  if (node.span_start_seq === null) return 'seq -';
  return `seq ${node.span_start_seq}-${node.span_end_seq ?? node.span_start_seq}`;
}

/**
 * D18: no rendered meta list prints more than LIST_MAX_VALUES entries. The root
 * block's decisions/open-questions/fetchable-nodes are merges over EVERY child,
 * so an uncapped list re-introduces the ~50-tok/branch growth that capping the
 * root's headline list (D17) removed. Prompt lossy, L1 lossless — the full list
 * stays in the stored SummaryMeta and is reachable by context_fetch.
 */
const LIST_MAX_VALUES = 40;

function listLine(label: string, values: readonly string[]): string | null {
  if (values.length === 0) return null;
  const shown = values.slice(0, LIST_MAX_VALUES);
  const more = values.length - shown.length;
  return `${label}: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/**
 * A Zone B summary block. The §8 rehydration pointers (files, symbols, tests,
 * artifacts, open questions, covered node ids) are rendered, not just the prose:
 * they are what lets the model notice it needs `context_fetch` at all (§9).
 */
export function renderSummaryBlock(node: TreeNode, summary: NodeSummary, isRoot: boolean): string {
  // No seq range here, deliberately: `span_end_seq` grows on every append to
  // the newest branch, and a volatile bit in a Zone B heading re-writes the
  // whole B segment each turn (the assembler's own "no per-block volatile
  // bits" rule — measured live as a ~2k cacheWrite every turn with cacheRead
  // pinned at Zone A). Seq coordinates stay reachable via `fetchable nodes`
  // and Zone C's active header, both outside the cached prefix.
  const heading = isRoot
    ? `# Task: ${node.title}`
    : `## Branch: ${node.title}${node.phase_type === null ? '' : ` [${node.phase_type}]`} (${node.status})`;

  const lines: (string | null)[] = [
    heading,
    summary.text.trim(),
    listLine('files', summary.meta.files.map(spanLabel)),
    listLine('symbols', summary.meta.symbols),
    listLine(
      'tests',
      summary.meta.tests.map((t) => `${t.name}=${t.status}`),
    ),
    listLine(
      'artifacts',
      summary.meta.artifacts.map((a) => `${a.kind} ${a.ref}`),
    ),
    listLine('decisions', summary.meta.decisions),
    listLine('open questions', summary.meta.open_questions),
    listLine('fetchable nodes', summary.meta.node_ids),
  ];
  return lines.filter((line): line is string => line !== null && line !== '').join('\n');
}

/**
 * D10 lateral links, rendered as their own block so that adding a link changes a
 * block id (`B:links:<node>:<count>`) instead of silently mutating the summary
 * block's text under a stable id — §17's cache assertions key on ids.
 */
export function renderLinksBlock(node: TreeNode, links: readonly NodeLink[]): string {
  const rendered = links.map((link) => `${link.kind} -> ${link.to_id}`);
  return `links from "${node.title}": ${rendered.join(', ')}`;
}

/**
 * The Zone C header: what got expanded, so the model can tell breadth from depth.
 * Same volatile-bit rule as the Zone B heading: the active branch's span extends
 * on every append, and this block is Zone C's FIRST — a seq range here rewrites
 * the whole zone each turn, which defeats any caching of Zone C's append-only
 * event stream. The events themselves carry their seq numbers. The descendant
 * map lives in its own block (`renderActiveMap`) at the END of the zone for the
 * same reason: every file edit grows it, and churn ahead of stable bytes voids
 * their cache (measured: iter8-rep1 re-wrote 10–16k tokens/turn, cacheRead
 * pinned at the A+B prefix, exactly while edits were landing).
 */
export function renderActiveHeader(active: TreeNode): string {
  return `## Active branch (expanded in full): ${active.title}${active.phase_type === null ? '' : ` [${active.phase_type}]`} (${active.status})`;
}

/**
 * The descendant map of the active branch, rendered after the event stream so
 * its per-edit churn never invalidates the cached events before it. Seq ranges
 * here are fine — this block is expected to change and is never cached.
 */
export function renderActiveMap(descendants: readonly TreeNode[]): string {
  const lines = ['## Expanded above — descendant index'];
  for (const node of descendants) {
    const path = typeof node.meta_json.path === 'string' ? ` ${node.meta_json.path}` : '';
    lines.push(`- ${node.kind}${path} "${node.title}" (${seqRange(node)})`);
  }
  return lines.join('\n');
}

/**
 * One L0 event as raw Zone C detail. L1 holds coordinates only (§6), so the
 * payload is always a blob read; a missing blob throws out of `blobs.get*`
 * rather than yielding a plausible-looking empty block.
 */
/**
 * Max rendered args bytes when a post-state blob is also present (v5.9b).
 *
 * Exported because the SAME rule has to hold wherever an event is rendered.
 * It did not: `retrieve/detail.ts` rendered `context_fetch` results with
 * uncapped args, so a write's content appeared twice — once JSON-escaped in the
 * args and once raw in the post-state — in exactly the payload the model reads
 * back. Measured on the frozen store: 6 of 754 events carry a byte-identical
 * duplicate that way, and it is a material part of why one branch tokenizes
 * larger than the window it is read into. One rule, one constant, both callers.
 */
export const ARGS_CAP_WITH_BLOB = 512;

export function renderEvent(event: TraceEvent, blobs: BlobStore): string {
  switch (event.type) {
    case 'user_message':
      return `### user (seq ${event.seq})\n${blobs.getText(event.blob)}`;
    case 'assistant_message':
      return `### assistant (seq ${event.seq})\n${blobs.getText(event.blob)}`;
    case 'tool_call': {
      const target = event.path === undefined ? '' : ` ${event.path}`;
      const lines = [`### tool_call ${event.tool}${target} (seq ${event.seq})`];
      // v5.9b: when a post-state blob exists, args render CAPPED — a
      // write_file's args carry the whole file a second time, and that
      // duplicate rode through every cache write (1.25x) and read (0.1x/turn)
      // of the zone. Dropping args entirely went too far (measured: sw-1
      // turns 13 → 25 — an edit_file's args are the model's only record of
      // WHAT it changed; the post-state alone forces re-verification). The
      // cap keeps intent visible and kills the kilobyte-scale duplication,
      // one rule, no tool special-casing.
      if (event.args_blob !== undefined) {
        const args = blobs.getText(event.args_blob);
        lines.push(
          event.blob !== undefined && args.length > ARGS_CAP_WITH_BLOB
            ? `args: ${args.slice(0, safeCut(args, ARGS_CAP_WITH_BLOB))}${elision(args.length - safeCut(args, ARGS_CAP_WITH_BLOB))}`
            : `args: ${args}`,
        );
      }
      if (event.blob !== undefined) lines.push(blobs.getText(event.blob));
      return lines.join('\n');
    }
    case 'tool_result': {
      const flags = [
        event.error === undefined ? null : `error: ${event.error}`,
        event.truncated === true ? 'truncated by host' : null,
      ].filter((f): f is string => f !== null);
      const suffix = flags.length === 0 ? '' : ` [${flags.join('; ')}]`;
      const head = `### tool_result for seq ${event.call_seq} (seq ${event.seq})${suffix}`;
      return event.output_blob === undefined ? head : `${head}\n${blobs.getText(event.output_blob)}`;
    }
    case 'segment_boundary':
      return `### phase boundary ${event.from ?? 'none'} -> ${event.to} (seq ${event.seq})`;
    case 'manual_annotation':
      return `### annotation (seq ${event.seq})\n${blobs.getText(event.blob)}`;
  }
}

/** A tail block — `context_fetch` / `context_search` / `context_peek` output. */
export function renderTailBlock(id: string, text: string, ephemeral: boolean): string {
  return `## retrieved: ${id}${ephemeral ? ' (dropped at the next phase boundary)' : ''}\n${text}`;
}

const BARE_ELISION = '...';

export function elision(dropped: number): string {
  return `\n...[${dropped} chars elided - call \`context_fetch\` for the full detail]`;
}

/** Never split a surrogate pair — a lone half is not valid text to send. */
export function safeCut(text: string, at: number): number {
  const clamped = Math.max(0, Math.min(at, text.length));
  if (clamped <= 0 || clamped >= text.length) return clamped;
  const code = text.charCodeAt(clamped - 1);
  return code >= 0xd800 && code <= 0xdbff ? clamped - 1 : clamped;
}

/**
 * Shrinks `text` to at most `maxTokens` under `tokenizer`, keeping the head and
 * saying loudly how much went missing. Truncation is deliberately visible in the
 * text: §10 rule 4's Zone C overflow is supposed to push the model toward a
 * narrow `context_fetch`, which it cannot do if the loss is invisible.
 */
export function truncateToTokens(text: string, maxTokens: number, tokenizer: Tokenizer): string {
  if (tokenizer.count(text) <= maxTokens) return text;
  // The marker's own cost is reserved against the longest form it can take
  // (the full length as the elided count), so the result never exceeds maxTokens.
  const bodyBudget = maxTokens - tokenizer.count(elision(text.length));
  if (bodyBudget <= 0) {
    // A cap this small drops the block in all but name. The `<= maxTokens`
    // guarantee is what makes Zone C's water-filling cap actually hold, so the
    // marker degrades to the cheapest thing that still says content was here.
    return tokenizer.count(BARE_ELISION) <= maxTokens ? BARE_ELISION : '';
  }

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tokenizer.count(text.slice(0, safeCut(text, mid))) <= bodyBudget) lo = mid;
    else hi = mid - 1;
  }
  const cut = safeCut(text, lo);
  return text.slice(0, cut) + elision(text.length - cut);
}
