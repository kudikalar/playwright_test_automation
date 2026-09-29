/**
 * API smoke suite — the fastest signal that an environment is usable.
 * Runs first in CI: if these fail, nothing else is worth executing.
 */

import { HTTP_STATUS } from '@constants/ApiConstants';
import { MODULES, TAGS } from '@constants/TestConstants';
import { verify } from '@api/validators';
import { healthSchema, loginResponseSchema } from '@api/models/schemas';
import { expect, test } from '@fixtures/index';

test.describe('Platform API @api', () => {
  test(`The service reports healthy ${TAGS.smoke} ${TAGS.critical}`, async ({
    authApi,
    testData,
  }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.platform });
    const budgets = testData.get('api').performance;

    const response = await authApi.health();
    verify(response)
      .hasStatus(HTTP_STATUS.OK)
      .isJson()
      .isSuccessful()
      .matchesSchema(healthSchema)
      .respondedWithin(budgets.maxResponseTimeMs)
      .hasProperty('status', 'UP');
  });

  test(`An administrator can authenticate ${TAGS.smoke} ${TAGS.critical}`, async ({
    authApi,
    environment,
  }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.authentication });
    const credentials = environment.credentialsFor('ADMIN');

    const response = await authApi.login(credentials);
    const session = verify(response)
      .hasStatus(HTTP_STATUS.OK)
      .isSuccessful()
      .matchesSchema(loginResponseSchema)
      .hasProperty('user.role', 'ADMIN')
      .unwrap();

    expect(session.token, 'a session token must be issued').toBeTruthy();
    expect(session.expiresIn).toBeGreaterThan(0);
  });

  test(`The token identifies the caller ${TAGS.smoke}`, async ({ authApi }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.authentication });

    await authApi.authenticateClientAs('ADMIN');
    const me = await authApi.me();

    verify(me).hasStatus(HTTP_STATUS.OK).isSuccessful().hasProperty('role', 'ADMIN');
  });

  test(`The employee directory responds ${TAGS.smoke}`, async ({
    adminEmployeeApi,
    testData,
  }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.employeeManagement });
    const budgets = testData.get('api').performance;

    const response = await adminEmployeeApi.list({ pageSize: 5 });
    verify(response)
      .hasStatus(HTTP_STATUS.OK)
      .isSuccessful()
      .isArray({ minLength: 1 })
      .hasPaginationMeta()
      .respondedWithin(budgets.maxListResponseTimeMs);
  });
});
