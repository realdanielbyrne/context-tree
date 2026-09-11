/**
 * NOTE (deployment): this remote `/embeddings` client is the current default, but
 * remote-vs-local was NOT-CARRIED-FORWARD (a deployment choice, never A/B'd). The
 * intended deployment default is a LOCAL MiniLM-class embedder (hermetic, offline),
 * added as a `SummaryEmbedder` implementation without changing the ensemble
 * retriever, which is embedder-agnostic. `reports/session-handoff.md`.
 *
 * §11 embeddings client — the OpenAI-compatible `/embeddings` endpoint. Same
 * `openai` npm client `OpenRouterProvider` already uses for chat completions
 * (`openrouter.ts:66-77`), just pointed at `.embeddings.create()` instead of
 * `.chat.completions.create()`, so one client works against both
 * `api.openai.com` (`OPENAI_API_KEY`) and `openrouter.ai/api/v1`
 * (`OPENROUTER_API_KEY`) — whichever `baseURL`/`apiKey` the caller selects.
 *
 * Returns a `SummaryEmbedder` (`retrieve/types.ts:17`) so it plugs straight
 * into `TreeRetriever`: this module knows nothing about nodes, summaries or
 * L3, only how to turn strings into vectors and fail loud when the response
 * shape doesn't match what was sent.
 */
import OpenAI from 'openai';
import type { ApiKeys } from '../config.js';
import { ConfigError, ModelCallError } from '../contracts/index.js';
import type { SummaryEmbedder } from '../retrieve/types.js';
import { OPENROUTER_BASE_URL } from './openrouter.js';
import { withRetry, type RetryOptions } from './retry.js';

export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

export interface EmbeddingClientLike {
  embeddings: {
    create(
      params: OpenAI.Embeddings.EmbeddingCreateParams,
    ): Promise<OpenAI.Embeddings.CreateEmbeddingResponse>;
  };
}

export interface EmbeddingClientOptions {
  apiKey?: string;
  /** Defaults to `text-embedding-3-small`. */
  model?: string;
  /** Omit for `api.openai.com`; pass `OPENROUTER_BASE_URL` to embed via OpenRouter. */
  baseURL?: string;
  /** Injected in tests; a real client is constructed when absent. */
  client?: EmbeddingClientLike;
  retry?: RetryOptions;
}

/**
 * Builds a `SummaryEmbedder`. One `input` array is one request — batching is
 * "pass every text you want vectors for in one call", not internal chunking;
 * the s1 fixture's whole 22-summary store fits one request with room to spare
 * (`03-embeddings.md` §4), and nothing in this repo currently produces enough
 * summary text to need splitting.
 */
export function createEmbeddingClient(options: EmbeddingClientOptions = {}): SummaryEmbedder {
  const model = options.model ?? DEFAULT_EMBED_MODEL;
  const client: EmbeddingClientLike =
    options.client ?? new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
  const retry = options.retry ?? {};

  return async (texts: readonly string[]): Promise<Float32Array[]> => {
    const input = [...texts];
    const response = await withRetry(() => client.embeddings.create({ model, input }), {
      label: 'embeddings.create',
      ...retry,
    });

    const rows = response.data ?? [];
    if (rows.length !== input.length) {
      throw new ModelCallError(
        `embeddings.create returned ${rows.length} vector(s) for ${input.length} input(s)`,
      );
    }

    let dim: number | undefined;
    const vectors: Float32Array[] = [];
    for (const row of rows) {
      const vec = Float32Array.from(row.embedding);
      if (dim === undefined) {
        dim = vec.length;
      } else if (vec.length !== dim) {
        throw new ModelCallError(
          `embeddings.create returned mixed dimensions in one batch (${dim} and ${vec.length})`,
        );
      }
      vectors.push(vec);
    }
    return vectors;
  };
}

export interface EmbeddingClientFromKeysOptions {
  keys: ApiKeys;
  model?: string;
  /** Omit for `api.openai.com`; pass `OPENROUTER_BASE_URL` to embed via OpenRouter. */
  baseURL?: string;
  client?: EmbeddingClientLike;
  retry?: RetryOptions;
}

/**
 * `createEmbeddingClient`, but the API key is picked from `ApiKeys`
 * (`config.ts`) by `baseURL` rather than passed in already resolved:
 * `OPENAI_API_KEY` for the default host, `OPENROUTER_API_KEY` for
 * `OPENROUTER_BASE_URL`. One `baseURL` fully determines which host receives
 * the request, so it is also the one fact that should determine which key is
 * sent — a separate provider flag would just be a second way to say the same
 * thing and could disagree with it.
 */
export function createEmbeddingClientFromKeys(
  options: EmbeddingClientFromKeysOptions,
): SummaryEmbedder {
  const viaOpenRouter = options.baseURL === OPENROUTER_BASE_URL;
  const apiKey = viaOpenRouter ? options.keys.openrouter : options.keys.openai;
  if (apiKey === undefined) {
    throw new ConfigError(
      viaOpenRouter
        ? 'embedding via OpenRouter requires OPENROUTER_API_KEY'
        : 'embedding via api.openai.com requires OPENAI_API_KEY',
    );
  }
  return createEmbeddingClient({
    apiKey,
    model: options.model,
    baseURL: options.baseURL,
    client: options.client,
    retry: options.retry,
  });
}
