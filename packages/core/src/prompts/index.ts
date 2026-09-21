/**
 * Versioned prompt artifacts (§11: "prompt templates are versioned artifacts
 * (`src/prompts/*.md`) with fixture-based golden tests").
 *
 * The markdown is read from disk at runtime rather than inlined, so the `.md`
 * file is genuinely the versioned artifact: editing it changes behavior and
 * shows up as a reviewable diff. §14.1 is why the §9 tool contract lives in
 * exactly one file — a learned edit policy replaces that file and nothing else.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ContextTreeError, SummaryContractError } from '../contracts/index.js';
import type {
  ExternalArtifact,
  NodeId,
  PhaseType,
  SummaryMeta,
  SymbolSpan,
  TestOutcome,
} from '../contracts/index.js';

export const SYSTEM_CONTRACT_VERSION = 'v1';
export const LEAF_SUMMARY_VERSION = 'v1';
export const ROOT_SUMMARY_VERSION = 'v1';

export type PromptName = 'system-contract' | 'leaf-summary' | 'root-summary';

const PROMPT_VERSIONS: Readonly<Record<PromptName, string>> = Object.freeze({
  'system-contract': SYSTEM_CONTRACT_VERSION,
  'leaf-summary': LEAF_SUMMARY_VERSION,
  'root-summary': ROOT_SUMMARY_VERSION,
});

/**
 * The three §9 system-prompt rules as data, verbatim from
 * `system-contract.v1.md`. The eval harness (§15) asserts fetch behavior
 * against these, so a rule edited in the markdown must be edited here too —
 * the golden test in `test/prompts.test.ts` enforces that pairing.
 */
export const TOOL_CONTRACT_RULES: readonly string[] = Object.freeze([
  'Before editing any file, if its current content is not in context, call `fetch` first.',
  'Branch summaries list the files and artifacts each phase touched. If a summary mentions something you need, fetch that branch.',
  'Summaries may be stale or incomplete; when in doubt, `peek`.',
]);

const cache = new Map<PromptName, string>();

/**
 * `tsc` does not copy `.md` into `dist/`, and package.json ships `src/prompts`,
 * so a build artifact resolves the template back into the source tree.
 */
function promptPath(file: string): string {
  const beside = fileURLToPath(new URL(file, import.meta.url));
  if (existsSync(beside)) return beside;
  return fileURLToPath(new URL(`../../src/prompts/${file}`, import.meta.url));
}

/** Reads a versioned template, cached for the life of the process. */
export function loadPrompt(name: PromptName): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const text = readFileSync(promptPath(`${name}.${PROMPT_VERSIONS[name]}.md`), 'utf8');
  cache.set(name, text);
  return text;
}

const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g;

/**
 * `{{name}}` substitution. A placeholder with no value throws instead of
 * shipping: a prompt sent with `{{detail}}` still in it degrades summary
 * quality silently, and nothing downstream would ever report it.
 *
 * Substitution is single-pass, so interpolated branch detail that happens to
 * contain `{{...}}` is never rescanned as a placeholder of its own.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const unfilled: string[] = [];
  const rendered = template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      unfilled.push(key);
      return '';
    }
    return value;
  });
  if (unfilled.length > 0) {
    throw new ContextTreeError(
      `prompt template has unfilled placeholder(s): ${unfilled.join(', ')}`,
      'E_PROMPT_TEMPLATE',
    );
  }
  return rendered;
}

/**
 * Contract variants selectable independently of `SYSTEM_CONTRACT_VERSION`
 * (which names the file `loadPrompt('system-contract')` reads by default).
 * `v2` is `v1` minus the "Two ways this goes wrong" section.
 * `v4` is `v1` plus the pipeline tools (units / classify / evict / restore / reduce /
 * assemble) and when to reach for them.
 * `v1` stays the default.
 */
export const SYSTEM_CONTRACT_VERSIONS = ['v1', 'v2', 'v3', 'v4'] as const;
export type SystemContractVersion = (typeof SYSTEM_CONTRACT_VERSIONS)[number];

const systemContractCache = new Map<SystemContractVersion, string>();

function loadSystemContract(version: SystemContractVersion): string {
  const hit = systemContractCache.get(version);
  if (hit !== undefined) return hit;
  const text = readFileSync(promptPath(`system-contract.${version}.md`), 'utf8');
  systemContractCache.set(version, text);
  return text;
}

/**
 * The §9 agent-facing contract — Zone A content (D5), so it is frozen and takes
 * no interpolation. Rendered anyway so a placeholder accidentally added to the
 * markdown fails loudly rather than reaching a model.
 *
 * Defaults to `v1`; an unknown version throws rather than silently falling
 * back, since a silent fallback here is a silent epoch shift in the cached
 * Zone A prefix (D5).
 */
export function systemContract(version: SystemContractVersion = 'v1'): string {
  if (!SYSTEM_CONTRACT_VERSIONS.includes(version)) {
    throw new ContextTreeError(
      `unknown system contract version: ${String(version)} (expected one of ${SYSTEM_CONTRACT_VERSIONS.join(', ')})`,
      'E_PROMPT_TEMPLATE',
    );
  }
  return renderTemplate(loadSystemContract(version), {});
}

export interface LeafSummaryInput {
  /** The branch node's title. */
  title: string;
  phaseType: PhaseType | null;
  /** Node ids this branch covers; the model copies them into `meta.node_ids`. */
  nodeIds: readonly NodeId[];
  /** The branch's raw L0+L2 detail, already rendered to text by the summarizer. */
  detail: string;
}

export function leafSummaryPrompt(input: LeafSummaryInput): string {
  return renderTemplate(loadPrompt('leaf-summary'), {
    node_title: input.title,
    phase_type: input.phaseType ?? 'unknown',
    node_ids: input.nodeIds.join(', '),
    detail: input.detail,
  });
}

export interface ChildSummary {
  nodeId: NodeId;
  title: string;
  text: string;
  meta: SummaryMeta;
}

export interface RootSummaryInput {
  taskTitle: string;
  children: readonly ChildSummary[];
}

export function rootSummaryPrompt(input: RootSummaryInput): string {
  return renderTemplate(loadPrompt('root-summary'), {
    task_title: input.taskTitle,
    child_summaries: input.children.map(formatChildSummary).join('\n\n'),
  });
}

/** §8: the root summarizer reads leaf summaries, never raw events. */
function formatChildSummary(child: ChildSummary): string {
  return [
    `### ${child.title} (node_id: ${child.nodeId})`,
    child.text,
    'metadata:',
    JSON.stringify(child.meta, null, 2),
  ].join('\n');
}

const TEST_STATUSES: readonly string[] = ['passed', 'failed', 'skipped', 'unknown'];
const ARTIFACT_KINDS: readonly string[] = ['ticket', 'pr', 'url', 'other'];

/**
 * Parses a summarizer reply and validates it against the §8 content contract.
 *
 * Nothing is coerced or defaulted: §9's whole relevance-detection story rests on
 * these fields being present and honest, so a contract-violating summary is
 * worse than none and must surface as `SummaryContractError` naming the field.
 */
export function parseSummaryResponse(raw: string): { text: string; meta: SummaryMeta } {
  const root = requireObject(extractJsonObject(raw), 'response');
  const text = requireString(root.text, 'text');
  const meta = requireObject(root.meta, 'meta');
  return {
    text,
    meta: {
      files: requireArray(meta.files, 'meta.files').map((v, i) => parseSpan(v, `meta.files[${i}]`)),
      symbols: requireStringArray(meta.symbols, 'meta.symbols'),
      tests: requireArray(meta.tests, 'meta.tests').map((v, i) => parseTest(v, `meta.tests[${i}]`)),
      artifacts: requireArray(meta.artifacts, 'meta.artifacts').map((v, i) =>
        parseArtifact(v, `meta.artifacts[${i}]`),
      ),
      open_questions: requireStringArray(meta.open_questions, 'meta.open_questions'),
      decisions: requireStringArray(meta.decisions, 'meta.decisions'),
      node_ids: requireStringArray(meta.node_ids, 'meta.node_ids'),
    },
  };
}

const JSON_FENCE = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/;

/** Models wrap JSON in fences and prose; tolerate that, but tolerate nothing else. */
function extractJsonObject(raw: string): unknown {
  const candidates = [raw.trim()];
  const fenced = JSON_FENCE.exec(raw);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1]);
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open >= 0 && close > open) candidates.push(raw.slice(open, close + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Next shape.
    }
  }
  throw new SummaryContractError('response: no JSON object found in the model reply');
}

function fail(field: string, problem: string): never {
  throw new SummaryContractError(`${field}: ${problem}`);
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return JSON.stringify(value);
  return `${typeof value} ${String(value)}`;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) fail(field, 'missing required field');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(field, `expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (value === undefined) fail(field, 'missing required field');
  if (typeof value !== 'string') fail(field, `expected a string, got ${describe(value)}`);
  if (value.length === 0) fail(field, 'expected a non-empty string');
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireString(value, field);
}

function requireArray(value: unknown, field: string): unknown[] {
  if (value === undefined) fail(field, 'missing required field');
  if (!Array.isArray(value)) fail(field, `expected an array, got ${describe(value)}`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  return requireArray(value, field).map((item, i) => requireString(item, `${field}[${i}]`));
}

function requireInteger(value: unknown, field: string): number {
  if (value === undefined) fail(field, 'missing required field');
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(field, `expected an integer, got ${describe(value)}`);
  }
  return value;
}

/**
 * Only the four model-authorable fields of `SymbolSpan` are accepted: `kind` and
 * `degraded` describe tree-sitter's own output (§12) and a model must not invent
 * them.
 */
function parseSpan(value: unknown, field: string): SymbolSpan {
  const raw = requireObject(value, field);
  const span: SymbolSpan = {
    path: requireString(raw.path, `${field}.path`),
    start_line: requireInteger(raw.start_line, `${field}.start_line`),
    end_line: requireInteger(raw.end_line, `${field}.end_line`),
  };
  if (span.start_line < 1) fail(`${field}.start_line`, 'expected a 1-based line number');
  if (span.end_line < span.start_line) {
    fail(`${field}.end_line`, `expected >= start_line (${span.start_line}), got ${span.end_line}`);
  }
  const symbol = optionalString(raw.symbol, `${field}.symbol`);
  if (symbol !== undefined) span.symbol = symbol;
  return span;
}

function parseTest(value: unknown, field: string): TestOutcome {
  const raw = requireObject(value, field);
  const name = requireString(raw.name, `${field}.name`);
  const status = requireString(raw.status, `${field}.status`);
  if (!TEST_STATUSES.includes(status)) {
    fail(`${field}.status`, `expected one of ${TEST_STATUSES.join('|')}, got ${JSON.stringify(status)}`);
  }
  const outcome: TestOutcome = { name, status: status as TestOutcome['status'] };
  const detail = optionalString(raw.detail, `${field}.detail`);
  if (detail !== undefined) outcome.detail = detail;
  return outcome;
}

function parseArtifact(value: unknown, field: string): ExternalArtifact {
  const raw = requireObject(value, field);
  const kind = requireString(raw.kind, `${field}.kind`);
  if (!ARTIFACT_KINDS.includes(kind)) {
    fail(`${field}.kind`, `expected one of ${ARTIFACT_KINDS.join('|')}, got ${JSON.stringify(kind)}`);
  }
  const artifact: ExternalArtifact = {
    kind: kind as ExternalArtifact['kind'],
    ref: requireString(raw.ref, `${field}.ref`),
  };
  const title = optionalString(raw.title, `${field}.title`);
  if (title !== undefined) artifact.title = title;
  return artifact;
}
