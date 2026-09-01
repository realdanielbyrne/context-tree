/**
 * §17's cache assertion harness in action — "deterministic tokenizer + provider
 * cache simulator asserting exactly which prefix ranges survive each event
 * type", which §17 names as the place D5 regressions surface and essentially
 * nowhere else.
 *
 * Every test below is the same shape: build a store, assemble, apply ONE event,
 * re-assemble, simulate. The assertions are on block ids and token ranges, never
 * on prose — a D5 regression changes nothing the model reads, only what the
 * provider can reuse, so an assertion about content would pass while the session
 * silently paid several times over.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { ExactTokenizer, HeuristicTokenizer } from '../src/tokens/index.js';
import { ZoneAssembler } from '../src/assemble/index.js';
import {
  ANTHROPIC_PROFILE,
  CacheAssertionError,
  ProviderCacheSimulator,
  assertPrefixStable,
  cacheReport,
  findPrefixDivergence,
} from '../src/cache/index.js';

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
  summary?: string | null;
}

const dirs: string[] = [];
const stores: SqliteTreeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A task tree plus the assembler and simulator that read it. */
function harness(systemContract: string = SYSTEM) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-cache-'));
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
  store.putSummary({
    node_id: root.id,
    model: 'mock-root',
    text: 'the task is to fix pricing rounding',
    meta: summaryMeta({ node_ids: [root.id] }),
  });

  function addBranch(spec: BranchSpec): TreeNode {
    const path = `src/${spec.phase}.ts`;
    const start = trace.lastSeq() + 1;
    trace.append({ type: 'user_message', ts: TS, blob: blobs.put(`please ${spec.title}`) });
    trace.append({ type: 'assistant_message', ts: TS, blob: blobs.put(`starting ${spec.title}`) });
    trace.append({
      type: 'tool_call',
      ts: TS,
      tool: 'Edit',
      path,
      blob: blobs.put(`post-edit content for ${spec.title}`),
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
    store.updateNode(root.id, { span_end_seq: end });
    if (spec.summary !== null) {
      store.putSummary({
        node_id: node.id,
        model: 'mock-leaf',
        text: spec.summary ?? `${spec.title}: what happened here`,
        meta: summaryMeta({ node_ids: [node.id] }),
      });
    }
    return node;
  }

  /** Closes `node`, lands its backgrounded summary (D11), opens the next phase. */
  function transitionPhase(node: TreeNode, next: BranchSpec): TreeNode {
    store.updateNode(node.id, { status: 'closed' });
    store.putSummary({
      node_id: node.id,
      model: 'mock-leaf',
      text: `${node.title}: what happened here`,
      meta: summaryMeta({ node_ids: [node.id] }),
    });
    return addBranch({ ...next, status: 'open', summary: null });
  }

  const deps = { store, blobs, trace, tokenizer, systemContract };
  const assembler = new ZoneAssembler(deps);
  const assemble = (): AssembledPrompt => assembler.assemble({ toolSchemasText: TOOL_SCHEMAS });
  const simulator = new ProviderCacheSimulator({ tokenizer });

  return {
    store,
    blobs,
    trace,
    tokenizer,
    deps,
    root,
    addBranch,
    transitionPhase,
    assembler,
    assemble,
    simulator,
  };
}

function inZone(prompt: AssembledPrompt, zone: Zone): PromptBlock[] {
  return prompt.blocks.filter((block) => block.zone === zone);
}

function ids(blocks: readonly PromptBlock[]): string[] {
  return blocks.map((block) => block.id);
}

function zoneTokens(prompt: AssembledPrompt, zone: Zone): number {
  return inZone(prompt, zone).reduce((sum, block) => sum + block.tokens, 0);
}

/** A three-branch task with a fourth phase open — the steady state Zone C rewrites. */
function threeClosedBranches(h: ReturnType<typeof harness>) {
  const first = h.addBranch({ title: 'reproduce', phase: 'diagnosis' });
  const second = h.addBranch({ title: 'patch', phase: 'implementation' });
  const third = h.addBranch({ title: 'run tests', phase: 'verification' });
  const active = h.addBranch({ title: 'open PR', phase: 'delivery', status: 'open', summary: null });
  return { first, second, third, active };
}

describe('Zone A — the frozen prefix (§10 rule 5, D5)', () => {
  it('is byte-identical across a config-identical re-assemble and is read from cache on the second submission, which is the only evidence the frozen prefix is actually earning anything', () => {
    const h = harness();
    threeClosedBranches(h);

    const first = h.assemble();
    // A second assembler over the same config: nothing per-instance may leak
    // into Zone A, or a resumed session pays full price for the whole prefix.
    const second = new ZoneAssembler(h.deps).assemble({ toolSchemasText: TOOL_SCHEMAS });

    expect(ids(inZone(second, 'A'))).toEqual(['A:system', 'A:tools']);
    expect(inZone(second, 'A').map((b) => b.text)).toEqual(inZone(first, 'A').map((b) => b.text));
    expect(second.system).toBe(first.system);

    h.simulator.submit(first);
    const outcome = h.simulator.submit(second);

    expect(outcome.cacheRead).toBeGreaterThan(0);
    expect(outcome.survivingSegments).toContain('A');
    expect(outcome.cacheRead).toBe(zoneTokens(second, 'A') + zoneTokens(second, 'B'));
    // Nothing about the accounting may go missing: every input token is read,
    // written, or fresh.
    expect(outcome.cacheRead + outcome.cacheWrite + outcome.fresh).toBe(outcome.total);
  });

  it('records the injected tokenizer id on every outcome so swapping tokenizers is a deliberate diff rather than a silent shift of every recorded range (§17)', () => {
    const h = harness();
    threeClosedBranches(h);
    const prompt = h.assemble();

    const heuristic = new ProviderCacheSimulator({ tokenizer: h.tokenizer }).submit(prompt);
    const bytes = new ProviderCacheSimulator({
      tokenizer: new ExactTokenizer('bytes-v0', (text) => text.length),
    }).submit(prompt);

    expect(heuristic.tokenizerId).toBe('heuristic-v1');
    expect(bytes.tokenizerId).toBe('bytes-v0');
    expect(bytes.total).not.toBe(heuristic.total);
    // Same layout, same segments — only the measuring stick changed.
    expect(bytes.segments.map((s) => s.blockIds)).toEqual(heuristic.segments.map((s) => s.blockIds));
  });
});

describe('event: a turn appended to the ACTIVE branch', () => {
  it('leaves Zone A and Zone B fully cache-readable and charges only Zone C as fresh, because the appended turn lands after the last breakpoint (§10 rule 2)', () => {
    const h = harness();
    threeClosedBranches(h);
    const before = h.assemble();
    const firstOutcome = h.simulator.submit(before);

    // The event: one more turn inside the open phase. L1 is untouched; Zone C
    // reads an open branch out to `trace.lastSeq()`.
    h.trace.append({ type: 'user_message', ts: TS, blob: h.blobs.put('also fix the tax line') });
    h.trace.append({
      type: 'assistant_message',
      ts: TS,
      blob: h.blobs.put('reading the tax helper'),
    });

    const after = h.assemble();
    const outcome = h.simulator.submit(after);

    assertPrefixStable(before, after, { throughZone: 'B' });
    expect(ids(inZone(after, 'B'))).toEqual(ids(inZone(before, 'B')));
    expect(ids(inZone(after, 'C')).length).toBe(ids(inZone(before, 'C')).length + 2);

    expect(outcome.survivingSegments).toEqual(['A', 'B']);
    expect(outcome.cacheRead).toBe(zoneTokens(after, 'A') + zoneTokens(after, 'B'));
    expect(outcome.cacheWrite).toBe(0);
    expect(outcome.fresh).toBe(zoneTokens(after, 'C'));
    expect(outcome.divergedInZone).toBe('C');
    // The first submission had to write the prefix it now reads back.
    expect(firstOutcome.cacheWrite).toBe(outcome.cacheRead);
  });
});

describe('event: a PHASE TRANSITION (§16 M4 acceptance)', () => {
  it('grows Zone B by exactly the newly-closed branch summary at its END, keeps the prefix through the previous last summary byte-identical, and rewrites Zone C in full', () => {
    const h = harness();
    const { active } = threeClosedBranches(h);
    const before = h.assemble();
    h.simulator.submit(before);

    const next = h.transitionPhase(active, { title: 'address review', phase: 'review' });
    h.assembler.onPhaseTransition();
    const after = h.assemble();
    const outcome = h.simulator.submit(after);

    // Rule 2: insertion at the end only. Every pre-existing Zone A/B block is
    // still byte-identical and in the same position.
    assertPrefixStable(before, after, { throughZone: 'B' });
    expect(ids(inZone(after, 'B'))).toEqual([
      ...ids(inZone(before, 'B')),
      `B:summary:${active.id}:1`,
    ]);

    // Zone C is a different branch entirely — not one block id survives.
    const beforeC = new Set(ids(inZone(before, 'C')));
    expect(ids(inZone(after, 'C')).filter((id) => beforeC.has(id))).toEqual([]);
    expect(ids(inZone(after, 'C'))[0]).toBe(`C:head:${next.id}`);

    // What the provider can actually reuse: Zone A only. Zone B's sole
    // breakpoint is at its END (rule 5), so appending to it re-writes the whole
    // segment even though every earlier block survived — the block prefix and
    // the cacheable prefix are not the same number, and the harness reports both.
    expect(outcome.survivingSegments).toEqual(['A']);
    expect(outcome.cacheRead).toBe(zoneTokens(after, 'A'));
    expect(outcome.cacheWrite).toBe(zoneTokens(after, 'B'));
    expect(outcome.fresh).toBe(zoneTokens(after, 'C'));
    expect(outcome.commonPrefixTokens).toBeGreaterThan(outcome.cacheRead);
    expect(outcome.divergedAtBlockId).toBe(`B:summary:${active.id}:1`);
  });
});

describe('event: a `context_fetch` result appended to the tail (§10 rule 3)', () => {
  it('leaves every block through Zone C byte-identical and charges only the retrieved text, which is the cheapest property in the layout to break by accident', () => {
    const h = harness();
    threeClosedBranches(h);
    const before = h.assemble();
    const beforeOutcome = h.simulator.submit(before);

    h.assembler.appendTail({
      id: 'fetch:n_pricing',
      text: 'src/pricing.ts:142-168 roundHalfEven(...)',
      ephemeral: true,
    });
    const after = h.assemble();
    const outcome = h.simulator.submit(after);

    // The whole point of rule 3: the cached prefix is untouched by retrieval.
    assertPrefixStable(before, after, { throughZone: 'C' });
    expect(ids(inZone(after, 'C'))).toEqual(ids(inZone(before, 'C')));
    expect(ids(inZone(after, 'tail'))).toEqual(['tail:fetch:n_pricing']);

    expect(outcome.survivingSegments).toEqual(['A', 'B']);
    expect(outcome.cacheRead).toBe(beforeOutcome.cacheWrite);
    expect(outcome.fresh).toBe(beforeOutcome.fresh + zoneTokens(after, 'tail'));
    expect(outcome.divergedInZone).toBe('tail');
  });
});

describe('event: a summary regenerated for a MIDDLE branch (the D4 cascade)', () => {
  it('keeps Zone A cache-readable and invalidates Zone B from the rewritten branch onward — the expected, documented cost of versioned summaries (D3), not a bug', () => {
    const h = harness();
    const { second } = threeClosedBranches(h);
    const before = h.assemble();
    h.simulator.submit(before);

    // The cascade's leaf write: a new summary VERSION for a middle branch. D3
    // never overwrites, so the block id carries the version and the block that
    // held version 1 is replaced in place.
    h.store.putSummary({
      node_id: second.id,
      model: 'mock-leaf',
      text: 'patch: rewritten after the follow-up edit',
      meta: summaryMeta({ node_ids: [second.id] }),
    });
    const after = h.assemble();
    const outcome = h.simulator.submit(after);

    assertPrefixStable(before, after, { throughZone: 'A' });
    const divergence = findPrefixDivergence(before, after, { throughZone: 'B' });
    expect(divergence?.kind).toBe('replaced');
    expect(divergence?.blockId).toBe(`B:summary:${second.id}:2`);
    expect(divergence?.displacedBlockId).toBe(`B:summary:${second.id}:1`);
    expect(divergence?.zone).toBe('B');

    // "Survives up to that branch": the byte-identical block prefix still covers
    // Zone A, the root summary and the branch before it — but the provider can
    // only read back as far as the Zone A breakpoint.
    expect(outcome.commonPrefixBlocks).toBe(inZone(before, 'A').length + 2);
    expect(outcome.cacheRead).toBe(zoneTokens(after, 'A'));
    expect(outcome.survivingSegments).toEqual(['A']);

    // And when the cascade reaches the ancestor (§8: leaf, then up the path),
    // divergence moves to the very first Zone B block. That is the honest full
    // cost of D3/D4 and the number this harness exists to keep visible.
    h.store.putSummary({
      node_id: h.root.id,
      model: 'mock-root',
      text: 'the task is to fix pricing rounding (revised)',
      meta: summaryMeta({ node_ids: [h.root.id] }),
    });
    const cascaded = h.assemble();
    const cascadedOutcome = h.simulator.submit(cascaded);

    expect(cascadedOutcome.commonPrefixBlocks).toBe(inZone(before, 'A').length);
    expect(cascadedOutcome.divergedAtBlockId).toBe(`B:root:${h.root.id}:2`);
    expect(cascadedOutcome.cacheRead).toBe(zoneTokens(cascaded, 'A'));
  });
});

describe('negative control — the harness must catch what §10 rule 1 forbids', () => {
  /**
   * Relevance-ordered Zone B: the newest branch summary hoisted to the front
   * because it "matters most". Only the ORDER changes — same blocks, same text,
   * same breakpoints — which is exactly why nothing except a cache assertion
   * can notice it.
   */
  function relevanceOrderZoneB(prompt: AssembledPrompt): AssembledPrompt {
    const blocks = prompt.blocks.map((block) => ({ ...block, cacheBreakpointAfter: false }));
    const zoneB = blocks.filter((block) => block.zone === 'B');
    const head = zoneB[0];
    const last = zoneB.at(-1);
    if (head === undefined || last === undefined) throw new Error('fixture needs a Zone B');
    const reordered = [head, last, ...zoneB.slice(1, -1)];

    const out: PromptBlock[] = [
      ...blocks.filter((block) => block.zone === 'A'),
      ...reordered,
      ...blocks.filter((block) => block.zone === 'C' || block.zone === 'tail'),
    ];
    // Re-emit rule 5's breakpoints so ordering is the only variable under test.
    const breakpoints: string[] = [];
    for (const zone of ['A', 'B'] as const) {
      const tail = out.filter((block) => block.zone === zone).at(-1);
      if (tail === undefined) continue;
      tail.cacheBreakpointAfter = true;
      breakpoints.push(tail.id);
    }
    return { ...prompt, blocks: out, cacheBreakpoints: breakpoints };
  }

  it('reports Zone B as invalidated and throws from assertPrefixStable naming the moved block, while Zone A stays intact — a harness that misses this is worthless', () => {
    const h = harness();
    const { third } = threeClosedBranches(h);
    const creationOrder = h.assemble();
    h.simulator.submit(creationOrder);

    const relevanceOrder = relevanceOrderZoneB(creationOrder);
    const outcome = h.simulator.submit(relevanceOrder);

    expect(outcome.survivingSegments).toEqual(['A']);
    expect(outcome.cacheRead).toBe(zoneTokens(creationOrder, 'A'));
    expect(outcome.cacheWrite).toBe(zoneTokens(creationOrder, 'B'));
    expect(outcome.divergedInZone).toBe('B');

    // The asymmetry the whole module encodes: one moved byte-range in Zone B
    // invalidates Zone B and everything after it, and nothing before it.
    expect(() => assertPrefixStable(creationOrder, relevanceOrder, { throughZone: 'A' })).not.toThrow();

    let thrown: unknown;
    try {
      assertPrefixStable(creationOrder, relevanceOrder, { throughZone: 'B' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CacheAssertionError);
    const error = thrown as CacheAssertionError;
    expect(error.code).toBe('E_CACHE_ASSERT');
    expect(error.divergence?.kind).toBe('position');
    expect(error.divergence?.blockId).toBe(`B:summary:${third.id}:1`);
    expect(error.divergence?.zone).toBe('B');
    expect(error.message).toContain(`B:summary:${third.id}:1`);
    expect(error.message).toContain('§10 rule 1');
  });

  it('reports a dropped §10 rule 5 breakpoint as total loss of cache reads even though every block is byte-identical, because an unmarked prefix is never cached at all', () => {
    const h = harness();
    threeClosedBranches(h);
    const marked = h.assemble();
    h.simulator.submit(marked);

    // Same bytes, same order, no breakpoints — the mistake of building a
    // provider request from `toMessages` alone and losing the markers.
    const unmarked: AssembledPrompt = {
      ...marked,
      blocks: marked.blocks.map((block) => ({ ...block, cacheBreakpointAfter: false })),
      cacheBreakpoints: [],
    };
    const outcome = h.simulator.submit(unmarked);

    expect(() => assertPrefixStable(marked, unmarked, { throughZone: 'tail' })).not.toThrow();
    expect(outcome.commonPrefixTokens).toBe(outcome.total);
    expect(outcome.survivingSegments).toEqual([]);
    expect(outcome.cacheRead).toBe(0);
    expect(outcome.fresh).toBe(outcome.total);
  });

  it('names a dropped Zone B summary a removal and its re-insertion an insertion, because rule 4 degradation that reaches into the cached prefix costs the whole suffix in both directions', () => {
    const h = harness();
    threeClosedBranches(h);
    const before = h.assemble();
    const evicted = ids(inZone(before, 'B'))[1];
    const dropped: AssembledPrompt = {
      ...before,
      blocks: before.blocks.filter((block) => block.id !== evicted),
    };

    const removal = findPrefixDivergence(before, dropped, { throughZone: 'B' });
    expect(removal?.kind).toBe('removed');
    expect(removal?.blockId).toBe(evicted);
    expect(() => assertPrefixStable(before, dropped, { throughZone: 'B' })).toThrow(
      CacheAssertionError,
    );

    // Putting it back is just as expensive: it displaces every later summary.
    expect(findPrefixDivergence(dropped, before, { throughZone: 'B' })?.kind).toBe('inserted');
    // Zone A is untouched either way — the invalidation starts where the edit is.
    expect(() => assertPrefixStable(dropped, before, { throughZone: 'A' })).not.toThrow();
  });
});

describe('per-provider profiles (§18: cache behaviour differs per provider)', () => {
  it('reports nothing cached under Anthropic minimums when the prefix is below its 1024-token floor, even though the layout is identical', () => {
    const h = harness();
    threeClosedBranches(h);
    const prompt = h.assemble();
    expect(zoneTokens(prompt, 'A') + zoneTokens(prompt, 'B')).toBeLessThan(1024);

    const simulator = new ProviderCacheSimulator({
      tokenizer: h.tokenizer,
      profile: ANTHROPIC_PROFILE,
    });
    simulator.submit(prompt);
    const outcome = simulator.submit(h.assemble());

    expect(outcome.profileId).toBe('anthropic');
    expect(outcome.cacheRead).toBe(0);
    expect(outcome.cacheWrite).toBe(0);
    expect(outcome.fresh).toBe(outcome.total);
    // The layout is fine — the block prefix is intact. Only the provider floor
    // stops it from paying, which is why the two numbers are reported apart.
    expect(outcome.commonPrefixTokens).toBe(outcome.total);
  });

  it('caches the Zone A breakpoint under Anthropic once the frozen prefix clears the floor, so the profile knob is measuring the floor and not a broken simulator', () => {
    const h = harness(`${SYSTEM}\n${'contract clause about fetching before editing. '.repeat(200)}`);
    threeClosedBranches(h);
    const prompt = h.assemble();
    expect(zoneTokens(prompt, 'A')).toBeGreaterThan(1024);

    const simulator = new ProviderCacheSimulator({
      tokenizer: h.tokenizer,
      profile: ANTHROPIC_PROFILE,
    });
    simulator.submit(prompt);
    const outcome = simulator.submit(h.assemble());

    // Both breakpoints now clear the floor, so both are honoured and the read
    // runs to the longest matching cached prefix — the same layout that cached
    // nothing in the test above.
    expect(outcome.segments.filter((s) => s.cacheable).map((s) => s.label)).toEqual(['A', 'B']);
    expect(outcome.survivingSegments).toEqual(['A', 'B']);
    expect(outcome.cacheRead).toBe(zoneTokens(prompt, 'A') + zoneTokens(prompt, 'B'));
    expect(outcome.fresh).toBe(zoneTokens(prompt, 'C'));
  });
});

describe('cacheReport — §15 input-token split across a session', () => {
  it('aggregates read/write/fresh over a whole session and conserves every input token', () => {
    const h = harness();
    const { active } = threeClosedBranches(h);

    h.simulator.submit(h.assemble());
    h.trace.append({ type: 'user_message', ts: TS, blob: h.blobs.put('one more turn') });
    h.simulator.submit(h.assemble());
    h.assembler.appendTail({ id: 'fetch:1', text: 'retrieved detail', ephemeral: true });
    h.simulator.submit(h.assemble());
    h.transitionPhase(active, { title: 'address review', phase: 'review' });
    h.assembler.onPhaseTransition();
    h.simulator.submit(h.assemble());

    const outcomes = h.simulator.outcomes();
    const report = cacheReport(outcomes);

    expect(report.submissions).toBe(4);
    expect(report.tokenizerId).toBe('heuristic-v1');
    expect(report.profileId).toBe('exact-prefix');
    expect(report.cacheRead + report.cacheWrite + report.fresh).toBe(report.total);
    expect(report.cacheRead).toBe(outcomes.reduce((sum, o) => sum + o.cacheRead, 0));
    expect(report.cacheReadRatio).toBeCloseTo(report.cacheRead / report.total, 12);
    // Three of the four submissions read a prefix back; a session that cached
    // nothing would be the D5 regression this report is meant to expose.
    expect(report.cacheRead).toBeGreaterThan(0);
  });

  it('refuses to aggregate outcomes measured with different tokenizers, because a cost split built from two measuring sticks is worse than a crash', () => {
    const h = harness();
    threeClosedBranches(h);
    const prompt = h.assemble();

    const a = new ProviderCacheSimulator({ tokenizer: h.tokenizer }).submit(prompt);
    const b = new ProviderCacheSimulator({
      tokenizer: new ExactTokenizer('bytes-v0', (text) => text.length),
    }).submit(prompt);

    expect(() => cacheReport([a, b])).toThrow(/mixed tokenizers/);
    expect(() => cacheReport([])).toThrow(CacheAssertionError);
  });
});
