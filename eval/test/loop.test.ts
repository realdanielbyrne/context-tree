/**
 * End-to-end loop test, fully offline: a ScriptedProvider plays the agent (one
 * tool call, then a final answer) and a MockProvider plays the §8 summarizer
 * with contract-abiding replies that echo the node ids the prompt shows it.
 * Both arms must complete, meter honest usage, and grade through the judge.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CompletionRequest, CompletionResult, ModelProvider } from '@context-tree/core';
import { MockProvider } from '@context-tree/core';
import { CONTEXT_SEARCH } from '@context-tree/mcp';
import { disabledSink } from '../src/langfuse.js';
import {
  runScenario,
  selectTopKMessages,
  selectTopKBranches,
  splitSummarizePlan,
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

