/**
 * Deterministic offline provider. M0–M2 run on zero LLM budget (§16), and the
 * cache-breakpoint and prompt-layout tests need to see exactly what was sent —
 * hence `requests`, which records every `CompletionRequest` verbatim.
 */
import type {
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  TokenUsage,
} from '../contracts/index.js';
import { ConfigError, ModelCallError } from '../contracts/index.js';
import { ZERO_USAGE } from './cost.js';

export interface MockProviderOptions {
  /** The same reply every call. */
  reply?: string;
  /** A reply computed from the request. */
  responder?: (request: CompletionRequest) => string;
  /** Replies in order; exhausting the queue is an error, never a silent repeat. */
  queue?: readonly string[];
  /** Reported for every call — lets a cost-meter test drive known arithmetic. */
  usage?: TokenUsage;
  stopReason?: string | null;
  id?: string;
}

export class MockProvider implements ModelProvider {
  readonly id: string;
  /** Every request this provider was handed, in call order. */
  readonly requests: CompletionRequest[] = [];
  private readonly options: MockProviderOptions;
  private readonly queue: string[];
  private served = 0;

  constructor(options: MockProviderOptions = {}) {
    const modes = [options.reply, options.responder, options.queue].filter(
      (mode) => mode !== undefined,
    );
    if (modes.length !== 1) {
      throw new ConfigError(
        'MockProvider needs exactly one of { reply, responder, queue }, got ' +
          `${modes.length}`,
      );
    }
    this.options = options;
    this.queue = [...(options.queue ?? [])];
    this.id = options.id ?? 'mock';
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    return {
      text: this.nextText(request),
      model: request.model,
      usage: this.options.usage ?? ZERO_USAGE,
      toolCalls: [],
      stopReason: this.options.stopReason ?? 'end_turn',
    };
  }

  private nextText(request: CompletionRequest): string {
    if (this.options.reply !== undefined) return this.options.reply;
    if (this.options.responder !== undefined) return this.options.responder(request);
    const next = this.queue[this.served];
    this.served += 1;
    if (next === undefined) {
      // Reusing the last reply would let a test that over-calls the model pass.
      throw new ModelCallError(
        `MockProvider queue exhausted after ${this.queue.length} reply(ies)`,
      );
    }
    return next;
  }
}
