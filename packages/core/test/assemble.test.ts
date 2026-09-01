/**
 * §10 prompt assembly (D5) — and, per §17, the only place a D5 regression will
 * surface at all.
 *
 * What these tests defend: provider caches are keyed on a *prefix*. Every
 * assertion below is ultimately about whether a given event moved bytes that
 * precede a cache breakpoint. A test that only checked "the prompt contains the
 * right text" would pass while the session silently paid full price on every
 * turn, so the assertions are on block ids and token counts, not prose.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoreInvariantError } from '../src/contracts/index.js';
import type {
  AssembledPrompt,
  NodeStatus,
  PhaseType,
  PromptBlock,
  SummaryMeta,
  TreeNode,
  Zone,
} from '../src/contracts/index.js';
import { FsBlobStore } from '../src/blobs/index.js';
import { JsonlTraceLog } from '../src/trace/index.js';
import { openInMemoryStore, type SqliteTreeStore } from '../src/store/index.js';
import { HeuristicTokenizer } from '../src/tokens/index.js';
import {
  ZoneAssembler,
  toCompletionRequest,
  toMessages,
  truncateToTokens,
} from '../src/assemble/index.js';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from '../src/models/index.js';
import type { AnthropicClientLike, AnthropicMessageLike } from '../src/models/index.js';

/** Frozen Zone A stand-ins: the real ones come from `src/prompts/` (§14.1). */
const SYSTEM = 'CONTEXT-TREE CONTRACT\nFetch before you edit.\nPeek when in doubt.';
const TOOL_SCHEMAS = '{"tools":["context_fetch","context_search","context_peek","annotate"]}';
const TS = '2026-01-01T00:00:00.000Z';

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

interface BranchSpec {
  title: string;
  phase: PhaseType;
  status?: NodeStatus;
  /** Post-edit blob content — the bulk of Zone C detail. */
  detail?: string;
  /** `null` models an open/just-closed phase whose backgrounded summary (D11)
   *  has not landed yet — the common case, and the one rule 2 depends on. */
  summary?: string | null;
}

const dirs: string[] = [];
const stores: SqliteTreeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(rootSummary: string | null = 'the task is to fix pricing rounding') {
  const dir = mkdtempSync(join(tmpdir(), 'ct-assemble-'));
  dirs.push(dir);
  const store = openInMemoryStore();
  stores.push(store);
  const blobs = new FsBlobStore(join(dir, 'blobs'));
  const trace = new JsonlTraceLog(join(dir, 'trace.jsonl'));
  const tokenizer = new HeuristicTokenizer();

  const root = store.insertNode({
    parent_id: null,
    kind: 'task',
    title: 'fix pricing rounding',
    span_start_seq: 1,
    span_end_seq: 1,
  });
  if (rootSummary !== null) {
    store.putSummary({
      node_id: root.id,
      model: 'mock-root',
      text: rootSummary,
      meta: summaryMeta({ node_ids: [root.id] }),
    });
  }

  /** Appends one phase's L0 events plus the L1 phase + file nodes covering them. */
  function addBranch(spec: BranchSpec): TreeNode {
    const path = `src/${spec.phase}.ts`;
    const start = trace.lastSeq() + 1;
    trace.append({ type: 'user_message', ts: TS, blob: blobs.put(`please ${spec.title}`) });
    trace.append({ type: 'assistant_message', ts: TS, blob: blobs.put(`starting ${spec.title}`) });
    const call = trace.append({
      type: 'tool_call',
      ts: TS,
      tool: 'Edit',
      path,
      blob: blobs.put(spec.detail ?? `post-edit content for ${spec.title}`),
    });
    trace.append({
      type: 'tool_result',
      ts: TS,
      call_seq: call.seq,
      output_blob: blobs.put(`applied ${spec.title}`),
    });
    const end = trace.lastSeq();

    const node = store.insertNode({
      parent_id: root.id,
      kind: 'phase',
      title: spec.title,
      phase_type: spec.phase,
      span_start_seq: start,
      span_end_seq: end,
      status: spec.status ?? 'closed',
    });
    store.insertNode({
      parent_id: node.id,
      kind: 'file',
      title: path,
      span_start_seq: call.seq,
      span_end_seq: call.seq,
      meta_json: { path },
    });
    store.updateNode(root.id, { span_end_seq: end });
    if (spec.summary !== null) {
      store.putSummary({
        node_id: node.id,
        model: 'mock-leaf',
        text: spec.summary ?? `${spec.title}: what happened here`,
        meta: summaryMeta({
          node_ids: [node.id],
          files: [{ path, start_line: 1, end_line: 12, symbol: 'priceOf' }],
        }),
      });
    }
    return node;
  }

  const assembler = new ZoneAssembler({ store, blobs, trace, tokenizer, systemContract: SYSTEM });
  return { dir, store, blobs, trace, tokenizer, root, addBranch, assembler };
}

function inZone(prompt: AssembledPrompt, zone: Zone): PromptBlock[] {
  return prompt.blocks.filter((block) => block.zone === zone);
}

function ids(blocks: readonly PromptBlock[]): string[] {
  return blocks.map((block) => block.id);
}

function tokens(blocks: readonly PromptBlock[]): number[] {
  return blocks.map((block) => block.tokens);
}

describe('Zone A (frozen prefix)', () => {
  it('is byte-identical across turns even after a phase transition, a new summary and a tail append, because any per-turn value in Zone A defeats caching for the whole session', () => {
    const h = harness();
    h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
    const open = h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });

    const first = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });

    // Everything that changes between turns, at once.
    h.store.updateNode(open.id, { status: 'closed' });
    h.store.putSummary({
      node_id: open.id,
      model: 'mock-leaf',
      text: 'patched the rounding',
      meta: summaryMeta({ node_ids: [open.id] }),
    });
    h.addBranch({ title: 'run tests', phase: 'verification', status: 'open', summary: null });
    h.assembler.appendTail({ id: 'f1', text: 'fetched detail', ephemeral: true });
    h.assembler.onPhaseTransition();

    const second = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });

    expect(second.system).toBe(first.system);
    expect(ids(inZone(second, 'A'))).toEqual(['A:system', 'A:tools']);
    expect(inZone(second, 'A').map((b) => b.text)).toEqual(inZone(first, 'A').map((b) => b.text));
    expect(tokens(inZone(second, 'A'))).toEqual(tokens(inZone(first, 'A')));
  });

  it('carries the system contract and tool schemas in `system` and nowhere else, so the models layer never sends the frozen prefix twice', () => {
    const h = harness();
    h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });
    const prompt = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });

    expect(prompt.system).toBe(`${SYSTEM}\n\n${TOOL_SCHEMAS}`);
    for (const message of toMessages(prompt)) {
      expect(message.content).not.toContain(SYSTEM);
      expect(message.content).not.toContain(TOOL_SCHEMAS);
    }
  });
});

describe('M4 acceptance — a phase transition invalidates only the expected token range', () => {
  it('leaves every Zone A and Zone B block id and token count untouched and rewrites only Zone C, which is the entire point of D5', () => {
    const h = harness();
    h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
    h.addBranch({ title: 'patch', phase: 'implementation' });
    const active = h.addBranch({
      title: 'run tests',
      phase: 'verification',
      status: 'open',
      summary: null,
    });

    const before = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });

    // The transition itself: close the active phase, open the next one. Its
    // summary is backgrounded (D11) and has not landed yet.
    h.store.updateNode(active.id, { status: 'closed' });
    const next = h.addBranch({ title: 'open PR', phase: 'delivery', status: 'open', summary: null });
    h.assembler.onPhaseTransition();

    const after = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });

    expect(ids(inZone(after, 'A'))).toEqual(ids(inZone(before, 'A')));
    expect(tokens(inZone(after, 'A'))).toEqual(tokens(inZone(before, 'A')));
    expect(ids(inZone(after, 'B'))).toEqual(ids(inZone(before, 'B')));
    expect(tokens(inZone(after, 'B'))).toEqual(tokens(inZone(before, 'B')));
    expect(after.budgets.zoneA).toBe(before.budgets.zoneA);
    expect(after.budgets.zoneB).toBe(before.budgets.zoneB);
    expect(after.cacheBreakpoints).toEqual(before.cacheBreakpoints);

    // Zone C is the only zone that moved, and it now points at the new branch.
    expect(ids(inZone(after, 'C'))).not.toEqual(ids(inZone(before, 'C')));
    expect(ids(inZone(after, 'C'))[0]).toBe(`C:head:${next.id}`);
    expect(ids(inZone(before, 'C'))[0]).toBe(`C:head:${active.id}`);
  });

  it('appends a newly-landed branch summary at the END of Zone B, so the already-cached Zone B prefix survives (rule 2)', () => {
    const h = harness();
    h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
    h.addBranch({ title: 'patch', phase: 'implementation' });
    const active = h.addBranch({
      title: 'run tests',
      phase: 'verification',
      status: 'open',
      summary: null,
    });

    const before = h.assembler.assemble();
    const prefix = inZone(before, 'B');
    expect(prefix.length).toBe(3); // root + two closed branches

    h.store.updateNode(active.id, { status: 'closed' });
    h.store.putSummary({
      node_id: active.id,
      model: 'mock-leaf',
      text: '3 tests failed, then passed',
      meta: summaryMeta({ node_ids: [active.id] }),
    });
    h.addBranch({ title: 'open PR', phase: 'delivery', status: 'open', summary: null });

    const after = inZone(h.assembler.assemble(), 'B');
    expect(after.length).toBe(4);
    expect(ids(after.slice(0, 3))).toEqual(ids(prefix));
    expect(tokens(after.slice(0, 3))).toEqual(tokens(prefix));
    expect(ids(after)[3]).toBe(`B:summary:${active.id}:1`);
  });
});

describe('Zone B ordering (rule 1)', () => {
  it('emits the task root first and then branch summaries in creation order, never relevance order, because reordering the prefix is the cache killer', () => {
    const h = harness();
    const b1 = h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
    const b2 = h.addBranch({ title: 'patch', phase: 'implementation', detail: 'x'.repeat(4_000) });
    const b3 = h.addBranch({ title: 'run tests', phase: 'verification' });

    const zoneB = inZone(h.assembler.assemble({ activeNodeId: b1.id }), 'B');
    // b2 is by far the largest branch; a relevance- or size-ordered Zone B
    // would hoist it, so asserting creation order here is the guard.
    expect(zoneB.map((block) => block.nodeId)).toEqual([h.root.id, b2.id, b3.id]);
  });

  it('stays in creation order when the active branch changes, and drops only the active branch block, so promoting or demoting a branch never reorders its neighbours', () => {
    const h = harness();
    const b1 = h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
    const b2 = h.addBranch({ title: 'patch', phase: 'implementation' });
    const b3 = h.addBranch({ title: 'run tests', phase: 'verification' });

    const onB1 = inZone(h.assembler.assemble({ activeNodeId: b1.id }), 'B');
    const onB3 = inZone(h.assembler.assemble({ activeNodeId: b3.id }), 'B');

    expect(onB1.map((block) => block.nodeId)).toEqual([h.root.id, b2.id, b3.id]);
    expect(onB3.map((block) => block.nodeId)).toEqual([h.root.id, b1.id, b2.id]);
    // The blocks that survive both assemblies are byte-for-byte identical.
    const b2OnB1 = onB1.find((block) => block.nodeId === b2.id);
    const b2OnB3 = onB3.find((block) => block.nodeId === b2.id);
    expect(b2OnB3?.id).toBe(b2OnB1?.id);
    expect(b2OnB3?.text).toBe(b2OnB1?.text);
  });

  it('excludes a deep active node by its owning branch, because Zone C already expands that whole branch', () => {
    const h = harness();
    const b1 = h.addBranch({ title: 'patch', phase: 'implementation' });
    const fileNode = h.store.children(b1.id)[0];
    expect(fileNode).toBeDefined();

    const zoneB = inZone(h.assembler.assemble({ activeNodeId: fileNode!.id }), 'B');
    expect(zoneB.map((block) => block.nodeId)).toEqual([h.root.id]);
  });

  it('renders lateral links as their own block whose id changes with the link count, so adding a link can never mutate a summary block under a stable id (D10)', () => {
    const h = harness();
    const b1 = h.addBranch({ title: 'first attempt', phase: 'implementation' });
    const b2 = h.addBranch({ title: 'second attempt', phase: 'implementation' });
    h.addBranch({ title: 'run tests', phase: 'verification', status: 'open', summary: null });

    const before = inZone(h.assembler.assemble(), 'B');
    h.store.putLink({ from_id: b1.id, to_id: b2.id, kind: 'superseded_by' });
    const after = inZone(h.assembler.assemble(), 'B');

    const summaryBlock = (blocks: readonly PromptBlock[]) =>
      blocks.find((block) => block.id === `B:summary:${b1.id}:1`);
    expect(summaryBlock(after)?.text).toBe(summaryBlock(before)?.text);
    expect(ids(before)).not.toContain(`B:links:${b1.id}:1`);
    // Beneath the node it belongs to, not appended to the end of the zone.
    expect(ids(after)).toEqual([
      `B:root:${h.root.id}:1`,
      `B:summary:${b1.id}:1`,
      `B:links:${b1.id}:1`,
      `B:summary:${b2.id}:1`,
    ]);
    expect(after.find((block) => block.id === `B:links:${b1.id}:1`)?.text).toContain(
      `superseded_by -> ${b2.id}`,
    );
  });
});

describe('Zone C (rewritten each phase, rule 2)', () => {
  it('expands the active branch out of L0 through L2 rather than repeating its summary, because L1 holds coordinates and never content', () => {
    const h = harness();
    h.addBranch({ title: 'reproduce', phase: 'diagnosis', summary: 'do not show this in Zone C' });
    const active = h.addBranch({
      title: 'patch',
      phase: 'implementation',
      status: 'open',
      summary: null,
      detail: 'export const rounded = Math.round(x * 100) / 100;',
    });

    const prompt = h.assembler.assemble();
    const zoneC = inZone(prompt, 'C');
    const text = zoneC.map((block) => block.text).join('\n');

    expect(ids(zoneC)[0]).toBe(`C:head:${active.id}`);
    expect(text).toContain('export const rounded = Math.round(x * 100) / 100;');
    expect(text).toContain('please patch'); // the user_message blob
    expect(text).toContain('applied patch'); // this turn's tool_result blob
    expect(text).not.toContain('do not show this in Zone C');
    // One block per L0 event in the branch's span — the finest truncation unit.
    expect(ids(zoneC).slice(1)).toEqual(['C:event:5', 'C:event:6', 'C:event:7', 'C:event:8']);
  });

  it('reads an OPEN branch through to lastSeq so this turn’s tool results appear before the next ingest pass extends the span', () => {
    const h = harness();
    const active = h.addBranch({
      title: 'patch',
      phase: 'implementation',
      status: 'open',
      summary: null,
    });
    const call = h.trace.append({
      type: 'tool_call',
      ts: TS,
      tool: 'Bash',
      args_blob: h.blobs.put('npx vitest run'),
    });
    h.trace.append({
      type: 'tool_result',
      ts: TS,
      call_seq: call.seq,
      output_blob: h.blobs.put('1 failed, 4 passed'),
    });

    // L1 still records the pre-turn span; the events are only in L0.
    expect(h.store.getNode(active.id)?.span_end_seq).toBe(4);
    const text = inZone(h.assembler.assemble(), 'C')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('1 failed, 4 passed');
  });

  it('assembles Zone A alone on an empty tree instead of throwing, because a fresh session has no branches yet', () => {
    const h = harness(null);
    const prompt = h.assembler.assemble();
    expect(ids(prompt.blocks)).toEqual(['A:system']);
    expect(prompt.cacheBreakpoints).toEqual(['A:system']);
    expect(prompt.budgets.zoneB).toBe(0);
    expect(prompt.budgets.zoneC).toBe(0);
  });

  it('throws on an unknown activeNodeId instead of quietly assembling an empty Zone C, which would look exactly like a finished phase', () => {
    const h = harness();
    h.addBranch({ title: 'patch', phase: 'implementation' });
    expect(() => h.assembler.assemble({ activeNodeId: 'n_nope' })).toThrow(StoreInvariantError);
  });
});

describe('budgets (rule 4)', () => {
  it('drops the OLDEST branch summaries first, reports their node ids, and leaves the survivors in creation order — a silent drop is indistinguishable from a summarizer bug', () => {
    const h = harness();
    const b1 = h.addBranch({ title: 'reproduce', phase: 'diagnosis', summary: 'A '.repeat(300) });
    const b2 = h.addBranch({ title: 'patch', phase: 'implementation', summary: 'B '.repeat(300) });
    const b3 = h.addBranch({ title: 'run tests', phase: 'verification', summary: 'C '.repeat(300) });

    const full = h.assembler.assemble();
    expect(full.budgets.droppedFromZoneB).toEqual([]);

    // Exactly enough room for the task anchor plus the newest branch.
    const sizeOf = (id: string) =>
      full.blocks.find((block) => block.nodeId === id)?.tokens ?? 0;
    const zoneBBudget = sizeOf(h.root.id) + sizeOf(b3.id);

    const squeezed = h.assembler.assemble({ zoneBBudget });
    expect(squeezed.budgets.droppedFromZoneB).toEqual([b1.id, b2.id]);
    expect(inZone(squeezed, 'B').map((block) => block.nodeId)).toEqual([h.root.id, b3.id]);
    expect(squeezed.budgets.zoneB).toBeLessThanOrEqual(zoneBBudget);
    expect(squeezed.budgets.overBudget).not.toContain('B');
  });

  it('never drops the root summary and flags Zone B over budget when dropping every branch is still not enough, because the task anchor is what a resumed session reads first', () => {
    const h = harness('the task is to fix pricing rounding in the billing service');
    h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
    h.addBranch({ title: 'patch', phase: 'implementation' });

    const prompt = h.assembler.assemble({ zoneBBudget: 1 });
    expect(inZone(prompt, 'B').map((block) => block.nodeId)).toEqual([h.root.id]);
    expect(prompt.budgets.droppedFromZoneB.length).toBe(2);
    expect(prompt.budgets.overBudget).toContain('B');
  });

  it('truncates the largest Zone C detail blocks, leaves the small ones byte-identical, and flags the zone, so the overflow pushes the model toward a narrow context_fetch', () => {
    const h = harness();
    h.addBranch({
      title: 'patch',
      phase: 'implementation',
      status: 'open',
      summary: null,
      detail: 'const noise = 1;\n'.repeat(500),
    });

    const untruncated = h.assembler.assemble({ zoneCBudget: 1_000_000 });
    const prompt = h.assembler.assemble({ zoneCBudget: 300 });

    expect(prompt.budgets.overBudget).toContain('C');
    expect(prompt.budgets.zoneC).toBeLessThanOrEqual(300);
    expect(untruncated.budgets.zoneC).toBeGreaterThan(300);

    const big = inZone(prompt, 'C').find((block) => block.id === 'C:event:3');
    expect(big?.text).toContain('elided');
    // Only the oversized block paid: the small blocks are untouched, so a Zone C
    // overflow does not smear loss across detail the model can still afford.
    for (const id of ['C:event:1', 'C:event:2', 'C:event:4']) {
      const small = inZone(prompt, 'C').find((block) => block.id === id);
      const before = inZone(untruncated, 'C').find((block) => block.id === id);
      expect(small?.text).toBe(before?.text);
    }
    // Degradation is zone-local: the cached prefix is not re-cut to make room.
    expect(prompt.budgets.zoneA).toBe(untruncated.budgets.zoneA);
    expect(prompt.budgets.zoneB).toBe(untruncated.budgets.zoneB);
  });

  it('reports zone token sums that add up to `total`, because the cost meter and §17 assertions both read this report rather than recounting', () => {
    const h = harness();
    h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
    h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });
    h.assembler.appendTail({ id: 'f1', text: 'fetched branch detail', ephemeral: true });

    const prompt = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });
    const { budgets } = prompt;
    expect(budgets.total).toBe(budgets.zoneA + budgets.zoneB + budgets.zoneC + budgets.tail);
    for (const zone of ['A', 'B', 'C', 'tail'] as const) {
      const sum = inZone(prompt, zone).reduce((acc, block) => acc + block.tokens, 0);
      expect(sum).toBe(budgets[zone === 'tail' ? 'tail' : (`zone${zone}` as const)]);
    }
  });

  it('truncateToTokens never exceeds the cap it was given, since Zone C’s budget is the only backstop against a multi-megabyte post-edit blob', () => {
    const tokenizer = new HeuristicTokenizer();
    const huge = 'const x = 1;\n'.repeat(20_000);
    for (const cap of [0, 1, 7, 64, 500]) {
      const cut = truncateToTokens(huge, cap, tokenizer);
      expect(tokenizer.count(cut)).toBeLessThanOrEqual(cap);
      expect(cut.length).toBeLessThan(huge.length);
    }
    expect(truncateToTokens('short', 1_000, tokenizer)).toBe('short');
  });
});

describe('tail (rule 3, D6)', () => {
  it('appends a retrieval result strictly after Zone C, changing nothing before it, so a context_fetch never invalidates the cached prefix', () => {
    const h = harness();
    h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
    h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });

    const before = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });
    h.assembler.appendTail({ id: 'fetch:n_1', text: 'the fetched branch detail', ephemeral: true });
    const after = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });

    const nonTail = (prompt: AssembledPrompt) => prompt.blocks.filter((b) => b.zone !== 'tail');
    expect(ids(nonTail(after))).toEqual(ids(nonTail(before)));
    expect(tokens(nonTail(after))).toEqual(tokens(nonTail(before)));
    expect(nonTail(after).map((b) => b.text)).toEqual(nonTail(before).map((b) => b.text));
    expect(after.cacheBreakpoints).toEqual(before.cacheBreakpoints);
    expect(ids(inZone(after, 'tail'))).toEqual(['tail:fetch:n_1']);
    expect(inZone(after, 'tail')[0]?.text).toContain('the fetched branch detail');
  });

  it('drops ephemeral tail entries at a phase boundary and keeps the rest, which is the whole of D6 soft offloading and nothing more', () => {
    const h = harness();
    h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });
    h.assembler.appendTail({ id: 'fetched', text: 'branch detail', ephemeral: true });
    h.assembler.appendTail({ id: 'pinned', text: 'annotation the user pinned', ephemeral: false });

    const before = h.assembler.assemble();
    expect(ids(inZone(before, 'tail'))).toEqual(['tail:fetched', 'tail:pinned']);

    h.assembler.onPhaseTransition();
    const after = h.assembler.assemble();

    expect(ids(inZone(after, 'tail'))).toEqual(['tail:pinned']);
    expect(h.assembler.tailEntries().map((entry) => entry.id)).toEqual(['pinned']);
    // "and nothing else": no L1 write, no re-summarization, no zone rewrite.
    const nonTail = (prompt: AssembledPrompt) => prompt.blocks.filter((b) => b.zone !== 'tail');
    expect(nonTail(after).map((b) => b.text)).toEqual(nonTail(before).map((b) => b.text));
    expect(h.store.staleNodes()).toEqual([]);
  });

  it('honours an explicitly supplied tail in place of the held one, since the MCP layer may own the retrieval buffer', () => {
    const h = harness();
    h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });
    h.assembler.appendTail({ id: 'held', text: 'held entry', ephemeral: true });

    const prompt = h.assembler.assemble({
      tail: [{ id: 'supplied', text: 'supplied entry', ephemeral: false }],
    });
    expect(ids(inZone(prompt, 'tail'))).toEqual(['tail:supplied']);
    expect(h.assembler.tailEntries().map((entry) => entry.id)).toEqual(['held']);
  });
});

describe('cache breakpoints (rule 5)', () => {
  it('lands on exactly the last Zone A block and the last Zone B block and nowhere else, because a breakpoint inside a zone splits a range that always invalidates together', () => {
    const h = harness();
    h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
    const b2 = h.addBranch({ title: 'patch', phase: 'implementation' });
    h.addBranch({ title: 'run tests', phase: 'verification', status: 'open', summary: null });
    h.store.putLink({ from_id: b2.id, to_id: b2.id, kind: 'relates_to' });
    h.assembler.appendTail({ id: 'f1', text: 'fetched', ephemeral: true });

    const prompt = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });
    const zoneA = inZone(prompt, 'A');
    const zoneB = inZone(prompt, 'B');

    expect(prompt.cacheBreakpoints).toEqual([zoneA.at(-1)?.id, zoneB.at(-1)?.id]);
    expect(zoneA.at(-1)?.id).toBe('A:tools');
    expect(zoneB.at(-1)?.id).toBe(`B:links:${b2.id}:1`);
    const flagged = prompt.blocks.filter((block) => block.cacheBreakpointAfter === true);
    expect(ids(flagged)).toEqual(prompt.cacheBreakpoints);
  });

  it('emits no Zone B breakpoint when Zone B is empty, because a breakpoint on an empty range caches nothing and costs a write', () => {
    const h = harness(null);
    h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });
    const prompt = h.assembler.assemble();
    expect(inZone(prompt, 'B')).toEqual([]);
    expect(prompt.cacheBreakpoints).toEqual(['A:system']);
  });
});

describe('toMessages', () => {
  it('carries the Zone B/C breakpoint through to the message the models layer will mark, one message per zone', () => {
    const h = harness();
    h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
    h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });
    h.assembler.appendTail({ id: 'f1', text: 'fetched detail', ephemeral: true });

    const prompt = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });
    const messages = toMessages(prompt);

    expect(messages.length).toBe(3); // B, C, tail — Zone A ships as `system`.
    expect(messages.every((message) => message.role === 'user')).toBe(true);
    expect(messages[0]?.cacheBreakpoint).toBe(true);
    expect(messages[1]?.cacheBreakpoint).toBeUndefined();
    expect(messages[2]?.cacheBreakpoint).toBeUndefined();
    expect(messages[0]?.content).toBe(
      inZone(prompt, 'B')
        .map((block) => block.text)
        .join('\n\n'),
    );
    expect(messages[2]?.content).toContain('fetched detail');
  });

  it('omits an empty zone rather than emitting a blank message, so a fresh session sends Zone C alone', () => {
    const h = harness(null);
    h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });
    const messages = toMessages(h.assembler.assemble());
    expect(messages.length).toBe(1);
    expect(messages[0]?.cacheBreakpoint).toBeUndefined();
  });
});


/**
 * Records the params handed to the SDK and never touches the network (§17: CI
 * runs against recorded completions). The point of reaching all the way to the
 * client here is that `cache_control` on the wire is the only observable proof a
 * breakpoint survived the assemble -> models handoff.
 */
class AnthropicStub implements AnthropicClientLike {
  readonly sent: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];
  readonly messages: AnthropicClientLike['messages'];

  constructor() {
    this.messages = {
      create: async (
        params: Anthropic.Messages.MessageCreateParamsNonStreaming,
      ): Promise<AnthropicMessageLike> => {
        this.sent.push(params);
        return {
          model: 'claude-haiku-4-5-20251001',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };
  }
}

describe('toCompletionRequest', () => {
  it('gets BOTH rule 5 breakpoints all the way to the provider in one request — cache_control on the system block and on the Zone B/C message — because a Zone A marker the client never sees silently costs the frozen prefix on every single turn', async () => {
    const h = harness();
    h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
    h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });

    const prompt = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });
    // Precondition: the assembler did name the Zone A block, per rule 5.
    expect(prompt.cacheBreakpoints[0]).toBe(inZone(prompt, 'A').at(-1)?.id);

    const request = toCompletionRequest(prompt, 'claude-haiku-4-5-20251001', { maxTokens: 512 });
    expect(request.system).toBe(prompt.system);
    expect(request.systemCacheBreakpoint).toBe(true);

    const stub = new AnthropicStub();
    await new AnthropicProvider({ client: stub }).complete(request);
    const sent = stub.sent[0];

    expect(sent?.system).toEqual([
      { type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } },
    ]);
    // Exactly one message is marked, and it is the Zone B/C boundary.
    const marked = (sent?.messages ?? []).filter((message) => Array.isArray(message.content));
    expect(marked).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: inZone(prompt, 'B')
              .map((block) => block.text)
              .join('\n\n'),
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ]);
  });

  it('leaves the system flag off when no Zone A breakpoint was emitted, because a cache write nobody asked for is a cost, not a saving', () => {
    const h = harness();
    h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });
    const prompt = h.assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });

    const unmarked: AssembledPrompt = {
      ...prompt,
      cacheBreakpoints: [],
      blocks: prompt.blocks.map((block) => ({ ...block, cacheBreakpointAfter: false })),
    };

    expect(toCompletionRequest(unmarked, 'm').systemCacheBreakpoint).toBeUndefined();
    expect(toCompletionRequest(prompt, 'm').systemCacheBreakpoint).toBe(true);
  });

  it('passes the per-call knobs through and nothing else, so the assembler never invents a sampling param or an empty tools array (D5)', () => {
    const h = harness();
    h.addBranch({ title: 'patch', phase: 'implementation', status: 'open', summary: null });
    const prompt = h.assembler.assemble();

    const bare = toCompletionRequest(prompt, 'm');
    expect(bare.maxTokens).toBeUndefined();
    expect(bare.temperature).toBeUndefined();
    expect(bare.tools).toBeUndefined();
    expect(bare.json).toBeUndefined();
    expect(bare.messages).toEqual(toMessages(prompt));

    const tuned = toCompletionRequest(prompt, 'm', { maxTokens: 8, temperature: 0, json: true });
    expect(tuned.maxTokens).toBe(8);
    expect(tuned.temperature).toBe(0);
    expect(tuned.json).toBe(true);
  });
});

describe('Zone B blocks carry no volatile bits (D5)', () => {
  it('keeps a branch summary block byte-identical while the branch span grows, because span_end_seq extends on every append and a seq range in the heading re-writes the whole B segment each turn', () => {
    const h = harness();
    const node = h.addBranch({ title: 'reproduce', phase: 'diagnosis', summary: 'found the bug' });
    const before = h.assembler.assemble();
    const blockBefore = before.blocks.find((b) => b.id.startsWith(`B:summary:${node.id}`));

    // The event: the branch absorbs more trace (re-ingestion extends the span).
    h.store.extendSpan(node.id, ((node.span_end_seq ?? 0) + 40) as never);

    const after = h.assembler.assemble();
    const blockAfter = after.blocks.find((b) => b.id.startsWith(`B:summary:${node.id}`));
    expect(blockAfter?.text).toBe(blockBefore?.text);
    expect(blockAfter?.id).toBe(blockBefore?.id);
  });
});
