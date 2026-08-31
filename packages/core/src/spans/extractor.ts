/**
 * §12 — tree-sitter span extraction. Span extraction ONLY: this module never
 * writes to L1 and answers no queries (D9 — "parsers aren't databases"). It
 * turns a post-edit blob plus diff hunks into exact `path:start-end` symbol
 * coordinates, which is what makes rehydration pointers trustworthy.
 *
 * Two degradations are load-bearing, not fallbacks-of-last-resort:
 *  - no grammar for the extension  -> raw diff-hunk line spans, `degraded`
 *  - grammar parses but with ERROR nodes -> spans still emitted, `hasParseError`
 * WIP files with syntax errors are the normal case during an agent's
 * implementation phase; refusing to emit spans for them would defeat §12.
 */
import { extname } from 'node:path';
import Parser from 'tree-sitter';
import type { DiffHunk, SpanExtraction, SpanExtractor, SpanRequest, SymbolSpan } from '../contracts/index.js';
import { DEFAULT_LANGUAGES } from '../config.js';
import { definitionTypes, loadGrammar, loadedGrammars } from './grammars.js';
import { lineCount } from './lines.js';

export class TreeSitterSpanExtractor implements SpanExtractor {
  private readonly languages: Record<string, string>;
  /** One parser, re-pointed at each grammar: construction is the costly part. */
  private parser: Parser | null = null;

  constructor(languages: Record<string, string> = DEFAULT_LANGUAGES) {
    this.languages = languages;
  }

  extract(request: SpanRequest): SpanExtraction {
    const grammarId = this.grammarId(request.path);
    const language = grammarId === null ? null : loadGrammar(grammarId);
    if (grammarId === null || language === null) return rawExtraction(request);

    let tree: Parser.Tree;
    try {
      const parser = (this.parser ??= new Parser());
      parser.setLanguage(language);
      tree = parser.parse(request.content);
    } catch {
      // A grammar that loads but cannot parse is indistinguishable, from
      // ingestion's point of view, from a grammar that never loaded.
      return rawExtraction(request);
    }

    const defs = definitionTypes(grammarId);
    const max = lineCount(request.content);
    const spans = new Map<string, SymbolSpan>();

    if (request.hunks === undefined) {
      // Whole file changed: outermost definitions only. Every named node would
      // be noise, and every nested method would drown the file's shape.
      for (const node of topLevelDefinitions(tree.rootNode, defs)) {
        put(spans, spanOfNode(request.path, node));
      }
    } else {
      for (const hunk of request.hunks) {
        const resolved = hunkSpans(tree.rootNode, hunk, max, defs, request.path);
        // No enclosing definition anywhere in the hunk — usual inside an ERROR
        // subtree, or for edits to imports. The raw range is still a true
        // coordinate, so mark it degraded rather than dropping it.
        if (resolved.length === 0) put(spans, rawSpan(request.path, hunk, max));
        for (const span of resolved) put(spans, span);
      }
    }

    const sorted = sortSpans([...spans.values()]);
    return {
      spans: sorted,
      symbols: uniqueSymbols(sorted),
      degraded: false,
      language: grammarId,
      hasParseError: tree.rootNode.hasError,
    };
  }

  loadedLanguages(): string[] {
    return loadedGrammars();
  }

  private grammarId(path: string): string | null {
    return this.languages[extname(path).toLowerCase()] ?? null;
  }
}

/** §12: "fall back to diff-hunk line spans (degraded but functional)". */
function rawExtraction(request: SpanRequest): SpanExtraction {
  const max = lineCount(request.content);
  const hunks = request.hunks ?? [{ start_line: 1, end_line: max }];
  const spans = new Map<string, SymbolSpan>();
  for (const hunk of hunks) put(spans, rawSpan(request.path, hunk, max));
  return {
    spans: sortSpans([...spans.values()]),
    symbols: [],
    degraded: true,
    language: null,
    hasParseError: false,
  };
}

/**
 * Minimal enclosing definition per *line* of the hunk, not per hunk: a hunk
 * spanning two functions must yield both, and the smallest node containing
 * such a range is the file root, which names nothing.
 */
function hunkSpans(
  root: Parser.SyntaxNode,
  hunk: DiffHunk,
  max: number,
  defs: ReadonlySet<string>,
  path: string,
): SymbolSpan[] {
  const first = clampLine(hunk.start_line, max);
  const last = clampLine(hunk.end_line, max);
  const out: SymbolSpan[] = [];
  const seen = new Set<number>();
  for (let line = first; line <= last; line++) {
    const node = enclosingDefinition(root, line, defs);
    if (node === null || seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(spanOfNode(path, node));
  }
  return out;
}

/**
 * Deepest definition node whose row range covers `line`.
 *
 * Descending beats walking up from `descendantForPosition`: the smallest node
 * containing `export function foo(` is the `export_statement`, and a definition
 * is that node's *child*, so an upward walk from a signature line finds
 * nothing. Descending also survives ERROR subtrees, which is the §12 point —
 * an ERROR node is not definition-shaped, so the walk keeps going through it.
 */
function enclosingDefinition(
  root: Parser.SyntaxNode,
  line: number,
  defs: ReadonlySet<string>,
): Parser.SyntaxNode | null {
  const row = line - 1;
  let best: Parser.SyntaxNode | null = null;
  let node = root;
  for (;;) {
    // First covering child wins when a row is shared by siblings (`} else {`):
    // arbitrary but total, and determinism is what D8 requires of it.
    const next = node.namedChildren.find(
      (child) => child.startPosition.row <= row && row <= child.endPosition.row,
    );
    if (next === undefined) return best;
    if (isDefinition(next, defs)) best = next;
    node = next;
  }
}

/** Outermost definitions: descend through wrappers, stop at the first definition. */
function topLevelDefinitions(root: Parser.SyntaxNode, defs: ReadonlySet<string>): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    for (const child of node.namedChildren) {
      if (isDefinition(child, defs)) out.push(child);
      else visit(child);
    }
  };
  visit(root);
  return out;
}

function isDefinition(node: Parser.SyntaxNode, defs: ReadonlySet<string>): boolean {
  if (!node.isNamed || !defs.has(node.type)) return false;
  // A local `const y = 2` is a worse pointer than the function that contains
  // it, so only module-level declarators count. `export const X = …` does.
  if (node.type === 'variable_declarator') return isModuleLevel(node);
  return true;
}

function isModuleLevel(node: Parser.SyntaxNode): boolean {
  const declaration = node.parent;
  const outer = declaration === null ? null : declaration.parent;
  const top = outer !== null && outer.type === 'export_statement' ? outer.parent : outer;
  return top !== null && top.type === 'program';
}

/**
 * The symbol name. One level of descent covers the wrapper nodes that carry no
 * `name` field themselves: go `type_declaration` -> `type_spec`, python
 * `decorated_definition` -> `function_definition`.
 */
function symbolName(node: Parser.SyntaxNode): string | undefined {
  const direct = node.childForFieldName('name');
  if (direct !== null) return direct.text;
  for (const child of node.namedChildren) {
    const nested = child.childForFieldName('name');
    if (nested !== null) return nested.text;
  }
  return undefined;
}

function spanOfNode(path: string, node: Parser.SyntaxNode): SymbolSpan {
  const span: SymbolSpan = {
    path,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    kind: node.type,
  };
  const symbol = symbolName(node);
  if (symbol !== undefined) span.symbol = symbol;
  return span;
}

function rawSpan(path: string, hunk: DiffHunk, max: number): SymbolSpan {
  return {
    path,
    start_line: clampLine(hunk.start_line, max),
    end_line: clampLine(hunk.end_line, max),
    degraded: true,
  };
}

function clampLine(line: number, max: number): number {
  if (!Number.isFinite(line)) return 1;
  return Math.min(Math.max(Math.trunc(line), 1), Math.max(max, 1));
}

function spanKey(span: SymbolSpan): string {
  return `${span.start_line}:${span.end_line}:${span.kind ?? ''}:${span.symbol ?? ''}`;
}

/** Two hunks inside one function must collapse to one span (D9: trustworthy, not noisy). */
function put(spans: Map<string, SymbolSpan>, span: SymbolSpan): void {
  const key = spanKey(span);
  if (!spans.has(key)) spans.set(key, span);
}

/** Total order, so a rebuild of the same L0+L2 yields byte-identical spans (D8). */
function sortSpans(spans: SymbolSpan[]): SymbolSpan[] {
  return spans.sort(
    (a, b) =>
      a.start_line - b.start_line ||
      a.end_line - b.end_line ||
      (a.kind ?? '').localeCompare(b.kind ?? '') ||
      (a.symbol ?? '').localeCompare(b.symbol ?? ''),
  );
}

function uniqueSymbols(spans: readonly SymbolSpan[]): string[] {
  const out: string[] = [];
  for (const span of spans) {
    if (span.symbol !== undefined && !out.includes(span.symbol)) out.push(span.symbol);
  }
  return out;
}
