/**
 * Employee domain service.
 *
 * Everything a test needs to set up, read back and clean up employee records, so specs never
 * assemble raw HTTP calls.
 */

import { API_ROUTES } from '../../constants/ApiConstants';
import type {
  ApiResponse,
  Employee,
  EmployeeCreateRequest,
  EmployeeQuery,
  EmployeeUpdateRequest,
} from '../../types/ApiModels';
import { ApiRequestError } from '../../utils/FrameworkError';
import { pollUntil } from '../../utils/RetryUtils';
import { BaseApiService } from './BaseApiService';

export class EmployeeApi extends BaseApiService {
  public async list(query: EmployeeQuery = {}): Promise<ApiResponse<Employee[]>> {
    return this.client.get<Employee[]>(API_ROUTES.employees.root, {
      query: {
        search: query.search,
        department: query.department,
        page: query.page,
        pageSize: query.pageSize,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      },
    });
  }

  public async getById(id: string): Promise<ApiResponse<Employee>> {
    return this.client.get<Employee>(API_ROUTES.employees.byId(id));
  }

  public async create(payload: EmployeeCreateRequest): Promise<ApiResponse<Employee>> {
    return this.client.post<Employee>(API_ROUTES.employees.root, { body: payload });
  }

  public async replace(id: string, payload: EmployeeCreateRequest): Promise<ApiResponse<Employee>> {
    return this.client.put<Employee>(API_ROUTES.employees.byId(id), { body: payload });
  }

  public async update(id: string, payload: EmployeeUpdateRequest): Promise<ApiResponse<Employee>> {
    return this.client.patch<Employee>(API_ROUTES.employees.byId(id), { body: payload });
  }

  public async remove(id: string): Promise<ApiResponse<never>> {
    return this.client.delete<never>(API_ROUTES.employees.byId(id));
  }

  /* ----------------------------------------------------- test lifecycle -- */

  /**
   * Creates a record for test setup and throws when the API refuses, so a failing precondition
   * never surfaces later as a confusing UI assertion failure.
   */
  public async createOrThrow(payload: EmployeeCreateRequest): Promise<Employee> {
    const response = await this.create(payload);
    if (!response.ok || !response.data) {
      throw new ApiRequestError('Employee setup failed', {
        operation: 'createOrThrow',
        target: payload.email,
        expected: 'HTTP 201 with the created record',
        actual:
          `HTTP ${response.status} ${response.error?.code ?? ''} ${response.error?.message ?? ''}`.trim(),
      });
    }
    this.log.info('employee created for test setup', {
      id: response.data.id,
      email: payload.email,
    });
    return response.data;
  }

  /** Creates several records in sequence; returns them in the order requested. */
  public async createMany(payloads: readonly EmployeeCreateRequest[]): Promise<Employee[]> {
    const created: Employee[] = [];
    for (const payload of payloads) {
      created.push(await this.createOrThrow(payload));
    }
    return created;
  }

  public async findByEmail(email: string): Promise<Employee | undefined> {
    const response = await this.list({ search: email, pageSize: 100 });
    return response.data?.find((employee) => employee.email.toLowerCase() === email.toLowerCase());
  }

  /** Waits for a record to become visible in the list (eventual consistency after a write). */
  public async waitUntilSearchable(email: string, maxAttempts = 5): Promise<Employee> {
    const found = await pollUntil(
      async () => this.findByEmail(email),
      (employee) => employee !== undefined,
      { maxAttempts, intervalMs: 300, description: `employee ${email} in search results` },
    );
    return found as Employee;
  }

  /**
   * Removes a record if it still exists. Safe to call from teardown: a record already deleted by
   * the test, or protected by the API, does not fail the cleanup.
   */
  public async deleteIfExists(id: string): Promise<boolean> {
    const response = await this.remove(id);
    if (response.status === 204) {
      this.log.info('employee cleaned up', { id });
      return true;
    }
    if (response.status === 404) return false;
    this.log.warn('cleanup could not delete employee', { id, status: response.status });
    return false;
  }

  /** Bulk cleanup for a test that created several records. */
  public async deleteAll(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.deleteIfExists(id);
    }
  }

  public async countAll(): Promise<number> {
    const response = await this.list({ pageSize: 1 });
    return response.meta?.total ?? 0;
  }
}
