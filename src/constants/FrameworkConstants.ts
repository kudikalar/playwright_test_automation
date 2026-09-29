/** Framework-wide, non-business constants. Nothing here is environment or feature specific. */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute repository root, resolved from this file rather than `process.cwd()`. */
export const ROOT_DIR = resolve(HERE, '..', '..');

export const PATHS = {
  root: ROOT_DIR,
  config: resolve(ROOT_DIR, 'config'),
  environments: resolve(ROOT_DIR, 'config', 'environments'),
  testData: resolve(ROOT_DIR, 'test-data'),
  storage: resolve(ROOT_DIR, 'storage'),
  authState: resolve(ROOT_DIR, 'storage', 'auth'),
  reports: resolve(ROOT_DIR, 'reports'),
  extentReport: resolve(ROOT_DIR, 'reports', 'extent'),
  playwrightReport: resolve(ROOT_DIR, 'reports', 'playwright'),
  jsonReport: resolve(ROOT_DIR, 'reports', 'json'),
  junitReport: resolve(ROOT_DIR, 'reports', 'junit'),
  screenshots: resolve(ROOT_DIR, 'reports', 'screenshots'),
  videos: resolve(ROOT_DIR, 'reports', 'videos'),
  traces: resolve(ROOT_DIR, 'reports', 'traces'),
  testResults: resolve(ROOT_DIR, 'test-results'),
  logs: resolve(ROOT_DIR, 'logs'),
  downloads: resolve(ROOT_DIR, 'reports', 'downloads'),
  uploads: resolve(ROOT_DIR, 'test-data', 'files'),
  snapshots: resolve(ROOT_DIR, 'tests', 'visual', '__screenshots__'),
} as const;

/** Directories the framework guarantees exist before a run starts. */
export const REQUIRED_DIRECTORIES: readonly string[] = [
  PATHS.authState,
  PATHS.extentReport,
  PATHS.screenshots,
  PATHS.downloads,
  PATHS.logs,
];

/** Last-resort timeouts. Environment JSON overrides all of these. */
export const DEFAULT_TIMEOUTS = {
  test: 60_000,
  action: 15_000,
  navigation: 30_000,
  expect: 10_000,
  api: 20_000,
  /** Upper bound for a short poll (element settle, toast dismissal). */
  shortPoll: 5_000,
} as const;

export const STORAGE_STATE_VERSION = 'v1';

/** File name for a role's persisted authentication state. */
export function authStateFileName(role: string, environment: string): string {
  return `${environment}.${role.toLowerCase()}.${STORAGE_STATE_VERSION}.json`;
}

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;

/** Keys whose values must never reach a log line, report or attachment. */
export const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'authorization',
  'auth',
  'cookie',
  'set-cookie',
  'apikey',
  'api_key',
  'x-api-key',
  'secret',
  'clientsecret',
  'client_secret',
  'privatekey',
  'private_key',
  'sessionid',
  'session_id',
  'otp',
  'pin',
  'creditcard',
  'cvv',
];

export const MASKED_VALUE = '***REDACTED***';

/** Viewport profiles used by the Playwright projects and by responsive assertions. */
export const VIEWPORTS = {
  desktop: { width: 1920, height: 1080 },
  laptop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
} as const;

export const FRAMEWORK_NAME = 'Playwright Enterprise Framework';
export const FRAMEWORK_VERSION = '1.0.0';
