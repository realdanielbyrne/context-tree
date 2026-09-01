/**
 * Writes the §17 cassettes that let CI test the §8 prompts with no network.
 *
 * Two modes, one code path:
 *   --authored   replay the hand-authored replies in `golden.ts` (no key, no
 *                network) and stamp the cassettes as hand-authored
 *   --live       LIVE=1 plus a provider key: call the real models through
 *                `RecordingProvider` and stamp the cassettes as recorded
 *
 * The modes share `writeCassettes` because the cassette keys are content
 * hashes: `requestKey` covers the model id and the exact prompt text, so the
 * only reliable way to produce a loadable cassette is to run the real
 * `Summarizer` over the real golden tree and let `RecordingProvider` key what
 * it actually sent. Hand-editing the JSON means hand-computing SHA-256.
 *
 * Run it (from the repo root — vite-node is what resolves the `@context-tree/*`
 * aliases, and its bin is not linked at the root):
 *
 *   VN=$(node -e "process.stdout.write(require.resolve('vite-node/vite-node.mjs',{paths:[require.resolve('vitest/package.json')]}))")
 *   node "$VN" --config vitest.config.ts packages/core/test/live/record.ts -- --authored
 *   LIVE=1 ANTHROPIC_API_KEY=sk-... node "$VN" --config vitest.config.ts packages/core/test/live/record.ts -- --live
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  LEAF_SUMMARY_VERSION,
  PROVIDER_KEY,
  ROOT_SUMMARY_VERSION,
  RecordingProvider,
  Summarizer,
  ZERO_USAGE,
  createProvider,
  loadApiKeys,
  loadDotEnv,
  readCassette,
  resolveConfig,
  writeCassette,
  type Cassette,
  type CompletionRequest,
  type CompletionResult,
  type ContextTreeConfig,
  type ModelProvider,
} from '@context-tree/core';
import {
  LEAF_MODEL,
  MALFORMED_LEAF_KEY,
  MALFORMED_LEAF_REPLY,
  MALFORMED_ROOT_KEY,
  MALFORMED_ROOT_REPLY,
  ROOT_ID,
  ROOT_MODEL,
  authoredReplyFor,
  buildGoldenTree,
} from './golden.js';

const EVAL_RECORDED = fileURLToPath(new URL('../../../../eval-resumption/recorded/', import.meta.url));

/**
 * Named for the prompt version they were produced from: a `v2` leaf template is
 * a different prompt, so its replies belong in a different file rather than
 * silently replacing v1's.
 */
export const LEAF_CASSETTE = join(EVAL_RECORDED, `leaf-summary.${LEAF_SUMMARY_VERSION}.json`);
export const ROOT_CASSETTE = join(EVAL_RECORDED, `root-summary.${ROOT_SUMMARY_VERSION}.json`);

/**
 * Reserved cassette keys. A real key is a 64-char SHA-256 hex digest, so an
 * underscore-prefixed key can never collide with one and never be replayed —
 * but it is still a `CompletionResult`, because `readCassette` parses every
 * top-level value as one and a bare string would make the file unloadable.
 */
export const PROVENANCE_KEY = '_provenance';
export const REGENERATE_KEY = '_regenerate';

export const AUTHORED_PROVENANCE =
  'hand-authored, not a real recording — written by hand because no API key was available; see eval-resumption/recorded/README.md';

export function recordedProvenance(providerId: string, when: string): string {
  return `recorded from live models via ${providerId} on ${when}`;
}

/** Both markers start with one of these; the offline suite refuses a cassette that claims neither. */
export const PROVENANCE_PREFIXES = ['hand-authored', 'recorded from live models'] as const;

const REGENERATE_COMMAND = [
  'VN=$(node -e "process.stdout.write(require.resolve(\'vite-node/vite-node.mjs\',{paths:[require.resolve(\'vitest/package.json\')]}))")',
  '# hand-authored replies, no key needed:',
  'node "$VN" --config vitest.config.ts packages/core/test/live/record.ts -- --authored',
  '# real completions:',
  'LIVE=1 ANTHROPIC_API_KEY=sk-... node "$VN" --config vitest.config.ts packages/core/test/live/record.ts -- --live',
].join('\n');

/** A `CompletionResult` carrying a note. `model: "none"` says no model produced it. */
function marker(text: string): CompletionResult {
  return { text, model: 'none', usage: { ...ZERO_USAGE }, toolCalls: [], stopReason: null };
}

/**
 * Routes by §8 role. `RecordingProvider` writes one file, and leaf and root
 * replies belong in separate cassettes so a change to one prompt version only
 * invalidates its own.
 */
export class RoleRouter implements ModelProvider {
  readonly id: string;

  constructor(
    private readonly leaf: ModelProvider,
    private readonly root: ModelProvider,
    private readonly leafModel: string,
  ) {
    this.id = `role-router:${leaf.id}`;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return request.model === this.leafModel ? this.leaf.complete(request) : this.root.complete(request);
  }
}

/** Serves the hand-authored replies. Kept here rather than in `golden.ts` so the fixture stays data. */
class AuthoredProvider implements ModelProvider {
  readonly id = 'authored';
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return authoredReplyFor(request);
  }
}

export interface RecordOptions {
  /** The model behind the recorder: authored replies, or a live provider. */
  inner: ModelProvider;
  /** What `_provenance` will say. Never inferred — the caller knows what it ran. */
  provenance: string;
  leafModel?: string;
  rootModel?: string;
}

/**
 * Runs the §8 summarizer over the five golden branches and writes both
 * cassettes. Throws on any failed branch: a cassette missing a golden branch
 * would make the offline suite pass on four of five and report nothing.
 */
export async function writeCassettes(options: RecordOptions): Promise<void> {
  const leafModel = options.leafModel ?? LEAF_MODEL;
  const rootModel = options.rootModel ?? ROOT_MODEL;
  // Start from nothing: `RecordingProvider` merges into whatever is on disk, so
  // a re-record after a prompt edit would otherwise leave the superseded keys
  // behind and the cassette would hold two corpora, one of them unreachable.
  rmSync(LEAF_CASSETTE, { force: true });
  rmSync(ROOT_CASSETTE, { force: true });
  const dir = mkdtempSync(join(tmpdir(), 'context-tree-record-'));
  const golden = buildGoldenTree(dir);
  try {
    const provider = new RoleRouter(
      new RecordingProvider(options.inner, LEAF_CASSETTE),
      new RecordingProvider(options.inner, ROOT_CASSETTE),
      leafModel,
    );
    const summarizer = new Summarizer({
      store: golden.store,
      provider,
      leafModel,
      rootModel,
      trace: golden.trace,
      blobs: golden.blobs,
    });
    const outcomes = await summarizer.summarizeTree(ROOT_ID);
    const failed = outcomes.filter((outcome) => outcome.status === 'failed');
    if (failed.length > 0) {
      throw new Error(
        `re-record aborted: ${failed.length} branch(es) failed — ` +
          failed.map((f) => `${f.nodeId}: ${f.error?.message ?? 'unknown'}`).join('; '),
      );
    }
  } finally {
    golden.close();
    rmSync(dir, { recursive: true, force: true });
  }

  stamp(LEAF_CASSETTE, options.provenance, MALFORMED_LEAF_KEY, MALFORMED_LEAF_REPLY, leafModel);
  stamp(ROOT_CASSETTE, options.provenance, MALFORMED_ROOT_KEY, MALFORMED_ROOT_REPLY, rootModel);
}

/**
 * Adds the provenance marker, the regenerate command and the malformed entry.
 *
 * The malformed reply is hand-authored in every mode, including a live
 * re-record: it is a fixture for the contract-violation path, not something a
 * model was asked to produce.
 */
function stamp(
  path: string,
  provenance: string,
  malformedKey: string,
  malformedReply: string,
  model: string,
): void {
  const cassette: Cassette = readCassette(path);
  cassette[PROVENANCE_KEY] = marker(
    `${provenance}. The ${malformedKey} entry below is hand-authored in every mode — it is a fixture for the §8 contract-violation path, not a model reply.`,
  );
  cassette[REGENERATE_KEY] = marker(REGENERATE_COMMAND);
  cassette[malformedKey] = {
    text: malformedReply,
    model,
    usage: { ...ZERO_USAGE },
    toolCalls: [],
    stopReason: 'end_turn',
  };
  writeCassette(path, cassette);
}

/**
 * Whether the LIVE half of §17 may run: the opt-in flag *and* a key for the
 * selected provider. Both halves matter — a suite that fails for a missing key
 * teaches everyone to ignore it.
 */
export function shouldRunLive(env: NodeJS.ProcessEnv): boolean {
  const flag = env.LIVE;
  if (flag === undefined || flag === '' || flag === '0' || flag === 'false') return false;
  const needed = PROVIDER_KEY[liveConfig(env).provider];
  return needed === null || loadApiKeys(env)[needed] !== undefined;
}

/** The provider the live suite talks to. `CONTEXT_TREE_PROVIDER` picks the §11 alternative. */
export function liveConfig(env: NodeJS.ProcessEnv): ContextTreeConfig {
  const named = env.CONTEXT_TREE_PROVIDER;
  const provider: ContextTreeConfig['provider'] =
    named === 'openrouter' || named === 'anthropic' ? named : 'anthropic';
  return resolveConfig({ provider });
}

async function main(mode: '--authored' | '--live'): Promise<void> {
  if (mode === '--authored') {
    await writeCassettes({ inner: new AuthoredProvider(), provenance: AUTHORED_PROVENANCE });
    process.stdout.write(`wrote hand-authored cassettes to ${EVAL_RECORDED}\n`);
    return;
  }
  loadDotEnv();
  if (!shouldRunLive(process.env)) {
    throw new Error(
      'live re-record needs LIVE=1 and a provider key (ANTHROPIC_API_KEY or OPENROUTER_API_KEY). ' +
        'Pass --authored to regenerate the hand-authored cassettes instead.',
    );
  }
  const config = liveConfig(process.env);
  const inner = createProvider(config, loadApiKeys(process.env));
  await writeCassettes({
    inner,
    provenance: recordedProvenance(inner.id, new Date().toISOString()),
    leafModel: config.leafModel,
    rootModel: config.rootModel,
  });
  process.stdout.write(`re-recorded cassettes from ${inner.id} into ${EVAL_RECORDED}\n`);
}

/**
 * Script when a mode flag is passed, plain module otherwise. The flag is the
 * trigger rather than `process.argv[1]`, because vite-node leaves its own path
 * there — and an entry check that quietly never fires produces a recorder that
 * exits 0 having written nothing.
 */
const mode = process.argv.find((arg) => arg === '--authored' || arg === '--live');
if (mode !== undefined) {
  await main(mode as '--authored' | '--live');
}
