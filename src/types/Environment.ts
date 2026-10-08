/**
 * Environment contracts.
 *
 * `EnvironmentDefinition` mirrors the shape of `config/environments/<env>.json`.
 * `ResolvedEnvironment` is what the rest of the framework consumes after
 * environment-variable overrides and secret resolution have been applied.
 */

export type EnvironmentName = 'dev' | 'qa' | 'uat' | 'prod' | 'demoshop';

export type UserRole = 'ADMIN' | 'MANAGER' | 'EMPLOYEE' | 'STUDENT' | 'MENTOR';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** Non-secret timing budget for the environment, in milliseconds. */
export interface TimeoutConfig {
  /** Per-test budget. */
  readonly test: number;
  /** Single action (click, fill, …). */
  readonly action: number;
  /** Page navigation. */
  readonly navigation: number;
  /** Web-first assertion polling budget. */
  readonly expect: number;
  /** API request budget. */
  readonly api: number;
}

export interface RetryConfig {
  /** Retries when running on an engineer's machine. */
  readonly local: number;
  /** Retries when running in CI. */
  readonly ci: number;
  /** Attempts for idempotent API calls inside the API client. */
  readonly apiMaxAttempts: number;
  /** Base backoff between API attempts, in milliseconds. */
  readonly apiBackoffMs: number;
}

/**
 * Feature switches let one suite serve environments at different release stages.
 * Unknown keys are allowed so teams can add switches without touching the core.
 */
export interface FeatureFlags {
  readonly employeeManagement?: boolean;
  readonly employeeDeletion?: boolean;
  readonly csvExport?: boolean;
  readonly visualRegression?: boolean;
  readonly [feature: string]: boolean | undefined;
}

/**
 * Where a role's credentials come from. Values themselves are never stored in JSON —
 * only the names of the environment variables that carry them.
 */
export interface RoleCredentialSource {
  readonly usernameEnv: string;
  readonly passwordEnv: string;
  /**
   * Local sandbox only. When the environment sets `allowInsecureDefaults`, these
   * published, non-secret sandbox credentials are used if the env vars are absent.
   */
  readonly sandboxUsername?: string;
  readonly sandboxPassword?: string;
}

export interface UiEnvironmentConfig {
  readonly baseUrl: string;
  readonly loginPath: string;
  readonly dashboardPath: string;
  /** Only set where the target has a password-reset screen. */
  readonly forgotPasswordPath?: string;
}

export interface ApiEnvironmentConfig {
  readonly baseUrl: string;
  /** Name of the env var carrying the API key, if the environment uses one. */
  readonly apiKeyEnv?: string;
  readonly sandboxApiKey?: string;
  /**
   * Path global setup probes to prove the target is up, relative to {@link baseUrl}.
   * Defaults to the framework's `/health` route. Set to `null` for a third-party target that
   * exposes no health endpoint — the probe is then skipped rather than failing every run.
   */
  readonly healthPath?: string | null;
}

export interface EnvironmentDefinition {
  readonly name: EnvironmentName;
  readonly displayName: string;
  /** Guard rail: destructive suites refuse to run where this is false. */
  readonly allowDestructiveTests: boolean;
  /** Local sandbox escape hatch for published, non-secret credentials. */
  readonly allowInsecureDefaults: boolean;
  readonly ui: UiEnvironmentConfig;
  readonly api: ApiEnvironmentConfig;
  readonly timeouts: TimeoutConfig;
  readonly retries: RetryConfig;
  readonly features: FeatureFlags;
  readonly roles: Readonly<Partial<Record<UserRole, RoleCredentialSource>>>;
}

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

/** The environment as consumed by fixtures, pages and services. */
export interface ResolvedEnvironment extends EnvironmentDefinition {
  /** True when executing on CI (`process.env.CI`). */
  readonly isCi: boolean;
  /** Resolves a role's credentials from the environment, throwing when unavailable. */
  credentialsFor(role: UserRole): Credentials;
  /** Resolves the API key when the environment declares one. */
  apiKey(): string | undefined;
  /** Reads a feature switch with a safe default of `false`. */
  isEnabled(feature: keyof FeatureFlags | string): boolean;
}
