/**
 * §15's four arms. Same task, same model, same tokenizer, same cost meter —
 * only the context differs:
 *
 *   A `full-transcript`  every event verbatim: the quality ceiling, worst cost
 *   B `flat-window`      the last N tokens: what naive agents do
 *   C `flat-summary`     one whole-transcript summary (Mem0-style flatten)
 *   D `context-tree`     ZoneAssembler output + the four §9 tools
 *
 * The shared `ArmRuntime` is the load-bearing part. A per-arm tokenizer would
 * make the token comparison meaningless (§15's headline claim is a token
 * ratio), and a per-arm cost meter would make the cap unenforceable, so the
 * tokenizer, the meter and the metered provider are constructed once and handed
 * to every arm as one object that cannot be split.
 */
import {
  HeuristicTokenizer,
  InMemoryCostMeter,
  MeteredProvider,
  TreeRetriever,
  ZoneAssembler,
  renderEvent,
  systemContract,
  toCompletionRequest,
  type AssembledPrompt,
  type ChatMessage,
  type CompletionRequest,
  type CostMeter,
  type ModelProvider,
  type TaskStore,
  type Tokenizer,
  type ToolSchema,
} from '@context-tree/core';
import {
  ANNOTATE,
  ANNOTATE_DESCRIPTION,
  CONTEXT_FETCH,
  CONTEXT_FETCH_DESCRIPTION,
  CONTEXT_PEEK,
  CONTEXT_PEEK_DESCRIPTION,
  CONTEXT_SEARCH,
  CONTEXT_SEARCH_DESCRIPTION,
  HANDLERS,
  TOOL_NAMES,
  type ToolContext,
  type ToolName,
} from '@context-tree/mcp';
import type { ToolBinding } from './loop.js';
import type { EvalTask } from './task-spec.js';

export const ARM_IDS = ['A', 'B', 'C', 'D'] as const;
export type ArmId = (typeof ARM_IDS)[number];

export const ARM_NAMES: Readonly<Record<ArmId, string>> = Object.freeze({
  A: 'full-transcript',
  B: 'flat-window',
  C: 'flat-summary',
  D: 'context-tree',
});

/** Arms that cannot be built without a model call of their own. */
export const ARMS_NEEDING_SUMMARY: readonly ArmId[] = ['C', 'D'];

export function parseArmId(value: string): ArmId {
  if ((ARM_IDS as readonly string[]).includes(value)) return value as ArmId;
  const byName = ARM_IDS.find((id) => ARM_NAMES[id] === value);
  if (byName !== undefined) return byName;
  throw new Error(`unknown arm ${JSON.stringify(value)} — expected one of ${ARM_IDS.join(', ')}`);
}

/**
 * The instruction every arm shares. Identical bytes in all four so the only
 * measured difference is the CONTEXT, which is the whole design of §15.
 */
export const RESUME_SYSTEM = [
  'You are resuming a coding task that another agent started. You did not see that work happen.',
  'Answer the request using the recorded context you are given. Be concrete: name files, symbols and',
  'test outcomes rather than describing them in general terms. If the context contradicts itself, say',
  'which version you are acting on and why. When you are done, state your answer in plain prose.',
].join(' ');

// ── the §9 tool set, as the model sees it ──────────────────────────────────

/**
 * JSON Schema for the four tools. The names and descriptions are imported from
 * `@context-tree/mcp` so Zone A's text is the real one; the argument schemas are
 * mirrored by hand because `zod` is not resolvable from `eval/` and this package
 * adds no dependencies. `harness.test.ts` asserts these properties against the
 * exported zod shapes, so a drifted argument fails the suite rather than the run.
 */
export const TOOL_SCHEMAS: readonly ToolSchema[] = Object.freeze([
  {
    name: CONTEXT_FETCH,
    description: CONTEXT_FETCH_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        branch_id: { type: 'string', description: 'Node id of the branch to read.' },
        depth: { type: 'string', enum: ['summary', 'full'], description: "'summary' (default) or 'full'." },
        file: { type: 'string', description: 'Repo-relative path to narrow to one file node.' },
      },
      required: ['branch_id'],
      additionalProperties: false,
    },
  },
  {
    name: CONTEXT_SEARCH,
    description: CONTEXT_SEARCH_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in words.' },
        kind: { type: 'string', enum: ['task', 'phase', 'file', 'turn'], description: 'Narrow to one node kind.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: CONTEXT_PEEK,
    description: CONTEXT_PEEK_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Node to excerpt.' },
        max_chars: { type: 'integer', description: 'Excerpt length.' },
      },
      required: ['node_id'],
      additionalProperties: false,
    },
  },
  {
    name: ANNOTATE,
    description: ANNOTATE_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Node the note is about.' },
        text: { type: 'string', description: 'The note, in your own words.' },
        link_to: { type: 'string', description: 'Node id to link node_id to.' },
        link_kind: { type: 'string', enum: ['superseded_by', 'relates_to', 'blocks'], description: 'Edge kind.' },
      },
      required: ['node_id', 'text'],
      additionalProperties: false,
    },
  },
]);

/**
 * Dispatch into the handlers `@context-tree/mcp` exports. Not a reimplementation
 * and not a copy: an eval that called a different code path would measure a
 * surface the agent never sees (§11).
 */
export function mcpToolBinding(ctx: ToolContext): ToolBinding {
  return {
    schemas: TOOL_SCHEMAS,
    async invoke(name, input) {
      if (!(TOOL_NAMES as readonly string[]).includes(name)) {
        return { ok: false, error: { code: 'invalid_input', message: `unknown tool ${JSON.stringify(name)}` } };
      }
      return HANDLERS[name as ToolName](ctx, input);
    },
  };
}

// ── shared runtime ─────────────────────────────────────────────────────────

export interface ArmRuntime {
  /** One tokenizer for every arm — see the file header. */
  tokenizer: Tokenizer;
  meter: CostMeter;
  /** The inner provider wrapped in `MeteredProvider`, so no call escapes the cap. */
  provider: ModelProvider;
  model: string;
}

export function createArmRuntime(provider: ModelProvider, model: string, capUsd: number | null): ArmRuntime {
  const meter = new InMemoryCostMeter({ capUsd });
  return {
    tokenizer: new HeuristicTokenizer(),
    meter,
    provider: new MeteredProvider(provider, meter),
    model,
  };
}

// ── transcript rendering (arms A and B) ────────────────────────────────────

/** Every L0 event through core's own renderer, so all arms read the same bytes. */
export function renderTranscript(handle: TaskStore): string {
  return handle.trace
    .all()
    .map((event) => renderEvent(event, handle.blobs))
    .join('\n\n');
}

/**
 * The last `budget` tokens of the transcript, event-aligned. Events are dropped
 * from the FRONT, which is what a naive sliding window does, and the marker
 * says how many went — a window that silently swallowed the first half of a
 * session would flatter arm B against arms C and D.
 */
export function renderWindow(handle: TaskStore, budget: number, tokenizer: Tokenizer): string {
  const events = handle.trace.all();
  const rendered = events.map((event) => renderEvent(event, handle.blobs));
  const kept: string[] = [];
  let tokens = 0;
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    const text = rendered[i] ?? '';
    const cost = tokenizer.count(text);
    if (tokens + cost > budget && kept.length > 0) break;
    kept.unshift(text);
    tokens += cost;
  }
  const dropped = rendered.length - kept.length;
  const header =
    dropped === 0
      ? `[window: the whole transcript fits in ${String(budget)} tokens]`
      : `[window: the last ${String(kept.length)} of ${String(rendered.length)} events; ${String(dropped)} older events are not shown]`;
  return [header, ...kept].join('\n\n');
}

// ── arm C's flatten ────────────────────────────────────────────────────────

/**
 * Arm C: ONE summary of the whole raw transcript, Mem0-style. This is the arm
 * the tree has to beat, and it is deliberately built the way §8 forbids —
 * summarizing raw events at the root instead of summarizing leaf summaries.
 * That is not an oversight in the baseline; it is the thing being measured. If
 * D does not beat C, the two-level structure is not paying for itself.
 */
export const FLATTEN_INSTRUCTION = [
  'Summarize this entire coding session into one self-contained brief for an agent that will resume the',
  'task and has seen none of it. Cover: what was being done, which files and symbols changed, what the',
  'tests said, decisions taken, and anything still open. Prose only.',
].join(' ');

export async function buildFlatSummary(runtime: ArmRuntime, transcript: string, taskTitle: string): Promise<string> {
  const result = await runtime.provider.complete({
    model: runtime.model,
    system: RESUME_SYSTEM,
    messages: [{ role: 'user', content: `# Session: ${taskTitle}\n\n${FLATTEN_INSTRUCTION}\n\n${transcript}` }],
  });
  return result.text;
}

// ── building an arm's prompt ───────────────────────────────────────────────

export interface ArmBuildInput {
  task: EvalTask;
  /** The ingested store for this task: L0 + L2 + L1, and L1's summaries for D. */
  handle: TaskStore;
  runtime: ArmRuntime;
  /** Arm B's window size, in tokens of the shared tokenizer. */
  windowTokens: number;
  /** Arm C only, from `buildFlatSummary`. Absent makes arm C unbuildable. */
  flatSummary?: string;
  budgets?: { zoneB: number; zoneC: number };
}

export interface ArmPrompt {
  arm: ArmId;
  request: CompletionRequest;
  /** Counted with the shared tokenizer over system + every message. */
  promptTokens: number;
  tokenizerId: string;
  /** Arm D only. */
  tools?: ToolBinding;
  /** Arm D only — the input §17's cache simulator scores. */
  assembled?: AssembledPrompt;
  /** Degradations that are real and must be reported, never hidden (§18). */
  conditions: string[];
}

export class ArmUnavailableError extends Error {
  constructor(
    readonly arm: ArmId,
    readonly reason: string,
  ) {
    super(`arm ${arm} (${ARM_NAMES[arm]}) cannot be built: ${reason}`);
    this.name = 'ArmUnavailableError';
  }
}

function countRequest(request: CompletionRequest, tokenizer: Tokenizer): number {
  let total = tokenizer.count(request.system ?? '');
  for (const message of request.messages) total += tokenizer.count(message.content);
  return total;
}

function contextMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

export function buildArm(arm: ArmId, input: ArmBuildInput): ArmPrompt {
  const { runtime, task } = input;
  const conditions: string[] = [];

  if (arm === 'D') return buildTreeArm(input);

  let context: string;
  switch (arm) {
    case 'A':
      context = renderTranscript(input.handle);
      break;
    case 'B':
      context = renderWindow(input.handle, input.windowTokens, runtime.tokenizer);
      break;
    case 'C': {
      if (input.flatSummary === undefined) {
        throw new ArmUnavailableError('C', 'no whole-transcript summary was produced (the flatten call did not run)');
      }
      context = `# Session summary\n\n${input.flatSummary}`;
      break;
    }
    default:
      throw new ArmUnavailableError(arm, 'unhandled arm');
  }

  const request: CompletionRequest = {
    model: runtime.model,
    system: RESUME_SYSTEM,
    messages: [contextMessage(context), contextMessage(task.prompt)],
  };
  return {
    arm,
    request,
    promptTokens: countRequest(request, runtime.tokenizer),
    tokenizerId: runtime.tokenizer.id,
    conditions,
  };
}

/**
 * Arm D. Zone A is the resume instruction plus the §9 system contract; the tool
 * half of Zone A travels as the provider's native tool list rather than as
 * prompt text, because that is where the provider caches it — sending both
 * would charge the schemas twice on every turn.
 */
function buildTreeArm(input: ArmBuildInput): ArmPrompt {
  const { handle, runtime, task } = input;
  const conditions: string[] = [];

  const assembler = new ZoneAssembler({
    store: handle.store,
    blobs: handle.blobs,
    trace: handle.trace,
    tokenizer: runtime.tokenizer,
    systemContract: `${RESUME_SYSTEM}\n\n${systemContract()}`,
    budgets: input.budgets ?? handle.config.budgets,
  });
  const assembled = assembler.assemble();
  if (assembled.blocks.filter((block) => block.zone === 'B').length === 0) {
    conditions.push('arm D: Zone B is empty — the tree carries no summaries, so D is running on structure alone');
  }

  const request = toCompletionRequest(assembled, runtime.model, { tools: TOOL_SCHEMAS });
  request.messages.push(contextMessage(task.prompt));

  // No embedder: L3 is unbuildable against Anthropic/OpenRouter (neither has an
  // embedding endpoint), so `context_search` runs §9's lexical beam fallback.
  // That is a reported condition of the run, not a failure of it.
  const retriever = new TreeRetriever({ store: handle.store, blobs: handle.blobs, trace: handle.trace });
  conditions.push('arm D: no embedder configured — context_search runs the lexical beam fallback (L3 absent)');

  const ctx: ToolContext = { config: handle.config, handle, retriever };
  return {
    arm: 'D',
    request,
    promptTokens: countRequest(request, runtime.tokenizer),
    tokenizerId: runtime.tokenizer.id,
    tools: mcpToolBinding(ctx),
    assembled,
    conditions,
  };
}
