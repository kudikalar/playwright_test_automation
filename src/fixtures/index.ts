/**
 * The framework's public test entry point.
 *
 * Fixture layers are chained — base -> pages -> api -> auth — so a fixture in a later layer can
 * depend on one from an earlier layer. A spec imports only from here:
 *
 * ```ts
 * import { test, expect } from '@fixtures/index';
 * ```
 */

export { authTest as test } from './auth.fixture';
export { expect } from '@playwright/test';

export {
  baseTest,
  type BaseTestFixtures,
  type BaseWorkerFixtures,
  type TestDataAccessor,
} from './base.fixture';
export { pageTest, type PageObjectFixtures } from './page.fixture';
export {
  apiTest,
  type ApiFixtures,
  type ApiWorkerFixtures,
  type CleanupTracker,
} from './api.fixture';
export { authTest, type AuthFixtures, type AuthOptions } from './auth.fixture';
export {
  clearStorageStates,
  createStorageState,
  createStorageStates,
  hasFreshStorageState,
  storageStatePath,
} from './AuthenticationManager';
