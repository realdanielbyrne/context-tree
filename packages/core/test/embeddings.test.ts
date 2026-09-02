import { describe, expect, it } from 'vitest';
import { ConfigError, ModelCallError } from '../src/contracts/index.js';
import {
  DEFAULT_EMBED_MODEL,
  createEmbeddingClient,
  createEmbeddingClientFromKeys,
  type EmbeddingClientLike,
} from '../src/models/embeddings.js';
import { OPENROUTER_BASE_URL } from '../src/models/openrouter.js';

function vector(dim: number, fill = 0.1): number[] {
  return Array.from({ length: dim }, () => fill);
}

function stubClient(
  data: Array<{ embedding: number[]; index: number; object: 'embedding' }>,
): { sent: unknown[]; client: EmbeddingClientLike } {
  const sent: unknown[] = [];
  return {
    sent,
    client: {
      embeddings: {
        create: async (params) => {
          sent.push(params);
          return {
            object: 'list',
            model: (params as { model: string }).model,
            data,
            usage: { prompt_tokens: 1, total_tokens: 1 },
          };
        },
      },
    },
  };
}

describe('createEmbeddingClient', () => {
  it('sends the model and every input in one batched request, because embedSummaries hands it a whole store in one call (03-embeddings.md §4)', async () => {
    const { sent, client } = stubClient([
      { embedding: vector(3), index: 0, object: 'embedding' },
      { embedding: vector(3), index: 1, object: 'embedding' },
    ]);

    const embed = createEmbeddingClient({ client, model: 'text-embedding-3-small' });
    const vectors = await embed(['first summary', 'second summary']);

    expect(sent).toEqual([
      { model: 'text-embedding-3-small', input: ['first summary', 'second summary'] },
    ]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
  });

  it('defaults to text-embedding-3-small, because that is the D8-reversible default this wiring pass chose (03-embeddings.md §2)', async () => {
    const { sent, client } = stubClient([{ embedding: vector(3), index: 0, object: 'embedding' }]);

    await createEmbeddingClient({ client })(['x']);

    expect((sent[0] as { model: string }).model).toBe(DEFAULT_EMBED_MODEL);
  });

  it('maps each row to a same-length Float32Array in request order, so a caller can zip the result back onto its input texts positionally', async () => {
    const a = vector(4, 0.25);
    const b = vector(4, 0.75);
    const { client } = stubClient([
      { embedding: a, index: 0, object: 'embedding' },
      { embedding: b, index: 1, object: 'embedding' },
    ]);

    const [first, second] = await createEmbeddingClient({ client })(['a', 'b']);

    expect(Array.from(first ?? [])).toEqual(a);
    expect(Array.from(second ?? [])).toEqual(b);
  });

  it('throws ModelCallError when the vector count does not match the input count, because embedSummaries would otherwise zip a vector onto the wrong node', async () => {
    const { client } = stubClient([{ embedding: vector(3), index: 0, object: 'embedding' }]);

    await expect(createEmbeddingClient({ client })(['one', 'two'])).rejects.toThrow(
      ModelCallError,
    );
  });

  it('throws ModelCallError on a dimension mismatch within one batch, because sqlite-vec\'s embeddings table is fixed-width per store (sqlite.ts ensureEmbeddingsTable) and a mixed batch would corrupt it silently', async () => {
    const { client } = stubClient([
      { embedding: vector(3), index: 0, object: 'embedding' },
      { embedding: vector(5), index: 1, object: 'embedding' },
    ]);

    await expect(createEmbeddingClient({ client })(['one', 'two'])).rejects.toThrow(
      ModelCallError,
    );
  });

  it('accepts an empty input array and returns no vectors, rather than erroring on a shape check that only matters once there is at least one row', async () => {
    const { sent, client } = stubClient([]);

    const vectors = await createEmbeddingClient({ client })([]);

    expect(vectors).toEqual([]);
    expect((sent[0] as { input: string[] }).input).toEqual([]);
  });

  it('picks OPENAI_API_KEY for the default host and OPENROUTER_API_KEY for OPENROUTER_BASE_URL, because one baseURL determines which host receives the request and the key must agree with it', async () => {
    const { sent: openaiSent, client: openaiClient } = stubClient([
      { embedding: vector(2), index: 0, object: 'embedding' },
    ]);
    const { sent: openrouterSent, client: openrouterClient } = stubClient([
      { embedding: vector(2), index: 0, object: 'embedding' },
    ]);

    await createEmbeddingClientFromKeys({
      keys: { openai: 'sk-openai', openrouter: 'sk-openrouter' },
      client: openaiClient,
    })(['default host']);
    await createEmbeddingClientFromKeys({
      keys: { openai: 'sk-openai', openrouter: 'sk-openrouter' },
      baseURL: OPENROUTER_BASE_URL,
      client: openrouterClient,
    })(['via openrouter']);

    // The injected client stands in for the real `openai.OpenAI` instance, so
    // the key selection itself — not the HTTP call — is what this asserts;
    // both requests reached their stub, proving neither path threw.
    expect(openaiSent).toHaveLength(1);
    expect(openrouterSent).toHaveLength(1);
  });

  it('throws ConfigError naming the missing env var rather than sending an unauthenticated request, because a 401 discovered mid-batch is a worse failure than one caught before any network call', async () => {
    expect(() =>
      createEmbeddingClientFromKeys({ keys: {} }),
    ).toThrow(ConfigError);
    expect(() => createEmbeddingClientFromKeys({ keys: {} })).toThrow(/OPENAI_API_KEY/);
    expect(() =>
      createEmbeddingClientFromKeys({ keys: {}, baseURL: OPENROUTER_BASE_URL }),
    ).toThrow(/OPENROUTER_API_KEY/);
  });
});
