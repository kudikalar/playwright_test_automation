/**
 * Visual regression suite.
 *
 * Baselines live under `tests/visual/__screenshots__/<project>/` — separate from the failure
 * screenshots in `reports/`, so a diff is never confused with a diagnostic capture.
 * Update deliberately with `npm run test:visual:update`.
 */

import { TAGS } from '@constants/TestConstants';
import { expect, test } from '@fixtures/index';

/** Page size that always fills, so the captured table height never depends on live data. */
const VISIBLE_ROWS = 5;

test.describe('Visual baselines @visual', () => {
  test(`Sign-in screen ${TAGS.visual}`, async ({ loginPage }) => {
    await loginPage.open();
    await expect(loginPage.rawPage).toHaveScreenshot('login-page.png', {
      fullPage: true,
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    });
  });

  test(`Sign-in screen with a validation error ${TAGS.visual}`, async ({ loginPage, testData }) => {
    const [scenario] = testData.get('login').invalidScenarios;
    await loginPage.open();
    await loginPage.attemptInvalidLogin(scenario!.username, scenario!.password);
    await loginPage.toast.waitUntilCleared();

    await expect(loginPage.rawPage.getByRole('main')).toHaveScreenshot('login-error.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    });
  });

  test(`Employee directory shell ${TAGS.visual}`, async ({ employeesAs }) => {
    await employeesAs.open();
    await employeesAs.toast.waitUntilCleared();

    /*
     * Masking hides what the rows say, not how many there are, and other suites add and remove
     * records in parallel. Pinning the page size fixes the table height: the eight seeded
     * records cannot be deleted, so a full first page always renders.
     */
    await employeesAs.pagination.setPageSize(VISIBLE_ROWS);
    await employeesAs.table.expectRowCount(VISIBLE_ROWS);

    /* The table body holds live data; only the surrounding chrome is compared. */
    await expect(employeesAs.rawPage).toHaveScreenshot('employees-shell.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
      mask: [employeesAs.table.rows, employeesAs.pagination.summary],
    });
  });
});
