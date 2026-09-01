/**
 * §15 task format — the contract a task set is written against.
 *
 * §15 asks for "20–30 scripted tasks (10 fresh / 10 resumed-mid-task / 10
 * adversarial: stale summary, contradiction across branches, fetch-not-needed
 * trap), each with: full trace log, golden file states, and a checker script".
 * This file is that sentence as types plus a validator that names the field it
 * rejected, because the task set is authored separately from the harness and a
 * silent coercion there becomes a fabricated number in the results table.
 *
 * Two rules the format enforces rather than documents:
 *  - an `adversarial` task MUST declare its `trap`, and the trap MUST come with
 *    an assertion that can actually fail because of it. §15 asks for ten
 *    adversarial tasks; a trap nothing asserts is a task that always passes.
 *  - traces are CONTENT-BEARING, never blob hashes. A task file carries the
 *    text; `materializeTrace` puts it into L2 and appends L0 (§6). That keeps
 *    every fixture synthetic and hand-auditable — no private transcript can be
 *    smuggled in as a hash that only resolves on one machine.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { PHASE_TYPES, type PhaseType, type Seq, type TaskStore } from '@context-tree/core';
import { TOOL_NAMES } from '@context-tree/mcp';

export const TASK_KINDS = ['fresh', 'resumed', 'adversarial'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** §15's three adversarial shapes. */
export const TRAP_KINDS = ['stale-summary', 'contradiction', 'fetch-not-needed'] as const;
export type TrapKind = (typeof TRAP_KINDS)[number];

/**
 * One recorded event, as a task author writes it. This is deliberately NOT
 * `TraceEventInput`: L0 references payloads by hash, and a task file cannot
 * carry a hash whose blob exists. `materializeTrace` performs the translation.
 */
export type TaskEvent =
  | { type: 'user_message'; text: string; ts?: string }
  | { type: 'assistant_message'; text: string; ts?: string }
  | { type: 'tool_call'; tool: string; path?: string; content?: string; args?: string; ts?: string }
  | {
      type: 'tool_result';
      /** 1-based index of the `tool_call` in this list. Defaults to the previous one. */
      call?: number;
      output?: string;
      error?: string;
      truncated?: boolean;
      ts?: string;
    }
  | { type: 'segment_boundary'; to: PhaseType; from?: PhaseType | null; ts?: string };

export interface TaskTrace {
  /** Inline events. Exactly one of `events` / `fixture`. */
  events?: TaskEvent[];
  /** Path to a `.json` (array or `{events:[…]}`) or `.jsonl` file of `TaskEvent`s. */
  fixture?: string;
}

/** The correct end state of a file after the task — ground truth for checker and judge. */
export interface GoldenFile {
  path: string;
  content: string;
}

/**
 * What the resuming agent's run must look like. The adversarial traps are
 * assertable through exactly these fields — see `validateTask`.
 */
export interface TaskExpectations {
  answerContains?: string[];
  answerOmits?: string[];
  /** Tool names the run must use (e.g. `context_peek` for a stale-summary trap). */
  requiresTool?: string[];
  /** Tool names the run must NOT use (the `fetch-not-needed` trap). */
  forbidsTool?: string[];
  maxToolCalls?: number;
  /**
   * Strings that appear ONLY in the stale summary. One of them in the final
   * answer is a stale-summary incident (§15's organization-quality metric), and
   * that is what makes the trap measurable rather than implied.
   */
  staleMarkers?: string[];
}

/**
 * `builtin:<name>` selects a checker from `BUILTIN_CHECKERS`; anything else is
 * a module path resolved against the task file's directory and imported.
 */
export interface CheckerRef {
  module: string;
  export?: string;
}

export interface EvalTask {
  id: string;
  kind: TaskKind;
  /** Required exactly when `kind === 'adversarial'`. */
  trap?: TrapKind;
  title: string;
  trace: TaskTrace;
  golden: GoldenFile[];
  /** The prompt handed to the fresh resuming agent — identical across all four arms. */
  prompt: string;
  expect: TaskExpectations;
  checker: CheckerRef;
  /** Rubric path for the LLM judge; falls back to the run's default. */
  rubric?: string;
  notes?: string;
  /** Directory this task was loaded from; `fixture`/`checker`/`rubric` resolve against it. */
  baseDir?: string;
}

export class TaskSpecError extends Error {
  constructor(
    message: string,
    readonly errors: readonly string[],
  ) {
    super(message);
    this.name = 'TaskSpecError';
  }
}

export interface TaskValidation {
  ok: boolean;
  task: EvalTask | null;
  errors: string[];
}

// ── validation ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(
  value: unknown,
  field: string,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${field}: expected an array of strings`);
    return undefined;
  }
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      errors.push(`${field}[${String(i)}]: expected a non-empty string`);
      return;
    }
    out.push(item);
  });
  return out;
}

function requireString(value: unknown, field: string, errors: string[]): string {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${field}: expected a non-empty string`);
    return '';
  }
  return value;
}

const EVENT_TYPES: readonly string[] = [
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'segment_boundary',
];

function validateEvent(value: unknown, field: string, errors: string[]): TaskEvent | null {
  if (!isRecord(value)) {
    errors.push(`${field}: expected an object`);
    return null;
  }
  const type = value.type;
  if (typeof type !== 'string' || !EVENT_TYPES.includes(type)) {
    errors.push(`${field}.type: expected one of ${EVENT_TYPES.join('|')}`);
    return null;
  }
  const before = errors.length;
  let event: TaskEvent | null = null;
  switch (type) {
    case 'user_message':
    case 'assistant_message':
      event = { type, text: requireString(value.text, `${field}.text`, errors) };
      break;
    case 'tool_call': {
      const call: TaskEvent = { type: 'tool_call', tool: requireString(value.tool, `${field}.tool`, errors) };
      if (typeof value.path === 'string') call.path = value.path;
      if (typeof value.content === 'string') call.content = value.content;
      if (typeof value.args === 'string') call.args = value.args;
      event = call;
      break;
    }
    case 'tool_result': {
      const result: TaskEvent = { type: 'tool_result' };
      if (value.call !== undefined) {
        if (typeof value.call !== 'number' || !Number.isInteger(value.call) || value.call < 1) {
          errors.push(`${field}.call: expected a 1-based integer index of a tool_call in this list`);
        } else {
          result.call = value.call;
        }
      }
      if (typeof value.output === 'string') result.output = value.output;
      if (typeof value.error === 'string') result.error = value.error;
      if (value.truncated === true) result.truncated = true;
      event = result;
      break;
    }
    case 'segment_boundary': {
      const to = value.to;
      if (typeof to !== 'string' || !(PHASE_TYPES as readonly string[]).includes(to)) {
        errors.push(`${field}.to: expected one of ${PHASE_TYPES.join('|')}`);
        break;
      }
      const boundary: TaskEvent = { type: 'segment_boundary', to: to as PhaseType };
      if (typeof value.from === 'string') boundary.from = value.from as PhaseType;
      event = boundary;
      break;
    }
    default:
      break;
  }
  if (event !== null && typeof value.ts === 'string') event.ts = value.ts;
  return errors.length === before ? event : null;
}

/**
 * The trap-assertability rule (§15). Each trap names the field that can carry
 * the failure; without it the adversarial task is decoration.
 */
function validateTrap(task: Partial<EvalTask>, expect: TaskExpectations, errors: string[]): void {
  if (task.kind === 'adversarial' && task.trap === undefined) {
    errors.push('trap: required when kind is "adversarial"');
    return;
  }
  if (task.kind !== 'adversarial' && task.trap !== undefined) {
    errors.push(`trap: only an "adversarial" task declares a trap, got kind "${String(task.kind)}"`);
    return;
  }
  if (task.trap === undefined) return;

  const has = (values: readonly string[] | undefined): boolean => values !== undefined && values.length > 0;
  switch (task.trap) {
    case 'stale-summary':
      if (!has(expect.staleMarkers)) {
        errors.push(
          'expect.staleMarkers: a "stale-summary" trap must list strings that appear only in the stale summary, or the incident is not assertable',
        );
      }
      break;
    case 'fetch-not-needed':
      if (expect.maxToolCalls === undefined && !has(expect.forbidsTool)) {
        errors.push(
          'expect.maxToolCalls: a "fetch-not-needed" trap must bound the tool calls (or set expect.forbidsTool), or the trap is not assertable',
        );
      }
      break;
    case 'contradiction':
      if (!has(expect.answerContains) && !has(expect.answerOmits)) {
        errors.push(
          'expect.answerContains: a "contradiction" trap must assert which side of the contradiction the answer takes',
        );
      }
      break;
    default:
      break;
  }
}

function validateExpectations(value: unknown, errors: string[]): TaskExpectations {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push('expect: expected an object');
    return {};
  }
  const expect: TaskExpectations = {};
  const contains = stringArray(value.answerContains, 'expect.answerContains', errors);
  if (contains !== undefined) expect.answerContains = contains;
  const omits = stringArray(value.answerOmits, 'expect.answerOmits', errors);
  if (omits !== undefined) expect.answerOmits = omits;
  const markers = stringArray(value.staleMarkers, 'expect.staleMarkers', errors);
  if (markers !== undefined) expect.staleMarkers = markers;

  for (const [key, field] of [
    ['requiresTool', 'expect.requiresTool'],
    ['forbidsTool', 'expect.forbidsTool'],
  ] as const) {
    const names = stringArray(value[key], field, errors);
    if (names === undefined) continue;
    for (const name of names) {
      if (!(TOOL_NAMES as readonly string[]).includes(name)) {
        errors.push(`${field}: "${name}" is not one of the four §9 tools (${TOOL_NAMES.join(', ')})`);
      }
    }
    expect[key] = names;
  }

  if (value.maxToolCalls !== undefined) {
    if (typeof value.maxToolCalls !== 'number' || !Number.isInteger(value.maxToolCalls) || value.maxToolCalls < 0) {
      errors.push('expect.maxToolCalls: expected a non-negative integer');
    } else {
      expect.maxToolCalls = value.maxToolCalls;
    }
  }
  return expect;
}

/** Validates one task, collecting every problem with the field that caused it. */
export function validateTask(value: unknown, where = 'task'): TaskValidation {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, task: null, errors: [`${where}: expected an object`] };
  }

  const id = requireString(value.id, 'id', errors);
  const kind = value.kind;
  if (typeof kind !== 'string' || !(TASK_KINDS as readonly string[]).includes(kind)) {
    errors.push(`kind: expected one of ${TASK_KINDS.join('|')}`);
  }
  // JSON authors write `"trap": null` for "no trap"; that is absence, not a
  // malformed value, and rejecting it would be pedantry with a field name on it.
  const trap = value.trap ?? undefined;
  if (trap !== undefined && (typeof trap !== 'string' || !(TRAP_KINDS as readonly string[]).includes(trap))) {
    errors.push(`trap: expected one of ${TRAP_KINDS.join('|')}`);
  }
  const prompt = requireString(value.prompt, 'prompt', errors);

  // trace: exactly one of events / fixture.
  const events: TaskEvent[] = [];
  let fixture: string | undefined;
  if (!isRecord(value.trace)) {
    errors.push('trace: expected an object with either `events` or `fixture`');
  } else {
    const rawEvents = value.trace.events;
    const rawFixture = value.trace.fixture;
    if (rawEvents === undefined && rawFixture === undefined) {
      errors.push('trace: expected either `trace.events` (inline) or `trace.fixture` (a path)');
    } else if (rawEvents !== undefined && rawFixture !== undefined) {
      errors.push('trace: expected exactly one of `trace.events` and `trace.fixture`, got both');
    } else if (rawFixture !== undefined) {
      fixture = requireString(rawFixture, 'trace.fixture', errors);
    } else if (!Array.isArray(rawEvents)) {
      errors.push('trace.events: expected an array of events');
    } else if (rawEvents.length === 0) {
      errors.push('trace.events: expected at least one event — an empty trace grades nothing');
    } else {
      rawEvents.forEach((raw, i) => {
        const event = validateEvent(raw, `trace.events[${String(i)}]`, errors);
        if (event !== null) events.push(event);
      });
    }
  }

  const golden: GoldenFile[] = [];
  if (!Array.isArray(value.golden)) {
    errors.push('golden: expected an array of { path, content } file states');
  } else {
    value.golden.forEach((raw, i) => {
      const field = `golden[${String(i)}]`;
      if (!isRecord(raw)) {
        errors.push(`${field}: expected an object`);
        return;
      }
      const path = requireString(raw.path, `${field}.path`, errors);
      if (typeof raw.content !== 'string') {
        errors.push(`${field}.content: expected a string (the file's correct end state)`);
        return;
      }
      golden.push({ path, content: raw.content });
    });
  }

  const expect = validateExpectations(value.expect, errors);

  let checker: CheckerRef = { module: '' };
  if (!isRecord(value.checker)) {
    errors.push('checker: expected an object like { "module": "builtin:golden-text" }');
  } else {
    const module_ = requireString(value.checker.module, 'checker.module', errors);
    checker = { module: module_ };
    if (value.checker.export !== undefined) {
      checker.export = requireString(value.checker.export, 'checker.export', errors);
    }
  }

  const partial: Partial<EvalTask> = {
    id,
    kind: kind as TaskKind,
    trap: trap as TrapKind | undefined,
  };
  validateTrap(partial, expect, errors);

  if (errors.length > 0) return { ok: false, task: null, errors };

  const task: EvalTask = {
    id,
    kind: kind as TaskKind,
    title: typeof value.title === 'string' && value.title.length > 0 ? value.title : id,
    trace: fixture === undefined ? { events } : { fixture },
    golden,
    prompt,
    expect,
    checker,
  };
  if (trap !== undefined) task.trap = trap as TrapKind;
  if (typeof value.rubric === 'string') task.rubric = value.rubric;
  if (typeof value.notes === 'string') task.notes = value.notes;
  return { ok: true, task, errors };
}

export function parseTask(value: unknown, where = 'task'): EvalTask {
  const result = validateTask(value, where);
  if (!result.ok || result.task === null) {
    throw new TaskSpecError(`${where}: ${result.errors.join('; ')}`, result.errors);
  }
  return result.task;
}

// ── loading ────────────────────────────────────────────────────────────────

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new TaskSpecError(`${path}: cannot read — ${(error as Error).message}`, []);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new TaskSpecError(`${path}: invalid JSON — ${(error as Error).message}`, []);
  }
}

/** One `.json` file: a single task, an array of tasks, or `{ "tasks": [...] }`. */
export function loadTaskFile(path: string): EvalTask[] {
  const parsed = readJson(path);
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.tasks)
      ? parsed.tasks
      : [parsed];
  const baseDir = resolve(path, '..');
  return list.map((raw, i) => ({ ...parseTask(raw, `${path}[${String(i)}]`), baseDir }));
}

/**
 * A file or a directory of `.json` task files. Sorted by id so a run's task
 * order is a function of the task set alone (§15's n>=5 seeds compare like with
 * like across arms).
 */
export function loadTasks(pathOrDir: string): EvalTask[] {
  const stats = statSync(pathOrDir);
  const files = stats.isDirectory()
    ? readdirSync(pathOrDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => join(pathOrDir, name))
    : [pathOrDir];
  const tasks = files.flatMap(loadTaskFile);
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new TaskSpecError(`duplicate task id ${JSON.stringify(task.id)}`, []);
    seen.add(task.id);
  }
  return tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function resolveAgainst(baseDir: string | undefined, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir ?? process.cwd(), path);
}

/** Reads a `.jsonl` or `.json` fixture of `TaskEvent`s and validates every one. */
export function loadFixtureEvents(path: string): TaskEvent[] {
  const raw = path.endsWith('.jsonl')
    ? readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('//'))
        .map((line, i) => {
          try {
            return JSON.parse(line) as unknown;
          } catch (error) {
            throw new TaskSpecError(`${path}:${String(i + 1)}: invalid JSON — ${(error as Error).message}`, []);
          }
        })
    : ((): unknown[] => {
        const parsed = readJson(path);
        if (Array.isArray(parsed)) return parsed;
        if (isRecord(parsed) && Array.isArray(parsed.events)) return parsed.events;
        throw new TaskSpecError(`${path}: expected an array of events or { "events": [...] }`, []);
      })();

  const errors: string[] = [];
  const events: TaskEvent[] = [];
  raw.forEach((value, i) => {
    const event = validateEvent(value, `${path}[${String(i)}]`, errors);
    if (event !== null) events.push(event);
  });
  if (errors.length > 0) throw new TaskSpecError(`${path}: ${errors.join('; ')}`, errors);
  return events;
}

/** The task's events, inline or from its fixture file. */
export function taskEvents(task: EvalTask): TaskEvent[] {
  if (task.trace.events !== undefined) return task.trace.events;
  if (task.trace.fixture === undefined) throw new TaskSpecError(`${task.id}: trace has neither events nor fixture`, []);
  return loadFixtureEvents(resolveAgainst(task.baseDir, task.trace.fixture));
}

const DEFAULT_TS = '2026-01-01T00:00:00.000Z';

/**
 * Task events -> L0 + L2 (§6). Text goes to the blob store and the L0 record
 * keeps only the hash, which is the same shape ingestion produces for a real
 * session — so a synthetic fixture exercises the real hermetic path (§7.1).
 */
export function materializeTrace(events: readonly TaskEvent[], handle: TaskStore): void {
  const { trace, blobs } = handle;
  const callSeqs: Seq[] = [];
  let previousCall: Seq | null = null;

  for (const event of events) {
    const ts = event.ts ?? DEFAULT_TS;
    switch (event.type) {
      case 'user_message':
      case 'assistant_message':
        trace.append({ type: event.type, ts, blob: blobs.put(event.text) });
        break;
      case 'tool_call': {
        const stored = trace.append({
          type: 'tool_call',
          ts,
          tool: event.tool,
          path: event.path,
          blob: event.content === undefined ? undefined : blobs.put(event.content),
          args_blob: event.args === undefined ? undefined : blobs.put(event.args),
        });
        callSeqs.push(stored.seq);
        previousCall = stored.seq;
        break;
      }
      case 'tool_result': {
        const target = event.call === undefined ? previousCall : (callSeqs[event.call - 1] ?? null);
        if (target === null) {
          throw new TaskSpecError(
            `tool_result: no tool_call to attach to (call=${String(event.call ?? 'previous')})`,
            [],
          );
        }
        trace.append({
          type: 'tool_result',
          ts,
          call_seq: target,
          output_blob: event.output === undefined ? undefined : blobs.put(event.output),
          error: event.error,
          truncated: event.truncated,
        });
        break;
      }
      case 'segment_boundary':
        trace.append({ type: 'segment_boundary', ts, from: event.from ?? null, to: event.to });
        break;
      default:
        break;
    }
  }
}

// ── checkers ───────────────────────────────────────────────────────────────

export interface CheckerToolCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export interface CheckerInput {
  task: EvalTask;
  /** The resuming agent's last assistant text. */
  finalText: string;
  toolCalls: readonly CheckerToolCall[];
  steps: number;
  stoppedBy: string;
}

export interface CheckerResult {
  passed: boolean;
  /** Why — shown verbatim in the results file, so it must name what failed. */
  detail: string;
  /**
   * §15's organization-quality metric. Left undefined by a checker that does
   * not judge staleness; metrics then reports "not reported" rather than 0.
   */
  staleSummaryIncident?: boolean;
}

export type CheckerFn = (input: CheckerInput) => CheckerResult | Promise<CheckerResult>;

/**
 * The default checker: every assertion in `expect`, and nothing else. It is a
 * script checker in §15's sense — the LLM judge is a separate, additional
 * grade, never a substitute for this one.
 */
export const goldenTextChecker: CheckerFn = (input) => {
  const { expect } = input.task;
  const text = input.finalText;
  const failures: string[] = [];

  for (const needle of expect.answerContains ?? []) {
    if (!text.includes(needle)) failures.push(`answer is missing ${JSON.stringify(needle)}`);
  }
  for (const needle of expect.answerOmits ?? []) {
    if (text.includes(needle)) failures.push(`answer contains forbidden ${JSON.stringify(needle)}`);
  }
  const used = new Set(input.toolCalls.map((call) => call.name));
  for (const name of expect.requiresTool ?? []) {
    if (!used.has(name)) failures.push(`run never called ${name}`);
  }
  for (const name of expect.forbidsTool ?? []) {
    if (used.has(name)) failures.push(`run called ${name}, which this task forbids`);
  }
  if (expect.maxToolCalls !== undefined && input.toolCalls.length > expect.maxToolCalls) {
    failures.push(`run made ${String(input.toolCalls.length)} tool calls, over the cap of ${String(expect.maxToolCalls)}`);
  }

  const result: CheckerResult = {
    passed: failures.length === 0,
    detail: failures.length === 0 ? 'all expectations met' : failures.join('; '),
  };
  // Only a stale-summary task can report the incident — elsewhere the field
  // stays undefined so the metric says "not reported" instead of a false 0.
  const markers = input.task.expect.staleMarkers;
  if (input.task.trap === 'stale-summary' && markers !== undefined) {
    result.staleSummaryIncident = markers.some((marker) => text.includes(marker));
  }
  return result;
};

export const BUILTIN_CHECKERS: Readonly<Record<string, CheckerFn>> = Object.freeze({
  'golden-text': goldenTextChecker,
});

export interface ResolveCheckerOptions {
  /** Overrides `BUILTIN_CHECKERS` — the injection point offline tests use. */
  registry?: Readonly<Record<string, CheckerFn>>;
}

/** `builtin:<name>` from the registry; anything else is imported from disk. */
export async function resolveChecker(task: EvalTask, options: ResolveCheckerOptions = {}): Promise<CheckerFn> {
  const ref = task.checker;
  const registry = options.registry ?? BUILTIN_CHECKERS;
  if (ref.module.startsWith('builtin:')) {
    const name = ref.module.slice('builtin:'.length);
    const fn = registry[name];
    if (fn === undefined) {
      throw new TaskSpecError(
        `${task.id}: checker.module "builtin:${name}" is not a builtin (have: ${Object.keys(registry).join(', ')})`,
        [],
      );
    }
    return fn;
  }
  const path = resolveAgainst(task.baseDir, ref.module);
  const loaded = (await import(path)) as Record<string, unknown>;
  const exportName = ref.export ?? 'default';
  const fn = loaded[exportName];
  if (typeof fn !== 'function') {
    throw new TaskSpecError(`${task.id}: ${path} has no exported function ${JSON.stringify(exportName)}`, []);
  }
  return fn as CheckerFn;
}
