/**
 * Global teardown.
 *
 * Finalises the run: records the end time for the report and, unless explicitly kept, removes
 * the persisted session files so live tokens never linger on a CI agent or a laptop.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { getEnvironment } from './config/environment.config';
import { frameworkConfig } from './config/framework.config';
import { PATHS } from './src/constants/FrameworkConstants';
import { clearStorageStates } from './src/fixtures/AuthenticationManager';
import type { UserRole } from './src/types/Environment';
import { readTextFile, writeJsonFile } from './src/utils/FileUtils';
import { createLogger } from './src/utils/Logger';

const log = createLogger('global-teardown');

const ROLES: readonly UserRole[] = ['ADMIN', 'MANAGER', 'EMPLOYEE', 'STUDENT', 'MENTOR'];

const keepSessions = ['1', 'true', 'yes'].includes(
  (process.env.KEEP_AUTH_STATE ?? '').toLowerCase(),
);

async function globalTeardown(): Promise<void> {
  const environment = getEnvironment();
  const contextFile = resolve(PATHS.reports, 'run-context.json');

  if (existsSync(contextFile)) {
    const context = JSON.parse(readTextFile(contextFile)) as Record<string, unknown>;
    const startedAt = new Date(String(context.startedAt));
    writeJsonFile(contextFile, {
      ...context,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
    });
  }

  /* Session files carry live tokens. Keep them only when an engineer opts in locally. */
  if (!keepSessions) {
    clearStorageStates(ROLES);
  } else {
    log.warn('KEEP_AUTH_STATE is set — session files were left on disk under storage/auth');
  }

  log.info('run finished', {
    environment: environment.name,
    runId: frameworkConfig.runId,
    reports: { playwright: PATHS.playwrightReport, extent: PATHS.extentReport, logs: PATHS.logs },
  });
  await Promise.resolve();
}

export default globalTeardown;
