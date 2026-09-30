import { MODULES, TAGS } from '@constants/TestConstants';
import { resolveEnvironmentName } from '@config/environment.config';
import { readTestData } from '@utils/JsonReader';
import { uniqueEmail } from '@utils/RandomUtils';
import { expect, test } from '@fixtures/index';

/*
 * Every value comes from test-data/demoshop/register.json. The dataset is read at collection time
 * (not inside a fixture) because each invalid scenario becomes its own test — adding a row to the
 * JSON adds a test, with no spec change.
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
     * The address must be unique per run: the shop keeps every account forever, so a fixed
     * email registers once and then fails with "The specified email already exists" on every
     * later run. Only its prefix lives in the JSON.
     */
    const email = uniqueEmail(user.emailPrefix);
    testInfo.annotations.push({ type: 'test-data', description: `register.validUser → ${email}` });

    await test.step('Submit the registration form', async () => {
      await registerPage.register({ ...user, email });
    });

    await test.step('The shop confirms the registration', async () => {
      await expect(registerPage.resultMessage).toBeVisible();
      await expect(registerPage.resultMessage).toHaveText(data.ui.successMessage);
    });
  });

  for (const scenario of data.invalidScenarios) {
    test(`Register to website with Invalid Data — ${scenario.scenario} ${TAGS.functional} ${TAGS.negative}`, async ({
      registerPage,
    }, testInfo) => {
      testInfo.annotations.push({
        type: 'test-data',
        description: `register.invalidScenarios → ${scenario.scenario}`,
      });

      await test.step(`Submit the form with ${scenario.scenario}`, async () => {
        await registerPage.register(scenario);
      });

      await test.step('The form is rejected and says why', async () => {
        /* Invalid input must NOT produce the success message — asserting for it here would make
           the test pass only if the shop were broken. */
        await expect(registerPage.resultMessage).toHaveCount(0);
        await expect(registerPage.fieldErrors.first()).toBeVisible();

        const errors = await registerPage.getValidationErrors();
        for (const expected of scenario.expectedErrors) {
          expect(errors, `shows "${expected}"`).toContain(expected);
        }
      });
    });
  }


    for (const scenario of data.invalidEmails) {
    test(`Register to website with invalid email address— ${scenario.scenario} ${TAGS.functional} ${TAGS.negative}`, async ({
      registerPage,
    }, testInfo) => {
      testInfo.annotations.push({
        type: 'test-data',
        description: `register.invalidEmails → ${scenario.scenario}`,
      });

      await test.step(`Enter invalid email address ${scenario.scenario}`, async () => {
        await registerPage.enterEmail("skjshfkj.com");
      });

      await test.step(`Click on register button ${scenario.scenario}`, async()=>{
        await registerPage.clickRegisterButton();
      })

      await test.step('Verify error message ', async () => {
        /* Invalid input must NOT produce the success message — asserting for it here would make
           the test pass only if the shop were broken. */
       const errors = await registerPage.getValidationErrors();
        for (const expected of scenario.expectedErrors) {
          expect(errors, `shows "${expected}"`).toContain("Wrong email");
        }
      
      });
    });
  }
});
