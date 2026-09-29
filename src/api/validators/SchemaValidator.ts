/**
 * JSON-Schema contract validation.
 *
 * Contract tests assert the *shape* of a payload, so a field that silently changes type is
 * caught even when the value-level assertions still pass.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { expect } from '@playwright/test';

import type { JsonSchema } from '../models/schemas';
import { ValidationError } from '../../utils/FrameworkError';

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

const compiled = new Map<string, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  const key = schema.title ?? JSON.stringify(schema);
  const existing = compiled.get(key);
  if (existing) return existing;
  const validate = ajv.compile(schema as object);
  compiled.set(key, validate);
  return validate;
}

const formatErrors = (errors: readonly ErrorObject[] | null | undefined): string =>
  (errors ?? [])
    .map((error) => `  ${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`)
    .join('\n');

export interface SchemaResult {
  readonly valid: boolean;
  readonly errors: string;
}

/** Validates a payload without failing the test — for conditional or reporting-only checks. */
export function validateSchema(payload: unknown, schema: JsonSchema): SchemaResult {
  const validate = compile(schema);
  const valid = validate(payload);
  return { valid, errors: formatErrors(validate.errors) };
}

/** Asserts a payload matches its schema, failing the test with every violation listed. */
export function assertSchema(payload: unknown, schema: JsonSchema, label?: string): void {
  const { valid, errors } = validateSchema(payload, schema);
  expect(
    valid,
    `${label ?? schema.title ?? 'payload'} did not match its JSON Schema:\n${errors}`,
  ).toBe(true);
}

/** Throws (rather than asserts) — used by services that must not proceed on a bad payload. */
export function ensureSchema<T>(payload: unknown, schema: JsonSchema, label?: string): T {
  const { valid, errors } = validateSchema(payload, schema);
  if (!valid) {
    throw new ValidationError('Payload failed schema validation', {
      operation: 'ensureSchema',
      target: label ?? schema.title ?? 'payload',
      actual: errors,
    });
  }
  return payload as T;
}
