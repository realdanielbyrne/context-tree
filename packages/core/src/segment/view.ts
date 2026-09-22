/**
 * THE FOLD VIEW — what the prompt shows of each block, given the ledger.
 *
 * A block is `raw`, a `stub` (its own shorter form), the `carrier` of a summary (the first
 * text block in the summary's range — else its first reasoning block, else its first block —
 * now holds the summary's text), or `covered` (inside a shown summary's range, hidden). Precedence:
 * summary over stub over raw. Two overlapping summaries both show, each through its own
 * carrier, and a block covered by either is hidden. Sizes come from here, so every later
 * stage budgets on the folded size and the budget and the prompt cannot disagree.
 */
import type { Block } from './blocks.js';
import type { Fold } from './ledger.js';
import type { StubPart } from './stubs.js';

export interface StubBlob {
  readonly parts: readonly StubPart[];
  readonly tokens: number;
}

export type BlockState =
  | { readonly kind: 'raw'; readonly tokens: number }
  | { readonly kind: 'stub'; readonly fold: string; readonly parts: readonly StubPart[]; readonly tokens: number }
  | { readonly kind: 'carrier'; readonly fold: string; readonly text: string; readonly tokens: number }
  | { readonly kind: 'covered'; readonly fold: string; readonly tokens: 0 };

export interface FoldTexts {
  /** A stub fold's blob, parsed. */
  stub(fold: Fold): StubBlob;
  /** A summary fold as the prompt shows it, and its size. */
  summary(fold: Fold): { text: string; tokens: number };
}

export function foldView(blocks: readonly Block[], folds: readonly Fold[], texts: FoldTexts): Map<number, BlockState> {
  const view = new Map<number, BlockState>(blocks.map((b) => [b.stub, { kind: 'raw', tokens: b.tokens }]));
  const byStart = new Map(blocks.map((b) => [b.fromSeq, b]));
  for (const fold of folds) {
    if (fold.kind !== 'stub') continue;
    const block = byStart.get(fold.fromSeq);
    if (block === undefined) continue;
    const { parts, tokens } = texts.stub(fold);
    view.set(block.stub, { kind: 'stub', fold: fold.id, parts, tokens });
  }
  const carriers = new Set<number>();
  for (const fold of folds) {
    if (fold.kind !== 'summary') continue;
    const inside = blocks.filter((b) => b.fromSeq >= fold.fromSeq && b.toSeq <= fold.toSeq);
    if (inside.length === 0) continue;
    const free = inside.filter((b) => !carriers.has(b.stub));
    // The first text block, else the first reasoning block, else the first block of any kind (a run
    // of tool calls: the summary rides in the first output). A summary always shows somewhere.
    const pick = (bs: readonly Block[]): Block | undefined => bs.find((b) => b.kind === 'text') ?? bs.find((b) => b.kind === 'reasoning') ?? bs[0];
    const carrier = pick(free) ?? pick(inside);
    const { text, tokens } = texts.summary(fold);
    for (const b of inside) {
      if (b === carrier) {
        carriers.add(b.stub);
        view.set(b.stub, { kind: 'carrier', fold: fold.id, text, tokens });
      } else if (!carriers.has(b.stub)) {
        view.set(b.stub, { kind: 'covered', fold: fold.id, tokens: 0 });
      }
    }
  }
  return view;
}

export const shownTokens = (view: ReadonlyMap<number, BlockState>): number => [...view.values()].reduce((n, s) => n + s.tokens, 0);
