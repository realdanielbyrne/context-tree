/**
 * §12 step 1 — lazy grammar loading, plus the per-grammar set of
 * "definition-shaped" node types the enclosing walk is allowed to stop at.
 *
 * Loading is lazy and cached process-wide: the native grammars are the
 * expensive part of ingestion, and §7.1 (reason 2) budgets ingestion in ms per
 * event, so a grammar is dlopen'd at most once and only if a file needs it.
 * Failures are cached too — a missing optional grammar must degrade on every
 * subsequent event without re-paying the failed resolve.
 */
import { createRequire } from 'node:module';
import type Parser from 'tree-sitter';

/** Grammar id -> [module specifier, export key]. `null` key = module is the Language. */
const GRAMMAR_MODULES: Readonly<Record<string, readonly [string, string | null]>> = Object.freeze({
  typescript: ['tree-sitter-typescript', 'typescript'],
  tsx: ['tree-sitter-typescript', 'tsx'],
  javascript: ['tree-sitter-javascript', null],
  python: ['tree-sitter-python', null],
  go: ['tree-sitter-go', null],
});

/**
 * Node types that make a useful rehydration pointer (D9). Deliberately a small
 * per-grammar allow-list: stopping the walk at any named node would return
 * `binary_expression`, which points at nothing a reader can act on.
 */
const TS_DEFINITIONS: ReadonlySet<string> = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'class_declaration',
  'abstract_class_declaration',
  'method_definition',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'variable_declarator',
]);

const PY_DEFINITIONS: ReadonlySet<string> = new Set([
  'function_definition',
  'class_definition',
  'decorated_definition',
]);

const GO_DEFINITIONS: ReadonlySet<string> = new Set([
  'function_declaration',
  'method_declaration',
  'type_declaration',
  'type_spec',
  'const_declaration',
  'const_spec',
  'var_declaration',
  'var_spec',
]);

const DEFINITION_TYPES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  typescript: TS_DEFINITIONS,
  tsx: TS_DEFINITIONS,
  javascript: TS_DEFINITIONS,
  python: PY_DEFINITIONS,
  go: GO_DEFINITIONS,
});

/** `null` marks a load that already failed, so it is never retried. */
const cache = new Map<string, Parser.Language | null>();

const require_ = createRequire(import.meta.url);

/** Loads a grammar by id, or returns null when it is unavailable (§12 degradation). */
export function loadGrammar(id: string): Parser.Language | null {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const entry = GRAMMAR_MODULES[id];
  let language: Parser.Language | null = null;
  if (entry) {
    const [specifier, exportKey] = entry;
    // Grammars are optionalDependencies: an uninstalled or ABI-mismatched
    // native module must degrade the extraction, never throw into ingestion.
    try {
      const mod: unknown = require_(specifier);
      const candidate = exportKey === null ? mod : (mod as Record<string, unknown>)[exportKey];
      language = isLanguage(candidate) ? candidate : null;
    } catch {
      language = null;
    }
  }
  cache.set(id, language);
  return language;
}

/** Grammar ids that loaded successfully in this process. */
export function loadedGrammars(): string[] {
  return [...cache.entries()].filter(([, lang]) => lang !== null).map(([id]) => id).sort();
}

/** Definition-shaped node types for a grammar id, empty when the id is unknown. */
export function definitionTypes(id: string): ReadonlySet<string> {
  return DEFINITION_TYPES[id] ?? new Set<string>();
}

function isLanguage(value: unknown): value is Parser.Language {
  return typeof value === 'object' && value !== null && 'nodeTypeInfo' in value;
}
