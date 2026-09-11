/**
 * §11 configuration. API keys come from the environment only — never from the
 * config file, which is committed in real projects.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
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
  // implementation — Claude Code (PascalCase) + generic (snake_case) + opencode (lowercase)
  edit_file: 'implementation',
  write_file: 'implementation',
  Edit: 'implementation',
  Write: 'implementation',
  NotebookEdit: 'implementation',
  apply_patch: 'implementation',
  edit: 'implementation',
  write: 'implementation',
  patch: 'implementation',
  // verification
  run_tests: 'verification',
  Test: 'verification',
  // diagnosis
  read_file: 'diagnosis',
  Read: 'diagnosis',
  Grep: 'diagnosis',
  Glob: 'diagnosis',
  search_code: 'diagnosis',
  read: 'diagnosis',
  grep: 'diagnosis',
  glob: 'diagnosis',
  list: 'diagnosis',
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
  bash: 'other',
  task: 'other',
  webfetch: 'other',
});

/** Tools whose `path` argument keys a file node under the phase (§7). */
export const DEFAULT_FILE_TOOLS: readonly string[] = Object.freeze([
  'edit_file',
  'write_file',
  'Edit',
  'Write',
  'NotebookEdit',
  'apply_patch',
  'edit',
  'write',
  'patch',
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
  /**
   * L3 embedding model. Its vector width is not recorded here — sqlite-vec
   * takes the dimension from the first vector actually written and enforces
   * that width thereafter (`store/sqlite.ts` `ensureEmbeddingsTable`), so
   * there is nothing for a config field to validate in advance. L3 is
   * disposable (D8): switching models is `dropEmbeddings()` + re-embed.
   */
  embedModel: string;
  provider: 'anthropic' | 'openrouter' | 'mock' | 'recorded';
  /** §9.2 / D14. Mode A is the v1 default (§19 Q5). */
  mode: 'tool-backend' | 'middleware';
  toolPhase: Record<string, PhaseType>;
  neutralPhases: PhaseType[];
  fileTools: string[];
  languages: Record<string, string>;
  /** D17: max branch headlines the composed root renders; older members fold into one line. */
  rootKeep: number;
  summarize: { concurrency: number; maxSummaryTokens: number };
  /**
   * `limit`: the ranked branch pool. `eventHits` / `excerptChars`: how many EVENT hits
   * `context_search` returns from that pool and how much of each event's text a hit
   * carries. The two defaults are the published claude.ai interface's (5 hits;
   * ~200-360-word chunks) and were measured, not derived, on one store — see
   * `reports/algorithm.md` Tier 2 before treating them as settled.
   */
  retrieval: { providers: string[]; limit: number; eventHits: number; excerptChars: number };
  /** Per-run spend cap in USD; null disables the cap. */
  costCapUsd: number | null;
  taskTitle: string;
}

export const DEFAULT_CONFIG: ContextTreeConfig = {
  root: '.context-tree',
  leafModel: 'claude-haiku-4-5-20251001',
  rootModel: 'claude-sonnet-5',
  judgeModel: 'claude-opus-5',
  embedModel: 'text-embedding-3-small',
  provider: 'anthropic',
  mode: 'tool-backend',
  toolPhase: { ...DEFAULT_TOOL_PHASE },
  neutralPhases: ['other'],
  fileTools: [...DEFAULT_FILE_TOOLS],
  languages: { ...DEFAULT_LANGUAGES },
  rootKeep: 40,
  summarize: { concurrency: 8, maxSummaryTokens: 1_024 },
  retrieval: { providers: ['graft', 'serena', 'augment', 'vector', 'grep'], limit: 20, eventHits: 5, excerptChars: 1_000 },
  costCapUsd: null,
  taskTitle: 'task',
};

/**
 * Model ids are provider-namespaced, so the §8 role defaults differ per provider:
 * an Anthropic-native id like `claude-haiku-4-5-20251001` 404s on OpenRouter, and
 * vice versa. Picking the wrong set fails at the first live call rather than at
 * config load, so `resolveConfig` substitutes the right set when the caller names
 * a provider without naming models.
 *
 * `embedModel` is unaffected by this table: it selects an embeddings client
 * built separately (`models/embeddings.ts`), not a chat-completion model, and
 * §9's lexical beam-search fallback still runs whenever no embedder — of
 * either provider — is configured or L3 hasn't been populated.
 */
export const PROVIDER_MODEL_DEFAULTS: Readonly<
  Record<'anthropic' | 'openrouter', Pick<ContextTreeConfig, 'leafModel' | 'rootModel' | 'judgeModel'>>
> = Object.freeze({
  anthropic: {
    leafModel: 'claude-haiku-4-5-20251001',
    rootModel: 'claude-sonnet-5',
    judgeModel: 'claude-opus-5',
  },
  openrouter: {
    leafModel: 'anthropic/claude-haiku-4.5',
    rootModel: 'anthropic/claude-sonnet-5',
    judgeModel: 'anthropic/claude-opus-5',
  },
});

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
    summarize: { ...DEFAULT_CONFIG.summarize, ...(partial.summarize ?? {}) },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...(partial.retrieval ?? {}) },
    neutralPhases: partial.neutralPhases ? [...partial.neutralPhases] : [...DEFAULT_CONFIG.neutralPhases],
    fileTools: partial.fileTools ? [...partial.fileTools] : [...DEFAULT_CONFIG.fileTools],
  };

  // A caller who names a provider but not models gets that provider's ids,
  // rather than the Anthropic-native defaults that would 404 on OpenRouter.
  const providerDefaults = PROVIDER_MODEL_DEFAULTS[merged.provider as 'anthropic' | 'openrouter'];
  if (providerDefaults) {
    if (partial.leafModel === undefined) merged.leafModel = providerDefaults.leafModel;
    if (partial.rootModel === undefined) merged.rootModel = providerDefaults.rootModel;
    if (partial.judgeModel === undefined) merged.judgeModel = providerDefaults.judgeModel;
  }

  for (const [tool, phase] of Object.entries(merged.toolPhase)) {
    merged.toolPhase[tool] = assertPhase(phase, `toolPhase.${tool}`);
  }
  merged.neutralPhases = merged.neutralPhases.map((p, i) => assertPhase(p, `neutralPhases[${i}]`));

  if (merged.summarize.concurrency <= 0) throw new ConfigError('summarize.concurrency must be > 0');
  if (merged.rootKeep <= 0) throw new ConfigError('rootKeep must be > 0');

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
  openai?: string;
}

/**
 * Accepted environment variable names per key, in precedence order.
 *
 * The `*_API_KEY` form is canonical; the shorter aliases are accepted because
 * they are what people actually put in a `.env`, and silently ignoring a key
 * that is plainly present is a worse failure than accepting two spellings —
 * it presents as "no key configured" while the key sits right there.
 */
export const API_KEY_ENV_NAMES: Readonly<Record<keyof ApiKeys, readonly string[]>> = Object.freeze({
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_KEY'],
  openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
  voyage: ['VOYAGE_API_KEY', 'VOYAGE_KEY'],
  openai: ['OPENAI_API_KEY', 'OPENAI_KEY'],
});

/** API keys, environment only (§11). */
export function loadApiKeys(env: NodeJS.ProcessEnv = process.env): ApiKeys {
  const keys: ApiKeys = {};
  for (const [key, names] of Object.entries(API_KEY_ENV_NAMES) as Array<
    [keyof ApiKeys, readonly string[]]
  >) {
    for (const name of names) {
      const value = env[name];
      if (value) {
        keys[key] = value;
        break;
      }
    }
  }
  return keys;
}

/** Which key names a provider needs, so a caller can say what is missing. */
export const PROVIDER_KEY: Readonly<Record<ContextTreeConfig['provider'], keyof ApiKeys | null>> =
  Object.freeze({
    anthropic: 'anthropic' as const,
    openrouter: 'openrouter' as const,
    mock: null,
    recorded: null,
  });

export interface DotEnvResult {
  /** Files actually read, nearest-first. */
  loaded: string[];
  /** Names set into `process.env` by this call. Names only — never values. */
  applied: string[];
  /** Names present in a file but left alone because the environment already had them. */
  skipped: string[];
}

/**
 * Loads `.env` into `process.env` so §11's env-only key rule has something to
 * read. Without this, a key in a `.env` file is invisible: `loadApiKeys` reads
 * the environment and nothing populates it.
 *
 * An existing environment variable always wins — an explicit `KEY=… command`
 * must not be silently overridden by a stale file. Search walks up from `cwd`
 * so a workspace-level `.env` covers a nested package, and stops at the first
 * directory holding one unless `all` is set.
 *
 * Values are never logged or returned; only names appear in the result, because
 * this function's whole input is secrets.
 */
export function loadDotEnv(cwd = process.cwd(), options: { all?: boolean } = {}): DotEnvResult {
  const result: DotEnvResult = { loaded: [], applied: [], skipped: [] };
  let dir = resolve(cwd);

  for (;;) {
    const file = resolve(dir, '.env');
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      continue;
    }

    result.loaded.push(file);
    for (const [name, value] of parseDotEnv(raw)) {
      if (process.env[name] === undefined) {
        process.env[name] = value;
        result.applied.push(name);
      } else if (!result.applied.includes(name)) {
        result.skipped.push(name);
      }
    }
    if (!options.all) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return result;
}

/**
 * Minimal `.env` parser: `KEY=value`, `export KEY=value`, `#` comments, and
 * single- or double-quoted values. Deliberately not a dependency — the format
 * this needs to read is four lines of shell-ish text, and a parser that also
 * does interpolation would let a `.env` expand one secret into another.
 */
function parseDotEnv(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const name = match[1];
    let value = (match[2] ?? '').trim();
    if (!name) continue;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing unquoted comment, which quoting would have protected.
      value = value.replace(/\s+#.*$/, '');
    }
    out.push([name, value]);
  }
  return out;
}
