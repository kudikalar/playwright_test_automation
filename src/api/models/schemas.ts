/**
 * JSON Schemas for contract testing.
 *
 * Kept as typed objects rather than loose JSON so a schema change fails compilation when the
 * matching TypeScript model is not updated alongside it.
 */

export interface JsonSchema {
  readonly $schema?: string;
  readonly title?: string;
  readonly type: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: unknown;
  readonly [keyword: string]: unknown;
}

export const employeeSchema: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Employee',
  type: 'object',
  required: [
    'id',
    'name',
    'email',
    'department',
    'designation',
    'salary',
    'status',
    'createdAt',
    'updatedAt',
  ],
  additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    department: { type: 'string', minLength: 1 },
    designation: { type: 'string', minLength: 1 },
    salary: { type: 'number', minimum: 0 },
    joiningDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
    seeded: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export const employeeListSchema: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'EmployeeList',
  type: 'array',
  items: employeeSchema,
};

export const authenticatedUserSchema: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'AuthenticatedUser',
  type: 'object',
  required: ['id', 'email', 'name', 'role'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    name: { type: 'string', minLength: 1 },
    role: { type: 'string', enum: ['ADMIN', 'MANAGER', 'EMPLOYEE', 'STUDENT', 'MENTOR'] },
  },
};

export const loginResponseSchema: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'LoginResponse',
  type: 'object',
  required: ['token', 'expiresIn', 'user'],
  additionalProperties: true,
  properties: {
    token: { type: 'string', minLength: 10 },
    expiresIn: { type: 'number', exclusiveMinimum: 0 },
    user: authenticatedUserSchema,
  },
};

export const paginationMetaSchema: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'PaginationMeta',
  type: 'object',
  required: ['page', 'pageSize', 'total', 'totalPages'],
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1 },
    pageSize: { type: 'integer', minimum: 1 },
    total: { type: 'integer', minimum: 0 },
    totalPages: { type: 'integer', minimum: 1 },
  },
};

export const errorEnvelopeSchema: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'ErrorEnvelope',
  type: 'object',
  required: ['success', 'error'],
  additionalProperties: true,
  properties: {
    success: { type: 'boolean', enum: [false] },
    error: {
      type: 'object',
      required: ['code', 'message'],
      additionalProperties: true,
      properties: {
        code: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
      },
    },
  },
};

export const healthSchema: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Health',
  type: 'object',
  required: ['status'],
  additionalProperties: true,
  properties: {
    status: { type: 'string', minLength: 1 },
    uptimeSeconds: { type: 'number', minimum: 0 },
    employees: { type: 'integer', minimum: 0 },
  },
};
