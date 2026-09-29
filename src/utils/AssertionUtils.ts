/**
 * Assertion helpers.
 *
 * Rule 20: assertions are Playwright's auto-retrying, web-first `expect` — these helpers add
 * business meaning and a consistent failure message, never a manual retry loop.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import type { ApiResponse } from '../types/ApiModels';
import { ValidationError } from './FrameworkError';

export interface AssertOptions {
  readonly timeout?: number;
  /** Overrides the generated failure message. */
  readonly message?: string;
}

const describeLocator = (locator: Locator): string => String(locator);

/* ------------------------------------------------------------------- UI -- */

export async function assertVisible(locator: Locator, options: AssertOptions = {}): Promise<void> {
  await expect(
    locator,
    options.message ?? `Expected ${describeLocator(locator)} to be visible`,
  ).toBeVisible({ timeout: options.timeout });
}

export async function assertHidden(locator: Locator, options: AssertOptions = {}): Promise<void> {
  await expect(
    locator,
    options.message ?? `Expected ${describeLocator(locator)} to be hidden`,
  ).toBeHidden({
    timeout: options.timeout,
  });
}

export async function assertText(
  locator: Locator,
  expected: string | RegExp,
  options: AssertOptions = {},
): Promise<void> {
  await expect(locator, options.message ?? `Expected text ${String(expected)}`).toHaveText(
    expected,
    {
      timeout: options.timeout,
    },
  );
}

export async function assertContainsText(
  locator: Locator,
  expected: string | RegExp,
  options: AssertOptions = {},
): Promise<void> {
  await expect(locator, options.message ?? `Expected to contain ${String(expected)}`).toContainText(
    expected,
    {
      timeout: options.timeout,
    },
  );
}

export async function assertValue(
  locator: Locator,
  expected: string | RegExp,
  options: AssertOptions = {},
): Promise<void> {
  await expect(locator, options.message ?? `Expected value ${String(expected)}`).toHaveValue(
    expected,
    {
      timeout: options.timeout,
    },
  );
}

export async function assertAttribute(
  locator: Locator,
  attribute: string,
  expected: string | RegExp,
  options: AssertOptions = {},
): Promise<void> {
  await expect(
    locator,
    options.message ?? `Expected attribute ${attribute} to be ${String(expected)}`,
  ).toHaveAttribute(attribute, expected, { timeout: options.timeout });
}

export async function assertCount(
  locator: Locator,
  expected: number,
  options: AssertOptions = {},
): Promise<void> {
  await expect(locator, options.message ?? `Expected ${expected} element(s)`).toHaveCount(
    expected,
    {
      timeout: options.timeout,
    },
  );
}

export async function assertEnabled(locator: Locator, options: AssertOptions = {}): Promise<void> {
  await expect(locator, options.message ?? 'Expected element to be enabled').toBeEnabled({
    timeout: options.timeout,
  });
}

export async function assertDisabled(locator: Locator, options: AssertOptions = {}): Promise<void> {
  await expect(locator, options.message ?? 'Expected element to be disabled').toBeDisabled({
    timeout: options.timeout,
  });
}

export async function assertChecked(
  locator: Locator,
  checked = true,
  options: AssertOptions = {},
): Promise<void> {
  await expect(locator, options.message ?? `Expected checked=${checked}`).toBeChecked({
    checked,
    timeout: options.timeout,
  });
}

export async function assertUrl(
  page: Page,
  expected: string | RegExp,
  options: AssertOptions = {},
): Promise<void> {
  await expect(page, options.message ?? `Expected URL ${String(expected)}`).toHaveURL(expected, {
    timeout: options.timeout,
  });
}

export async function assertTitle(
  page: Page,
  expected: string | RegExp,
  options: AssertOptions = {},
): Promise<void> {
  await expect(page, options.message ?? `Expected title ${String(expected)}`).toHaveTitle(
    expected,
    {
      timeout: options.timeout,
    },
  );
}

/* ------------------------------------------------------------------ API -- */

export function assertStatus<T>(response: ApiResponse<T>, expected: number): void {
  expect(
    response.status,
    `${response.method} ${response.url} expected HTTP ${expected}, received ${response.status}. ` +
      `Body: ${JSON.stringify(response.body).slice(0, 400)}`,
  ).toBe(expected);
}

export function assertOneOfStatus<T>(response: ApiResponse<T>, expected: readonly number[]): void {
  expect(
    expected.includes(response.status),
    `${response.method} ${response.url} expected one of [${expected.join(', ')}], received ${response.status}`,
  ).toBe(true);
}

export function assertSuccessEnvelope<T>(response: ApiResponse<T>): T {
  expect(
    response.body.success,
    `Expected a success envelope, received ${JSON.stringify(response.body)}`,
  ).toBe(true);
  if (response.data === undefined) {
    throw new ValidationError('Success envelope carried no data', {
      operation: 'assertSuccessEnvelope',
      url: response.url,
      actual: JSON.stringify(response.body).slice(0, 400),
    });
  }
  return response.data;
}

export function assertErrorEnvelope<T>(response: ApiResponse<T>, expectedCode?: string): void {
  expect(response.body.success, `Expected an error envelope for ${response.url}`).toBe(false);
  expect(response.error, `Expected an error object for ${response.url}`).toBeDefined();
  if (expectedCode) {
    expect(response.error?.code, `Expected error code ${expectedCode}`).toBe(expectedCode);
  }
}

export function assertResponseTimeUnder<T>(response: ApiResponse<T>, budgetMs: number): void {
  expect(
    response.durationMs,
    `${response.method} ${response.url} took ${response.durationMs}ms, budget ${budgetMs}ms`,
  ).toBeLessThanOrEqual(budgetMs);
}

/** Asserts a subset of properties on an object, reporting every mismatch at once. */
export function assertMatchesSubset<T extends Record<string, unknown>>(
  actual: T,
  expectedSubset: Partial<Record<keyof T, unknown>>,
  label = 'object',
): void {
  const mismatches = Object.entries(expectedSubset)
    .filter(([key, value]) => JSON.stringify(actual[key as keyof T]) !== JSON.stringify(value))
    .map(
      ([key, value]) =>
        `${key}: expected ${JSON.stringify(value)}, actual ${JSON.stringify(actual[key as keyof T])}`,
    );

  expect(
    mismatches,
    `${label} did not match expected subset:\n  ${mismatches.join('\n  ')}`,
  ).toEqual([]);
}

/* --------------------------------------------------------------- soft -- */

/**
 * Collects several non-fatal checks and fails once at the end, so a report shows every
 * broken expectation rather than only the first.
 */
export class SoftAssertions {
  private readonly failures: string[] = [];

  public check(condition: boolean, message: string): void {
    if (!condition) this.failures.push(message);
  }

  public async checkAsync(assertion: () => Promise<void>, message: string): Promise<void> {
    try {
      await assertion();
    } catch (error) {
      this.failures.push(`${message} (${(error as Error).message.split('\n')[0]})`);
    }
  }

  public get failureCount(): number {
    return this.failures.length;
  }

  /** Fails the test if anything was collected. Call once at the end of a step. */
  public assertAll(label = 'Soft assertions'): void {
    expect(
      this.failures,
      `${label} recorded ${this.failures.length} failure(s):\n  ${this.failures.join('\n  ')}`,
    ).toEqual([]);
  }
}
