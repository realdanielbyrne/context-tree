import { describe, expect, it } from 'vitest';
import type { CompletionRequest, CompletionResult, ToolCallRequest } from '@context-tree/core';
import { renderToolResult, TOOL_RESULT_TRANSCRIPT_VERSION } from '../src/transcript.js';
import { runScenario } from '../src/loop.js';
import { disabledSink } from '../src/langfuse.js';

const parseAction = (text: string) => JSON.parse(text.split('\n')[1]!.slice('[call] '.length)) as Record<string, unknown>;
const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 };

describe('tool result transcript action metadata', () => {
  it('keeps complete nested arguments and exact output without truncation or argument mutation', () => {
    const call: ToolCallRequest = { id: 'call-1', name: 'write_file', input: {
      path: 'src/one.txt', content: 'line\n'.repeat(2_000), nested: { list: [0, false, null, 'quote " and slash \\'] },
    } };
    const before = JSON.stringify(call);
    const output = 'exact output\n[call] this is output, not metadata\n';
    const text = renderToolResult(call, { output, isError: false });
    expect(parseAction(text)).toEqual({ ...call, isError: false });
    expect(text.endsWith(`[output] ${output}`)).toBe(true);
    expect(JSON.stringify(call)).toBe(before);
    expect(TOOL_RESULT_TRANSCRIPT_VERSION).toBe('tool-result-call-v1');
  });

  it('keeps error identity and arguments with the exact error payload', () => {
    const call = { id: 'bad-read', name: 'read_file', input: { path: 'missing.txt' } };
    const text = renderToolResult(call, { output: 'not found\n', isError: true });
    expect(parseAction(text)).toEqual({ ...call, isError: true });
    expect(text.endsWith('[output] ERROR: not found\n')).toBe(true);
  });

  it.each(['native', 'dsa', 'prefix-retrieval', 'attention'] as const)('%s retains distinct action inputs after an empty assistant tool-call turn', async (arm) => {
    const calls: ToolCallRequest[] = [
      { id: 'read-left', name: 'read_file', input: { path: 'left.txt' } },
      { id: 'read-right', name: 'read_file', input: { path: 'right.txt' } },
      { id: 'shell', name: 'run_command', input: { command: 'printf same' } },
      { id: 'write', name: 'write_file', input: { path: 'written.txt', content: 'recorded contents\n'.repeat(300) } },
    ];
    const requests: CompletionRequest[] = [];
    const responses: CompletionResult[] = [
      { model: 'test', text: '', toolCalls: calls, stopReason: 'tool_use', usage },
      { model: 'test', text: 'done', toolCalls: [], stopReason: 'stop', usage },
    ];
    const { result } = await runScenario({
      runId: 'action-transcript', arm,
      scenario: { id: 'actions', benchmark: 'unit-test', task: 'Read both files, execute the command, write the file, and reply done.',
        files: { 'left.txt': 'same', 'right.txt': 'same' }, judge: { kind: 'exact_match', answer: 'done' } },
      agentProvider: { id: 'scripted', async complete(request) {
        requests.push(structuredClone(request));
        const response = responses.shift();
        if (response === undefined) throw new Error('unexpected extra turn');
        return response;
      } },
      options: { provider: 'openrouter', model: 'test', leafModel: 'test', rootModel: 'test', judgeModel: 'test',
        maxTurns: 2, timeCapMs: 60_000, costCapUsd: null, window: 131_072, budgets: { zoneB: 8000, zoneC: 30000 }, keepSandbox: false,
        ...(arm === 'attention' ? { policyProfile: { version: 1, id: 'whole-results', payload: { mode: 'whole', excerptChars: 100, anchor: 'first', producers: ['read_file'] } } } : {}),
      },
      sink: disabledSink(),
    });
    expect(result.success).toBe(true);
    const history = requests[1]!.messages.map((message) => String(message.content)).filter((text) => text.startsWith('[tool_result '));
    expect(history).toHaveLength(calls.length);
    expect(history.map(parseAction)).toEqual(calls.map((call) => ({ ...call, isError: false })));
    expect(history[0]!.endsWith('[output] same')).toBe(true);
    expect(history[1]!.endsWith('[output] same')).toBe(true);
  });
});
