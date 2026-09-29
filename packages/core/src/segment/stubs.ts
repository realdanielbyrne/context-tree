/**
 * STUB TEXT — what a folded block shows. Summary-free: made from the block itself, no model.
 *
 *   tool        the call keeps its input; the output becomes a tag naming its size, how it
 *               began, and the one call that returns it
 *   reasoning   followed by the model's own text: NOTHING (that text is its summary and stays
 *               as its own block); otherwise its TAIL under a tag — the conclusion sits at the
 *               end of a thinking block, the deliberation at the start (`foldReasoning`)
 *   text        its first line
 *
 * Every tag describes and never instructs: a reference that names its content beat a
 * length-matched placebo (T12b); "stop re-reading" nudges were ignored 33 of 33 times.
 * The text is written to the ledger once and never changes (D5).
 */
import type { BlobStore, Tokenizer, TraceEvent } from '../contracts/index.js';
import { safeCut } from '../assemble/format.js';
import type { Block } from './blocks.js';

export type FoldReasoning = 'keep' | 'tail' | 'drop';

export interface StubParams {
  readonly foldReasoning: FoldReasoning;
  /** Tokens of a reasoning block's end kept under its tag. */
  readonly foldReasoningTail: number;
}

const FIRST_LINE_CHARS = 100;

const firstLine = (text: string): string => {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return line.length > FIRST_LINE_CHARS ? `${line.slice(0, safeCut(line, FIRST_LINE_CHARS))}…` : line;
};

const recall = (stub: number): string => `recall: fetch {"stub":${String(stub)}}`;

export const outputTag = (output: string, tokens: number, stub: number): string =>
  `[folded · ${String(tokens)} tokens · began: ${JSON.stringify(firstLine(output))} · ${recall(stub)}]`;

export const thinkingTag = (tokens: number, stub: number): string => `[folded thinking · ${String(tokens)} tokens · ${recall(stub)}]`;

/** The last `tokens` heuristic tokens of `text`, cut on a line. */
export function tailOf(text: string, tokens: number, tokenizer: Tokenizer): string {
  if (tokens <= 0 || tokenizer.count(text) <= tokens) return tokens <= 0 ? '' : text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = tokenizer.count(lines[i]!) + 1;
    if (used + cost > tokens && kept.length > 0) break;
    kept.unshift(lines[i]!);
    used += cost;
  }
  return kept.join('\n');
}

/** One part of a folded block, as a host applies it: which part, and what it becomes. `null` text = removed. */
export interface StubPart {
  readonly part: 'reasoning' | 'text' | 'output';
  readonly text: string | null;
}

export interface Stub {
  readonly parts: readonly StubPart[];
  /** Tokens the host sends for the folded block. */
  readonly tokens: number;
}

export function stubOf(block: Block, events: readonly TraceEvent[], blobs: BlobStore, tokenizer: Tokenizer, params: StubParams): Stub {
  const first = events[0]!;
  const slice = events.slice(block.fromSeq - first.seq, block.toSeq - first.seq + 1);
  switch (block.kind) {
    case 'tool': {
      const call = slice.find((e) => e.type === 'tool_call');
      const result = slice.find((e) => e.type === 'tool_result');
      const input = call?.type === 'tool_call' && call.args_blob !== undefined ? tokenizer.count(blobs.getText(call.args_blob)) : 0;
      if (result?.type !== 'tool_result' || result.output_blob === undefined) return { parts: [], tokens: block.tokens };
      const output = blobs.getText(result.output_blob);
      const outputTokens = tokenizer.count(output);
      const tag = outputTag(output, outputTokens, block.stub);
      const tagTokens = tokenizer.count(tag);
      // An output no larger than its tag stays: the tag would cost more and say less.
      if (tagTokens >= outputTokens) return { parts: [], tokens: block.tokens };
      return { parts: [{ part: 'output', text: tag }], tokens: input + tagTokens };
    }
    case 'reasoning': {
      if (params.foldReasoning === 'keep') return { parts: [], tokens: block.tokens };
      if (block.followedByText || params.foldReasoning === 'drop') return { parts: [{ part: 'reasoning', text: null }], tokens: 0 };
      const event = slice[0];
      const text = event?.type === 'reasoning' ? blobs.getText(event.blob) : '';
      const tail = tailOf(text, params.foldReasoningTail, tokenizer);
      const shown = `${thinkingTag(block.tokens, block.stub)}\n${tail}`;
      const shownTokens = tokenizer.count(shown);
      if (shownTokens >= block.tokens) return { parts: [], tokens: block.tokens };
      return { parts: [{ part: 'reasoning', text: shown }], tokens: shownTokens };
    }
    case 'text': {
      const event = slice[0];
      const text = event !== undefined && (event.type === 'user_message' || event.type === 'assistant_message') ? blobs.getText(event.blob) : '';
      const line = firstLine(text);
      const lineTokens = tokenizer.count(line);
      if (lineTokens >= block.tokens) return { parts: [], tokens: block.tokens };
      return { parts: [{ part: 'text', text: line }], tokens: lineTokens };
    }
  }
}
