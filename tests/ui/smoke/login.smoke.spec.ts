/**
 * Authentication smoke suite.
 *
 * The one place the framework deliberately signs in through the UI on every run — everything
 * else reuses the stored session created in global setup.
 */

import { MODULES, TAGS } from '@constants/TestConstants';
import { expect, test } from '@fixtures/index';

test.describe('Authentication @login', () => {
  test.beforeEach(async ({ loginPage }) => {
    await loginPage.open();
  });

  test(`Sign-in page renders its controls ${TAGS.smoke} ${TAGS.ui}`, async ({
    loginPage,
    testData,
  }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.authentication });
    const data = testData.get('login'); // object for test Data

    await test.step('The form exposes accessible, enabled controls', async () => {
      await loginPage.expectLoaded();
      await expect(loginPage.signInButton).toHaveText(data.ui.submitLabel);
      await expect(loginPage.forgotPasswordLink).toBeVisible();
    });
  });

  test(`Invalid credentials are rejected ${TAGS.smoke} ${TAGS.negative}`, async ({
    loginPage,
    testData,
  }) => {
    const data = testData.get('login');
    const [scenario] = data.invalidScenarios;
    expect(scenario, 'login.json must declare at least one invalid scenario').toBeDefined();

    const message = await loginPage.attemptInvalidLogin(scenario!.username, scenario!.password);
    expect(message).toContain(scenario!.expectedError);

    await test.step('The user remains on the sign-in screen with no session', async () => {
      await expect(loginPage.heading).toBeVisible();
      expect(await loginPage.hasSessionToken()).toBe(false);
    });
  });
});
