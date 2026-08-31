/**
 * §17 contract-test providers: "prompts tested against recorded completions (no
 * network in CI); `LIVE=1` opt-in suite hits real models".
 *
 * `RecordedProvider` replays a cassette; `RecordingProvider` writes one by
 * wrapping a live provider, so re-recording is a flag rather than hand-edited
 * JSON. A cassette miss is loud and names the key, the path and the remedy —
 * a silent fallback to a stub reply would make a prompt regression invisible.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  TokenUsage,
} from '../contracts/index.js';
import { ConfigError, ModelCallError } from '../contracts/index.js';

export type Cassette = Record<string, CompletionResult>;

const KEY_VERSION = 'ctk1';

/**
 * Hashes only the semantically meaningful fields, listed positionally: the key
 * must never depend on a timestamp or on the incidental key order of a
 * `JSON.stringify` over the whole request object.
 *
 * Deliberately excluded: `cacheBreakpoint` (a caching marker — it cannot change
 * the completion, and moving one must not invalidate the corpus), and
 * `maxTokens` / `temperature` / `tools` (the §17 corpus is the §8 summary
 * prompts, which pass no tools; re-record if a cassette ever covers tool use).
 */
export function requestKey(request: CompletionRequest): string {
  const canonical = JSON.stringify([
    KEY_VERSION,
    request.model,
    request.system ?? null,
    request.messages.map((message) => [message.role, message.content]),
    request.json === true,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export function readCassette(path: string): Cassette {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(
      `cassette not found: ${path} — re-record with LIVE=1 (RecordingProvider writes this file)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`cassette ${path}: invalid JSON — ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`cassette ${path}: expected a JSON object of key -> CompletionResult`);
  }
  const cassette: Cassette = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    cassette[key] = parseResult(value, `cassette ${path} entry ${key}`);
  }
  return cassette;
}

/** Keys sorted so a re-record shows up as a reviewable diff. */
export function writeCassette(path: string, cassette: Cassette): void {
  mkdirSync(dirname(path), { recursive: true });
  const sorted: Cassette = {};
  for (const key of Object.keys(cassette).sort()) {
    const entry = cassette[key];
    if (entry !== undefined) sorted[key] = entry;
  }
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

export class RecordedProvider implements ModelProvider {
  readonly id = 'recorded';
  private cassette: Cassette | null = null;

  /** The cassette is read on first use, so constructing one touches no disk. */
  constructor(readonly cassettePath: string) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.cassette ??= readCassette(this.cassettePath);
    const key = requestKey(request);
    const hit = this.cassette[key];
    if (hit === undefined) {
      throw new ModelCallError(
        `no recorded completion for request key ${key} in cassette ${this.cassettePath} — ` +
          're-record with LIVE=1 (RecordingProvider writes this file)',
      );
    }
    return hit;
  }
}

export class RecordingProvider implements ModelProvider {
  readonly id: string;

  constructor(
    private readonly inner: ModelProvider,
    readonly cassettePath: string,
  ) {
    this.id = `recording:${inner.id}`;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const result = await this.inner.complete(request);
    // Read-modify-write per call: the §8 summarizer records up to 8 completions
    // concurrently, and a cassette loaded once at construction would let the
    // last writer drop everything the others recorded. The sync fs calls make
    // the read-modify-write atomic against other pending tasks.
    const cassette = existsSync(this.cassettePath) ? readCassette(this.cassettePath) : {};
    cassette[requestKey(request)] = result;
    writeCassette(this.cassettePath, cassette);
    return result;
  }
}

function parseResult(value: unknown, where: string): CompletionResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${where}: expected an object`);
  }
  const raw = value as Record<string, unknown>;
  const stopReason = raw.stopReason ?? null;
  if (stopReason !== null && typeof stopReason !== 'string') {
    throw new ConfigError(`${where}: stopReason must be a string or null`);
  }
  return {
    text: requireString(raw.text, `${where}.text`),
    model: requireString(raw.model, `${where}.model`),
    usage: parseUsage(raw.usage, `${where}.usage`),
    toolCalls: parseToolCalls(raw.toolCalls, `${where}.toolCalls`),
    stopReason,
  };
}

function parseUsage(value: unknown, where: string): TokenUsage {
  if (typeof value !== 'object' || value === null) {
    throw new ConfigError(`${where}: expected an object`);
  }
  const raw = value as Record<string, unknown>;
  return {
    input: requireNumber(raw.input, `${where}.input`),
    output: requireNumber(raw.output, `${where}.output`),
    cacheRead: requireNumber(raw.cacheRead, `${where}.cacheRead`),
    cacheWrite: requireNumber(raw.cacheWrite, `${where}.cacheWrite`),
  };
}

function parseToolCalls(value: unknown, where: string): CompletionResult['toolCalls'] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${where}: expected an array`);
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigError(`${where}[${index}]: expected an object`);
    }
    const raw = entry as Record<string, unknown>;
    const input = raw.input;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ConfigError(`${where}[${index}].input: expected an object`);
    }
    return {
      id: requireString(raw.id, `${where}[${index}].id`),
      name: requireString(raw.name, `${where}[${index}].name`),
      input: input as Record<string, unknown>,
    };
  });
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new ConfigError(`${where}: expected a string`);
  return value;
}

function requireNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`${where}: expected a finite number`);
  }
  return value;
}
