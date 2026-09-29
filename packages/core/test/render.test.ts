import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SummaryMeta, TreeNode } from '../src/contracts/index.js';
import { openInMemoryStore, type SqliteTreeStore } from '../src/store/index.js';
import { renderTask, writeTaskView } from '../src/render/index.js';

function summaryMeta(overrides: Partial<SummaryMeta> = {}): SummaryMeta {
  return {
    files: [],
    symbols: [],
    tests: [],
    artifacts: [],
    open_questions: [],
    decisions: [],
    node_ids: [],
    ...overrides,
  };
}

/**
 * Three levels — task -> phase -> file — twice over, which is the minimum shape
 * that can distinguish depth-first creation order from any other traversal.
 * `p2` is deliberately left summary-less and open.
 */
interface Fixture {
  store: SqliteTreeStore;
  root: TreeNode;
  p1: TreeNode;
  f1: TreeNode;
  p2: TreeNode;
  f2: TreeNode;
}

function fixture(): Fixture {
  const store = openInMemoryStore();
  const root = store.insertNode({
    parent_id: null,
    kind: 'task',
    title: 'fix pricing',
    span_start_seq: 1,
    span_end_seq: 42,
    status: 'closed',
  });
  const p1 = store.insertNode({
    parent_id: root.id,
    kind: 'phase',
    title: 'diagnosis',
    phase_type: 'diagnosis',
    span_start_seq: 2,
    span_end_seq: 9,
    status: 'closed',
  });
  const f1 = store.insertNode({
    parent_id: p1.id,
    kind: 'file',
    title: 'pricing.go',
    span_start_seq: 3,
    span_end_seq: 8,
    status: 'closed',
    meta_json: { path: 'pricing.go' },
  });
  const p2 = store.insertNode({
    parent_id: root.id,
    kind: 'phase',
    title: 'implementation',
    phase_type: 'implementation',
    span_start_seq: 10,
  });
  const f2 = store.insertNode({
    parent_id: p2.id,
    kind: 'file',
    title: 'billing.go',
    span_start_seq: 11,
    span_end_seq: 20,
    meta_json: { path: 'billing.go' },
  });

  store.putSummary({
    node_id: root.id,
    model: 'strong-model',
    text: 'Pricing rounding was wrong for discounted line items.',
    meta: summaryMeta({ node_ids: [p1.id, p2.id] }),
  });
  store.putSummary({
    node_id: p1.id,
    model: 'cheap-model',
    text: 'Traced the rounding bug to calculatePrice.',
    meta: summaryMeta({
      files: [
        { path: 'pricing.go', start_line: 142, end_line: 168, symbol: 'calculatePrice', kind: 'function_declaration' },
        { path: 'billing.go', start_line: 10, end_line: 12, degraded: true },
      ],
      symbols: ['calculatePrice', 'applyDiscount'],
      tests: [
        { name: 'TestPricing', status: 'passed' },
        { name: 'TestBilling', status: 'failed', detail: 'expected 10.05 got 10.04' },
      ],
      artifacts: [
        { kind: 'ticket', ref: 'SOF-123', title: 'Rounding off by a cent' },
        { kind: 'pr', ref: '#45' },
        { kind: 'url', ref: 'https://example.test/spec' },
      ],
      open_questions: ['is banker-rounding the right default?'],
      decisions: ['round half-up at the line-item level'],
      node_ids: [f1.id],
    }),
  });
  store.putSummary({
    node_id: f1.id,
    model: 'cheap-model',
    text: 'calculatePrice truncates instead of rounding.',
    meta: summaryMeta(),
  });

  return { store, root, p1, f1, p2, f2 };
}

/** The lines of the node block that starts at `id`'s facts line, up to the next heading. */
function blockFor(md: string, id: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`\`${id}\``));
  expect(start, `no facts line for ${id}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6} /.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

describe('renderTask', () => {
  it('emits every node depth-first in creation order, one heading level per depth, because L4 must not lie about the shape of the tree (§6)', () => {
    const { store, root, p1, f1, p2, f2 } = fixture();
    const md = renderTask(store);

    expect(md.split('\n').filter((line) => /^#{1,6} /.test(line))).toEqual([
      '# fix pricing',
      '## diagnosis',
      '### pricing.go',
      '## implementation',
      '### billing.go',
    ]);
    // Depth-first: f1 (under p1) precedes p2, which a breadth-first walk reverses.
    const factsLineIds = md
      .split('\n')
      .map((line) => /^`(n_[^`]+)`/.exec(line)?.[1])
      .filter((id): id is string => id !== undefined);
    expect(factsLineIds).toEqual([root.id, p1.id, f1.id, p2.id, f2.id]);
  });

  it('renders kind, phase type, status and the L0 span for each node, because the span is the only content L1 holds (§6)', () => {
    const { store, root, p1, p2 } = fixture();
    const md = renderTask(store);

    expect(blockFor(md, root.id)).toContain('task · seq 1-42 · closed');
    expect(blockFor(md, p1.id)).toContain('phase/diagnosis · seq 2-9 · closed');
    // An open phase has no end seq yet; claiming one would overstate coverage.
    expect(blockFor(md, p2.id)).toContain('phase/implementation · seq 10-… · open');
  });

  it('renders every summary-metadata field as scannable text, because those rehydration pointers are the whole value of the view to an agent (§8)', () => {
    const { store, p1, f1 } = fixture();
    const block = blockFor(renderTask(store), p1.id);

    expect(block).toContain('Traced the rounding bug to calculatePrice.');
    // Exact spans in the D9 form, not a JSON blob.
    expect(block).toContain('`pricing.go:142-168` calculatePrice (function_declaration)');
    expect(block).toContain('`billing.go:10-12` (diff hunk, no grammar)');
    expect(block).toContain('- symbols: `calculatePrice`, `applyDiscount`');
    expect(block).toContain('passed — TestPricing');
    expect(block).toContain('failed — TestBilling: expected 10.05 got 10.04');
    expect(block).toContain('ticket SOF-123 — Rounding off by a cent');
    expect(block).toContain('pr #45');
    expect(block).toContain('url https://example.test/spec');
    expect(block).toContain('is banker-rounding the right default?');
    expect(block).toContain('round half-up at the line-item level');
    // meta.node_ids are the `fetch` targets (§9).
    expect(block).toContain(`- covers: \`${f1.id}\``);
  });

  it('omits metadata fields that are empty, because "files: none" on every node is noise a reader must skip', () => {
    const { store, f1 } = fixture();
    const block = blockFor(renderTask(store), f1.id);

    expect(block).toContain('calculatePrice truncates instead of rounding.');
    expect(block).not.toContain('- files:');
    expect(block).not.toContain('- symbols:');
  });

  it('shows a file node full path when its basename title would be ambiguous, because the path is half of a fetch coordinate (D9)', () => {
    const { store, p2 } = fixture();
    const deep = store.insertNode({
      parent_id: p2.id,
      kind: 'file',
      title: 'index.ts',
      span_start_seq: 12,
      span_end_seq: 12,
      meta_json: { path: 'src/deep/index.ts' },
    });
    const md = renderTask(store);

    expect(blockFor(md, deep.id)).toContain('`src/deep/index.ts`');
    // pricing.go's title already is its path; repeating it would be noise.
    expect(md).not.toContain('file · `pricing.go`');
  });

  it('marks a stale node visibly, because §18 lists stale summaries misleading resumption as a top risk', () => {
    const { store, p1, f1 } = fixture();
    store.markStale(f1.id, 18);
    const md = renderTask(store);

    expect(blockFor(md, f1.id)).toContain('stale since seq 18');
    // A view that marked everything stale would be as useless as one that marked
    // nothing: the marker must track the node the store actually flagged.
    expect(blockFor(md, p1.id)).not.toContain('stale since');
  });

  it('renders the current summary version, because D3 keeps every version and the view must say which one it shows', () => {
    const { store, f1 } = fixture();
    store.putSummary({
      node_id: f1.id,
      model: 'cheap-model',
      text: 'calculatePrice now rounds half-up.',
      meta: summaryMeta(),
    });
    const block = blockFor(renderTask(store), f1.id);

    expect(block).toContain('summary v2');
    expect(block).toContain('calculatePrice now rounds half-up.');
    expect(block).not.toContain('truncates instead of rounding');
  });

  it('renders a summary-less node with an explicit marker instead of dropping it, because a missing branch reads as a covered one', () => {
    const { store, p2 } = fixture();
    const md = renderTask(store);

    expect(md).toContain('## implementation');
    expect(blockFor(md, p2.id)).toContain('(no summary yet)');
  });

  it('renders lateral links under both endpoints (D10), because a pure tree is blind to exactly the relations links record', () => {
    const { store, p1, p2 } = fixture();
    store.putLink({ from_id: p1.id, to_id: p2.id, kind: 'superseded_by' });
    store.putLink({ from_id: p2.id, to_id: p1.id, kind: 'relates_to' });
    const md = renderTask(store);

    expect(blockFor(md, p1.id)).toContain(`-> superseded_by ${p2.id} (implementation)`);
    expect(blockFor(md, p1.id)).toContain(`<- relates_to ${p2.id} (implementation)`);
    expect(blockFor(md, p2.id)).toContain(`<- superseded_by ${p1.id} (diagnosis)`);
    expect(blockFor(md, p2.id)).toContain(`-> relates_to ${p1.id} (diagnosis)`);
  });

  it('is byte-identical for identical L1 state and leaks no timestamp, because L4 is regenerated and diffed (D8)', () => {
    const { store, p1, p2 } = fixture();
    store.putLink({ from_id: p1.id, to_id: p2.id, kind: 'blocks' });

    expect(renderTask(store)).toBe(renderTask(store));
    // created_at / Date.now() in the output would make every regeneration a diff.
    expect(renderTask(store)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('defaults to store.root(), because §19 Q3 makes the task id the root node id', () => {
    const { store, root } = fixture();
    expect(renderTask(store)).toBe(renderTask(store, root.id));
  });

  it('neutralizes summary markdown that would forge a heading or swallow the outline, because the outline is structure the view owns', () => {
    const { store, f1 } = fixture();
    store.putSummary({
      node_id: f1.id,
      model: 'cheap-model',
      text: [
        '## Findings',
        '```go',
        'func calculatePrice() {}',
        '```',
        '<!-- hidden',
        '---',
      ].join('\n'),
      meta: summaryMeta(),
    });
    const md = renderTask(store);

    // The only headings left are the five node headings.
    expect(md.split('\n').filter((line) => /^#{1,6} /.test(line))).toHaveLength(5);
    expect(md).toContain('\\## Findings');
    expect(md).toContain('\\```go');
    expect(md).toContain('\\<!-- hidden');
    expect(md).toContain('\\---');
    // Escaped, not stripped: the agent-readable consumer still gets the text.
    expect(md).toContain('func calculatePrice() {}');
  });

  it('collapses a multi-line title to one line, because a newline in a heading splits the outline', () => {
    const store = openInMemoryStore();
    store.insertNode({ parent_id: null, kind: 'task', title: 'fix\npricing\n# bogus', span_start_seq: 1 });

    expect(renderTask(store)).toContain('# fix pricing # bogus\n');
    expect(renderTask(store).split('\n').filter((line) => /^#{1,6} /.test(line))).toHaveLength(1);
  });

  it('throws instead of rendering an empty document when L1 has no task root', () => {
    expect(() => renderTask(openInMemoryStore())).toThrow(/no task root/);
  });
});

describe('writeTaskView', () => {
  it('writes <rootId>.md under viewsDir, creating it, because L4 is a file the host reads when it has no MCP (§6)', () => {
    const { store, root } = fixture();
    const viewsDir = join(mkdtempSync(join(tmpdir(), 'ct-render-')), 'views');
    expect(existsSync(viewsDir)).toBe(false);

    const path = writeTaskView(store, viewsDir);

    expect(path).toBe(join(viewsDir, `${root.id}.md`));
    expect(readFileSync(path, 'utf8')).toBe(renderTask(store, root.id));
  });
});
