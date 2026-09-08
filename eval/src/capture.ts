/** Durable, content-addressed evidence. Request bodies are captured at the
 * provider-neutral interface, not claimed to be the provider's HTTP wire bytes. */
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompletionRequest, CompletionResult, ModelProvider, TokenUsage } from '@context-tree/core';
import { EmptyCompletionError, hasKnownUsage } from '@context-tree/core';
import type { Sandbox } from './sandbox.js';
import { addTotals, ZERO_TOTALS } from './metrics.js';
import type { TokenTotals } from './types.js';

export class TokenBudgetExceeded extends Error {
  constructor(readonly spent: number, readonly limit: number) {
    super(`all-model token ceiling reached: ${spent} >= ${limit}`);
    this.name = 'TokenBudgetExceeded';
  }
}

export class RunCapture {
  private sequence = 0;
  private calls = 0;
  private errors = 0;
  private unknownUsage = false;
  private readonly unknownModels = new Set<string>();
  private readonly modelCalls = new Map<string, number>();
  private totals: TokenTotals = { ...ZERO_TOTALS };
  private agentTotals: TokenTotals = { ...ZERO_TOTALS };
  constructor(readonly directory: string | undefined, readonly tokenLimit?: number) {
    if (tokenLimit !== undefined && (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0)) throw new Error('tokenLimit must be a positive integer');
    if (directory !== undefined) {
      if (existsSync(join(directory, 'events.jsonl'))) throw new Error(`capture directory already contains a run: ${directory}`);
      mkdirSync(join(directory, 'blobs'), { recursive: true });
    }
  }

  blob(text: string): string {
    const digest = createHash('sha256').update(text).digest('hex');
    if (this.directory !== undefined) {
      const path = join(this.directory, 'blobs', digest);
      if (!existsSync(path)) writeFileSync(path, text);
    }
    return digest;
  }

  record(kind: string, value: unknown): void {
    const row = { seq: ++this.sequence, kind, value };
    if (this.directory !== undefined) appendFileSync(join(this.directory, 'events.jsonl'), `${JSON.stringify(row)}\n`);
  }

  snapshot(): { calls: number; providerErrors: number; allModels: TokenTotals; agent: TokenTotals; usageComplete: boolean; unknownUsageModels: string[]; callsByModel: Record<string, number> } {
    return { calls: this.calls, providerErrors: this.errors, allModels: { ...this.totals }, agent: { ...this.agentTotals }, usageComplete: !this.unknownUsage,
      unknownUsageModels: [...this.unknownModels].sort(), callsByModel: Object.fromEntries(this.modelCalls) };
  }

  provider(inner: ModelProvider, role: 'agent' | 'summarizer' | 'judge', window?: number): ModelProvider {
    const capture = this;
    return {
      id: `capture:${inner.id}`,
      ...(inner.embed === undefined ? {} : { embed: inner.embed.bind(inner) }),
      async complete(request: CompletionRequest): Promise<CompletionResult> {
        if (capture.tokenLimit !== undefined && capture.totals.total >= capture.tokenLimit) throw new TokenBudgetExceeded(capture.totals.total, capture.tokenLimit);
        const requestJson = JSON.stringify(request);
        const requestBlob = capture.blob(requestJson);
        const attempt = ++capture.calls;
        const recordModel = (model: string, known: boolean): void => {
          capture.modelCalls.set(model, (capture.modelCalls.get(model) ?? 0) + 1);
          if (!known) { capture.unknownUsage = true; capture.unknownModels.add(model); }
        };
        capture.record('request', { attempt, attemptScope: 'ModelProvider.complete', role, provider: inner.id, requestBlob, window, representation: 'CompletionRequest-v1' });
        let result: CompletionResult;
        try {
          // Copy so a provider cannot mutate the request retained for retries.
          result = await inner.complete(JSON.parse(requestJson) as CompletionRequest);
          if (result.text.trim() === '' && result.toolCalls.length === 0) {
            throw new EmptyCompletionError('EmptyModelResponse: no answer text or tool calls', result, hasKnownUsage(result));
          }
        } catch (error) {
          capture.errors++;
          if (error instanceof EmptyCompletionError) {
            const usageKnown = error.usageKnown && hasKnownUsage(error.result);
            recordModel(error.result.model, usageKnown);
            if (usageKnown) {
              capture.totals = addTotals(capture.totals, error.result.usage);
              if (role === 'agent') capture.agentTotals = addTotals(capture.agentTotals, error.result.usage);
            }
            capture.record('empty_completion', { attempt, role, requestBlob, responseBlob: capture.blob(JSON.stringify(error.result)), model: error.result.model, usage: usageKnown ? error.result.usage : null, usageKnown, error: String(error) });
          } else {
            recordModel(request.model, false);
            capture.record('provider_error', { attempt, role, requestBlob, model: request.model, error: String(error), usage: null });
          }
          throw error;
        }
        const usageKnown = hasKnownUsage(result);
        recordModel(result.model, usageKnown);
        if (usageKnown) {
          capture.totals = addTotals(capture.totals, result.usage);
          if (role === 'agent') capture.agentTotals = addTotals(capture.agentTotals, result.usage);
        } else result = { ...result, usageKnown: false };
        capture.record('response', { attempt, role, requestBlob, responseBlob: capture.blob(JSON.stringify(result)), usage: usageKnown ? result.usage : null, usageKnown, model: result.model });
        return result;
      },
    };
  }

  sandbox(inner: Sandbox): Sandbox {
    return {
      ...inner,
      run: async (command, timeoutMs) => {
        this.record('command', { command, timeoutMs });
        const result = await inner.run(command, timeoutMs);
        this.record('command_result', { ...result, stdout: this.blob(result.stdout), stderr: this.blob(result.stderr) });
        return result;
      },
      readFile: (path) => {
        const result = inner.readFile(path);
        this.record('read_file', { path, blob: this.blob(result) });
        return result;
      },
      writeFile: (path, content) => {
        inner.writeFile(path, content);
        this.record('write_file', { path, blob: this.blob(content) });
      },
    };
  }

  archiveStore(path: string): void {
    if (this.directory !== undefined && existsSync(path)) cpSync(path, join(this.directory, 'store'), { recursive: true });
    this.record('capture_complete', this.snapshot());
  }
}

export function sumUsage(values: readonly TokenUsage[]): TokenTotals {
  return values.reduce(addTotals, { ...ZERO_TOTALS });
}
