/** Suite taxonomy and shared test-level constants. */

/** Tags drive CLI selection (`--grep @smoke`) and report grouping. */
export const TAGS = {
  smoke: '@smoke',
  sanity: '@sanity',
  regression: '@regression',
  e2e: '@e2e',
  api: '@api',
  ui: '@ui',
  hybrid: '@hybrid',
  contract: '@contract',
  negative: '@negative',
  critical: '@critical',
  security: '@security',
  visual: '@visual',
  accessibility: '@a11y',
  dataDriven: '@data-driven',
  flakyWatch: '@flaky-watch',
  functional: '@functional',
} as const;

export type Tag = (typeof TAGS)[keyof typeof TAGS];

/** Business modules; surfaced as a report dimension. */
export const MODULES = {
  authentication: 'Authentication',
  dashboard: 'Dashboard',
  employeeManagement: 'Employee Management',
  userManagement: 'User Management',
  platform: 'Platform',
  register: 'Register',
} as const;

export type ModuleName = (typeof MODULES)[keyof typeof MODULES];

/** Suite names used by CI jobs and by the Extent report grouping. */
export const SUITES = {
  smoke: 'Smoke',
  sanity: 'Sanity',
  regression: 'Regression',
  e2e: 'End to End',
  api: 'API',
  contract: 'Contract',
  hybrid: 'Hybrid UI + API',
  visual: 'Visual',
} as const;

/** Time budgets asserted by tests (kept out of specs so they can be tuned centrally). */
export const PERFORMANCE_BUDGETS = {
  pageLoadMs: 5_000,
  apiResponseMs: 2_000,
  searchDebounceMs: 400,
} as const;

/** Prefix applied to every record the suite creates, so cleanup can find its own data. */
export const TEST_DATA_PREFIX = 'pwauto';
