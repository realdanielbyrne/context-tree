/**
 * §11 shared retry policy. Both live providers use this one implementation so
 * their failure behavior cannot drift apart.
 *
 * Only 429, 5xx and transport failures are retried. A 400 retried is still a
 * 400, and each retry of it spends against the §16 per-PR cost cap for nothing.
 * `sleep` and `random` are injected because a jitter assertion that calls the
 * real clock and the real `Math.random` can neither be fast nor deterministic.
 */
import { ConfigError, ModelCallError } from '../contracts/index.js';

export interface RetryOptions {
  /** Total attempts, not extra retries. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Uniform in [0, 1). */
  random?: () => number;
  /** Names the operation in the thrown `ModelCallError`. */
  label?: string;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * An absent status means the request never got an HTTP response (DNS, reset
 * socket, timeout), which is the retryable case by definition.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 429 || (status >= 500 && status < 600);
}

/** HTTP status off an SDK error, read structurally so both SDKs work. */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** `retry-after` in ms, from either a `Headers` instance or a plain record. */
export function retryAfterMs(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const headers = (error as { headers?: unknown }).headers;
  let raw: unknown;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    raw = headers.get('retry-after');
  } else if (typeof headers === 'object' && headers !== null) {
    raw = (headers as Record<string, unknown>)['retry-after'];
  }
  if (raw === null || raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/** Full jitter: uniform in [0, ceiling), where the ceiling doubles per attempt. */
export function backoffDelayMs(
  attempt: number,
  random: () => number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new ConfigError(`retry attempts must be an integer >= 1, got ${String(attempts)}`);
  }
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const label = options.label ?? 'model call';

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = httpStatusOf(error);
      if (!isRetryableStatus(status) || attempt >= attempts) {
        throw new ModelCallError(
          `${label} failed after ${attempt} attempt(s): ${describe(error)}`,
          status,
        );
      }
      // A server-sent `retry-after` beats our guess — it is the only number that
      // knows when the rate limit window actually reopens.
      const explicit = retryAfterMs(error);
      await sleep(explicit ?? backoffDelayMs(attempt, random, options.baseDelayMs, options.maxDelayMs));
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
