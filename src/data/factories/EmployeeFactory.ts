/**
 * Employee data factory.
 *
 * Implements the test-data lifecycle (rule 29): the JSON template is the source of functional
 * values, and unique runtime values (email, name, joining date) are layered on top so records
 * never collide across parallel workers.
 */

import { resolveEnvironmentName } from '../../../config/environment.config';
import type { EmployeeCreateRequest } from '../../types/ApiModels';
import type { EmployeeTemplate, EmployeeTestData } from '../../types/TestData';
import { addDays, toIsoDate } from '../../utils/DateUtils';
import { TestDataError } from '../../utils/FrameworkError';
import { readTestData } from '../../utils/JsonReader';
import { uniqueEmail, uniqueName, randomSalary } from '../../utils/RandomUtils';

export interface BuildOptions {
  /** Template key from `test-data/**\/employees.json`; defaults to the first template. */
  readonly templateKey?: string;
  /** Field-level overrides applied last. */
  readonly overrides?: Partial<EmployeeCreateRequest>;
  /** Randomise the salary instead of using the template value. */
  readonly randomSalary?: boolean;
}

function dataset(): EmployeeTestData {
  return readTestData('employees', { environment: resolveEnvironmentName() });
}

function selectTemplate(key?: string): EmployeeTemplate {
  const templates = dataset().templates;
  const template = key ? templates.find((candidate) => candidate.key === key) : templates[0];
  if (!template) {
    throw new TestDataError('Employee template not found', {
      operation: 'selectTemplate',
      target: key ?? '(first template)',
      expected: `one of: ${templates.map((candidate) => candidate.key).join(', ')}`,
    });
  }
  return template;
}

/** Builds a unique, valid create payload from a JSON template. */
export function buildEmployee(options: BuildOptions = {}): EmployeeCreateRequest {
  const template = selectTemplate(options.templateKey);
  return {
    name: uniqueName(template.namePrefix),
    email: uniqueEmail(template.emailPrefix),
    department: template.department,
    designation: template.designation,
    salary: options.randomSalary ? randomSalary() : template.salary,
    joiningDate: toIsoDate(addDays(new Date(), -30)),
    status: template.status,
    ...options.overrides,
  };
}

/** Builds several unique payloads from the same template. */
export function buildEmployees(count: number, options: BuildOptions = {}): EmployeeCreateRequest[] {
  return Array.from({ length: count }, () => buildEmployee(options));
}

/** One payload per template declared in the dataset — for coverage across departments. */
export function buildOnePerTemplate(): EmployeeCreateRequest[] {
  return dataset().templates.map((template) => buildEmployee({ templateKey: template.key }));
}

/**
 * Builds an intentionally invalid payload from a validation case in the dataset.
 * The overrides come from JSON, so negative expectations live beside the data they describe.
 */
export function buildInvalidEmployee(scenario: string): {
  payload: EmployeeCreateRequest;
  expectedStatus: number;
  expectedErrorCode: string;
  expectedField: string | undefined;
} {
  const testCase = dataset().validation.find((candidate) => candidate.scenario === scenario);
  if (!testCase) {
    throw new TestDataError('Validation scenario not found', {
      operation: 'buildInvalidEmployee',
      target: scenario,
      expected: dataset()
        .validation.map((candidate) => candidate.scenario)
        .join(' | '),
    });
  }
  return {
    payload: { ...buildEmployee(), ...(testCase.overrides as Partial<EmployeeCreateRequest>) },
    expectedStatus: testCase.expectedStatus,
    expectedErrorCode: testCase.expectedErrorCode,
    expectedField: testCase.expectedField,
  };
}

/** The departments the application accepts, from JSON. */
export function allowedDepartments(): readonly string[] {
  return dataset().departments;
}
