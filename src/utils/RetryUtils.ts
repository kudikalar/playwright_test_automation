/**
 * Retry policy for genuinely transient operations (network blips, eventual consistency).
 *
 * Rule 23: retries must not mask defects. These helpers retry only what a caller explicitly
 * declares retryable, cap the attempts, and surface every attempt in the final error.
 */

import { createLogger } from './Logger';
import { FrameworkError } from './FrameworkError';

const log = createLogger('RetryUtils');

export interface RetryOptions {
  /** Total attempts including the first. */
  readonly maxAttempts?: number;
  /** Base delay; grows exponentially with jitter. */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly description?: string;
  /** Decides whether a given failure is worth retrying. Defaults to "never". */
  readonly retryOn?: (error: unknown, attempt: number) => boolean;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Exponential backoff with full jitter, capped at `maxDelayMs`. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(Math.random() * exponential);
}

/** Runs `operation`, retrying only failures accepted by `retryOn`. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 4_000;
  const description = options.description ?? 'operation';
  const retryOn = options.retryOn ?? ((): boolean => false);

  const failures: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`attempt ${attempt}: ${message}`);

      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt || !retryOn(error, attempt)) {
        if (attempt > 1) {
          throw new FrameworkError(
            `${description} failed after ${attempt} attempt(s)`,
            { operation: 'withRetry', target: description, attempts: failures },
            error,
          );
        }
        throw error;
      }

      const wait = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      log.warn(`${description} failed, retrying in ${wait}ms`, { attempt, maxAttempts, message });
      await delay(wait);
    }
  }

  /* Unreachable: the loop either returns or throws. */
  throw new FrameworkError('Retry loop exited unexpectedly', {
    operation: 'withRetry',
    target: description,
  });
}

/**
 * Polls until `operation` produces a value satisfying `until` — for reading back
 * eventually-consistent state (a record created through the API appearing in a list).
 */
export async function pollUntil<T>(
  operation: () => Promise<T>,
  until: (value: T) => boolean,
  options: RetryOptions & { readonly intervalMs?: number } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const intervalMs = options.intervalMs ?? 300;
  const description = options.description ?? 'value';

  let last: T | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await operation();
    if (until(last)) return last;
    if (attempt < maxAttempts) await delay(intervalMs);
  }

  throw new FrameworkError('Polled value never satisfied the condition', {
    operation: 'pollUntil',
    target: description,
    attempts: maxAttempts,
    actual: JSON.stringify(last)?.slice(0, 500),
  });
}
