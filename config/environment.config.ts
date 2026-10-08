/**
 * Environment resolution.
 *
 * Reads `config/environments/<TEST_ENV>.json`, applies environment-variable overrides and
 * resolves secrets lazily. This is the only place that knows how an environment is assembled;
 * everything else consumes the `ResolvedEnvironment` returned by {@link getEnvironment}.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

import { PATHS } from '../src/constants/FrameworkConstants';
import type {
  Credentials,
  EnvironmentDefinition,
  EnvironmentName,
  FeatureFlags,
  ResolvedEnvironment,
  UserRole,
} from '../src/types/Environment';

const VALID_ENVIRONMENTS: readonly EnvironmentName[] = ['dev', 'qa', 'uat', 'prod', 'demoshop'];

let dotenvLoaded = false;

/** Loads `.env` once, if present. Values already in `process.env` (CI secrets) always win. */
function loadDotEnvOnce(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const envFile = resolve(PATHS.root, '.env');
  if (existsSync(envFile)) {
    dotenv.config({ path: envFile, override: false, quiet: true });
  }
}

export class EnvironmentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentConfigurationError';
  }
}

/** Reads `TEST_ENV`, defaulting to `dev`, and rejects anything unrecognised. */
export function resolveEnvironmentName(raw?: string): EnvironmentName {
  /* `.env` must be loaded before TEST_ENV is read, or a TEST_ENV set only there is ignored. */
  loadDotEnvOnce();
  raw ??= process.env.TEST_ENV;
  const candidate = (raw ?? 'dev').trim().toLowerCase();
  if (!VALID_ENVIRONMENTS.includes(candidate as EnvironmentName)) {
    throw new EnvironmentConfigurationError(
      `Unknown TEST_ENV "${raw ?? ''}". Expected one of: ${VALID_ENVIRONMENTS.join(', ')}.`,
    );
  }
  return candidate as EnvironmentName;
}

function readDefinition(name: EnvironmentName): EnvironmentDefinition {
  const file = resolve(PATHS.environments, `${name}.json`);
  if (!existsSync(file)) {
    throw new EnvironmentConfigurationError(`Environment file not found: ${file}`);
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as EnvironmentDefinition;
    assertDefinitionShape(parsed, file);
    return parsed;
  } catch (error) {
    if (error instanceof EnvironmentConfigurationError) throw error;
    throw new EnvironmentConfigurationError(
      `Environment file ${file} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

function assertDefinitionShape(definition: EnvironmentDefinition, file: string): void {
  const missing: string[] = [];
  if (!definition.name) missing.push('name');
  if (!definition.ui?.baseUrl) missing.push('ui.baseUrl');
  if (!definition.api?.baseUrl) missing.push('api.baseUrl');
  if (!definition.timeouts) missing.push('timeouts');
  if (!definition.retries) missing.push('retries');
  if (missing.length > 0) {
    throw new EnvironmentConfigurationError(
      `Environment file ${file} is missing required keys: ${missing.join(', ')}`,
    );
  }
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

function buildEnvironment(name: EnvironmentName): ResolvedEnvironment {
  loadDotEnvOnce();
  const definition = readDefinition(name);

  /* `BASE_URL` is the short form most teams set in `.env`; `UI_BASE_URL` still wins when both exist. */
  const uiBaseUrl = stripTrailingSlash(
    process.env.UI_BASE_URL || process.env.BASE_URL || definition.ui.baseUrl,
  );
  const apiBaseUrl = stripTrailingSlash(process.env.API_BASE_URL ?? definition.api.baseUrl);
  const isCi = process.env.CI === 'true' || process.env.CI === '1';

  return {
    ...definition,
    ui: { ...definition.ui, baseUrl: uiBaseUrl },
    api: { ...definition.api, baseUrl: apiBaseUrl },
    isCi,

    credentialsFor(role: UserRole): Credentials {
      const source = definition.roles[role];
      if (!source) {
        throw new EnvironmentConfigurationError(
          `Role "${role}" is not configured for environment "${definition.name}". ` +
            `Add it to config/environments/${definition.name}.json.`,
        );
      }
      const username = process.env[source.usernameEnv] ?? '';
      const password = process.env[source.passwordEnv] ?? '';
      if (username && password) return { username, password };

      if (definition.allowInsecureDefaults && source.sandboxUsername && source.sandboxPassword) {
        return { username: source.sandboxUsername, password: source.sandboxPassword };
      }
      throw new EnvironmentConfigurationError(
        `Credentials for role "${role}" are unavailable in environment "${definition.name}". ` +
          `Set ${source.usernameEnv} and ${source.passwordEnv} in your .env file or CI secrets. ` +
          `See .env.example.`,
      );
    },

    apiKey(): string | undefined {
      const keyEnv = definition.api.apiKeyEnv;
      if (!keyEnv) return undefined;
      const fromEnv = process.env[keyEnv];
      if (fromEnv) return fromEnv;
      if (definition.allowInsecureDefaults && definition.api.sandboxApiKey) {
        return definition.api.sandboxApiKey;
      }
      return undefined;
    },

    isEnabled(feature: keyof FeatureFlags | string): boolean {
      return definition.features[feature as string] === true;
    },
  };
}

const cache = new Map<EnvironmentName, ResolvedEnvironment>();

/** Returns the resolved environment, cached per process. */
export function getEnvironment(
  name: EnvironmentName = resolveEnvironmentName(),
): ResolvedEnvironment {
  const cached = cache.get(name);
  if (cached) return cached;
  const built = buildEnvironment(name);
  cache.set(name, built);
  return built;
}

/** Absolute UI URL for an application path. */
export function uiUrl(path: string, environment: ResolvedEnvironment = getEnvironment()): string {
  return `${environment.ui.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Absolute API URL for an endpoint path. */
export function apiUrl(path: string, environment: ResolvedEnvironment = getEnvironment()): string {
  return `${environment.api.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
