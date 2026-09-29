/**
 * §17's offline half: the §8 summary prompts driven through `RecordedProvider`
 * against the cassettes in `packages/core/test/recorded/`, with no network anywhere.
 *
 * This is §16's M3 acceptance — "real summaries pass the content contract on 5
 * golden branches" — in the only form it can take without an API key. The
 * cassettes it replays are hand-authored (see `packages/core/test/recorded/README.md`), so
 * what this file proves is that the *contract* holds end to end for realistic
 * replies, not that a real model produced them. `live.test.ts` is the half that
 * proves the second thing, and only when someone runs it with a key.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InMemoryCostMeter,
  MockProvider,
  RecordedProvider,
  SummaryContractError,
  Summarizer,
  branchFacts,
  leafSummaryPrompt,
  parseSummaryResponse,
  readCassette,
  renderBranchDetail,
  requestKey,
  type Cassette,
  type NodeSummary,
  type SummaryMeta,
  type TreeNode,
} from '@context-tree/core';
import {
  BRANCH_IDS,
  LEAF_MODEL,
  MALFORMED_LEAF_KEY,
  MALFORMED_ROOT_KEY,
  ROOT_ID,
  ROOT_MODEL,
  buildGoldenTree,
  nodeIdsOf,
  type GoldenTree,
} from './golden.js';
import {
  LEAF_CASSETTE,
  PROVENANCE_KEY,
  PROVENANCE_PREFIXES,
  REGENERATE_KEY,
  ROOT_CASSETTE,
  RoleRouter,
} from './record.js';

/** Every field of §8's content contract. A summary missing one is not a summary. */
const CONTRACT_FIELDS = [
  'artifacts',
  'decisions',
  'files',
  'node_ids',
  'open_questions',
  'symbols',
  'tests',
] as const;

const REPLAYABLE_KEY = /^[0-9a-f]{64}$/;

const replayableKeys = (cassette: Cassette): string[] =>
  Object.keys(cassette).filter((key) => REPLAYABLE_KEY.test(key));

describe('recorded cassettes (§17)', () => {
  const leaf = readCassette(LEAF_CASSETTE);
  const root = readCassette(ROOT_CASSETTE);

  it('load through RecordedProvider and hold one replayable entry per golden branch', () => {
    expect(replayableKeys(leaf)).toHaveLength(BRANCH_IDS.length);
    expect(replayableKeys(root)).toHaveLength(1);
  });

  // The marker is the only thing standing between a hand-written reply and
  // everyone treating it as evidence of what a real model does. Stripping it
  // must break the build, not pass quietly.
  it.each([
    ['leaf', LEAF_CASSETTE, leaf],
    ['root', ROOT_CASSETTE, root],
  ])('%s cassette states its provenance, so a hand-authored reply is never read as a recording', (
    _role,
    path,
    cassette,
  ) => {
    const marker = cassette[PROVENANCE_KEY];
    expect(marker, `${path} has no ${PROVENANCE_KEY} entry`).toBeDefined();
    expect(
      PROVENANCE_PREFIXES.some((prefix) => marker?.text.startsWith(prefix)),
      `${PROVENANCE_KEY} must start with one of ${PROVENANCE_PREFIXES.join(' | ')}, got ${JSON.stringify(marker?.text.slice(0, 60))}`,
    ).toBe(true);
    // No model produced a marker, and pricing one would inflate the meter.
    expect(marker?.model).toBe('none');
    expect(marker?.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it.each([
    ['leaf', leaf],
    ['root', root],
  ])('%s cassette carries the command that regenerates it, so it stays replaceable', (_role, cassette) => {
    expect(cassette[REGENERATE_KEY]?.text).toContain('packages/core/test/live/record.ts');
    expect(cassette[REGENERATE_KEY]?.text).toContain('--authored');
  });

  it('names the missing key and the cassette path on a miss, so a prompt edit is diagnosable', async () => {
    const provider = new RecordedProvider(LEAF_CASSETTE);
    const request = {
      model: LEAF_MODEL,
      messages: [{ role: 'user' as const, content: 'a prompt no cassette was recorded for' }],
      json: true,
    };
    await expect(provider.complete(request)).rejects.toThrow(requestKey(request));
    await expect(provider.complete(request)).rejects.toThrow(LEAF_CASSETTE);
  });
});

describe('§8 content contract over 5 golden branches (M3 acceptance)', () => {
  let dir: string;
  let golden: GoldenTree;
  let summaries: Map<string, NodeSummary>;
  let meter: InMemoryCostMeter;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'context-tree-contract-'));
    golden = buildGoldenTree(dir);
    meter = new InMemoryCostMeter();
    const summarizer = new Summarizer({
      store: golden.store,
      provider: new RoleRouter(
        new RecordedProvider(LEAF_CASSETTE),
        new RecordedProvider(ROOT_CASSETTE),
        LEAF_MODEL,
      ),
      leafModel: LEAF_MODEL,
      rootModel: ROOT_MODEL,
      trace: golden.trace,
      blobs: golden.blobs,
      costMeter: meter,
      now: () => '2026-02-11T10:00:00.000Z',
    });
    const outcomes = await summarizer.summarizeTree(ROOT_ID);
    const failures = outcomes
      .filter((outcome) => outcome.status === 'failed')
      .map((outcome) => `${outcome.nodeId}: ${outcome.error?.message ?? 'unknown'}`);
    // Reported here rather than left to a later assertion: a cassette miss and a
    // contract violation fail the same expectation otherwise, and they have
    // opposite fixes.
    expect(failures, 'every golden branch must summarize').toEqual([]);

    summaries = new Map();
    for (const id of [ROOT_ID, ...BRANCH_IDS]) {
      const summary = golden.store.currentSummary(id);
      expect(summary, `${id} has no stored summary`).not.toBeNull();
      if (summary !== null) summaries.set(id, summary);
    }
  });

  afterAll(() => {
    golden.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(BRANCH_IDS)(
    '%s: the summarizer stores a complete SummaryMeta — an absent field is a branch the next agent cannot ask about',
    (branch) => {
      const summary = summaries.get(branch);
      expect(summary?.text.length ?? 0).toBeGreaterThan(80);
      expect(Object.keys(summary?.meta ?? {}).sort()).toEqual([...CONTRACT_FIELDS]);
    },
  );

  it.each(BRANCH_IDS)('%s: meta.node_ids names every child node, which are the §9 fetch targets', (branch) => {
    expect(summaries.get(branch)?.meta.node_ids).toEqual(nodeIdsOf(golden.store, branch));
  });

  // D9: spans are coordinates `fetch` resolves, so they come from the
  // tree even when the reply offered its own.
  it.each(BRANCH_IDS)('%s: meta.files are the tree-sitter spans, never the reply\'s (D9)', (branch) => {
    const node = golden.store.getNode(branch) as TreeNode;
    expect(summaries.get(branch)?.meta.files).toEqual(branchFacts(golden.store, node).spans);
  });

  it('carries a failed test through: a summary that reports only passes hides the reason work is unfinished', () => {
    const statuses = [...summaries.values()].flatMap((summary) =>
      summary.meta.tests.map((test) => test.status),
    );
    expect(statuses).toContain('failed');
    expect(statuses).toContain('passed');
  });

  it('carries the ticket and the PR: external artifacts are how a resumed session finds the work outside the repo', () => {
    const kinds = [...summaries.values()].flatMap((summary) =>
      summary.meta.artifacts.map((artifact) => artifact.kind),
    );
    expect(kinds).toContain('ticket');
    expect(kinds).toContain('pr');
  });

  it('leaves open questions on the record — §8 calls them part of the rehydration pointers', () => {
    const questions = [...summaries.values()].flatMap((summary) => summary.meta.open_questions);
    expect(questions.length).toBeGreaterThan(0);
    expect(summaries.get(ROOT_ID)?.meta.open_questions.length ?? 0).toBeGreaterThan(0);
  });

  it('rolls the five branches up into the root summary, so Zone B alone names every branch to fetch', () => {
    const root = summaries.get(ROOT_ID);
    expect(root?.meta.node_ids).toEqual([ROOT_ID, ...BRANCH_IDS]);
    expect(root?.model).toBe(ROOT_MODEL);
    const paths = new Set(root?.meta.files.map((file) => file.path));
    expect([...paths].sort()).toEqual(['src/api/cursor.ts', 'src/api/legacy-cursor.ts']);
  });

  it('meters the recorded usage: §16 caps per-PR spend, and a call accounted as free defeats the cap', () => {
    const snapshot = meter.snapshot();
    expect(snapshot.entries.map((entry) => entry.model).sort()).toEqual([LEAF_MODEL, ROOT_MODEL]);
    expect(snapshot.totalUsd).toBeGreaterThan(0);
    expect(meter.unpricedModels()).toEqual([]);
  });
});

/**
 * The prompts are versioned artifacts (§11). If one is edited, every cassette
 * key derived from it goes stale — and the failure mode without this test is
 * six identical "no recorded completion" errors that name a hash and nothing
 * else.
 */
describe('cassette keys track the versioned prompts (§11)', () => {
  it('every golden leaf prompt still hashes to a key the cassette holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-tree-keys-'));
    const golden = buildGoldenTree(dir);
    try {
      const cassette = readCassette(LEAF_CASSETTE);
      for (const branch of BRANCH_IDS) {
        const node = golden.store.getNode(branch) as TreeNode;
        const facts = branchFacts(golden.store, node);
        const key = requestKey({
          model: LEAF_MODEL,
          messages: [
            {
              role: 'user',
              content: leafSummaryPrompt({
                title: node.title,
                phaseType: node.phase_type,
                nodeIds: nodeIdsOf(golden.store, branch),
                detail: renderBranchDetail(golden.store, node, facts, {
                  trace: golden.trace,
                  blobs: golden.blobs,
                }),
              }),
            },
          ],
          json: true,
        });
        expect(
          cassette[key],
          `${branch}'s prompt hashes to ${key}, which the cassette does not hold — ` +
            'the leaf template or the fixture changed; re-record (see packages/core/test/recorded/README.md)',
        ).toBeDefined();
      }
    } finally {
      golden.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('contract violations (§8)', () => {
  it('rejects a span with only one edge, naming the field — half a span is not a coordinate', () => {
    const malformed = readCassette(LEAF_CASSETTE)[MALFORMED_LEAF_KEY];
    expect(malformed).toBeDefined();
    expect(() => parseSummaryResponse(malformed?.text ?? '')).toThrow(SummaryContractError);
    expect(() => parseSummaryResponse(malformed?.text ?? '')).toThrow(/meta\.files\[1\]\.end_line/);
  });

  it('rejects a test status outside the four allowed values, naming the field', () => {
    const malformed = readCassette(ROOT_CASSETTE)[MALFORMED_ROOT_KEY];
    expect(malformed).toBeDefined();
    expect(() => parseSummaryResponse(malformed?.text ?? '')).toThrow(/meta\.tests\[1\]\.status/);
  });

  /**
   * End to end rather than through `parseSummaryReply` alone: the tree-owned
   * fields (files/symbols, D9) are dropped from the reply before the strict
   * parse and overwritten from the tree, so a malformed span element cannot
   * fail the branch — a branch that goes unsummarized is one §9's reader can
   * never ask about, which is the worse failure (observed live:
   * claude-haiku-4.5 broke this sub-contract on 3/3 runs).
   */
  it('drops a malformed span element and stores tree-derived coordinates instead of retrying', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-tree-malformed-'));
    const golden = buildGoldenTree(dir);
    try {
      const malformed = readCassette(LEAF_CASSETTE)[MALFORMED_LEAF_KEY];
      const provider = new MockProvider({ reply: malformed?.text ?? '' });
      const summarizer = new Summarizer({
        store: golden.store,
        provider,
        leafModel: LEAF_MODEL,
        rootModel: ROOT_MODEL,
        trace: golden.trace,
        blobs: golden.blobs,
      });
      const summary = await summarizer.summarizeLeaf('n_gold_b2');
      // No retry: the violation lived in a field the system discards.
      expect(provider.requests).toHaveLength(1);
      expect(summary.version).toBe(1);
      const stored = golden.store.currentSummary('n_gold_b2');
      expect(stored).not.toBeNull();
      // The stored coordinates are the tree's, complete and well-formed —
      // the malformed element never reaches storage.
      expect(stored?.meta.files.length).toBeGreaterThan(0);
      expect(stored?.meta.files.every((file) => file.path === 'src/api/cursor.ts')).toBe(true);
      expect(
        stored?.meta.files.every(
          (file) => typeof file.start_line === 'number' && typeof file.end_line === 'number',
        ),
      ).toBe(true);
    } finally {
      golden.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops a reply that parses but points outside the branch, storing tree coordinates instead (D9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-tree-offbranch-'));
    const golden = buildGoldenTree(dir);
    try {
      const meta: SummaryMeta = {
        files: [{ path: 'src/unrelated/other.ts', start_line: 1, end_line: 9 }],
        symbols: [],
        tests: [],
        artifacts: [],
        open_questions: [],
        decisions: [],
        node_ids: nodeIdsOf(golden.store, 'n_gold_b2'),
      };
      const summarizer = new Summarizer({
        store: golden.store,
        provider: new MockProvider({ reply: JSON.stringify({ text: 'plausible prose', meta }) }),
        leafModel: LEAF_MODEL,
        rootModel: ROOT_MODEL,
        trace: golden.trace,
        blobs: golden.blobs,
      });
      const summary = await summarizer.summarizeLeaf('n_gold_b2');
      expect(summary.version).toBe(1);
      const stored = golden.store.currentSummary('n_gold_b2');
      expect(stored?.meta.files.every((file) => file.path === 'src/api/cursor.ts')).toBe(true);
      expect(stored?.meta.files.some((file) => file.path === 'src/unrelated/other.ts')).toBe(false);
    } finally {
      golden.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
