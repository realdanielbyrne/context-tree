/**
 * §8 summarization engine (D2, D11) + the D4 cascade — the M2 acceptance.
 *
 * Every test here is stub-driven: M0–M2 spend zero LLM budget (§16), and CI
 * never hits the network (§17). The stub is a *compliant* model — it echoes the
 * node ids it was handed — so a test that fails does so because the summarizer
 * changed, not because the fake model is unrealistic.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SummaryContractError, SummaryInputError } from '../src/contracts/index.js';
import type {
  BlobStore,
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  NodeId,
  SummaryMeta,
  SymbolSpan,
  TraceLog,
} from '../src/contracts/index.js';
import { FsBlobStore } from '../src/blobs/index.js';
import { JsonlTraceLog } from '../src/trace/index.js';
import { resolveConfig } from '../src/config.js';
import { ingest, openTaskStore } from '../src/ingest/index.js';
import { openInMemoryStore, type SqliteTreeStore } from '../src/store/index.js';
import { Summarizer } from '../src/summarize/index.js';

const LEAF_MODEL = 'stub-cheap';
const ROOT_MODEL = 'stub-strong';
const NOW = '2026-01-01T00:00:00.000Z';

interface RecordedCall {
  model: string;
  content: string;
}

/** A model that records what it was asked and how many calls overlapped. */
class StubProvider implements ModelProvider {
  readonly id = 'stub';
  readonly calls: RecordedCall[] = [];
  inFlight = 0;
  maxInFlight = 0;

  constructor(private readonly reply: (call: RecordedCall, index: number) => Promise<string>) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const call: RecordedCall = {
      model: request.model,
      content: request.messages.map((message) => message.content).join('\n'),
    };
    const index = this.calls.length;
    this.calls.push(call);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return {
        text: await this.reply(call, index),
        model: request.model,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        toolCalls: [],
        stopReason: 'end_turn',
      };
    } finally {
      this.inFlight -= 1;
    }
  }
}

/**
 * Pulls the node ids out of whichever prompt it was given — `NODE IDS:` in the
 * leaf template, `(node_id: ...)` per child in the root template. This is what
 * a model obeying the §8 contract does, so the fixture reply below is honest.
 */
function echoedNodeIds(content: string): string[] {
  const leaf = /NODE IDS: (.*)/.exec(content);
  if (leaf?.[1] !== undefined) {
    return leaf[1].split(',').map((id) => id.trim()).filter((id) => id.length > 0);
  }
  return [...content.matchAll(/\(node_id: ([^)]+)\)/g)].map((match) => match[1] as string);
}

function replyBody(nodeIds: readonly string[], overrides: Partial<SummaryMeta> = {}, text = 'the branch did work'): string {
  const meta: SummaryMeta = {
    files: [],
    symbols: [],
    tests: [],
    artifacts: [],
    open_questions: [],
    decisions: [],
    node_ids: [...nodeIds],
    ...overrides,
  };
  return JSON.stringify({ text, meta });
}

/** The default stub behaviour: a contract-abiding reply for whatever it was asked. */
async function compliant(call: RecordedCall): Promise<string> {
  return replyBody(echoedNodeIds(call.content));
}

/** A runner's own output — the only place a §8 `tests[]` entry can come from. */
const FAILING_RUN = [
  'FAIL test/pricing.test.ts > rounds half up on discounted totals',
  '  expected 108 to be 109',
  '1 failing, 11 passing',
].join('\n');

const A_SPAN: SymbolSpan = {
  path: 'src/a.ts',
  start_line: 10,
  end_line: 42,
  symbol: 'parseThing',
  kind: 'function_declaration',
};

interface Fixture {
  store: SqliteTreeStore;
  root: NodeId;
  p1: NodeId;
  f1: NodeId;
  p2: NodeId;
}

/**
 * root(task) -> p1(diagnosis) -> f1(file src/a.ts), and root -> p2(implementation).
 * Two branches is the minimum shape that can prove the cascade skips a sibling;
 * the file node under p1 is what proves spans come from the tree (D9).
 */
function fixture(): Fixture {
  const store = openInMemoryStore();
  const root = store.insertNode({
    parent_id: null,
    kind: 'task',
    title: 'fix the parser',
    span_start_seq: 1,
    span_end_seq: 6,
    meta_json: { tools: ['Read', 'Edit'] },
  });
  const p1 = store.insertNode({
    parent_id: root.id,
    kind: 'phase',
    title: 'diagnosis: read the parser',
    phase_type: 'diagnosis',
    span_start_seq: 1,
    span_end_seq: 4,
    meta_json: { tools: ['Read', 'Edit'] },
  });
  const f1 = store.insertNode({
    parent_id: p1.id,
    kind: 'file',
    title: 'src/a.ts',
    span_start_seq: 3,
    span_end_seq: 4,
    meta_json: { path: 'src/a.ts', spans: [A_SPAN], symbols: ['parseThing'] },
  });
  const p2 = store.insertNode({
    parent_id: root.id,
    kind: 'phase',
    title: 'verification: run the tests',
    phase_type: 'verification',
    span_start_seq: 5,
    span_end_seq: 6,
    meta_json: { tools: ['Bash'] },
  });
  return { store, root: root.id, p1: p1.id, f1: f1.id, p2: p2.id };
}

function summarizerFor(
  fx: Fixture,
  provider: StubProvider,
  options: { concurrency?: number; trace?: TraceLog; blobs?: BlobStore } = {},
): Summarizer {
  return new Summarizer({
    store: fx.store,
    provider,
    leafModel: LEAF_MODEL,
    rootModel: ROOT_MODEL,
    now: () => NOW,
    ...options,
  });
}

describe('leaf summaries', () => {
  it('writes version 1 and clears staleness, because a summary is what the tree shows in place of the branch', async () => {
    const fx = fixture();
    fx.store.markStale(fx.p1, 4);
    const provider = new StubProvider(compliant);
    const summary = await summarizerFor(fx, provider).summarizeLeaf(fx.p1);

    expect(summary.version).toBe(1);
    expect(summary.created_at).toBe(NOW);
    expect(fx.store.getNode(fx.p1)?.stale_since_seq).toBeNull();
    expect(fx.store.getNode(fx.p1)?.current_summary_version).toBe(1);
  });

  it('uses the cheap model at the leaves and the strong model at the root (D2: that split is the cost model)', async () => {
    const fx = fixture();
    const provider = new StubProvider(compliant);
    const summarizer = summarizerFor(fx, provider);
    await summarizer.summarizeLeaf(fx.p1);
    await summarizer.summarizeRoot(fx.root);

    expect(provider.calls.map((call) => call.model)).toEqual([LEAF_MODEL, ROOT_MODEL]);
  });

  it('keeps version 1 readable after writing version 2, because D3 makes "what did the model see" auditable', async () => {
    const fx = fixture();
    const provider = new StubProvider(async (call, index) =>
      replyBody(echoedNodeIds(call.content), {}, `pass ${index + 1}`),
    );
    const summarizer = summarizerFor(fx, provider);

    const first = await summarizer.summarizeLeaf(fx.p1);
    const second = await summarizer.summarizeLeaf(fx.p1);

    expect([first.version, second.version]).toEqual([1, 2]);
    expect(fx.store.summaryVersion(fx.p1, 1)?.text).toBe('pass 1');
    expect(fx.store.summaryVersion(fx.p1, 2)?.text).toBe('pass 2');
    expect(fx.store.currentSummary(fx.p1)?.version).toBe(2);
    expect(fx.store.summaryVersions(fx.p1).map((s) => s.version)).toEqual([1, 2]);
  });

  it('stores the tree-sitter spans, not the model\'s, because §9 only calls a span verifiable if D9 produced it', async () => {
    const fx = fixture();
    // A path inside the branch (so no contract violation) with invented lines
    // and an invented symbol — exactly the plausible hallucination that would
    // make every rehydration pointer untrustworthy if it were stored.
    const provider = new StubProvider(async (call) =>
      replyBody(echoedNodeIds(call.content), {
        files: [{ path: 'src/a.ts', start_line: 900, end_line: 901, symbol: 'ghost' }],
        symbols: ['ghost'],
      }),
    );
    const summary = await summarizerFor(fx, provider).summarizeLeaf(fx.p1);

    expect(summary.meta.files).toEqual([A_SPAN]);
    expect(summary.meta.symbols).toEqual(['parseThing']);
    // Prose-side fields still come from the model — it is the only source for them.
    expect(summary.meta.node_ids).toEqual([fx.p1, fx.f1]);
  });

  it('carries the model\'s decisions and open questions through, since they are the fields the tree cannot know', async () => {
    const fx = fixture();
    const provider = new StubProvider(async (call) =>
      replyBody(echoedNodeIds(call.content), {
        open_questions: ['is the fallback lexer still needed?'],
        decisions: ['keep the recursive-descent parser'],
        tests: [{ name: 'parses a fence', status: 'failed' }],
        artifacts: [{ kind: 'ticket', ref: 'SOF-1' }],
      }),
    );
    const summary = await summarizerFor(fx, provider).summarizeLeaf(fx.p1);

    expect(summary.meta.open_questions).toEqual(['is the fallback lexer still needed?']);
    expect(summary.meta.decisions).toEqual(['keep the recursive-descent parser']);
    expect(summary.meta.tests).toEqual([{ name: 'parses a fence', status: 'failed' }]);
    expect(summary.meta.artifacts).toEqual([{ kind: 'ticket', ref: 'SOF-1' }]);
  });

  it('resolves the branch\'s L0 span through L2 so the model summarizes real content, not coordinates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-summarize-'));
    const blobs = new FsBlobStore(join(dir, 'blobs'));
    const trace = new JsonlTraceLog(join(dir, 'trace.jsonl'));
    const askRef = blobs.put('why does the parser drop fences?');
    const editRef = blobs.put('export function parseThing() { return 1; }');
    trace.appendAll([
      { type: 'user_message', ts: NOW, blob: askRef },
      { type: 'assistant_message', ts: NOW, blob: blobs.put('looking now') },
      { type: 'tool_call', ts: NOW, tool: 'Edit', path: 'src/a.ts', blob: editRef },
      { type: 'tool_result', ts: NOW, call_seq: 3 },
      // Outside p1's span (5..6) — must not leak into p1's detail.
      { type: 'user_message', ts: NOW, blob: blobs.put('now run the tests') },
      { type: 'tool_call', ts: NOW, tool: 'Bash' },
    ]);

    const fx = fixture();
    const provider = new StubProvider(compliant);
    const summarizer = new Summarizer({
      store: fx.store,
      provider,
      leafModel: LEAF_MODEL,
      rootModel: ROOT_MODEL,
      trace,
      blobs,
      now: () => NOW,
    });
    await summarizer.summarizeLeaf(fx.p1);

    const prompt = provider.calls[0]?.content ?? '';
    expect(prompt).toContain('why does the parser drop fences?');
    expect(prompt).toContain('export function parseThing() { return 1; }');
    expect(prompt).toContain('src/a.ts:10-42 parseThing');
    expect(prompt).not.toContain('now run the tests');
  });

  /**
   * §8's `tests: [{name, status, detail}]` pointer can only be written from the
   * runner's own output, and "which test failed" is the fact a resumed agent
   * needs most (§9: the structured metadata is the ONLY mitigation for the
   * model not knowing what it does not know). A tool_result that reached the
   * model as its `error` string alone made that pointer unwritable.
   */
  it('renders a failed run\'s output alongside its error, or §8\'s tests[] pointer has nothing to name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-summarize-failrun-'));
    const blobs = new FsBlobStore(join(dir, 'blobs'));
    const trace = new JsonlTraceLog(join(dir, 'trace.jsonl'));
    trace.appendAll([
      { type: 'user_message', ts: NOW, blob: blobs.put('the suite went red') },
      { type: 'assistant_message', ts: NOW, blob: blobs.put('running it') },
      { type: 'tool_call', ts: NOW, tool: 'run_tests', args_blob: blobs.put('{"suite":"pricing"}') },
      // A runner that exited non-zero: the reason is in `error`, the failure
      // text is in `output_blob`. Both, or the summary can only say "it failed".
      {
        type: 'tool_result',
        ts: NOW,
        call_seq: 3,
        error: 'exit code 1',
        output_blob: blobs.put(FAILING_RUN),
      },
    ]);

    const fx = fixture();
    const provider = new StubProvider(compliant);
    await summarizerFor(fx, provider, { trace, blobs }).summarizeLeaf(fx.p1);

    const prompt = provider.calls[0]?.content ?? '';
    expect(prompt).toContain('error: exit code 1');
    expect(prompt).toContain('rounds half up on discounted totals');
    expect(prompt).toContain('expected 108 to be 109');
    // The arguments say *what was asked* — the suite name a tests[] entry is
    // written from, which no other event carries.
    expect(prompt).toContain('{"suite":"pricing"}');
  });

  it('marks a truncated payload, so the head of a long run is never read as the whole run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-summarize-truncate-'));
    const blobs = new FsBlobStore(join(dir, 'blobs'));
    const trace = new JsonlTraceLog(join(dir, 'trace.jsonl'));
    const tail = 'FAIL past the cap';
    trace.appendAll([
      { type: 'user_message', ts: NOW, blob: blobs.put('run everything') },
      { type: 'assistant_message', ts: NOW, blob: blobs.put('running') },
      { type: 'tool_call', ts: NOW, tool: 'run_tests' },
      {
        type: 'tool_result',
        ts: NOW,
        call_seq: 3,
        output_blob: blobs.put(`${'PASS ok\n'.repeat(600)}${tail}`),
      },
    ]);

    const fx = fixture();
    const provider = new StubProvider(compliant);
    await summarizerFor(fx, provider, { trace, blobs }).summarizeLeaf(fx.p1);

    const prompt = provider.calls[0]?.content ?? '';
    expect(prompt).not.toContain(tail);
    // Visible, not silent: a model that cannot see the rest must be told so it
    // reports what it saw rather than what it assumes.
    expect(prompt).toMatch(/truncated: first 4096 of \d+ bytes/);
  });
});

describe('root summary', () => {
  it('is one call over the child summaries and never over raw event text — raw events at the root is §15 arm C', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-summarize-root-'));
    const blobs = new FsBlobStore(join(dir, 'blobs'));
    const trace = new JsonlTraceLog(join(dir, 'trace.jsonl'));
    trace.appendAll([
      { type: 'user_message', ts: NOW, blob: blobs.put('RAW-EVENT-TEXT-MARKER') },
      { type: 'assistant_message', ts: NOW, blob: blobs.put('ok') },
      { type: 'tool_call', ts: NOW, tool: 'Read', path: 'src/a.ts' },
      { type: 'tool_result', ts: NOW, call_seq: 3 },
      { type: 'user_message', ts: NOW, blob: blobs.put('and now the tests') },
      { type: 'tool_call', ts: NOW, tool: 'Bash' },
    ]);

    const fx = fixture();
    const provider = new StubProvider(async (call) =>
      replyBody(echoedNodeIds(call.content), {}, `summary of ${call.model}`),
    );
    const summarizer = new Summarizer({
      store: fx.store,
      provider,
      leafModel: LEAF_MODEL,
      rootModel: ROOT_MODEL,
      trace,
      blobs,
      now: () => NOW,
    });

    const outcomes = await summarizer.summarizeTree(fx.root);
    expect(outcomes.every((outcome) => outcome.status === 'summarized')).toBe(true);

    const rootCalls = provider.calls.filter((call) => call.model === ROOT_MODEL);
    expect(rootCalls).toHaveLength(1);
    const rootPrompt = rootCalls[0]?.content ?? '';
    expect(rootPrompt).toContain(`node_id: ${fx.p1}`);
    expect(rootPrompt).toContain(`node_id: ${fx.p2}`);
    expect(rootPrompt).toContain(`summary of ${LEAF_MODEL}`);
    expect(rootPrompt).not.toContain('RAW-EVENT-TEXT-MARKER');
    expect(rootPrompt).not.toContain('[1] user_message');
  });

  it('refuses to roll up a root with no summarized children rather than falling back to raw events', async () => {
    const fx = fixture();
    const provider = new StubProvider(compliant);
    const thrown = await summarizerFor(fx, provider)
      .summarizeRoot(fx.root)
      .catch((error: unknown) => error);
    // A named class with a code, not an inline `new ContextTreeError(...)`: a
    // caller can only catch what the taxonomy declares.
    expect(thrown).toBeInstanceOf(SummaryInputError);
    expect((thrown as SummaryInputError).code).toBe('E_SUMMARY_INPUT');
    expect((thrown as SummaryInputError).message).toMatch(/no summarized child branches/);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('the D4 cascade', () => {
  it('marks exactly the appended node and its ancestors, never a sibling', async () => {
    const fx = fixture();
    const marked = summarizerFor(fx, new StubProvider(compliant)).onAppend(fx.f1, 4);

    expect(marked).toEqual([fx.f1, fx.p1, fx.root]);
    expect(fx.store.getNode(fx.p2)?.stale_since_seq).toBeNull();
    expect(fx.store.staleNodes().map((node) => node.id).sort()).toEqual([fx.f1, fx.p1, fx.root].sort());
  });

  it('empties staleNodes() after the stale path is re-summarized, or a --stale-only caller has work forever', async () => {
    const fx = fixture();
    const summarizer = summarizerFor(fx, new StubProvider(compliant));
    await summarizer.summarizeTree(fx.root);
    summarizer.onAppend(fx.f1, 4);
    expect(fx.store.staleNodes().map((node) => node.id).sort()).toEqual([fx.f1, fx.p1, fx.root].sort());

    await summarizer.resummarizeStale();

    // The file node is never in `stalePlan`, so nothing would ever clear its
    // mark; writing p1's summary is what clears it, because p1's detail is where
    // that file's content reached the model. Without this the stale set never
    // drains and every scheduler reading it as a work queue spins.
    expect(fx.store.getNode(fx.f1)?.stale_since_seq).toBeNull();
    expect(fx.store.staleNodes()).toEqual([]);
  });

  it('plans bottom-up with the root last, so every parent reads fresh children', async () => {
    const fx = fixture();
    const summarizer = summarizerFor(fx, new StubProvider(compliant));
    summarizer.onAppend(fx.f1, 4);

    // The file node is stale but absent from the plan: its content reaches the
    // model as part of p1's detail, so re-summarizing p1 is what refreshes it.
    expect(summarizer.stalePlan(fx.root)).toEqual([fx.p1, fx.root]);
  });

  it('re-summarizes only the stale path and leaves a sibling\'s summary version untouched — D4\'s 1–3 calls per turn IS that property', async () => {
    const fx = fixture();
    const provider = new StubProvider(compliant);
    const summarizer = summarizerFor(fx, provider);
    await summarizer.summarizeTree(fx.root);
    const callsAfterFirstPass = provider.calls.length;
    expect(fx.store.currentSummary(fx.p2)?.version).toBe(1);

    summarizer.onAppend(fx.f1, 4);
    const outcomes = await summarizer.resummarizeStale();

    expect(outcomes.map((outcome) => outcome.nodeId)).toEqual([fx.p1, fx.root]);
    expect(fx.store.currentSummary(fx.p1)?.version).toBe(2);
    expect(fx.store.currentSummary(fx.root)?.version).toBe(2);
    // The whole point: the untouched branch is neither re-read nor re-billed.
    expect(fx.store.currentSummary(fx.p2)?.version).toBe(1);
    expect(fx.store.summaryVersions(fx.p2)).toHaveLength(1);
    expect(provider.calls.length - callsAfterFirstPass).toBe(2);
  });

  it('re-summarizes in plan order — leaves before the root, or the root reads a stale child', async () => {
    const fx = fixture();
    const provider = new StubProvider(compliant);
    const summarizer = summarizerFor(fx, provider);
    await summarizer.summarizeTree(fx.root);

    provider.calls.length = 0;
    summarizer.onAppend(fx.p1, 4);
    summarizer.onAppend(fx.p2, 5);
    await summarizer.resummarizeStale();

    // p1 and p2 may overlap (they are independent leaves), but the single root
    // call must be last: the strong model reads whatever the leaves just wrote.
    expect(provider.calls.map((call) => call.model)).toEqual([LEAF_MODEL, LEAF_MODEL, ROOT_MODEL]);
  });

  it('leaves nothing to do on a second pass, because putSummary clears the staleness that put a node in the plan', async () => {
    const fx = fixture();
    const summarizer = summarizerFor(fx, new StubProvider(compliant));
    await summarizer.summarizeTree(fx.root);
    summarizer.onAppend(fx.f1, 4);
    await summarizer.resummarizeStale();

    expect(summarizer.stalePlan(fx.root)).toEqual([]);
    expect(await summarizer.resummarizeStale()).toEqual([]);
  });
});

describe('summarizeTree batching', () => {
  it('never exceeds the configured concurrency cap, because §8 would otherwise put every leaf of a long session in flight at once', async () => {
    const store = openInMemoryStore();
    const root = store.insertNode({ parent_id: null, kind: 'task', title: 'wide task', span_start_seq: 1, span_end_seq: 12 });
    for (let i = 0; i < 6; i += 1) {
      store.insertNode({
        parent_id: root.id,
        kind: 'phase',
        title: `phase ${i}`,
        phase_type: 'other',
        span_start_seq: i * 2 + 1,
        span_end_seq: i * 2 + 2,
      });
    }
    const provider = new StubProvider(async (call) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return compliant(call);
    });
    const summarizer = new Summarizer({
      store,
      provider,
      leafModel: LEAF_MODEL,
      rootModel: ROOT_MODEL,
      concurrency: 2,
      now: () => NOW,
    });

    const outcomes = await summarizer.summarizeTree(root.id);

    expect(outcomes.filter((outcome) => outcome.status === 'summarized')).toHaveLength(7);
    expect(provider.maxInFlight).toBe(2);
  });

  it('reports a failing leaf and still summarizes the others, because the assembler never blocks on the summarizer', async () => {
    const fx = fixture();
    const provider = new StubProvider(async (call) => {
      if (call.content.includes(fx.p1)) throw new Error('leaf model exploded');
      return compliant(call);
    });
    const summarizer = summarizerFor(fx, provider);

    const outcomes = await summarizer.summarizeTree(fx.root);

    const failed = outcomes.filter((outcome) => outcome.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.nodeId).toBe(fx.p1);
    expect(failed[0]?.error?.message).toContain('leaf model exploded');
    expect(fx.store.currentSummary(fx.p1)).toBeNull();
    expect(fx.store.currentSummary(fx.p2)?.version).toBe(1);
    // A half-summarized tree is still usable: the root rolls up what exists.
    expect(fx.store.currentSummary(fx.root)?.meta.node_ids).toEqual([fx.root, fx.p2]);
  });
});

describe('the §8 content contract', () => {
  it('retries once with the violation named when a reply omits a child branch id', async () => {
    const fx = fixture();
    const provider = new StubProvider(async (call, index) => {
      const ids = echoedNodeIds(call.content);
      // First reply drops the file child — the branch would then be invisible
      // to a reader deciding what to fetch (§9).
      return index === 0 ? replyBody([fx.p1]) : replyBody(ids);
    });
    const summarizer = summarizerFor(fx, provider);

    const summary = await summarizer.summarizeLeaf(fx.p1);

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.content).toContain('meta.node_ids omits child branch id(s)');
    expect(provider.calls[1]?.content).toContain(fx.f1);
    expect(summary.version).toBe(1);
  });

  it('drops reply-owned file spans and stores tree-derived coordinates instead (D9)', async () => {
    const fx = fixture();
    const provider = new StubProvider(async (call) =>
      replyBody(echoedNodeIds(call.content), {
        files: [{ path: 'src/never-touched.ts', start_line: 1, end_line: 2 }],
      }),
    );
    const summarizer = summarizerFor(fx, provider);

    const summary = await summarizer.summarizeLeaf(fx.p1);

    // A hallucinated path is NOT a rejection: `summaryMetaFrom` overwrites
    // files/symbols from the tree, so validating them failed whole branches
    // over values the system discards (observed live: claude-haiku-4.5 broke
    // this sub-contract on 3/3 runs, and the retry did not recover it).
    expect(provider.calls).toHaveLength(1);
    expect(summary.version).toBe(1);
    const stored = fx.store.currentSummary(fx.p1);
    expect(stored?.meta.files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(stored?.meta.files.some((file) => file.path === 'src/never-touched.ts')).toBe(false);
  });

  /**
   * The three sub-field defects `claude-haiku-4.5` produced live, in one reply:
   * a missing `end_line`, an empty `symbol`, and a path this branch never
   * touched. All of them are inside fields `summaryMetaFrom` overwrites from
   * the tree (D9), so rejecting them cost a whole branch summary — and §9 says
   * an unsummarized branch is one the next session cannot ask about — while
   * changing nothing that gets stored.
   */
  it('accepts a reply whose file spans are malformed sub-field by sub-field, because the tree overwrites them (D9)', async () => {
    const fx = fixture();
    const provider = new StubProvider(async (call) =>
      JSON.stringify({
        text: 'the branch did work',
        meta: {
          files: [
            { path: 'src/a.ts', start_line: 900 },
            { path: 'src/never-touched.ts', start_line: 1, end_line: 2, symbol: '' },
          ],
          symbols: [''],
          tests: [],
          artifacts: [],
          open_questions: [],
          decisions: [],
          node_ids: echoedNodeIds(call.content),
        },
      }),
    );

    const summary = await summarizerFor(fx, provider).summarizeLeaf(fx.p1);

    // Not even a retry: none of that was ever a violation.
    expect(provider.calls).toHaveLength(1);
    expect(summary.meta.files).toEqual([A_SPAN]);
    expect(summary.meta.symbols).toEqual(['parseThing']);
  });

  it('still refuses a reply missing a model-owned field, since §8\'s metadata is §9\'s only unknown-unknowns mitigation', async () => {
    const fx = fixture();
    // `decisions` is the model's alone: the tree cannot recover it, so storing
    // a reply without it stores a summary with a hole nothing would report.
    const provider = new StubProvider(async (call) => {
      const reply = JSON.parse(replyBody(echoedNodeIds(call.content))) as {
        meta: Record<string, unknown>;
      };
      delete reply.meta.decisions;
      return JSON.stringify(reply);
    });

    await expect(summarizerFor(fx, provider).summarizeLeaf(fx.p1)).rejects.toBeInstanceOf(
      SummaryContractError,
    );
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.content).toContain('meta.decisions');
    expect(fx.store.currentSummary(fx.p1)).toBeNull();
    expect(fx.store.summaryVersions(fx.p1)).toEqual([]);
  });

  it('still refuses a `files` that is not an array: its presence is the model\'s job even when its contents are not', async () => {
    const fx = fixture();
    const provider = new StubProvider(async (call) =>
      JSON.stringify({
        text: 'the branch did work',
        meta: {
          files: 'src/a.ts',
          symbols: [],
          tests: [],
          artifacts: [],
          open_questions: [],
          decisions: [],
          node_ids: echoedNodeIds(call.content),
        },
      }),
    );

    await expect(summarizerFor(fx, provider).summarizeLeaf(fx.p1)).rejects.toBeInstanceOf(
      SummaryContractError,
    );
    expect(provider.calls[1]?.content).toContain('meta.files');
  });

  it('retries an unparseable reply once too, since a summary that cannot be read is the same failure', async () => {
    const fx = fixture();
    const provider = new StubProvider(async (call, index) =>
      index === 0 ? 'I would rather explain it in prose.' : replyBody(echoedNodeIds(call.content)),
    );

    const summary = await summarizerFor(fx, provider).summarizeLeaf(fx.p1);

    expect(provider.calls).toHaveLength(2);
    expect(summary.version).toBe(1);
  });
});

describe('D11 background summarization', () => {
  it('returns before the model is called and drains to a written summary, because a turn must not wait on sleep-time compute', async () => {
    const fx = fixture();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const provider = new StubProvider(async (call) => {
      await gate;
      return compliant(call);
    });
    const summarizer = summarizerFor(fx, provider);

    summarizer.scheduleSummarize(fx.p1);
    expect(provider.calls).toHaveLength(0);
    expect(fx.store.currentSummary(fx.p1)).toBeNull();

    release();
    await summarizer.drain();

    expect(fx.store.currentSummary(fx.p1)?.version).toBe(1);
    expect(summarizer.backgroundOutcomes()).toEqual([
      { nodeId: fx.p1, role: 'leaf', status: 'summarized', version: 1 },
    ]);
  });

  it('surfaces a background failure in the outcomes instead of losing it off the caller\'s path', async () => {
    const fx = fixture();
    const provider = new StubProvider(async () => {
      throw new Error('background model exploded');
    });
    const summarizer = summarizerFor(fx, provider);

    summarizer.scheduleSummarize(fx.p1);
    await summarizer.drain();

    const outcomes = summarizer.backgroundOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[0]?.error?.message).toContain('background model exploded');
  });

  it('drains work scheduled while draining, so quiescence means quiescence', async () => {
    const fx = fixture();
    const summarizer = summarizerFor(fx, new StubProvider(compliant));

    summarizer.scheduleSummarize(fx.p1);
    const drained = summarizer.drain();
    summarizer.scheduleSummarize(fx.p2);
    await drained;

    expect(summarizer.backgroundOutcomes().map((outcome) => outcome.nodeId)).toEqual([fx.p1, fx.p2]);
  });
});


/**
 * The one fact a resumed session cannot do without. §8 builds the root summary
 * from child summaries and never from raw events, so an event under no phase
 * reaches no summary — and until the segmenter adopted the leading pre-tool
 * run, the opening user message was exactly such an event.
 */
describe('the opening task statement (§8, §9, §15)', () => {
  it('reaches a leaf summary and the root prompt, so Zone B alone says what the session was asked to do', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-summarize-task-'));
    const handle = openTaskStore(
      resolveConfig({
        root: dir,
        taskTitle: 'fix the cursor',
        provider: 'mock',
        leafModel: LEAF_MODEL,
        rootModel: ROOT_MODEL,
      }),
    );
    const TASK = 'paging past page 1 drops the status filter (ACME-412)';
    handle.trace.appendAll([
      { type: 'user_message', ts: NOW, blob: handle.blobs.put(TASK) },
      { type: 'assistant_message', ts: NOW, blob: handle.blobs.put('reading the cursor') },
      { type: 'tool_call', ts: NOW, tool: 'Read', path: 'src/cursor.ts' },
      {
        type: 'tool_call',
        ts: NOW,
        tool: 'Edit',
        path: 'src/cursor.ts',
        blob: handle.blobs.put('export const cursor = 2;\n'),
      },
    ]);
    ingest({ handle });

    // The stub reports only what its prompt showed it, so this fails when the
    // statement never reaches the model instead of passing on invented text.
    const provider = new StubProvider(async (call) =>
      replyBody(
        echoedNodeIds(call.content),
        {},
        call.content.includes(TASK) ? `the user asked about ${TASK}` : 'the branch did work',
      ),
    );
    const root = handle.store.root();
    expect(root).not.toBeNull();
    const summarizer = new Summarizer({
      store: handle.store,
      provider,
      leafModel: LEAF_MODEL,
      rootModel: ROOT_MODEL,
      trace: handle.trace,
      blobs: handle.blobs,
      now: () => NOW,
    });

    const outcomes = await summarizer.summarizeTree(root?.id ?? '');
    expect(outcomes.every((outcome) => outcome.status === 'summarized')).toBe(true);

    const leafTexts = handle.store
      .children(root?.id ?? '')
      .map((child) => handle.store.currentSummary(child.id)?.text ?? '');
    expect(leafTexts.some((text) => text.includes(TASK))).toBe(true);
    // The root call reads child summaries only (§8), which is the whole path
    // the statement has to travel to reach Zone B of a resumed session.
    const rootPrompt = provider.calls.find((call) => call.model === ROOT_MODEL)?.content ?? '';
    expect(rootPrompt).toContain(TASK);

    handle.close();
  });
});
