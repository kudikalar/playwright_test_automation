import { MODULES, TAGS } from '@constants/TestConstants';
import { resolveEnvironmentName } from '@config/environment.config';
import { readTestData } from '@utils/JsonReader';
import { uniqueEmail, uniqueMobile } from '@utils/RandomUtils';
import { expect, test } from '@fixtures/index';

/*
 * Every value comes from test-data/demoshop/register.json. The dataset is read at collection time
 * (not inside a fixture) so data-driven tests can be generated from it.
 */
const data = readTestData('register', { environment: resolveEnvironmentName() });

test.describe('Registration @register', () => {
  test.beforeEach(async ({ registerPage }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.register });
    await registerPage.open();
  });

  test(`Register to website with valid Data ${TAGS.functional} ${TAGS.ui}`, async ({
    registerPage,
  }, testInfo) => {
    const user = data.validUser;
    /*
     * Email and mobile must be unique per run: the site keeps every account, so fixed values
     * register once and then fail on every later run. Only the email prefix lives in the JSON.
     */
    const email = uniqueEmail(user.emailPrefix, user.emailDomain);
    const mobile = uniqueMobile();
    testInfo.annotations.push({ type: 'test-data', description: `register.validUser → ${email}` });

    await test.step('Submit the registration form', async () => {
      await registerPage.register({ ...user, email, mobile });
    });

    await test.step('The site asks the user to verify their email', async () => {
      await expect(registerPage.resultMessage).toBeVisible();
      await expect(registerPage.resultMessage).toHaveText(data.ui.successMessage);
    });
  });
});
