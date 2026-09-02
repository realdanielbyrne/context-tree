/**
 * End-to-end loop test, fully offline: a ScriptedProvider plays the agent (one
 * tool call, then a final answer) and a MockProvider plays the §8 summarizer
 * with contract-abiding replies that echo the node ids the prompt shows it.
 * Both arms must complete, meter honest usage, and grade through the judge.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompletionRequest, CompletionResult, ModelProvider } from '@context-tree/core';
import { FsBlobStore, MockProvider } from '@context-tree/core';
import { CONTEXT_SEARCH } from '@context-tree/mcp';
import { disabledSink } from '../src/langfuse.js';
import {
  branchContentText,
  dedupSummarizePlan,
  mergeKeepSets,
  runScenario,
  selectTopKMessages,
  selectTopKBranches,
  splitSummarizePlan,
  toZoneCCachedRequest,
  contentWords,
  cosineSimilarity,
  idfVectors,
  termCounts,
} from '../src/loop.js';
import type { ChatMessage } from '@context-tree/core';
import type { HarnessOptions, Scenario } from '../src/types.js';

class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  private readonly replies: CompletionResult[];
  constructor(replies: CompletionResult[]) {
    this.replies = [...replies];
  }
  async complete(_request: CompletionRequest): Promise<CompletionResult> {
    const next = this.replies.shift();
    if (next === undefined) throw new Error('script exhausted — the loop over-called the model');
    return next;
  }
}

/** A contract-abiding summary reply: echoes the node ids the prompt names. */
function summaryResponder(request: CompletionRequest): string {
  const text = `${request.system ?? ''}\n${request.messages.map((message) => message.content).join('\n')}`;
  const ids = [...new Set(text.match(/n_[0-9A-HJKMNP-TV-Z]{26}/g) ?? [])];
  return JSON.stringify({
    text: 'the branch did work',
    meta: { files: [], symbols: [], tests: [], artifacts: [], open_questions: [], decisions: [], node_ids: ids },
  });
}

const scenario: Scenario = {
  id: 's1',
  benchmark: 'unit-test',
  task: 'Create hello.txt containing hi, then reply done.',
  judge: { kind: 'exact_match', answer: 'done' },
};

const options: HarnessOptions = {
  model: 'test-model',
  leafModel: 'test-model',
  rootModel: 'test-model',
  judgeModel: 'test-model',
  provider: 'anthropic',
  maxTurns: 6,
  timeCapMs: 60_000,
  costCapUsd: null,
  budgets: { zoneB: 8000, zoneC: 30000 },
  keepSandbox: false,
};

const agentReplies: CompletionResult[] = [
  {
    text: '',
    model: 'test-model',
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'hello.txt', content: 'hi' } }],
    stopReason: 'tool_use',
  },
  {
    text: 'done',
    model: 'test-model',
    usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0 },
    toolCalls: [],
    stopReason: 'end_turn',
  },
];

describe('selectTopKMessages — the DSA arm selector', () => {
  const task = 'Create hello.txt containing hi, then reply done.';
  const words = contentWords(task);
  const transcript: ChatMessage[] = [
    { role: 'user', content: task },
    { role: 'assistant', content: 'step one: created setup.log' },
    { role: 'user', content: '[tool_result write_file] wrote setup.log' },
    { role: 'assistant', content: 'step two: echoed marker' },
    { role: 'user', content: '[tool_result run_command] marker' },
    { role: 'assistant', content: 'step three: about to write hello.txt with hi' },
    { role: 'user', content: '[tool_result write_file] wrote hello.txt' },
    { role: 'assistant', content: 'latest action' },
    { role: 'user', content: '[tool_result read_file] hi' },
  ];

  it('passes short transcripts through untouched (below the eval floor)', () => {
    const short = transcript.slice(0, 4);
    expect(selectTopKMessages(short, words, 6)).toEqual(short);
    // The full 9-message fixture is also below the default floor of 10.
    expect(selectTopKMessages(transcript, words, 6)).toEqual(transcript);
  });

  it('keeps the task head verbatim (stable cache prefix) and pins the latest events', () => {
    const selected = selectTopKMessages(transcript, words, 6, 4);
    expect(selected[0]).toEqual(transcript[0]);
    expect(selected.slice(-2)).toEqual(transcript.slice(-2));
    expect(selected.length).toBeLessThanOrEqual(1 + 6);
  });

  it('prefers task-relevant old events over irrelevant older ones', () => {
    // k=4 leaves room for only 2 pool picks: the relevant "hello.txt with hi"
    // event must beat both older noise events, which recency alone would drop.
    const selected = selectTopKMessages(transcript, words, 4, 4);
    const texts = selected.map((message) => message.content as string);
    expect(texts.some((text) => text.includes('hello.txt with hi'))).toBe(true);
    expect(texts.some((text) => text.includes('setup.log'))).toBe(false);
    expect(texts.some((text) => text.includes('echoed marker'))).toBe(false);
  });

  it('preserves chronological order after selection', () => {
    const selected = selectTopKMessages(transcript, words, 6, 4);
    const indexes = selected.map((message) => transcript.indexOf(message));
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });
});

describe('selectTopKBranches — the tree-dsa arm selector', () => {
  const words = contentWords('create w1.txt containing apple, then verify');
  const branch = (id: string, text: string) => ({ id, text });

  it('returns undefined (no selection, byte-identical prompt) when branches fit within k', () => {
    const three = [branch('a', 'setup'), branch('b', 'noise'), branch('c', 'apple work')];
    expect(selectTopKBranches(three, words, 3)).toBeUndefined();
    expect(selectTopKBranches(three, words, 6)).toBeUndefined();
  });

  it('keeps the task-relevant branch over older noise once branches exceed k', () => {
    const many = [
      branch('a', 'setup phase one'),
      branch('b', 'unrelated diagnostics'),
      branch('c', 'wrote apple to w1.txt'),
      branch('d', 'more noise'),
      branch('e', 'latest cleanup'),
    ];
    const keep = selectTopKBranches(many, words, 3);
    expect(keep).toBeDefined();
    expect(keep?.size).toBe(3);
    expect(keep?.has('c')).toBe(true); // relevance beats pure recency
  });

  it('spreads across distinct branches instead of collapsing on an identical pair when relevance is tied', () => {
    const taskWords = contentWords('create w1.txt containing apple then verify');
    // One strong anchor + four irrelevant branches, two of which (b, c) are
    // identical. With relevance tied at 0 for the four, a relevance-only
    // top-k would take the highest-recency pair and could land on both b and c;
    // farthest-point diversity instead skips the duplicate and spreads.
    const spread = [
      branch('anchor', 'create w1.txt containing apple then verify it'),
      branch('b', 'inspected crashed server logs'),
      branch('c', 'inspected crashed server logs'), // identical to b
      branch('d', 'updated the project readme'),
      branch('e', 'looked at the repo layout'),
    ];
    const keep = selectTopKBranches(spread, taskWords, 3);
    expect(keep).toBeDefined();
    expect(keep?.size).toBe(3);
    expect(keep?.has('anchor')).toBe(true); // the clearly-relevant anchor always survives
    // The identical pair (b, c) do NOT both fit: diversity spreads to d/e.
    expect(keep?.has('b') && keep?.has('c')).toBe(false);
  });
});

describe('summary circuit breaker (splitSummarizePlan)', () => {
  it('excludes only the already-failed nodes and keeps fresh siblings pending', () => {
    const failed = new Set(['n_a', 'n_b']);
    expect(splitSummarizePlan(['n_a', 'n_b'], failed)).toEqual({ pending: [], skipped: 2 });
    // A fresh node in the plan must still summarise — only the repeat is stopped.
    expect(splitSummarizePlan(['n_a', 'n_fresh'], failed)).toEqual({ pending: ['n_fresh'], skipped: 1 });
    expect(splitSummarizePlan(['n_fresh'], failed)).toEqual({ pending: ['n_fresh'], skipped: 0 });
    expect(splitSummarizePlan([], failed)).toEqual({ pending: [], skipped: 0 });
  });
});

describe('v6 keep-set combinator (mergeKeepSets)', () => {
  it('never evicts a guarded branch — unfinished work survives any score', () => {
    const keptEver = new Set<string>();
    const keep = mergeKeepSets(['a', 'b', 'c', 'd'], new Set(['a', 'b']), new Set(['d']), keptEver);
    expect(keep).toBeDefined();
    expect([...keep!].sort()).toEqual(['a', 'b', 'd']);
  });

  it('is monotone — a branch kept once is kept on every later turn, so the cached prefix never churns', () => {
    const keptEver = new Set<string>();
    mergeKeepSets(['a', 'b', 'c'], new Set(['a', 'b']), new Set(), keptEver);
    // Next turn the scorer changes its mind about b; membership must not shrink.
    const keep = mergeKeepSets(['a', 'b', 'c', 'd'], new Set(['a', 'd']), new Set(), keptEver);
    expect([...keep!].sort()).toEqual(['a', 'b', 'd']);
  });

  it('returns undefined when everything is kept — the floor property (byte-identical prompt)', () => {
    const keptEver = new Set<string>();
    expect(mergeKeepSets(['a', 'b'], undefined, new Set(), keptEver)).toBeUndefined();
    expect(mergeKeepSets(['a', 'b'], new Set(['a']), new Set(['b']), keptEver)).toBeUndefined();
  });
});

describe('v5.5 incremental Zone C caching (toZoneCCachedRequest)', () => {
  const block = (zone: string, id: string, text: string) => ({ zone, id, text, tokens: 1 });
  const prompt = {
    system: 'zone A contract',
    blocks: [
      block('A', 'A:contract', 'zone A contract'),
      block('B', 'B:summary:n1', 'branch one summary'),
      block('B', 'B:summary:n2', 'branch two summary'),
      block('C', 'C:head:n3', 'active header'),
      block('C', 'C:event:5', 'event five'),
      block('C', 'C:event:6', 'event six'),
      block('C', 'C:map:n3', 'descendant index'),
      block('tail', 'tail:fetch-1', 'fetched detail'),
    ],
    budgets: { zoneA: 1, zoneB: 2, zoneC: 3, tail: 1, total: 7, overBudget: [], droppedFromZoneB: [] },
    cacheBreakpoints: ['A:contract', 'B:summary:n2'],
  } as never;

  it('emits one message per Zone C block with the moving breakpoint on the LAST — prior events become 0.1x reads and only the delta is written, which is native v5.2\'s economics', () => {
    const request = toZoneCCachedRequest(prompt, 'test-model', {});
    const contents = request.messages.map((m) => m.content);
    expect(contents).toEqual([
      'branch one summary\n\nbranch two summary',
      'active header',
      'event five',
      'event six',
      'descendant index\n\nfetched detail',
    ]);
    const marked = request.messages.filter((m) => m.cacheBreakpoint === true).map((m) => m.content);
    // Exactly Zone B's end and the last cached C block. The C:map (churns on
    // every edit) and the tail (rewritten per turn) ride AFTER the marker.
    expect(marked).toEqual(['branch one summary\n\nbranch two summary', 'event six']);
    expect(request.systemCacheBreakpoint).toBe(true);
  });

  it('stays within Anthropic\'s 4-breakpoint limit: system + Zone B + Zone C = 3 markers', () => {
    const request = toZoneCCachedRequest(prompt, 'test-model', {});
    const count =
      (request.systemCacheBreakpoint === true ? 1 : 0) +
      request.messages.filter((m) => m.cacheBreakpoint === true).length;
    expect(count).toBe(3);
  });

  it('appending a Zone C event leaves every earlier message byte-identical — the cached-prefix property the whole design rides on', () => {
    const before = toZoneCCachedRequest(prompt, 'test-model', {});
    const grown = {
      ...(prompt as { blocks: unknown[] }),
      blocks: [
        ...(prompt as { blocks: { zone: string }[] }).blocks.filter((b) => b.zone !== 'tail'),
        block('C', 'C:event:7', 'event seven'),
        block('tail', 'tail:fetch-2', 'newer fetched detail'),
      ],
    } as never;
    const after = toZoneCCachedRequest(grown, 'test-model', {});
    const beforeC = before.messages.slice(0, -1); // drop tail message
    for (const [index, message] of beforeC.entries()) {
      expect(after.messages[index]?.content).toBe(message.content);
    }
  });
});

describe('cosine dedup-before-summarize (dedupSummarizePlan)', () => {
  const detail = (body: string) =>
    `ran the test suite for ${body} and edited the module until the cases passed; reran to confirm green`;

  it('skips a pending branch that duplicates an already-summarized sibling', () => {
    const { kept, deduped } = dedupSummarizePlan(
      [{ id: 'n_new', text: detail('slugify hyphen collapse boundary strip') }],
      [{ id: 'n_done', text: detail('slugify hyphen collapse boundary strip') }],
    );
    expect(kept).toEqual([]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({ id: 'n_new', against: 'n_done' });
    expect(deduped[0]!.cosine).toBeGreaterThanOrEqual(0.9);
  });

  it('dedupes within the plan itself — the first twin summarizes, the second is skipped', () => {
    const { kept, deduped } = dedupSummarizePlan(
      [
        { id: 'n_first', text: detail('wordwrap greedy width joining space overflow') },
        { id: 'n_twin', text: detail('wordwrap greedy width joining space overflow') },
      ],
      [],
    );
    expect(kept).toEqual(['n_first']);
    expect(deduped.map((entry) => entry.id)).toEqual(['n_twin']);
  });

  it('keeps genuinely distinct branches — one summary per topic, not per plan', () => {
    const { kept, deduped } = dedupSummarizePlan(
      [
        { id: 'n_slug', text: detail('slugify hyphen collapse punctuation runs') },
        { id: 'n_num', text: detail('numparse decimal multiplier truncation suffix') },
      ],
      [{ id: 'n_wrap', text: detail('wordwrap greedy width joining space') }],
    );
    expect(kept).toEqual(['n_slug', 'n_num']);
    expect(deduped).toEqual([]);
  });

  it('branchContentText drops the coordinates header so unique node ids cannot dilute the cosine', () => {
    const rendered =
      'BRANCH COORDINATES (from the tree; authoritative — do not contradict these):\nnode: n_abc123 kind=phase\n\nEVENTS (L0 4..9):\nuser: fix the bug';
    expect(branchContentText(rendered)).toBe('EVENTS (L0 4..9):\nuser: fix the bug');
    // No events section => the text passes through rather than vanishing.
    expect(branchContentText('coordinates only')).toBe('coordinates only');
  });
});

describe('vector-space branch scoring (embedding-free DSA machinery)', () => {
  it('termCounts + cosineSimilarity are deterministic and symmetric in direction', () => {
    const a = termCounts('apple banana');
    const b = termCounts('apple cherry');
    const c = termCounts('zebra monkey');
    const ab = cosineSimilarity(a, b);
    expect(ab).toBeCloseTo(cosineSimilarity(b, a), 10);
    expect(ab).toBeGreaterThan(cosineSimilarity(a, c));
    expect(Number.isFinite(ab)).toBe(true);
  });

  it('idfVectors weights rare task terms above corpus-common ones', () => {
    const corpus = ['credential rotate v2', 'credential rotate v2', 'log rotate daily'];
    const query = new Set(contentWords('credential rotate'));
    const { vectors, query: queryVector } = idfVectors(corpus, query);
    // 'rotate' appears in every doc (low idf); 'credential' in fewer (higher idf).
    const rotateIdx = [...queryVector.keys()];
    expect(rotateIdx).toContain('credential');
    expect(rotateIdx).toContain('rotate');
    expect(queryVector.get('credential') ?? 0).toBeGreaterThan(queryVector.get('rotate') ?? 0);
    expect(vectors).toHaveLength(corpus.length);
  });
});

describe('runScenario — native arm', () => {
  it('completes, executes the scripted tool call, and meters honest totals', async () => {
    const { result, finalText } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'native',
      agentProvider: new ScriptedProvider(agentReplies),
      options,
      sink: disabledSink(),
    });
    expect(result.status).toBe('completed');
    expect(result.success).toBe(true);
    expect(finalText).toBe('done');
    expect(result.metrics.turns).toEqual({ modelTurns: 2, toolCalls: 1 });
    expect(result.metrics.tokens.input).toBe(300);
    expect(result.metrics.tokens.output).toBe(15);
    expect(result.metrics.tokens.total).toBe(315);
    expect(result.metrics.costUsd).toBeGreaterThan(0);
    expect(result.metrics.speed.p50TurnMs).toBeGreaterThan(0);
    expect(result.judge?.detail).toContain('matched');
  });
});

describe('runScenario — context-tree arm', () => {
  /** The completion gate nudges once after tool work, so a tree run needs a second bare-text reply to finish. */
  const confirmReply: CompletionResult = {
    text: 'done',
    model: 'test-model',
    usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 },
    toolCalls: [],
    stopReason: 'end_turn',
  };

  it('completes through the real assembler/summarizer/handler path and grades the same', async () => {
    const { result } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'context-tree',
      agentProvider: new ScriptedProvider([...agentReplies, confirmReply]),
      summarizerProvider: new MockProvider({ responder: summaryResponder }),
      options,
      sink: disabledSink(),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(result.success).toBe(true);
    expect(result.metrics.turns.modelTurns).toBe(3);
    expect(result.metrics.tokens.input).toBe(400);
  });

  it('routes context tools through the real MCP handlers without leaving the tree inconsistent', async () => {
    const searchReply: CompletionResult = {
      text: '',
      model: 'test-model',
      usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 },
      toolCalls: [{ id: 't0', name: CONTEXT_SEARCH, input: { query: 'hello' } }],
      stopReason: 'tool_use',
    };
    const { result } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'context-tree',
      agentProvider: new ScriptedProvider([searchReply, ...agentReplies, confirmReply]),
      summarizerProvider: new MockProvider({ responder: summaryResponder }),
      options,
      sink: disabledSink(),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(result.metrics.turns.toolCalls).toBe(2);
  });

  it('completes on the FIRST bare-text reply when no tool work was done', async () => {
    const { result } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'context-tree',
      agentProvider: new ScriptedProvider([agentReplies[1] as CompletionResult]),
      summarizerProvider: new MockProvider({ responder: summaryResponder }),
      options,
      sink: disabledSink(),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(result.metrics.turns.modelTurns).toBe(1);
  });

  it('leaves a rebuildable store behind when the sandbox is kept', async () => {
    const { result } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'context-tree',
      agentProvider: new ScriptedProvider(agentReplies),
      summarizerProvider: new MockProvider({ responder: summaryResponder }),
      options: { ...options, keepSandbox: true },
      sink: disabledSink(),
    });
    const sandboxPath = result.sandboxPath;
    expect(sandboxPath).toBeDefined();
    try {
      expect(existsSync(join(sandboxPath!, '.context-tree', 'tree.db'))).toBe(true);
      expect(existsSync(join(sandboxPath!, 'hello.txt'))).toBe(true);
    } finally {
      if (sandboxPath !== undefined) rmSync(sandboxPath, { recursive: true, force: true });
    }
  });
});

describe('loop9b-item3 gate (EVAL_NO_COMPLETION_GATE)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('skips the nudge and completes on the first bare-text reply after tool work, modelTurns===2', async () => {
    vi.stubEnv('EVAL_NO_COMPLETION_GATE', '1');
    // No confirmReply: with the gate flagged off, a bare-text reply right
    // after tool work must end the run exactly like native's :339-342. If the
    // flag failed to wire through, the loop asks the script for a third reply
    // that was never scripted, and ScriptedProvider throws 'script exhausted'
    // — a fail-loud gate rather than a silently-passing count mismatch.
    const { result } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'context-tree',
      agentProvider: new ScriptedProvider(agentReplies),
      summarizerProvider: new MockProvider({ responder: summaryResponder }),
      options,
      sink: disabledSink(),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(result.metrics.turns.modelTurns).toBe(2);
  });

  it('never writes the nudge into L0 when flagged off', async () => {
    vi.stubEnv('EVAL_FETCH_EVENTS', '1');
    vi.stubEnv('EVAL_NO_COMPLETION_GATE', '1');
    const { result } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'context-tree',
      agentProvider: new ScriptedProvider(agentReplies),
      summarizerProvider: new MockProvider({ responder: summaryResponder }),
      options: { ...options, keepSandbox: true },
      sink: disabledSink(),
    });
    const sandboxPath = result.sandboxPath;
    try {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe('completed');
      const storeRoot = join(sandboxPath!, '.context-tree');
      const trace = readFileSync(join(storeRoot, 'trace.jsonl'), 'utf8');
      const events = trace.trim().split('\n').map((line) => JSON.parse(line));
      const blobs = new FsBlobStore(join(storeRoot, 'blobs'));
      const nudged = events.some(
        (e) => e.type === 'user_message' && blobs.getText(e.blob).includes('you stopped calling tools'),
      );
      expect(nudged).toBe(false);
    } finally {
      if (sandboxPath !== undefined) rmSync(sandboxPath, { recursive: true, force: true });
    }
  });
});

describe('runScenario — caps', () => {
  it('stops at the turn cap and still grades whatever was produced', async () => {
    // Every turn issues a tool call, so only the cap can end the loop.
    const neverDone = new ScriptedProvider(
      Array.from({ length: 10 }, (_, i) => ({
        text: `still working ${i}`,
        model: 'test-model',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        toolCalls: [{ id: `t${i}`, name: 'run_command', input: { command: 'true' } }],
        stopReason: 'tool_use',
      })),
    );
    const { result } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'native',
      agentProvider: neverDone,
      options: { ...options, maxTurns: 3 },
      sink: disabledSink(),
    });
    expect(result.status).toBe('turn_cap');
    expect(result.metrics.turns.modelTurns).toBe(3);
    expect(result.metrics.turns.toolCalls).toBe(3);
    expect(result.success).toBe(false);
  });
});


describe('v5.7 gates (EVAL_LAZY_K / EVAL_DET_ROOT)', () => {
  afterEach(() => vi.unstubAllEnvs());

  /** Alternating implementation/diagnosis tools force multiple phase branches. */
  const phaseCrossingReplies = (): CompletionResult[] => [
    ...['write_file', 'read_file', 'write_file', 'read_file'].map((name, i) => ({
      text: '',
      model: 'test-model',
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      toolCalls: [
        name === 'write_file'
          ? { id: `t${i}`, name, input: { path: `f${i}.txt`, content: 'x' } }
          : { id: `t${i}`, name, input: { path: `f${i - 1}.txt` } },
      ],
      stopReason: 'tool_use' as const,
    })),
    {
      text: 'done',
      model: 'test-model',
      usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0 },
      toolCalls: [],
      stopReason: 'end_turn' as const,
    },
    {
      text: 'done',
      model: 'test-model',
      usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0 },
      toolCalls: [],
      stopReason: 'end_turn' as const,
    },
  ];

  const runTree = async (summarizer: MockProvider) => {
    const { result } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'context-tree',
      agentProvider: new ScriptedProvider(phaseCrossingReplies()),
      summarizerProvider: summarizer,
      options: { ...options, maxTurns: 8, rootModel: 'root-model' },
      sink: disabledSink(),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    return result;
  };

  it('without lazy-k, summarize-on-close pays summarizer calls (the contrast that keeps the gate test honest)', async () => {
    vi.stubEnv('EVAL_SUMMARIZE_ON_CLOSE', '1');
    const summarizer = new MockProvider({ responder: summaryResponder });
    await runTree(summarizer);
    expect(summarizer.requests.length).toBeGreaterThan(0);
  });

  it('below k branches the tree spends ZERO summarizer calls — the architecture devolves to baseline, so it must also cost baseline', async () => {
    vi.stubEnv('EVAL_SUMMARIZE_ON_CLOSE', '1');
    vi.stubEnv('EVAL_LAZY_K', '99');
    const summarizer = new MockProvider({ responder: summaryResponder });
    await runTree(summarizer);
    expect(summarizer.requests).toHaveLength(0);
  });

  it('with det-root the strong model is never called — the root is composed, leaves still summarize on the cheap model', async () => {
    vi.stubEnv('EVAL_SUMMARIZE_ON_CLOSE', '1');
    vi.stubEnv('EVAL_DET_ROOT', '1');
    const summarizer = new MockProvider({ responder: summaryResponder });
    await runTree(summarizer);
    expect(summarizer.requests.length).toBeGreaterThan(0);
    expect(summarizer.requests.every((request) => request.model !== 'root-model')).toBe(true);
  });
});

describe('v5.8 gate (EVAL_FETCH_EVENTS)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('routes context-tool exchanges into L0 as tool_call/tool_result events instead of the never-dropped tail', async () => {
    vi.stubEnv('EVAL_FETCH_EVENTS', '1');
    const searchReply: CompletionResult = {
      text: '',
      model: 'test-model',
      usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 },
      toolCalls: [{ id: 't0', name: CONTEXT_SEARCH, input: { query: 'hello' } }],
      stopReason: 'tool_use',
    };
    const confirm: CompletionResult = {
      text: 'done',
      model: 'test-model',
      usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 },
      toolCalls: [],
      stopReason: 'end_turn',
    };
    const { result } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'context-tree',
      agentProvider: new ScriptedProvider([searchReply, ...agentReplies, confirm]),
      summarizerProvider: new MockProvider({ responder: summaryResponder }),
      options: { ...options, keepSandbox: true },
      sink: disabledSink(),
    });
    const sandboxPath = result.sandboxPath;
    try {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe('completed');
      // L0 is the audit trail: the context tool call must be IN it.
      const { readFileSync } = await import('node:fs');
      const trace = readFileSync(join(sandboxPath!, '.context-tree', 'trace.jsonl'), 'utf8');
      const events = trace.trim().split('\n').map((line) => JSON.parse(line));
      const call = events.find((e) => e.type === 'tool_call' && e.tool === CONTEXT_SEARCH);
      expect(call).toBeDefined();
      expect(events.some((e) => e.type === 'tool_result' && e.call_seq === call.seq)).toBe(true);
      // And the completion nudge is an event too, not a tail block.
      expect(
        events.some((e) => e.type === 'user_message' && e.seq > call.seq),
      ).toBe(true);
    } finally {
      if (sandboxPath !== undefined) rmSync(sandboxPath, { recursive: true, force: true });
    }
  });
});

describe('v6.0 gate (EVAL_LAZY_TOKENS)', () => {
  afterEach(() => vi.unstubAllEnvs());

  const phaseCrossing = (): CompletionResult[] => [
    ...['write_file', 'read_file', 'write_file', 'read_file'].map((name, i) => ({
      text: '',
      model: 'test-model',
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      toolCalls: [
        name === 'write_file'
          ? { id: `t${i}`, name, input: { path: `f${i}.txt`, content: 'x' } }
          : { id: `t${i}`, name, input: { path: `f${i - 1}.txt` } },
      ],
      stopReason: 'tool_use' as const,
    })),
    { text: 'done', model: 'test-model', usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], stopReason: 'end_turn' as const },
    { text: 'done', model: 'test-model', usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], stopReason: 'end_turn' as const },
  ];

  const run = async (summarizer: MockProvider) => {
    const { result } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'context-tree',
      agentProvider: new ScriptedProvider(phaseCrossing()),
      summarizerProvider: summarizer,
      options: { ...options, maxTurns: 8 },
      sink: disabledSink(),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
  };

  it('while the trace fits the budget, ZERO summarizer calls — the tree devolves to baseline and costs baseline', async () => {
    vi.stubEnv('EVAL_SUMMARIZE_ON_CLOSE', '1');
    vi.stubEnv('EVAL_LAZY_TOKENS', '999999');
    const summarizer = new MockProvider({ responder: summaryResponder });
    await run(summarizer);
    expect(summarizer.requests).toHaveLength(0);
  });

  it('once the trace exceeds the budget, summarization resumes (a 1-token budget crosses immediately)', async () => {
    vi.stubEnv('EVAL_SUMMARIZE_ON_CLOSE', '1');
    vi.stubEnv('EVAL_LAZY_TOKENS', '1');
    const summarizer = new MockProvider({ responder: summaryResponder });
    await run(summarizer);
    expect(summarizer.requests.length).toBeGreaterThan(0);
  });

  it('gates on the REAL reported prompt tokens, not chars/4 — cheap-looking text with expensive real tokens still crosses', async () => {
    vi.stubEnv('EVAL_SUMMARIZE_ON_CLOSE', '1');
    vi.stubEnv('EVAL_LAZY_TOKENS', '150');
    // Every turn's appended trace text is a handful of characters (`content: 'x'`)
    // — chars/4 of that never approaches 150 no matter how many turns run, so
    // a reverted (chars/4) gate would report ZERO summarizer calls here. The
    // mocked usage says the model was actually billed 500 tokens/turn, which
    // crosses a 150-token budget on turn 1. Only a real-token gate can tell
    // these two traces apart; that's the whole point of the fix.
    const replies: CompletionResult[] = [
      ...['write_file', 'read_file', 'write_file', 'read_file'].map((name, i) => ({
        text: '',
        model: 'test-model',
        usage: { input: 500, output: 10, cacheRead: 0, cacheWrite: 0 },
        toolCalls: [
          name === 'write_file'
            ? { id: `t${i}`, name, input: { path: `f${i}.txt`, content: 'x' } }
            : { id: `t${i}`, name, input: { path: `f${i - 1}.txt` } },
        ],
        stopReason: 'tool_use' as const,
      })),
      // Two consecutive bare-text replies: the first is consumed by the
      // completion gate's one-time nudge (matches `phaseCrossing()` above).
      { text: 'done', model: 'test-model', usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], stopReason: 'end_turn' as const },
      { text: 'done', model: 'test-model', usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], stopReason: 'end_turn' as const },
    ];
    const summarizer = new MockProvider({ responder: summaryResponder });
    const { result } = await runScenario({
      runId: 'r1',
      scenario,
      arm: 'context-tree',
      agentProvider: new ScriptedProvider(replies),
      summarizerProvider: summarizer,
      options: { ...options, maxTurns: 8 },
      sink: disabledSink(),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(summarizer.requests.length).toBeGreaterThan(0); // 0 under chars/4; >0 under real-usage gating
  });

  it('the crossing is one-way — a prompt that SHRINKS below the budget after summarizing must not re-expand the trace', async () => {
    vi.stubEnv('EVAL_SUMMARIZE_ON_CLOSE', '1');
    vi.stubEnv('EVAL_LAZY_TOKENS', '150');
    // The rule asks whether the WHOLE trace fits the budget. After the crossing
    // the prompt no longer contains the whole trace, so a small prompt is not
    // evidence that it fits again — and L0 only grows. The first live run
    // without a latch alternated modes every turn (40k → <30k → 43k) at twice
    // the cost of either mode. Usage here goes 500 (cross), 100, 100 (shrunk
    // prompt), 500: an unlatched gate reports a second crossing; a latched one
    // reports exactly one.
    const usages = [500, 100, 100, 500];
    const replies: CompletionResult[] = [
      ...['write_file', 'read_file', 'write_file', 'read_file'].map((name, i) => ({
        text: '',
        model: 'test-model',
        usage: { input: usages[i]!, output: 10, cacheRead: 0, cacheWrite: 0 },
        toolCalls: [
          name === 'write_file'
            ? { id: `t${i}`, name, input: { path: `f${i}.txt`, content: 'x' } }
            : { id: `t${i}`, name, input: { path: `f${i - 1}.txt` } },
        ],
        stopReason: 'tool_use' as const,
      })),
      { text: 'done', model: 'test-model', usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], stopReason: 'end_turn' as const },
      { text: 'done', model: 'test-model', usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], stopReason: 'end_turn' as const },
    ];
    const stderrLines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      const { result } = await runScenario({
        runId: 'r1',
        scenario,
        arm: 'context-tree',
        agentProvider: new ScriptedProvider(replies),
        summarizerProvider: new MockProvider({ responder: summaryResponder }),
        options: { ...options, maxTurns: 8 },
        sink: disabledSink(),
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe('completed');
    } finally {
      spy.mockRestore();
    }
    const crossings = stderrLines.filter((line) => line.includes('lazy gate crossed'));
    expect(crossings).toHaveLength(1);
  });
});

describe('loop9-item3 step 1 gate (EVAL_CONTRACT_VERSION) — the Zone A trim arm', () => {
  afterEach(() => vi.unstubAllEnvs());

  const runTreeWithAgent = (agent: MockProvider) =>
    runScenario({
      runId: 'r1',
      scenario,
      arm: 'context-tree',
      agentProvider: agent,
      summarizerProvider: new MockProvider({ responder: summaryResponder }),
      options,
      sink: disabledSink(),
    });

  it('unset EVAL_CONTRACT_VERSION assembles Zone A from v1 — byte-identical to the frozen-epoch default', async () => {
    const agent = new MockProvider({ reply: 'done' });
    const { result } = await runTreeWithAgent(agent);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(agent.requests[0]?.system).toContain('Two ways this goes wrong');
  });

  it('EVAL_CONTRACT_VERSION=v2 assembles Zone A from the trimmed contract, dropping the "Two ways this goes wrong" section', async () => {
    vi.stubEnv('EVAL_CONTRACT_VERSION', 'v2');
    const agent = new MockProvider({ reply: 'done' });
    const { result } = await runTreeWithAgent(agent);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    const system = agent.requests[0]?.system ?? '';
    expect(system).not.toContain('Two ways this goes wrong');
    // The surviving Rules/Tools sections must still reach the model — this is a
    // deletion of one section, not a broken Zone A.
    expect(system).toContain('context_fetch');
    expect(system).toContain('Before editing any file');
  });

  it('an unrecognized EVAL_CONTRACT_VERSION throws rather than silently falling back to v1', async () => {
    vi.stubEnv('EVAL_CONTRACT_VERSION', 'v9');
    const agent = new MockProvider({ reply: 'done' });
    const { result } = await runTreeWithAgent(agent);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/unknown system contract version: v9/);
    // The whole point of failing loudly: no request was ever sent with a
    // silently-substituted contract.
    expect(agent.requests).toHaveLength(0);
  });
});
