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
import { runScenario } from '../src/loop.js';
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
  it('completes through the real assembler/summarizer/handler path and grades the same', async () => {
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
    expect(result.success).toBe(true);
    expect(result.metrics.turns.modelTurns).toBe(2);
    expect(result.metrics.tokens.input).toBe(300);
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
      agentProvider: new ScriptedProvider([searchReply, ...agentReplies]),
      summarizerProvider: new MockProvider({ responder: summaryResponder }),
      options,
      sink: disabledSink(),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(result.metrics.turns.toolCalls).toBe(2);
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

