import { MODULES, TAGS } from '@constants/TestConstants';
import { expect, test } from '@fixtures/index';

test.describe('Forgot Password @forgotpassword', () => {
  test.beforeEach(async ({ forgotPasswordPage }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.authentication });
    await forgotPasswordPage.open();
  });

  test(`Forgot Password with valid Email Address ${TAGS.forgotPassword}`, async ({
    forgotPasswordPage,
    testData,
  }) => {
    const data = testData.get('forgotPassword');

    await test.step('Verify the Reset your password heading', async () => {
      await expect(forgotPasswordPage.heading).toHaveText(data.ui.heading);
      await expect(forgotPasswordPage.recoverButton).toHaveText(data.ui.submitLabel);
    });

    await test.step('Enter the valid email address and click on Send reset link', async () => {
      await forgotPasswordPage.enterEmailAndSubmit(data.validUser.email);
    });

    await test.step('Verify the reset link confirmation is shown', async () => {
      /* The confirmation text comes from the server, so only its presence is pinned here. */
      await expect(forgotPasswordPage.successMessage).toBeVisible();
      await expect(forgotPasswordPage.errorMessage).toHaveCount(0);
    });
  });

  test(`Forgot Password with invalid Email Address ${TAGS.forgotPassword} ${TAGS.negative}`, async ({
    forgotPasswordPage,
    testData,
  }) => {
    const data = testData.get('forgotPassword');

    for (const scenario of data.invalidScenarios) {
      await test.step(`${scenario.scenario} is rejected`, async () => {
        await forgotPasswordPage.enterEmailAndSubmit(scenario.email);
        await expect(forgotPasswordPage.fieldError).toHaveText(scenario.expectedError);
        await expect(forgotPasswordPage.successMessage).toHaveCount(0);
      });
    }
  });
});
