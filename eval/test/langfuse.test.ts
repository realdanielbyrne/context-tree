/**
 * The Langfuse sink, against an injected stub client — no network. What matters
 * here: the pairing contract (one trace per scenario×arm, sessionId shared by
 * both arms), generations carrying usage+cost, metric scores on finish, and the
 * honest no-op when keys are absent or export is disabled.
 */
import { describe, expect, it } from 'vitest';
import {
  createLangfuseSink,
  disabledSink,
  type LangfuseClientLike,
  type LangfuseTraceFields,
} from '../src/langfuse.js';
import { summarizeMetrics, ZERO_TOTALS } from '../src/metrics.js';
import type { RunMetrics } from '../src/types.js';

interface Recorded {
  traces: LangfuseTraceFields[];
  generations: Array<Record<string, unknown>>;
  scores: Array<{ name: string; value: number; comment?: string }>;
  flushes: number;
  shutdowns: number;
}

function stubClient(): { client: LangfuseClientLike; recorded: Recorded } {
  const recorded: Recorded = { traces: [], generations: [], scores: [], flushes: 0, shutdowns: 0 };
  const client: LangfuseClientLike = {
    trace: (fields) => {
      recorded.traces.push(fields);
      return {
        generation: (fields) => {
          recorded.generations.push(fields as unknown as Record<string, unknown>);
        },
        score: (fields) => {
          recorded.scores.push({
            name: fields.name,
            value: fields.value,
            ...(fields.comment === undefined ? {} : { comment: fields.comment }),
          });
        },
        update: () => undefined,
      };
    },
    flushAsync: async () => {
      recorded.flushes += 1;
    },
    shutdownAsync: async () => {
      recorded.shutdowns += 1;
    },
  };
  return { client, recorded };
}


const metrics: RunMetrics = summarizeMetrics({
  turns: [],
  wallMs: 1234,
  usage: { ...ZERO_TOTALS, input: 100, output: 20, total: 120 },
  costUsd: 0.0042,
});

describe('createLangfuseSink', () => {
  it('is a no-op without keys — a run without Langfuse must still work', async () => {
    const sink = createLangfuseSink({});
    expect(sink.enabled).toBe(false);
    const handle = sink.startRun({
      runId: 'r',
      benchmark: 'hle-tools',
      scenarioId: 'q1',
      arm: 'native',
      model: 'm',
      scenarioTask: 't',
      meta: {},
    });
    expect(() => handle.generation({
      name: 'turn-0', model: 'm', input: {}, output: {}, usage: { input: 1, output: 1, unit: 'TOKENS', totalCost: 0 }, metadata: {},
    })).not.toThrow();
    handle.finish('completed', metrics, true, '');
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  it('is disabled by LANGFUSE_TRACING_DISABLED=1 even with keys present', () => {
    expect(createLangfuseSink({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk', LANGFUSE_TRACING_DISABLED: '1' }).enabled).toBe(false);
  });

  it('pairs the two arms of a scenario on one sessionId and tags arm + model', async () => {
    const { client, recorded } = stubClient();
    const sink = createLangfuseSink({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }, async () => client);
    for (const arm of ['native', 'context-tree'] as const) {
      const handle = sink.startRun({
        runId: 'r1',
        benchmark: 'hle-tools',
        scenarioId: 'q1',
        arm,
        model: 'claude-sonnet-5',
        scenarioTask: 'the task',
        meta: { judgeKind: 'exact_match' },
      });
      handle.generation({
        name: 'turn-0',
        model: 'claude-sonnet-5',
        input: { messageCount: 1 },
        output: { textChars: 4 },
        usage: { input: 100, output: 20, unit: 'TOKENS', totalCost: 0.001 },
        metadata: { cacheRead: 5 },
      });
      handle.finish('completed', metrics, true, 'matched');
    }
    await sink.flush();
    expect(recorded.traces).toHaveLength(2);
    expect(recorded.traces[0]!.sessionId).toBe('hle-tools:q1');
    expect(recorded.traces[1]!.sessionId).toBe('hle-tools:q1');
    expect(recorded.traces.map((trace) => trace.tags)).toContainEqual(['hle-tools', 'arm:native', 'model:claude-sonnet-5', 'run:r1']);
    expect(recorded.generations).toHaveLength(2);
    expect(recorded.generations[0]!['usage']).toEqual({ input: 100, output: 20, unit: 'TOKENS', totalCost: 0.001 });
    expect(recorded.scores.map((score) => score.name)).toContain('success');
    expect(recorded.scores.map((score) => score.name)).toContain('total_tokens');
    expect(recorded.flushes).toBe(1);
  });

  it('disabledSink never throws and never flushes', async () => {
    const sink = disabledSink();
    const handle = sink.startRun({
      runId: 'r', benchmark: 'b', scenarioId: 's', arm: 'native', model: 'm', scenarioTask: 't', meta: {},
    });
    handle.finish('error', metrics, null, '');
    await sink.shutdown();
    expect(sink.enabled).toBe(false);
  });
});
