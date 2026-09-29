/**
 * Contract suite.
 *
 * Asserts the *shape* of each payload against its JSON Schema, so a field that changes type or
 * disappears is caught even when value-level assertions still pass.
 */

import { HTTP_STATUS } from '@constants/ApiConstants';
import { MODULES, TAGS } from '@constants/TestConstants';
import {
  authenticatedUserSchema,
  employeeListSchema,
  employeeSchema,
  errorEnvelopeSchema,
  healthSchema,
  loginResponseSchema,
  paginationMetaSchema,
} from '@api/models/schemas';
import { assertSchema, verify } from '@api/validators';
import { buildEmployee } from '@data/factories';
import { expect, test } from '@fixtures/index';

test.describe('API contracts @api @contract', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.platform });
  });

  test(`Health payload matches its contract ${TAGS.contract}`, async ({ authApi }) => {
    verify(await authApi.health())
      .hasStatus(HTTP_STATUS.OK)
      .matchesSchema(healthSchema);
  });

  test(`Login payload matches its contract ${TAGS.contract} ${TAGS.critical}`, async ({
    authApi,
    environment,
  }) => {
    const response = await authApi.login(environment.credentialsFor('ADMIN'));
    verify(response).hasStatus(HTTP_STATUS.OK).matchesSchema(loginResponseSchema);
    assertSchema(response.data?.user, authenticatedUserSchema, 'login.user');
  });

  test(`Employee list payload and pagination meta match their contracts ${TAGS.contract}`, async ({
    adminEmployeeApi,
  }) => {
    const response = await adminEmployeeApi.list({ pageSize: 5 });

    verify(response)
      .hasStatus(HTTP_STATUS.OK)
      .matchesSchema(employeeListSchema)
      .hasPaginationMeta();
    assertSchema(response.meta, paginationMetaSchema, 'pagination meta');
  });

  test(`A single employee payload matches its contract ${TAGS.contract}`, async ({
    adminEmployeeApi,
    cleanup,
  }) => {
    const created = await adminEmployeeApi.createOrThrow(buildEmployee());
    cleanup.employee(created.id);

    verify(await adminEmployeeApi.getById(created.id))
      .hasStatus(HTTP_STATUS.OK)
      .matchesSchema(employeeSchema);
  });

  test(`Error payloads match the error contract ${TAGS.contract} ${TAGS.negative}`, async ({
    adminEmployeeApi,
  }) => {
    const response = await adminEmployeeApi.getById('emp-does-not-exist');

    verify(response).hasStatus(HTTP_STATUS.NOT_FOUND).matchesEnvelopeSchema(errorEnvelopeSchema);
    expect(response.error?.code).toBe('NOT_FOUND');
  });
});
