/**
 * The §15 harness agent loop — "implements its own minimal tool-use loop"
 * (packages/mcp contract). Each scenario runs twice on the same frontier model:
 *
 *   native        full-transcript context. The message list grows every turn;
 *                 tools are the four harness tools only.
 *   context-tree  the tree IS the context. Every turn's events are appended to
 *                 L0 via `appendEvent`, the §8 summarizer refreshes stale
 *                 branches, and the request is assembled by ZoneAssembler
 *                 (Zone A contract + schemas, Zone B summaries, Zone C active
 *                 branch, tail fetches). The four §9 tools are dispatched
 *                 through the same HANDLERS the MCP server registers.
 *
 * Metrics per run: token totals with the provider's cache split, model turns +
 * tool calls, per-turn latency percentiles, and USD cost via InMemoryCostMeter
 * over every model call in the run — agent, §8 summarizer and judge alike, so
 * the A/B pays for what it actually spends.
 */
import {
  CostCapExceededError,
  HeuristicTokenizer,
  InMemoryCostMeter,
  MeteredProvider,
  Summarizer,
  TreeRetriever,
  ZoneAssembler,
  appendEvent,
  openTaskStore,
  priceFor,
  resolveConfig,
  systemContract,
  toCompletionRequest,
  usdFor,
  type AppendResult,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContextTreeConfig,
  type ModelProvider,
  type TaskStore,
  type ToolCallRequest,
  type TraceEventInput,
} from '@context-tree/core';
import { HANDLERS, type ToolContext, type ToolName } from '@context-tree/mcp';
import {
  CONTEXT_TOOL_SCHEMAS,
  HARNESS_TOOL_SCHEMAS,
  TREE_COMPLETION_ADDENDUM,
  TREE_ZONE_A_TOOL_SCHEMAS_TEXT,
  executeHarnessTool,
  isContextTool,
  isHarnessTool,
  pathOf,
  type ToolCallOutcome,
} from './tools.js';
import { addTotals, summarizeMetrics, ZERO_TOTALS } from './metrics.js';
import { judgeScenario } from './scoring.js';
import { createSandbox, type Sandbox } from './sandbox.js';
import type { LangfuseRunHandle, LangfuseSink } from './langfuse.js';
import type { Arm, HarnessOptions, RunResult, RunStatus, Scenario, TokenTotals, TurnRecord } from './types.js';
import { join } from 'node:path';

const NATIVE_SYSTEM_PROMPT = [
  'You are a capable coding agent working inside a task sandbox.',
  'Complete the task using the provided tools. Keep tool outputs and file edits precise,',
  'and verify your work by running the relevant commands.',
  'When the task is complete, STOP calling tools and reply with your final answer —',
  'a reply without tool calls ends the task, so make that reply the deliverable the task asks for.',
].join('\n');

const AGENT_MAX_TOKENS = 8192;

export interface LoopOptions {
  runId: string;
  scenario: Scenario;
  arm: Arm;
  agentProvider: ModelProvider;
  /**
   * The §8 summarizer's provider, separate from the agent's only so an offline
   * test can script the two independently. Live runs leave it unset and the
   * agent's provider is reused.
   */
  summarizerProvider?: ModelProvider;
  options: HarnessOptions;
  sink: LangfuseSink;
}

export interface LoopOutput {
  result: RunResult;
  finalText: string;
}

interface ArmArgs {
  scenario: Scenario;
  config: ContextTreeConfig;
  options: HarnessOptions;
  provider: ModelProvider;
  sandbox: Sandbox;
  turns: TurnRecord[];
  usage: TokenTotals;
  runHandle: LangfuseRunHandle;
  deadlineMs: number;
}

interface ArmOutput {
  status: RunStatus;
  finalText: string;
}

async function callModel(args: {
  provider: ModelProvider;
  request: CompletionRequest;
  turnIndex: number;
  runHandle: LangfuseRunHandle;
  usage: TokenTotals;
}): Promise<{ result: CompletionResult; record: TurnRecord }> {
  const startedAt = Date.now();
  const result = await args.provider.complete(args.request);
  const latencyMs = Math.max(1, Date.now() - startedAt);
  const record: TurnRecord = {
    index: args.turnIndex,
    latencyMs,
    usage: result.usage,
    toolCalls: result.toolCalls.map((call) => call.name),
    stopReason: result.stopReason,
  };
  args.runHandle.generation({
    name: `turn-${args.turnIndex}`,
    model: result.model,
    input: {
      systemChars: args.request.system?.length ?? 0,
      messageCount: args.request.messages.length,
      tools: args.request.tools?.map((tool) => tool.name) ?? [],
    },
    output: { textChars: result.text.length, toolCalls: record.toolCalls, stopReason: result.stopReason },
    usage: {
      input: result.usage.input,
      output: result.usage.output,
      unit: 'TOKENS',
      totalCost: usdFor(result.usage, priceFor(result.model).price),
    },
    metadata: { cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite, latencyMs },
  });
  return { result, record };
}

function toolResultMessage(call: ToolCallRequest, outcome: ToolCallOutcome): string {
  return `[tool_result ${call.name}] ${outcome.isError ? 'ERROR: ' : ''}${outcome.output}`;
}

/**
 * Repeat-call guard, identical in both arms (so the A/B stays fair): a harness
 * capability, not a context feature. Re-issuing a byte-identical tool call is
 * the signature of an autopilot loop — the result is already in context — so
 * the second call gets guidance instead of another execution.
 */
export function makeRepeatGuard() {
  const seen = new Set<string>();
  return (call: ToolCallRequest, execute: () => Promise<ToolCallOutcome>): Promise<ToolCallOutcome> => {
    const signature = `${call.name}:${JSON.stringify(call.input)}`;
    if (seen.has(signature)) {
      return Promise.resolve({
        output:
          'error: you already ran this exact call and its result is recorded above. ' +
          'Repeating it cannot produce new information. Act on the recorded result, or reply with your final answer now.',
        isError: true,
      });
    }
    seen.add(signature);
    return execute();
  };
}

async function runNativeArm(args: ArmArgs): Promise<ArmOutput> {
  const messages: ChatMessage[] = [{ role: 'user', content: args.scenario.task }];
  const guard = makeRepeatGuard();
  let finalText = '';
  for (let turnIndex = 0; turnIndex < args.options.maxTurns; turnIndex += 1) {
    if (Date.now() >= args.deadlineMs) return { status: 'time_cap', finalText };
    const request: CompletionRequest = {
      model: args.options.model,
      system: NATIVE_SYSTEM_PROMPT,
      messages: [...messages],
      tools: HARNESS_TOOL_SCHEMAS,
      maxTokens: AGENT_MAX_TOKENS,
    };
    const { result, record } = await callModel({
      provider: args.provider,
      request,
      turnIndex,
      runHandle: args.runHandle,
      usage: args.usage,
    });
    args.turns.push(record);
    Object.assign(args.usage, addTotals(args.usage, result.usage));
    messages.push({ role: 'assistant', content: result.text });
    if (result.toolCalls.length === 0) {
      finalText = result.text;
      return { status: 'completed', finalText };
    }
    for (const call of result.toolCalls) {
      const outcome = await guard(call, () => executeHarnessTool(args.sandbox, call.name, call.input));
      messages.push({ role: 'user', content: toolResultMessage(call, outcome) });
    }
  }
  return { status: 'turn_cap', finalText };
}

function appendTo(handle: TaskStore, input: TraceEventInput): AppendResult {
  return appendEvent(handle, input);
}

async function resummarize(summarizer: Summarizer): Promise<void> {
  const outcomes = await summarizer.resummarizeStale();
  const failed = outcomes.filter((outcome) => outcome.status === 'failed');
  for (const outcome of failed) {
    // §8: the assembler never blocks on the summarizer — a half-summarized
    // tree is still usable, so a dead leaf degrades the run (and shows up as a
    // stale-summary incident, which §15 counts) instead of killing it.
    process.stderr.write(
      `[eval] summarization failed on ${outcome.nodeId} (${outcome.role}): ${outcome.error?.message ?? 'unknown error'}\n`,
    );
  }
}

async function runTreeArm(args: ArmArgs & { summarizerProvider: ModelProvider }): Promise<ArmOutput> {
  const handle = openTaskStore(args.config);
  try {
    const summarizer = new Summarizer({
      store: handle.store,
      provider: args.summarizerProvider,
      leafModel: args.options.leafModel,
      rootModel: args.options.rootModel,
      trace: handle.trace,
      blobs: handle.blobs,
      maxSummaryTokens: 1024,
    });
    const retriever = new TreeRetriever({ store: handle.store, blobs: handle.blobs, trace: handle.trace });
    const toolCtx: ToolContext = { config: args.config, handle, retriever };
    const guard = makeRepeatGuard();
    const assembler = new ZoneAssembler({
      store: handle.store,
      blobs: handle.blobs,
      trace: handle.trace,
      tokenizer: new HeuristicTokenizer(),
      systemContract: systemContract() + TREE_COMPLETION_ADDENDUM,
      budgets: { ...args.options.budgets },
    });

    const ts = () => new Date().toISOString();
    appendTo(handle, { type: 'user_message', ts: ts(), blob: handle.blobs.put(args.scenario.task) });
    await resummarize(summarizer);

    const treeTools = [...HARNESS_TOOL_SCHEMAS, ...CONTEXT_TOOL_SCHEMAS];
    let finalText = '';
    let tailCounter = 0;
    for (let turnIndex = 0; turnIndex < args.options.maxTurns; turnIndex += 1) {
      if (Date.now() >= args.deadlineMs) return { status: 'time_cap', finalText };
      const prompt = assembler.assemble({
        toolSchemasText: TREE_ZONE_A_TOOL_SCHEMAS_TEXT,
        // appendEvent re-ingests the whole log each turn, and the segmenter ends
        // every trace by closing all phases and the task node — so openPhase()
        // is ALWAYS null here and the assembler would emit an empty Zone C (the
        // investigate-1 root cause: the model never saw its own tool results and
        // looped on stale summaries). Zone C must not vanish: expand the root,
        // which spans the whole trace.
        activeNodeId: handle.store.openPhase()?.id ?? handle.store.root()?.id,
      });
      const request = toCompletionRequest(prompt, args.options.model, {
        tools: treeTools,
        maxTokens: AGENT_MAX_TOKENS,
      });
      const { result, record } = await callModel({
        provider: args.provider,
        request,
        turnIndex,
        runHandle: args.runHandle,
        usage: args.usage,
      });
      args.turns.push(record);
      Object.assign(args.usage, addTotals(args.usage, result.usage));

      const openBefore = handle.store.openPhase()?.id ?? null;
      const assistantEvent = appendTo(handle, {
        type: 'assistant_message',
        ts: ts(),
        blob: handle.blobs.put(result.text),
      });
      if (result.toolCalls.length === 0) {
        finalText = result.text;
        await resummarize(summarizer);
        return { status: 'completed', finalText };
      }
      for (const call of result.toolCalls) {
        if (isHarnessTool(call.name)) {
          const outcome = await guard(call, () => executeHarnessTool(args.sandbox, call.name, call.input));
          const contentBlob =
            outcome.postContent !== undefined ? handle.blobs.put(outcome.postContent) : undefined;
          const callEvent = appendTo(handle, {
            type: 'tool_call',
            ts: ts(),
            tool: call.name,
            path: pathOf(call.input),
            args_blob: handle.blobs.put(JSON.stringify(call.input)),
            blob: contentBlob,
            parent_seq: assistantEvent.event.seq,
          });
          appendTo(handle, {
            type: 'tool_result',
            ts: ts(),
            call_seq: callEvent.event.seq,
            output_blob: handle.blobs.put(outcome.output),
            error: outcome.isError ? outcome.output.slice(0, 500) : undefined,
          });
        } else if (isContextTool(call.name)) {
          const outcome = await HANDLERS[call.name as ToolName](toolCtx, call.input);
          const text = outcome.ok
            ? JSON.stringify(outcome.data)
            : `error ${outcome.error.code}: ${outcome.error.message}`;
          tailCounter += 1;
          assembler.appendTail({ id: `${call.name}-${tailCounter}`, text, ephemeral: true });
        } else {
          tailCounter += 1;
          assembler.appendTail({
            id: `unknown-tool-${tailCounter}`,
            text: `error invalid_input: unknown tool ${call.name}`,
            ephemeral: true,
          });
        }
      }
      await resummarize(summarizer);
      const openAfter = handle.store.openPhase()?.id ?? null;
      if (openAfter !== openBefore) assembler.onPhaseTransition();
    }
    return { status: 'turn_cap', finalText };
  } finally {
    handle.close();
  }
}


export async function runScenario(loop: LoopOptions): Promise<LoopOutput> {
  const { scenario, arm, options } = loop;
  const label = `${scenario.benchmark}-${scenario.id}`;
  const sandbox = createSandbox(scenario, label);
  const startedAt = new Date();
  const turns: TurnRecord[] = [];
  const usage: TokenTotals = { ...ZERO_TOTALS };
  const costMeter = new InMemoryCostMeter({ capUsd: options.costCapUsd });
  const meteredAgent = new MeteredProvider(loop.agentProvider, costMeter);
  const meteredSummarizer = new MeteredProvider(loop.summarizerProvider ?? loop.agentProvider, costMeter);

  const runHandle = loop.sink.startRun({
    runId: loop.runId,
    benchmark: scenario.benchmark,
    scenarioId: scenario.id,
    arm,
    model: options.model,
    scenarioTask: scenario.task,
    meta: { judgeKind: scenario.judge.kind, ...(scenario.meta ?? {}) },
  });

  let status: RunStatus = 'error';
  let errorText: string | undefined;
  let finalText = '';
  let success: boolean | null = null;
  let judgeDetail = '';

  try {
    const config = resolveConfig({
      root: join(sandbox.path, '.context-tree'),
      provider: options.provider,
      leafModel: options.leafModel,
      rootModel: options.rootModel,
      judgeModel: options.judgeModel,
      budgets: { ...options.budgets },
      taskTitle: `${scenario.benchmark}/${scenario.id}`,
    });
    const armArgs: ArmArgs = {
      scenario,
      config,
      options,
      provider: meteredAgent,
      sandbox,
      turns,
      usage,
      runHandle,
      deadlineMs: startedAt.getTime() + options.timeCapMs,
    };
    const output =
      arm === 'native'
        ? await runNativeArm(armArgs)
        : await runTreeArm({ ...armArgs, summarizerProvider: meteredSummarizer });
    status = output.status;
    finalText = output.finalText;
  } catch (error) {
    if (error instanceof CostCapExceededError) {
      status = 'cost_cap';
    } else {
      errorText = `${(error as Error).name}: ${(error as Error).message}`;
    }
  }

  if (errorText === undefined && (status === 'completed' || status === 'turn_cap' || status === 'time_cap')) {
    try {
      const judge = await judgeScenario({
        scenario,
        sandbox,
        finalText,
        provider: meteredAgent,
        judgeModel: options.judgeModel,
      });
      success = judge.success;
      judgeDetail = judge.detail;
    } catch (error) {
      if (error instanceof CostCapExceededError) {
        status = 'cost_cap';
      } else {
        errorText = `judge: ${(error as Error).name}: ${(error as Error).message}`;
      }
    }
  }

  const finishedAt = new Date();
  const wallMs = finishedAt.getTime() - startedAt.getTime();
  const metrics = summarizeMetrics({ turns, wallMs, usage, costUsd: costMeter.totalUsd() });
  runHandle.finish(status, metrics, success, judgeDetail);
  if (options.keepSandbox) sandbox.writeFile('.final-answer.txt', finalText);
  else sandbox.cleanup();

  const result: RunResult = {
    runId: loop.runId,
    benchmark: scenario.benchmark,
    scenarioId: scenario.id,
    arm,
    model: options.model,
    status,
    success,
    judge: { success, detail: judgeDetail },
    metrics,
    turns: [...turns],
    error: errorText,
    sandboxPath: options.keepSandbox ? sandbox.path : undefined,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
  return { result, finalText };
}

