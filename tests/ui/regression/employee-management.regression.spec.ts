/**
 * Employee management regression suite.
 *
 * Exercises the full UI workflow through Page Objects and components. Every record is created
 * from a JSON template with unique runtime values and removed through the API in teardown, so
 * the suite is safe to run in parallel and leaves no residue.
 */

import { MODULES, TAGS } from '@constants/TestConstants';
import { buildEmployee } from '@data/factories';
import { expect, test } from '@fixtures/index';

test.describe('Employee management @ui', () => {
  test.use({ role: 'ADMIN' });

  test.beforeEach(async ({ employeesAs }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.employeeManagement });
    await employeesAs.open();
  });

  test(`An employee can be created through the UI ${TAGS.regression} ${TAGS.critical}`, async ({
    employeesAs,
    cleanup,
  }) => {
    const employee = buildEmployee({ templateKey: 'engineer' });

    await test.step('Create the record', async () => {
      await employeesAs.createEmployee({ ...employee, active: true });
    });

    await test.step('The new record is listed with the values submitted', async () => {
      await employeesAs.searchFor(employee.email);
      await employeesAs.expectEmployeeRow(employee);
      cleanup.employee(await employeesAs.getEmployeeIdByName(employee.name));
    });
  });

  test(`An employee can be updated ${TAGS.regression}`, async ({
    employeesAs,
    adminEmployeeApi,
    cleanup,
  }) => {
    const created = await adminEmployeeApi.createOrThrow(buildEmployee({ templateKey: 'qaLead' }));
    cleanup.employee(created.id);
    await employeesAs.reload();

    await test.step('Change the designation and department', async () => {
      await employeesAs.searchFor(created.email);
      await employeesAs.updateEmployee(created.name, {
        designation: 'Principal SDET',
        department: 'Engineering',
      });
    });

    await test.step('The table reflects the change', async () => {
      await employeesAs.searchFor(created.email);
      await employeesAs.table.expectRowMatching({
        Name: created.name,
        Designation: 'Principal SDET',
        Department: 'Engineering',
      });
    });
  });

  test(`An employee can be deleted, and cancelling keeps the record ${TAGS.regression}`, async ({
    employeesAs,
    adminEmployeeApi,
    cleanup,
  }) => {
    const created = await adminEmployeeApi.createOrThrow(buildEmployee());
    cleanup.employee(created.id);
    await employeesAs.reload();
    await employeesAs.searchFor(created.email);

    await test.step('Cancelling the confirmation keeps the record', async () => {
      await employeesAs.cancelDelete(created.name);
      await employeesAs.expectEmployeeVisible(created.name);
    });

    await test.step('Confirming removes it from the directory', async () => {
      await employeesAs.deleteEmployee(created.name);
      await employeesAs.toast.expectSuccess('Employee deleted');
      await employeesAs.expectEmployeeAbsent(created.name);
    });

    await test.step('It is gone from the API as well', async () => {
      const response = await adminEmployeeApi.getById(created.id);
      expect(response.status).toBe(404);
    });
  });

  test(`Search narrows the directory and reports no matches ${TAGS.regression}`, async ({
    employeesAs,
    testData,
  }) => {
    const data = testData.get('employees');

    await test.step('A known employee is found by email', async () => {
      await employeesAs.searchFor(data.search.knownSeededEmail);
      await employeesAs.expectEmployeeVisible(data.search.knownSeededName);
      await expect(employeesAs.table.rows).toHaveCount(1);
    });

    await test.step('An unmatched term shows the empty state', async () => {
      await employeesAs.searchFor(data.search.noResultsTerm);
      await employeesAs.table.expectEmpty();
    });

    await test.step('Clearing the filters restores the directory', async () => {
      await employeesAs.clearFilters();
      expect(await employeesAs.table.getRowCount()).toBeGreaterThan(0);
    });
  });

  test(`The directory can be filtered by department ${TAGS.regression}`, async ({
    employeesAs,
    testData,
  }) => {
    const [department] = testData.get('employees').departments;
    await employeesAs.filterByDepartment(department!);

    const departments = await employeesAs.table.getColumnValues('Department');
    expect(departments.length).toBeGreaterThan(0);
    expect(new Set(departments)).toEqual(new Set([department]));
  });

  test(`The table sorts and paginates ${TAGS.regression}`, async ({ employeesAs, testData }) => {
    const data = testData.get('employees');

    await test.step('Clicking a column header toggles the sort direction', async () => {
      const first = await employeesAs.table.sortByColumn('Name');
      expect(
        await employeesAs.table.isColumnSorted('Name', first === 'ascending' ? 'asc' : 'desc'),
      ).toBe(true);

      const second = await employeesAs.table.sortByColumn('Name');
      expect(second, 'a second click must reverse the order').not.toBe(first);
      expect(
        await employeesAs.table.isColumnSorted('Name', second === 'ascending' ? 'asc' : 'desc'),
      ).toBe(true);
    });

    await test.step('A smaller page size splits the directory', async () => {
      await employeesAs.pagination.setPageSize(data.pagination.smallPageSize);
      const state = await employeesAs.pagination.getState();
      expect(state.page).toBe(1);
      expect(await employeesAs.table.getRowCount()).toBeLessThanOrEqual(
        data.pagination.smallPageSize,
      );
      expect(await employeesAs.pagination.isFirstPage()).toBe(true);
    });

    await test.step('Paging forward and back returns to the first page', async () => {
      const before = await employeesAs.pagination.getState();
      test.skip(before.totalPages < 2, 'Directory is smaller than one page in this environment');
      await employeesAs.pagination.goToNextPage();
      expect((await employeesAs.pagination.getState()).page).toBe(2);
      await employeesAs.pagination.goToPreviousPage();
      expect((await employeesAs.pagination.getState()).page).toBe(1);
    });
  });

  test(`A joining date is chosen from the calendar ${TAGS.regression}`, async ({
    employeesAs,
    cleanup,
  }) => {
    const employee = buildEmployee({ overrides: { joiningDate: '2023-07-14' } });

    await employeesAs.createEmployee({ ...employee, active: true });
    await employeesAs.searchFor(employee.email);
    await employeesAs.expectEmployeeVisible(employee.name);
    cleanup.employee(await employeesAs.getEmployeeIdByName(employee.name));
  });

  /* ---------------------------------------------------- data-driven cases -- */

  test.describe(`Form validation ${TAGS.negative}`, () => {
    const requiredFieldCases = [
      { scenario: 'name is missing', omit: 'name' as const },
      { scenario: 'email is missing', omit: 'email' as const },
      { scenario: 'designation is missing', omit: 'designation' as const },
    ];

    for (const testCase of requiredFieldCases) {
      test(`The form is rejected when ${testCase.scenario} ${TAGS.regression}`, async ({
        employeesAs,
      }) => {
        const employee = buildEmployee();
        const payload: Record<string, unknown> = { ...employee, active: true };
        delete payload[testCase.omit];

        const message = await employeesAs.attemptInvalidCreate(payload);
        expect(message).toContain(testCase.omit);
        await employeesAs.formModal.expectOpen();
        await employeesAs.formModal.cancel();
      });
    }

    test(`A duplicate email is refused by the server ${TAGS.regression}`, async ({
      employeesAs,
      adminEmployeeApi,
      cleanup,
    }) => {
      const existing = await adminEmployeeApi.createOrThrow(buildEmployee());
      cleanup.employee(existing.id);

      const duplicate = buildEmployee({ overrides: { email: existing.email } });
      await employeesAs.openCreateForm();
      await employeesAs.fillEmployeeForm({ ...duplicate, active: true });
      await employeesAs.submitForm();

      await expect(employeesAs.formModal.errorMessage).toContainText('already exists');
      await employeesAs.toast.expectError('Save failed');
      await employeesAs.formModal.cancel();
    });
  });
});
