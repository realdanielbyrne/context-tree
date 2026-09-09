/**
 * §11 provider selection. Keys come from the environment only (never the
 * committed config file), so a selected provider whose key is absent is a
 * configuration error raised here rather than a 401 discovered mid-run.
 */
import { join } from 'node:path';
import type { ApiKeys, ContextTreeConfig } from '../config.js';
import type { ModelProvider } from '../contracts/index.js';
import { ConfigError } from '../contracts/index.js';
import { storePaths } from '../paths.js';
import { AnthropicProvider } from './anthropic.js';
import { MockProvider } from './mock.js';
import { OpenRouterProvider } from './openrouter.js';
import { RecordedProvider } from './recorded.js';
import type { RetryOptions } from './retry.js';

/** Cassette inside `storePaths().recorded` (§17). */
export const CASSETTE_FILENAME = 'completions.json';

export interface CreateProviderOptions {
  /** Set 0 with retry.attempts=1 to expose every local transport attempt to the caller. */
  sdkMaxRetries?: number;
  retry?: RetryOptions;
  /** Per-request timeout in ms. Omitted leaves the SDK default (10 minutes). */
  timeoutMs?: number;
}

export function createProvider(config: ContextTreeConfig, apiKeys: ApiKeys, options: CreateProviderOptions = {}): ModelProvider {
  switch (config.provider) {
    case 'anthropic': {
      const apiKey = apiKeys.anthropic;
      if (apiKey === undefined) {
        throw new ConfigError('provider "anthropic" selected but ANTHROPIC_API_KEY is not set');
      }
      return new AnthropicProvider({ apiKey, ...options });
    }
    case 'openrouter': {
      const apiKey = apiKeys.openrouter;
      if (apiKey === undefined) {
        throw new ConfigError('provider "openrouter" selected but OPENROUTER_API_KEY is not set');
      }
      return new OpenRouterProvider({ apiKey, ...options });
    }
    case 'mock':
      return new MockProvider({ reply: '' });
    case 'recorded':
      return new RecordedProvider(join(storePaths(config.root).recorded, CASSETTE_FILENAME));
  }
}
