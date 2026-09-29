/** REST contract constants: routes, headers and status codes. No business logic. */

/** Every endpoint the service layer talks to, relative to the environment's API base URL. */
export const API_ROUTES = {
  health: '/health',
  auth: {
    login: '/auth/login',
    logout: '/auth/logout',
    me: '/auth/me',
  },
  users: {
    list: '/users',
  },
  employees: {
    root: '/employees',
    byId: (id: string): string => `/employees/${encodeURIComponent(id)}`,
  },
  departments: '/departments',
} as const;

export const HTTP_HEADERS = {
  authorization: 'Authorization',
  contentType: 'Content-Type',
  accept: 'Accept',
  apiKey: 'x-api-key',
  correlationId: 'x-correlation-id',
  requestId: 'x-request-id',
} as const;

export const CONTENT_TYPES = {
  json: 'application/json',
  formUrlEncoded: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data',
  csv: 'text/csv',
} as const;

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

/** Error codes the API is contracted to return; asserted by negative tests. */
export const API_ERROR_CODES = {
  validation: 'VALIDATION_ERROR',
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  notFound: 'NOT_FOUND',
  duplicateEmail: 'DUPLICATE_EMAIL',
  protectedRecord: 'PROTECTED_RECORD',
  malformedJson: 'MALFORMED_JSON',
  routeNotFound: 'ROUTE_NOT_FOUND',
} as const;

/** Status codes worth one automatic retry for idempotent calls. */
export const RETRYABLE_STATUS_CODES: readonly number[] = [
  HTTP_STATUS.TOO_MANY_REQUESTS,
  HTTP_STATUS.INTERNAL_SERVER_ERROR,
  HTTP_STATUS.BAD_GATEWAY,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
];

export const IDEMPOTENT_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];
