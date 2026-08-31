/**
 * §11 model providers. Nothing here is ever fine-tuned; both summarizer roles
 * are plain hosted models behind one interface so Anthropic, OpenRouter and the
 * recorded/mock provider are interchangeable in tests.
 */

export type ModelRole = 'leaf' | 'root' | 'judge' | 'embed';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Emit a provider-native cache breakpoint after this message (§10 rule 5).
   * Anthropic: `cache_control: {type: 'ephemeral'}`; OpenRouter: passed through
   * where the upstream provider supports it.
   */
  cacheBreakpoint?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  input_schema: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: readonly ToolSchema[];
  /** Ask for a JSON object back — used by the structured-summary prompts. */
  json?: boolean;
  /**
   * Emit a provider-native cache breakpoint after the `system` block — the Zone
   * A/B boundary of §10 rule 5. Zone A (the frozen system contract plus the four
   * §9 tool schemas) ships as `system`, not as a message, so no
   * `ChatMessage.cacheBreakpoint` can express that boundary: without this flag
   * the largest permanently-cacheable segment in the prompt is re-read as fresh
   * input every turn and D5's saving is silently forfeited.
   */
  systemCacheBreakpoint?: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage: TokenUsage;
  toolCalls: ToolCallRequest[];
  stopReason: string | null;
}

export interface ModelProvider {
  readonly id: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** Absent when the provider offers no embedding endpoint. */
  embed?(texts: readonly string[], model: string): Promise<Float32Array[]>;
}

export interface CostEntry {
  model: string;
  calls: number;
  usage: TokenUsage;
  usd: number;
}

export interface CostSnapshot {
  entries: CostEntry[];
  totalUsd: number;
  capUsd: number | null;
}

/** Per-run spend meter. §16 caps per-PR spend through this. */
export interface CostMeter {
  record(model: string, usage: TokenUsage): void;
  snapshot(): CostSnapshot;
  totalUsd(): number;
  /** Throws `CostCapExceededError` once the cap is passed. */
  assertUnderCap(): void;
}
