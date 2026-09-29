
import { defineConfig, devices } from '@playwright/test';

import { getEnvironment } from './config/environment.config';
import { frameworkConfig } from './config/framework.config';

import {
  PATHS,
  VIEWPORTS,
} from './src/constants/FrameworkConstants';

const environment = getEnvironment();

/**
 * Detect Sauce Labs execution.
 *
 * Sauce config sets:
 *   SAUCE=true
 *
 * This allows the same Playwright configuration to work
 * locally and in Sauce Labs without overriding Sauce's browser.
 */
const isSauce = process.env.SAUCE === 'true';

/**
 * UI projects run everything except:
 * - API
 * - Visual
 * - DemoShop
 */
const UI_TEST_IGNORE = [
  '**/tests/api/**',
  '**/tests/visual/**',
  '**/tests/demoshop/**',
];

/**
 * Shared Playwright configuration.
 *
 * IMPORTANT:
 * Do not pass launchOptions to Sauce Labs.
 * Sauce controls the browser executable/runtime.
 */
const sharedUse = {
  baseURL: environment.ui.baseUrl,

  actionTimeout: environment.timeouts.action,

  navigationTimeout: environment.timeouts.navigation,

  /**
   * Sauce execution should always be headless.
   * Local execution follows the framework setting.
   */
  headless: isSauce ? true : frameworkConfig.headless,

  ignoreHTTPSErrors: false,

  testIdAttribute: 'data-testid',

  /**
   * Diagnostics are captured only when required.
   */
  screenshot: 'only-on-failure' as const,

  video: 'retain-on-failure' as const,

  trace: 'retain-on-failure' as const,

  /**
   * IMPORTANT:
   * slowMo is useful locally but should NOT be passed to Sauce.
   *
   * Sauce must control browser launch options.
   */
  ...(isSauce
    ? {}
    : {
        launchOptions: {
          slowMo: frameworkConfig.slowMoMs,
        },
      }),
};

export default defineConfig({
  testDir: './tests',

  outputDir: PATHS.testResults,

  /**
   * Visual baselines are stored beside their specs.
   */
  snapshotPathTemplate:
    '{testDir}/__screenshots__/{projectName}/{testFileName}/{arg}{ext}',

  /**
   * Global lifecycle.
   */
  globalSetup: './global-setup.ts',

  globalTeardown: './global-teardown.ts',

  /**
   * Test execution limits.
   */
  timeout: environment.timeouts.test,

  expect: {
    timeout: environment.timeouts.expect,
  },

  fullyParallel: true,

  forbidOnly: frameworkConfig.isCi,

  retries: frameworkConfig.retries,

  workers: frameworkConfig.workers,

  maxFailures: frameworkConfig.isCi ? 25 : 0,

  reportSlowTests: {
    max: 5,
    threshold: 60_000,
  },

  /**
   * ---------------------------------------------------------------------------
   * REPORTING
   * ---------------------------------------------------------------------------
   *
   * 1. List   -> Console
   * 2. HTML   -> Playwright interactive report
   * 3. JSON   -> Machine-readable result
   * 4. JUnit  -> CI/CD integration
   * 5. Extent -> Enterprise custom dashboard
   */
  reporter: [
    [
      'list',
      {
        printSteps: false,
      },
    ],

    [
      'html',
      {
        outputFolder: PATHS.playwrightReport,
        open: 'never',
      },
    ],

    [
      'json',
      {
        outputFile: `${PATHS.jsonReport}/results.json`,
      },
    ],

    [
      'junit',
      {
        outputFile: `${PATHS.junitReport}/results.xml`,
      },
    ],

    ...(frameworkConfig.extentEnabled
      ? [
          [
            './src/reporting/ExtentReporter.ts',
          ] as [string],
        ]
      : []),
  ],

  /**
   * Shared Playwright settings.
   */
  use: sharedUse,

  /**
   * ===========================================================================
   * PROJECTS
   * ===========================================================================
   */
  projects: [
    /**
     * -------------------------------------------------------------------------
     * API
     * -------------------------------------------------------------------------
     */
    {
      name: 'api',

      testDir: './tests/api',

      metadata: {
        requiresBrowser: false,
      },

      use: {
        baseURL: environment.api.baseUrl,
      },
    },

    /**
     * -------------------------------------------------------------------------
     * CHROMIUM
     * -------------------------------------------------------------------------
     */
    {
      name: 'chromium',

      testIgnore: UI_TEST_IGNORE,

      use: {
        ...devices['Desktop Chrome'],

        ...sharedUse,

        viewport: VIEWPORTS.laptop,
      },
    },

    /**
     * -------------------------------------------------------------------------
     * FIREFOX
     * -------------------------------------------------------------------------
     */
    {
      name: 'firefox',

      testIgnore: UI_TEST_IGNORE,

      use: {
        ...devices['Desktop Firefox'],

        ...sharedUse,

        viewport: VIEWPORTS.laptop,
      },
    },

    /**
     * -------------------------------------------------------------------------
     * WEBKIT
     * -------------------------------------------------------------------------
     */
    {
      name: 'webkit',

      testIgnore: UI_TEST_IGNORE,

      use: {
        ...devices['Desktop Safari'],

        ...sharedUse,

        viewport: VIEWPORTS.laptop,
      },
    },

    /**
     * -------------------------------------------------------------------------
     * MICROSOFT EDGE
     * -------------------------------------------------------------------------
     */
    {
      name: 'edge',

      testIgnore: UI_TEST_IGNORE,

      use: {
        ...devices['Desktop Edge'],

        ...sharedUse,

        channel: 'msedge',
      },
    },

    /**
     * -------------------------------------------------------------------------
     * IPAD
     * -------------------------------------------------------------------------
     */
    {
      name: 'tablet-ipad',

      testIgnore: UI_TEST_IGNORE,

      use: {
        ...devices['iPad (gen 7)'],

        ...sharedUse,

        viewport: VIEWPORTS.tablet,

        isMobile: false,
      },
    },

    /**
     * -------------------------------------------------------------------------
     * MOBILE CHROME
     * -------------------------------------------------------------------------
     */
    {
      name: 'mobile-chrome',

      testIgnore: UI_TEST_IGNORE,

      use: {
        ...devices['Pixel 7'],

        ...sharedUse,
      },
    },

    /**
     * -------------------------------------------------------------------------
     * MOBILE SAFARI
     * -------------------------------------------------------------------------
     */
    {
      name: 'mobile-safari',

      testIgnore: UI_TEST_IGNORE,

      use: {
        ...devices['iPhone 14'],

        ...sharedUse,
      },
    },

    /**
     * -------------------------------------------------------------------------
     * TRICENTIS DEMO WEB SHOP
     * -------------------------------------------------------------------------
     *
     * Sauce:
     *   browserName: chrome
     *
     * Local:
     *   Desktop Chrome device
     */
    {
      name: 'demoshop',

      testDir: './tests/demoshop',

      use: {
        ...devices['Desktop Chrome'],

        ...sharedUse,

        viewport: VIEWPORTS.laptop,

        /**
         * DemoShop captures screenshots for every test.
         */
        screenshot: 'on' as const,
      },
    },

    /**
     * -------------------------------------------------------------------------
     * VISUAL REGRESSION
     * -------------------------------------------------------------------------
     *
     * Force device scale factor only locally.
     *
     * Sauce must not receive custom launchOptions.
     */
    {
      name: 'visual',

      testDir: './tests/visual',

      use: {
        ...devices['Desktop Chrome'],

        ...sharedUse,

        viewport: VIEWPORTS.laptop,

        ...(isSauce
          ? {}
          : {
              launchOptions: {
                slowMo: frameworkConfig.slowMoMs,

                args: [
                  '--force-device-scale-factor=1',
                ],
              },
            }),
      },
    },
  ],

  /**
   * ===========================================================================
   * REFERENCE APPLICATION
   * ===========================================================================
   */
  ...(frameworkConfig.startReferenceApp
    ? {
        webServer: {
          command: 'node demo-app/server.mjs',

          url: `${environment.api.baseUrl}/health`,

          reuseExistingServer: !frameworkConfig.isCi,

          timeout: 30_000,

          stdout: 'ignore' as const,

          stderr: 'pipe' as const,

          env: {
            DEMO_APP_PORT: String(
              frameworkConfig.referenceAppPort,
            ),
          },
        },
      }
    : {}),
});

