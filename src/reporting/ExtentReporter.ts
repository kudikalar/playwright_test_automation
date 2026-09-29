/**
 * Extent reporting adapter for Playwright.
 *
 * Playwright's reporter API is the integration point (rule 17): tests contain no reporting code.
 * Each result is normalised into {@link ExtentReportModel} — suite, module, tags, environment,
 * project, timings, status including retries, steps, error and artifacts — then rendered to a
 * timestamped folder under `reports/extent/`.
 *
 * Every string that reaches the report passes through the masker first, so no password, token,
 * cookie or Authorization header can be published in an artifact.
 */

import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';

import { getEnvironment } from '../../config/environment.config';
import { frameworkConfig } from '../../config/framework.config';
import { FRAMEWORK_NAME, FRAMEWORK_VERSION, PATHS } from '../constants/FrameworkConstants';
import { MODULES, SUITES } from '../constants/TestConstants';
import { humanDuration, toFileStamp } from '../utils/DateUtils';
import { maskString } from '../utils/DataMasker';
import { ensureDirectory, writeJsonFile, writeTextFile } from '../utils/FileUtils';
import { publishIntegrations } from '../integrations';
import { renderExtentHtml } from './ExtentHtml';
import type {
  ExtentAttachment,
  ExtentAttempt,
  ExtentEnvironment,
  ExtentHistoryEntry,
  ExtentReportModel,
  ExtentStatus,
  ExtentStep,
  ExtentStepKind,
  ExtentTest,
} from './ExtentTypes';

const TAG_PATTERN = /@[\w-]+/g;

/** How many runs the trend keeps. Fifty is a few weeks of nightlies and a few kilobytes. */
const HISTORY_LIMIT = 50;

/** The statuses that count as a failure everywhere in this file. */
const FAILED_STATUSES: readonly ExtentStatus[] = ['FAIL', 'TIMEOUT', 'INTERRUPTED'];

/** Maps a spec path to the business module shown in the report. */
function moduleFor(test: TestCase): string {
  const annotated = test.annotations.find((annotation) => annotation.type === 'module');
  if (annotated?.description) return annotated.description;

  const file = test.location.file.toLowerCase();
  if (file.includes('login') || file.includes('auth')) return MODULES.authentication;
  if (file.includes('dashboard')) return MODULES.dashboard;
  if (file.includes('employee')) return MODULES.employeeManagement;
  if (file.includes('user')) return MODULES.userManagement;
  return MODULES.platform;
}

/** Maps a spec path/tags to the suite shown in the report. */
function suiteFor(test: TestCase, tags: readonly string[]): string {
  const file = test.location.file.replace(/\\/g, '/');
  if (file.includes('/tests/api/contract/')) return SUITES.contract;
  if (file.includes('/tests/api/')) return SUITES.api;
  if (file.includes('/tests/hybrid/')) return SUITES.hybrid;
  if (file.includes('/tests/visual/')) return SUITES.visual;
  if (file.includes('/smoke/') || tags.includes('@smoke')) return SUITES.smoke;
  if (file.includes('/sanity/') || tags.includes('@sanity')) return SUITES.sanity;
  if (file.includes('/e2e/') || tags.includes('@e2e')) return SUITES.e2e;
  return SUITES.regression;
}

function statusFor(test: TestCase, result: TestResult): ExtentStatus {
  if (result.status === 'skipped') return 'SKIP';
  if (result.status === 'timedOut') return 'TIMEOUT';
  if (result.status === 'interrupted') return 'INTERRUPTED';
  if (result.status === 'passed') return result.retry > 0 ? 'FLAKY' : 'PASS';
  return test.outcome() === 'flaky' ? 'FLAKY' : 'FAIL';
}

/**
 * Step categories worth a row. `test.step` covers both the spec's business steps and every
 * page-object action (BasePage opens one per click/fill/check); `expect` is each assertion; raw
 * `pw:api` calls are left out because the page-object step above them already names the action.
 */
const STEP_KINDS: Readonly<Record<string, ExtentStepKind>> = {
  'test.step': 'step',
  expect: 'assertion',
  hook: 'hook',
};

/**
 * The head of a step's error: the headline plus the Locator / Expected / Received lines that
 * follow it, which is what a reader needs beside the step. The full stack stays on the test.
 */
function stepErrorSummary(message: string): string {
  return maskString(stripAnsi(message))
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !line.includes('Call log:'))
    .slice(0, 8)
    .join('\n');
}

function flattenSteps(steps: readonly TestStep[], depth = 0): ExtentStep[] {
  const flattened: ExtentStep[] = [];
  for (const step of steps) {
    const kind = STEP_KINDS[step.category];
    if (kind === undefined) continue;
    /* A parent step inherits its child's error; only the innermost failing step carries it. */
    const ownError =
      step.error?.message !== undefined && !step.steps.some((child) => child.error !== undefined)
        ? stepErrorSummary(step.error.message)
        : undefined;
    flattened.push({
      title: maskString(step.title),
      durationMs: step.duration,
      failed: step.error !== undefined,
      depth,
      kind,
      ...(ownError ? { error: ownError } : {}),
      ...(step.location
        ? { location: `${relative(PATHS.root, step.location.file)}:${step.location.line}` }
        : {}),
    });
    flattened.push(...flattenSteps(step.steps, depth + 1));
  }
  return flattened;
}

export default class ExtentReporter implements Reporter {
  private readonly reportDir: string;
  /*
   * Keyed by test id, not an array: Playwright calls onTestEnd once per ATTEMPT, so a retried
   * test would otherwise contribute several rows — appearing as both FAIL and FLAKY and skewing
   * total, failed and the pass rate away from what Playwright itself reports.
   */
  private readonly testsById = new Map<string, ExtentTest>();
  private startedAt = new Date();
  private config!: FullConfig;

  constructor() {
    this.reportDir = resolve(PATHS.extentReport, `run-${toFileStamp(new Date())}`);
  }

  public onBegin(config: FullConfig, _suite: Suite): void {
    this.config = config;
    this.startedAt = new Date();
    ensureDirectory(resolve(this.reportDir, 'attachments'));
  }

  public onTestEnd(test: TestCase, result: TestResult): void {
    const tags = [...new Set(test.title.match(TAG_PATTERN) ?? [])].concat(
      test.tags.filter((tag) => !test.title.includes(tag)),
    );
    const startedAt = result.startTime;
    const finishedAt = new Date(startedAt.getTime() + result.duration);

    const previous = this.testsById.get(test.id);
    const attempt: ExtentAttempt = {
      retry: result.retry,
      status: statusFor(test, result),
      startedAt: startedAt.toISOString(),
      durationMs: result.duration,
      workerIndex: result.workerIndex,
      ...(result.error?.message
        ? { errorMessage: maskString(stripAnsi(result.error.message)).split('\n')[0] ?? '' }
        : {}),
    };

    const row: ExtentTest = {
      id: test.id,
      name: maskString(test.titlePath().slice(3).join(' › ') || test.title),
      /* Both branches are masked: this file's contract is that nothing reaches the report raw. */
      description: maskString(
        test.annotations.find((annotation) => annotation.type === 'description')?.description ??
          test.titlePath().slice(1, -1).join(' › '),
      ),
      suite: suiteFor(test, tags),
      module: moduleFor(test),
      file: relative(PATHS.root, test.location.file),
      tags,
      project: test.parent.project()?.name ?? 'default',
      status: statusFor(test, result),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: result.duration,
      retries: result.retry,
      workerIndex: result.workerIndex,
      attempts: [...(previous?.attempts ?? []), attempt],
      steps: flattenSteps(result.steps),
      errorMessage: result.error?.message ? maskString(stripAnsi(result.error.message)) : undefined,
      errorStack: result.error?.stack
        ? maskString(stripAnsi(result.error.stack)).slice(0, 4000)
        : undefined,
      attachments: this.collectAttachments(test, result),
      annotations: test.annotations
        .filter((annotation) => annotation.description !== undefined)
        .map((annotation) => ({
          type: annotation.type,
          description: maskString(String(annotation.description)),
        })),
    };

    /*
     * The latest attempt decides the outcome, but the earlier attempt's evidence is what explains
     * a flake, so its error and artifacts are carried forward. Attachment files are already
     * namespaced by attempt (`<testId>-<retry>-<name>`), so concatenating cannot collide.
     */
    this.testsById.set(test.id, {
      ...row,
      errorMessage: row.errorMessage ?? previous?.errorMessage,
      errorStack: row.errorStack ?? previous?.errorStack,
      attachments: [...(previous?.attachments ?? []), ...row.attachments],
    });
  }

  /* ------------------------------------------------------------- history -- */

  /**
   * Reads the recorded history, appends this run and prunes to {@link HISTORY_LIMIT}.
   *
   * Returns the entries *before* this run, which is what the trend panel compares against. A
   * missing or corrupt file is treated as "no history yet" rather than an error: a trend is a
   * convenience, and losing it must never cost the report.
   */
  private updateHistory(entry: ExtentHistoryEntry): ExtentHistoryEntry[] {
    const file = resolve(PATHS.extentReport, 'history.json');
    let previous: ExtentHistoryEntry[] = [];
    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) previous = parsed as ExtentHistoryEntry[];
      } catch {
        process.stderr.write('[ExtentReporter] history.json was unreadable — starting a new one\n');
      }
    }

    /* A re-run of the same runId replaces its entry instead of duplicating it. */
    const kept = previous.filter((row) => row && row.runId !== entry.runId);
    const next = [...kept, entry].slice(-HISTORY_LIMIT);
    try {
      writeJsonFile(file, next);
    } catch (error) {
      process.stderr.write(
        `[ExtentReporter] could not write history.json: ${(error as Error).message}\n`,
      );
    }
    return kept.slice(-(HISTORY_LIMIT - 1));
  }

  /** Appends a summary table to the GitHub Actions job summary, when running there. */
  private writeCiSummary(model: ExtentReportModel, status: string): void {
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (!target) return;
    const s = model.summary;
    const icon = s.failed > 0 ? '❌' : s.flaky > 0 ? '⚠️' : '✅';
    const lines = [
      `### ${icon} ${model.environment.displayName} — ${s.passRate}% pass rate`,
      '',
      '| Total | Passed | Failed | Flaky | Skipped | Duration |',
      '| ---: | ---: | ---: | ---: | ---: | ---: |',
      `| ${s.total} | ${s.passed} | ${s.failed} | ${s.flaky} | ${s.skipped} | ${humanDuration(s.durationMs)} |`,
      '',
    ];
    const failures = model.tests.filter((test) => FAILED_STATUSES.includes(test.status));
    if (failures.length > 0) {
      lines.push(`<details><summary>${failures.length} failing test(s)</summary>`, '');
      for (const test of failures.slice(0, 20)) {
        lines.push(
          `- \`${test.project}\` ${test.name} — ${test.errorMessage?.split('\n')[0] ?? ''}`,
        );
      }
      if (failures.length > 20) lines.push(`- …and ${failures.length - 20} more`);
      lines.push('', '</details>', '');
    }
    lines.push(`Run status: \`${status}\``);
    try {
      appendFileSync(target, `${lines.join('\n')}\n`, 'utf8');
    } catch (error) {
      process.stderr.write(
        `[ExtentReporter] could not write the CI summary: ${(error as Error).message}\n`,
      );
    }
  }

  public async onEnd(result: FullResult): Promise<void> {
    const finishedAt = new Date();
    const tests = [...this.testsById.values()];
    const passed = tests.filter((test) => test.status === 'PASS').length;
    const flaky = tests.filter((test) => test.status === 'FLAKY').length;
    const failed = tests.filter(
      (test) =>
        test.status === 'FAIL' || test.status === 'TIMEOUT' || test.status === 'INTERRUPTED',
    ).length;
    const skipped = tests.filter((test) => test.status === 'SKIP').length;
    const executed = tests.length - skipped;

    const summary = {
      total: tests.length,
      passed,
      failed,
      skipped,
      flaky,
      passRate: executed > 0 ? Math.round(((passed + flaky) / executed) * 100) : 0,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
    };
    const environment = this.buildEnvironment();
    const runId = frameworkConfig.runId;

    /*
     * Outbound integrations run before the document is rendered so their outcome is part of the
     * artifact rather than something only the console saw. `publishIntegrations` resolves for
     * every target — enabled, disabled or broken — and never throws, so a dead webhook cannot
     * cost us the report itself. An empty array means nothing is configured, and the report says
     * exactly that instead of inventing a row.
     */
    const integrations =
      tests.length === 0
        ? []
        : await publishIntegrations({
            model: { runId, summary, environment, tests },
            reportDir: this.reportDir,
            ...(process.env.REPORT_URL ? { reportUrl: process.env.REPORT_URL } : {}),
          });

    /*
     * History is recorded only for runs that executed something, and the entries handed to the
     * report are the ones from BEFORE this run — a trend compares against the past, and a chart
     * that included its own data point would always end flat.
     */
    const history =
      tests.length === 0
        ? []
        : this.updateHistory({
            runId,
            finishedAt: summary.finishedAt,
            environment: environment.name,
            ci: environment.ci,
            total: summary.total,
            passed: summary.passed,
            failed: summary.failed,
            flaky: summary.flaky,
            skipped: summary.skipped,
            passRate: summary.passRate,
            durationMs: summary.durationMs,
          });

    const model: ExtentReportModel = {
      runId,
      summary,
      environment,
      tests,
      ...(integrations.length > 0 ? { integrations } : {}),
      ...(history.length > 0 ? { history } : {}),
    };

    const htmlPath = resolve(this.reportDir, 'index.html');
    writeTextFile(htmlPath, renderExtentHtml(model));
    writeJsonFile(resolve(this.reportDir, 'report.json'), model);

    /*
     * `latest.*` is what `npm run report:open` opens, so only a run that actually executed
     * something advances it. A run that reported nothing — an unknown `--project`, a failed
     * global setup, `--list` — would otherwise replace the last real report with an empty one
     * and leave the reader believing the suite had zero tests.
     */
    if (tests.length === 0) {
      process.stdout.write(
        `\nExtent report: ${htmlPath}\n` +
          `  no tests were executed (run status: ${result.status}) — ` +
          `reports/extent/latest.html still points at the previous run\n\n`,
      );
      await Promise.resolve();
      return;
    }

    /*
     * `reports/extent/latest.html` always points at the most recent run. It lives one directory
     * above the attachments, so it is rendered with the run folder as the asset prefix — without
     * it every screenshot, video and trace link in this copy would resolve to nothing.
     */
    writeTextFile(
      resolve(PATHS.extentReport, 'latest.html'),
      renderExtentHtml(model, `${basename(this.reportDir)}/`),
    );
    writeJsonFile(resolve(PATHS.extentReport, 'latest.json'), {
      reportDir: this.reportDir,
      runId,
      status: result.status,
      summary: model.summary,
    });

    this.writeCiSummary(model, result.status);

    process.stdout.write(
      `\nExtent report: ${htmlPath}\n` +
        `  ${model.summary.passed} passed · ${model.summary.failed} failed · ` +
        `${model.summary.flaky} flaky · ${model.summary.skipped} skipped ` +
        `(${model.summary.passRate}% pass rate)\n\n`,
    );
    await Promise.resolve();
  }

  /* ------------------------------------------------------------ internals -- */

  private buildEnvironment(): ExtentEnvironment {
    const environment = getEnvironment();
    return {
      name: environment.name,
      displayName: environment.displayName,
      uiBaseUrl: environment.ui.baseUrl,
      apiBaseUrl: environment.api.baseUrl,
      ci: environment.isCi,
      workers: this.config.workers,
      retries: frameworkConfig.retries,
      headless: frameworkConfig.headless,
      projects: this.config.projects.map((project) => project.name),
      node: process.version,
      framework: `${FRAMEWORK_NAME} v${FRAMEWORK_VERSION}`,
      playwright: this.config.version,
    };
  }

  /** Copies artifacts next to the report so it can be zipped and shared as one folder. */
  private collectAttachments(test: TestCase, result: TestResult): ExtentAttachment[] {
    const collected: ExtentAttachment[] = [];
    for (const attachment of result.attachments) {
      if (!attachment.path || !existsSync(attachment.path)) continue;

      const kind: ExtentAttachment['kind'] = attachment.name.includes('screenshot')
        ? 'screenshot'
        : attachment.name.includes('video')
          ? 'video'
          : attachment.name.includes('trace')
            ? 'trace'
            : 'other';

      const fileName = `${test.id}-${result.retry}-${basename(attachment.path)}`;
      const destination = resolve(this.reportDir, 'attachments', fileName);
      try {
        copyFileSync(attachment.path, destination);
        collected.push({ name: attachment.name, path: `attachments/${fileName}`, kind });
      } catch (error) {
        process.stderr.write(
          `[ExtentReporter] could not copy attachment ${attachment.name}: ${(error as Error).message}\n`,
        );
      }
    }

    /* Console/network logs written by a test as a text attachment are inlined for convenience. */
    for (const attachment of result.attachments) {
      if (attachment.body && attachment.contentType.startsWith('text/')) {
        const fileName = `${test.id}-${result.retry}-${attachment.name}.txt`;
        writeTextFile(
          resolve(this.reportDir, 'attachments', fileName),
          maskString(attachment.body.toString('utf8')),
        );
        collected.push({ name: attachment.name, path: `attachments/${fileName}`, kind: 'other' });
      }
    }
    return collected;
  }
}

/** Strips terminal colour codes so the report shows clean text. */
function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);
  const pattern = new RegExp(`${escape}\\[[0-9;]*m`, 'g');
  return value.replace(pattern, '');
}

/** Reads the most recent report summary — used by `npm run report:open`. */
export function latestReportSummary(): { reportDir: string } | undefined {
  const latest = resolve(PATHS.extentReport, 'latest.json');
  if (!existsSync(latest)) return undefined;
  return JSON.parse(readFileSync(latest, 'utf8')) as { reportDir: string };
}
