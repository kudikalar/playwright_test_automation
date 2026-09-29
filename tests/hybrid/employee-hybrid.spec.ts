/**
 * Hybrid UI + API suite.
 *
 * The API does the fast, reliable work — setup, teardown and backend verification — while the UI
 * is exercised only where the user experience is what is under test.
 */

import { HTTP_STATUS } from '@constants/ApiConstants';
import { MODULES, TAGS } from '@constants/TestConstants';
import { verify } from '@api/validators';
import { buildEmployee, buildEmployees } from '@data/factories';
import { expect, test } from '@fixtures/index';

test.describe('Employee hybrid journeys @hybrid', () => {
  test.use({ role: 'ADMIN' });

  test.beforeEach(({}, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.employeeManagement });
  });

  test(`API-seeded data is visible in the UI and removable through the API ${TAGS.hybrid} ${TAGS.critical}`, async ({
    employeesAs,
    adminEmployeeApi,
  }) => {
    const payload = buildEmployee({ templateKey: 'qaLead' });

    const created = await test.step('Set up the record through the API', async () =>
      adminEmployeeApi.createOrThrow(payload));

    await test.step('The UI lists the record with the values the API stored', async () => {
      await employeesAs.open();
      await employeesAs.searchFor(payload.email);
      await employeesAs.expectEmployeeRow(payload);
      expect(await employeesAs.getEmployeeIdByName(payload.name)).toBe(created.id);
    });

    await test.step('Tear the record down through the API', async () => {
      expect(await adminEmployeeApi.deleteIfExists(created.id)).toBe(true);
    });

    await test.step('The UI reflects the removal after a refresh', async () => {
      await employeesAs.reload();
      await employeesAs.searchFor(payload.email);
      await employeesAs.table.expectEmpty();
    });
  });

  test(`A UI-created record is correct in the backend ${TAGS.hybrid}`, async ({
    employeesAs,
    adminEmployeeApi,
    cleanup,
  }) => {
    const payload = buildEmployee({
      templateKey: 'engineer',
      overrides: { joiningDate: '2024-02-29' },
    });

    await test.step('Create the record through the UI', async () => {
      await employeesAs.open();
      await employeesAs.createEmployee({ ...payload, active: true });
    });

    await test.step('The API returns exactly what the form submitted', async () => {
      const stored = await adminEmployeeApi.waitUntilSearchable(payload.email);
      cleanup.employee(stored.id);

      expect(stored).toMatchObject({
        name: payload.name,
        email: payload.email,
        department: payload.department,
        designation: payload.designation,
        salary: payload.salary,
        joiningDate: '2024-02-29',
        status: 'ACTIVE',
      });
    });
  });

  test(`Bulk API setup drives UI filtering and paging ${TAGS.hybrid} ${TAGS.regression}`, async ({
    employeesAs,
    adminEmployeeApi,
    cleanup,
    testData,
  }) => {
    const pageSize = testData.get('employees').pagination.smallPageSize;

    const seeded =
      await test.step(`Seed ${pageSize + 2} finance records through the API`, async () => {
        const created = await adminEmployeeApi.createMany(
          buildEmployees(pageSize + 2, { templateKey: 'financeAnalyst' }),
        );
        created.forEach((employee) => cleanup.employee(employee.id));
        return created;
      });

    await test.step('The UI filter shows the seeded department across pages', async () => {
      await employeesAs.open();
      await employeesAs.filterByDepartment('Finance');
      await employeesAs.pagination.setPageSize(pageSize);

      const state = await employeesAs.pagination.getState();
      expect(state.totalRecords).toBeGreaterThanOrEqual(seeded.length);
      expect(state.totalPages).toBeGreaterThan(1);

      const firstPage = await employeesAs.getVisibleEmployeeNames();
      await employeesAs.pagination.goToNextPage();
      const secondPage = await employeesAs.getVisibleEmployeeNames();
      expect(
        firstPage.some((name) => secondPage.includes(name)),
        'pages must not repeat rows',
      ).toBe(false);
    });

    await test.step('Cleanup through the API leaves the directory as it was', async () => {
      await adminEmployeeApi.deleteAll(seeded.map((employee) => employee.id));
      const remaining = await adminEmployeeApi.list({ department: 'Finance', pageSize: 100 });
      verify(remaining).hasStatus(HTTP_STATUS.OK).isSuccessful();
      const remainingIds = (remaining.data ?? []).map((employee) => employee.id);
      expect(seeded.every((employee) => !remainingIds.includes(employee.id))).toBe(true);
    });
  });

  test(`A role that cannot delete in the API still sees the control ${TAGS.hybrid} ${TAGS.security}`, async ({
    employeesAs,
    authApi,
    employeeApi,
    adminEmployeeApi,
    cleanup,
  }) => {
    const target = await adminEmployeeApi.createOrThrow(buildEmployee());
    cleanup.employee(target.id);

    await test.step('The UI renders a delete action for every row', async () => {
      await employeesAs.open();
      await employeesAs.searchFor(target.email);
      await expect(
        employeesAs.table.rowByText(target.name).getByRole('button', { name: /^Delete/ }),
      ).toBeVisible();
    });

    await test.step('The API refuses the same action for an EMPLOYEE — the boundary is server-side', async () => {
      await authApi.authenticateClientAs('EMPLOYEE');
      verify(await employeeApi.remove(target.id))
        .hasStatus(HTTP_STATUS.FORBIDDEN)
        .isFailure('FORBIDDEN');
    });
  });
});
