/** Wire contracts for the application's REST API. */

import type { UserRole } from './Environment';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface ApiErrorDetail {
  readonly field: string;
  readonly message: string;
}

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[] | Record<string, unknown>;
}

export interface PaginationMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

/** The `{ success, data | error }` envelope every endpoint returns. */
export interface ApiEnvelope<TData> {
  readonly success: boolean;
  readonly data?: TData;
  readonly error?: ApiErrorBody;
  readonly meta?: PaginationMeta;
}

/** A parsed API response plus the diagnostics the reporter and validators need. */
export interface ApiResponse<TData> {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ApiEnvelope<TData>;
  /** Convenience accessor for `body.data`; throws through validators when absent. */
  readonly data: TData | undefined;
  readonly error: ApiErrorBody | undefined;
  readonly meta: PaginationMeta | undefined;
  /** Wall-clock duration of the call, in milliseconds. */
  readonly durationMs: number;
  readonly requestId: string | undefined;
  readonly url: string;
  readonly method: HttpMethod;
}

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
}

export interface LoginRequest {
  readonly username: string;
  readonly password: string;
}

export interface LoginResponse {
  readonly token: string;
  readonly expiresIn: number;
  readonly user: AuthenticatedUser;
}

export type EmployeeStatus = 'ACTIVE' | 'INACTIVE';

export interface Employee {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly department: string;
  readonly designation: string;
  readonly salary: number;
  readonly joiningDate: string;
  readonly status: EmployeeStatus;
  readonly seeded?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EmployeeCreateRequest {
  readonly name: string;
  readonly email: string;
  readonly department: string;
  readonly designation: string;
  readonly salary?: number;
  readonly joiningDate?: string;
  readonly status?: EmployeeStatus;
}

export type EmployeeUpdateRequest = Partial<EmployeeCreateRequest>;

export interface EmployeeQuery {
  readonly search?: string;
  readonly department?: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly sortBy?: 'name' | 'email' | 'department' | 'designation' | 'salary';
  readonly sortOrder?: 'asc' | 'desc';
}

export interface HealthStatus {
  readonly status: string;
  readonly uptimeSeconds: number;
  readonly employees: number;
}
