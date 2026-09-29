/**
 * Network-layer regression suite.
 *
 * Demonstrates the interception capabilities the framework exposes: waiting for a business
 * request, asserting what the UI sends, serving a canned payload for an edge case that is hard
 * to produce with real data, and aborting requests the test does not care about.
 */

import { API_ROUTES, HTTP_STATUS } from '@constants/ApiConstants';
import { MODULES, TAGS } from '@constants/TestConstants';
import { expect, test } from '@fixtures/index';
import { waitForApiResponse } from '@utils/WaitUtils';

test.describe('Network behaviour @ui', () => {
  test.use({ role: 'ADMIN' });

  test.beforeEach(({}, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.employeeManagement });
  });

  test(`The directory request carries the expected query ${TAGS.regression}`, async ({
    employeesAs,
  }) => {
    await employeesAs.open();

    const request = employeesAs.rawPage.waitForRequest(
      (candidate) =>
        candidate.url().includes(API_ROUTES.employees.root) &&
        candidate.url().includes('search=finance'),
    );
    await employeesAs.searchFor('finance');
    const url = new URL((await request).url());

    expect(url.searchParams.get('search')).toBe('finance');
    expect(url.searchParams.get('page')).toBe('1');
    expect(Number(url.searchParams.get('pageSize'))).toBeGreaterThan(0);
  });

  test(`A business response is awaited rather than slept on ${TAGS.regression}`, async ({
    employeesAs,
  }) => {
    await employeesAs.open();

    const response = await test.step('Filter and wait for the backing call', async () => {
      const pending = waitForApiResponse(employeesAs.rawPage, API_ROUTES.employees.root, {
        status: HTTP_STATUS.OK,
      });
      await employeesAs.filterByDepartment('Engineering');
      return pending;
    });

    const payload = (await response.json()) as { success: boolean; data: { department: string }[] };
    expect(payload.success).toBe(true);
    expect(payload.data.every((employee) => employee.department === 'Engineering')).toBe(true);
  });

  test(`An empty directory renders the empty state ${TAGS.regression} ${TAGS.negative}`, async ({
    employeesAs,
  }) => {
    await test.step('Serve an empty page of results', async () => {
      await employeesAs.mockJsonResponse(/\/employees\?/, {
        success: true,
        data: [],
        meta: { page: 1, pageSize: 10, total: 0, totalPages: 1 },
      });
      await employeesAs.open();
    });

    await employeesAs.table.expectEmpty();
    await expect(employeesAs.emptyState).toContainText('No employees match your filters');
    await employeesAs.clearRoutes();
  });

  test(`A failing directory call surfaces an error, not a blank page ${TAGS.regression} ${TAGS.negative}`, async ({
    employeesAs,
  }) => {
    await employeesAs.mockJsonResponse(
      /\/employees\?/,
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } },
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
    await employeesAs.open();

    await employeesAs.toast.expectError('Unable to load employees');
    await employeesAs.clearRoutes();
  });

  test(`Unrelated requests can be aborted ${TAGS.regression}`, async ({ employeesAs }) => {
    await employeesAs.abortRequests('**/*.{png,jpg,jpeg,woff2}');
    await employeesAs.open();

    /* The page still works with decorative assets blocked. */
    await employeesAs.expectLoaded();
    expect(await employeesAs.table.getRowCount()).toBeGreaterThan(0);
    await employeesAs.clearRoutes();
  });
});
