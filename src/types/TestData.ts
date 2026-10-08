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

/**
 * A registration that must succeed. The email and mobile are built at runtime (from `emailPrefix`
 * and a random 10-digit number), because the site keeps every account and a fixed value would
 * only ever register once.
 */
export interface ValidRegistration {
  readonly firstName: string;
  readonly lastName?: string;
  readonly emailPrefix: string;
  readonly emailDomain: string;
  readonly password: string;
}

export interface InvalidEmailRegistration {
  readonly email: string;
  readonly expectedErrors: readonly string[];
}

/** A registration the form must reject, and the validation messages it must show. */
export interface InvalidRegistrationCase {
  readonly scenario: string;
  readonly firstName: string;
  readonly lastName?: string;
  readonly email: string;
  readonly mobile: string;
  readonly password: string;
  /** Defaults to `password` when omitted. */
  readonly confirmPassword?: string;
  /** Defaults to `true` when omitted. */
  readonly acceptTerms?: boolean;
  readonly expectedErrors: readonly string[];
}

/** `test-data/demoshop/register.json` — only meaningful under TEST_ENV=demoshop. */
export interface RegisterTestData {
  readonly validUser: ValidRegistration;
  readonly invalidScenarios: readonly InvalidRegistrationCase[];
  readonly ui: {
    readonly heading: string;
    readonly subtitle: string;
    readonly passwordHint: string;
    readonly submitLabel: string;
    readonly successMessage: string;
    readonly formErrorMessage: string;
  };
  readonly invalidEmail: InvalidEmailRegistration;
}

export interface ForgotPasswordTestData {
  readonly validUser: {
    readonly email: string;
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
