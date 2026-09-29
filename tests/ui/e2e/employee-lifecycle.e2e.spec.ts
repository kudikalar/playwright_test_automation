/**
 * End-to-end employee lifecycle.
 *
 * One business journey, start to finish, through the UI only:
 * sign in → dashboard → employees → create → search → update → delete → sign out.
 * Every step is a `test.step`, so the report reads as the workflow rather than as clicks.
 */

import { MODULES, TAGS } from '@constants/TestConstants';
import { buildEmployee } from '@data/factories';
import { expect, test } from '@fixtures/index';

test.describe('Employee lifecycle @e2e', () => {
  test(`An administrator manages an employee from hire to exit ${TAGS.e2e} ${TAGS.critical}`, async ({
    loginPage,
    dashboardPage,
    employeePage,
    adminEmployeeApi,
    cleanup,
  }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.employeeManagement });
    testInfo.annotations.push({
      type: 'description',
      description: 'Sign in, create an employee, find them, promote them, remove them, sign out.',
    });

    const employee = buildEmployee({ templateKey: 'engineer' });
    const promotion = { designation: 'Lead Automation Engineer', salary: 1_650_000 };

    await test.step('1. Sign in as an administrator', async () => {
      await loginPage.open();
      await loginPage.loginAs('ADMIN');
      await dashboardPage.expectLoaded();
    });

    await test.step('2. The dashboard reports a live workforce size', async () => {
      const metrics = await dashboardPage.getMetrics();
      expect(metrics.totalEmployees).toBeGreaterThan(0);
      expect(metrics.departments).toBeGreaterThan(0);
    });

    await test.step('3. Open employee management', async () => {
      await dashboardPage.navigateToEmployees();
      await employeePage.expectLoaded();
    });

    await test.step('4. Create the employee', async () => {
      await employeePage.createEmployee({ ...employee, active: true });
    });

    await test.step('5. Find the new employee', async () => {
      await employeePage.searchFor(employee.email);
      await employeePage.expectEmployeeRow(employee);
      cleanup.employee(await employeePage.getEmployeeIdByName(employee.name));
    });

    /*
     * Rule 22: a test must not depend on state other tests share. The headline count moves as
     * parallel workers create and delete their own records, so the journey verifies the record
     * it owns — through the API, which is the system of record — rather than a global total.
     */
    await test.step('6. The backend holds exactly one record for this employee', async () => {
      const matches = await adminEmployeeApi.list({ search: employee.email, pageSize: 10 });
      expect(matches.data).toHaveLength(1);
      expect(matches.data?.[0]?.email).toBe(employee.email);
    });

    await test.step('7. Promote the employee', async () => {
      await employeePage.searchFor(employee.email);
      await employeePage.updateEmployee(employee.name, promotion);
      await employeePage.searchFor(employee.email);
      await employeePage.table.expectRowMatching({
        Name: employee.name,
        Designation: promotion.designation,
      });
    });

    await test.step('8. The change is persisted server-side', async () => {
      const stored = await adminEmployeeApi.findByEmail(employee.email);
      expect(stored?.designation).toBe(promotion.designation);
      expect(stored?.salary).toBe(promotion.salary);
    });

    await test.step('9. Remove the employee', async () => {
      await employeePage.deleteEmployee(employee.name);
      await employeePage.toast.expectSuccess('Employee deleted');
      await employeePage.expectEmployeeAbsent(employee.name);
    });

    await test.step('10. Sign out', async () => {
      await employeePage.header.logout();
      await loginPage.expectLoaded();
      expect(await loginPage.hasSessionToken()).toBe(false);
    });
  });
});
