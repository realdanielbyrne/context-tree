/**
 * The five golden branches of §16's M3 acceptance ("real summaries pass the
 * content contract on 5 golden branches"), plus the summarizer replies that
 * §17's recorded cassettes are built from.
 *
 * SYNTHETIC DATA. Every event, blob, path and identifier below was written by
 * hand for this fixture. Nothing here is derived from a real agent transcript:
 * a trace log is a verbatim record of somebody's work, and scrubbing one is
 * never provably complete.
 *
 * Node ids are fixed strings rather than the store's minted ULIDs on purpose.
 * The leaf prompt interpolates node ids (`NODE IDS:`) and the root prompt
 * interpolates the stored child metadata, so a random id would change the
 * prompt text — and `requestKey` hashes the prompt. Fixed ids are what make a
 * cassette replayable on a second machine.
 */
import { FsBlobStore, JsonlTraceLog, openInMemoryStore } from '@context-tree/core';
import type {
  AssistantMessageEvent,
  BlobRef,
  BlobStore,
  CompletionRequest,
  CompletionResult,
  NodeId,
  SummaryMeta,
  ToolCallEvent,
  ToolResultEvent,
  TraceEventInput,
  TraceLog,
  TreeStore,
  UserMessageEvent,
} from '@context-tree/core';
import { join } from 'node:path';

/** Anthropic-native ids, matching `DEFAULT_CONFIG`'s §8 role split. */
export const LEAF_MODEL = 'claude-haiku-4-5-20251001';
export const ROOT_MODEL = 'claude-sonnet-5';

export const ROOT_ID = 'n_gold_root';
const TASK_TITLE = 'Filtered note lists lose the filter after the first page';

/** The five branches, in creation order — the order Zone B would render them (§10 rule 1). */
export const BRANCH_IDS = [
  'n_gold_b1',
  'n_gold_b2',
  'n_gold_b3',
  'n_gold_b4',
  'n_gold_b5',
] as const;

type BranchId = (typeof BRANCH_IDS)[number];

const CURSOR_PATH = 'src/api/cursor.ts';
const LEGACY_PATH = 'src/api/legacy-cursor.ts';

const TS = '2026-02-11T09:00:00.000Z';

const userMessage = (blob: BlobRef): TraceEventInput<UserMessageEvent> => ({
  type: 'user_message',
  ts: TS,
  blob,
});
const assistantMessage = (blob: BlobRef): TraceEventInput<AssistantMessageEvent> => ({
  type: 'assistant_message',
  ts: TS,
  blob,
});
const toolCall = (
  tool: string,
  extra: { path?: string; blob?: BlobRef } = {},
): TraceEventInput<ToolCallEvent> => ({ type: 'tool_call', ts: TS, tool, ...extra });
const toolResult = (
  call_seq: number,
  extra: { output_blob?: BlobRef } = {},
): TraceEventInput<ToolResultEvent> => ({ type: 'tool_result', ts: TS, call_seq, ...extra });

export interface GoldenTree {
  trace: TraceLog;
  blobs: BlobStore;
  store: TreeStore;
  close(): void;
}

/**
 * L0 + L2 on disk under `dir`, L1 in memory. The mix is deliberate: leaf detail
 * is rendered from the real trace log and blob store (§6 — L1 holds coordinates,
 * not content), while the tree itself is written directly so its node ids stay
 * fixed.
 */
export function buildGoldenTree(dir: string): GoldenTree {
  const trace = new JsonlTraceLog(join(dir, 'trace.jsonl'));
  const blobs = new FsBlobStore(join(dir, 'blobs'));
  const store = openInMemoryStore();
  const put = (text: string): BlobRef => blobs.put(text);

  trace.appendAll([
    // ── b1: diagnosis, seq 1..7 ───────────────────────────────────────────
    userMessage(
      put(
        'Filtering notes by status and then paging past page 1 returns notes with other statuses. Ticket is ACME-412.',
      ),
    ),
    assistantMessage(put('Reproducing first, then reading how the cursor is built.')),
    toolCall('Read', { path: CURSOR_PATH }),
    toolResult(3, {
      output_blob: put(
        [
          'export function encodeCursor(sort: SortKey, offset: number): string {',
          '  return base64url(JSON.stringify({ sort, offset }));',
          '}',
        ].join('\n'),
      ),
    }),
    toolCall('run_tests'),
    toolResult(5, {
      output_blob: put(
        [
          'FAIL test/api/cursor.test.ts',
          '  x keeps the status filter across pages',
          '    page 2 returned notes with status=archived',
          '',
          '1 failed, 11 passed',
        ].join('\n'),
      ),
    }),
    assistantMessage(
      put(
        'Confirmed. encodeCursor serializes only the sort key and offset, so the filter set never crosses the page boundary.',
      ),
    ),

    // ── b2: implementation, seq 8..13 ─────────────────────────────────────
    assistantMessage(put('Encoding the active filter set into the cursor payload.')),
    toolCall('Edit', {
      path: CURSOR_PATH,
      blob: put(
        [
          'export function encodeCursor(sort: SortKey, offset: number, filters: FilterSet): string {',
          '  return base64url(JSON.stringify({ v: 2, sort, offset, filters }));',
          '}',
        ].join('\n'),
      ),
    }),
    toolResult(9),
    toolCall('Edit', {
      path: CURSOR_PATH,
      blob: put(
        [
          'export function decodeCursor(raw: string): Cursor {',
          '  const parsed = JSON.parse(fromBase64url(raw)) as Partial<Cursor>;',
          '  return { sort: parsed.sort, offset: parsed.offset ?? 0, filters: parsed.filters ?? {} };',
          '}',
        ].join('\n'),
      ),
    }),
    toolResult(11),
    assistantMessage(put('encodeCursor and decodeCursor now round-trip the filter map.')),

    // ── b3: verification, seq 14..17 ──────────────────────────────────────
    assistantMessage(put('Running the pagination suite.')),
    toolCall('run_tests'),
    toolResult(15, {
      output_blob: put(
        [
          'PASS  keeps the status filter across pages',
          'FAIL  rejects a cursor minted under a different filter set',
          '        expected 400, got 200',
          '',
          '1 failed, 12 passed',
        ].join('\n'),
      ),
    }),
    assistantMessage(
      put('A cursor minted under a different filter set is still accepted. Needs a guard.'),
    ),

    // ── b4: implementation, seq 18..23 ────────────────────────────────────
    assistantMessage(put('Rejecting mismatched cursors while keeping v1 cursors readable.')),
    toolCall('Edit', {
      path: CURSOR_PATH,
      blob: put(
        [
          'export function decodeCursor(raw: string, expected: FilterSet): Cursor {',
          '  const parsed = readLegacyCursor(raw) ?? parseV2(raw);',
          '  if (!sameFilters(parsed.filters, expected)) throw new BadCursorError(raw);',
          '  return parsed;',
          '}',
        ].join('\n'),
      ),
    }),
    toolResult(19),
    toolCall('Write', {
      path: LEGACY_PATH,
      blob: put(
        [
          'export function readLegacyCursor(raw: string): Cursor | null {',
          '  const parsed = tryParse(raw);',
          '  return parsed?.v === undefined ? { ...parsed, filters: {} } : null;',
          '}',
        ].join('\n'),
      ),
    }),
    toolResult(21),
    assistantMessage(put('Suite is green: 13 passed, 0 failed.')),

    // ── b5: delivery, seq 24..27 ──────────────────────────────────────────
    assistantMessage(put('Opening the pull request.')),
    toolCall('open_pr'),
    toolResult(25, { output_blob: put('https://github.com/acme/notes-api/pull/318') }),
    assistantMessage(put('PR #318 is open against ACME-412 and CI is green.')),
  ]);

  store.insertNode({
    id: ROOT_ID,
    parent_id: null,
    kind: 'task',
    title: TASK_TITLE,
    span_start_seq: 1,
    span_end_seq: 27,
  });

  const branch = (
    id: BranchId,
    title: string,
    phase: 'diagnosis' | 'implementation' | 'verification' | 'delivery',
    span: [number, number],
    tools: string[],
  ): void => {
    store.insertNode({
      id,
      parent_id: ROOT_ID,
      kind: 'phase',
      title,
      phase_type: phase,
      span_start_seq: span[0],
      span_end_seq: span[1],
      meta_json: { tools },
    });
  };

  branch('n_gold_b1', 'Reproduce the dropped status filter', 'diagnosis', [1, 7], [
    'Read',
    'run_tests',
  ]);
  branch('n_gold_b2', 'Encode the filter set into the cursor', 'implementation', [8, 13], ['Edit']);
  branch('n_gold_b3', 'Run the pagination suite', 'verification', [14, 17], ['run_tests']);
  branch('n_gold_b4', 'Reject mismatched cursors, keep v1 readable', 'implementation', [18, 23], [
    'Edit',
    'Write',
  ]);
  branch('n_gold_b5', 'Open the pull request', 'delivery', [24, 27], ['open_pr']);

  // §12/D9: spans live on file nodes and are the only spans ever stored, so the
  // fixture puts them where tree-sitter would.
  store.insertNode({
    id: 'n_gold_b2_f_cursor',
    parent_id: 'n_gold_b2',
    kind: 'file',
    title: CURSOR_PATH,
    span_start_seq: 9,
    span_end_seq: 12,
    meta_json: {
      path: CURSOR_PATH,
      symbols: ['encodeCursor', 'decodeCursor'],
      spans: [
        {
          path: CURSOR_PATH,
          start_line: 14,
          end_line: 41,
          symbol: 'encodeCursor',
          kind: 'function_declaration',
        },
        {
          path: CURSOR_PATH,
          start_line: 43,
          end_line: 78,
          symbol: 'decodeCursor',
          kind: 'function_declaration',
        },
      ],
    },
  });
  store.insertNode({
    id: 'n_gold_b4_f_cursor',
    parent_id: 'n_gold_b4',
    kind: 'file',
    title: CURSOR_PATH,
    span_start_seq: 19,
    span_end_seq: 20,
    meta_json: {
      path: CURSOR_PATH,
      symbols: ['decodeCursor'],
      spans: [
        {
          path: CURSOR_PATH,
          start_line: 43,
          end_line: 96,
          symbol: 'decodeCursor',
          kind: 'function_declaration',
        },
      ],
    },
  });
  store.insertNode({
    id: 'n_gold_b4_f_legacy',
    parent_id: 'n_gold_b4',
    kind: 'file',
    title: LEGACY_PATH,
    span_start_seq: 21,
    span_end_seq: 22,
    meta_json: {
      path: LEGACY_PATH,
      symbols: ['readLegacyCursor'],
      spans: [
        {
          path: LEGACY_PATH,
          start_line: 1,
          end_line: 34,
          symbol: 'readLegacyCursor',
          kind: 'function_declaration',
        },
      ],
    },
  });

  return {
    trace,
    blobs,
    store,
    close(): void {
      store.close();
      trace.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Hand-authored replies. These are what a §8-compliant model would return for
// the five branches above — see packages/core/test/recorded/README.md for why they are hand
// authored rather than recorded.
//
// Two constraints are not stylistic and will fail the suite if broken
// (`summarize/contract.ts`): every `meta.files[].path` must be a path the tree
// records under that branch, and `meta.node_ids` must name every child node id
// the prompt listed. A violation sends the summarizer into its retry, whose
// prompt hashes to a key no cassette holds.
// ---------------------------------------------------------------------------

function reply(text: string, meta: SummaryMeta): string {
  return `${JSON.stringify({ text, meta }, null, 2)}\n`;
}

const AUTHORED_LEAF_REPLIES: Readonly<Record<BranchId, string>> = {
  n_gold_b1: reply(
    'This phase set out to reproduce the report that a filtered note list loses its filter after page 1. Reading src/api/cursor.ts and running the pagination suite reproduced it: `keeps the status filter across pages` fails because page 2 comes back with archived notes. The cause is that encodeCursor serializes only the sort key and the offset, so the filter set never crosses the page boundary and the next request falls back to the unfiltered default. Nothing was changed here; the phase ended with the failing test as the acceptance signal for the fix.',
    {
      files: [],
      symbols: ['encodeCursor', 'decodeCursor'],
      tests: [
        {
          name: 'keeps the status filter across pages',
          status: 'failed',
          detail: 'page 2 returned notes with status=archived',
        },
      ],
      artifacts: [
        {
          kind: 'ticket',
          ref: 'ACME-412',
          title: 'Filtered note lists lose the filter after page 1',
        },
      ],
      open_questions: [
        'Are there cursors already in flight that were minted by the old encoder, and do those have to keep working?',
      ],
      decisions: [
        'Reproduce before editing: the failing pagination test is the acceptance signal for the rest of the task.',
      ],
      node_ids: ['n_gold_b1'],
    },
  ),
  n_gold_b2: reply(
    'This phase carried the active filter set inside the cursor instead of leaving it to the query string. encodeCursor now writes a versioned payload (`v: 2`) containing the sort key, the offset and the filter map, and decodeCursor reads that payload back, defaulting a missing filter map to the empty set. The edit is confined to src/api/cursor.ts. No tests were run in this phase, so the fix is unverified as it stands.',
    {
      files: [
        {
          path: 'src/api/cursor.ts',
          start_line: 14,
          end_line: 41,
          symbol: 'encodeCursor',
        },
        {
          path: 'src/api/cursor.ts',
          start_line: 43,
          end_line: 78,
          symbol: 'decodeCursor',
        },
      ],
      symbols: ['encodeCursor', 'decodeCursor'],
      tests: [],
      artifacts: [{ kind: 'ticket', ref: 'ACME-412' }],
      open_questions: [
        'decodeCursor currently treats a v1 cursor (no filter field) as an empty filter set rather than rejecting it — is silently widening the result set acceptable?',
      ],
      decisions: [
        'Filters travel inside the opaque cursor payload rather than being re-sent as query parameters, so a page request can never disagree with the cursor that produced it.',
        'The cursor payload is versioned (`v: 2`) so a later decoder can tell a v1 cursor from a corrupt one.',
      ],
      node_ids: ['n_gold_b2', 'n_gold_b2_f_cursor'],
    },
  ),
  n_gold_b3: reply(
    'This phase re-ran the pagination suite against the new cursor encoding. The original defect is fixed — `keeps the status filter across pages` now passes — but the run surfaced a second failure: `rejects a cursor minted under a different filter set` expected a 400 and got a 200, because decodeCursor reads the filters out of the cursor without comparing them to the filters the request asked for. The phase ended red, with 1 failed and 12 passed, and no files were edited.',
    {
      files: [],
      symbols: [],
      tests: [
        { name: 'keeps the status filter across pages', status: 'passed' },
        {
          name: 'rejects a cursor minted under a different filter set',
          status: 'failed',
          detail: 'expected 400, got 200 — the cursor filters are trusted without comparison',
        },
      ],
      artifacts: [],
      open_questions: [
        'Should a cursor whose filters disagree with the request be a 400, or should the cursor simply win?',
      ],
      decisions: [
        'The suite is the gate: the phase was left red rather than reporting the original defect as fixed.',
      ],
      node_ids: ['n_gold_b3'],
    },
  ),
  n_gold_b4: reply(
    'This phase closed the hole the verification run found. decodeCursor now takes the filter set the request asked for, compares it against the filters carried in the cursor, and throws BadCursorError (surfaced as a 400) when they disagree. Cursors minted before the change have no version field, so readLegacyCursor in the new src/api/legacy-cursor.ts recognizes them and returns them with an empty filter set instead of failing the comparison. The suite ended green at 13 passed, 0 failed.',
    {
      files: [
        {
          path: 'src/api/cursor.ts',
          start_line: 43,
          end_line: 96,
          symbol: 'decodeCursor',
        },
        {
          path: 'src/api/legacy-cursor.ts',
          start_line: 1,
          end_line: 34,
          symbol: 'readLegacyCursor',
        },
      ],
      symbols: ['decodeCursor', 'readLegacyCursor'],
      tests: [
        { name: 'rejects a cursor minted under a different filter set', status: 'passed' },
        { name: 'pagination suite', status: 'passed', detail: '13 passed, 0 failed' },
      ],
      artifacts: [{ kind: 'ticket', ref: 'ACME-412' }],
      open_questions: [
        'A v1 cursor is accepted with an empty filter set, which still widens the result set for an old client — how long should that grace period last?',
      ],
      decisions: [
        'A cursor whose filters disagree with the request is a 400, not a silent override: the client asked two different questions and only it can say which it meant.',
        'v1 cursors are read by a separate reader rather than by making the filter field optional in the v2 parser, so the legacy path can be deleted in one commit.',
      ],
      node_ids: ['n_gold_b4', 'n_gold_b4_f_cursor', 'n_gold_b4_f_legacy'],
    },
  ),
  n_gold_b5: reply(
    'This phase shipped the work. PR #318 was opened against ACME-412 with the cursor encoding change, the mismatch guard and the legacy reader, and CI came back green. Nothing in the working tree changed during this phase; it is the delivery record for the four phases before it.',
    {
      files: [],
      symbols: [],
      tests: [{ name: 'pagination suite (CI)', status: 'passed' }],
      artifacts: [
        {
          kind: 'ticket',
          ref: 'ACME-412',
          title: 'Filtered note lists lose the filter after page 1',
        },
        {
          kind: 'pr',
          ref: 'acme/notes-api#318',
          title: 'Carry the filter set inside the pagination cursor',
        },
        { kind: 'url', ref: 'https://github.com/acme/notes-api/pull/318' },
      ],
      open_questions: [
        'The v1-cursor grace period is open-ended; nobody has decided when readLegacyCursor gets deleted.',
      ],
      decisions: [
        'The change ships behind no flag: a cursor is opaque to clients, so the encoding can change in place.',
      ],
      node_ids: ['n_gold_b5'],
    },
  ),
};

const AUTHORED_ROOT_REPLY = reply(
  'The task was a report that filtering a note list and then paging past page 1 returned notes with other statuses (ACME-412). Diagnosis reproduced it and found the cause: the cursor carried only the sort key and the offset, so the filter set was lost at the page boundary. The fix moved the filter set inside a versioned cursor payload, and the verification run that followed caught a second, quieter bug — a cursor minted under one filter set was still accepted under another — which the fourth phase closed with an explicit mismatch check plus a reader for pre-change cursors. The suite and CI are green and PR #318 is open. What is unfinished is the legacy path: a v1 cursor is still accepted with an empty filter set, and no one has set a date for removing that.',
  {
    files: [
      {
        path: 'src/api/cursor.ts',
        start_line: 14,
        end_line: 96,
        symbol: 'encodeCursor',
      },
      {
        path: 'src/api/legacy-cursor.ts',
        start_line: 1,
        end_line: 34,
        symbol: 'readLegacyCursor',
      },
    ],
    symbols: ['encodeCursor', 'decodeCursor', 'readLegacyCursor'],
    tests: [
      { name: 'keeps the status filter across pages', status: 'passed' },
      {
        name: 'rejects a cursor minted under a different filter set',
        status: 'passed',
        detail: 'failed in the verification phase, fixed in the phase after it',
      },
      { name: 'pagination suite (CI)', status: 'passed', detail: '13 passed, 0 failed' },
    ],
    artifacts: [
      {
        kind: 'ticket',
        ref: 'ACME-412',
        title: 'Filtered note lists lose the filter after page 1',
      },
      {
        kind: 'pr',
        ref: 'acme/notes-api#318',
        title: 'Carry the filter set inside the pagination cursor',
      },
      { kind: 'url', ref: 'https://github.com/acme/notes-api/pull/318' },
    ],
    open_questions: [
      'How long do pre-change (v1) cursors stay readable, and who deletes readLegacyCursor?',
      'A v1 cursor is accepted with an empty filter set, so an old client still sees a widened result set until it refreshes.',
    ],
    decisions: [
      'Filters travel inside the opaque cursor payload rather than the query string, so a page request cannot disagree with the cursor that produced it.',
      'A cursor whose filters disagree with the request is a 400, not a silent override.',
      'The cursor payload is versioned, and v1 cursors are handled by a separate reader that can be deleted in one commit.',
    ],
    node_ids: [...BRANCH_IDS],
  },
);

/**
 * Realistic garbage, kept under a named key in each cassette so the
 * contract-violation path is exercised against something a model would
 * plausibly emit — fenced JSON with a prose preamble — rather than a toy string.
 */
export const MALFORMED_LEAF_KEY = '_malformed_leaf_missing_end_line';
export const MALFORMED_ROOT_KEY = '_malformed_root_bad_test_status';

/** `meta.files[1]` has no `end_line`: a span with one edge is not a coordinate. */
export const MALFORMED_LEAF_REPLY = `Here is the summary of that branch:

\`\`\`json
{
  "text": "This phase moved the filter set inside the cursor payload and left the decoder tolerant of older cursors.",
  "meta": {
    "files": [
      { "path": "src/api/cursor.ts", "start_line": 14, "end_line": 41, "symbol": "encodeCursor" },
      { "path": "src/api/cursor.ts", "start_line": 43, "symbol": "decodeCursor" }
    ],
    "symbols": ["encodeCursor", "decodeCursor"],
    "tests": [],
    "artifacts": [{ "kind": "ticket", "ref": "ACME-412" }],
    "open_questions": ["Do v1 cursors have to keep working?"],
    "decisions": ["Filters travel inside the cursor payload."],
    "node_ids": ["n_gold_b2", "n_gold_b2_f_cursor"]
  }
}
\`\`\`

Let me know if you want more detail on any phase.
`;

/** `meta.tests[1].status` is prose, not one of the four allowed values. */
export const MALFORMED_ROOT_REPLY = `\`\`\`json
{
  "text": "The task fixed a pagination cursor that dropped the caller's filters, then closed a second bug where a cursor from one filter set was accepted under another.",
  "meta": {
    "files": [{ "path": "src/api/cursor.ts", "start_line": 14, "end_line": 96, "symbol": "encodeCursor" }],
    "symbols": ["encodeCursor", "decodeCursor", "readLegacyCursor"],
    "tests": [
      { "name": "keeps the status filter across pages", "status": "passed" },
      { "name": "rejects a cursor minted under a different filter set", "status": "fixed after failing once" }
    ],
    "artifacts": [
      { "kind": "ticket", "ref": "ACME-412" },
      { "kind": "pr", "ref": "acme/notes-api#318" }
    ],
    "open_questions": ["When is readLegacyCursor deleted?"],
    "decisions": ["A mismatched cursor is a 400, not a silent override."],
    "node_ids": ["n_gold_b1", "n_gold_b2", "n_gold_b3", "n_gold_b4", "n_gold_b5"]
  }
}
\`\`\`
`;

/** Plausible per-role token counts; the live re-record overwrites them with real ones. */
const AUTHORED_USAGE = {
  leaf: { input: 2_140, output: 372, cacheRead: 0, cacheWrite: 0 },
  root: { input: 3_016, output: 486, cacheRead: 0, cacheWrite: 0 },
} as const;

function authoredResult(role: 'leaf' | 'root', text: string): CompletionResult {
  return {
    text,
    model: role === 'leaf' ? LEAF_MODEL : ROOT_MODEL,
    usage: { ...AUTHORED_USAGE[role] },
    toolCalls: [],
    stopReason: 'end_turn',
  };
}

/**
 * Which golden branch a summarizer request is for. The leaf template prints
 * `NODE IDS: <branch>, <children...>`; the root template has no such line, so
 * its absence identifies the root call.
 */
function branchOfRequest(request: CompletionRequest): BranchId | 'root' {
  const content = request.messages.map((message) => message.content).join('\n');
  const match = /NODE IDS: (\S+?)(?:,|\s*$)/m.exec(content);
  const id = match?.[1];
  if (id === undefined) return 'root';
  if (!(BRANCH_IDS as readonly string[]).includes(id)) {
    throw new Error(`golden fixture: unexpected branch id ${id} in a summarizer prompt`);
  }
  return id as BranchId;
}

/** Serves the hand-authored replies. Never touches the network. */
export function authoredReplyFor(request: CompletionRequest): CompletionResult {
  const branch = branchOfRequest(request);
  return branch === 'root'
    ? authoredResult('root', AUTHORED_ROOT_REPLY)
    : authoredResult('leaf', AUTHORED_LEAF_REPLIES[branch]);
}

/** The node ids the leaf prompt for `branch` lists — branch first, then its file nodes. */
export function nodeIdsOf(store: TreeStore, branch: NodeId): NodeId[] {
  return [branch, ...store.children(branch).map((child) => child.id)];
}
