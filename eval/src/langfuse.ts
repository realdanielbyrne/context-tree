/**
 * Langfuse A/B export for the §15 harness. One trace per scenario × arm;
 * `sessionId` is `<benchmark>:<scenarioId>` so the two arms of the same
 * scenario pair up in the Sessions view, and tags carry
 * `[benchmark, arm:<arm>, model:<model>]` for dashboard filtering.
 *
 * Per model call: one generation with model, usage (input/output TOKENS plus
 * the cache split in metadata) and computed cost. On completion: numeric
 * scores (success, total_tokens, turns, tool_calls, wall_ms, cost_usd) so
 * Langfuse dashboards can chart the A/B directly.
 *
 * The client is injected or lazily imported; without keys (or with
 * LANGFUSE_TRACING_DISABLED=1) the sink is an honest no-op, so tests and
 * dry runs never touch the network.
 */
import type { Arm, RunMetrics } from './types.js';

export interface LangfuseGenerationFields {
  name: string;
  model: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  usage?: { input: number; output: number; unit: 'TOKENS'; totalCost?: number };
  metadata: Record<string, unknown>;
}

export interface LangfuseTraceFields {
  name: string;
  sessionId: string;
  tags: string[];
  metadata: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
}

export interface LangfuseTraceLike {
  generation(fields: LangfuseGenerationFields): unknown;
  score(fields: { name: string; value: number; comment?: string }): void;
  update(fields: { output?: unknown; metadata?: Record<string, unknown> }): void;
}

export interface LangfuseClientLike {
  trace(fields: LangfuseTraceFields): LangfuseTraceLike;
  flushAsync(): Promise<void>;
  shutdownAsync(): Promise<void>;
}

export type LangfuseClientFactory = () => Promise<LangfuseClientLike>;

export interface RunTraceInfo {
  runId: string;
  benchmark: string;
  scenarioId: string;
  arm: Arm;
  model: string;
  scenarioTask: string;
  meta: Record<string, unknown>;
}

export interface LangfuseRunHandle {
  generation(fields: LangfuseGenerationFields): void;
  score(name: string, value: number, comment?: string): void;
  finish(status: string, metrics: RunMetrics, success: boolean | null, judgeDetail: string): void;
}

export interface LangfuseSink {
  readonly enabled: boolean;
  startRun(info: RunTraceInfo): LangfuseRunHandle;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const NOOP_HANDLE: LangfuseRunHandle = {
  generation: () => undefined,
  score: () => undefined,
  finish: () => undefined,
};

export function disabledSink(): LangfuseSink {
  return {
    enabled: false,
    startRun: () => NOOP_HANDLE,
    flush: async () => undefined,
    shutdown: async () => undefined,
  };
}

function defaultClientFactory(publicKey: string, secretKey: string, baseUrl?: string): LangfuseClientFactory {
  return async () => {
    const mod = await import('langfuse');
    const client = new mod.Langfuse({ publicKey, secretKey, ...(baseUrl === undefined ? {} : { baseUrl }) });
    return client as unknown as LangfuseClientLike;
  };
}

export function createLangfuseSink(
  env: NodeJS.ProcessEnv = process.env,
  clientFactory?: LangfuseClientFactory,
): LangfuseSink {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  const baseUrl = env.LANGFUSE_BASE_URL ?? env.LANGFUSE_HOST;
  const disabledByFlag = env.LANGFUSE_TRACING_DISABLED === '1' || env.LANGFUSE_TRACING_DISABLED === 'true';
  if (disabledByFlag || publicKey === undefined || secretKey === undefined) {
    return disabledSink();
  }

  const getClient = clientFactory ?? defaultClientFactory(publicKey, secretKey, baseUrl);
  let clientPromise: Promise<LangfuseClientLike> | null = null;
  const client = async (): Promise<LangfuseClientLike | null> => {
    if (clientPromise === null) clientPromise = getClient();
    try {
      return await clientPromise;
    } catch (error) {
      console.error(`[langfuse] client init failed — tracing disabled for this run: ${(error as Error).message}`);
      return null;
    }
  };

  return {
    enabled: true,
    startRun(info: RunTraceInfo): LangfuseRunHandle {
      const tracePromise = client().then((resolved) =>
        resolved === null
          ? null
          : resolved.trace({
              name: `eval:${info.benchmark}`,
              sessionId: `${info.benchmark}:${info.scenarioId}`,
              tags: [info.benchmark, `arm:${info.arm}`, `model:${info.model}`, `run:${info.runId}`],
              metadata: { ...info.meta, arm: info.arm, benchmark: info.benchmark, model: info.model, runId: info.runId, scenarioId: info.scenarioId },
              input: info.scenarioTask,
            }),
      );
      const withTrace = async <T>(fn: (trace: LangfuseTraceLike) => T): Promise<T | undefined> => {
        try {
          const trace = await tracePromise;
          return trace === null ? undefined : fn(trace);
        } catch (error) {
          console.error(`[langfuse] trace call failed: ${(error as Error).message}`);
          return undefined;
        }
      };
      return {
        generation: (fields) => {
          void withTrace((trace) => trace.generation(fields));
        },
        score: (name, value, comment) => {
          void withTrace((trace) => trace.score({ name, value, ...(comment === undefined ? {} : { comment }) }));
        },
        finish: (status, metrics, success, judgeDetail) => {
          void withTrace((trace) => {
            trace.score({ name: 'total_tokens', value: metrics.tokens.total });
            trace.score({ name: 'input_tokens', value: metrics.tokens.input });
            trace.score({ name: 'output_tokens', value: metrics.tokens.output });
            trace.score({ name: 'turns', value: metrics.turns.modelTurns });
            trace.score({ name: 'tool_calls', value: metrics.turns.toolCalls });
            trace.score({ name: 'wall_ms', value: metrics.speed.wallMs });
            trace.score({ name: 'cost_usd', value: metrics.costUsd });
            if (success !== null) trace.score({ name: 'success', value: success ? 1 : 0, comment: judgeDetail.slice(0, 500) });
            trace.update({ output: { status, metrics } });
          });
        },
      };
    },
    flush: async () => {
      const resolved = await client();
      if (resolved !== null) await resolved.flushAsync();
    },
    shutdown: async () => {
      const resolved = await client();
      if (resolved !== null) await resolved.shutdownAsync();
    },
  };
}
