/**
 * Negative and authorisation coverage for the employee API.
 *
 * The scenarios come from JSON (`api.json`, `employees.json`), so adding a case is a data change
 * rather than a code change.
 */

import { API_ERROR_CODES, API_ROUTES, HTTP_STATUS } from '@constants/ApiConstants';
import { MODULES, TAGS } from '@constants/TestConstants';
import { errorEnvelopeSchema } from '@api/models/schemas';
import { verify } from '@api/validators';
import { buildEmployee, buildInvalidEmployee } from '@data/factories';
import { readTestData } from '@utils/JsonReader';
import { expect, test } from '@fixtures/index';

/* Read at module load so the scenarios can be turned into individual, named tests. */
const apiData = readTestData('api');
const employeeData = readTestData('employees');

test.describe('Employee API failure modes @api @negative', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.employeeManagement });
  });

  /* ------------------------------------------------ data-driven: transport -- */

  for (const scenario of apiData.negative) {
    test(`${scenario.scenario} returns ${scenario.expectedStatus} ${TAGS.regression}`, async ({
      apiClient,
      adminApiClient,
    }) => {
      /* Unauthenticated scenarios use the bare client; the rest use an authenticated one. */
      const client =
        scenario.expectedStatus === HTTP_STATUS.UNAUTHORIZED ? apiClient : adminApiClient;
      const response = await client.get(scenario.path, {
        skipAuth: scenario.expectedStatus === HTTP_STATUS.UNAUTHORIZED,
      });

      verify(response)
        .hasStatus(scenario.expectedStatus)
        .isFailure(scenario.expectedErrorCode)
        .matchesEnvelopeSchema(errorEnvelopeSchema);
    });
  }

  /* ----------------------------------------------- data-driven: validation -- */

  for (const validationCase of employeeData.validation) {
    test(`Create is rejected when ${validationCase.scenario} ${TAGS.regression}`, async ({
      adminEmployeeApi,
    }) => {
      const { payload, expectedStatus, expectedErrorCode, expectedField } = buildInvalidEmployee(
        validationCase.scenario,
      );

      const response = await adminEmployeeApi.create(payload);
      const validator = verify(response).hasStatus(expectedStatus).isFailure(expectedErrorCode);
      if (expectedField) validator.hasValidationErrorForField(expectedField);
    });
  }

  /* --------------------------------------------------------- authorisation -- */

  test(`An unauthenticated caller cannot list employees ${TAGS.security} ${TAGS.regression}`, async ({
    employeeApi,
    apiClient,
  }) => {
    apiClient.clearAuthToken();
    const response = await apiClient.get(API_ROUTES.employees.root, { skipAuth: true });

    verify(response).hasStatus(HTTP_STATUS.UNAUTHORIZED).isFailure(API_ERROR_CODES.unauthorized);
    expect(employeeApi.apiClient.isAuthenticated, 'the shared client must stay clean').toBe(false);
  });

  test(`An invalid token is rejected ${TAGS.security} ${TAGS.regression}`, async ({
    apiClient,
  }) => {
    const response = await apiClient
      .withToken('tkn_not-a-real-session-token')
      .get(API_ROUTES.employees.root);

    verify(response).hasStatus(HTTP_STATUS.UNAUTHORIZED).isFailure(API_ERROR_CODES.unauthorized);
  });

  test(`An EMPLOYEE may read but not delete ${TAGS.security} ${TAGS.critical}`, async ({
    authApi,
    employeeApi,
    adminEmployeeApi,
    cleanup,
  }) => {
    const target = await adminEmployeeApi.createOrThrow(buildEmployee());
    cleanup.employee(target.id);

    await authApi.authenticateClientAs('EMPLOYEE');

    await test.step('Reading is permitted', async () => {
      verify(await employeeApi.list({ pageSize: 1 }))
        .hasStatus(HTTP_STATUS.OK)
        .isSuccessful();
    });

    await test.step('Deleting is refused', async () => {
      verify(await employeeApi.remove(target.id))
        .hasStatus(HTTP_STATUS.FORBIDDEN)
        .isFailure(API_ERROR_CODES.forbidden)
        .hasErrorMessageContaining('role required');
    });

    await test.step('The record survives the refused delete', async () => {
      verify(await adminEmployeeApi.getById(target.id))
        .hasStatus(HTTP_STATUS.OK)
        .isSuccessful();
    });
  });

  test(`Listing users requires ADMIN ${TAGS.security} ${TAGS.regression}`, async ({
    authApi,
    userApi,
  }) => {
    await authApi.authenticateClientAs('EMPLOYEE');
    verify(await userApi.list())
      .hasStatus(HTTP_STATUS.FORBIDDEN)
      .isFailure(API_ERROR_CODES.forbidden);
  });

  /* ------------------------------------------------------------- payloads -- */

  test(`A duplicate email is refused ${TAGS.regression}`, async ({ adminEmployeeApi, cleanup }) => {
    const original = await adminEmployeeApi.createOrThrow(buildEmployee());
    cleanup.employee(original.id);

    const duplicate = await adminEmployeeApi.create(
      buildEmployee({ overrides: { email: original.email } }),
    );
    verify(duplicate).hasStatus(HTTP_STATUS.CONFLICT).isFailure(API_ERROR_CODES.duplicateEmail);
  });

  test(`Malformed JSON is rejected cleanly ${TAGS.regression}`, async ({ adminApiClient }) => {
    const response = await adminApiClient.post(API_ROUTES.employees.root, {
      rawBody: '{ "name": ',
    });

    verify(response)
      .hasStatus(HTTP_STATUS.BAD_REQUEST)
      .isFailure(API_ERROR_CODES.malformedJson)
      .matchesEnvelopeSchema(errorEnvelopeSchema);
  });

  test(`Updating an unknown employee returns 404 ${TAGS.regression}`, async ({
    adminEmployeeApi,
  }) => {
    const response = await adminEmployeeApi.update('emp-does-not-exist', { salary: 1 });
    verify(response).hasStatus(HTTP_STATUS.NOT_FOUND).isFailure(API_ERROR_CODES.notFound);
  });
});
