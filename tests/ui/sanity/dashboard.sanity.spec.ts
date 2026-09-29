/**
 * Dashboard sanity suite.
 *
 * Runs against the stored ADMIN session created in global setup, so it verifies the landing
 * experience without paying for a UI login per test.
 */

import { MODULES, TAGS } from '@constants/TestConstants';
import { createUploadFixture, parseCsv, readTextFile } from '@utils/FileUtils';
import { expect, test } from '@fixtures/index';

test.describe('Dashboard @ui', () => {
  test.use({ role: 'ADMIN' });

  test.beforeEach(async ({ dashboardAs }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.dashboard });
    await dashboardAs.open();
  });

  test(`Workforce metrics reflect the directory ${TAGS.sanity} ${TAGS.critical}`, async ({
    dashboardAs,
    testData,
  }) => {
    const data = testData.get('dashboard');

    await test.step('The page renders its shell and metric tiles', async () => {
      await dashboardAs.expectLoaded();
      for (const label of data.metricLabels) {
        await expect(dashboardAs.rawPage.getByRole('heading', { name: label })).toBeVisible();
      }
    });

    /*
     * Rule 22: the directory is shared state. The tile is compared with the payload this page
     * actually rendered from, captured on the same navigation, so a parallel worker creating a
     * record cannot make a correct dashboard look wrong.
     */
    await test.step('The headline count matches the payload the page rendered', async () => {
      const { metrics, total } = await dashboardAs.openAndCaptureSource();
      expect(metrics.totalEmployees).toBe(total);
      expect(metrics.departments).toBeGreaterThan(0);
      expect(metrics.active).toBeLessThanOrEqual(metrics.totalEmployees);
      expect(metrics.averageSalary).toMatch(/^₹/);
    });
  });

  test(`Primary navigation reaches every module ${TAGS.sanity}`, async ({
    dashboardAs,
    testData,
  }) => {
    const data = testData.get('dashboard');

    for (const item of data.navigationItems) {
      await test.step(`Navigate to ${item.label}`, async () => {
        /* Return to the dashboard each time so every item is reached from the same origin. */
        await dashboardAs.open();
        await dashboardAs.sidebar.navigateTo(item.label);
        await expect(dashboardAs.rawPage).toHaveURL(new RegExp(`${item.path}$`));
        await dashboardAs.sidebar.expectActiveItem(item.label);
      });
    }
  });

  test(`Onboarding documents can be uploaded ${TAGS.regression}`, async ({ dashboardAs }) => {
    const files = [
      createUploadFixture('offer-letter.txt', 'signed offer letter'),
      createUploadFixture('id-proof.txt', 'identity document'),
    ];

    const summary = await dashboardAs.uploadDocuments(files);
    expect(summary).toContain('offer-letter.txt');
    expect(summary).toContain('id-proof.txt');
  });

  test(`The directory can be exported as CSV ${TAGS.regression}`, async ({
    dashboardAs,
    adminEmployeeApi,
  }) => {
    /*
     * Rule 22: the directory is shared state. The export is a snapshot, so it is bracketed by a
     * count taken either side of it — a parallel worker adding or removing a record during the
     * download must not make a correct export look wrong.
     */
    const countBefore = await adminEmployeeApi.countAll();

    const downloadPath = await test.step('Trigger the export', async () =>
      dashboardAs.exportEmployeesCsv());

    const countAfter = await adminEmployeeApi.countAll();

    await test.step('The export carries one row per employee', () => {
      const rows = parseCsv(readTextFile(downloadPath));
      const [header] = rows;
      expect(header).toEqual([
        'id',
        'name',
        'email',
        'department',
        'designation',
        'salary',
        'status',
      ]);

      const exported = rows.length - 1;
      const reason = 'the export must match the directory as it stood during the download';
      expect(exported, reason).toBeGreaterThanOrEqual(Math.min(countBefore, countAfter));
      expect(exported, reason).toBeLessThanOrEqual(Math.max(countBefore, countAfter));
    });
  });

  test(`Destructive actions ask for confirmation ${TAGS.regression} ${TAGS.negative}`, async ({
    dashboardAs,
    testData,
  }) => {
    const data = testData.get('dashboard');

    await test.step('Dismissing the dialog cancels the action', async () => {
      const message = await dashboardAs.cancelWorkspaceReset();
      expect(message).toBe(data.resetConfirmationMessage);
      await dashboardAs.toast.waitForMessage('Reset cancelled');
    });

    await test.step('Accepting the dialog proceeds', async () => {
      const message = await dashboardAs.confirmWorkspaceReset();
      expect(message).toBe(data.resetConfirmationMessage);
      await dashboardAs.toast.expectSuccess('Workspace reset requested');
    });
  });

  test(`Embedded compliance widget is interactive ${TAGS.regression}`, async ({ dashboardAs }) => {
    const acknowledgement = await dashboardAs.acknowledgeCompliance();
    expect(acknowledgement).toContain('Acknowledged');
  });

  test(`Employees can be opened in a second tab ${TAGS.regression}`, async ({ dashboardAs }) => {
    const newTab = await dashboardAs.openEmployeesInNewTab();
    try {
      await expect(newTab).toHaveURL(/\/employees$/);
      await expect(newTab.getByRole('heading', { name: 'Employees', level: 1 })).toBeVisible();
    } finally {
      await dashboardAs.closeTab(newTab);
    }
  });
});
