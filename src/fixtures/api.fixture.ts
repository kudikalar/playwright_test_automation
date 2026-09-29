/**
 * API fixtures.
 *
 * Gives every test a configured {@link ApiClient} and the domain services built on it, plus an
 * admin-authenticated client for setup/cleanup and an automatic cleanup tracker so records
 * created during a test are always removed — even when the test fails.
 */

import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';

import { ApiClient } from '../api/clients/ApiClient';
import { AuthApi } from '../api/services/AuthApi';
import { EmployeeApi } from '../api/services/EmployeeApi';
import { UserApi } from '../api/services/UserApi';
import { createLogger } from '../utils/Logger';
import { pageTest } from './page.fixture';

const log = createLogger('CleanupTracker');

/** Records created during a test, removed automatically in teardown. */
export interface CleanupTracker {
  /** Registers an employee id for deletion after the test. */
  employee(id: string): void;
  /** Ids currently registered. */
  readonly trackedEmployeeIds: readonly string[];
}

export interface ApiWorkerFixtures {
  /** Raw request context shared by a worker; used to build clients. */
  readonly apiRequestContext: APIRequestContext;
}

export interface ApiFixtures {
  /** Unauthenticated client — the starting point for auth and negative tests. */
  readonly apiClient: ApiClient;
  readonly authApi: AuthApi;
  readonly userApi: UserApi;
  /** Employee service on the unauthenticated client (use for 401 scenarios). */
  readonly employeeApi: EmployeeApi;
  /** Client already signed in as ADMIN — the default for setup and data seeding. */
  readonly adminApiClient: ApiClient;
  readonly adminEmployeeApi: EmployeeApi;
  readonly adminUserApi: UserApi;
  readonly cleanup: CleanupTracker;
}

export const apiTest = pageTest.extend<ApiFixtures, ApiWorkerFixtures>({
  apiRequestContext: [
    async ({ environment }, use) => {
      const context = await playwrightRequest.newContext({
        baseURL: environment.api.baseUrl,
        ignoreHTTPSErrors: false,
      });
      await use(context);
      await context.dispose();
    },
    { scope: 'worker' },
  ],

  apiClient: async ({ apiRequestContext }, use) => {
    await use(new ApiClient(apiRequestContext));
  },

  authApi: async ({ apiClient }, use) => {
    await use(new AuthApi(apiClient));
  },

  userApi: async ({ apiClient }, use) => {
    await use(new UserApi(apiClient));
  },

  employeeApi: async ({ apiClient }, use) => {
    await use(new EmployeeApi(apiClient));
  },

  adminApiClient: async ({ apiRequestContext }, use) => {
    const client = new ApiClient(apiRequestContext);
    await new AuthApi(client).authenticateClientAs('ADMIN');
    await use(client);
    client.clearAuthToken();
  },

  adminEmployeeApi: async ({ adminApiClient }, use) => {
    await use(new EmployeeApi(adminApiClient));
  },

  adminUserApi: async ({ adminApiClient }, use) => {
    await use(new UserApi(adminApiClient));
  },

  cleanup: async ({ adminEmployeeApi }, use) => {
    const employeeIds: string[] = [];
    const tracker: CleanupTracker = {
      employee: (id: string): void => {
        if (!employeeIds.includes(id)) employeeIds.push(id);
      },
      get trackedEmployeeIds(): readonly string[] {
        return [...employeeIds];
      },
    };

    await use(tracker);

    if (employeeIds.length > 0) {
      log.info('removing records created by this test', { count: employeeIds.length });
      await adminEmployeeApi.deleteAll(employeeIds);
    }
  },
});
