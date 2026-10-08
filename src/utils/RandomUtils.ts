/**
 * Deterministic-enough uniqueness for parallel-safe test data.
 *
 * Every generated value carries the {@link TEST_DATA_PREFIX} so cleanup jobs can identify
 * records this suite created, and a worker-aware suffix so parallel workers never collide.
 */

import { randomUUID, randomInt } from 'node:crypto';

import { TEST_DATA_PREFIX } from '../constants/TestConstants';

const workerId = (): string =>
  process.env.TEST_PARALLEL_INDEX ?? process.env.TEST_WORKER_INDEX ?? '0';

/** Short, collision-resistant token: worker index + time + random suffix. */
export function uniqueToken(): string {
  return `${workerId()}${Date.now().toString(36)}${randomInt(1000, 9999)}`;
}

/** `pwauto-<label>-<token>` — always identifiable as automation-created data. */
export function uniqueId(label = 'id'): string {
  return `${TEST_DATA_PREFIX}-${label}-${uniqueToken()}`;
}

export function uuid(): string {
  return randomUUID();
}

/** Unique, deliverable-shaped email inside a domain the suite owns. */
export function uniqueEmail(prefix = 'user', domain = 'automation.test'): string {
  return `${TEST_DATA_PREFIX}.${prefix}.${uniqueToken()}@${domain}`.toLowerCase();
}

/** Random 10-digit Indian mobile number (starts 6–9), as a registration form expects. */
export function uniqueMobile(): string {
  return `${randomInt(6, 10)}${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

export function uniqueName(base = 'Auto Employee'): string {
  return `${base} ${uniqueToken().slice(-6).toUpperCase()}`;
}

export function randomNumber(min: number, max: number): number {
  if (min > max) throw new RangeError(`randomNumber: min (${min}) must not exceed max (${max})`);
  return randomInt(min, max + 1);
}

/** Random salary rounded to the nearest thousand, for realistic-looking payloads. */
export function randomSalary(min = 600_000, max = 2_400_000): number {
  return Math.round(randomNumber(min, max) / 1000) * 1000;
}

export function randomItem<T>(items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('randomItem: cannot pick from an empty array');
  return items[randomNumber(0, items.length - 1)] as T;
}

export function randomItems<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < Math.min(count, items.length)) {
    picked.push(...pool.splice(randomNumber(0, pool.length - 1), 1));
  }
  return picked;
}

export function randomString(
  length = 10,
  alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789',
): string {
  return Array.from({ length }, () => alphabet[randomNumber(0, alphabet.length - 1)]).join('');
}

export function randomBoolean(): boolean {
  return randomNumber(0, 1) === 1;
}
