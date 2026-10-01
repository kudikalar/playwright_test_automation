import { MODULES, TAGS } from '@constants/TestConstants';
import { expect, test } from '@fixtures/index';

test.describe('Forgot Password @forgotpassword', () => {
  test.beforeEach(async ({ forgotPasswordPage }) => {
    await forgotPasswordPage.open();
  });

  test(`Forgot Password with valid Email Address ${TAGS.forgotPassword}`, async ({
    forgotPasswordPage,
    testData,
  }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.authentication });
    const data = testData.get('forgotPassword'); // object for test Data

    await test.step('Verify the Password recovery heading and description', async () => {
      await expect(forgotPasswordPage.heading).toHaveText(data.ui.heading);
    });

    await test.step('Enter the valid email address and click on recover button', async () => {
      await forgotPasswordPage.enterEmailAndSubmit(data.validUser.email);
    });

    await test.step('Verify the successfull password recovery message sent', async () => {
      await expect(forgotPasswordPage.successMessage).toHaveText(data.validUser.successMessage);
    });
  });

});
