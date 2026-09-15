import { describe, it, expect } from 'vitest';
import { mapFlexUnits, assembleFlex, type FlexEntry } from '../src/assemble/index.js';
import { HeuristicTokenizer } from '../src/tokens/index.js';

const tok = new HeuristicTokenizer();

const entry = (order: number, o: Partial<FlexEntry> & { raw: string }): FlexEntry => ({
  nodeId: o.nodeId ?? `n${order}`,
  order,
  rawText: o.raw,
  summaryText: o.summaryText,
  wrote: o.wrote ?? false,
  lastReferencedTurn: o.lastReferencedTurn,
});

// Recent context is about widgets/prices; unit 0 is off-topic → most dormant.
// NB: extractFingerprints matches camelCase/PascalCase/paths (not snake_case).
const entries: FlexEntry[] = [
  entry(0, { nodeId: 'dormant', raw: 'refactored loggingModule and retryBackoff timers in src/net/retry.ts' }),
  entry(1, { nodeId: 'widgetA', raw: 'the widgetCatalog lists widgetPrice as 13 dollars in src/catalog/widget.ts', wrote: true }),
  entry(2, { nodeId: 'widgetB', raw: 'widgetCatalog note repeats widgetPrice 13 per unit, see src/catalog/widget.ts' }),
];

describe('mapFlexUnits — lexical-only (no embedder)', () => {
  it('produces one FlexUnit per entry, in order, with raw text and fingerprints', async () => {
    const { units } = await mapFlexUnits(entries);
    expect(units.map((u) => u.nodeId)).toEqual(['dormant', 'widgetA', 'widgetB']);
    expect(units[0]!.raw).toContain('loggingModule');
    expect(units[1]!.fingerprints.size).toBeGreaterThan(0);
    expect(units[1]!.wrote).toBe(true);
  });

  it('assigns highest dormancy to the unit most off-topic vs the recent window', async () => {
    // recent window = last 2 units (widgets); the off-topic unit 0 falls outside it.
    const { units } = await mapFlexUnits(entries, { k: 2 });
    const byId = new Map(units.map((u) => [u.nodeId, u.dormancy]));
    expect(byId.get('dormant')!).toBeGreaterThan(byId.get('widgetA')!);
    expect(byId.get('dormant')!).toBeGreaterThan(byId.get('widgetB')!);
  });

  it('emits a retrieval corpus mirroring each unit’s raw text', async () => {
    const { corpus } = await mapFlexUnits(entries);
    expect(corpus.map((c) => c.id)).toEqual(['dormant', 'widgetA', 'widgetB']);
    expect(corpus[0]!.text).toContain('retryBackoff');
  });

  it('empty entries → empty units and corpus', async () => {
    expect(await mapFlexUnits([])).toEqual({ units: [], corpus: [] });
  });
});

describe('mapFlexUnits — with an embedder', () => {
  const VOCAB = ['logging', 'retry', 'widget', 'price', 'dollars'];
  const fakeEmbed = async (texts: readonly string[]): Promise<Float32Array[]> =>
    texts.map((t) => Float32Array.from(VOCAB.map((w) => t.toLowerCase().split(w).length - 1)));

  it('runs the full (semantic + lexical) classifier without crashing and still ranks the off-topic unit dormant', async () => {
    const { units } = await mapFlexUnits(entries, { embed: fakeEmbed });
    const byId = new Map(units.map((u) => [u.nodeId, u.dormancy]));
    expect(byId.get('dormant')!).toBeGreaterThanOrEqual(byId.get('widgetA')!);
    for (const u of units) {
      expect(u.dormancy).toBeGreaterThanOrEqual(0);
      expect(u.dormancy).toBeLessThanOrEqual(1);
    }
  });

  it('throws on a malformed embedder instead of silently degrading to lexical-only', async () => {
    const bad = async (texts: readonly string[]): Promise<Float32Array[]> =>
      texts.slice(1).map(() => Float32Array.from([1])); // one short
    await expect(mapFlexUnits(entries, { embed: bad })).rejects.toThrow();
  });
});

describe('mapFlexUnits → assembleFlex end to end', () => {
  it('the mapped units assemble into a flex prompt (dormant unit evicted first at the hard limit)', async () => {
    const bulk = 'context '.repeat(60);
    const wide: FlexEntry[] = [
      entry(0, { nodeId: 'dormant', raw: `loggingModule retryBackoff ${bulk}` }),
      entry(1, { nodeId: 'widgetA', raw: `widgetCatalog widgetPrice ${bulk}`, wrote: true }),
      entry(2, { nodeId: 'widgetB', raw: `widgetCatalog priceNote ${bulk}` }),
      entry(3, { nodeId: 'active', raw: `widgetCatalog currentWork ${bulk}` }),
    ];
    const { units } = await mapFlexUnits(wide);
    // The cap must BIND: eviction now fires at the hard limit (window − replyReserve),
    // not at a fraction of the window. See report-cadence-confound.md.
    const prompt = assembleFlex({ system: 'S', userPrompts: ['do the widget task'] }, units, tok, {
      window: 400,
      replyReserve: 200,
      softTargetFrac: 0.5,
      anchor: 1,
    });
    const kept = prompt.blocks.filter((b) => b.zone === 'flex').map((b) => b.nodeId);
    expect(kept).toContain('active'); // anchor kept
    expect(kept).not.toContain('dormant'); // most-dormant, low-priority unit evicted
    expect(prompt.blocks.some((b) => b.zone === 'head')).toBe(true);
  });
});
