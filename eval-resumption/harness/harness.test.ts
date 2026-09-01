/**
 * §15 harness tests. Every fixture here is SYNTHETIC — hand-authored in this
 * file — because a trace log is a verbatim record of someone's private work and
 * scrubbing is never provably complete (docs/TESTING.md).
 *
 * No network anywhere. Model replies come from `MockProvider` and
 * `RecordedProvider`; the three cases that need a model to emit TOOL CALLS use
 * a local object implementing `ModelProvider`, because neither offline provider
 * in core can produce a tool call from a request the loop composed itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MockProvider,
  RecordedProvider,
  TreeRetriever,
  ingest,
  openTaskStore,
  requestKey,
  resolveConfig,
  writeCassette,
  type Cassette,
  type CompletionRequest,
  type CompletionResult,
  type TaskStore,
  type TokenUsage,
} from '@context-tree/core';
import {
  ANNOTATE,
  CONTEXT_FETCH,
  CONTEXT_PEEK,
  CONTEXT_SEARCH,
  TOOL_NAMES,
  annotateInputShape,
  contextFetchInputShape,
  contextPeekInputShape,
  contextSearchInputShape,
  type ToolContext,
} from '@context-tree/mcp';
import {
  ARM_IDS,
  TOOL_SCHEMAS,
  buildArm,
  createArmRuntime,
  mcpToolBinding,
  type ArmId,
  type ArmRuntime,
} from './arms.js';
import { evaluateCriteria } from './criteria.js';
import { judgeRun, parseJudgeVerdict, parseRubric, type Rubric } from './judge.js';
import { runToolLoop, type ToolCallRecord } from './loop.js';
import { aggregate, aggregateArm, peekPrecision, percentile, type ArmRunResult } from './metrics.js';
import {
  DEFAULT_RUN_ARGS,
  EvalBudgetError,
  parseRunArgs,
  renderSummaryMarkdown,
  runEvaluation,
  type RunArgs,
} from './run.js';
import {
  materializeTrace,
  parseTask,
  taskEvents,
  validateTask,
  type EvalTask,
  type TaskEvent,
} from './task-spec.js';

const temps: string[] = [];
const handles: TaskStore[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
  while (temps.length > 0) rmSync(temps.pop() ?? '', { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

// ── synthetic fixture ──────────────────────────────────────────────────────

/** The golden end state of one edited file. */
const RULE1_GOLDEN = [
  'export function rule1(cents: number, taxRate: number): number {',
  '  const base = Math.round(cents * 101) / 100;',
  '  return Math.round(base * (1 + taxRate));',
  '}',
].join('\n');

/**
 * A synthetic session, generated here so nothing in this suite comes from a
 * real transcript. Twelve diagnose/edit/verify cycles, which is what makes arm
 * A genuinely the largest arm: on a three-event toy, arm D's fixed Zone A (the
 * §9 contract, ~1k tokens) dwarfs the transcript and the ordering inverts —
 * true, but not the regime §15 is about.
 */
function cycle(index: number): TaskEvent[] {
  const path = `src/pricing/rule${String(index)}.ts`;
  const body = [
    `export function rule${String(index)}(cents: number, taxRate: number): number {`,
    '  // Round to the nearest cent BEFORE applying tax, not after: the invoice',
    '  // total is the sum of rounded lines, and rounding last drifts by a cent',
    '  // per line on multi-line invoices.',
    `  const base = Math.round(cents * ${String(100 + index)}) / 100;`,
    '  return Math.round(base * (1 + taxRate));',
    '}',
  ].join('\n');
  return [
    { type: 'tool_call', tool: 'Read', path, args: `{"path":"${path}"}` },
    { type: 'tool_result', output: `export function rule${String(index)}(cents: number, taxRate: number) { return cents * (1 + taxRate); }` },
    { type: 'assistant_message', text: `rule${String(index)} multiplies before rounding; that is the off-by-a-cent drift.` },
    { type: 'tool_call', tool: 'Edit', path, content: body },
    { type: 'tool_result', output: `edited ${path}` },
    { type: 'tool_call', tool: 'run_tests', args: `{"suite":"pricing/rule${String(index)}"}` },
    { type: 'tool_result', output: `2 passing, 0 failing (pricing/rule${String(index)})` },
  ];
}

const EVENTS: TaskEvent[] = [
  { type: 'user_message', text: 'the pricing rounding is off by a cent on invoices' },
  ...Array.from({ length: 12 }, (_unused, index) => cycle(index + 1)).flat(),
  { type: 'assistant_message', text: 'rounding fixed across the pricing rules; suites green.' },
];

function baseTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: 'pricing-resume',
    kind: 'resumed',
    title: 'fix pricing rounding',
    trace: { events: EVENTS },
    golden: [{ path: 'src/pricing/rule1.ts', content: RULE1_GOLDEN }],
    prompt: 'Finish the task: confirm the rounding fix and say what is left to do.',
    expect: { answerContains: ['rule1'] },
    checker: { module: 'builtin:golden-text' },
    ...overrides,
  };
}

function seedStore(): TaskStore {
  const root = tempDir('ct-eval-');
  const handle = openTaskStore(resolveConfig({ root, taskTitle: 'fix pricing rounding' }));
  handles.push(handle);
  materializeTrace(EVENTS, handle);
  ingest({ handle });
  return handle;
}

/** Adds §8-shaped summaries so arm D has a Zone B to assemble. */
function summarize(handle: TaskStore): void {
  const { store } = handle;
  const root = store.root();
  if (root === null) throw new Error('fixture produced no root');
  const emptyMeta = {
    files: [],
    symbols: [],
    tests: [],
    artifacts: [],
    open_questions: [],
    decisions: [],
    node_ids: [],
  };
  store.putSummary({
    node_id: root.id,
    model: 'test',
    text: 'Fix a rounding bug in pricing and verify it.',
    meta: emptyMeta,
  });
  for (const phase of store.byKind('phase')) {
    store.putSummary({
      node_id: phase.id,
      model: 'test',
      text: `Phase ${phase.phase_type ?? 'other'} of the pricing fix; touched src/pricing/rule1.ts.`,
      meta: {
        ...emptyMeta,
        files: [{ path: 'src/pricing/rule1.ts', start_line: 1, end_line: 4, symbol: 'rule1' }],
        symbols: ['rule1'],
      },
    });
  }
}

function runtimeFor(reply = 'done'): ArmRuntime {
  return createArmRuntime(new MockProvider({ reply }), 'claude-sonnet-5', null);
}

// ── task spec ──────────────────────────────────────────────────────────────

describe('task-spec', () => {
  it('accepts a well-formed task and keeps every field the harness grades on', () => {
    const result = validateTask(baseTask());
    expect(result.errors).toEqual([]);
    expect(result.task?.kind).toBe('resumed');
    expect(result.task?.golden[0]?.path).toBe('src/pricing/rule1.ts');
    expect(result.task?.checker.module).toBe('builtin:golden-text');
  });

  it.each([
    [{ id: '' }, 'id'],
    [{ kind: 'sideways' }, 'kind'],
    [{ prompt: '' }, 'prompt'],
    [{ trace: {} }, 'trace'],
    [{ trace: { events: EVENTS, fixture: 'x.jsonl' } }, 'trace'],
    [{ golden: 'src/pricing/rule1.ts' }, 'golden'],
    [{ checker: {} }, 'checker.module'],
    [{ expect: { requiresTool: ['read_file'] } }, 'expect.requiresTool'],
    [{ expect: { maxToolCalls: -1 } }, 'expect.maxToolCalls'],
  ])('rejects a malformed task naming the field (%#)', (patch, field) => {
    const result = validateTask({ ...baseTask(), ...patch });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' | ')).toContain(field);
  });

  it('reads a JSON-authored "trap": null as no trap rather than a malformed one', () => {
    const result = validateTask({ ...baseTask(), trap: null, rubric: null });
    expect(result.errors).toEqual([]);
    expect(result.task?.trap).toBeUndefined();
  });

  it('requires a trap on an adversarial task, because §15 asks for ten of them', () => {
    const result = validateTask({ ...baseTask(), kind: 'adversarial' });
    expect(result.errors.join(' | ')).toContain('trap');
  });

  it('refuses a trap on a non-adversarial task, so the kind and the trap cannot disagree', () => {
    const result = validateTask({ ...baseTask(), kind: 'fresh', trap: 'contradiction' });
    expect(result.errors.join(' | ')).toContain('trap');
  });

  it('makes every trap assertable: a stale-summary trap with no staleMarkers is rejected', () => {
    const result = validateTask({ ...baseTask(), kind: 'adversarial', trap: 'stale-summary' });
    expect(result.errors.join(' | ')).toContain('expect.staleMarkers');

    const ok = validateTask({
      ...baseTask(),
      kind: 'adversarial',
      trap: 'stale-summary',
      expect: { staleMarkers: ['returns cents * 1.08 unrounded'] },
    });
    expect(ok.ok).toBe(true);
  });

  it('makes a fetch-not-needed trap assertable through a tool-call bound', () => {
    const bad = validateTask({ ...baseTask(), kind: 'adversarial', trap: 'fetch-not-needed' });
    expect(bad.errors.join(' | ')).toContain('expect.maxToolCalls');

    const good = validateTask({
      ...baseTask(),
      kind: 'adversarial',
      trap: 'fetch-not-needed',
      expect: { maxToolCalls: 0 },
    });
    expect(good.ok).toBe(true);
  });

  it('materializes inline events into L0 + L2 so a synthetic task exercises the real hermetic path', () => {
    const handle = seedStore();
    const events = handle.trace.all();
    expect(events).toHaveLength(EVENTS.length);

    // Payload text lives in L2; L0 keeps only the hash (§6).
    const edit = events.find((event) => event.type === 'tool_call' && event.tool === 'Edit');
    if (edit?.type !== 'tool_call' || edit.blob === undefined) throw new Error('expected an Edit with a blob');
    expect(handle.blobs.getText(edit.blob)).toContain('Math.round(base * (1 + taxRate))');

    // A tool_result with no explicit `call` links to the preceding tool_call.
    const first = events.find((event) => event.type === 'tool_result');
    expect(first?.type === 'tool_result' ? first.call_seq : null).toBe(2);
  });

  it('loads a task whose events come from a fixture file', () => {
    const dir = tempDir('ct-eval-fixture-');
    writeFileSync(join(dir, 'trace.jsonl'), EVENTS.map((event) => JSON.stringify(event)).join('\n'), 'utf8');
    const task = parseTask({ ...baseTask(), trace: { fixture: 'trace.jsonl' } });
    task.baseDir = dir;
    expect(taskEvents(task)).toHaveLength(EVENTS.length);
  });
});

// ── arms ───────────────────────────────────────────────────────────────────

describe('arms', () => {
  it('builds all four arms from one fixture, and arm A is the largest — it is the cost ceiling', () => {
    const handle = seedStore();
    summarize(handle);
    const runtime = runtimeFor();
    const sizes = new Map<ArmId, number>();
    for (const arm of ARM_IDS) {
      const prompt = buildArm(arm, {
        task: baseTask(),
        handle,
        runtime,
        windowTokens: 400,
        flatSummary: 'One flat summary of the whole session.',
        budgets: { zoneB: 600, zoneC: 900 },
      });
      sizes.set(arm, prompt.promptTokens);
      // One tokenizer across every arm, or §15's token comparison means nothing.
      expect(prompt.tokenizerId).toBe(runtime.tokenizer.id);
    }
    const a = sizes.get('A') ?? 0;
    for (const arm of ['B', 'C', 'D'] as const) {
      expect(sizes.get(arm) ?? 0).toBeLessThan(a);
    }
  });

  it("arm B's window drops the oldest events and says how many, so truncation is never silent", () => {
    const handle = seedStore();
    const prompt = buildArm('B', { task: baseTask(), handle, runtime: runtimeFor(), windowTokens: 40 });
    const context = prompt.request.messages[0]?.content ?? '';
    expect(context).toMatch(/\[window: the last \d+ of \d+ events; \d+ older events are not shown\]/);
    expect(context).not.toContain('the pricing rounding is off by a cent');
  });

  it('arm C refuses to build without its flatten instead of quietly degrading to an empty summary', () => {
    const handle = seedStore();
    expect(() => buildArm('C', { task: baseTask(), handle, runtime: runtimeFor(), windowTokens: 100 })).toThrow(
      /arm C/,
    );
  });

  it("arm D's Zone A+B prefix is byte-identical across two builds — D5's cached prefix must not move", () => {
    const handle = seedStore();
    summarize(handle);
    const runtime = runtimeFor();
    const prefixOf = (): string => {
      const prompt = buildArm('D', { task: baseTask(), handle, runtime, windowTokens: 100 });
      const zoneAB = (prompt.assembled?.blocks ?? [])
        .filter((block) => block.zone === 'A' || block.zone === 'B')
        .map((block) => `${block.id} ${block.text}`)
        .join('');
      return `${prompt.request.system ?? ''}${zoneAB}`;
    };
    expect(prefixOf()).toBe(prefixOf());
  });

  it('arm D reports the absent embedder as a condition rather than pretending L3 exists', () => {
    const handle = seedStore();
    summarize(handle);
    const prompt = buildArm('D', { task: baseTask(), handle, runtime: runtimeFor(), windowTokens: 100 });
    expect(prompt.conditions.join(' ')).toContain('lexical beam fallback');
  });

  it('advertises exactly the four §9 tools, with the arguments the real zod schemas validate', () => {
    expect(TOOL_SCHEMAS.map((schema) => schema.name)).toEqual([...TOOL_NAMES]);

    type ProbeField = { safeParse: (value: unknown) => { success: boolean } };
    const shapes: Record<string, Record<string, ProbeField>> = {
      [CONTEXT_FETCH]: contextFetchInputShape,
      [CONTEXT_SEARCH]: contextSearchInputShape,
      [CONTEXT_PEEK]: contextPeekInputShape,
      [ANNOTATE]: annotateInputShape,
    };

    for (const schema of TOOL_SCHEMAS) {
      const shape = shapes[schema.name] ?? {};
      const properties = (schema.input_schema.properties ?? {}) as Record<string, unknown>;
      expect(Object.keys(properties).sort()).toEqual(Object.keys(shape).sort());

      // Required must match the zod fields that reject `undefined`, or the model
      // is told a different contract than the handler enforces.
      const required = [...((schema.input_schema.required ?? []) as string[])].sort();
      const zodRequired = Object.entries(shape)
        .filter(([, field]) => !field.safeParse(undefined).success)
        .map(([name]) => name)
        .sort();
      expect(required).toEqual(zodRequired);
    }
  });
});

// ── tool-use loop ──────────────────────────────────────────────────────────

const USAGE: TokenUsage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 40 };

function completion(overrides: Partial<CompletionResult> = {}): CompletionResult {
  return {
    text: 'ok',
    model: 'claude-sonnet-5',
    usage: USAGE,
    toolCalls: [],
    stopReason: 'end_turn',
    ...overrides,
  };
}

/** Core's offline replay mechanism, driven from a cassette written to a temp dir. */
function recordedProvider(entries: readonly { request: CompletionRequest; result: CompletionResult }[]): RecordedProvider {
  const path = join(tempDir('ct-eval-cassette-'), 'completions.json');
  const cassette: Cassette = {};
  for (const entry of entries) cassette[requestKey(entry.request)] = entry.result;
  writeCassette(path, cassette);
  return new RecordedProvider(path);
}

describe('tool-use loop', () => {
  const baseRequest: CompletionRequest = {
    model: 'claude-sonnet-5',
    system: 'sys',
    messages: [{ role: 'user', content: 'resume the task' }],
  };

  it('stops as soon as the model stops, and reports the measured usage it summed', async () => {
    const provider = recordedProvider([{ request: baseRequest, result: completion({ text: 'final answer' }) }]);
    const loop = await runToolLoop({ provider, request: baseRequest, maxSteps: 5 });

    expect(loop.steps).toBe(1);
    expect(loop.stoppedBy).toBe('stop');
    expect(loop.finalText).toBe('final answer');
    expect(loop.usage).toEqual(USAGE);
  });

  it('ends on the step cap when the model keeps calling tools, and records every call with its args', async () => {
    const looping = {
      id: 'looping',
      async complete(): Promise<CompletionResult> {
        return completion({ text: 'peeking', toolCalls: [{ id: 'c1', name: CONTEXT_PEEK, input: { node_id: 'n_x' } }] });
      },
    };
    const loop = await runToolLoop({
      provider: looping,
      request: baseRequest,
      tools: {
        schemas: TOOL_SCHEMAS,
        invoke: async () => ({ ok: true, data: { node_id: 'n_x', text: 'excerpt' } }),
      },
      maxSteps: 3,
    });

    expect(loop.steps).toBe(3);
    expect(loop.stoppedBy).toBe('step-cap');
    expect(loop.toolCalls).toHaveLength(3);
    expect(loop.toolCalls[0]?.name).toBe(CONTEXT_PEEK);
    expect(loop.toolCalls[0]?.args).toEqual({ node_id: 'n_x' });
    expect(loop.toolCalls.every((record) => record.latencyMs >= 0)).toBe(true);
  });

  it('stops rather than inventing a tool result when an arm advertises no tools', async () => {
    const wantsTools = {
      id: 'wants-tools',
      async complete(): Promise<CompletionResult> {
        return completion({ toolCalls: [{ id: 'c1', name: CONTEXT_FETCH, input: { branch_id: 'n_1' } }] });
      },
    };
    const loop = await runToolLoop({ provider: wantsTools, request: baseRequest, maxSteps: 4 });
    expect(loop.stoppedBy).toBe('no-tools');
    expect(loop.toolCalls).toHaveLength(0);
  });

  it("arm D's loop reaches branch content through the REAL context_fetch handler", async () => {
    const handle = seedStore();
    summarize(handle);
    const phase = handle.store.byKind('phase')[0];
    if (phase === undefined) throw new Error('fixture produced no phase');

    const ctx: ToolContext = {
      config: handle.config,
      handle,
      retriever: new TreeRetriever({ store: handle.store, blobs: handle.blobs, trace: handle.trace }),
    };

    let turn = 0;
    const twoTurn = {
      id: 'two-turn',
      async complete(): Promise<CompletionResult> {
        turn += 1;
        return turn === 1
          ? completion({
              text: 'let me look',
              toolCalls: [{ id: 'c1', name: CONTEXT_FETCH, input: { branch_id: phase.id } }],
            })
          : completion({ text: 'the fix rounds before tax in price()' });
      },
    };

    const loop = await runToolLoop({ provider: twoTurn, request: baseRequest, tools: mcpToolBinding(ctx), maxSteps: 4 });

    expect(loop.stoppedBy).toBe('stop');
    expect(loop.toolCalls).toHaveLength(1);
    expect(loop.toolCalls[0]?.ok).toBe(true);
    expect(loop.toolCalls[0]?.digest.summary_version).toBe(1);

    // The handler's real payload reached the model's next turn.
    const toolTurn = loop.messages.find((message) => message.content.includes('[tool_result context_fetch'));
    expect(toolTurn?.content).toContain('touched src/pricing/rule1.ts');
  });
});

// ── metrics ────────────────────────────────────────────────────────────────

function toolCall(name: string, args: Record<string, unknown>): ToolCallRecord {
  return {
    step: 1,
    id: `${name}-${JSON.stringify(args)}`,
    name,
    args,
    ok: true,
    latencyMs: 1,
    resultChars: 10,
    digest: {},
  };
}

function runResult(overrides: Partial<ArmRunResult> = {}): ArmRunResult {
  return {
    taskId: 't1',
    taskKind: 'resumed',
    arm: 'D',
    seed: 0,
    status: 'ok',
    model: 'claude-sonnet-5',
    success: true,
    toolCalls: [],
    latencyMs: 100,
    usage: { input: 1_000, output: 50, cacheRead: 200, cacheWrite: 300 },
    conditions: [],
    ...overrides,
  };
}

describe('metrics', () => {
  it('reports null, never 0, for every metric of an arm that produced no runs', () => {
    const metrics = aggregateArm([], 'A');
    expect(metrics.runs).toBe(0);
    expect(metrics.successRate).toBeNull();
    expect(metrics.toolCallsPerTask).toBeNull();
    expect(metrics.latencyP50).toBeNull();
    expect(metrics.latencyP95).toBeNull();
    expect(metrics.usdPerTask).toBeNull();
    expect(metrics.inputTokensPerRun).toBeNull();
    expect(metrics.peekPrecision).toBeNull();
  });

  it('takes nearest-rank percentiles, so p50/p95 are latencies that actually happened', () => {
    const values = [10, 20, 30, 40, 100];
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile([], 50)).toBeNull();
  });

  it('counts a peek as precise only when a later fetch of that same node followed it', () => {
    const converted = runResult({
      toolCalls: [toolCall(CONTEXT_PEEK, { node_id: 'n_1' }), toolCall(CONTEXT_FETCH, { branch_id: 'n_1' })],
    });
    const wasted = runResult({
      toolCalls: [toolCall(CONTEXT_PEEK, { node_id: 'n_2' }), toolCall(CONTEXT_FETCH, { branch_id: 'n_9' })],
    });
    expect(peekPrecision([converted, wasted])).toEqual({ peeks: 2, converted: 1, precision: 0.5 });
    expect(peekPrecision([runResult()]).precision).toBeNull();
  });

  it('splits input tokens into cache read vs write and stamps them as MEASURED', () => {
    const metrics = aggregateArm([runResult(), runResult({ seed: 1 })], 'D');
    expect(metrics.cacheSplit).toEqual({
      input: 2_000,
      cacheRead: 400,
      cacheWrite: 600,
      total: 3_000,
      source: 'measured',
    });
    expect(metrics.inputTokensPerRun).toEqual({ value: 1_500, source: 'measured' });
  });

  it('keeps the simulated cache split beside the measured one and never merges them', () => {
    const metrics = aggregateArm(
      [
        runResult({
          simulatedCache: {
            cacheRead: 0,
            cacheWrite: 900,
            fresh: 100,
            total: 1_000,
            tokenizerId: 'heuristic-v1',
            profileId: 'exact-prefix',
          },
        }),
      ],
      'D',
    );
    expect(metrics.cacheSplit?.source).toBe('measured');
    expect(metrics.simulatedCacheSplit?.source).toBe('simulated');
    expect(metrics.simulatedInputTokensPerRun).toEqual({ value: 1_000, source: 'simulated' });
  });

  it('distinguishes "no stale incidents" from "nobody checked"', () => {
    expect(aggregateArm([runResult()], 'D').staleSummaryReports).toBe(0);
    const reported = aggregateArm(
      [runResult({ staleSummaryIncident: true }), runResult({ seed: 1, staleSummaryIncident: false })],
      'D',
    );
    expect(reported.staleSummaryReports).toBe(2);
    expect(reported.staleSummaryIncidents).toBe(1);
  });

  it('leaves an errored run out of the success rate instead of blaming the arm for it', () => {
    const metrics = aggregateArm([runResult(), runResult({ seed: 1, status: 'error', reason: 'boom' })], 'D');
    expect(metrics.runs).toBe(1);
    expect(metrics.errors).toBe(1);
    expect(metrics.successRate).toBe(1);
  });
});

// ── judge ──────────────────────────────────────────────────────────────────

const RUBRIC_TEXT = [
  '# Resumption rubric',
  '',
  '### correctness (weight: 2)',
  'Does the answer match the golden end state?',
  '',
  '### grounding',
  'Does it name the real files and symbols?',
].join('\n');

describe('judge', () => {
  const rubric: Rubric = parseRubric(RUBRIC_TEXT, 'test-rubric.md');

  it('parses criteria and weights out of the rubric file', () => {
    expect(rubric.criteria.map((criterion) => criterion.id)).toEqual(['correctness', 'grounding']);
    expect(rubric.criteria[0]?.weight).toBe(2);
  });

  it('parses a well-formed verdict and weights the overall score by the rubric', () => {
    const verdict = parseJudgeVerdict(
      '```json\n{"scores": {"correctness": 5, "grounding": 2}, "rationale": "named price() and the rounding change"}\n```',
      rubric,
    );
    expect(verdict.overall).toBeCloseTo(12 / 15, 10);
    expect(verdict.passed).toBe(true);
  });

  it.each([
    ['{"scores": {"correctness": 5}, "rationale": "x"}', 'scores.grounding'],
    ['{"scores": {"correctness": 5, "grounding": 1, "vibes": 5}, "rationale": "x"}', 'scores.vibes'],
    ['{"scores": {"correctness": 9, "grounding": 1}, "rationale": "x"}', 'scores.correctness'],
    ['{"scores": {"correctness": 5, "grounding": 1}}', 'rationale'],
    ['not json at all', 'no JSON object'],
  ])('rejects a malformed verdict naming the field (%#)', (raw, field) => {
    expect(() => parseJudgeVerdict(raw, rubric)).toThrow(field);
  });

  it('runs offline against MockProvider, which is how the harness stays testable', async () => {
    const verdict = await judgeRun({
      provider: new MockProvider({ reply: '{"scores": {"correctness": 4, "grounding": 4}, "rationale": "solid"}' }),
      model: 'claude-opus-5',
      rubric,
      task: baseTask(),
      answer: 'price() rounds before tax now.',
    });
    expect(verdict.scores).toEqual({ correctness: 4, grounding: 4 });
    expect(verdict.model).toBe('claude-opus-5');
  });
});

// ── criteria ───────────────────────────────────────────────────────────────

interface ArmShape {
  successes: number;
  runs: number;
  inputTokens: number;
  toolCalls?: number;
}

function armResults(arm: ArmId, shape: ArmShape): ArmRunResult[] {
  const out: ArmRunResult[] = [];
  for (let i = 0; i < shape.runs; i += 1) {
    out.push(
      runResult({
        arm,
        seed: i,
        taskId: `t${String(i)}`,
        success: i < shape.successes,
        usage: { input: shape.inputTokens, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolCalls: Array.from({ length: shape.toolCalls ?? 0 }, () => toolCall(CONTEXT_FETCH, { branch_id: 'n_1' })),
      }),
    );
  }
  return out;
}

describe('criteria', () => {
  it('reports UNKNOWN, never pass, when an arm is missing from the result set', () => {
    const report = evaluateCriteria(
      aggregate(armResults('D', { successes: 5, runs: 5, inputTokens: 100 }), ['A', 'C', 'D']),
    );
    const statuses = Object.fromEntries(report.criteria.map((criterion) => [criterion.id, criterion.status]));
    expect(statuses['success-rate-gap']).toBe('unknown');
    expect(statuses['input-tokens-vs-a']).toBe('unknown');
    expect(report.verdict).toBe('unproven');
  });

  it('passes each §15 threshold just inside it', () => {
    // A: 100% success, 1000 tok. C: 700 tok. D: 95% (gap -5), 490 tok
    // (51% under A, 30% under C), 2.0 tool calls/run.
    const report = evaluateCriteria(
      aggregate(
        [
          ...armResults('A', { successes: 10, runs: 10, inputTokens: 1_000 }),
          ...armResults('C', { successes: 6, runs: 10, inputTokens: 700 }),
          ...armResults('D', { successes: 19, runs: 20, inputTokens: 490, toolCalls: 2 }),
        ],
        ['A', 'C', 'D'],
      ),
    );
    expect(report.criteria.map((criterion) => `${criterion.id}=${criterion.status}`)).toEqual([
      'success-rate-gap=pass',
      'input-tokens-vs-a=pass',
      'input-tokens-vs-c=pass',
      'tool-call-overhead=pass',
    ]);
    expect(report.verdict).toBe('met');
  });

  it('fails each §15 threshold just outside it', () => {
    // D: 90% (gap -10), 501 tok (49.9% under A, 28.4% under C), 3 tool calls/run.
    const report = evaluateCriteria(
      aggregate(
        [
          ...armResults('A', { successes: 10, runs: 10, inputTokens: 1_000 }),
          ...armResults('C', { successes: 6, runs: 10, inputTokens: 700 }),
          ...armResults('D', { successes: 18, runs: 20, inputTokens: 501, toolCalls: 3 }),
        ],
        ['A', 'C', 'D'],
      ),
    );
    expect(report.criteria.map((criterion) => `${criterion.id}=${criterion.status}`)).toEqual([
      'success-rate-gap=fail',
      'input-tokens-vs-a=fail',
      'input-tokens-vs-c=fail',
      'tool-call-overhead=fail',
    ]);
    expect(report.verdict).toBe('not-met');
  });

  it('refuses to compare a measured arm against a simulated one', () => {
    const simulatedD = armResults('D', { successes: 10, runs: 10, inputTokens: 0 }).map((result) => {
      const { usage, ...rest } = result;
      void usage;
      return {
        ...rest,
        simulatedCache: {
          cacheRead: 0,
          cacheWrite: 400,
          fresh: 100,
          total: 500,
          tokenizerId: 'heuristic-v1',
          profileId: 'exact-prefix',
        },
      } satisfies ArmRunResult;
    });
    const report = evaluateCriteria(
      aggregate([...armResults('A', { successes: 10, runs: 10, inputTokens: 1_000 }), ...simulatedD], ['A', 'D']),
    );
    const tokens = report.criteria.find((criterion) => criterion.id === 'input-tokens-vs-a');
    expect(tokens?.status).toBe('unknown');
    expect(tokens?.detail).toContain('never blended');
  });
});

// ── runner ─────────────────────────────────────────────────────────────────

/**
 * An offline stand-in for the whole model layer. §8's contract requires a
 * summary to name every child branch id, which no fixed reply can know — so
 * this echoes back the ids it was shown. The same JSON serves as the resuming
 * agent's answer, and it mentions `rule1`, which is what the task's checker
 * asserts.
 */
function contractRespondingProvider(): MockProvider {
  return new MockProvider({
    responder: (request) => {
      const content = request.messages.map((message) => message.content).join('\n');
      const nodeIds = [...new Set(content.match(/n_[0-9A-Za-z]+/g) ?? [])];
      return JSON.stringify({
        text: 'resumed: rule1 now rounds the base before applying tax; the pricing suites are green.',
        meta: {
          files: [],
          symbols: [],
          tests: [{ name: 'pricing', status: 'passed' }],
          artifacts: [],
          open_questions: [],
          decisions: ['round before tax'],
          node_ids: nodeIds,
        },
      });
    },
    usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
  });
}

function writeTaskFile(task: EvalTask): string {
  const dir = tempDir('ct-eval-tasks-');
  writeFileSync(join(dir, 'task.json'), JSON.stringify(task, null, 2), 'utf8');
  return dir;
}

function runArgsFor(tasksDir: string, overrides: Partial<RunArgs> = {}): RunArgs {
  return {
    ...DEFAULT_RUN_ARGS,
    arms: [...DEFAULT_RUN_ARGS.arms],
    tasksPath: tasksDir,
    seeds: 1,
    maxSteps: 2,
    windowTokens: 400,
    capUsd: null,
    cwd: tasksDir,
    ...overrides,
  };
}

describe('runner', () => {
  it('parses the flags §15 needs and rejects an unknown one by name', () => {
    const args = parseRunArgs(['--tasks', 'eval/tasks', '--arms', 'A,D', '--seeds', '7', '--cap', 'none'], '/tmp');
    expect(args.arms).toEqual(['A', 'D']);
    expect(args.seeds).toBe(7);
    expect(args.capUsd).toBeNull();
    expect(() => parseRunArgs(['--nope'], '/tmp')).toThrow(/--nope/);
    expect(DEFAULT_RUN_ARGS.seeds).toBeGreaterThanOrEqual(5);
  });

  it('refuses to start when the PROJECTED spend exceeds the cap, before any model call', async () => {
    const provider = contractRespondingProvider();
    const dir = writeTaskFile(baseTask());
    await expect(
      runEvaluation(runArgsFor(dir, { capUsd: 0.000_001 }), { provider, write: false, log: () => {} }),
    ).rejects.toThrow(EvalBudgetError);
    // Nothing was sent — that is the whole point of projecting first.
    expect(provider.requests).toHaveLength(0);
  });

  it('runs every arm offline end to end and reports each one it measured', async () => {
    const dir = writeTaskFile(baseTask());
    const report = await runEvaluation(runArgsFor(dir), {
      provider: contractRespondingProvider(),
      write: false,
      log: () => {},
    });

    expect(report.results).toHaveLength(4);
    expect(report.results.map((result) => result.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(report.metrics.map((metrics) => metrics.arm)).toEqual(['A', 'B', 'C', 'D']);
    for (const metrics of report.metrics) {
      expect(metrics.runs).toBe(1);
      expect(metrics.successRate).toBe(1);
      expect(metrics.inputTokensPerRun?.source).toBe('measured');
    }
    // Arm D alone carries a simulated split, and it never replaces the measured one.
    const armD = report.metrics.find((metrics) => metrics.arm === 'D');
    expect(armD?.simulatedCacheSplit?.source).toBe('simulated');
    expect(report.conditions.join(' ')).toContain('lexical beam fallback');
    expect(report.outDir).toBeNull();
    expect(report.cost.totalUsd).toBeGreaterThan(0);
    expect(report.setupCosts[0]?.treeBuildUsd).not.toBeNull();
    expect(report.setupCosts[0]?.flattenUsd).not.toBeNull();
  });

  it('a run that measures nothing skips every arm and leaves the criteria UNKNOWN', async () => {
    const dir = writeTaskFile(baseTask());
    const lines: string[] = [];
    const report = await runEvaluation(runArgsFor(dir, { dryRun: true }), {
      provider: contractRespondingProvider(),
      write: false,
      log: (line) => lines.push(line),
    });

    expect(report.results).toHaveLength(0);
    expect(report.skippedArms.map((skipped) => skipped.arm)).toEqual(['A', 'B', 'C', 'D']);
    expect(report.criteria.criteria.every((criterion) => criterion.status === 'unknown')).toBe(true);
    expect(report.criteria.verdict).toBe('unproven');
    expect(lines.join(' ')).toContain('nothing was measured');
    // The table says "not run", never 0.
    const markdown = renderSummaryMarkdown(report);
    expect(markdown).toContain('not run');
    expect(markdown).toContain('Arms that did not run');
  });
});
