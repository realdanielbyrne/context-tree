/**
 * §11 configuration. API keys come from the environment only — never from the
 * config file, which is committed in real projects.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ConfigError } from './contracts/errors.js';
import { PHASE_TYPES, type PhaseType } from './contracts/tree.js';

/**
 * §7 default tool -> phase map. Harness tool names vary, so this is remappable;
 * `toolPhase` in the config file is merged over these defaults.
 *
 * Anything unmapped becomes `other`, which is neutral by default (Ruling C6):
 * it attaches to the open phase rather than opening a node of its own.
 */
export const DEFAULT_TOOL_PHASE: Readonly<Record<string, PhaseType>> = Object.freeze({
  // implementation
  edit_file: 'implementation',
  write_file: 'implementation',
  Edit: 'implementation',
  Write: 'implementation',
  NotebookEdit: 'implementation',
  apply_patch: 'implementation',
  // verification
  run_tests: 'verification',
  Test: 'verification',
  // diagnosis
  read_file: 'diagnosis',
  Read: 'diagnosis',
  Grep: 'diagnosis',
  Glob: 'diagnosis',
  search_code: 'diagnosis',
  // delivery
  create_ticket: 'delivery',
  push_pr: 'delivery',
  open_pr: 'delivery',
  // review
  post_comment: 'review',
  reply_comment: 'review',
  // explicitly neutral
  run_command: 'other',
  Bash: 'other',
});

/** Tools whose `path` argument keys a file node under the phase (§7). */
export const DEFAULT_FILE_TOOLS: readonly string[] = Object.freeze([
  'edit_file',
  'write_file',
  'Edit',
  'Write',
  'NotebookEdit',
  'apply_patch',
]);

/** Extension -> tree-sitter grammar module (§12, lazily loaded). */
export const DEFAULT_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
});

export interface ContextTreeConfig {
  /** Directory holding L0/L2/L1/L4 for one task (§19 Q3: one DB per task). */
  root: string;
  /** Cheap, high-volume leaf summarizer (§8). */
  leafModel: string;
  /** Strong root/task summarizer (§8). */
  rootModel: string;
  /** Eval judge (§15). */
  judgeModel: string;
  embedModel: string;
  /** L3 vector width. A change forces an L3 rebuild — L3 is disposable. */
  embedDim: number;
  provider: 'anthropic' | 'openrouter' | 'mock' | 'recorded';
  /** §9.2 / D14. Mode A is the v1 default (§19 Q5). */
  mode: 'tool-backend' | 'middleware';
  toolPhase: Record<string, PhaseType>;
  neutralPhases: PhaseType[];
  fileTools: string[];
  languages: Record<string, string>;
  budgets: { zoneB: number; zoneC: number };
  summarize: { concurrency: number; maxSummaryTokens: number };
  retrieval: { providers: string[]; limit: number };
  /** Per-run spend cap in USD; null disables the cap. */
  costCapUsd: number | null;
  taskTitle: string;
}

export const DEFAULT_CONFIG: ContextTreeConfig = {
  root: '.context-tree',
  leafModel: 'claude-haiku-4-5-20251001',
  rootModel: 'claude-sonnet-5',
  judgeModel: 'claude-opus-5',
  embedModel: 'voyage-3-lite',
  embedDim: 512,
  provider: 'anthropic',
  mode: 'tool-backend',
  toolPhase: { ...DEFAULT_TOOL_PHASE },
  neutralPhases: ['other'],
  fileTools: [...DEFAULT_FILE_TOOLS],
  languages: { ...DEFAULT_LANGUAGES },
  budgets: { zoneB: 8_000, zoneC: 30_000 },
  summarize: { concurrency: 8, maxSummaryTokens: 1_024 },
  retrieval: { providers: ['graft', 'serena', 'augment', 'vector', 'grep'], limit: 20 },
  costCapUsd: null,
  taskTitle: 'task',
};

export const CONFIG_FILENAME = 'context-tree.config.json';

function assertPhase(value: unknown, where: string): PhaseType {
  if (typeof value !== 'string' || !(PHASE_TYPES as readonly string[]).includes(value)) {
    throw new ConfigError(`${where}: expected one of ${PHASE_TYPES.join('|')}, got ${String(value)}`);
  }
  return value as PhaseType;
}

/** Merges a partial config over the defaults, validating phase names. */
export function resolveConfig(
  partial: Partial<ContextTreeConfig> = {},
  cwd = process.cwd(),
): ContextTreeConfig {
  const merged: ContextTreeConfig = {
    ...DEFAULT_CONFIG,
    ...partial,
    toolPhase: { ...DEFAULT_CONFIG.toolPhase, ...(partial.toolPhase ?? {}) },
    languages: { ...DEFAULT_CONFIG.languages, ...(partial.languages ?? {}) },
    budgets: { ...DEFAULT_CONFIG.budgets, ...(partial.budgets ?? {}) },
    summarize: { ...DEFAULT_CONFIG.summarize, ...(partial.summarize ?? {}) },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...(partial.retrieval ?? {}) },
    neutralPhases: partial.neutralPhases ? [...partial.neutralPhases] : [...DEFAULT_CONFIG.neutralPhases],
    fileTools: partial.fileTools ? [...partial.fileTools] : [...DEFAULT_CONFIG.fileTools],
  };

  for (const [tool, phase] of Object.entries(merged.toolPhase)) {
    merged.toolPhase[tool] = assertPhase(phase, `toolPhase.${tool}`);
  }
  merged.neutralPhases = merged.neutralPhases.map((p, i) => assertPhase(p, `neutralPhases[${i}]`));

  if (merged.embedDim <= 0) throw new ConfigError('embedDim must be > 0');
  if (merged.summarize.concurrency <= 0) throw new ConfigError('summarize.concurrency must be > 0');
  if (merged.budgets.zoneB <= 0 || merged.budgets.zoneC <= 0) {
    throw new ConfigError('budgets must be > 0');
  }

  merged.root = isAbsolute(merged.root) ? merged.root : resolve(cwd, merged.root);
  return merged;
}

/** Reads `context-tree.config.json` from `cwd` if present; defaults otherwise. */
export function loadConfig(cwd = process.cwd(), filename = CONFIG_FILENAME): ContextTreeConfig {
  const path = resolve(cwd, filename);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return resolveConfig({}, cwd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${path}: invalid JSON — ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path}: expected a JSON object`);
  }
  return resolveConfig(parsed as Partial<ContextTreeConfig>, cwd);
}

export interface ApiKeys {
  anthropic?: string;
  openrouter?: string;
  voyage?: string;
}

/** API keys, environment only (§11). */
export function loadApiKeys(env: NodeJS.ProcessEnv = process.env): ApiKeys {
  const keys: ApiKeys = {};
  if (env.ANTHROPIC_API_KEY) keys.anthropic = env.ANTHROPIC_API_KEY;
  if (env.OPENROUTER_API_KEY) keys.openrouter = env.OPENROUTER_API_KEY;
  if (env.VOYAGE_API_KEY) keys.voyage = env.VOYAGE_API_KEY;
  return keys;
}
