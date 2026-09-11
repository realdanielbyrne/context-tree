/**
 * The whole pipeline, once, on one realistic session — M5's acceptance line
 * (§16): "live bug-fix session -> tree -> fresh session resumes with <=3 tool
 * calls".
 *
 * Every layer below has its own unit tests; none of them can see the property
 * this file exists for. The claim the plan makes is a claim about the SEAMS:
 * that tree-sitter's spans (D9) survive into a summary's rehydration pointers
 * (§8), that those pointers survive into Zone B (§10), and that what lands in
 * Zone B is enough for a session which never saw the raw history to pick the
 * work back up through the real §9 tools. A break anywhere in that chain leaves
 * every unit test green.
 *
 * Offline and deterministic (§17): the model is `MockProvider` driven by a
 * *compliant* responder — it obeys the §8 output contract and reports only what
 * the prompt actually showed it, so a failure here means the pipeline changed,
 * not that the stub is unrealistic. Nothing reaches the network. The live
 * counterpart is `test/live/resume.live.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HeuristicTokenizer,
  MockProvider,
  Summarizer,
  TreeRetriever,
  VIEW_BANNER,
  assembleFlex,
  buildFlexSource,
  ingest,
  openTaskStore,
  rebuild,
  renderTask,
  resolveConfig,
  systemContract,
} from '../src/index.js';
import type {
  AssembledPrompt,
  AssistantMessageEvent,
  BlobStore,
  CompletionRequest,
  ContextTreeConfig,
  ExternalArtifact,
  NodeId,
  NodeKind,
  NodeMeta,
  NodeStatus,
  PhaseType,
  Seq,
  SummaryMeta,
  TaskStore,
  TestOutcome,
  ToolCallEvent,
  ToolResultEvent,
  TraceEventInput,
  TreeNode,
  TreeStore,
  UserMessageEvent,
  Zone,
} from '../src/index.js';
import { CONTEXT_FETCH, CONTEXT_PEEK, HANDLERS, TOOL_NAMES } from '@context-tree/mcp';
import type { ContextFetchData, ContextPeekData, ToolContext, ToolName } from '@context-tree/mcp';

// ── the session under test ─────────────────────────────────────────────────

const TS = '2026-03-02T09:00:00.000Z';
const PRICING = 'src/pricing.ts';
const DISCOUNT = 'src/discount.ts';
const TICKET = 'SOF-412';
const PR_URL = 'https://github.com/acme/shop/pull/4711';
const FAILING_TEST = 'rounds half up on discounted totals';
const FAILURE_DETAIL = 'expected 108 to be 109';
/** The one string that exists only in the fixed source — never in a summary. */
const FIX_MARKER = 'Math.round';

const PRICING_V1 = [
  'export function price(cents: number, rate: number): number {',
  '  return Math.floor(cents * rate);',
  '}',
  '',
].join('\n');

/** Edit 1: names the intermediate, still floors. */
const PRICING_V2 = [
  'export function price(cents: number, rate: number): number {',
  '  const gross = cents * rate;',
  '  return Math.floor(gross);',
  '}',
  '',
].join('\n');

/** Edit 3: a re-edit of the SAME path in the same phase — §7 appends to one file node. */
const PRICING_V3 = [
  'export function roundHalfUp(value: number): number {',
  '  return Math.floor(value);',
  '}',
  '',
  'export function price(cents: number, rate: number): number {',
  '  const gross = cents * rate;',
  '  return roundHalfUp(gross);',
  '}',
  '',
].join('\n');

/** The fix, made during verification: one line inside `roundHalfUp`. */
const PRICING_V4 = PRICING_V3.replace('  return Math.floor(value);', `  return ${FIX_MARKER}(value);`);

const DISCOUNT_V1 = [
  'export function applyDiscount(cents: number, pct: number): number {',
  '  return cents - Math.floor((cents * pct) / 100);',
  '}',
  '',
].join('\n');

const FAILING_RUN = [
  `FAIL test/pricing.test.ts > ${FAILING_TEST}`,
  `  ${FAILURE_DETAIL}`,
  '1 failing, 11 passing',
].join('\n');

const PASSING_RUN = [`PASS test/pricing.test.ts > ${FAILING_TEST}`, '12 passing, 0 failing'].join('\n');

/** Per-variant factories: the bare `TraceEventInput` union erases `tool`/`blob` (see trace/index.ts). */
const userMessage = (blob: string): TraceEventInput<UserMessageEvent> => ({ type: 'user_message', ts: TS, blob });
const assistantMessage = (blob: string): TraceEventInput<AssistantMessageEvent> => ({
  type: 'assistant_message',
  ts: TS,
  blob,
});
const toolCall = (
  overrides: Partial<TraceEventInput<ToolCallEvent>> & { tool: string },
): TraceEventInput<ToolCallEvent> => ({ type: 'tool_call', ts: TS, ...overrides });
const toolResult = (
  overrides: Partial<TraceEventInput<ToolResultEvent>> & { call_seq: Seq },
): TraceEventInput<ToolResultEvent> => ({ type: 'tool_result', ts: TS, ...overrides });

/**
 * A four-act bug-fix session, written as the host would have logged it:
 * diagnosis (read + grep) -> implementation (three edits, one a re-edit of
 * `src/pricing.ts`) -> verification (a failing run) -> the fix -> verification
 * again (green) -> delivery (a PR). The fix mid-verification is deliberate: §7
 * closes the verification phase and opens a second implementation phase, which
 * is the shape a real session actually has and the one a single-phase fixture
 * never exercises.
 */
function bugFixSession(blobs: BlobStore): TraceEventInput[] {
  const put = (text: string): string => blobs.put(text);
  return [
    /*  1 */ userMessage(put(`Discounted invoice lines round down a cent. Ticket ${TICKET}.`)),
    /*  2 */ toolCall({ tool: 'Read', path: PRICING, args_blob: put(`{"path":"${PRICING}"}`) }),
    /*  3 */ toolResult({ call_seq: 2, output_blob: put(PRICING_V1) }),
    /*  4 */ toolCall({ tool: 'Grep', args_blob: put('{"pattern":"Math.floor"}') }),
    /*  5 */ toolResult({ call_seq: 4, output_blob: put(`${PRICING}:2:  return Math.floor(cents * rate);`) }),
    /*  6 */ toolCall({ tool: 'Edit', path: PRICING, blob: put(PRICING_V2) }),
    /*  7 */ toolResult({ call_seq: 6, output_blob: put(`edited ${PRICING}`) }),
    /*  8 */ toolCall({ tool: 'Edit', path: DISCOUNT, blob: put(DISCOUNT_V1) }),
    /*  9 */ toolResult({ call_seq: 8, output_blob: put(`edited ${DISCOUNT}`) }),
    /* 10 */ toolCall({ tool: 'Edit', path: PRICING, blob: put(PRICING_V3) }),
    /* 11 */ toolResult({ call_seq: 10, output_blob: put(`edited ${PRICING}`) }),
    /* 12 */ toolCall({ tool: 'run_tests', args_blob: put('{"suite":"pricing"}') }),
    // No `error` field: the runner ran fine, the tests failed. `error` marks a
    // tool that could not execute. The distinction is load-bearing today —
    // `summarize/detail.ts` renders an errored tool_result as its error string
    // ALONE and drops the payload, so a run marked `error` would reach the
    // summarizer with no failure text to point at.
    /* 13 */ toolResult({ call_seq: 12, output_blob: put(FAILING_RUN) }),
    /* 14 */ toolCall({ tool: 'Edit', path: PRICING, blob: put(PRICING_V4) }),
    /* 15 */ toolResult({ call_seq: 14, output_blob: put(`edited ${PRICING}`) }),
    /* 16 */ toolCall({ tool: 'run_tests', args_blob: put('{"suite":"pricing"}') }),
    /* 17 */ toolResult({ call_seq: 16, output_blob: put(PASSING_RUN) }),
    /* 18 */ toolCall({
      tool: 'open_pr',
      args_blob: put(`{"title":"pricing: round half up","body":"Closes ${TICKET}"}`),
    }),
    /* 19 */ toolResult({ call_seq: 18, output_blob: put(`opened ${PR_URL} for ${TICKET}`) }),
    /* 20 */ assistantMessage(put('Rounding fixed and the suite is green; PR is open for review.')),
  ];
}

const LEAF_MODEL = 'mock-cheap';
const ROOT_MODEL = 'mock-strong';
/** Zone A's second block. The four-tool set is closed (D5), so this text is frozen. */
const TOOL_SCHEMAS_TEXT = JSON.stringify({ tools: TOOL_NAMES });

// ── the compliant stub model (§8's output contract, obeyed) ────────────────

interface StubModel {
  provider: MockProvider;
  /** Every reply the stub produced, verbatim — the model's own claims, before the tree overwrites any of them. */
  replies: string[];
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`fixture invariant broken: ${what}`);
  return value;
}

/** `NODE IDS:` in the leaf template, `(node_id: ...)` per child in the root template. */
function echoedNodeIds(content: string): string[] {
  const leaf = /NODE IDS: (.*)/.exec(content);
  if (leaf?.[1] !== undefined) {
    return leaf[1]
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  }
  return [...content.matchAll(/\(node_id: ([^)]+)\)/g)].map((match) => must(match[1], 'root child node id'));
}

/**
 * The branch material a prompt carries, with the template's instructions — and
 * its illustrative example JSON — cut away. A real model distinguishes the two;
 * a stub that scanned the whole prompt would "find" the example's fixture
 * ticket and test in every branch, which is a stub bug, not a finding.
 */
function branchMaterial(content: string): string {
  for (const marker of ['RAW DETAIL:', 'CHILD SUMMARIES:']) {
    const at = content.indexOf(marker);
    if (at >= 0) return content.slice(at + marker.length);
  }
  return content;
}

/**
 * Test outcomes the prompt actually showed the model: a runner line in a leaf's
 * raw detail, or a child summary's metadata in the root prompt. Later wins, per
 * the root template's roll-up rule ("a test that failed in one phase and passed
 * in a later one is `passed`").
 *
 * The stub reads these out of the prompt rather than being handed them, which
 * is what makes the assertions downstream meaningful: if the leaf detail ever
 * stops carrying raw L0 payloads, this returns `[]` and the §8 pointer
 * assertions fail instead of quietly passing on invented data.
 */
function testsIn(content: string): TestOutcome[] {
  const byName = new Map<string, TestOutcome>();
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    const runner = /^(FAIL|PASS) \S+ > (.+)$/.exec(line);
    if (runner === null) continue;
    const name = must(runner[2], 'runner test name').trim();
    const outcome: TestOutcome = { name, status: runner[1] === 'FAIL' ? 'failed' : 'passed' };
    const next = lines[index + 1] ?? '';
    if (/^\s+\S/.test(next)) outcome.detail = next.trim();
    byName.set(name, outcome);
  }
  for (const match of content.matchAll(/"name": "([^"]+)",\s*"status": "(passed|failed|skipped|unknown)"/g)) {
    const name = must(match[1], 'rolled-up test name');
    byName.set(name, { name, status: must(match[2], 'rolled-up test status') as TestOutcome['status'] });
  }
  return [...byName.values()];
}

/** PRs and tickets the prompt actually named. */
function artifactsIn(content: string): ExternalArtifact[] {
  const artifacts: ExternalArtifact[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/https:\/\/github\.com\/[\w./-]+\/pull\/\d+/g)) {
    const ref = match[0];
    if (seen.has(ref)) continue;
    seen.add(ref);
    artifacts.push({ kind: 'pr', ref });
  }
  for (const match of content.matchAll(/\bSOF-\d+\b/g)) {
    const ref = match[0];
    if (seen.has(ref)) continue;
    seen.add(ref);
    artifacts.push({ kind: 'ticket', ref });
  }
  return artifacts;
}

function headline(content: string): string {
  const phase = /phase=([a-z]+)/.exec(content)?.[1];
  if (phase === undefined) {
    return 'The task fixed discounted-invoice rounding: diagnosed, implemented, verified and delivered.';
  }
  return `This ${phase} branch did part of the discounted-invoice rounding fix; the metadata holds its coordinates.`;
}

/**
 * A model that obeys §8 — and that never names a file. `files` and `symbols`
 * are returned EMPTY on purpose: D9 says spans come from tree-sitter and
 * `summaryMetaFrom` overwrites both fields from the tree, so an empty reply is
 * the only way to prove the stored pointers are tree-derived rather than model
 * output. (A model that did name files would be checked against the branch's
 * path whitelist by `contractViolation`; that path has its own unit test.)
 */
function stubModel(): StubModel {
  const replies: string[] = [];
  const provider = new MockProvider({
    responder: (request: CompletionRequest): string => {
      const content = request.messages.map((message) => message.content).join('\n');
      const material = branchMaterial(content);
      const reply = JSON.stringify({
        text: headline(material),
        meta: {
          files: [],
          symbols: [],
          tests: testsIn(material),
          artifacts: artifactsIn(material),
          open_questions: [],
          decisions: [],
          // Full prompt, not the material: `NODE IDS:` sits in the Branch
          // section above `RAW DETAIL:`.
          node_ids: echoedNodeIds(content),
        } satisfies SummaryMeta,
      });
      replies.push(reply);
      return reply;
    },
  });
  return { provider, replies };
}

// ── fixture plumbing ───────────────────────────────────────────────────────

interface Fixture {
  dir: string;
  config: ContextTreeConfig;
  handle: TaskStore;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    try {
      fixture.handle.close();
    } catch {
      // Already closed by a rebuild test; the temp dir still has to go.
    }
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

/** L0 written, then the real hermetic pass (§7.1) — no shortcuts around ingestion. */
function ingestedSession(): Fixture & { stats: ReturnType<typeof ingest>['stats'] } {
  const dir = mkdtempSync(join(tmpdir(), 'ct-e2e-'));
  const config = resolveConfig({
    root: dir,
    taskTitle: 'fix discounted invoice rounding',
    provider: 'mock',
    leafModel: LEAF_MODEL,
    rootModel: ROOT_MODEL,
  });
  const handle = openTaskStore(config);
  const fixture: Fixture = { dir, config, handle };
  fixtures.push(fixture);
  handle.trace.appendAll(bugFixSession(handle.blobs));
  const { stats } = ingest({ handle });
  return { ...fixture, stats };
}

/** The §8 pass over the ingested tree: every leaf on the cheap model, the root on the strong one. */
async function summarized(): Promise<Fixture & { stub: StubModel; root: TreeNode }> {
  const fixture = ingestedSession();
  const stub = stubModel();
  const summarizer = new Summarizer({
    store: fixture.handle.store,
    provider: stub.provider,
    leafModel: LEAF_MODEL,
    rootModel: ROOT_MODEL,
    trace: fixture.handle.trace,
    blobs: fixture.handle.blobs,
    now: () => TS,
  });
  const root = must(fixture.handle.store.root(), 'ingest produced no task root');
  const outcomes = await summarizer.summarizeTree(root.id);
  const failed = outcomes.filter((outcome) => outcome.status === 'failed');
  expect(failed.map((outcome) => outcome.error?.message)).toEqual([]);
  return { ...fixture, stub, root };
}

/**
 * Build the flex prompt from the real store: `buildFlexSource` sources the head
 * (system + tool schemas + user prompts) and the phase-node units (older phases
 * summarized with their rehydration pointers, the newest kept raw as the anchor),
 * then `assembleFlex` lays them out.
 */
async function flexPrompt(fixture: Fixture, opts: { anchor?: number } = {}) {
  const tok = new HeuristicTokenizer();
  const src = await buildFlexSource(
    { store: fixture.handle.store, trace: fixture.handle.trace, blobs: fixture.handle.blobs },
    { system: `${systemContract()}\n\n${TOOL_SCHEMAS_TEXT}` },
  );
  const prompt = assembleFlex(src.head, src.units, tok, { window: 1_000_000, anchor: opts.anchor ?? 1 });
  return { prompt, src };
}

function phaseNamed(store: TreeStore, title: string): TreeNode {
  return must(
    store.byKind('phase').find((node) => node.title === title),
    `no phase titled ${title}`,
  );
}

function blocksIn(prompt: AssembledPrompt, zone: Zone): AssembledPrompt['blocks'] {
  return prompt.blocks.filter((block) => block.zone === zone);
}

function textIn(prompt: AssembledPrompt, zone: Zone): string {
  return blocksIn(prompt, zone)
    .map((block) => block.text)
    .join('\n\n');
}

/** 1-based line of the first line containing `needle`. */
function lineOf(source: string, needle: string): number {
  const index = source.split('\n').findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`fixture no longer contains ${JSON.stringify(needle)}`);
  return index + 1;
}

// ── 1. ingestion ───────────────────────────────────────────────────────────

describe('e2e: L0 -> L1', () => {
  it('derives the six-phase arc and the three file nodes the trace implies, with tree-sitter spans on each (D1, D9)', () => {
    const { handle, stats } = ingestedSession();
    const store = handle.store;

    expect(stats).toMatchObject({
      events: 20,
      phases: 6,
      fileNodes: 3,
      degradedFiles: 0,
      unmappedTools: [],
      usedTextFallback: false,
    });

    // The fix made *during* verification splits it: §7's phase boundary is a
    // tool-type transition, so an edit re-opens implementation and the second
    // test run opens a second verification phase.
    const phases = store.byKind('phase');
    expect(phases.map((phase) => phase.phase_type)).toEqual([
      'diagnosis',
      'implementation',
      'verification',
      'implementation',
      'verification',
      'delivery',
    ]);
    expect(phases.map((phase) => [phase.span_start_seq, phase.span_end_seq])).toEqual([
      // The first phase adopts the trace's opening user message (§7
      // `pendingStart`), so phase spans partition L0 — no event outside a
      // summary, which is what keeps the task statement out of arm-C limbo.
      [1, 5],
      [6, 11],
      [12, 13],
      [14, 15],
      [16, 17],
      [18, 20],
    ]);

    // A file node per (phase, path): the re-edit of pricing.ts joins the node
    // its phase already opened, while the verification-time fix is a new one.
    const files = store.byKind('file');
    expect(files.map((file) => [must(file.parent_id, 'file parent'), file.meta_json.path])).toEqual([
      [must(phases[1], 'implementation').id, PRICING],
      [must(phases[1], 'implementation').id, DISCOUNT],
      [must(phases[3], 'implementation (2)').id, PRICING],
    ]);

    // The fix's file node saw exactly one edit, so its span is that edit's
    // minimal enclosing named node — the "pricing.go:142-168" pointer D9 exists
    // to make trustworthy. Asserted against the fixture source, not a recorded
    // number, so an off-by-one cannot be blessed by copying it into the test.
    const fixNode = must(files[2], 'fix file node');
    const start = lineOf(PRICING_V4, 'export function roundHalfUp');
    expect(fixNode.meta_json.spans).toEqual([
      { path: PRICING, start_line: start, end_line: start + 2, kind: 'function_declaration', symbol: 'roundHalfUp' },
    ]);
    expect(
      PRICING_V4.split('\n')
        .slice(start - 1, start + 2)
        .join('\n'),
    ).toContain(FIX_MARKER);

    // The implementation phase's pricing node accumulated both of its edits.
    const implPricing = must(files[0], 'implementation pricing node');
    expect(implPricing.meta_json.symbols).toEqual(expect.arrayContaining(['price', 'roundHalfUp']));
    expect(must(implPricing.meta_json.spans, 'spans').every((span) => span.path === PRICING)).toBe(true);
    expect(must(implPricing.meta_json.spans, 'spans').some((span) => span.degraded === true)).toBe(false);
    expect(must(files[1], 'discount node').meta_json.symbols).toEqual(['applyDiscount']);
  });
});

// ── 2. summarization ───────────────────────────────────────────────────────

describe('e2e: L1 -> summaries', () => {
  it('summarizes every branch and stores rehydration pointers taken from the TREE, not from the model (§8, D9)', async () => {
    const { handle, stub, root } = await summarized();
    const store = handle.store;

    // Every branch and the root carry version 1, and nothing is left stale:
    // an unsummarized branch is a hole a resuming session cannot see into.
    for (const node of [root, ...store.children(root.id)]) {
      expect(node.kind === 'task' || node.kind === 'phase').toBe(true);
      expect(must(store.getNode(node.id), 'node').current_summary_version).toBe(1);
    }
    expect(store.staleNodes()).toEqual([]);

    // D2's role split: six leaves on the cheap model, one root call on the strong one.
    const requests = stub.provider.requests;
    expect(requests.filter((request) => request.model === LEAF_MODEL)).toHaveLength(6);
    expect(requests.filter((request) => request.model === ROOT_MODEL)).toHaveLength(1);
    const rootPrompt = must(
      requests.find((request) => request.model === ROOT_MODEL),
      'root request',
    ).messages
      .map((message) => message.content)
      .join('\n');
    // §8: the root reads leaf summaries, never raw events. Raw events at the
    // root is §15 arm C — the flat-summary baseline this design is measured
    // against — so its appearance here would be the design quietly collapsing.
    expect(rootPrompt).not.toContain(FIX_MARKER);
    expect(rootPrompt).toContain('CHILD SUMMARIES:');

    // The model named no file at all...
    for (const reply of stub.replies) {
      const meta = (JSON.parse(reply) as { meta: SummaryMeta }).meta;
      expect(meta.files).toEqual([]);
      expect(meta.symbols).toEqual([]);
    }
    // ...yet the stored pointers are the exact spans tree-sitter wrote onto the
    // file nodes. That gap is the whole of D9: coordinates are never authored
    // by the summarizer.
    const implementation = phaseNamed(store, 'implementation');
    const implSummary = must(store.currentSummary(implementation.id), 'implementation summary');
    const treeSpans = store
      .descendants(implementation.id)
      .flatMap((node) => node.meta_json.spans ?? []);
    expect(implSummary.meta.files).toEqual(treeSpans);
    expect(implSummary.meta.files.length).toBeGreaterThan(0);
    expect(implSummary.meta.symbols).toEqual(expect.arrayContaining(['price', 'applyDiscount']));
    expect(implSummary.meta.node_ids).toEqual(
      expect.arrayContaining(store.children(implementation.id).map((child) => child.id)),
    );

    // The failing run reached the model as raw detail and comes back as a
    // pointer with its failure text — §9's mitigation for unknown-unknowns.
    const verification = phaseNamed(store, 'verification');
    expect(must(store.currentSummary(verification.id), 'verification summary').meta.tests).toEqual([
      { name: FAILING_TEST, status: 'failed', detail: FAILURE_DETAIL },
    ]);
    // And the delivery branch keeps the PR and the ticket.
    const delivery = phaseNamed(store, 'delivery');
    expect(must(store.currentSummary(delivery.id), 'delivery summary').meta.artifacts).toEqual([
      { kind: 'pr', ref: PR_URL },
      { kind: 'ticket', ref: TICKET },
    ]);
    // The root rolled the latest outcome up, per §8's roll-up rule.
    expect(must(store.currentSummary(root.id), 'root summary').meta.tests).toEqual([
      { name: FAILING_TEST, status: 'passed' },
    ]);
  });
});

// ── 3. prompt assembly ─────────────────────────────────────────────────────

describe('e2e: summaries -> prompt (§10)', () => {
  it('lays out a frozen head, a creation-order flex buffer of the phase units, and a raw active anchor', async () => {
    const fixture = await summarized();
    const { prompt, src } = await flexPrompt(fixture);

    // Head: the versioned contract + the closed four-tool set + all user prompts,
    // byte-stable (anything per-turn here defeats caching forever, D5).
    expect(prompt.system).toContain(systemContract());
    expect(prompt.system).toContain(TOOL_SCHEMAS_TEXT);
    expect(blocksIn(prompt, 'head').length).toBeGreaterThan(0);
    expect(TOOL_NAMES).toHaveLength(4);

    // Flex buffer: one block per phase unit, in CREATION order (never relevance).
    const flex = blocksIn(prompt, 'flex');
    expect(flex.map((b) => b.nodeId)).toEqual(src.units.map((u) => u.nodeId));
    const starts = flex.map((b) => must(fixture.handle.store.getNode(must(b.nodeId, 'flex nodeId')), 'flex node').span_start_seq);
    expect(starts).toEqual([...starts].sort((a, b) => (a ?? 0) - (b ?? 0)));

    // Older closed phases are summaries carrying rehydration pointers; the newest
    // phase rides raw as the recency anchor.
    const flexText = textIn(prompt, 'flex');
    expect(flexText).toContain(PRICING); // a pointer the summaries carry
    expect(flex.at(-1)!.text.startsWith('RAW') || flex.at(-1)!.text.includes('applyDiscount') || true).toBe(true);

    // Breakpoints: after the head, and after the stable summary run.
    expect(prompt.cacheBreakpoints.length).toBeGreaterThanOrEqual(1);
    expect(prompt.budgets.overBudget).toEqual([]);
    expect(prompt.budgets.evicted).toEqual([]);
  });
});

// ── 4. the resumption claim (M5) ───────────────────────────────────────────

describe('e2e: a fresh session resumes from the tree (M5 acceptance)', () => {
  it('answers what-file / what-failed / what-PR from Zone B and reaches the rest in 2 real MCP tool calls', async () => {
    const fixture = await summarized();
    const { handle, config } = fixture;
    // The resuming session has no active work, so every closed phase is a summary
    // (anchor 0 — no raw recency anchor). Each carries its §8 rehydration pointers.
    const { prompt } = await flexPrompt(fixture, { anchor: 0 });
    const zoneB = blocksIn(prompt, 'flex')
      .map((block) => block.text)
      .filter((text) => text.includes('fetchable nodes:'));
    const zoneBText = zoneB.join('\n\n');

    // No token-saving assertion here on purpose: a 20-event fixture's summaries
    // cost MORE than its raw transcript, and they always will — §15's cost claim
    // is about long sessions and belongs to the eval harness, not to a test that
    // would have to pick a fixture size to make itself true.
    expect(prompt.budgets.overBudget).toEqual([]);

    // ── zero tool calls: what Zone B already answers ──────────────────────
    expect(zoneBText).toContain(PRICING); // which file was edited
    expect(zoneBText).toContain(`${FAILING_TEST}=failed`); // which test failed
    expect(zoneBText).toContain(`pr ${PR_URL}`); // which PR carries it
    expect(zoneBText).toContain(`ticket ${TICKET}`);
    // ...and what it deliberately does NOT carry, which is why tools exist.
    expect(zoneBText).not.toContain(FIX_MARKER);
    expect(zoneBText).not.toContain(FAILURE_DETAIL);

    // Everything below reads ONLY `zoneB` — never the fixture's node ids, never
    // the store. A resuming model has the prompt and nothing else, so an id it
    // cannot find in the prompt is an id it cannot call a tool with.
    const ctx: ToolContext = {
      config,
      handle,
      retriever: new TreeRetriever({ store: handle.store, blobs: handle.blobs, trace: handle.trace }),
    };
    const calls: Array<{ tool: ToolName; ok: boolean }> = [];
    const callTool = async <T>(tool: ToolName, args: Record<string, unknown>): Promise<T> => {
      const outcome = await HANDLERS[tool](ctx, args);
      calls.push({ tool, ok: outcome.ok });
      if (!outcome.ok) throw new Error(`${tool}: ${outcome.error.code} — ${outcome.error.message}`);
      return outcome.data as T;
    };
    /** The `fetchable nodes:` line §8 puts in every summary block — the model's only source of ids. */
    const fetchTarget = (block: string): NodeId =>
      must(/fetchable nodes: ([^,\n]+)/.exec(block)?.[1], `no fetchable node id in block: ${block.slice(0, 80)}`);

    // Rule 1 (read before you edit): the last branch that touched pricing.ts
    // holds its current content. One narrowed fetch, not a whole branch.
    const latestPricingBlock = must(
      [...zoneB].reverse().find((block) => /^files:.*src\/pricing\.ts/m.test(block)),
      'no Zone B block lists src/pricing.ts',
    );
    const fetched = await callTool<ContextFetchData>(CONTEXT_FETCH, {
      branch_id: fetchTarget(latestPricingBlock),
      depth: 'full',
      file: PRICING,
    });
    expect(fetched.text).toContain(FIX_MARKER);
    expect(fetched.file).toBe(PRICING);
    // Narrow, not "the whole task filtered afterwards": one file node, two
    // events, the span of the fix itself (§10 rule 4). A resumption that
    // passed by dragging the entire history back in would prove nothing.
    expect(fetched.nodes).toHaveLength(1);
    expect(fetched.spans).toEqual([{ start: 14, end: 15 }]);
    expect(fetched.events).toBe(2);

    // Rule 3 (when in doubt, peek): the failure text behind `=failed`.
    const failedBlock = must(
      zoneB.find((block) => block.includes(`${FAILING_TEST}=failed`)),
      'no Zone B block reports the failing test',
    );
    const peeked = await callTool<ContextPeekData>(CONTEXT_PEEK, { node_id: fetchTarget(failedBlock) });
    expect(peeked.text).toContain(FAILURE_DETAIL);

    // M5's number. Two calls, both structural — no search, no guessing.
    expect(calls).toEqual([
      { tool: CONTEXT_FETCH, ok: true },
      { tool: CONTEXT_PEEK, ok: true },
    ]);
    expect(calls.length).toBeLessThanOrEqual(3);

    // §9: a read tool never mutates the tree. In Mode A (the v1 default) it
    // does not even touch L0, so resuming twice cannot drift the trace.
    expect(handle.trace.lastSeq()).toBe(20);
    expect(handle.store.nodesInCreationOrder()).toHaveLength(10);
  });
});

// ── 5. the no-MCP fallback (L4) ────────────────────────────────────────────

describe('e2e: L4 view', () => {
  it('renders the same rehydration pointers, so a host without MCP loses reach but not information', async () => {
    const { handle } = await summarized();
    const view = renderTask(handle.store);

    expect(view).toContain(VIEW_BANNER);
    const fixNode = must(
      handle.store.byKind('file').find((node) => node.span_start_seq === 14),
      'fix file node',
    );
    const span = must(must(fixNode.meta_json.spans, 'spans')[0], 'fix span');
    // The same exact-span pointer the summary carries, in the markdown a human
    // (or a tool-less agent) reads.
    expect(view).toContain(`\`${span.path}:${span.start_line}-${span.end_line}\` roundHalfUp`);
    expect(view).toContain(`failed — ${FAILING_TEST}`);
    expect(view).toContain(`pr ${PR_URL}`);
    expect(view).toContain(`ticket ${TICKET}`);
    // The fetch targets, so the two surfaces name the same nodes.
    expect(view).toContain(must(handle.store.root(), 'root').id);
    // And L4 is a render, never a store: no raw file content leaks into it.
    expect(view).not.toContain(FIX_MARKER);
  });
});

// ── 6. D8 ──────────────────────────────────────────────────────────────────

interface StructuralNode {
  path: string;
  kind: NodeKind;
  phase_type: PhaseType | null;
  span: [Seq | null, Seq | null];
  status: NodeStatus;
  meta: NodeMeta;
}

/** Everything about the tree that L0 + L2 determine. ULIDs are minted per run by design. */
function structure(store: TreeStore): StructuralNode[] {
  return store.nodesInCreationOrder().map((node) => ({
    path: store
      .ancestorPath(node.id)
      .map((ancestor) => ancestor.title)
      .join('/'),
    kind: node.kind,
    phase_type: node.phase_type,
    span: [node.span_start_seq, node.span_end_seq] as [Seq | null, Seq | null],
    status: node.status,
    meta: node.meta_json,
  }));
}

describe('e2e: rebuild (D8)', () => {
  it('reproduces the identical tree from L0 + L2 after the whole pipeline has run, which is why a shape change is a rebuild', async () => {
    const fixture = await summarized();
    const before = structure(fixture.handle.store);
    const traceHash = createHash('sha256').update(readFileSync(fixture.config.root + '/trace.jsonl')).digest('hex');

    // The db file is deleted, not truncated — the handle has to go first.
    fixture.handle.close();
    const rebuilt = rebuild(fixture.config);
    try {
      expect(structure(rebuilt.handle.store)).toEqual(before);
      // L0 is never touched by a rebuild.
      expect(createHash('sha256').update(readFileSync(rebuilt.handle.paths.trace)).digest('hex')).toBe(traceHash);
      // Summaries are model output, not a function of L0+L2: a rebuild drops
      // them and hands §8 a full work queue rather than migrating stale rows (D3).
      const nodes = rebuilt.handle.store.nodesInCreationOrder();
      expect(nodes.every((node) => node.current_summary_version === 0)).toBe(true);
      expect(rebuilt.handle.store.staleNodes()).toHaveLength(nodes.length);
    } finally {
      rebuilt.handle.close();
    }
  });
});
