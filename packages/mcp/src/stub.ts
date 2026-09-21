/**
 * A STUB — what an evicted unit still shows. The host keeps the message, its text and its
 * tool calls (the agent's own record of what it did, to what, in what order); the reasoning
 * goes, and each tool output becomes `evictedTag`. One definition, used to SIZE the residue
 * (session) and to RENDER it (decisions), so the budget and the prompt cannot disagree.
 */
import { evictedTag, hostContent, type BlobStore, type Tokenizer, type TraceEvent } from '@context-tree/core';

export interface Stub {
  readonly tokens: number;
  /** `index` counts the tool calls among `events`, in order — a host's tool-part ordinal. */
  readonly outputs: readonly { readonly index: number; readonly text: string }[];
}

export function stubOf(events: readonly TraceEvent[], blobs: BlobStore, tokenizer: Tokenizer, unitId: string): Stub {
  const calls = events.filter((e) => e.type === 'tool_call').map((e) => e.seq);
  const outputs: { index: number; text: string }[] = [];
  let tokens = 0;
  for (const event of events) {
    if (event.type === 'reasoning') continue;
    const size = hostContent(event, blobs).reduce((n, text) => n + tokenizer.count(text), 0);
    if (event.type !== 'tool_result' || event.output_blob === undefined) {
      tokens += size;
      continue;
    }
    const tag = evictedTag(blobs.getText(event.output_blob), size, unitId);
    const tagTokens = tokenizer.count(tag);
    // An output no larger than its tag stays: the tag would cost more and say less.
    if (tagTokens >= size) tokens += size;
    else {
      tokens += tagTokens;
      outputs.push({ index: calls.indexOf(event.call_seq), text: tag });
    }
  }
  return { tokens, outputs };
}
