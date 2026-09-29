/**
 * BLOCKS — the leaf segments, on the transcript's natural boundaries INSIDE a turn.
 *
 * A turn (one host message) is what a host can edit; a block is what a fold covers:
 *
 *   reasoning   the model's thinking before it acted
 *   text        what it said
 *   tool        one call with its result
 *
 * Block ordinals are the STUB IDS — the universal index into the transcript, a pure
 * function of L0, defined for every block whether or not it is folded. `followedByText`
 * marks a reasoning block whose own turn goes on to say something: measured on a SWE-bench
 * session, that text is a median 4.4% of the reasoning it follows — the model's own summary
 * of its thinking, which is why such a block folds to nothing while the text stays.
 *
 * Ledger and boundary events belong to no block: they are about the transcript, not in it.
 */
import type { BlobStore, Seq, Tokenizer, TraceEvent } from '../contracts/index.js';
import { hostContent } from '../assemble/format.js';
import { deriveTurns, type Turn } from './turns.js';

export type BlockKind = 'reasoning' | 'text' | 'tool';

export interface Block {
  /** 1-based ordinal across the transcript: the stub id. */
  readonly stub: number;
  readonly kind: BlockKind;
  readonly fromSeq: Seq;
  readonly toSeq: Seq;
  readonly turn: Turn;
  /** Tokens the host sends for it (`hostContent`), raw. */
  readonly tokens: number;
  /** A reasoning block whose turn then says something in a text block. */
  readonly followedByText: boolean;
}

export function blocksOf(events: readonly TraceEvent[], blobs: BlobStore, tokenizer: Tokenizer): Block[] {
  const blocks: Block[] = [];
  const size = (slice: readonly TraceEvent[]): number => slice.flatMap((e) => hostContent(e, blobs)).reduce((n, t) => n + tokenizer.count(t), 0);
  const first = events[0];
  if (first === undefined) return blocks;
  const at = (seq: Seq): TraceEvent | undefined => events[seq - first.seq];
  for (const turn of deriveTurns(events)) {
    const drafts: { kind: BlockKind; fromSeq: Seq; toSeq: Seq }[] = [];
    for (let seq = turn.startSeq; seq <= turn.endSeq; seq += 1) {
      const event = at(seq);
      if (event === undefined) continue;
      switch (event.type) {
        case 'reasoning':
          drafts.push({ kind: 'reasoning', fromSeq: seq, toSeq: seq });
          break;
        case 'user_message':
        case 'assistant_message':
          drafts.push({ kind: 'text', fromSeq: seq, toSeq: seq });
          break;
        case 'tool_call':
          drafts.push({ kind: 'tool', fromSeq: seq, toSeq: seq });
          break;
        case 'tool_result': {
          // A result joins its call; an orphan result (call outside this turn) is its own block.
          const owner = drafts.find((d) => d.kind === 'tool' && d.fromSeq === event.call_seq);
          if (owner !== undefined && owner.toSeq === owner.fromSeq) owner.toSeq = seq;
          else drafts.push({ kind: 'tool', fromSeq: seq, toSeq: seq });
          break;
        }
        case 'segment_boundary':
        case 'manual_annotation':
        case 'fold':
        case 'unfold':
          break;
      }
    }
    drafts.forEach((draft, i) => {
      const slice = events.slice(draft.fromSeq - first.seq, draft.toSeq - first.seq + 1);
      blocks.push({
        stub: blocks.length + 1,
        kind: draft.kind,
        fromSeq: draft.fromSeq,
        toSeq: draft.toSeq,
        turn,
        tokens: size(slice),
        followedByText: draft.kind === 'reasoning' && drafts.slice(i + 1).some((d) => d.kind === 'text'),
      });
    });
  }
  return blocks;
}
