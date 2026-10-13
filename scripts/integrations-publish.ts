#!/usr/bin/env -S npx tsx
/**
 * Re-publishes a finished run to the integrations without re-running a single test.
 *
 *   npm run integrations:publish                              # latest run, every enabled target
 *   npm run integrations:publish -- --only slack,email        # just the notifiers
 *   npm run integrations:publish -- --report reports/extent/run-2026-10-13T06-01-21-187Z
 *   npm run integrations:publish -- --report-url https://ci.example.com/artifacts/report
 *   npm run integrations:publish -- --report reports/sauce   # newest report.json found beneath
 *
 * Typical uses: a webhook was down during the run; the suite ran with INTEGRATIONS_DISABLED and a
 * human decided afterwards to publish; or a CI job publishes once after all shards finish.
 * Reads `report.json` from the run folder — the exact model the reporter would have published.
 */

import 'dotenv/config';

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { publishIntegrations } from '../src/integrations/index';
import type { ExtentReportModel } from '../src/reporting/ExtentTypes';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

const extentRoot = resolve(process.cwd(), 'reports/extent');

/** Newest folder under `root` that holds a report.json — e.g. inside downloaded Sauce artifacts. */
function newestReportDir(root: string): string | undefined {
  let best: { dir: string; mtime: number } | undefined;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'report.json') {
        const mtime = statSync(full).mtimeMs;
        if (best === undefined || mtime > best.mtime) best = { dir, mtime };
      }
    }
  };
  walk(root, 0);
  return best?.dir;
}

function resolveReportDir(): string {
  const explicit = arg('report');
  if (explicit !== undefined) {
    const dir = resolve(process.cwd(), explicit);
    if (existsSync(resolve(dir, 'report.json')) || !existsSync(dir)) return dir;
    return newestReportDir(dir) ?? dir;
  }
  const latest = resolve(extentRoot, 'latest.json');
  if (!existsSync(latest)) {
    throw new Error(
      'No reports/extent/latest.json — run a suite first or pass --report <run folder>.',
    );
  }
  const { reportDir } = JSON.parse(readFileSync(latest, 'utf8')) as { reportDir: string };
  /* latest.json stores an absolute path; after a CI artifact download it lives somewhere else. */
  return existsSync(reportDir) ? reportDir : resolve(extentRoot, basename(reportDir));
}

const only = arg('only');
if (only !== undefined) process.env.INTEGRATIONS_ONLY = only;
const reportUrl = arg('report-url') ?? process.env.REPORT_URL;

const reportDir = resolveReportDir();
const modelFile = resolve(reportDir, 'report.json');
if (!existsSync(modelFile)) {
  console.error(`No report.json in ${reportDir}.`);
  process.exit(2);
}
const model = JSON.parse(readFileSync(modelFile, 'utf8')) as ExtentReportModel;

console.log(
  `\nPublishing run ${model.runId} (${model.environment.displayName}: ${model.summary.passed}/${model.summary.total} passed, ${model.summary.failed} failed)` +
    `${only ? ` to ${only}` : ''}…\n`,
);

const results = await publishIntegrations({
  model,
  reportDir,
  ...(reportUrl ? { reportUrl } : {}),
});

if (results.length === 0) {
  console.log('  Nothing is configured to publish to. Run `npm run integrations:doctor`.\n');
  process.exit(0);
}
const ICON = {
  published: '\u001b[32m✔\u001b[0m',
  failed: '\u001b[31m✖\u001b[0m',
  skipped: '\u001b[90m–\u001b[0m',
} as const;
for (const result of results) {
  console.log(
    `  ${ICON[result.status]} ${result.name.padEnd(13)} ${result.detail}${result.url ? `\n${' '.repeat(18)}${result.url}` : ''}`,
  );
}
console.log('');
process.exit(results.some((result) => result.status === 'failed') ? 1 : 0);
