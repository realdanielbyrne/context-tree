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

/** Cassette inside `storePaths().recorded` (§17). */
export const CASSETTE_FILENAME = 'completions.json';

export function createProvider(config: ContextTreeConfig, apiKeys: ApiKeys): ModelProvider {
  switch (config.provider) {
    case 'anthropic': {
      const apiKey = apiKeys.anthropic;
      if (apiKey === undefined) {
        throw new ConfigError('provider "anthropic" selected but ANTHROPIC_API_KEY is not set');
      }
      return new AnthropicProvider({ apiKey });
    }
    case 'openrouter': {
      const apiKey = apiKeys.openrouter;
      if (apiKey === undefined) {
        throw new ConfigError('provider "openrouter" selected but OPENROUTER_API_KEY is not set');
      }
      return new OpenRouterProvider({ apiKey });
    }
    case 'mock':
      return new MockProvider({ reply: '' });
    case 'recorded':
      return new RecordedProvider(join(storePaths(config.root).recorded, CASSETTE_FILENAME));
  }
}
