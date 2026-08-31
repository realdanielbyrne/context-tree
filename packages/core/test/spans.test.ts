/**
 * §12 / D9 span extraction.
 *
 * What these tests defend: spans are the *coordinates* every rehydration
 * pointer in a summary is built from (§8 `meta_json.files`). A span that is
 * off by a line, duplicated, or silently missing sends the model to the wrong
 * place — and unlike a wrong summary, nothing downstream can detect it.
 */
import { describe, expect, it } from 'vitest';
import { LineDiffHunker, TreeSitterSpanExtractor } from '../src/spans/index.js';

/** Line numbers are asserted literally below; keep this fixture stable. */
const TS_SOURCE = [
  /*  1 */ "import { readFileSync } from 'node:fs';",
  /*  2 */ '',
  /*  3 */ 'export function priceOf(units: number): number {',
  /*  4 */ '  const base = 10;',
  /*  5 */ '  return units * base;',
  /*  6 */ '}',
  /*  7 */ '',
  /*  8 */ 'function taxOf(amount: number): number {',
  /*  9 */ '  return amount * 0.07;',
  /* 10 */ '}',
  /* 11 */ '',
  /* 12 */ 'export class Ledger {',
  /* 13 */ '  private total = 0;',
  /* 14 */ '',
  /* 15 */ '  add(amount: number): void {',
  /* 16 */ '    this.total += amount;',
  /* 17 */ '  }',
  /* 18 */ '}',
  /* 19 */ '',
  /* 20 */ 'export const RATE = 0.07;',
  '',
].join('\n');

const PY_SOURCE = [
  /* 1 */ 'import os',
  /* 2 */ '',
  /* 3 */ 'class Ledger:',
  /* 4 */ '    def __init__(self):',
  /* 5 */ '        self.total = 0',
  /* 6 */ '',
  /* 7 */ '    def add(self, amount):',
  /* 8 */ '        self.total += amount',
  /* 9 */ '        return self.total',
  '',
].join('\n');

const GO_SOURCE = [
  /* 1 */ 'package main',
  /* 2 */ '',
  /* 3 */ 'type Server struct {',
  /* 4 */ '\tPort int',
  /* 5 */ '}',
  /* 6 */ '',
  /* 7 */ 'func (s *Server) Handle(x int) int {',
  /* 8 */ '\treturn x * s.Port',
  /* 9 */ '}',
  '',
].join('\n');

/** A file mid-edit: unbalanced paren, missing brace. The §12 normal case. */
const BROKEN_TS = [
  /* 1 */ 'export function healthy(a: number): number {',
  /* 2 */ '  return a + 1;',
  /* 3 */ '}',
  /* 4 */ '',
  /* 5 */ 'export function halfWritten(b: number): number {',
  /* 6 */ '  if (b > 0 {',
  /* 7 */ '    return b',
  /* 8 */ '}',
  '',
].join('\n');

const extractor = new TreeSitterSpanExtractor();

describe('TreeSitterSpanExtractor', () => {
  it('resolves an edit inside a function body to that function, because §12 promises exact spans like pricing.go:142-168', () => {
    const result = extractor.extract({
      path: 'src/pricing.ts',
      content: TS_SOURCE,
      hunks: [{ start_line: 5, end_line: 5 }],
    });

    expect(result.spans).toEqual([
      {
        path: 'src/pricing.ts',
        start_line: 3,
        end_line: 6,
        kind: 'function_declaration',
        symbol: 'priceOf',
      },
    ]);
    expect(result.symbols).toEqual(['priceOf']);
    expect(result.degraded).toBe(false);
    expect(result.language).toBe('typescript');
    expect(result.hasParseError).toBe(false);
  });

  it('collapses two hunks inside one function into one span, because D9 pointers must be trustworthy rather than noisy', () => {
    const result = extractor.extract({
      path: 'src/pricing.ts',
      content: TS_SOURCE,
      // Line 4 is a *local* `const`: it must not become a pointer of its own,
      // or every local variable would outrank the function that holds it.
      hunks: [
        { start_line: 4, end_line: 4 },
        { start_line: 5, end_line: 5 },
      ],
    });

    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.symbol).toBe('priceOf');
  });

  it('returns one span per function for a hunk that spans two functions, because the enclosing node of the whole range names nothing', () => {
    const result = extractor.extract({
      path: 'src/pricing.ts',
      content: TS_SOURCE,
      hunks: [{ start_line: 5, end_line: 9 }],
    });

    expect(result.spans.map((s) => [s.symbol, s.start_line, s.end_line])).toEqual([
      ['priceOf', 3, 6],
      ['taxOf', 8, 10],
    ]);
  });

  it('resolves a method-body edit to the method, not the class, because minimal enclosing is what makes a span cheap to rehydrate', () => {
    const result = extractor.extract({
      path: 'src/pricing.ts',
      content: TS_SOURCE,
      hunks: [{ start_line: 16, end_line: 16 }],
    });

    expect(result.spans).toEqual([
      {
        path: 'src/pricing.ts',
        start_line: 15,
        end_line: 17,
        kind: 'method_definition',
        symbol: 'add',
      },
    ]);
  });

  it('resolves a signature-line edit to the definition itself, because `export` wraps the definition and an upward walk would miss it', () => {
    const result = extractor.extract({
      path: 'src/pricing.ts',
      content: TS_SOURCE,
      hunks: [{ start_line: 3, end_line: 3 }],
    });

    expect(result.spans[0]?.symbol).toBe('priceOf');
    expect(result.spans[0]?.degraded).toBeUndefined();
  });

  it('marks a hunk with no enclosing definition degraded instead of dropping it, because a raw range is still a true coordinate', () => {
    const result = extractor.extract({
      path: 'src/pricing.ts',
      content: TS_SOURCE,
      hunks: [{ start_line: 1, end_line: 1 }],
    });

    expect(result.spans).toEqual([
      { path: 'src/pricing.ts', start_line: 1, end_line: 1, degraded: true },
    ]);
    // The extraction itself is not degraded: a grammar *was* available (§12).
    expect(result.degraded).toBe(false);
    expect(result.symbols).toEqual([]);
  });

  it('still yields named spans for syntactically broken TypeScript, which is the entire reason §12 uses tree-sitter', () => {
    const result = extractor.extract({
      path: 'src/wip.ts',
      content: BROKEN_TS,
      hunks: [
        { start_line: 2, end_line: 2 },
        { start_line: 7, end_line: 7 },
      ],
    });

    expect(result.hasParseError).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.language).toBe('typescript');
    // The intact function above the break is still addressable by name.
    expect(result.symbols).toContain('healthy');
    // And the broken region still produces *some* coordinate.
    expect(result.spans.some((s) => s.start_line >= 5)).toBe(true);
  });

  it('resolves a python method through the python grammar, because the definition node set is per-language', () => {
    const result = extractor.extract({
      path: 'ledger.py',
      content: PY_SOURCE,
      hunks: [{ start_line: 8, end_line: 8 }],
    });

    expect(result.language).toBe('python');
    expect(result.spans).toEqual([
      {
        path: 'ledger.py',
        start_line: 7,
        end_line: 9,
        kind: 'function_definition',
        symbol: 'add',
      },
    ]);
  });

  it('resolves a go method and a go struct field through the go grammar, because go names live on child nodes', () => {
    const method = extractor.extract({
      path: 'pricing.go',
      content: GO_SOURCE,
      hunks: [{ start_line: 8, end_line: 8 }],
    });
    expect(method.language).toBe('go');
    expect(method.spans).toEqual([
      {
        path: 'pricing.go',
        start_line: 7,
        end_line: 9,
        kind: 'method_declaration',
        symbol: 'Handle',
      },
    ]);

    // `type_declaration` carries no `name` field — it hangs off `type_spec`.
    const field = extractor.extract({
      path: 'pricing.go',
      content: GO_SOURCE,
      hunks: [{ start_line: 4, end_line: 4 }],
    });
    expect(field.spans[0]?.symbol).toBe('Server');
  });

  it('degrades an unknown extension to raw hunk spans without throwing, because ingestion must never fail on an unparseable file (§12)', () => {
    const result = extractor.extract({
      path: 'notes.zzz',
      content: 'alpha\nbeta\ngamma\n',
      hunks: [{ start_line: 2, end_line: 3 }],
    });

    expect(result).toEqual({
      spans: [{ path: 'notes.zzz', start_line: 2, end_line: 3, degraded: true }],
      symbols: [],
      degraded: true,
      language: null,
      hasParseError: false,
    });
  });

  it('degrades a whole unknown file to a single 1..n span when hunks are omitted, so the coordinate is still addressable', () => {
    const result = extractor.extract({ path: 'notes.zzz', content: 'alpha\nbeta\ngamma\n' });

    expect(result.spans).toEqual([
      { path: 'notes.zzz', start_line: 1, end_line: 3, degraded: true },
    ]);
    expect(result.degraded).toBe(true);
  });

  it('degrades when a configured grammar cannot be loaded and never reports it as loaded, because grammars are optional dependencies', () => {
    const withMissingGrammar = new TreeSitterSpanExtractor({ '.ts': 'cobol' });

    const result = withMissingGrammar.extract({
      path: 'src/pricing.ts',
      content: TS_SOURCE,
      hunks: [{ start_line: 5, end_line: 5 }],
    });

    expect(result.degraded).toBe(true);
    expect(result.language).toBeNull();
    expect(result.spans[0]?.degraded).toBe(true);
    expect(withMissingGrammar.loadedLanguages()).not.toContain('cobol');
  });

  it('returns top-level definitions only when hunks are omitted, because every named node would be noise', () => {
    const result = extractor.extract({ path: 'src/pricing.ts', content: TS_SOURCE });

    expect(result.symbols).toEqual(['priceOf', 'taxOf', 'Ledger', 'RATE']);
    // `add` is a method: reachable by fetching Ledger, not a top-level symbol.
    expect(result.symbols).not.toContain('add');
    expect(result.spans.map((s) => s.kind)).toEqual([
      'function_declaration',
      'function_declaration',
      'class_declaration',
      'variable_declarator',
    ]);
  });

  it('reports the grammars it actually loaded, so callers can tell a degraded extraction from a missing grammar', () => {
    extractor.extract({ path: 'a.ts', content: TS_SOURCE, hunks: [{ start_line: 5, end_line: 5 }] });
    extractor.extract({ path: 'a.py', content: PY_SOURCE, hunks: [{ start_line: 8, end_line: 8 }] });

    const loaded = extractor.loadedLanguages();
    expect(loaded).toContain('typescript');
    expect(loaded).toContain('python');
  });

  it('is bit-identical across runs and sorted by start_line, because L1 must be a deterministic function of L0+L2 (D8)', () => {
    const request = {
      path: 'src/pricing.ts',
      content: TS_SOURCE,
      hunks: [
        { start_line: 16, end_line: 16 },
        { start_line: 5, end_line: 5 },
      ],
    };

    const first = extractor.extract(request);
    const second = extractor.extract(request);

    expect(second).toEqual(first);
    expect(first.spans.map((s) => s.start_line)).toEqual([3, 15]);
  });

  it('clamps a hunk that runs past the end of the file, because a stale hunk must not produce an unaddressable span', () => {
    const result = extractor.extract({
      path: 'notes.zzz',
      content: 'alpha\nbeta\n',
      hunks: [{ start_line: 9, end_line: 40 }],
    });

    expect(result.spans).toEqual([
      { path: 'notes.zzz', start_line: 2, end_line: 2, degraded: true },
    ]);
  });
});

describe('LineDiffHunker', () => {
  const hunker = new LineDiffHunker();

  it('treats a new file as one whole-file hunk, because nothing in it is unchanged context', () => {
    expect(hunker.hunks(null, 'a\nb\nc\n')).toEqual([{ start_line: 1, end_line: 3 }]);
  });

  it('returns no hunks for an unchanged file, so an idempotent write cannot mark a node stale', () => {
    expect(hunker.hunks('a\nb\nc\n', 'a\nb\nc\n')).toEqual([]);
  });

  it('reports an insertion at its post-edit line, because the extractor parses the post-edit blob (§12 step 1)', () => {
    expect(hunker.hunks('a\nb\nc\n', 'a\nb\nX\nc\n')).toEqual([{ start_line: 3, end_line: 3 }]);
  });

  it('reports a modification at the changed post-edit line only, not the whole file', () => {
    expect(hunker.hunks('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ start_line: 2, end_line: 2 }]);
  });

  it('attributes a deletion to the surviving line after it, because deleted text has no post-edit coordinate', () => {
    // 'b' is gone; line 2 of the new file is 'c', still inside whatever
    // definition lost the line.
    expect(hunker.hunks('a\nb\nc\n', 'a\nc\n')).toEqual([{ start_line: 2, end_line: 2 }]);
  });

  it('clamps a trailing deletion to the last surviving line, so the hunk stays inside the file', () => {
    expect(hunker.hunks('a\nb\n', 'a\n')).toEqual([{ start_line: 1, end_line: 1 }]);
  });

  it('merges contiguous changes into one hunk but keeps separated ones apart, so each hunk maps to its own definition', () => {
    expect(hunker.hunks('a\nb\nc\nd\n', 'a\nX\nY\nd\n')).toEqual([{ start_line: 2, end_line: 3 }]);
    expect(hunker.hunks('a\nb\nc\nd\ne\n', 'X\nb\nc\nd\nY\n')).toEqual([
      { start_line: 1, end_line: 1 },
      { start_line: 5, end_line: 5 },
    ]);
  });

  it('ignores a change in trailing-newline only, because a terminator is not a line', () => {
    expect(hunker.hunks('a\nb\n', 'a\nb')).toEqual([]);
  });

  it('degrades a pathological rewrite to one coarse hunk, because ingestion is budgeted in ms per event (§7.1)', () => {
    // Ends differ, so nothing trims: the LCS table would be ~6M cells. Above
    // the cell cap the whole changed middle becomes one hunk instead.
    const middle = Array.from({ length: 2_500 }, (_, i) => `same${i}`);
    const before = ['A', ...middle, 'B'].join('\n');
    const after = ['X', ...middle, 'Y'].join('\n');

    expect(hunker.hunks(before, after)).toEqual([{ start_line: 1, end_line: 2_502 }]);
    // Under the cap the same shape resolves precisely, so the cap is the cause.
    const smallBefore = ['A', ...middle.slice(0, 100), 'B'].join('\n');
    const smallAfter = ['X', ...middle.slice(0, 100), 'Y'].join('\n');
    expect(hunker.hunks(smallBefore, smallAfter)).toEqual([
      { start_line: 1, end_line: 1 },
      { start_line: 102, end_line: 102 },
    ]);
  });

  it('feeds the extractor coordinates that resolve to the edited definition, which is the only reason the two exist', () => {
    const edited = TS_SOURCE.replace('  return units * base;', '  return units * base * 2;');
    const hunks = hunker.hunks(TS_SOURCE, edited);

    expect(hunks).toEqual([{ start_line: 5, end_line: 5 }]);
    const result = extractor.extract({ path: 'src/pricing.ts', content: edited, hunks });
    expect(result.symbols).toEqual(['priceOf']);
  });
});
