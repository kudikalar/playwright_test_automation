/**
 * Typed access to the JSON datasets under `test-data/`.
 *
 * Resolution order for a dataset named `employees` in environment `qa`:
 *   1. `test-data/qa/employees.json`      (environment-specific override)
 *   2. `test-data/common/employees.json`  (shared baseline)
 *
 * When both exist the environment file is deep-merged over the common file, so an environment
 * only needs to declare what differs. Results are cached per process; `clearCache()` exists for
 * tests of the reader itself.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PATHS } from '../constants/FrameworkConstants';
import type { EnvironmentName } from '../types/Environment';
import type { TestDataName, TestDataRegistry } from '../types/TestData';
import { TestDataError } from './FrameworkError';
import { createLogger } from './Logger';

const log = createLogger('JsonReader');
const cache = new Map<string, unknown>();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deep-merges `override` onto `base`; arrays are replaced, not concatenated. */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override ?? base) as T;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

function parseFile<T>(filePath: string): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new TestDataError(
      'Unable to read test-data file',
      { operation: 'readFile', target: filePath },
      error,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new TestDataError(
      'Test-data file is not valid JSON',
      { operation: 'parseJson', target: filePath },
      error,
    );
  }
}

export interface ReadOptions {
  /** Environment whose overrides should be layered on top of `common`. */
  readonly environment?: EnvironmentName;
  /** Skip the cache (used by the framework's own unit-style checks). */
  readonly fresh?: boolean;
}

/**
 * Reads a dataset and returns it typed. Prefer {@link readTestData} for known datasets — it is
 * keyed to {@link TestDataRegistry} so the return type needs no annotation at the call site.
 */
export function readJson<T>(datasetName: string, options: ReadOptions = {}): T {
  const environment = options.environment;
  const cacheKey = `${environment ?? 'none'}::${datasetName}`;
  if (!options.fresh && cache.has(cacheKey)) return cache.get(cacheKey) as T;

  const commonFile = resolve(PATHS.testData, 'common', `${datasetName}.json`);
  const envFile = environment
    ? resolve(PATHS.testData, environment, `${datasetName}.json`)
    : undefined;

  const hasCommon = existsSync(commonFile);
  const hasEnv = envFile !== undefined && existsSync(envFile);

  if (!hasCommon && !hasEnv) {
    throw new TestDataError('Test dataset not found', {
      operation: 'resolveDataset',
      target: datasetName,
      expected: `${commonFile}${envFile ? ` or ${envFile}` : ''}`,
      available: availableDatasets().join(', ') || '(none)',
    });
  }

  const base = hasCommon ? parseFile<T>(commonFile) : ({} as T);
  const merged = hasEnv && envFile ? deepMerge(base, parseFile<unknown>(envFile)) : base;

  log.debug('dataset resolved', {
    dataset: datasetName,
    common: hasCommon,
    environmentOverride: hasEnv,
    environment: environment ?? null,
  });

  cache.set(cacheKey, merged);
  return merged;
}

/** Reads a dataset declared in {@link TestDataRegistry}, fully typed. */
export function readTestData<K extends TestDataName>(
  datasetName: K,
  options: ReadOptions = {},
): TestDataRegistry[K] {
  return readJson<TestDataRegistry[K]>(datasetName, options);
}

/**
 * Reads a nested value using dot/bracket notation, e.g. `readPath('login', 'ui.submitLabel')`.
 * Throws with the full path when a segment is missing, rather than returning `undefined`.
 */
export function readPath<T>(datasetName: string, path: string, options: ReadOptions = {}): T {
  const dataset = readJson<unknown>(datasetName, options);
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  let cursor: unknown = dataset;
  const walked: string[] = [];
  for (const segment of segments) {
    walked.push(segment);
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) {
      throw new TestDataError('Test-data path is not traversable', {
        operation: 'readPath',
        target: `${datasetName}.${path}`,
        actual: `stopped at "${walked.join('.')}"`,
      });
    }
    cursor = (cursor as Record<string, unknown>)[segment];
    if (cursor === undefined) {
      throw new TestDataError('Test-data path not found', {
        operation: 'readPath',
        target: `${datasetName}.${path}`,
        actual: `"${walked.join('.')}" is undefined`,
      });
    }
  }
  return cursor as T;
}

/** Validates that every listed key exists on a dataset; used by global setup as a fail-fast. */
export function assertDatasetKeys(
  datasetName: string,
  requiredKeys: readonly string[],
  options: ReadOptions = {},
): void {
  const dataset = readJson<Record<string, unknown>>(datasetName, options);
  const missing = requiredKeys.filter((key) => dataset[key] === undefined);
  if (missing.length > 0) {
    throw new TestDataError('Test dataset is missing required keys', {
      operation: 'assertDatasetKeys',
      target: datasetName,
      expected: requiredKeys.join(', '),
      actual: `missing: ${missing.join(', ')}`,
    });
  }
}

/** Every dataset name discoverable under `test-data/common`. */
export function availableDatasets(): string[] {
  const commonDir = resolve(PATHS.testData, 'common');
  if (!existsSync(commonDir)) return [];
  return readdirSync(commonDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();
}

export function clearCache(): void {
  cache.clear();
}
