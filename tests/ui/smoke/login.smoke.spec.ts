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

  test(`An administrator can sign in ${TAGS.smoke} ${TAGS.critical}`, async ({
    loginPage,
    dashboardPage,
  }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.authentication });

    await test.step('Sign in with the ADMIN role', async () => {
      await loginPage.loginAs('ADMIN');
    });

    await test.step('The dashboard loads for the signed-in user', async () => {
      await dashboardPage.expectLoaded();
      await expect(dashboardPage.header.userRole).toHaveText('ADMIN');
    });

    await test.step('A session is persisted in the browser', async () => {
      expect(await loginPage.hasSessionToken()).toBe(true);
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

  test(`Sign - in with invalid Credentials ${TAGS.regression} ${TAGS.ui} @PITS-1234`, async ({
    loginPage,
    testData,
  }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.authentication });
    const data = testData.get('login'); // object for test Data

    /* Indexed access is `T | undefined` under noUncheckedIndexedAccess. Binding it once turns a
       shrunken dataset into one clear failure instead of three undefined reads. */
    const scenario = data.invalidScenarios[4];
    expect(scenario, 'login.json must declare a fifth invalid scenario').toBeDefined();

    await test.step('Enter invalid email address and password and check the error message', async () => {
      await loginPage.expectLoaded();
      await loginPage.attemptInvalidLogin(scenario!.username, scenario!.password);
      await loginPage.expectErrorMessage(scenario!.expectedError);
    });
  });
});
