/**
 * Condition-based waiting.
 *
 * Rule 5: no arbitrary sleeps. Playwright's auto-waiting covers element readiness; these helpers
 * exist for the cases it cannot express — a computed condition, a network idle window, or a
 * business event such as "the table finished re-querying".
 */

import type { Page, Response } from '@playwright/test';

import { DEFAULT_TIMEOUTS } from '../constants/FrameworkConstants';
import { UiActionError } from './FrameworkError';

export interface WaitOptions {
  readonly timeout?: number;
  /** Interval between condition evaluations. */
  readonly pollIntervalMs?: number;
  /** Human-readable description used in the failure message. */
  readonly description?: string;
}

/**
 * Polls a predicate until it returns true. Prefer a web-first assertion or a Playwright
 * `waitFor*` when one exists; reach for this only for computed conditions.
 */
export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  options: WaitOptions = {},
): Promise<void> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUTS.shortPoll;
  const interval = options.pollIntervalMs ?? 100;
  const description = options.description ?? 'condition';
  const deadline = Date.now() + timeout;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval));
  }

  throw new UiActionError(
    'Timed out waiting for condition',
    {
      operation: 'waitForCondition',
      target: description,
      expected: 'predicate to return true',
      timeout,
    },
    lastError,
  );
}

/** Waits for the response to a business API call matching a URL fragment. */
export async function waitForApiResponse(
  page: Page,
  urlFragment: string,
  options: WaitOptions & { readonly status?: number } = {},
): Promise<Response> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUTS.navigation;
  try {
    return await page.waitForResponse(
      (response) =>
        response.url().includes(urlFragment) &&
        (options.status === undefined || response.status() === options.status),
      { timeout },
    );
  } catch (error) {
    throw new UiActionError(
      'Timed out waiting for API response',
      {
        operation: 'waitForApiResponse',
        target: urlFragment,
        expected: options.status ? `status ${options.status}` : 'any response',
        url: page.url(),
        timeout,
      },
      error,
    );
  }
}

/** Waits until no network request has been in flight for the given quiet period. */
export async function waitForNetworkIdle(page: Page, options: WaitOptions = {}): Promise<void> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUTS.navigation;
  try {
    await page.waitForLoadState('networkidle', { timeout });
  } catch (error) {
    throw new UiActionError(
      'Page never reached network idle',
      { operation: 'waitForNetworkIdle', url: page.url(), timeout },
      error,
    );
  }
}

/** Waits for a page-level function to evaluate truthy inside the browser. */
export async function waitForFunction(
  page: Page,
  pageFunction: string,
  options: WaitOptions = {},
): Promise<void> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUTS.shortPoll;
  try {
    await page.waitForFunction(pageFunction, undefined, { timeout });
  } catch (error) {
    throw new UiActionError(
      'Browser-side condition never became true',
      { operation: 'waitForFunction', target: pageFunction, url: page.url(), timeout },
      error,
    );
  }
}

/**
 * Waits for a value produced by `read` to stop changing — useful after a debounce, where the
 * alternative would be an arbitrary sleep.
 */
export async function waitForStableValue<T>(
  read: () => Promise<T>,
  options: WaitOptions & { readonly stableForMs?: number } = {},
): Promise<T> {
  const stableFor = options.stableForMs ?? 300;
  const interval = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUTS.shortPoll);

  let previous = await read();
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval));
    const current = await read();
    if (JSON.stringify(current) === JSON.stringify(previous)) {
      if (Date.now() - stableSince >= stableFor) return current;
    } else {
      previous = current;
      stableSince = Date.now();
    }
  }

  throw new UiActionError('Value never stabilised', {
    operation: 'waitForStableValue',
    target: options.description ?? 'value',
    expected: `no change for ${stableFor}ms`,
  });
}
