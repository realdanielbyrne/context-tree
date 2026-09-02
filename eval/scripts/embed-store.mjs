#!/usr/bin/env node
/**
 * G6 offline check (`eval/plans/loop9b-item2-judge-verdict.md` Step 5, Graft 4
 * from `03-embeddings.md` §6): populate L3 in a COPY of a frozen transplant
 * store with a real embeddings client, then print the rank at which each
 * question's source node comes back from `TreeRetriever.search(question)` —
 * the lexical-vs-semantic self-retrieval table the spec calls for, and the
 * number G6 gates a live `tree-semantic` arm on (strict top-5 >= 4/12, median
 * rank better than lexical's).
 *
 * NEVER touches the frozen fixture store: everything happens inside an
 * `mkdtemp()` copy of `<scenario>/store`, removed on exit unless `--keep` is
 * passed. This script only reads `<scenario>/<runHash>/questions.json`
 * (the sibling of `store/` under the scenario dir) — it writes nothing there.
 *
 * Usage:
 *   OPENAI_API_KEY=... node eval/scripts/embed-store.mjs --scenario s1
 *   OPENROUTER_API_KEY=... node eval/scripts/embed-store.mjs --scenario s1 \
 *     --base-url https://openrouter.ai/api/v1 --model openai/text-embedding-3-small
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import {
  DEFAULT_EMBED_MODEL,
  FsBlobStore,
  JsonlTraceLog,
  OPENROUTER_BASE_URL,
  TreeRetriever,
  createEmbeddingClient,
  loadApiKeys,
  loadDotEnv,
  openStore,
  priceFor,
  storePaths,
} from '@context-tree/core';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURES = join(REPO, 'eval/fixtures/transplant');
/** Generous relative to this fixture's ~22 summarized nodes (manifest.json). */
const DEFAULT_RANK_LIMIT = 30;

function parseArgs(argv) {
  const args = {
    scenario: 's1',
    model: undefined,
    baseURL: undefined,
    limit: DEFAULT_RANK_LIMIT,
    keep: false,
    questions: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scenario') args.scenario = argv[(i += 1)];
    else if (arg === '--model') args.model = argv[(i += 1)];
    else if (arg === '--base-url') args.baseURL = argv[(i += 1)];
    else if (arg === '--limit') args.limit = Number(argv[(i += 1)]);
    else if (arg === '--keep') args.keep = true;
    // Overrides the auto-discovered sibling questions.json (rarely needed —
    // mainly for pointing at a questions.json outside this checkout).
    else if (arg === '--questions') args.questions = argv[(i += 1)];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** `questions.json` lives at `<scenario>/<runHash>/questions.json`, a sibling of `store/`. */
function findQuestionsPath(scenarioDir) {
  for (const entry of readdirSync(scenarioDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(scenarioDir, entry.name, 'questions.json');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no questions.json found under ${scenarioDir}/*/questions.json`);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Wraps the real client to total the `usage.total_tokens` OpenAI reports, for a real (not estimated) cost figure. */
function withUsageMeter(client, meter) {
  return {
    embeddings: {
      create: async (params) => {
        const response = await client.embeddings.create(params);
        meter.calls += 1;
        meter.tokens += response.usage?.total_tokens ?? 0;
        return response;
      },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(REPO);
  const keys = loadApiKeys();

  const viaOpenRouter = args.baseURL === OPENROUTER_BASE_URL;
  const apiKey = viaOpenRouter ? keys.openrouter : keys.openai;
  if (apiKey === undefined) {
    throw new Error(
      viaOpenRouter ? 'OPENROUTER_API_KEY is not set' : 'OPENAI_API_KEY is not set',
    );
  }

  const scenarioDir = join(FIXTURES, args.scenario);
  const frozenStore = join(scenarioDir, 'store');
  if (!existsSync(frozenStore)) throw new Error(`no store at ${frozenStore}`);
  const questionsPath = args.questions ?? findQuestionsPath(scenarioDir);
  const { questions } = JSON.parse(readFileSync(questionsPath, 'utf8'));

  // Never touch the frozen fixture: embed a throwaway copy.
  const copyRoot = mkdtempSync(join(tmpdir(), 'ct-embed-'));
  const storeCopy = join(copyRoot, 'store');
  cpSync(frozenStore, storeCopy, { recursive: true });
  console.log(`operating on a copy: ${storeCopy} (frozen fixture untouched)`);

  const paths = storePaths(storeCopy);
  const trace = new JsonlTraceLog(paths.trace);
  const blobs = new FsBlobStore(paths.blobs);
  const store = openStore(paths.db);
  const usage = { calls: 0, tokens: 0 };

  try {
    const model = args.model ?? DEFAULT_EMBED_MODEL;
    const rawClient = new OpenAI({ apiKey, baseURL: args.baseURL });
    const embed = createEmbeddingClient({
      model,
      client: withUsageMeter(rawClient, usage),
    });
    const retriever = new TreeRetriever({ store, blobs, trace, embed });

    const embedResult = await retriever.embedSummaries();
    console.log(
      `embedSummaries: embedded ${embedResult.embedded.length}, skipped ${embedResult.skipped.length} (model ${model}${args.baseURL ? `, ${args.baseURL}` : ''})`,
    );

    const rows = [];
    for (const question of questions) {
      const result = await retriever.search(question.question, { limit: args.limit });
      // Mirrors the lexical g15 gate's convention: the task root is excluded
      // from ranking (it is not a candidate "source" any question points at).
      const ranked = result.hits.filter((hit) => hit.kind !== 'task');
      const position = ranked.findIndex((hit) => hit.nodeId === question.node_id);
      rows.push({
        id: question.id,
        stratum: question.stratum,
        path: result.path,
        rank: position === -1 ? null : position + 1,
        ranked: ranked.length,
      });
    }

    const ranks = rows.map((row) => row.rank).filter((rank) => rank !== null);
    const strictTop5 = ranks.filter((rank) => rank <= 5).length;

    console.log('\nid               stratum     path    rank/ranked');
    for (const row of rows) {
      console.log(
        `${row.id.padEnd(16)} ${row.stratum.padEnd(11)} ${row.path.padEnd(7)} ${row.rank ?? 'absent'}/${row.ranked}`,
      );
    }
    console.log(`\nstrict top-5: ${strictTop5}/${rows.length}`);
    console.log(`median rank: ${median(ranks) ?? 'n/a'} (of ${rows.length} ranked questions)`);

    const price = priceFor(model);
    const usd = (usage.tokens / 1_000_000) * price.price.input;
    console.log(
      `\ncost: ${usage.calls} call(s), ${usage.tokens} token(s) reported by the API, ` +
        `$${usd.toFixed(6)} at ${price.matched ?? '(fallback rate)'} pricing`,
    );
  } finally {
    store.close();
    trace.close();
    if (args.keep) console.log(`\n--keep: store copy left at ${copyRoot}`);
    else rmSync(copyRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`${error.constructor.name}: ${error.message}`);
  process.exitCode = 1;
});
