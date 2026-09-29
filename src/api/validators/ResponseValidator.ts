/**
 * Fluent response validation.
 *
 * Chains the checks an API test repeats — status, headers, envelope, body properties, types,
 * arrays, response time — with failure messages that name the endpoint and show the payload.
 */

import { expect } from '@playwright/test';

import type { ApiResponse } from '../../types/ApiModels';
import type { JsonSchema } from '../models/schemas';
import { assertSchema } from './SchemaValidator';

export class ResponseValidator<T> {
  private readonly response: ApiResponse<T>;

  constructor(response: ApiResponse<T>) {
    this.response = response;
  }

  private get label(): string {
    return `${this.response.method} ${this.response.url}`;
  }

  private get payloadPreview(): string {
    return JSON.stringify(this.response.body).slice(0, 500);
  }

  public hasStatus(expected: number): this {
    expect(
      this.response.status,
      `${this.label} expected HTTP ${expected} but received ${this.response.status}. Body: ${this.payloadPreview}`,
    ).toBe(expected);
    return this;
  }

  public hasStatusIn(expected: readonly number[]): this {
    expect(
      expected,
      `${this.label} expected one of [${expected.join(', ')}] but received ${this.response.status}`,
    ).toContain(this.response.status);
    return this;
  }

  public isSuccessful(): this {
    expect(this.response.ok, `${this.label} expected a 2xx, received ${this.response.status}`).toBe(
      true,
    );
    expect(
      this.response.body.success,
      `${this.label} envelope was not successful: ${this.payloadPreview}`,
    ).toBe(true);
    return this;
  }

  public isFailure(expectedCode?: string): this {
    expect(this.response.body.success, `${this.label} expected an error envelope`).toBe(false);
    expect(this.response.error, `${this.label} expected an error object`).toBeDefined();
    if (expectedCode) {
      expect(this.response.error?.code, `${this.label} expected error code ${expectedCode}`).toBe(
        expectedCode,
      );
    }
    return this;
  }

  public hasErrorMessageContaining(fragment: string | RegExp): this {
    const message = this.response.error?.message ?? '';
    if (typeof fragment === 'string') {
      expect(message, `${this.label} error message did not contain "${fragment}"`).toContain(
        fragment,
      );
    } else {
      expect(message, `${this.label} error message did not match ${String(fragment)}`).toMatch(
        fragment,
      );
    }
    return this;
  }

  /** Asserts a validation error names the offending field. */
  public hasValidationErrorForField(field: string): this {
    const details = this.response.error?.details;
    const fields = Array.isArray(details)
      ? details.map((detail) => (detail as { field?: string }).field)
      : [];
    expect(
      fields,
      `${this.label} expected a validation error for "${field}", got ${JSON.stringify(details)}`,
    ).toContain(field);
    return this;
  }

  public hasHeader(name: string, expected?: string | RegExp): this {
    const value = this.response.headers[name.toLowerCase()];
    expect(value, `${this.label} is missing header "${name}"`).toBeDefined();
    if (expected !== undefined) {
      if (typeof expected === 'string') expect(value).toContain(expected);
      else expect(value ?? '').toMatch(expected);
    }
    return this;
  }

  public isJson(): this {
    return this.hasHeader('content-type', 'application/json');
  }

  /** Asserts a property on `data`, supporting dot paths (`user.role`). */
  public hasProperty(path: string, expected?: unknown): this {
    const actual = path
      .split('.')
      .reduce<unknown>(
        (cursor, key) => (cursor as Record<string, unknown> | undefined)?.[key],
        this.response.data as unknown,
      );
    expect(
      actual,
      `${this.label} is missing data.${path}. Body: ${this.payloadPreview}`,
    ).toBeDefined();
    if (expected !== undefined) {
      expect(actual, `${this.label} data.${path} mismatch`).toEqual(expected);
    }
    return this;
  }

  public hasPropertyOfType(path: string, type: 'string' | 'number' | 'boolean' | 'object'): this {
    const actual = path
      .split('.')
      .reduce<unknown>(
        (cursor, key) => (cursor as Record<string, unknown> | undefined)?.[key],
        this.response.data as unknown,
      );
    expect(typeof actual, `${this.label} data.${path} should be a ${type}`).toBe(type);
    return this;
  }

  /** Asserts `data` is an array, optionally with an exact or minimum length. */
  public isArray(options: { readonly length?: number; readonly minLength?: number } = {}): this {
    expect(Array.isArray(this.response.data), `${this.label} data should be an array`).toBe(true);
    const items = this.response.data as unknown as unknown[];
    if (options.length !== undefined) {
      expect(items, `${this.label} expected ${options.length} item(s)`).toHaveLength(
        options.length,
      );
    }
    if (options.minLength !== undefined) {
      expect(
        items.length,
        `${this.label} expected at least ${options.minLength} item(s)`,
      ).toBeGreaterThanOrEqual(options.minLength);
    }
    return this;
  }

  /** Asserts every item in the array satisfies a predicate; reports the first offender. */
  public everyItem(predicate: (item: unknown) => boolean, description: string): this {
    const items = (this.response.data ?? []) as unknown as unknown[];
    const offender = items.find((item) => !predicate(item));
    expect(
      offender,
      `${this.label}: item failed "${description}": ${JSON.stringify(offender)}`,
    ).toBeUndefined();
    return this;
  }

  public hasPaginationMeta(): this {
    expect(this.response.meta, `${this.label} is missing pagination meta`).toBeDefined();
    return this;
  }

  public respondedWithin(budgetMs: number): this {
    expect(
      this.response.durationMs,
      `${this.label} took ${this.response.durationMs}ms, budget ${budgetMs}ms`,
    ).toBeLessThanOrEqual(budgetMs);
    return this;
  }

  public matchesSchema(schema: JsonSchema): this {
    assertSchema(this.response.data, schema, `${this.label} data`);
    return this;
  }

  public matchesEnvelopeSchema(schema: JsonSchema): this {
    assertSchema(this.response.body, schema, `${this.label} envelope`);
    return this;
  }

  /** Escape hatch for a business rule the fluent API does not cover. */
  public satisfies(rule: (data: T | undefined) => boolean, description: string): this {
    expect(rule(this.response.data), `${this.label} failed business rule: ${description}`).toBe(
      true,
    );
    return this;
  }

  /** Returns the payload, asserting it is present. */
  public unwrap(): T {
    expect(
      this.response.data,
      `${this.label} carried no data. Body: ${this.payloadPreview}`,
    ).toBeDefined();
    return this.response.data as T;
  }
}

/** Entry point: `verify(response).isSuccessful().matchesSchema(employeeSchema)`. */
export function verify<T>(response: ApiResponse<T>): ResponseValidator<T> {
  return new ResponseValidator<T>(response);
}
