/**
 * §9 tool-surface tests. Every case here protects a rule the plan states:
 * the four-tool set (Zone A is frozen, D5), the mode gate on L0 writes
 * (D14 / ruling C9), the "unknown id is a normal model mistake" failure design,
 * and §9.1's fixed structural-before-fuzzy merge order.
 *
 * No network anywhere: the embedder is a stub, the providers are fakes, and the
 * server is exercised over an in-memory transport.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProviderRegistry,
  TreeRetriever,
  ingest,
  openTaskStore,
  resolveConfig,
  systemContract,
  type Candidate,
  type ContextTreeConfig,
  type NodeId,
  type ProviderTier,
  type RetrievalProvider,
  type SummaryMeta,
  type TaskStore,
  type TreeNode,
} from '@context-tree/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ANNOTATE,
  CONTEXT_FETCH,
  CONTEXT_PEEK,
  CONTEXT_SEARCH,
  CONTRACT_PROMPT,
  HANDLERS,
  MAX_PEEK_CHARS,
  TOOL_NAMES,
  annotate,
  contextFetch,
  contextPeek,
  contextSearch,
  createServer,
} from '@context-tree/mcp';
import type { ContextFetchData, ContextPeekData, ContextSearchData, ToolContext, ToolOutcome } from '@context-tree/mcp';

// ── fixture ────────────────────────────────────────────────────────────────

const TS = '2026-01-01T00:00:00.000Z';

const PRICING_V2 = [
  'export function price(cents: number): number {',
  '  return Math.round(cents * 1.08);',
  '}',
].join('\n');

const temps: string[] = [];
const handles: TaskStore[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
  while (temps.length > 0) rmSync(temps.pop() ?? '', { recursive: true, force: true });
});

function emptyMeta(overrides: Partial<SummaryMeta> = {}): SummaryMeta {
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

interface Fixture {
  config: ContextTreeConfig;
  handle: TaskStore;
  retriever: TreeRetriever;
  root: TreeNode;
  /** The implementation phase — the branch that edited `src/pricing.ts`. */
  implementation: TreeNode;
  /** A phase whose summary is about something else entirely — the ranking control. */
  unrelated: TreeNode;
  fileNode: TreeNode;
}

/**
 * A three-phase trace (diagnosis -> implementation -> verification) with a real
 * file edit, ingested through core's own hermetic path so the tree under test
 * is the tree ingestion actually produces.
 */
function seed(overrides: Partial<ContextTreeConfig> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ct-mcp-'));
  temps.push(root);
  const config = resolveConfig({ root, taskTitle: 'fix pricing rounding', ...overrides });
  const handle = openTaskStore(config);
  handles.push(handle);

  const { blobs, trace, store } = handle;
  trace.appendAll([
    { type: 'user_message', ts: TS, blob: blobs.put('the pricing rounding is off by a cent') },
    { type: 'tool_call', ts: TS, tool: 'Read', path: 'src/pricing.ts', args_blob: blobs.put('{"path":"src/pricing.ts"}') },
    { type: 'tool_result', ts: TS, call_seq: 2, output_blob: blobs.put('export function price(cents: number) { return cents * 1.08; }') },
    { type: 'tool_call', ts: TS, tool: 'Edit', path: 'src/pricing.ts', blob: blobs.put(PRICING_V2) },
    { type: 'tool_result', ts: TS, call_seq: 4, output_blob: blobs.put('edited src/pricing.ts') },
    { type: 'tool_call', ts: TS, tool: 'run_tests', args_blob: blobs.put('{"suite":"pricing"}') },
    { type: 'tool_result', ts: TS, call_seq: 6, output_blob: blobs.put('2 passing, 0 failing') },
    { type: 'assistant_message', ts: TS, blob: blobs.put('rounding fixed, pricing tests pass') },
  ]);
  ingest({ handle });

  const taskNode = store.root();
  if (taskNode === null) throw new Error('fixture produced no root');
  const implementation = store.byKind('phase').find((node) => node.phase_type === 'implementation');
  if (implementation === undefined) throw new Error('fixture produced no implementation phase');
  const fileNode = store.byKind('file').find((node) => node.meta_json.path === 'src/pricing.ts');
  if (fileNode === undefined) throw new Error('fixture produced no file node');

  // §8 summaries, with the rehydration pointers the contract tells the model to read first.
  store.putSummary({
    node_id: taskNode.id,
    model: 'test',
    text: 'Task: fix a rounding bug in pricing and verify it.',
    meta: emptyMeta({ node_ids: [implementation.id] }),
  });
  store.putSummary({
    node_id: implementation.id,
    model: 'test',
    text: 'Rewrote price() in src/pricing.ts to round cents before applying tax.',
    meta: emptyMeta({
      files: [{ path: 'src/pricing.ts', start_line: 1, end_line: 3, symbol: 'price' }],
      symbols: ['price'],
      node_ids: [fileNode.id],
    }),
  });
  for (const phase of store.byKind('phase')) {
    if (phase.id === implementation.id) continue;
    store.putSummary({
      node_id: phase.id,
      model: 'test',
      text: `Phase ${phase.phase_type ?? 'other'}: deployment and release notes, unrelated to pricing.`,
      meta: emptyMeta(),
    });
  }

  const unrelated = store.byKind('phase').find((node) => node.id !== implementation.id);
  if (unrelated === undefined) throw new Error('fixture needs a second phase');

  const retriever = new TreeRetriever({ store, blobs, trace });
  return { config, handle, retriever, root: taskNode, implementation, unrelated, fileNode };
}

function contextFor(fixture: Fixture, extra: Partial<ToolContext> = {}): ToolContext {
  return { config: fixture.config, handle: fixture.handle, retriever: fixture.retriever, ...extra };
}

function unwrap<T>(outcome: ToolOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.data;
}

function expectError<T>(outcome: ToolOutcome<T>): { code: string; message: string } {
  if (outcome.ok) throw new Error('expected a structured error, got success');
  return outcome.error;
}

// ── context_fetch ──────────────────────────────────────────────────────────

describe('context_fetch', () => {
  it("depth 'summary' answers from L1 alone — it reads no L0 span, which is why it is the default", async () => {
    const fixture = seed();
    const data = unwrap(
      (await contextFetch(contextFor(fixture), { branch_id: fixture.implementation.id })) as ToolOutcome<ContextFetchData>,
    );

    expect(data.depth).toBe('summary');
    expect(data.text).toContain('Rewrote price()');
    expect(data.summary_version).toBe(1);
    expect(data.meta?.files[0]?.path).toBe('src/pricing.ts');
    expect(data.spans).toEqual([]);
    expect(data.events).toBe(0);
  });

  it("depth 'full' replays the branch's L0 span through L2, so raw tool payloads reappear", async () => {
    const fixture = seed();
    const data = unwrap(
      (await contextFetch(contextFor(fixture), {
        branch_id: fixture.implementation.id,
        depth: 'full',
      })) as ToolOutcome<ContextFetchData>,
    );

    expect(data.events).toBeGreaterThan(0);
    expect(data.spans.length).toBeGreaterThan(0);
    expect(data.text).toContain('Math.round');
    // A full replay is raw events, not the summary — the two must not be confused.
    expect(data.text).not.toContain('Rewrote price()');
  });

  it('`file` restricts the READ to the file node, not the whole branch filtered afterwards (§10 rule 4)', async () => {
    const fixture = seed();
    const ctx = contextFor(fixture);
    const wholeTask = unwrap(
      (await contextFetch(ctx, { branch_id: fixture.root.id, depth: 'full' })) as ToolOutcome<ContextFetchData>,
    );
    const narrowed = unwrap(
      (await contextFetch(ctx, {
        branch_id: fixture.root.id,
        depth: 'full',
        file: 'src/pricing.ts',
      })) as ToolOutcome<ContextFetchData>,
    );

    expect(narrowed.file).toBe('src/pricing.ts');
    expect(narrowed.nodes).toEqual([fixture.fileNode.id]);
    expect(narrowed.events).toBeLessThan(wholeTask.events);
    expect(narrowed.text).toContain('Math.round');
  });

  it('an unknown branch_id is a normal model mistake: a structured error naming the id, never a throw', async () => {
    const fixture = seed();
    const error = expectError(await contextFetch(contextFor(fixture), { branch_id: 'n_does_not_exist' }));

    expect(error.code).toBe('unknown_node');
    expect(error.message).toContain('n_does_not_exist');
    expect(error.message).toContain('context_search');
  });

  it('a file the branch never touched reports unknown_file naming the path, not an empty success', async () => {
    const fixture = seed();
    const error = expectError(
      await contextFetch(contextFor(fixture), { branch_id: fixture.root.id, file: 'src/nowhere.ts' }),
    );

    expect(error.code).toBe('unknown_file');
    expect(error.message).toContain('src/nowhere.ts');
  });

  it('rejects a malformed argument with invalid_input instead of reaching the store', async () => {
    const fixture = seed();
    const error = expectError(await contextFetch(contextFor(fixture), { branch_id: 7 }));

    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('branch_id');
  });
});

// ── context_search ─────────────────────────────────────────────────────────

/** Deterministic keyword embedder: no network, and the ranking is assertable. */
const DIMS = ['pricing', 'rounding', 'deploy', 'release'] as const;

function keywordVector(text: string): Float32Array {
  const lower = text.toLowerCase();
  // The floor keeps a keyword-free summary from becoming a zero vector, which
  // has no cosine distance to anything.
  const raw = DIMS.map((dim) => 0.01 + (lower.split(dim).length - 1));
  const norm = Math.hypot(...raw);
  return Float32Array.from(raw.map((value) => value / norm));
}

async function keywordEmbedder(texts: readonly string[]): Promise<Float32Array[]> {
  return texts.map(keywordVector);
}

function fakeProvider(
  id: string,
  tier: ProviderTier,
  candidates: Candidate[],
  available = true,
): RetrievalProvider {
  return {
    id,
    tier,
    available: async () => available,
    search: async () => candidates,
    hydrate: async () => ({ text: '', provider: id, truncated: false }),
  };
}

/**
 * Relative rank, not absolute position: the tree also holds the task root and a
 * file node whose titles legitimately match a pricing query. What must hold is
 * that the branch which did the work outranks a branch about something else.
 */
function expectRankedAbove(data: ContextSearchData, better: NodeId, worse: NodeId): void {
  const ranked = data.hits.map((hit) => hit.node_id);
  expect(ranked, `expected ${better} among the hits`).toContain(better);
  expect(ranked.indexOf(better)).toBeLessThan(ranked.includes(worse) ? ranked.indexOf(worse) : ranked.length);
}

describe('context_search', () => {
  it('falls back to beam search over summary text when no embedder is injected, and says so', async () => {
    const fixture = seed();
    const data = unwrap(
      (await contextSearch(contextFor(fixture), { query: 'pricing rounding' })) as ToolOutcome<ContextSearchData>,
    );

    expect(data.path).toBe('beam');
    expect(data.fallback).toBe('no-embedder');
    expectRankedAbove(data, fixture.implementation.id, fixture.unrelated.id);
    // §8's pointers must survive to the model: they are how it judges relevance
    // without paying for a fetch.
    const impl = data.hits.find((hit) => hit.node_id === fixture.implementation.id);
    expect(impl?.meta?.files[0]?.path).toBe('src/pricing.ts');
  });

  it('uses the L3 vector path once summaries are embedded, and ranks by that vector, not by text overlap', async () => {
    const fixture = seed();
    const retriever = new TreeRetriever({
      store: fixture.handle.store,
      blobs: fixture.handle.blobs,
      trace: fixture.handle.trace,
      embed: keywordEmbedder,
    });
    await retriever.embedSummaries();

    const data = unwrap(
      (await contextSearch(contextFor(fixture, { retriever }), {
        query: 'rounding in pricing',
      })) as ToolOutcome<ContextSearchData>,
    );

    expect(data.path).toBe('vector');
    expect(data.fallback).toBeNull();
    expectRankedAbove(data, fixture.implementation.id, fixture.unrelated.id);
  });

  it('kind narrows the answer to file nodes so a model can ask which branch touched a path', async () => {
    const fixture = seed();
    const data = unwrap(
      (await contextSearch(contextFor(fixture), { query: 'pricing', kind: 'file' })) as ToolOutcome<ContextSearchData>,
    );

    expect(data.hits.length).toBeGreaterThan(0);
    expect(data.hits.every((hit) => hit.kind === 'file')).toBe(true);
  });

  it('fans out to §9.1 providers and reports per-provider provenance the eval harness can score', async () => {
    const fixture = seed();
    const structural: Candidate = {
      path: 'src/pricing.ts',
      span: { start_line: 1, end_line: 3 },
      symbol: 'price',
      score: 0.9,
      provider: 'graftish',
      tier: 'structural',
    };
    const registry = new ProviderRegistry([fakeProvider('graftish', 'structural', [structural])]);

    const data = unwrap(
      (await contextSearch(contextFor(fixture, { registry }), {
        query: 'pricing rounding',
      })) as ToolOutcome<ContextSearchData>,
    );

    const providers = data.provenance.map((entry) => entry.provider);
    expect(providers).toContain('graftish');
    expect(providers).toContain('tree');
    // §9.1's fixed order: structural hits are exact edges and outrank fuzzy ones.
    expect(data.candidates[0]?.provider).toBe('graftish');
    expect(data.provenance.find((entry) => entry.provider === 'graftish')?.kept).toBe(1);
    expect(data.unavailable).toEqual([]);
  });

  it('a provider that fails its capability probe is dropped and named, never fatal (§18)', async () => {
    const fixture = seed();
    const registry = new ProviderRegistry([
      fakeProvider('missing-binary', 'structural', [], false),
      fakeProvider('graftish', 'structural', [], true),
    ]);

    const data = unwrap(
      (await contextSearch(contextFor(fixture, { registry }), { query: 'pricing' })) as ToolOutcome<ContextSearchData>,
    );

    expect(data.unavailable).toEqual(['missing-binary']);
    expect(data.hits.length).toBeGreaterThan(0);
  });
});

// ── context_peek ───────────────────────────────────────────────────────────

describe('context_peek', () => {
  it('honours a small max_chars so a suspicion costs one small call, not an expansion (§9)', async () => {
    const fixture = seed();
    const data = unwrap(
      (await contextPeek(contextFor(fixture), {
        node_id: fixture.implementation.id,
        max_chars: 24,
      })) as ToolOutcome<ContextPeekData>,
    );

    expect(data.max_chars).toBe(24);
    expect(data.text.length).toBeLessThanOrEqual(24);
    expect(data.chars).toBe(data.text.length);
  });

  it('clamps an oversized max_chars to the cap instead of turning a peek into a fetch', async () => {
    const fixture = seed();
    const data = unwrap(
      (await contextPeek(contextFor(fixture), {
        node_id: fixture.implementation.id,
        max_chars: 5_000_000,
      })) as ToolOutcome<ContextPeekData>,
    );

    expect(data.max_chars).toBe(MAX_PEEK_CHARS);
    expect(data.text.length).toBeLessThanOrEqual(MAX_PEEK_CHARS);
  });

  it('reads RAW L0 payloads, not the summary — that is the point of rule 3', async () => {
    const fixture = seed();
    const data = unwrap(
      (await contextPeek(contextFor(fixture), { node_id: fixture.fileNode.id })) as ToolOutcome<ContextPeekData>,
    );

    expect(data.text).toContain('Math.round');
    expect(data.text).not.toContain('Rewrote price()');
  });

  it('an unknown node_id returns a structured error naming the id', async () => {
    const fixture = seed();
    const error = expectError(await contextPeek(contextFor(fixture), { node_id: 'n_missing' }));

    expect(error.code).toBe('unknown_node');
    expect(error.message).toContain('n_missing');
  });
});

// ── annotate ───────────────────────────────────────────────────────────────

describe('annotate', () => {
  it('writes the node_links edge AND the note AND the L0 event — all three, or the conclusion is lost', async () => {
    const fixture = seed();
    const review = fixture.unrelated;
    const before = fixture.handle.trace.lastSeq();

    const data = unwrap(
      await annotate(contextFor(fixture), {
        node_id: fixture.implementation.id,
        text: 'superseded: rounding moved into the tax helper',
        link_to: review.id,
        link_kind: 'superseded_by',
      }),
    );

    const store = fixture.handle.store;
    expect(store.linksFrom(fixture.implementation.id)).toEqual([
      expect.objectContaining({ from_id: fixture.implementation.id, to_id: review.id, kind: 'superseded_by' }),
    ]);
    const annotations = store.getNode(fixture.implementation.id)?.meta_json.annotations ?? [];
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.text).toContain('superseded');
    // The note's identity is its L0 seq: L1 is derived, L0 is the record (D8).
    expect(annotations[0]?.seq).toBe(data.seq);

    const appended = fixture.handle.trace.all().filter((event) => event.seq > before);
    expect(appended.map((event) => event.type)).toEqual(['manual_annotation']);
    expect(data.link).toEqual({ from_id: fixture.implementation.id, to_id: review.id, kind: 'superseded_by' });
  });

  it('appends rather than replacing, so a second note does not erase the first (D3 applied to notes)', async () => {
    const fixture = seed();
    const ctx = contextFor(fixture);
    await annotate(ctx, { node_id: fixture.fileNode.id, text: 'first' });
    const second = unwrap(await annotate(ctx, { node_id: fixture.fileNode.id, text: 'second' }));

    expect(second.annotations).toBe(2);
    const stored = fixture.handle.store.getNode(fixture.fileNode.id)?.meta_json.annotations ?? [];
    expect(stored.map((entry) => entry.text)).toEqual(['first', 'second']);
  });

  it('records in Mode A too: it is an explicit write, so its L0 record is not mode-dependent', async () => {
    const fixture = seed({ mode: 'tool-backend' });
    const before = fixture.handle.trace.lastSeq();
    await annotate(contextFor(fixture), { node_id: fixture.root.id, text: 'note' });

    expect(fixture.handle.trace.lastSeq()).toBe(before + 1);
  });

  it('rejects link_kind without link_to rather than silently dropping the edge the model asked for', async () => {
    const fixture = seed();
    const error = expectError(
      await annotate(contextFor(fixture), {
        node_id: fixture.root.id,
        text: 'note',
        link_kind: 'blocks',
      }),
    );

    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('link_to');
  });

  it('rejects a self-link: a node superseded by itself would corrupt the tree, not describe it', async () => {
    const fixture = seed();
    const error = expectError(
      await annotate(contextFor(fixture), {
        node_id: fixture.root.id,
        text: 'note',
        link_to: fixture.root.id,
        link_kind: 'superseded_by',
      }),
    );

    expect(error.code).toBe('invalid_input');
  });

  it('an unknown link_to names that argument, not node_id, so the model knows which id was wrong', async () => {
    const fixture = seed();
    const error = expectError(
      await annotate(contextFor(fixture), {
        node_id: fixture.root.id,
        text: 'note',
        link_to: 'n_ghost',
      }),
    );

    expect(error.code).toBe('unknown_node');
    expect(error.message).toContain('link_to');
    expect(error.message).toContain('n_ghost');
  });
});

// ── mode gating (D14 / §9.2, ruling C9) ────────────────────────────────────

describe('mode gating', () => {
  it('Mode A read tools append NOTHING to L0 — installing context-tree cannot perturb the host trace', async () => {
    const fixture = seed({ mode: 'tool-backend' });
    const ctx = contextFor(fixture);
    const before = fixture.handle.trace.lastSeq();

    await contextFetch(ctx, { branch_id: fixture.implementation.id });
    await contextSearch(ctx, { query: 'pricing' });
    await contextPeek(ctx, { node_id: fixture.implementation.id });

    expect(fixture.handle.trace.lastSeq()).toBe(before);
  });

  it('Mode B appends exactly one tool_call + one tool_result per retrieval, so §7 indexes it unchanged', async () => {
    const fixture = seed({ mode: 'middleware' });
    const before = fixture.handle.trace.lastSeq();

    await contextFetch(contextFor(fixture), { branch_id: fixture.implementation.id });

    const appended = fixture.handle.trace.all().filter((event) => event.seq > before);
    expect(appended).toHaveLength(2);
    const [call, result] = appended;
    expect(call?.type).toBe('tool_call');
    expect(call?.type === 'tool_call' ? call.tool : null).toBe(CONTEXT_FETCH);
    expect(result?.type).toBe('tool_result');
    expect(result?.type === 'tool_result' ? result.call_seq : null).toBe(call?.seq);
  });

  it('a failed Mode B retrieval writes nothing: the L0 record follows the answer, not the attempt', async () => {
    const fixture = seed({ mode: 'middleware' });
    const before = fixture.handle.trace.lastSeq();

    expectError(await contextFetch(contextFor(fixture), { branch_id: 'n_missing' }));

    expect(fixture.handle.trace.lastSeq()).toBe(before);
  });

  it('the explicit `mode` override beats config.mode, which is what §15 Mode A/B arm needs', async () => {
    const fixture = seed({ mode: 'tool-backend' });
    const before = fixture.handle.trace.lastSeq();

    await contextPeek(contextFor(fixture, { mode: 'middleware' }), { node_id: fixture.implementation.id });

    expect(fixture.handle.trace.lastSeq()).toBe(before + 2);
  });
});

// ── the registered surface ─────────────────────────────────────────────────

async function connect(fixture: Fixture): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer({
    config: fixture.config,
    handle: fixture.handle,
    retriever: fixture.retriever,
    mode: 'tool-backend',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'context-tree-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('registered surface', () => {
  it('exposes exactly the four §9 tools — Zone A is frozen, so the set is closed (D5)', async () => {
    const fixture = seed();
    const { client, close } = await connect(fixture);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
      expect(TOOL_NAMES).toHaveLength(4);
      expect([...TOOL_NAMES].sort()).toEqual([ANNOTATE, CONTEXT_FETCH, CONTEXT_PEEK, CONTEXT_SEARCH].sort());
    } finally {
      await close();
    }
  });

  it('every description states WHEN to reach for the tool — with no fine-tuning, that text is the policy (D7)', async () => {
    const fixture = seed();
    const { client, close } = await connect(fixture);
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.description ?? '', `${tool.name} description`).toContain('Reach for it');
      }
      const fetchTool = tools.find((tool) => tool.name === CONTEXT_FETCH);
      // §9 contract rule 1 must survive even when a host installs the tools
      // without the system contract.
      expect(fetchTool?.description).toContain('BEFORE EDITING');
      expect(fetchTool?.description).toContain('never invalidates the cached prompt prefix');
    } finally {
      await close();
    }
  });

  it('ships the §9 system contract with the tools, as instructions and as a pullable prompt', async () => {
    const fixture = seed();
    const { client, close } = await connect(fixture);
    try {
      expect(client.getInstructions()).toBe(systemContract());
      const prompt = await client.getPrompt({ name: CONTRACT_PROMPT });
      const first = prompt.messages[0];
      expect(first?.content.type === 'text' ? first.content.text : '').toBe(systemContract());
    } finally {
      await close();
    }
  });

  it('routes a tool call through the same handler and returns a tool error, not a protocol error', async () => {
    const fixture = seed();
    const { client, close } = await connect(fixture);
    try {
      const good = await client.callTool({ name: CONTEXT_FETCH, arguments: { branch_id: fixture.implementation.id } });
      expect(good.isError).toBeFalsy();

      const bad = await client.callTool({ name: CONTEXT_PEEK, arguments: { node_id: 'n_missing' } });
      expect(bad.isError).toBe(true);
      const block = (bad.content as Array<{ type: string; text?: string }>)[0];
      expect(block?.text ?? '').toContain('unknown_node');
    } finally {
      await close();
    }
  });

  it('marks the read tools read-only in Mode A and not in Mode B, because Mode B writes L0', async () => {
    const fixture = seed();
    const modeB = createServer({
      config: fixture.config,
      handle: fixture.handle,
      retriever: fixture.retriever,
      mode: 'middleware',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'context-tree-test', version: '0.0.0' });
    await Promise.all([modeB.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const fetchTool = tools.find((tool) => tool.name === CONTEXT_FETCH);
      expect(fetchTool?.annotations?.readOnlyHint).toBe(false);
    } finally {
      await client.close();
      await modeB.close();
    }

    const modeAFixture = seed({ mode: 'tool-backend' });
    const { client: readClient, close } = await connect(modeAFixture);
    try {
      const { tools } = await readClient.listTools();
      expect(tools.find((tool) => tool.name === CONTEXT_FETCH)?.annotations?.readOnlyHint).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('the eval-harness integration point (§11)', () => {
  it('HANDLERS covers exactly the registered tool set, or the eval scores a surface the agent never sees', async () => {
    const fixture = seed();
    const { client, close } = await connect(fixture);
    try {
      const { tools } = await client.listTools();
      expect(Object.keys(HANDLERS).sort()).toEqual(tools.map((tool) => tool.name).sort());
    } finally {
      await close();
    }
  });

  it('dispatching through HANDLERS by name gives the same result as calling the handler directly', async () => {
    const fixture = seed();
    const ctx = contextFor(fixture);
    const args = { branch_id: fixture.implementation.id };
    const viaMap = await HANDLERS[CONTEXT_FETCH](ctx, args);
    const direct = await contextFetch(ctx, args);

    expect(viaMap).toEqual(direct);
  });
});

/**
 * stdout IS the MCP transport: a single stray `console.log` frames as garbage
 * and corrupts the session. Nothing in this package may write to it.
 */
describe('stdout discipline', () => {
  it('no source file in this package writes to stdout', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      // Comments stripped first: the rule is about code, and bin.ts's own
      // header names the hazard it is guarding against.
      const code = readFileSync(join(src, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*/g, '');
      expect(code, `${file} must not write to stdout`).not.toMatch(/console\.(log|info|debug)|process\.stdout/);
    }
  });
});

/** The eval harness dispatches by node id it got from search; that round trip must close. */
describe('search -> fetch round trip', () => {
  it('every search hit is a valid context_fetch target', async () => {
    const fixture = seed();
    const ctx = contextFor(fixture);
    const search = unwrap((await contextSearch(ctx, { query: 'pricing rounding' })) as ToolOutcome<ContextSearchData>);

    for (const hit of search.hits) {
      const fetched = await contextFetch(ctx, { branch_id: hit.node_id as NodeId });
      expect(fetched.ok, `fetching ${hit.node_id}`).toBe(true);
    }
  });
});
