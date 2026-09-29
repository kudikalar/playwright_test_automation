/**
 * Authentication state manager.
 *
 * Signs in once per role through the real UI and persists the browser storage state under
 * `storage/auth/`, so the rest of the suite starts already authenticated instead of repeating a
 * login for every test. Dedicated login specs still exercise the UI flow directly.
 *
 * Session files contain live tokens: they are git-ignored, and `--clean-auth` / teardown remove
 * them.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser } from '@playwright/test';

import { getEnvironment } from '../../config/environment.config';
import { frameworkConfig } from '../../config/framework.config';
import { PATHS, authStateFileName } from '../constants/FrameworkConstants';
import { LoginPage } from '../pages/LoginPage';
import type { UserRole } from '../types/Environment';
import { ensureDirectory, remove } from '../utils/FileUtils';
import { FrameworkError } from '../utils/FrameworkError';
import { createLogger } from '../utils/Logger';

const log = createLogger('AuthenticationManager');

/** How long a persisted session is considered reusable. */
const MAX_STATE_AGE_MS = 45 * 60 * 1000;

/** Absolute path of the storage-state file for a role in the current environment. */
export function storageStatePath(role: UserRole): string {
  const environment = getEnvironment();
  return resolve(PATHS.authState, authStateFileName(role, environment.name));
}

/** True when a usable, recent session file already exists. */
export function hasFreshStorageState(role: UserRole): boolean {
  const file = storageStatePath(role);
  if (!existsSync(file)) return false;
  if (!frameworkConfig.reuseAuthState) return false;
  return Date.now() - statSync(file).mtimeMs < MAX_STATE_AGE_MS;
}

/**
 * Creates (or reuses) the storage state for a role and returns its path.
 * The login runs through {@link LoginPage}, so the stored session is produced the same way a
 * user produces one.
 */
export async function createStorageState(browser: Browser, role: UserRole): Promise<string> {
  const file = storageStatePath(role);
  if (hasFreshStorageState(role)) {
    log.info('reusing existing session state', {
      role,
      file: authStateFileName(role, getEnvironment().name),
    });
    return file;
  }

  ensureDirectory(PATHS.authState);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const loginPage = new LoginPage(page);
    await loginPage.open();
    await loginPage.loginAs(role);
    await context.storageState({ path: file });
    log.info('session state created', { role });
    return file;
  } catch (error) {
    throw new FrameworkError(
      'Unable to establish an authenticated session',
      {
        operation: 'createStorageState',
        target: role,
        environment: getEnvironment().name,
        url: page.url(),
        expected: 'successful UI sign-in',
      },
      error,
    );
  } finally {
    await context.close();
  }
}

/** Prepares session state for several roles, sequentially (they share one browser). */
export async function createStorageStates(
  browser: Browser,
  roles: readonly UserRole[],
): Promise<Record<string, string>> {
  const created: Record<string, string> = {};
  for (const role of roles) {
    created[role] = await createStorageState(browser, role);
  }
  return created;
}

/** Deletes every persisted session for the current environment. */
export function clearStorageStates(roles: readonly UserRole[]): void {
  for (const role of roles) {
    remove(storageStatePath(role));
  }
  log.info('session states cleared', { roles: [...roles] });
}
