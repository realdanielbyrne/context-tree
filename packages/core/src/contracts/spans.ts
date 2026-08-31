/**
 * §12 tree-sitter ingestion — span extraction only, never storage (D9).
 * Synchronous: the native bindings are, and this runs inline during ingestion.
 */
import type { SymbolSpan } from './tree.js';

/** A changed line range, 1-based inclusive. */
export interface DiffHunk {
  start_line: number;
  end_line: number;
}

export interface SpanRequest {
  path: string;
  /** Post-edit file content — the blob the `tool_call` event points at. */
  content: string;
  /**
   * Changed ranges. Omitted => the whole file is treated as changed, and the
   * extractor returns every top-level named symbol.
   */
  hunks?: readonly DiffHunk[];
}

export interface SpanExtraction {
  /** Minimal enclosing named nodes for each hunk, deduped and sorted. */
  spans: SymbolSpan[];
  symbols: string[];
  /**
   * True when no grammar was available and spans are raw diff-hunk line ranges
   * (§12's documented degradation).
   */
  degraded: boolean;
  /** Resolved grammar id (`typescript`, `python`, …) or null when degraded. */
  language: string | null;
  /** True when the parse produced ERROR nodes — expected for WIP files. */
  hasParseError: boolean;
}

export interface SpanExtractor {
  extract(request: SpanRequest): SpanExtraction;
  /** Grammar ids that loaded successfully in this process. */
  loadedLanguages(): string[];
}

/** Computes changed line ranges between two revisions of a file. */
export interface DiffHunker {
  hunks(before: string | null, after: string): DiffHunk[];
}
