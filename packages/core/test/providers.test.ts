/**
 * §9.1 retrieval backends. Two properties are load-bearing and everything here
 * protects one of them: the merge is deterministic (D13/§19 Q6 — reproducible
 * rankings), and no provider can hard-fail a query (§18 last row).
 *
 * No real graft, no real `rg`, no network: every backend takes an injected
 * runner, client or fetch.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  Candidate,
  Content,
  ProviderTier,
  RetrievalProvider,
  SearchQuery,
} from '../src/contracts/index.js';
import {
  AugmentProvider,
  GraftProvider,
  GrepProvider,
  ProviderRegistry,
  SerenaProvider,
  execFileRunner,
  mergeCandidates,
  readFileSpan,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  type ProviderOutcome,
} from '../src/providers/index.js';

// --- fixtures -------------------------------------------------------------

interface RecordedCall {
  file: string;
  args: readonly string[];
  options: CommandOptions;
}

function recordingRunner(
  reply: (call: RecordedCall) => Partial<CommandResult> = () => ({}),
): { run: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = async (file, args, options) => {
    const call: RecordedCall = { file, args, options };
    calls.push(call);
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...reply(call) };
  };
  return { run, calls };
}

function hit(provider: string, tier: ProviderTier, path: string, start: number, score: number): Candidate {
  return { path, span: { start_line: start, end_line: start + 4 }, score, provider, tier };
}

function outcome(provider: string, tier: ProviderTier, candidates: Candidate[]): ProviderOutcome {
  return { provider, tier, candidates };
}

class StubProvider implements RetrievalProvider {
  probes = 0;
  searches = 0;

  constructor(
    readonly id: string,
    readonly tier: ProviderTier,
    private readonly plan: {
      available?: boolean | 'throw' | 'hang';
      search?: Candidate[] | 'throw' | 'hang';
      delayMs?: number;
    } = {},
  ) {}

  async available(): Promise<boolean> {
    this.probes++;
    if (this.plan.available === 'throw') throw new Error(`${this.id}: probe blew up`);
    if (this.plan.available === 'hang') return new Promise<boolean>(() => undefined);
    return this.plan.available ?? true;
  }

  async search(): Promise<Candidate[]> {
    this.searches++;
    if (this.plan.search === 'throw') throw new Error(`${this.id}: search blew up`);
    if (this.plan.search === 'hang') return new Promise<Candidate[]>(() => undefined);
    const delay = this.plan.delayMs;
    if (delay !== undefined) await new Promise<void>((done) => setTimeout(() => done(), delay));
    return this.plan.search ?? [];
  }

  async hydrate(ref: Candidate): Promise<Content> {
    return { text: `${this.id} hydrated ${ref.path ?? ''}`, provider: this.id, truncated: false };
  }
}

const RANKED: SearchQuery = { query: 'resolveConfig' };
const EXHAUSTIVE: SearchQuery = { query: 'resolveConfig', mode: 'exhaustive' };

/** A model-authored query is the threat model for every shelling provider. */
const DANGEROUS = '; rm -rf / `whoami` $(id) && echo pwned';

// --- merge ----------------------------------------------------------------

describe('mergeCandidates — §9.1 deterministic merge policy', () => {
  it('orders structural above fuzzy above grep, because §9.1 rules 1-3 make graph edges outrank similarity', () => {
    const merged = mergeCandidates(
      [
        outcome('grep', 'fallback', [hit('grep', 'fallback', 'c.ts', 1, 1)]),
        outcome('augment', 'fuzzy', [hit('augment', 'fuzzy', 'b.ts', 1, 0.99)]),
        outcome('graft', 'structural', [hit('graft', 'structural', 'a.ts', 1, 0.01)]),
      ],
      RANKED,
    );
    expect(merged.candidates.map((c) => c.provider)).toEqual(['graft', 'augment', 'grep']);
  });

  it('puts grep FIRST in exhaustive mode, because §9.1 rule 3 makes completeness authoritative there', () => {
    const outcomes = [
      outcome('graft', 'structural', [hit('graft', 'structural', 'a.ts', 1, 1)]),
      outcome('augment', 'fuzzy', [hit('augment', 'fuzzy', 'b.ts', 1, 1)]),
      outcome('grep', 'fallback', [hit('grep', 'fallback', 'c.ts', 1, 1)]),
    ];
    expect(mergeCandidates(outcomes, EXHAUSTIVE).candidates.map((c) => c.provider)).toEqual([
      'grep',
      'graft',
      'augment',
    ]);
    // The same inputs in ranked mode must NOT reorder: only `mode` flips it.
    expect(mergeCandidates(outcomes, RANKED).candidates.map((c) => c.provider)).toEqual([
      'graft',
      'augment',
      'grep',
    ]);
  });

  it('dedups by (path, span) keeping the structural hit and counting the fuzzy duplicate as dropped', () => {
    const merged = mergeCandidates(
      [
        outcome('augment', 'fuzzy', [hit('augment', 'fuzzy', 'src/a.ts', 10, 0.9)]),
        outcome('graft', 'structural', [hit('graft', 'structural', 'src/a.ts', 10, 0.1)]),
      ],
      RANKED,
    );
    expect(merged.candidates).toHaveLength(1);
    expect(merged.candidates[0]?.provider).toBe('graft');
    expect(merged.contributions).toEqual([
      { provider: 'augment', tier: 'fuzzy', kept: 0, dropped: 1 },
      { provider: 'graft', tier: 'structural', kept: 1, dropped: 0 },
    ]);
  });

  it('does not dedup two different spans in the same file, because (path, span) is the key and not path alone', () => {
    const merged = mergeCandidates(
      [outcome('graft', 'structural', [hit('graft', 'structural', 'a.ts', 1, 1), hit('graft', 'structural', 'a.ts', 40, 0.5)])],
      RANKED,
    );
    expect(merged.candidates).toHaveLength(2);
  });

  it('keeps kept + dropped equal to what each provider supplied, because the eval harness reads tier contribution from it', () => {
    const graftHits = [hit('graft', 'structural', 'a.ts', 1, 1), hit('graft', 'structural', 'b.ts', 1, 0.5)];
    const augmentHits = [
      hit('augment', 'fuzzy', 'a.ts', 1, 0.9), // duplicate of graft's
      hit('augment', 'fuzzy', 'z.ts', 1, 0.8),
    ];
    const merged = mergeCandidates(
      [outcome('graft', 'structural', graftHits), outcome('augment', 'fuzzy', augmentHits)],
      RANKED,
    );
    const supplied = new Map([
      ['graft', graftHits.length],
      ['augment', augmentHits.length],
    ]);
    for (const row of merged.contributions) {
      expect(row.kept + row.dropped).toBe(supplied.get(row.provider));
    }
    expect(merged.contributions.reduce((sum, row) => sum + row.kept, 0)).toBe(merged.candidates.length);
  });

  it('counts limit-truncated hits as dropped, so the arithmetic never loses a candidate', () => {
    const merged = mergeCandidates(
      [outcome('graft', 'structural', [hit('graft', 'structural', 'a.ts', 1, 1), hit('graft', 'structural', 'b.ts', 1, 0.5)])],
      { query: 'x', limit: 1 },
    );
    expect(merged.candidates).toHaveLength(1);
    expect(merged.contributions[0]).toEqual({ provider: 'graft', tier: 'structural', kept: 1, dropped: 1 });
  });

  it('ranks by the registered tier, not the tier a candidate claims, so a mislabelled hit cannot jump the merge order', () => {
    const liar: Candidate = { ...hit('augment', 'fuzzy', 'liar.ts', 1, 1), tier: 'structural' };
    const merged = mergeCandidates(
      [outcome('augment', 'fuzzy', [liar]), outcome('graft', 'structural', [hit('graft', 'structural', 'real.ts', 1, 0.01)])],
      RANKED,
    );
    expect(merged.candidates.map((c) => c.path)).toEqual(['real.ts', 'liar.ts']);
  });

  it('produces byte-identical output twice, and the same output whatever order the providers were listed in', () => {
    const outcomes = [
      outcome('graft', 'structural', [hit('graft', 'structural', 'a.ts', 1, 1), hit('graft', 'structural', 'b.ts', 7, 1)]),
      outcome('serena', 'structural', [hit('serena', 'structural', 'a.ts', 1, 1)]),
      outcome('augment', 'fuzzy', [hit('augment', 'fuzzy', 'c.ts', 3, 0.4)]),
      outcome('grep', 'fallback', [hit('grep', 'fallback', 'd.ts', 9, 0.2)]),
    ];
    const first = JSON.stringify(mergeCandidates(outcomes, RANKED));
    const second = JSON.stringify(mergeCandidates(outcomes, RANKED));
    const reversed = JSON.stringify(mergeCandidates([...outcomes].reverse(), RANKED));
    expect(second).toBe(first);
    expect(reversed).toBe(first);
  });

  it('breaks a same-tier tie on provider id before score, because Candidate.score is documented as provider-local', () => {
    const merged = mergeCandidates(
      [
        outcome('serena', 'structural', [hit('serena', 'structural', 'z.ts', 1, 0.99)]),
        outcome('graft', 'structural', [hit('graft', 'structural', 'a.ts', 1, 0.01)]),
      ],
      RANKED,
    );
    expect(merged.candidates.map((c) => c.provider)).toEqual(['graft', 'serena']);
  });

  it('lists unavailable providers and ignores their candidates wholesale, because half an answer is worse than none', () => {
    const merged = mergeCandidates(
      [
        { provider: 'serena', tier: 'structural', candidates: [hit('serena', 'structural', 'partial.ts', 1, 1)], unavailable: true },
        outcome('grep', 'fallback', [hit('grep', 'fallback', 'ok.ts', 1, 1)]),
      ],
      RANKED,
    );
    expect(merged.unavailable).toEqual(['serena']);
    expect(merged.candidates.map((c) => c.path)).toEqual(['ok.ts']);
    expect(merged.contributions.map((row) => row.provider)).toEqual(['grep']);
  });

  it('dedups vector hits on node_id and never collapses two candidates that identify nothing', () => {
    const node = { node_id: 'n_01', score: 1, provider: 'vector', tier: 'fuzzy' as ProviderTier };
    const anonymous = { score: 1, provider: 'vector', tier: 'fuzzy' as ProviderTier };
    const merged = mergeCandidates(
      [outcome('vector', 'fuzzy', [node, { ...node, score: 0.5 }, anonymous, { ...anonymous }])],
      RANKED,
    );
    expect(merged.candidates.filter((c) => c.node_id !== undefined)).toHaveLength(1);
    expect(merged.candidates.filter((c) => c.node_id === undefined)).toHaveLength(2);
  });
});

// --- registry -------------------------------------------------------------

describe('ProviderRegistry — §9.1 fan-out', () => {
  it('probes available() exactly once and caches it, because a probe per query puts shelling out on the model critical path', async () => {
    const graft = new StubProvider('graft', 'structural');
    const registry = new ProviderRegistry([graft]);
    await registry.search(RANKED);
    await registry.search(RANKED);
    await registry.init();
    expect(graft.probes).toBe(1);
    expect(graft.searches).toBe(2);
  });

  it('shares one probe round between concurrent first queries, so the cache cannot be raced', async () => {
    const graft = new StubProvider('graft', 'structural');
    const registry = new ProviderRegistry([graft]);
    await Promise.all([registry.search(RANKED), registry.search(RANKED), registry.init()]);
    expect(graft.probes).toBe(1);
  });

  it('records a provider that throws in unavailable and still returns the others, because §18 forbids a hard fail', async () => {
    const registry = new ProviderRegistry([
      new StubProvider('graft', 'structural', { search: 'throw' }),
      new StubProvider('grep', 'fallback', { search: [hit('grep', 'fallback', 'ok.ts', 1, 1)] }),
    ]);
    const merged = await registry.search(RANKED);
    expect(merged.unavailable).toEqual(['graft']);
    expect(merged.candidates.map((c) => c.path)).toEqual(['ok.ts']);
  });

  it('records a provider that hangs past its search timeout in unavailable, never a crash', async () => {
    const registry = new ProviderRegistry(
      [
        new StubProvider('serena', 'structural', { search: 'hang' }),
        new StubProvider('grep', 'fallback', { search: [hit('grep', 'fallback', 'ok.ts', 1, 1)] }),
      ],
      { searchTimeoutMs: 25 },
    );
    const merged = await registry.search(RANKED);
    expect(merged.unavailable).toEqual(['serena']);
    expect(merged.candidates).toHaveLength(1);
  });

  it('records a provider whose probe hangs or throws in unavailable and never calls its search', async () => {
    const hanging = new StubProvider('serena', 'structural', { available: 'hang' });
    const throwing = new StubProvider('augment', 'fuzzy', { available: 'throw' });
    const refusing = new StubProvider('graft', 'structural', { available: false });
    const registry = new ProviderRegistry([hanging, throwing, refusing], { probeTimeoutMs: 25 });
    const merged = await registry.search(RANKED);
    expect(merged.unavailable).toEqual(['augment', 'graft', 'serena']);
    expect([hanging.searches, throwing.searches, refusing.searches]).toEqual([0, 0, 0]);
  });

  it('produces the same result whichever provider settles first, because §9.1 must not depend on settle order', async () => {
    const build = (graftDelay: number, grepDelay: number): ProviderRegistry =>
      new ProviderRegistry([
        new StubProvider('graft', 'structural', { search: [hit('graft', 'structural', 'a.ts', 1, 1)], delayMs: graftDelay }),
        new StubProvider('grep', 'fallback', { search: [hit('grep', 'fallback', 'b.ts', 1, 1)], delayMs: grepDelay }),
      ]);
    const graftLast = JSON.stringify(await build(30, 0).search(RANKED));
    const grepLast = JSON.stringify(await build(0, 30).search(RANKED));
    expect(grepLast).toBe(graftLast);
  });

  it('routes hydrate to the provider that produced the candidate, which is what makes context_fetch resolvable', async () => {
    const registry = new ProviderRegistry([new StubProvider('graft', 'structural'), new StubProvider('grep', 'fallback')]);
    const content = await registry.hydrate(hit('grep', 'fallback', 'x.ts', 1, 1));
    expect(content.text).toBe('grep hydrated x.ts');
    await expect(registry.hydrate(hit('ghost', 'fuzzy', 'x.ts', 1, 1))).rejects.toThrow(/no registered provider/);
  });
});

// --- graft ----------------------------------------------------------------

const GRAFT_ASK = [
  '[graft] refreshed the graph (49 files changed) before answering',
  'graft ask — "resolveConfig"  (lexical)',
  '',
  '1. resolveConfig · function  [symbol]',
  '   packages/core/src/config.ts:L127-L156',
  '   function resolveConfig( partial, cwd ): ContextTreeConfig',
  '',
  '2. loadConfig · function  [symbol]',
  '   packages/core/src/config.ts:L159-L177',
  '',
].join('\n');

const GRAFT_GREP = [
  '"resolveConfig" — 12 hits in 5 symbols across 3 files (searched 49 indexed files)',
  '',
  'resolveConfig · function · packages/core/src/config.ts:L127-L156 · 3 in-edges',
  '  L127: export function resolveConfig(',
  '',
  'loadConfig · function · packages/core/src/config.ts:L159-L177 · 1 in-edges',
  '  L165: return resolveConfig({}, cwd);',
  '',
].join('\n');

describe('GraftProvider — §9.1 structural', () => {
  it('parses `graft ask --source` into path/span/symbol coordinates, which is what makes a rehydration pointer trustworthy', async () => {
    const { run } = recordingRunner(() => ({ stdout: GRAFT_ASK }));
    const candidates = await new GraftProvider({ run, cwd: '/repo' }).search(RANKED);
    expect(candidates).toEqual([
      {
        path: 'packages/core/src/config.ts',
        span: { start_line: 127, end_line: 156 },
        symbol: 'resolveConfig',
        score: 1,
        provider: 'graft',
        tier: 'structural',
      },
      {
        path: 'packages/core/src/config.ts',
        span: { start_line: 159, end_line: 177 },
        symbol: 'loadConfig',
        score: 0.5,
        provider: 'graft',
        tier: 'structural',
      },
    ]);
  });

  it('parses the `graft grep`, `graft callers` and `covers:` span forms, because all three are §9.1 graft entry points', async () => {
    const grep = await new GraftProvider({ run: recordingRunner(() => ({ stdout: GRAFT_GREP })).run }).search(EXHAUSTIVE);
    expect(grep.map((c) => [c.symbol, c.span?.start_line])).toEqual([
      ['resolveConfig', 127],
      ['loadConfig', 159],
    ]);

    const callersOut = [
      'resolveConfig · function · packages/core/src/config.ts:L127-L156',
      '  calls ← loadConfig (packages/core/src/config.ts:L159-L177)',
    ].join('\n');
    const callers = await new GraftProvider({ run: recordingRunner(() => ({ stdout: callersOut })).run }).callers('resolveConfig');
    expect(callers.map((c) => c.symbol)).toEqual(['resolveConfig', 'loadConfig']);

    const covers = await new GraftProvider({ run: recordingRunner(() => ({ stdout: '   covers: src/a.ts:L10-L20' })).run }).search(RANKED);
    expect(covers[0]?.span).toEqual({ start_line: 10, end_line: 20 });
  });

  it('ignores a file:line mention inside an inlined source snippet, so a snippet cannot fabricate a coordinate', async () => {
    const stdout = [
      '1. handler · function  [symbol]',
      '   src/a.ts:L1-L9',
      '```',
      '  const url = "http://cdn/x/other.ts:99";',
      '```',
    ].join('\n');
    const candidates = await new GraftProvider({ run: recordingRunner(() => ({ stdout })).run }).search(RANKED);
    expect(candidates.map((c) => c.path)).toEqual(['src/a.ts']);
  });

  it('maps exhaustive to `graft grep` and ranked to `graft ask --source`, because D13 says that split is graft own', async () => {
    const { run, calls } = recordingRunner();
    const provider = new GraftProvider({ run, cwd: '/repo' });
    await provider.search(RANKED);
    await provider.search({ query: 'x', mode: 'exhaustive' });
    await provider.search({ query: 'x', scope: 'packages/core/' });
    expect(calls.map((call) => call.args)).toEqual([
      ['ask', 'resolveConfig', '--source'],
      ['grep', 'x'],
      ['ask', 'x', '--source', '--in', 'packages/core/'],
    ]);
  });

  it('passes a shell-metacharacter query as ONE argv element with no interpolation, because a model query reaching a shell is an injection hole', async () => {
    const { run, calls } = recordingRunner();
    await new GraftProvider({ run }).search({ query: DANGEROUS });
    const args = calls[0]?.args;
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(['ask', DANGEROUS, '--source']);
    // Nothing was concatenated into a command string anywhere in argv.
    expect(args?.some((arg) => arg.includes('ask ') || arg.includes('graft '))).toBe(false);
    expect(calls[0]?.file).toBe('graft');
  });

  it('enforces a timeout and a maxBuffer on every spawn, because a hung provider must degrade and not hang the agent', async () => {
    const { run, calls } = recordingRunner();
    await new GraftProvider({ run, timeoutMs: 1234, maxBuffer: 4096, cwd: '/repo' }).search(RANKED);
    expect(calls[0]?.options).toEqual({ cwd: '/repo', timeoutMs: 1234, maxBuffer: 4096 });
  });

  it('reports unavailable rather than throwing when graft is absent or its probe times out (§18 last row)', async () => {
    const absent = new GraftProvider({ run: recordingRunner(() => ({ exitCode: null, spawnCode: 'ENOENT' })).run });
    const hung = new GraftProvider({ run: recordingRunner(() => ({ exitCode: null, timedOut: true })).run });
    const throwing = new GraftProvider({
      run: async () => {
        throw new Error('spawn exploded');
      },
    });
    const present = new GraftProvider({ run: recordingRunner(() => ({ stdout: '0.8.2' })).run });
    expect(await absent.available()).toBe(false);
    expect(await hung.available()).toBe(false);
    expect(await throwing.available()).toBe(false);
    expect(await present.available()).toBe(true);
  });

  it('treats a non-zero exit that still produced output as an answer, because graft exits non-zero on an empty query', async () => {
    const withOutput = new GraftProvider({ run: recordingRunner(() => ({ exitCode: 2, stdout: '   src/a.ts:L1-L2' })).run });
    await expect(withOutput.search(RANKED)).resolves.toHaveLength(1);
    const withNothing = new GraftProvider({ run: recordingRunner(() => ({ exitCode: 2, stderr: 'boom' })).run });
    await expect(withNothing.search(RANKED)).rejects.toThrow(/graft ask failed/);
  });
});

// --- serena ---------------------------------------------------------------

describe('SerenaProvider — structural, injected client only', () => {
  it('is unavailable with no injected client, because declaring an LSP we cannot reach is worse than declaring it absent', async () => {
    const provider = new SerenaProvider();
    expect(await provider.available()).toBe(false);
    await expect(provider.search(RANKED)).rejects.toThrow(/no client injected/);
  });

  it('calls find_symbol with the query as name_path and normalizes the MCP text envelope into candidates', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = new SerenaProvider({
      client: {
        callTool: async (name, args) => {
          calls.push({ name, args });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify([
                  { name_path: 'resolveConfig', relative_path: 'src/config.ts', body_location: { start_line: 127, end_line: 156 } },
                ]),
              },
            ],
          };
        },
      },
    });
    expect(await provider.available()).toBe(true);
    const candidates = await provider.search({ query: 'resolveConfig', scope: 'src/' });
    expect(calls).toEqual([{ name: 'find_symbol', args: { name_path: 'resolveConfig', relative_path: 'src/' } }]);
    expect(candidates[0]).toEqual({
      path: 'src/config.ts',
      span: { start_line: 127, end_line: 156 },
      symbol: 'resolveConfig',
      score: 1,
      provider: 'serena',
      tier: 'structural',
    });

    await provider.referencingSymbols('resolveConfig', 'src/config.ts');
    expect(calls[1]?.name).toBe('find_referencing_symbols');
  });

  it('skips entries it cannot read instead of failing the query, because a Serena shape change is a lost hit and not an outage', async () => {
    const provider = new SerenaProvider({
      client: {
        callTool: async () => ({
          content: [
            { type: 'text', text: 'Serena narrating in prose, not JSON' },
            { type: 'text', text: JSON.stringify([{ unrecognized: true }, { path: 'src/b.ts', line: 4 }]) },
          ],
        }),
      },
    });
    const candidates = await provider.search(RANKED);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.span).toEqual({ start_line: 4, end_line: 4 });
  });
});

// --- augment --------------------------------------------------------------

describe('AugmentProvider — fuzzy, HTTP', () => {
  it('is unavailable without a token and makes NO request while unconfigured, because a startup probe that dials out is a latency and privacy bug', async () => {
    let requests = 0;
    const provider = new AugmentProvider({
      env: {},
      fetch: async () => {
        requests++;
        throw new Error('the probe must never reach the network');
      },
    });
    expect(await provider.available()).toBe(false);
    expect(requests).toBe(0);
    await expect(provider.search(RANKED)).rejects.toThrow(/not configured/);
    expect(requests).toBe(0);
  });

  it('reads its endpoint and token from the environment and sends the token as a bearer header', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const provider = new AugmentProvider({
      env: { AUGMENT_API_URL: 'https://augment.example/context', AUGMENT_API_TOKEN: 'tok-123' },
      fetch: async (url, init) => {
        seen.push({ url, headers: init.headers, body: init.body });
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [{ path: 'src/a.ts', range: { start_line: 3, end_line: 9 }, score: 0.42, snippet: 'const a = 1;' }] }),
          text: async () => '',
        };
      },
    });
    expect(await provider.available()).toBe(true);
    const candidates = await provider.search({ query: 'where is a', limit: 5 });
    expect(seen[0]?.url).toBe('https://augment.example/context');
    expect(seen[0]?.headers.authorization).toBe('Bearer tok-123');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ query: 'where is a', mode: 'ranked', limit: 5, scope: null });
    expect(candidates[0]).toEqual({
      path: 'src/a.ts',
      span: { start_line: 3, end_line: 9 },
      snippet: 'const a = 1;',
      score: 0.42,
      provider: 'augment',
      tier: 'fuzzy',
    });
  });

  it('throws on a non-2xx so the registry records it unavailable rather than returning a silently empty answer', async () => {
    const provider = new AugmentProvider({
      apiUrl: 'https://augment.example/context',
      apiToken: 'tok',
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => 'down' }),
    });
    await expect(provider.search(RANKED)).rejects.toThrow(/HTTP 503/);
  });

  it('hydrates from the snippet it already returned, marked truncated, instead of paying a second round trip', async () => {
    let requests = 0;
    const provider = new AugmentProvider({
      apiUrl: 'u',
      apiToken: 't',
      fetch: async () => {
        requests++;
        return { ok: true, status: 200, json: async () => [], text: async () => '' };
      },
    });
    const content = await provider.hydrate({ path: 'a.ts', snippet: 'const a = 1;', score: 1, provider: 'augment', tier: 'fuzzy' });
    expect(content).toEqual({ text: 'const a = 1;', path: 'a.ts', span: undefined, provider: 'augment', truncated: true });
    expect(requests).toBe(0);
  });
});

// --- grep -----------------------------------------------------------------

function repoFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ct-providers-'));
  mkdirSync(join(root, 'repo', 'sub'), { recursive: true });
  mkdirSync(join(root, 'repo', 'node_modules'), { recursive: true });
  mkdirSync(join(root, 'outside'), { recursive: true });
  writeFileSync(join(root, 'repo', 'a.ts'), 'needle here\nnothing\n', 'utf8');
  writeFileSync(join(root, 'repo', 'sub', 'b.ts'), 'nope\nneedle again\n', 'utf8');
  writeFileSync(join(root, 'repo', 'node_modules', 'c.ts'), 'needle in a dependency\n', 'utf8');
  writeFileSync(join(root, 'outside', 'secret.ts'), 'needle outside the repo\n', 'utf8');
  return root;
}

const RG_ABSENT: CommandRunner = async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: false, spawnCode: 'ENOENT' });

describe('GrepProvider — fallback, always available', () => {
  it('is available even when its binary is not, because §9.1 guarantees GrepProvider is always there', async () => {
    expect(await new GrepProvider({ run: RG_ABSENT }).available()).toBe(true);
  });

  it('answers through the node-builtin walker with no rg present, skipping node_modules, so the guarantee is real and not nominal', async () => {
    const root = repoFixture();
    const candidates = await new GrepProvider({ cwd: join(root, 'repo'), run: RG_ABSENT }).search({ query: 'needle' });
    expect(candidates.map((c) => [c.path, c.span?.start_line])).toEqual([
      ['a.ts', 1],
      [join('sub', 'b.ts'), 2],
    ]);
    expect(candidates.every((c) => c.provider === 'grep' && c.tier === 'fallback')).toBe(true);
  });

  it('treats the query as a literal in ranked mode and as a regex only in exhaustive mode, because a model query is prose', async () => {
    const root = repoFixture();
    const provider = new GrepProvider({ cwd: join(root, 'repo'), run: RG_ABSENT });
    expect(await provider.search({ query: 'ne+dle' })).toHaveLength(0);
    expect(await provider.search({ query: 'ne+dle', mode: 'exhaustive' })).toHaveLength(2);
    // An unparseable pattern degrades to a literal instead of un-availing the
    // one provider §9.1 promises is always there.
    expect(await provider.search({ query: 'needle(', mode: 'exhaustive' })).toHaveLength(0);
  });

  it('never lets a ../ scope escape the repo root, because scope is model-supplied too', async () => {
    const root = repoFixture();
    const candidates = await new GrepProvider({ cwd: join(root, 'repo'), run: RG_ABSENT }).search({
      query: 'needle',
      scope: '../outside',
    });
    expect(candidates.map((c) => c.path)).not.toContain(join('..', 'outside', 'secret.ts'));
    expect(candidates.map((c) => c.path)).toEqual(['a.ts', join('sub', 'b.ts')]);
  });

  it('passes the query to rg in its own argv slot with --fixed-strings only in ranked mode, so metacharacters are never a shell or a flag', async () => {
    const { run, calls } = recordingRunner(() => ({ stdout: '' }));
    const provider = new GrepProvider({ run, cwd: '/repo' });
    await provider.search({ query: DANGEROUS });
    await provider.search({ query: 'a.+b', mode: 'exhaustive', scope: 'src' });
    expect(calls[0]?.args).toEqual([
      '--line-number', '--no-heading', '--with-filename', '--color', 'never', '--fixed-strings', '--regexp', DANGEROUS,
    ]);
    expect(calls[1]?.args).toEqual([
      '--line-number', '--no-heading', '--with-filename', '--color', 'never', '--regexp', 'a.+b', '--', 'src',
    ]);
    expect(calls[0]?.options.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.options.maxBuffer).toBeGreaterThan(0);
  });

  it('parses rg output and treats exit 1 as "no matches", because that is an answer and not a failure', async () => {
    const stdout = 'src/a.ts:12:  const needle = 1;\n./src/b.ts:3:needle\n';
    const parsed = await new GrepProvider({ run: recordingRunner(() => ({ stdout })).run }).search({ query: 'needle' });
    expect(parsed).toEqual([
      { path: 'src/a.ts', span: { start_line: 12, end_line: 12 }, snippet: 'const needle = 1;', score: 1, provider: 'grep', tier: 'fallback' },
      { path: 'src/b.ts', span: { start_line: 3, end_line: 3 }, snippet: 'needle', score: 0.5, provider: 'grep', tier: 'fallback' },
    ]);
    const empty = await new GrepProvider({ run: recordingRunner(() => ({ exitCode: 1 })).run }).search({ query: 'needle' });
    expect(empty).toEqual([]);
  });

  it('falls back to the walker when rg errors or is killed by its timeout, rather than reporting zero hits', async () => {
    const root = repoFixture();
    const killed = new GrepProvider({ cwd: join(root, 'repo'), run: recordingRunner(() => ({ exitCode: null, timedOut: true })).run });
    expect(await killed.search({ query: 'needle' })).toHaveLength(2);
    const errored = new GrepProvider({ cwd: join(root, 'repo'), run: recordingRunner(() => ({ exitCode: 2, stderr: 'bad pattern' })).run });
    expect(await errored.search({ query: 'needle' })).toHaveLength(2);
  });
});

// --- shell + hydrate ------------------------------------------------------

describe('execFileRunner — argv, never a shell', () => {
  it('passes `; rm -rf /`, backticks and $(...) through as one literal argument, which is the whole reason execFile takes an array', async () => {
    const result = await execFileRunner('/bin/echo', [DANGEROUS], { cwd: tmpdir(), timeoutMs: 5_000, maxBuffer: 64 * 1024 });
    // A shell would have run `whoami`/$(id) and swallowed the `;`. Byte
    // equality proves no shell ever saw the string.
    expect(result.stdout).toBe(`${DANGEROUS}\n`);
    expect(result.exitCode).toBe(0);
  });

  it('reports a missing binary as spawnCode ENOENT instead of throwing, so "not installed" is a capability answer', async () => {
    const result = await execFileRunner('context-tree-no-such-binary', [], { cwd: tmpdir(), timeoutMs: 5_000, maxBuffer: 1024 });
    expect(result.spawnCode).toBe('ENOENT');
    expect(result.exitCode).toBeNull();
  });

  it('reports its own timeout kill as timedOut instead of throwing, so a hung tool degrades the provider and nothing else', async () => {
    const result = await execFileRunner(process.execPath, ['-e', 'setTimeout(() => undefined, 10000)'], {
      cwd: tmpdir(),
      timeoutMs: 250,
      maxBuffer: 1024,
    });
    expect(result.timedOut).toBe(true);
  });
});

describe('readFileSpan — shared hydration', () => {
  it('returns exactly the requested inclusive line range, because a rehydration pointer that drifts is worse than none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-hydrate-'));
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\nthree\nfour\n', 'utf8');
    const content = await readFileSpan('graft', { path: 'a.ts', span: { start_line: 2, end_line: 3 }, score: 1, provider: 'graft', tier: 'structural' }, root);
    expect(content).toEqual({
      text: 'two\nthree',
      path: 'a.ts',
      span: { start_line: 2, end_line: 3 },
      provider: 'graft',
      truncated: false,
    });
  });

  it('refuses a candidate path that escapes the repo root, because a Candidate round-trips through the model before context_fetch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-hydrate-'));
    const escaping: Candidate = { path: '../../etc/passwd', score: 1, provider: 'grep', tier: 'fallback' };
    await expect(readFileSpan('grep', escaping, root)).rejects.toThrow(/outside the repo root/);
    await expect(readFileSpan('grep', { score: 1, provider: 'grep', tier: 'fallback' }, root)).rejects.toThrow(/no path/);
  });

  it('marks only the byte cap as truncated, because clamping a span to EOF loses nothing the caller asked for', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-hydrate-'));
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\n', 'utf8');
    const clamped = await readFileSpan('grep', { path: 'a.ts', span: { start_line: 1, end_line: 900 }, score: 1, provider: 'grep', tier: 'fallback' }, root);
    expect(clamped.truncated).toBe(false);
    const capped = await readFileSpan('grep', { path: 'a.ts', score: 1, provider: 'grep', tier: 'fallback' }, root, 3);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toBe('one');
  });
});
