/**
 * §13's install end-state: `npm i -g @context-tree/cli && context-tree init`
 * wires the MCP server into the host's config, mirroring graft's onboarding.
 *
 * Two rules shape everything here:
 *  - The registration names `context-tree-mcp` as a **string**. The CLI must not
 *    depend on `@context-tree/mcp`; the bin name is the whole contract between
 *    them.
 *  - The host config is read, merged and written back. A host config holds the
 *    user's other MCP servers, so clobbering it is unacceptable — an existing
 *    `context-tree` entry is refused without `--force`, and `--host print`
 *    writes nothing at all for anyone who wants their config left alone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  SYSTEM_CONTRACT_VERSION,
  resolveConfig,
} from '@context-tree/core';
import { cwdOf, type GlobalOptions } from '../context.js';
import { CliError } from '../errors.js';
import { report, type Io } from '../io.js';

/** `print` writes nothing; the others name a host config to merge into. */
export type InitHost = 'claude-code' | 'codex' | 'opencode' | 'print';

/** Hosts that have a config file. `print` reports the plan for one of these. */
type WritableHost = Exclude<InitHost, 'print'>;

export interface InitOptions extends GlobalOptions {
  host?: InitHost;
  /** Required to replace an existing `context-tree` registration. */
  force?: boolean;
}

export interface McpRegistration {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface InitResult {
  host: InitHost;
  /** The config the registration went into — or would go into, for `print`. */
  hostConfigPath: string;
  hostConfigWritten: boolean;
  /** True when `context-tree` was already registered there. */
  alreadyRegistered: boolean;
  /** Other MCP servers found in that config: proof the merge preserved them. */
  preservedServers: string[];
  configPath: string;
  configWritten: boolean;
  /** §9 system-prompt contract, for pasting into the host's system prompt. */
  systemContractPath: string | null;
  registration: McpRegistration;
}

const SERVER_NAME = 'context-tree';

/** The `@context-tree/mcp` bin, referenced by name — never imported (see header). */
const SERVER_COMMAND = 'context-tree-mcp';

const CLAUDE_CODE_CONFIG = '.mcp.json';
const OPENCODE_CONFIG = 'opencode.json';
const OPENCODE_JSONC = 'opencode.jsonc';

export function initCommand(opts: InitOptions, io: Io): InitResult {
  const cwd = cwdOf(opts);
  const requested: InitHost = opts.host ?? detectHost(cwd);
  const dryRun = requested === 'print';
  const target: WritableHost = dryRun ? detectWritableHost(cwd) : requested;
  const registration: McpRegistration = { command: SERVER_COMMAND, args: [], env: {} };

  const plan =
    target === 'claude-code'
      ? planClaudeCode(join(cwd, CLAUDE_CODE_CONFIG), registration)
      : target === 'opencode'
        ? planOpencode(cwd, registration)
        : planCodex(codexConfigPath(), registration);

  // Refuse before writing anything, so a refused init leaves the tree untouched.
  // `--force` cannot rescue codex: see `refusal`.
  if (plan.alreadyRegistered && !dryRun && (opts.force !== true || target === 'codex')) {
    throw new CliError(refusal(target, plan.path));
  }

  const configPath = join(cwd, CONFIG_FILENAME);
  const scaffoldNeeded = !existsSync(configPath);

  if (!dryRun) {
    mkdirSync(dirname(plan.path), { recursive: true });
    writeFileSync(plan.path, plan.text, 'utf8');
    if (scaffoldNeeded) writeFileSync(configPath, configScaffold(cwd), 'utf8');
  }

  const result: InitResult = {
    host: requested,
    hostConfigPath: plan.path,
    hostConfigWritten: !dryRun,
    alreadyRegistered: plan.alreadyRegistered,
    preservedServers: plan.preservedServers,
    configPath,
    configWritten: !dryRun && scaffoldNeeded,
    systemContractPath: systemContractPath(),
    registration,
  };
  report(io, opts.json, result, humanLines(result, target, dryRun, scaffoldNeeded));
  return result;
}

function refusal(target: WritableHost, path: string): string {
  if (target === 'codex') {
    // Appending a second `[mcp_servers.context-tree]` would make the TOML
    // invalid, and this command never rewrites lines it did not write — so
    // --force has nothing safe to do here.
    return `${SERVER_NAME} is already registered in ${path}; edit that section by hand — init only appends to TOML`;
  }
  return `${SERVER_NAME} is already registered in ${path}; re-run with --force to replace that entry`;
}

interface HostPlan {
  path: string;
  /** Full content to write. */
  text: string;
  alreadyRegistered: boolean;
  preservedServers: string[];
}

/**
 * Claude Code reads project MCP servers from `.mcp.json`'s `mcpServers` map.
 * Spreading (rather than rebuilding) the document preserves both the unrelated
 * server entries and any other top-level keys the host put there.
 */
function planClaudeCode(path: string, registration: McpRegistration): HostPlan {
  const doc = readJsonObject(path);
  const servers = doc.mcpServers;
  if (servers !== undefined && !isPlainObject(servers)) {
    throw new CliError(`${path}: "mcpServers" is not an object — refusing to rewrite it`);
  }
  const existing: Record<string, unknown> = isPlainObject(servers) ? servers : {};
  const merged = { ...doc, mcpServers: { ...existing, [SERVER_NAME]: registration } };
  return {
    path,
    text: `${JSON.stringify(merged, null, 2)}\n`,
    alreadyRegistered: Object.hasOwn(existing, SERVER_NAME),
    preservedServers: Object.keys(existing).filter((name) => name !== SERVER_NAME),
  };
}

const CODEX_SECTION = /^[ \t]*\[mcp_servers\.(?:context-tree|"context-tree")\][ \t]*$/m;
const CODEX_ANY_SECTION = /^[ \t]*\[mcp_servers\.(?:([A-Za-z0-9_-]+)|"([^"]+)")\][ \t]*$/gm;

/**
 * Codex keeps MCP servers in `config.toml`. Node ships no TOML writer, so the
 * merge is **append-only**: existing bytes are never re-serialized, which is the
 * one way to be sure a hand-tuned config survives.
 */
function planCodex(path: string, registration: McpRegistration): HostPlan {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(registration.command)}`,
    'args = []',
    '',
  ].join('\n');
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const preserved: string[] = [];
  for (const match of existing.matchAll(CODEX_ANY_SECTION)) {
    const name = match[1] ?? match[2];
    if (name !== undefined && name !== SERVER_NAME) preserved.push(name);
  }
  return {
    path,
    text: `${existing}${separator}${block}`,
    alreadyRegistered: CODEX_SECTION.test(existing),
    preservedServers: preserved,
  };
}

/** `$CODEX_HOME/config.toml`, the path Codex itself resolves. */
function codexConfigPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
}

function detectHost(cwd: string): InitHost {
  const writable = detectWritableHostOrNull(cwd);
  // Nothing recognizable in this project: print the plan rather than guessing
  // which of the user's configs to edit.
  return writable ?? 'print';
}

function detectWritableHost(cwd: string): WritableHost {
  return detectWritableHostOrNull(cwd) ?? 'claude-code';
}

function detectWritableHostOrNull(cwd: string): WritableHost | null {
  if (existsSync(join(cwd, CLAUDE_CODE_CONFIG)) || existsSync(join(cwd, '.claude'))) {
    return 'claude-code';
  }
  if (existsSync(join(cwd, OPENCODE_CONFIG)) || existsSync(join(cwd, OPENCODE_JSONC))) {
    return 'opencode';
  }
  if (existsSync(codexConfigPath())) return 'codex';
  return null;
}

interface OpencodeRegistration {
  type: string;
  command: string[];
  cwd: string;
  enabled: boolean;
  timeout: number;
}

function planOpencode(cwd: string, registration: McpRegistration): HostPlan {
  const jsoncPath = join(cwd, OPENCODE_JSONC);
  if (existsSync(jsoncPath)) {
    const block = JSON.stringify(
      {
        [SERVER_NAME]: {
          type: 'local',
          command: [registration.command, ...registration.args],
          cwd: '.',
          enabled: true,
          timeout: 15_000,
        } satisfies OpencodeRegistration,
      },
      null,
      2,
    );
    throw new CliError(
      `${OPENCODE_JSONC} exists — init would strip comments; paste this into the "mcp" key manually:\n${block}`,
    );
  }

  const path = join(cwd, OPENCODE_CONFIG);
  const doc = readJsonObject(path);
  const mcp = doc.mcp;
  const existing: Record<string, unknown> = isPlainObject(mcp) ? mcp : {};
  const entry: OpencodeRegistration = {
    type: 'local',
    command: [registration.command, ...registration.args],
    cwd: '.',
    enabled: true,
    timeout: 15_000,
  };
  const merged = { ...doc, mcp: { ...existing, [SERVER_NAME]: entry } };
  return {
    path,
    text: `${JSON.stringify(merged, null, 2)}\n`,
    alreadyRegistered: Object.hasOwn(existing, SERVER_NAME),
    preservedServers: Object.keys(existing).filter((name) => name !== SERVER_NAME),
  };
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`${path}: invalid JSON (${(error as Error).message}) — fix it, or move it aside`);
  }
  if (!isPlainObject(parsed)) throw new CliError(`${path}: expected a JSON object`);
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The committed half of the configuration. The remappable §7 fields are
 * scaffolded empty (they merge over `DEFAULT_TOOL_PHASE`) so the file shows the
 * extension point without freezing today's defaults into the user's project.
 * API keys are never scaffolded — §11 keeps them in the environment.
 */
function configScaffold(cwd: string): string {
  const scaffold = {
    root: DEFAULT_CONFIG.root,
    provider: DEFAULT_CONFIG.provider,
    mode: DEFAULT_CONFIG.mode,
    leafModel: DEFAULT_CONFIG.leafModel,
    rootModel: DEFAULT_CONFIG.rootModel,
    judgeModel: DEFAULT_CONFIG.judgeModel,
    embedModel: DEFAULT_CONFIG.embedModel,
    budgets: DEFAULT_CONFIG.budgets,
    summarize: DEFAULT_CONFIG.summarize,
    retrieval: DEFAULT_CONFIG.retrieval,
    costCapUsd: DEFAULT_CONFIG.costCapUsd,
    taskTitle: DEFAULT_CONFIG.taskTitle,
    toolPhase: {},
  };
  // A scaffold the loader would reject is a bug in this command, not the user's
  // problem to discover on the next run.
  resolveConfig(scaffold, cwd);
  return `${JSON.stringify(scaffold, null, 2)}\n`;
}

/**
 * §14.1 keeps the agent-facing contract in one versioned file so a learned
 * policy can replace it; that file is what the user pastes into the host system
 * prompt, so `init` prints its path rather than its content.
 */
function systemContractPath(): string | null {
  try {
    return createRequire(import.meta.url).resolve(
      `@context-tree/core/prompts/system-contract.${SYSTEM_CONTRACT_VERSION}.md`,
    );
  } catch {
    // A global install with a pruned core is possible; the rest of init still worked.
    return null;
  }
}

function humanLines(
  result: InitResult,
  target: WritableHost,
  dryRun: boolean,
  scaffoldNeeded: boolean,
): string[] {
  const verb = dryRun ? 'would write' : 'wrote';
  const lines = [
    dryRun ? `host: ${target} (dry run — nothing written)` : `host: ${target}`,
    `${verb} MCP registration "${SERVER_NAME}" -> ${result.hostConfigPath}`,
    `  command: ${result.registration.command}`,
  ];
  if (result.preservedServers.length > 0) {
    lines.push(`  preserved: ${result.preservedServers.join(', ')}`);
  }
  if (result.alreadyRegistered) {
    lines.push(`  note: already registered — a real run needs --force`);
  }
  lines.push(
    scaffoldNeeded
      ? `${verb} ${result.configPath}`
      : `kept existing ${result.configPath}`,
  );
  lines.push(
    result.systemContractPath === null
      ? 'system-prompt contract: not resolvable from this install (see @context-tree/core/src/prompts)'
      : `paste this into your host's system prompt: ${result.systemContractPath}`,
  );
  return lines;
}
