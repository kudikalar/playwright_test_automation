/** Shapes of the JSON files under `test-data/`. Every functional value lives there, never in a spec. */

import type { EmployeeStatus } from './ApiModels';
import type { UserRole } from './Environment';

/** A credential reference: a spec names a role, the framework resolves the secret. */
export interface UserReference {
  readonly role: UserRole;
  readonly description: string;
}

export interface InvalidLoginCase {
  readonly scenario: string;
  readonly username: string;
  readonly password: string;
  readonly expectedError: string;
  readonly tags?: readonly string[];
}

export interface LoginTestData {
  readonly validUsers: readonly UserReference[];
  readonly invalidScenarios: readonly InvalidLoginCase[];
  readonly ui: {
    readonly pageTitle: string;
    readonly submitLabel: string;
    readonly invalidCredentialsMessage: string;
    readonly missingFieldsMessage: string;
  };
}

/** A template; unique runtime values are layered on by `EmployeeDataFactory`. */
export interface EmployeeTemplate {
  readonly key: string;
  readonly namePrefix: string;
  readonly emailPrefix: string;
  readonly department: string;
  readonly designation: string;
  readonly salary: number;
  readonly status: EmployeeStatus;
}

export interface EmployeeValidationCase {
  readonly scenario: string;
  readonly overrides: Record<string, unknown>;
  readonly expectedStatus: number;
  readonly expectedErrorCode: string;
  readonly expectedField?: string;
}

export interface EmployeeTestData {
  readonly templates: readonly EmployeeTemplate[];
  readonly departments: readonly string[];
  readonly validation: readonly EmployeeValidationCase[];
  readonly search: {
    readonly knownSeededEmail: string;
    readonly knownSeededName: string;
    readonly noResultsTerm: string;
  };
  readonly pagination: {
    readonly defaultPageSize: number;
    readonly smallPageSize: number;
  };
}

export interface DashboardTestData {
  readonly heading: string;
  readonly metricLabels: readonly string[];
  readonly navigationItems: readonly { readonly label: string; readonly path: string }[];
  readonly exportFileName: string;
  readonly resetConfirmationMessage: string;
}

export interface ApiTestData {
  readonly endpoints: {
    readonly health: string;
    readonly login: string;
    readonly me: string;
    readonly employees: string;
  };
  readonly performance: {
    readonly maxResponseTimeMs: number;
    readonly maxListResponseTimeMs: number;
  };
  readonly negative: readonly {
    readonly scenario: string;
    readonly path: string;
    readonly method: string;
    readonly expectedStatus: number;
    readonly expectedErrorCode: string;
  }[];
}

export type Gender = 'male' | 'female';

/**
 * A registration that must succeed. The email is built at runtime from `emailPrefix`, because the
 * shop keeps every account forever and a fixed address would only ever register once.
 */
export interface ValidRegistration {
  readonly gender: Gender;
  readonly firstName: string;
  readonly lastName: string;
  readonly emailPrefix: string;
  readonly password: string;
}

/** A registration the form must reject, and the validation messages it must show. */
export interface InvalidRegistrationCase {
  readonly scenario: string;
  readonly gender: Gender;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly password: string;
  /** Defaults to `password` when omitted. */
  readonly confirmPassword?: string;
  readonly expectedErrors: readonly string[];
}

/** `test-data/demoshop/register.json` — only meaningful under TEST_ENV=demoshop. */
export interface RegisterTestData {
  readonly validUser: ValidRegistration;
  readonly invalidScenarios: readonly InvalidRegistrationCase[];
  readonly ui: {
    readonly successMessage: string;
  };
}

export interface ForgotPasswordTestData {
  readonly validUser: {
    readonly email: string;
    readonly successMessage: string;
  };
  readonly invalidScenarios: readonly {
    readonly scenario: string;
    readonly email: string;
    readonly expectedError: string;
  }[];
  readonly ui: {
    readonly heading: string;
    readonly submitLabel: string;
  };
}
/** Registry of every dataset name the framework knows, keyed to its parsed type. */
export interface TestDataRegistry {
  readonly login: LoginTestData;
  readonly employees: EmployeeTestData;
  readonly dashboard: DashboardTestData;
  readonly api: ApiTestData;
  readonly register: RegisterTestData;
  readonly forgotPassword: ForgotPasswordTestData;
}

export type TestDataName = keyof TestDataRegistry;
