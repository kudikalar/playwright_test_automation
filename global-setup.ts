/**
 * Global setup.
 *
 * Responsibilities are deliberately narrow (rule 25): validate the environment, make sure the
 * target is reachable, prepare the directories the run writes to, and create the authenticated
 * sessions the suite reuses. No business logic lives here.
 */

import {
  chromium,
  request,
  type Browser,
  type FullConfig,
  type FullProject,
} from '@playwright/test';

import { getEnvironment } from './config/environment.config';
import { frameworkConfig } from './config/framework.config';
import { API_ROUTES } from './src/constants/ApiConstants';
import { PATHS, REQUIRED_DIRECTORIES } from './src/constants/FrameworkConstants';
import { createStorageStates } from './src/fixtures/AuthenticationManager';
import type { UserRole } from './src/types/Environment';
import { ensureFrameworkDirectories, writeJsonFile } from './src/utils/FileUtils';
import { FrameworkError } from './src/utils/FrameworkError';
import { assertDatasetKeys } from './src/utils/JsonReader';
import { createLogger } from './src/utils/Logger';
import { resolve } from 'node:path';

const log = createLogger('global-setup');

/** Roles whose sessions the suite reuses. Adding a role here is all that a new persona needs. */
const ROLES_TO_AUTHENTICATE: readonly UserRole[] = ['ADMIN', 'MANAGER', 'EMPLOYEE'];

/**
 * The projects this run actually selected.
 *
 * Playwright hands global setup the whole configuration rather than the selection, so
 * `config.projects` still lists all nine projects during a `--project=api` run. The `--project`
 * flags are therefore read from the command line; no flag means every project runs.
 */
function selectedProjects(
  config: FullConfig,
  argv: readonly string[] = process.argv,
): FullProject[] {
  const requested = new Set<string>();
  const flag = '--project=';
  argv.forEach((argument, index) => {
    if (argument.startsWith(flag)) requested.add(argument.slice(flag.length).toLowerCase());
    else if (argument === '--project') requested.add((argv[index + 1] ?? '').toLowerCase());
  });
  if (requested.size === 0) return [...config.projects];
  const matched = config.projects.filter((project) => requested.has(project.name.toLowerCase()));
  /* Nothing matched (an unknown name): fall back to the declaration rather than assume less. */
  return matched.length > 0 ? matched : [...config.projects];
}

/** A project needs a browser unless it explicitly declares otherwise (default-safe). */
function requiresBrowser(project: FullProject): boolean {
  return project.metadata.requiresBrowser !== false;
}

/** Polls the health endpoint until the environment answers, or the budget expires. */
async function waitForEnvironment(
  baseUrl: string,
  healthPath: string | null | undefined,
  budgetMs = 60_000,
): Promise<void> {
  /*
   * A third-party target may expose no health endpoint at all. `healthPath: null` says so
   * explicitly, and the probe is skipped — better than failing every run against a site we do
   * not own, or silently pretending an unreachable target is up.
   */
  if (healthPath === null) {
    log.info('health probe skipped — this environment declares no health endpoint', { baseUrl });
    return;
  }
  /* Absolute URL: a leading-slash path against a baseURL would drop the API prefix. */
  const healthUrl = `${baseUrl}${healthPath ?? API_ROUTES.health}`;
  const context = await request.newContext();
  const deadline = Date.now() + budgetMs;
  let lastFailure = 'no attempt made';

  try {
    while (Date.now() < deadline) {
      try {
        const response = await context.get(healthUrl, { timeout: 5_000 });
        if (response.ok()) {
          log.info('environment is reachable', { healthUrl, status: response.status() });
          return;
        }
        lastFailure = `HTTP ${response.status()}`;
      } catch (error) {
        lastFailure = (error as Error).message;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  } finally {
    await context.dispose();
  }

  throw new FrameworkError('Target environment is not reachable', {
    operation: 'waitForEnvironment',
    target: baseUrl,
    expected: `HTTP 200 from ${baseUrl}${API_ROUTES.health}`,
    actual: lastFailure,
    hint: 'Check TEST_ENV, UI_BASE_URL/API_BASE_URL, VPN access, or whether the reference app is running.',
  });
}

/**
 * Launches the browser used to mint session state, translating Playwright's raw launch failure
 * into the framework's error shape so a fresh clone is told exactly what to run.
 */
async function launchSessionBrowser(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (error) {
    throw new FrameworkError(
      'Unable to launch a browser for session setup',
      {
        operation: 'launchSessionBrowser',
        target: 'chromium',
        expected: 'an installed Playwright browser binary',
        actual: (error as Error).message,
        hint: 'Run "npm run prepare:browsers" (or "npx playwright install chromium"). API-only runs (--project=api) do not need this.',
      },
      error,
    );
  }
}

async function globalSetup(config: FullConfig): Promise<void> {
  const startedAt = new Date();
  const environment = getEnvironment();
  const projects = selectedProjects(config);
  const projectNames = projects.map((project) => project.name);

  log.info('run starting', {
    environment: environment.name,
    displayName: environment.displayName,
    uiBaseUrl: environment.ui.baseUrl,
    apiBaseUrl: environment.api.baseUrl,
    workers: config.workers,
    projects: projectNames,
    ci: environment.isCi,
  });

  /* 1. directories the run writes into */
  ensureFrameworkDirectories(REQUIRED_DIRECTORIES);

  /* 2. fail fast on malformed or incomplete test data */
  assertDatasetKeys('login', ['validUsers', 'invalidScenarios', 'ui'], {
    environment: environment.name,
  });
  assertDatasetKeys('employees', ['templates', 'departments', 'validation'], {
    environment: environment.name,
  });
  assertDatasetKeys('api', ['endpoints', 'performance', 'negative'], {
    environment: environment.name,
  });
  if (environment.name === 'demoshop') {
    assertDatasetKeys('register', ['validUser', 'invalidScenarios', 'ui'], {
      environment: environment.name,
    });
  }

  /* 3. fail fast when credentials are missing, before a browser is launched */
  for (const role of ROLES_TO_AUTHENTICATE) {
    if (environment.roles[role]) environment.credentialsFor(role);
  }

  /* 4. the environment must actually be up */
  await waitForEnvironment(environment.api.baseUrl, environment.api.healthPath);

  /*
   * 5. authenticated sessions, created once and reused by the suite.
   * Projects opt out with `metadata.requiresBrowser: false` (the API suites). A run that
   * selects only those never launches — or needs — a browser binary.
   */
  const rolesToMint = ROLES_TO_AUTHENTICATE.filter((role) => environment.roles[role] !== undefined);
  if (rolesToMint.length === 0) {
    log.info('no roles configured for this environment — skipping session state creation', {
      environment: environment.name,
    });
  } else if (projects.some(requiresBrowser)) {
    const browser = await launchSessionBrowser();
    try {
      await createStorageStates(browser, rolesToMint);
    } finally {
      await browser.close();
    }
  } else {
    log.info('no browser-backed project selected — skipping session state creation', {
      projects: projectNames,
    });
  }

  /* 6. run metadata consumed by the Extent reporter */
  writeJsonFile(resolve(PATHS.reports, 'run-context.json'), {
    runId: frameworkConfig.runId,
    startedAt: startedAt.toISOString(),
    environment: {
      name: environment.name,
      displayName: environment.displayName,
      uiBaseUrl: environment.ui.baseUrl,
      apiBaseUrl: environment.api.baseUrl,
    },
    execution: {
      ci: environment.isCi,
      workers: config.workers,
      retries: frameworkConfig.retries,
      headless: frameworkConfig.headless,
      projects: projectNames,
    },
    node: process.version,
  });

  log.info('global setup complete');
}

export default globalSetup;
