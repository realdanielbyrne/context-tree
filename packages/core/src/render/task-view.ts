/**
 * L4 — the generated markdown view of one task (§6).
 *
 * One document per task: an indented outline of branches carrying their current
 * summaries, spans and lateral links. L4 is a *render* of L1 (D8), so it is
 * regenerated and diffed, never hand-edited — which makes byte-determinism a
 * hard requirement here, not a nicety: no clock, no created_at, no iteration
 * over an unordered collection. Every ordering comes from the store's
 * creation-order queries.
 *
 * Two consumers: humans reviewing the tree, and the agent itself on a host with
 * no MCP support, where this file is simply readable context. The second
 * consumer is why the summary's rehydration pointers (§8) are rendered as
 * scannable bullets rather than a JSON blob.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StoreInvariantError } from '../contracts/index.js';
import type {
  ExternalArtifact,
  NodeId,
  SummaryMeta,
  SymbolSpan,
  TestOutcome,
  TreeNode,
  TreeStore,
} from '../contracts/index.js';
import { escapeBlock, oneLine } from './markdown.js';

/** §6: "generated from L1 — never edited by hand". The file says so itself. */
export const VIEW_BANNER =
  '<!-- L4 view: generated from L1 (D8). Regenerate it; edits here are lost on the next rebuild. -->';

/** §18: a view that hides staleness feeds the "stale summary misleads resumption" risk. */
const NO_SUMMARY = '(no summary yet)';

/** Markdown has six heading levels; deeper nodes reuse the sixth. */
const MAX_HEADING_LEVEL = 6;

export interface RenderOptions {
  /**
   * Heading level of the root node; each level of depth adds one. Defaults to
   * 1 — pass a deeper level to nest the view under a host document's heading.
   */
  rootHeadingLevel?: number;
}

/**
 * Renders the task rooted at `rootId` (default `store.root()`) — depth-first in
 * creation order, one heading level per depth.
 *
 * `rootId` is the task id: §19 Q3 fixes one SQLite DB per task, so the task's
 * identity *is* its root node id.
 */
export function renderTask(store: TreeStore, rootId?: NodeId, opts: RenderOptions = {}): string {
  const root = resolveRoot(store, rootId);
  const rootLevel = opts.rootHeadingLevel ?? 1;
  const blocks: string[] = [heading(rootLevel, root.title), VIEW_BANNER];

  const walk = (node: TreeNode, level: number): void => {
    if (node.id !== root.id) blocks.push(heading(level, node.title));
    blocks.push(...nodeBlocks(store, node));
    // children() is creation-ordered (span_start_seq, id), which is the order
    // §10 rule 1 uses for summaries too — the view mirrors what the model sees.
    for (const child of store.children(node.id)) walk(child, level + 1);
  };
  walk(root, rootLevel);

  return `${blocks.join('\n\n')}\n`;
}

/** Writes `<viewsDir>/<rootId>.md` and returns the path. */
export function writeTaskView(store: TreeStore, viewsDir: string, rootId?: NodeId): string {
  const root = resolveRoot(store, rootId);
  const path = join(viewsDir, `${root.id}.md`);
  mkdirSync(viewsDir, { recursive: true });
  writeFileSync(path, renderTask(store, root.id), 'utf8');
  return path;
}

function resolveRoot(store: TreeStore, rootId?: NodeId): TreeNode {
  if (rootId === undefined) {
    const root = store.root();
    if (root === null) throw new StoreInvariantError('nothing to render: L1 has no task root');
    return root;
  }
  const node = store.getNode(rootId);
  if (node === null) throw new StoreInvariantError(`nothing to render: unknown node ${rootId}`);
  return node;
}

function heading(level: number, title: string): string {
  return `${'#'.repeat(Math.min(Math.max(level, 1), MAX_HEADING_LEVEL))} ${oneLine(title)}`;
}

/** The body of one node: facts, summary text, pointers, links. */
function nodeBlocks(store: TreeStore, node: TreeNode): string[] {
  const summary = store.currentSummary(node.id);
  const blocks = [factsLine(node, summary?.version ?? null)];
  // A summary-less node still renders: omitting it would make the outline lie
  // about the tree's shape, and unsummarized branches are exactly the ones a
  // resuming agent must not assume were covered.
  blocks.push(summary === null ? NO_SUMMARY : escapeBlock(summary.text));

  const bullets = [...(summary === null ? [] : metaBullets(summary.meta)), ...linkBullets(store, node.id)];
  if (bullets.length > 0) blocks.push(bullets.join('\n'));
  return blocks;
}

function factsLine(node: TreeNode, summaryVersion: number | null): string {
  const parts = [`\`${node.id}\``, kindLabel(node)];
  // A file node's title is the basename (§7), so two `index.ts` nodes are
  // indistinguishable without the path — and the path is half of a fetch
  // coordinate (D9).
  const path = node.meta_json.path;
  if (typeof path === 'string' && path !== oneLine(node.title)) parts.push(`\`${path}\``);
  parts.push(seqSpan(node), node.status);
  if (summaryVersion !== null) parts.push(`summary v${summaryVersion}`);
  // Bold because §18 names stale summaries misleading resumption as a top risk:
  // the marker has to be unmissable in a document read as prose.
  if (node.stale_since_seq !== null) parts.push(`**stale since seq ${node.stale_since_seq}**`);
  return parts.join(' · ');
}

function kindLabel(node: TreeNode): string {
  return node.phase_type === null ? node.kind : `${node.kind}/${node.phase_type}`;
}

/** The node's L0 coordinates (§6): the only content L1 holds about it. */
function seqSpan(node: TreeNode): string {
  const { span_start_seq: start, span_end_seq: end } = node;
  if (start === null && end === null) return 'seq unset';
  // An open node's end is genuinely not known yet; showing its start as its end
  // would understate what the branch covers.
  if (start === null) return `seq …-${end}`;
  if (end === null) return `seq ${start}-…`;
  return `seq ${start}-${end}`;
}

/**
 * The §8 rehydration pointers, one bullet per populated field. Empty fields are
 * dropped rather than rendered empty — "files: none" is noise a reader has to
 * skip on every node.
 */
function metaBullets(meta: SummaryMeta): string[] {
  const bullets: string[] = [];
  if (meta.files.length > 0) bullets.push(bulletList('files', meta.files.map(formatSpan)));
  if (meta.symbols.length > 0) bullets.push(`- symbols: ${meta.symbols.map(inlineCode).join(', ')}`);
  if (meta.tests.length > 0) bullets.push(bulletList('tests', meta.tests.map(formatTest)));
  if (meta.artifacts.length > 0) bullets.push(bulletList('artifacts', meta.artifacts.map(formatArtifact)));
  if (meta.open_questions.length > 0) bullets.push(bulletList('open questions', meta.open_questions.map(oneLine)));
  if (meta.decisions.length > 0) bullets.push(bulletList('decisions', meta.decisions.map(oneLine)));
  // The fetch targets: what `context_fetch` should be called with (§9).
  if (meta.node_ids.length > 0) bullets.push(`- covers: ${meta.node_ids.map(inlineCode).join(', ')}`);
  return bullets;
}

function bulletList(label: string, items: readonly string[]): string {
  return [`- ${label}:`, ...items.map((item) => `  - ${item}`)].join('\n');
}

function inlineCode(text: string): string {
  return `\`${oneLine(text)}\``;
}

/** `pricing.go:142-168` — the exact-span form D9 exists to make trustworthy. */
function formatSpan(span: SymbolSpan): string {
  const parts = [`\`${span.path}:${span.start_line}-${span.end_line}\``];
  if (span.symbol !== undefined) parts.push(oneLine(span.symbol));
  if (span.kind !== undefined) parts.push(`(${oneLine(span.kind)})`);
  // §12: a degraded span is a raw diff hunk, not a symbol boundary. Saying so is
  // what keeps the pointer honest instead of merely precise-looking.
  if (span.degraded === true) parts.push('(diff hunk, no grammar)');
  return parts.join(' ');
}

function formatTest(test: TestOutcome): string {
  const head = `${test.status} — ${oneLine(test.name)}`;
  return test.detail === undefined ? head : `${head}: ${oneLine(test.detail)}`;
}

function formatArtifact(artifact: ExternalArtifact): string {
  const head = `${artifact.kind} ${oneLine(artifact.ref)}`;
  return artifact.title === undefined ? head : `${head} — ${oneLine(artifact.title)}`;
}

/**
 * D10 lateral edges, rendered under both endpoints: a link is only useful if the
 * node you happen to be reading shows it, and a tree view is otherwise blind to
 * exactly the relations links exist to record.
 */
function linkBullets(store: TreeStore, id: NodeId): string[] {
  const items = [
    ...store.linksFrom(id).map((link) => `-> ${link.kind} ${labelFor(store, link.to_id)}`),
    ...store.linksTo(id).map((link) => `<- ${link.kind} ${labelFor(store, link.from_id)}`),
  ];
  return items.length === 0 ? [] : [bulletList('links', items)];
}

/** A bare ULID means nothing to the human consumer; the title does. */
function labelFor(store: TreeStore, id: NodeId): string {
  const node = store.getNode(id);
  return node === null ? id : `${id} (${oneLine(node.title)})`;
}
