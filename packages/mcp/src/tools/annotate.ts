/**
 * §9's write-side tool and the v1 seed of A-MEM-style memory evolution (D3,
 * D10): a review-phase discovery can mark an implementation branch
 * `superseded_by` a later one, and that conclusion outlives the transcript.
 *
 * It writes in BOTH modes. The read tools are mode-gated because Mode A must
 * not perturb the host's trace (ruling C9); `annotate` is an explicit write, so
 * its L0 record is not a side effect anyone needs protecting from.
 *
 * It writes L0 and nothing else. The annotation's identity IS its L0 seq
 * (`Annotation.seq`), and ingestion replays every `manual_annotation` into the
 * note list and `node_links` because L1 is derived from L0 + L2 (D8) — so this
 * tool appends the event and then *reports* what the store holds. Writing L1
 * here as well made two writers for one event, which stored every note twice.
 */
import { z } from 'zod';
import type { LinkKind, NodeId, TreeNode } from '@context-tree/core';
import { fail, failFrom, ok, parseArgs, requireNode } from '../result.js';
import { recordAnnotation } from '../observe.js';
import type { ToolContext, ToolOutcome } from '../types.js';

export const ANNOTATE = 'annotate';

const LINK_KINDS = ['superseded_by', 'relates_to', 'blocks'] as const satisfies readonly LinkKind[];

/** An edge with no kind is a "these are related" edge; §9 lists it as the neutral one. */
const DEFAULT_LINK_KIND: LinkKind = 'relates_to';

export const ANNOTATE_DESCRIPTION =
  'Record a note on a node, and/or link two nodes (superseded_by, relates_to, blocks). ' +
  'Reach for it the moment you conclude that an earlier branch is wrong, obsolete or replaced by ' +
  'what you just did — and for anything you fetched that matters beyond this phase. This is the ' +
  'only way a conclusion survives: prose in the transcript is dropped at the next phase boundary.';

const shape = {
  node_id: z.string().min(1).describe('Node the note is about.'),
  text: z.string().min(1).describe('The note, in your own words. Stored on the node and in the task log.'),
  link_to: z.string().min(1).optional().describe('Node id to link node_id to.'),
  link_kind: z
    .enum(LINK_KINDS)
    .optional()
    .describe(`Edge kind; defaults to ${DEFAULT_LINK_KIND} when link_to is given. Requires link_to.`),
};

export const annotateSchema = z.object(shape);
export const annotateInputShape = shape;

export interface ContextLinkPayload {
  from_id: NodeId;
  to_id: NodeId;
  kind: LinkKind;
}

export interface AnnotateData {
  node_id: NodeId;
  /** L0 seq of the `manual_annotation` event — the annotation's identity. */
  seq: number;
  created_at: string;
  /** Notes now on the node, including this one. */
  annotations: number;
  link: ContextLinkPayload | null;
}

export async function annotate(ctx: ToolContext, input: unknown): Promise<ToolOutcome<AnnotateData>> {
  const parsed = parseArgs(annotateSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;

  const subject = requireNode(ctx, 'node_id', args.node_id);
  if (!subject.ok) return subject;

  if (args.link_to === undefined && args.link_kind !== undefined) {
    return fail(
      'invalid_input',
      'link_kind was given without link_to. Pass link_to to create an edge, or drop link_kind to record a note only.',
    );
  }

  let target: TreeNode | null = null;
  if (args.link_to !== undefined) {
    if (args.link_to === args.node_id) {
      return fail('invalid_input', `link_to equals node_id (${args.node_id}); a node cannot link to itself.`);
    }
    const found = requireNode(ctx, 'link_to', args.link_to);
    if (!found.ok) return found;
    target = found.data;
  }

  const linkKind = target === null ? undefined : (args.link_kind ?? DEFAULT_LINK_KIND);
  const ts = new Date().toISOString();

  try {
    const event = recordAnnotation(ctx, {
      ts,
      nodeId: args.node_id,
      text: args.text,
      linkTo: target?.id,
      linkKind,
    });

    // `recordAnnotation` re-ingested, and ingestion is the single writer of L1
    // from an L0 event (D8): it has already appended this note to
    // `meta_json.annotations` and upserted the edge into `node_links`. So read
    // the result back rather than composing it — a second writer here is what
    // duplicated every note.
    const annotations = ctx.handle.store.getNode(args.node_id)?.meta_json.annotations ?? [];

    return ok({
      node_id: args.node_id,
      seq: event.seq,
      created_at: ts,
      annotations: annotations.length,
      link:
        target === null || linkKind === undefined
          ? null
          : { from_id: args.node_id, to_id: target.id, kind: linkKind },
    });
  } catch (error) {
    return failFrom(error);
  }
}
