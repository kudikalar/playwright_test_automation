/**
 * Authentication fixtures.
 *
 * `test.use({ role: 'MANAGER' })` selects which persisted session a spec runs under; the
 * `authenticatedPage` fixture then hands back a page already signed in as that role, without a
 * UI login per test. Specs that must exercise the login screen simply use the plain `page`.
 */

import { existsSync } from 'node:fs';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import type { UserRole } from '../types/Environment';
import { FrameworkError } from '../utils/FrameworkError';
import { createStorageState, storageStatePath } from './AuthenticationManager';
import { apiTest } from './api.fixture';
import { DashboardPage } from '../pages/DashboardPage';
import { EmployeePage } from '../pages/EmployeePage';
import { ProfilePage } from '../pages/ProfilePage';
import { RegisterPage } from '@pages/RegisterPage';

export interface AuthOptions {
  /** Role whose stored session backs {@link AuthFixtures.authenticatedPage}. */
  readonly role: UserRole;
}

export interface AuthFixtures {
  /** A page carrying the stored session for {@link AuthOptions.role}. */
  readonly authenticatedPage: Page;
  /** The context behind {@link AuthFixtures.authenticatedPage}. */
  readonly authenticatedContext: BrowserContext;
  /** Page Objects bound to the authenticated page. */
  readonly dashboardAs: DashboardPage;
  readonly employeesAs: EmployeePage;
  readonly profileAs: ProfilePage;
  readonly registerAs: RegisterPage;
}

async function contextForRole(browser: Browser, role: UserRole): Promise<BrowserContext> {
  const statePath = storageStatePath(role);
  if (!existsSync(statePath)) {
    // Global setup normally creates this; regenerate on demand so a single-spec run still works.
    await createStorageState(browser, role);
  }
  if (!existsSync(statePath)) {
    throw new FrameworkError('Stored session is unavailable', {
      operation: 'contextForRole',
      target: role,
      expected: statePath,
    });
  }
  return browser.newContext({ storageState: statePath });
}

export const authTest = apiTest.extend<AuthFixtures & AuthOptions>({
  role: ['ADMIN', { option: true }],

  authenticatedContext: async ({ browser, role }, use) => {
    const context = await contextForRole(browser, role);
    await use(context);
    await context.close();
  },

  authenticatedPage: async ({ authenticatedContext }, use) => {
    const page = await authenticatedContext.newPage();
    await use(page);
    await page.close();
  },

  dashboardAs: async ({ authenticatedPage }, use) => {
    await use(new DashboardPage(authenticatedPage));
  },

  employeesAs: async ({ authenticatedPage }, use) => {
    await use(new EmployeePage(authenticatedPage));
  },

  profileAs: async ({ authenticatedPage }, use) => {
    await use(new ProfilePage(authenticatedPage));
  },

  registerAs: async ({ authenticatedPage }, use) => {
    await use(new RegisterPage(authenticatedPage));
  },
});
