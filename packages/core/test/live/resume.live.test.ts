/**
 * LIVE, opt-in (§17): the same pipeline as `test/e2e.test.ts`, against a real
 * model. A canary, not a benchmark — one small trace on the cheap model,
 * capped by a `CostMeter`, because it spends the user's money on every run.
 *
 * What only a real model can tell us: whether §8's output contract actually
 * holds when nobody is stubbing it. The offline e2e proves the *plumbing*
 * carries pointers; a compliant stub cannot prove that a frontier model reads
 * `leaf-summary.v1.md`, replies with every required field, echoes the node ids
 * it was handed, and stays inside the branch's file whitelist. That is the
 * failure this test exists to catch — a prompt edit that quietly makes the
 * contract unfollowable passes every offline test in the repo.
 *
 * KNOWN RED as of the first runs of this file (2026-03, `claude-haiku-4-5`):
 * one leaf per run fails on its model-authored `meta.files[]` — observed
 * `start_line: missing required field`, `symbol: expected a non-empty string`,
 * and a path outside the branch whitelist, on three consecutive runs. The
 * retry does not recover it. Every one of those rejections is over a field
 * `summaryMetaFrom` DISCARDS (D9: stored spans come from tree-sitter), so a
 * branch is being dropped from the tree over data the system never keeps. That
 * is a defect in `prompts/parseSummaryResponse` + `summarize/contract.ts`, not
 * flake and not this test's assertion being too strict — do not relax it to get
 * a green run; the point of a canary is that it is red when the bird is dead.
 *
 * Costs a few cents. Run with:
 *   LIVE=1 npx vitest run packages/core/test/live
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApiKeys, loadDotEnv, resolveConfig } from '../../src/config.js';
import { AnthropicProvider, InMemoryCostMeter, OpenRouterProvider } from '../../src/models/index.js';
import { HeuristicTokenizer } from '../../src/tokens/index.js';
import { ZoneAssembler } from '../../src/assemble/index.js';
import { systemContract } from '../../src/prompts/index.js';
import { Summarizer } from '../../src/summarize/index.js';
import { ingest, openTaskStore } from '../../src/ingest/index.js';
import { TreeRetriever } from '../../src/retrieve/index.js';
import type {
  AssistantMessageEvent,
  ModelProvider,
  ToolCallEvent,
  ToolResultEvent,
  TraceEventInput,
  UserMessageEvent,
} from '../../src/contracts/index.js';
import { CONTEXT_FETCH, HANDLERS } from '@context-tree/mcp';
import type { ContextFetchData, ToolContext, ToolName } from '@context-tree/mcp';

loadDotEnv();
const keys = loadApiKeys();
const provider: 'anthropic' | 'openrouter' | null = keys.anthropic
  ? 'anthropic'
  : keys.openrouter
    ? 'openrouter'
    : null;
const enabled = Boolean(process.env.LIVE) && provider !== null;

/** §8's cheap leaf model in both roles: this is a contract canary, not a quality bar. */
const MODEL = provider === 'openrouter' ? 'anthropic/claude-haiku-4.5' : 'claude-haiku-4-5-20251001';

/**
 * §16's per-run cap. Four haiku calls over a ten-event trace are well under a
 * cent; the cap sits two orders of magnitude above that so it fires on a
 * runaway (a retry storm, a model id that silently routes to an expensive
 * tier) rather than on normal variance.
 */
const CAP_USD = 0.1;

const TS = '2026-03-02T09:00:00.000Z';
const PRICING = 'src/pricing.ts';
const FIX_MARKER = 'Math.round';
const PASSING_TEST = 'rounds half up on discounted totals';

const PRICING_BEFORE = [
  'export function price(cents: number, rate: number): number {',
  '  return Math.floor(cents * rate);',
  '}',
  '',
].join('\n');

const PRICING_AFTER = PRICING_BEFORE.replace('Math.floor', FIX_MARKER);

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
  overrides: Partial<TraceEventInput<ToolResultEvent>> & { call_seq: number },
): TraceEventInput<ToolResultEvent> => ({ type: 'tool_result', ts: TS, ...overrides });

const temps: string[] = [];
afterAll(() => {
  while (temps.length > 0) rmSync(temps.pop() ?? '', { recursive: true, force: true });
});

function liveProvider(): ModelProvider {
  if (provider === 'openrouter') return new OpenRouterProvider({ apiKey: keys.openrouter ?? '' });
  return new AnthropicProvider({ apiKey: keys.anthropic ?? '' });
}

describe.skipIf(!enabled)('live: a real model resumes a task from the tree', () => {
  it("writes §8-compliant summaries whose file pointers are the tree's, and resumes in one tool call", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-live-resume-'));
    temps.push(dir);
    const config = resolveConfig({
      root: dir,
      taskTitle: 'fix discounted invoice rounding',
      provider: provider ?? 'anthropic',
      leafModel: MODEL,
      rootModel: MODEL,
    });
    const handle = openTaskStore(config);
    const { blobs, store, trace } = handle;
    const meter = new InMemoryCostMeter({ capUsd: CAP_USD });

    try {
      // One diagnosis / implementation / verification arc. Deliberately tiny:
      // every line of it is billed on every run.
      trace.appendAll([
        userMessage(blobs.put('Discounted invoice lines round down a cent.')),
        toolCall({ tool: 'Read', path: PRICING, args_blob: blobs.put(`{"path":"${PRICING}"}`) }),
        toolResult({ call_seq: 2, output_blob: blobs.put(PRICING_BEFORE) }),
        toolCall({ tool: 'Edit', path: PRICING, blob: blobs.put(PRICING_AFTER) }),
        toolResult({ call_seq: 4, output_blob: blobs.put(`edited ${PRICING}`) }),
        toolCall({ tool: 'run_tests', args_blob: blobs.put('{"suite":"pricing"}') }),
        toolResult({
          call_seq: 6,
          output_blob: blobs.put(`PASS test/pricing.test.ts > ${PASSING_TEST}\n12 passing, 0 failing`),
        }),
        assistantMessage(blobs.put('Rounding now uses half-up; the suite is green.')),
      ]);
      ingest({ handle });

      const root = store.root();
      if (root === null) throw new Error('ingest produced no task root');
      const summarizer = new Summarizer({
        store,
        provider: liveProvider(),
        leafModel: MODEL,
        rootModel: MODEL,
        trace,
        blobs,
        costMeter: meter,
      });
      const outcomes = await summarizer.summarizeTree(root.id);

      // A contract violation surfaces as a failed outcome after one retry, so
      // this is the assertion the whole test is for: it fails loudly, naming
      // the field the live model would not produce.
      expect(outcomes.filter((outcome) => outcome.status === 'failed').map((o) => o.error?.message)).toEqual([]);

      // §8's content contract, on real output. Every field present (never
      // omitted, never null) — that is what makes relevance detectable from a
      // summary alone, and it is §9's unknown-unknowns mitigation.
      const tracePaths = new Set([PRICING]);
      const metaFields = ['files', 'symbols', 'tests', 'artifacts', 'open_questions', 'decisions', 'node_ids'] as const;
      for (const node of [root, ...store.children(root.id)]) {
        const summary = store.currentSummary(node.id);
        expect(summary, `no summary for ${node.title}`).not.toBeNull();
        if (summary === null) continue;
        expect(summary.text.length).toBeGreaterThan(20);
        for (const field of metaFields) {
          expect(Array.isArray(summary.meta[field]), `${node.title}.meta.${field} must be an array`).toBe(true);
        }
        // Spans are tree-sitter's (D9), so every path must be one the trace
        // actually touched — a live model inventing `src/utils.ts` here would
        // make every rehydration pointer in the system untrustworthy.
        for (const file of summary.meta.files) {
          expect(tracePaths.has(file.path), `hallucinated path ${file.path}`).toBe(true);
          expect(file.end_line).toBeGreaterThanOrEqual(file.start_line);
        }
        // The branch names itself as a fetch target, so a reader of the summary
        // can act on it without a search first.
        expect(summary.meta.node_ids).toContain(node.id);
      }

      // The implementation branch carries the real span, and it is the one
      // tree-sitter wrote — not one the model composed.
      const implementation = store.byKind('phase').find((node) => node.phase_type === 'implementation');
      if (implementation === undefined) throw new Error('no implementation phase');
      const implFiles = store.currentSummary(implementation.id)?.meta.files;
      expect(implFiles).toEqual(store.descendants(implementation.id).flatMap((node) => node.meta_json.spans ?? []));
      expect(implFiles?.length).toBeGreaterThan(0);

      // Resumption, same shape as the offline test: a fresh session sees Zone B
      // only, finds the file and its fetch target there, and pulls the current
      // content back with one narrowed call.
      const prompt = new ZoneAssembler({
        store,
        blobs,
        trace,
        tokenizer: new HeuristicTokenizer(),
        systemContract: systemContract(),
      }).assemble();
      const zoneB = prompt.blocks.filter((block) => block.zone === 'B').map((block) => block.text);
      const pricingBlock = [...zoneB].reverse().find((block) => /^files:.*src\/pricing\.ts/m.test(block));
      expect(pricingBlock, 'no Zone B block lists the edited file').toBeDefined();
      const branchId = /fetchable nodes: ([^,\n]+)/.exec(pricingBlock ?? '')?.[1];
      expect(branchId, 'no fetch target in the Zone B block').toBeDefined();

      const ctx: ToolContext = { config, handle, retriever: new TreeRetriever({ store, blobs, trace }) };
      const calls: ToolName[] = [CONTEXT_FETCH];
      const fetched = await HANDLERS[CONTEXT_FETCH](ctx, { branch_id: branchId, depth: 'full', file: PRICING });
      expect(fetched.ok, fetched.ok ? '' : `${fetched.error.code}: ${fetched.error.message}`).toBe(true);
      if (fetched.ok) expect((fetched.data as ContextFetchData).text).toContain(FIX_MARKER);
      // M5's ceiling. One call here, because Zone B answered the rest.
      expect(calls.length).toBeLessThanOrEqual(3);

      // §16: the run stayed inside its cap, and it actually spent something —
      // a zero would mean the meter was never wired to the calls.
      const spent = meter.totalUsd();
      expect(spent).toBeGreaterThan(0);
      expect(spent).toBeLessThan(CAP_USD);
      // An unpriced model is charged the priciest tier, so the cap still holds
      // — but it means the id drifted away from the price table (§11).
      expect(meter.unpricedModels()).toEqual([]);
    } finally {
      handle.close();
    }
  }, 180_000);
});

describe.skipIf(enabled)('live suite guard', () => {
  it('skips without LIVE=1 and a key, so CI never needs a secret (§17)', () => {
    expect(enabled).toBe(false);
  });
});
