/**
 * Employee API regression suite: the full CRUD contract plus list behaviour.
 * Records are created from JSON templates and removed by the cleanup fixture.
 */

import { HTTP_STATUS } from '@constants/ApiConstants';
import { MODULES, TAGS } from '@constants/TestConstants';
import { employeeSchema } from '@api/models/schemas';
import { verify } from '@api/validators';
import { buildEmployee, buildEmployees } from '@data/factories';
import { expect, test } from '@fixtures/index';

test.describe('Employee API @api', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULES.employeeManagement });
  });

  test(`An employee can be created and read back ${TAGS.regression} ${TAGS.critical}`, async ({
    adminEmployeeApi,
    cleanup,
  }) => {
    const payload = buildEmployee({ templateKey: 'engineer' });

    const created = await test.step('POST /employees', async () => {
      const response = await adminEmployeeApi.create(payload);
      const employee = verify(response)
        .hasStatus(HTTP_STATUS.CREATED)
        .isSuccessful()
        .matchesSchema(employeeSchema)
        .hasProperty('email', payload.email)
        .hasProperty('department', payload.department)
        .unwrap();
      cleanup.employee(employee.id);
      return employee;
    });

    await test.step('GET /employees/:id returns the same record', async () => {
      const response = await adminEmployeeApi.getById(created.id);
      const fetched = verify(response).hasStatus(HTTP_STATUS.OK).isSuccessful().unwrap();
      expect(fetched).toMatchObject({
        id: created.id,
        name: payload.name,
        email: payload.email,
        designation: payload.designation,
      });
    });
  });

  test(`An employee can be replaced with PUT ${TAGS.regression}`, async ({
    adminEmployeeApi,
    cleanup,
  }) => {
    const created = await adminEmployeeApi.createOrThrow(buildEmployee());
    cleanup.employee(created.id);

    const replacement = buildEmployee({
      templateKey: 'financeAnalyst',
      overrides: { email: created.email },
    });
    const response = await adminEmployeeApi.replace(created.id, replacement);

    verify(response)
      .hasStatus(HTTP_STATUS.OK)
      .isSuccessful()
      .matchesSchema(employeeSchema)
      .hasProperty('designation', replacement.designation)
      .hasProperty('department', replacement.department)
      .satisfies((employee) => employee?.id === created.id, 'the identifier must be preserved');
  });

  test(`An employee can be amended with PATCH ${TAGS.regression}`, async ({
    adminEmployeeApi,
    cleanup,
  }) => {
    const created = await adminEmployeeApi.createOrThrow(buildEmployee());
    cleanup.employee(created.id);

    const response = await adminEmployeeApi.update(created.id, {
      salary: 1_999_000,
      status: 'INACTIVE',
    });

    verify(response)
      .hasStatus(HTTP_STATUS.OK)
      .isSuccessful()
      .hasProperty('salary', 1_999_000)
      .hasProperty('status', 'INACTIVE')
      .hasProperty('name', created.name);
  });

  test(`An employee can be deleted ${TAGS.regression} ${TAGS.critical}`, async ({
    adminEmployeeApi,
  }) => {
    const created = await adminEmployeeApi.createOrThrow(buildEmployee());

    const deleted = await adminEmployeeApi.remove(created.id);
    expect(deleted.status).toBe(HTTP_STATUS.NO_CONTENT);

    const afterDelete = await adminEmployeeApi.getById(created.id);
    verify(afterDelete).hasStatus(HTTP_STATUS.NOT_FOUND).isFailure('NOT_FOUND');
  });

  test(`The directory supports search, filter, sort and paging ${TAGS.regression}`, async ({
    adminEmployeeApi,
    cleanup,
  }) => {
    const created = await adminEmployeeApi.createMany(buildEmployees(3, { templateKey: 'qaLead' }));
    created.forEach((employee) => cleanup.employee(employee.id));

    await test.step('Search matches on email', async () => {
      const target = created[0]!;
      const response = await adminEmployeeApi.list({ search: target.email });
      verify(response)
        .hasStatus(HTTP_STATUS.OK)
        .isArray({ length: 1 })
        .hasProperty('0.email', target.email);
    });

    await test.step('Filtering returns only the requested department', async () => {
      const response = await adminEmployeeApi.list({
        department: 'Quality Assurance',
        pageSize: 100,
      });
      verify(response)
        .isSuccessful()
        .isArray({ minLength: 3 })
        .everyItem(
          (employee) => (employee as { department: string }).department === 'Quality Assurance',
          'department must be Quality Assurance',
        );
    });

    await test.step('Sorting by salary is honoured', async () => {
      const response = await adminEmployeeApi.list({
        sortBy: 'salary',
        sortOrder: 'desc',
        pageSize: 100,
      });
      const salaries = (response.data ?? []).map((employee) => employee.salary);
      expect(salaries).toEqual([...salaries].sort((a, b) => b - a));
    });

    await test.step('Paging splits the directory consistently', async () => {
      const firstPage = await adminEmployeeApi.list({ page: 1, pageSize: 2 });
      const secondPage = await adminEmployeeApi.list({ page: 2, pageSize: 2 });

      verify(firstPage).hasPaginationMeta().isArray({ length: 2 });
      expect(firstPage.meta?.totalPages).toBe(Math.ceil((firstPage.meta?.total ?? 0) / 2));

      const firstIds = (firstPage.data ?? []).map((employee) => employee.id);
      const secondIds = (secondPage.data ?? []).map((employee) => employee.id);
      expect(
        firstIds.some((id) => secondIds.includes(id)),
        'pages must not overlap',
      ).toBe(false);
    });
  });

  test(`A created record becomes searchable ${TAGS.regression}`, async ({
    adminEmployeeApi,
    cleanup,
  }) => {
    const payload = buildEmployee();
    const created = await adminEmployeeApi.createOrThrow(payload);
    cleanup.employee(created.id);

    const found = await adminEmployeeApi.waitUntilSearchable(payload.email);
    expect(found.id).toBe(created.id);
  });
});
