/**
 * The tool surface both arms share: `run_command` / `read_file` / `write_file`
 * / `edit_file` over the sandbox. Names deliberately match `config.toolPhase`'s
 * defaults so the segmenter phases tree-arm traces without a remap. The
 * context-tree arm adds the four §9 tools, dispatched through the SAME handlers
 * the MCP server registers — an eval that called a different code path would
 * measure a surface the agent never sees (packages/mcp README contract).
 */
import type { ToolSchema } from '@context-tree/core';
import {
  ANNOTATE,
  ANNOTATE_DESCRIPTION,
  CONTEXT_FETCH,
  CONTEXT_FETCH_DESCRIPTION,
  CONTEXT_PEEK,
  CONTEXT_PEEK_DESCRIPTION,
  CONTEXT_SEARCH,
  CONTEXT_SEARCH_DESCRIPTION,
} from '@context-tree/mcp';
import { renderOutcome, type Sandbox } from './sandbox.js';

export const RUN_COMMAND = 'run_command';
export const READ_FILE = 'read_file';
export const WRITE_FILE = 'write_file';
export const EDIT_FILE = 'edit_file';

export const HARNESS_TOOL_NAMES: readonly string[] = [RUN_COMMAND, READ_FILE, WRITE_FILE, EDIT_FILE];

export function isHarnessTool(name: string): boolean {
  return HARNESS_TOOL_NAMES.includes(name);
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

export interface ToolCallOutcome {
  output: string;
  isError: boolean;
  /** Post-edit file content for file tools — keys the §12 span extraction blob. */
  postContent?: string;
}

export const HARNESS_TOOL_SCHEMAS: readonly ToolSchema[] = [
  {
    name: RUN_COMMAND,
    description:
      'Run a shell command inside the task working directory and return its stdout/stderr and exit code. ' +
      'Use it to build, test, inspect and run the project you are working on.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run.' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: READ_FILE,
    description: 'Read a file from the task working directory.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Working-directory-relative file path.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: WRITE_FILE,
    description: 'Create or overwrite a file with the given content.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Working-directory-relative file path.' },
        content: { type: 'string', description: 'The full new file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: EDIT_FILE,
    description: 'Replace the first occurrence of old_text with new_text in a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Working-directory-relative file path.' },
        old_text: { type: 'string', description: 'Exact text to replace; must appear in the file.' },
        new_text: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
];

/** The four §9 tools, as Zone A-native schemas matching the MCP zod shapes. */
export const CONTEXT_TOOL_SCHEMAS: readonly ToolSchema[] = [
  {
    name: CONTEXT_FETCH,
    description: CONTEXT_FETCH_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        branch_id: { type: 'string', description: 'Node id of the branch to read, as returned by context_search.' },
        depth: { type: 'string', enum: ['summary', 'full'], description: "'summary' (default) or 'full' replay." },
        file: { type: 'string', description: 'Repo-relative path: narrow the fetch to one file node.' },
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
        kind: { type: 'string', enum: ['task', 'phase', 'file', 'turn'] },
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
        max_chars: { type: 'number', description: 'Excerpt length cap.' },
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
        link_kind: { type: 'string', enum: ['superseded_by', 'relates_to', 'blocks'] },
      },
      required: ['node_id', 'text'],
      additionalProperties: false,
    },
  },
];

export function isContextTool(name: string): boolean {
  return CONTEXT_TOOL_SCHEMAS.some((tool) => tool.name === name);
}

/**
 * Zone A text for the tree arm's assembler — the tool schemas as one
 * deterministic JSON string, byte-stable for the life of the process so the
 * cached prefix never churns.
 */
export const TREE_ZONE_A_TOOL_SCHEMAS_TEXT: string = JSON.stringify([
  ...HARNESS_TOOL_SCHEMAS,
  ...CONTEXT_TOOL_SCHEMAS,
]);

/**
 * The §9 contract governs the context tools, not task completion — a tree-arm
 * agent with no completion instruction shells forever. This addendum is
 * appended to the system contract once, at session start, so Zone A stays
 * byte-stable across every turn (D5: frozen means frozen).
 */
export const TREE_COMPLETION_ADDENDUM: string = [
  '',
  '# Completing the task',
  'Alongside the memory tools above you also have the working tools (run_command, read_file, write_file, edit_file)',
  'that actually do the task. Use them — context tools only recall what already happened.',
  '',
  'Trust order: the Active branch detail and the filesystem are ground truth; branch summaries are',
  'prose that may be stale or wrong (they can say a file is missing when it exists). If the Active',
  'branch already shows your command succeeding and its output matching what the task asked for,',
  'the step is DONE — do not re-run it, and do not chase an open question a summary has already answered.',
  '',
  'Summary open questions are observations, never requests. If a summary asks why the final reply',
  'was not sent, the answer is to send the final reply NOW — running more commands cannot answer it.',
  'When the task is complete, STOP calling tools and reply with your final answer:',
  'a reply without tool calls ends the task, so make that reply the deliverable the task asks for.',
].join('\n');


function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${key}: expected a non-empty string`);
  }
  return value;
}

export async function executeHarnessTool(
  sandbox: Sandbox,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolCallOutcome> {
  try {
    switch (name) {
      case RUN_COMMAND: {
        const outcome = await sandbox.run(requireString(input, 'command'), DEFAULT_COMMAND_TIMEOUT_MS);
        return { output: renderOutcome(outcome), isError: outcome.exitCode !== 0 };
      }
      case READ_FILE:
        return { output: sandbox.readFile(requireString(input, 'path')), isError: false };
      case WRITE_FILE: {
        const relPath = requireString(input, 'path');
        const content = requireString(input, 'content');
        sandbox.writeFile(relPath, content);
        return { output: `wrote ${relPath} (${content.length} bytes)`, isError: false, postContent: content };
      }
      case EDIT_FILE: {
        const relPath = requireString(input, 'path');
        const oldText = requireString(input, 'old_text');
        const newText = requireString(input, 'new_text');
        const current = sandbox.readFile(relPath);
        if (!current.includes(oldText)) {
          return { output: `edit failed: ${relPath} does not contain old_text`, isError: true };
        }
        const next = current.replace(oldText, newText);
        sandbox.writeFile(relPath, next);
        return { output: `edited ${relPath}`, isError: false, postContent: next };
      }
      default:
        return { output: `unknown harness tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { output: `tool error: ${(error as Error).message}`, isError: true };
  }
}

/** For a file-shaped tool call, the working-directory-relative `path` argument. */
export function pathOf(input: Record<string, unknown>): string | undefined {
  const value = input['path'];
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').includes('..')) return undefined;
  return normalized;
}

