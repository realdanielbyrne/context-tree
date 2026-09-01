/**
 * §17's opt-in half: `LIVE=1` hits real models. It is a canary, not a
 * benchmark — four calls on the cheap models, asserting the things a recorded
 * cassette structurally cannot: that a frontier model actually obeys the §8
 * content contract, that the provider reports a real cache-read/cache-write
 * split (§15 reports that split and cannot fabricate it), and that §16's spend
 * cap refuses the next call.
 *
 * It skips silently with no `LIVE`, and skips rather than fails with no key: a
 * suite that goes red because someone has no API key is a suite everyone learns
 * to ignore.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CostCapExceededError,
  InMemoryCostMeter,
  Summarizer,
  createProvider,
  loadApiKeys,
  loadDotEnv,
  type ContextTreeConfig,
  type ModelProvider,
  type TokenUsage,
} from '@context-tree/core';
import { BRANCH_IDS, ROOT_ID, buildGoldenTree, nodeIdsOf, type GoldenTree } from './golden.js';
import { liveConfig, shouldRunLive } from './record.js';

// Only when opting in: a `.env` read during an ordinary CI run would put a key
// into the environment of a suite that must never make a call.
if (process.env.LIVE !== undefined && process.env.LIVE !== '') loadDotEnv();

const LIVE_ENABLED = shouldRunLive(process.env);

/**
 * The guard itself is testable offline, and it is the only part of this file CI
 * ever executes — so it is the part that gets asserted rather than assumed.
 */
describe('the LIVE gate (§17)', () => {
  it('is off when LIVE is unset, so CI never reaches the network', () => {
    expect(shouldRunLive({ ANTHROPIC_API_KEY: 'sk-test' })).toBe(false);
  });

  it.each(['', '0', 'false'])('is off for LIVE=%j, so a falsy opt-in is not an opt-in', (flag) => {
    expect(shouldRunLive({ LIVE: flag, ANTHROPIC_API_KEY: 'sk-test' })).toBe(false);
  });

  it('is off when LIVE is set but the provider has no key, so it skips instead of failing', () => {
    expect(shouldRunLive({ LIVE: '1' })).toBe(false);
  });

  it('is on with LIVE=1 and a key for the selected provider', () => {
    expect(shouldRunLive({ LIVE: '1', ANTHROPIC_API_KEY: 'sk-test' })).toBe(true);
    expect(
      shouldRunLive({
        LIVE: '1',
        CONTEXT_TREE_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'sk-test',
      }),
    ).toBe(true);
  });

  it('reads the key the selected provider needs, not whichever key is lying around', () => {
    expect(
      shouldRunLive({ LIVE: '1', CONTEXT_TREE_PROVIDER: 'openrouter', ANTHROPIC_API_KEY: 'sk-test' }),
    ).toBe(false);
  });
});

describe.skipIf(!LIVE_ENABLED)('live summarization (§16 M3)', () => {
  let dir: string;
  let golden: GoldenTree;
  let config: ContextTreeConfig;
  let provider: ModelProvider;
  let meter: InMemoryCostMeter;

  const LEAF = BRANCH_IDS[1];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'context-tree-live-'));
    golden = buildGoldenTree(dir);
    config = liveConfig(process.env);
    provider = createProvider(config, loadApiKeys(process.env));
    meter = new InMemoryCostMeter();
    const summarizer = new Summarizer({
      store: golden.store,
      provider,
      leafModel: config.leafModel,
      rootModel: config.rootModel,
      trace: golden.trace,
      blobs: golden.blobs,
      costMeter: meter,
    });
    // One leaf and one root — the two §8 roles and the two versioned prompts.
    // `summarizeRoot` rolls up whatever children have summaries, so one leaf is
    // a complete root input.
    await summarizer.summarizeLeaf(LEAF);
    await summarizer.summarizeRoot(ROOT_ID);
  }, 120_000);

  afterAll(() => {
    golden?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['leaf', () => LEAF],
    ['root', () => ROOT_ID],
  ])(
    'a real %s summary satisfies the §8 content contract — the claim a cassette cannot make for us',
    (_role, id) => {
      const summary = golden.store.currentSummary(id());
      expect(summary).not.toBeNull();
      expect(summary?.text.length ?? 0).toBeGreaterThan(40);
      expect(Object.keys(summary?.meta ?? {}).sort()).toEqual([
        'artifacts',
        'decisions',
        'files',
        'node_ids',
        'open_questions',
        'symbols',
        'tests',
      ]);
    },
  );

  it('the live leaf summary names its child nodes, which are the §9 fetch targets', () => {
    expect(golden.store.currentSummary(LEAF)?.meta.node_ids).toEqual(nodeIdsOf(golden.store, LEAF));
  });

  /**
   * That the split is *reported* — the counters exist, are finite, and are not
   * invented. That it is non-zero when a breakpoint is set is D5's own claim,
   * and `cache.live.test.ts` proves that one with a counterfactual.
   */
  it('reports a real TokenUsage per model, cache split included — §15 measures that split', () => {
    const entries = meter.snapshot().entries;
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      const usage: TokenUsage = entry.usage;
      expect(usage.input).toBeGreaterThan(0);
      expect(usage.output).toBeGreaterThan(0);
      for (const counter of [usage.cacheRead, usage.cacheWrite]) {
        expect(Number.isFinite(counter)).toBe(true);
        expect(counter).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('records a non-zero spend: §16 caps per-PR cost, and a call accounted as free defeats the cap', () => {
    expect(meter.totalUsd()).toBeGreaterThan(0);
    expect(meter.unpricedModels()).toEqual([]);
  });

  it('refuses the next call once the cap is reached, before spending anything (§16)', async () => {
    // Charged with the spend that actually happened above, so the cap trips on
    // real numbers. `assertUnderCap` runs before the provider call, so this
    // test makes no request at all — which is the property being asserted.
    const capped = new InMemoryCostMeter({ capUsd: meter.totalUsd() / 2 });
    for (const entry of meter.snapshot().entries) capped.record(entry.model, entry.usage);
    expect(() => capped.assertUnderCap()).toThrow(CostCapExceededError);

    const summarizer = new Summarizer({
      store: golden.store,
      provider,
      leafModel: config.leafModel,
      rootModel: config.rootModel,
      trace: golden.trace,
      blobs: golden.blobs,
      costMeter: capped,
    });
    const other = BRANCH_IDS[3];
    await expect(summarizer.summarizeLeaf(other)).rejects.toThrow(CostCapExceededError);
    expect(golden.store.currentSummary(other)).toBeNull();
  });
});
