/**
 * Base fixtures — the foundation every other fixture layer extends.
 *
 * Provides the resolved environment and execution config (worker-scoped, resolved once per
 * worker), typed test data, a test-scoped logger, and an automatic fixture that annotates each
 * test with its environment/browser context for the report.
 */

import { test as base } from '@playwright/test';

import { getEnvironment, resolveEnvironmentName } from '../../config/environment.config';
import { frameworkConfig, type FrameworkExecutionConfig } from '../../config/framework.config';
import type { ResolvedEnvironment } from '../types/Environment';
import type { TestDataName, TestDataRegistry } from '../types/TestData';
import { readTestData } from '../utils/JsonReader';
import { createLogger, type Logger } from '../utils/Logger';

/** Environment-aware dataset accessor handed to tests. */
export interface TestDataAccessor {
  /** Reads a dataset, merging the environment override over the common baseline. */
  get<K extends TestDataName>(name: K): TestDataRegistry[K];
}

export interface BaseWorkerFixtures {
  readonly environment: ResolvedEnvironment;
  readonly execution: FrameworkExecutionConfig;
}

export interface BaseTestFixtures {
  readonly testData: TestDataAccessor;
  readonly log: Logger;
  /** Automatic: records run context on the test result. */
  readonly runContext: void;
}

export const baseTest = base.extend<BaseTestFixtures, BaseWorkerFixtures>({
  environment: [
    async ({}, use) => {
      await use(getEnvironment());
    },
    { scope: 'worker' },
  ],

  execution: [
    async ({}, use) => {
      await use(frameworkConfig);
    },
    { scope: 'worker' },
  ],

  testData: async ({ environment }, use) => {
    const accessor: TestDataAccessor = {
      get: <K extends TestDataName>(name: K): TestDataRegistry[K] =>
        readTestData(name, { environment: environment.name }),
    };
    await use(accessor);
  },

  log: async ({}, use, testInfo) => {
    await use(createLogger(testInfo.titlePath[0] ?? 'test', testInfo.title));
  },

  runContext: [
    async ({ environment }, use, testInfo) => {
      testInfo.annotations.push(
        { type: 'environment', description: `${environment.displayName} (${environment.name})` },
        { type: 'project', description: testInfo.project.name },
        { type: 'ui-base-url', description: environment.ui.baseUrl },
      );
      await use();
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
export { resolveEnvironmentName };
