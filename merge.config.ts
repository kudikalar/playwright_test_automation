/**
 * Reporter set for `playwright merge-reports`: CI shards write blob reports, and one job merges
 * them into a single HTML / JUnit / Extent report — which is also the one place integrations
 * (Jira, Zephyr, Slack, Email) publish, so a 10-shard nightly sends ONE Slack message, not ten.
 *
 *   npx playwright merge-reports --config merge.config.ts ./all-blob-reports
 */
import { defineConfig } from '@playwright/test';

import { PATHS } from './src/constants/FrameworkConstants';

export default defineConfig({
  testDir: './tests',
  reporter: [
    ['list'],
    ['html', { outputFolder: PATHS.playwrightReport, open: 'never' }],
    ['junit', { outputFile: `${PATHS.junitReport}/results.xml` }],
    ['json', { outputFile: `${PATHS.jsonReport}/results.json` }],
    ['./src/reporting/ExtentReporter.ts'],
  ],
});
