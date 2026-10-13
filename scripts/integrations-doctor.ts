#!/usr/bin/env -S npx tsx
/**
 * Integration doctor — proves every configured connection works BEFORE a suite depends on it.
 *
 *   npm run integrations:doctor                 # read-only checks (no writes anywhere)
 *   npm run integrations:doctor -- --send-test  # also posts a test Slack message and test email
 *
 * Read-only by default: Jira `/myself` + a project search, Zephyr status list, Sauce job list,
 * SMTP login. Exit code 1 when an enabled integration fails its check, so CI can gate on it.
 */

import 'dotenv/config';

import { EmailNotifier } from '../src/integrations/email/EmailNotifier';
import { JiraClient } from '../src/integrations/jira/JiraClient';
import {
  readSauceCredentials,
  resolveSauceRegion,
  sauceApiBaseUrl,
  sauceBasicAuthHeader,
} from '../src/integrations/sauce/SauceConfig';
import { SlackNotifier } from '../src/integrations/slack/SlackNotifier';
import { ZephyrClient, ZEPHYR_DEFAULT_BASE_URL } from '../src/integrations/zephyr/ZephyrClient';
import type { ExtentReportModel } from '../src/reporting/ExtentTypes';

type Verdict = 'ok' | 'fail' | 'off';
interface Check {
  readonly name: string;
  readonly verdict: Verdict;
  readonly detail: string;
}

const sendTest = process.argv.includes('--send-test');
const env = process.env;
const v = (name: string): string => (env[name] ?? '').trim();
const on = (name: string): boolean => ['1', 'true', 'yes', 'on'].includes(v(name).toLowerCase());
const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const TIMEOUT = 15_000;

async function checkJira(): Promise<Check> {
  const name = 'Jira';
  const missing = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY'].filter(
    (k) => v(k) === '',
  );
  if (!on('JIRA_ENABLED') || missing.length > 0) {
    return {
      name,
      verdict: 'off',
      detail: missing.length > 0 ? `missing ${missing.join(', ')}` : 'JIRA_ENABLED is not true',
    };
  }
  const client = new JiraClient({
    baseUrl: v('JIRA_BASE_URL'),
    email: v('JIRA_EMAIL'),
    apiToken: v('JIRA_API_TOKEN'),
    ...(v('JIRA_CLOUD_ID') === '' ? {} : { cloudId: v('JIRA_CLOUD_ID') }),
    timeoutMs: TIMEOUT,
  });
  try {
    const me = await client.verifyCredentials();
    const project = v('JIRA_PROJECT_KEY').toUpperCase();
    const search = await client.searchIssues(
      `project = "${project}" ORDER BY created DESC`,
      ['summary'],
      1,
    );
    const open = await client.searchIssues(
      `project = "${project}" AND labels = "pw-auto" AND statusCategory != Done`,
      ['summary'],
      100,
    );
    return {
      name,
      verdict: 'ok',
      detail:
        `authenticated as ${me.displayName}; project ${project} readable` +
        `${search.issues.length === 0 ? ' (no issues visible — check browse permission)' : ''}; ` +
        `${open.issues.length}${open.hasMore ? '+' : ''} open auto-filed bug(s); ` +
        `bug filing ${on('JIRA_CREATE_ISSUE_ON_FAILURE') ? `ON (${v('JIRA_BUG_MODE') || 'per-test'})` : 'off'}`,
    };
  } catch (error) {
    return { name, verdict: 'fail', detail: msg(error) };
  }
}

async function checkZephyr(): Promise<Check> {
  const name = 'Zephyr Scale';
  if (!on('ZEPHYR_ENABLED') || v('ZEPHYR_API_TOKEN') === '' || v('ZEPHYR_PROJECT_KEY') === '') {
    return {
      name,
      verdict: 'off',
      detail: 'needs ZEPHYR_ENABLED=true, ZEPHYR_API_TOKEN, ZEPHYR_PROJECT_KEY',
    };
  }
  try {
    const client = new ZephyrClient({
      token: v('ZEPHYR_API_TOKEN'),
      baseUrl: v('ZEPHYR_BASE_URL') || ZEPHYR_DEFAULT_BASE_URL,
      timeoutMs: TIMEOUT,
    });
    const page = await client.listExecutionStatuses(v('ZEPHYR_PROJECT_KEY').toUpperCase());
    const names = [...page.names];
    const wanted = [
      v('ZEPHYR_STATUS_PASS') || 'Pass',
      v('ZEPHYR_STATUS_FAIL') || 'Fail',
      v('ZEPHYR_STATUS_BLOCKED') || 'Blocked',
      v('ZEPHYR_STATUS_NOT_EXECUTED') || 'Not Executed',
    ];
    const unmapped = wanted.filter(
      (status) => !names.some((n: string) => n.toLowerCase() === status.toLowerCase()),
    );
    return {
      name,
      verdict: unmapped.length === 0 ? 'ok' : 'fail',
      detail:
        unmapped.length === 0
          ? `token valid; project ${v('ZEPHYR_PROJECT_KEY').toUpperCase()} statuses: ${names.join(', ')}`
          : `statuses ${unmapped.join(', ')} do not exist in the project (have: ${names.join(', ')}) — set ZEPHYR_STATUS_*`,
    };
  } catch (error) {
    return { name, verdict: 'fail', detail: msg(error) };
  }
}

async function checkSauce(): Promise<Check> {
  const name = 'Sauce Labs';
  const credentials = readSauceCredentials(env);
  if (credentials === undefined)
    return { name, verdict: 'off', detail: 'needs SAUCE_USERNAME and SAUCE_ACCESS_KEY' };
  const region = resolveSauceRegion(env.SAUCE_REGION);
  if (region === undefined)
    return { name, verdict: 'fail', detail: `unknown SAUCE_REGION "${v('SAUCE_REGION')}"` };
  try {
    const response = await fetch(
      `${sauceApiBaseUrl(region)}/rest/v1/${encodeURIComponent(credentials.username)}/jobs?limit=1`,
      {
        headers: { Authorization: sauceBasicAuthHeader(credentials), Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT),
      },
    );
    if (response.status === 401)
      return {
        name,
        verdict: 'fail',
        detail: `credentials rejected in ${region} (wrong key, or account lives in another region)`,
      };
    if (!response.ok)
      return {
        name,
        verdict: 'fail',
        detail: `HTTP ${response.status} from the ${region} jobs API`,
      };
    return {
      name,
      verdict: 'ok',
      detail: `authenticated in ${region}; run cloud suites with npm run test:sauce`,
    };
  } catch (error) {
    return { name, verdict: 'fail', detail: msg(error) };
  }
}

function sampleModel(): ExtentReportModel {
  const now = new Date().toISOString();
  return {
    runId: `doctor-${Date.now()}`,
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      flaky: 0,
      passRate: 100,
      startedAt: now,
      finishedAt: now,
      durationMs: 1000,
    },
    environment: {
      name: env.TEST_ENV ?? 'dev',
      displayName: `Integration doctor (${env.TEST_ENV ?? 'dev'})`,
      uiBaseUrl: env.BASE_URL ?? 'https://example.com',
      apiBaseUrl: env.API_BASE_URL ?? 'https://example.com/api',
      ci: env.CI === 'true',
      workers: 1,
      retries: 0,
      headless: true,
      projects: ['doctor'],
      node: process.version,
      framework: 'Playwright Enterprise Framework',
      playwright: 'n/a',
    },
    tests: [],
  };
}

async function checkSlack(): Promise<Check> {
  const name = 'Slack';
  const url = v('SLACK_WEBHOOK_URL');
  if (url === '') return { name, verdict: 'off', detail: 'needs SLACK_WEBHOOK_URL' };
  if (!/^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\//.test(url)) {
    return {
      name,
      verdict: 'fail',
      detail: 'SLACK_WEBHOOK_URL is not a hooks.slack.com webhook URL',
    };
  }
  if (!sendTest)
    return {
      name,
      verdict: 'ok',
      detail: 'webhook URL well-formed (use --send-test to post a test message)',
    };
  const result = await new SlackNotifier({ notifyOn: 'always' }).publish({
    model: sampleModel(),
    reportDir: process.cwd(),
  });
  return { name, verdict: result.status === 'published' ? 'ok' : 'fail', detail: result.detail };
}

async function checkEmail(): Promise<Check> {
  const name = 'Email';
  const notifier = new EmailNotifier();
  if (!notifier.isEnabled())
    return {
      name,
      verdict: 'off',
      detail: notifier.disabledReason().replace(/^Email reporting is off: /, ''),
    };
  const verified = await notifier.verify();
  if (!verified.ok || !sendTest) {
    return {
      name,
      verdict: verified.ok ? 'ok' : 'fail',
      detail: verified.ok ? `${verified.detail} (use --send-test to send one)` : verified.detail,
    };
  }
  const result = await new EmailNotifier({
    env: { ...env, EMAIL_NOTIFY_ON: 'always', EMAIL_ATTACH_REPORT: 'false' },
  }).publish({
    model: sampleModel(),
    reportDir: process.cwd(),
  });
  return { name, verdict: result.status === 'published' ? 'ok' : 'fail', detail: result.detail };
}

const ICON: Record<Verdict, string> = {
  ok: '\u001b[32m✔\u001b[0m',
  fail: '\u001b[31m✖\u001b[0m',
  off: '\u001b[90m–\u001b[0m',
};

const checks = await Promise.all([
  checkJira(),
  checkZephyr(),
  checkSauce(),
  checkSlack(),
  checkEmail(),
]);
console.log(`\nIntegration doctor${sendTest ? ' (with test sends)' : ' (read-only)'}\n`);
for (const check of checks) {
  console.log(`  ${ICON[check.verdict]} ${check.name.padEnd(13)} ${check.detail}`);
}
if (on('INTEGRATIONS_DISABLED'))
  console.log('\n  note: INTEGRATIONS_DISABLED=true — nothing will publish during test runs.');
const failed = checks.filter((check) => check.verdict === 'fail').length;
const ok = checks.filter((check) => check.verdict === 'ok').length;
console.log(
  `\n  ${ok} connected, ${failed} failing, ${checks.length - ok - failed} not configured\n`,
);
process.exit(failed > 0 ? 1 : 0);
