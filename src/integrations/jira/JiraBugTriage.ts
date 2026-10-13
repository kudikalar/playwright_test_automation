/**
 * JiraBugTriage — one Jira Bug per failing test, de-duplicated across runs.
 *
 * Without this, `JIRA_CREATE_ISSUE_ON_FAILURE` files a fresh Bug every build a test stays red,
 * which is how automation earns a reputation for spam. Triage fixes that with a fingerprint:
 *
 *   fingerprint = sha1(spec file + test title, tags stripped)  →  label `pw-fp-<12 hex>`
 *
 * The label survives renames of the browser project (one Bug covers chromium *and* firefox),
 * and tag edits (`@smoke` added later does not fork the history). Per run:
 *
 *  1. ONE JQL search fetches every open auto-filed Bug in the project (`labels = pw-auto`).
 *  2. A failing test whose fingerprint matches an open Bug gets a "still failing" comment on it
 *     (and loses the `pw-passing` label if a previous run had set it).
 *  3. A failing test with no open Bug gets a new one: summary, error, failed step, environment,
 *     report link — and the failure screenshot attached.
 *  4. With `JIRA_NOTE_RECOVERIES`, an open Bug whose test PASSED this run gets one "passing again"
 *     comment and the `pw-passing` label, so it is noted once rather than every green build.
 *     Nothing is ever transitioned or closed automatically — workflows differ, humans decide.
 *
 * Search-then-create is not atomic: two pipelines finishing in the same second can both file. That
 * window is narrow and visible (same fingerprint label on two Bugs), unlike the per-build spam it
 * replaces.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

import type { ExtentTest } from '../../reporting/ExtentTypes';
import type { IntegrationContext } from '../IntegrationTypes';
import { adfDocument, type JiraClient, type JiraIssueSummary } from './JiraClient';

export const AUTO_LABEL = 'pw-auto';
export const PASSING_LABEL = 'pw-passing';
export const FINGERPRINT_PREFIX = 'pw-fp-';

/** Jira rejects attachments above the site limit (10MB by default on Cloud is common); stay well under. */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

export interface TriageSettings {
  readonly projectKey: string;
  readonly issueType: string;
  readonly extraLabels: readonly string[];
  readonly createIssues: boolean;
  readonly attachScreenshots: boolean;
  readonly noteRecoveries: boolean;
}

/** Shared call budget/deadline owned by the notifier. */
export interface TriageBudget {
  /** Reserves one API call, or returns why it cannot. */
  take(): 'cap' | 'time' | undefined;
  remainingMs(): number;
}

export interface TriageOutcome {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly recovered: readonly string[];
  readonly failures: readonly string[];
  readonly skippedByBudget: number;
  readonly truncation: 'cap' | 'time' | undefined;
}

const clamp = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;

/** Strips `@tags` and normalises whitespace/case so cosmetic title edits keep the fingerprint. */
export function normaliseTitle(title: string): string {
  return title
    .replace(/(^|\s)@[\w:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function fingerprintOf(test: Pick<ExtentTest, 'file' | 'name'>): string {
  const identity = `${test.file.replace(/\\/g, '/')}::${normaliseTitle(test.name)}`;
  return `${FINGERPRINT_PREFIX}${createHash('sha1').update(identity).digest('hex').slice(0, 12)}`;
}

const firstErrorLine = (test: ExtentTest): string =>
  (test.errorMessage ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? 'no error message captured';

const failedStep = (test: ExtentTest): string | undefined =>
  test.steps.filter((step) => step.failed).at(-1)?.title;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Quotes a value for JQL: backslash and double quote are the only escapes it needs. */
const jqlString = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

interface FailureGroup {
  readonly fingerprint: string;
  readonly tests: readonly ExtentTest[];
}

function groupByFingerprint(tests: readonly ExtentTest[]): FailureGroup[] {
  const groups = new Map<string, ExtentTest[]>();
  for (const test of tests) {
    const key = fingerprintOf(test);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [test]);
    else bucket.push(test);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fingerprint, grouped]) => ({ fingerprint, tests: grouped }));
}

function runLine(context: IntegrationContext): string {
  const { environment, summary, runId } = context.model;
  return `Run ${runId} on ${environment.displayName} (${environment.name}) finished ${summary.finishedAt}: ${summary.failed} failed / ${summary.total} total.`;
}

function bugDescription(group: FailureGroup, context: IntegrationContext): string[] {
  const [lead] = group.tests;
  if (lead === undefined) return [];
  const step = failedStep(lead);
  return [
    `Automated Playwright test is failing: ${lead.name}`,
    `Spec: ${lead.file}`,
    `Browsers / projects: ${[...new Set(group.tests.map((test) => test.project))].join(', ')}`,
    step === undefined ? '' : `Failed at step: ${step}`,
    `Error: ${clamp(firstErrorLine(lead), 600)}`,
    ...(lead.errorMessage ?? '')
      .split('\n')
      .slice(1, 8)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('at ')),
    `Environment: ${context.model.environment.displayName} | UI ${context.model.environment.uiBaseUrl} | API ${context.model.environment.apiBaseUrl}`,
    runLine(context),
    context.reportUrl === undefined
      ? ''
      : `Full report with trace, video and screenshots: ${context.reportUrl}`,
    `This issue was filed by the Playwright framework and is de-duplicated by the label ${group.fingerprint}. ` +
      'Later failures of the same test add a comment here instead of filing a new issue.',
  ];
}

function stillFailingComment(group: FailureGroup, context: IntegrationContext): string[] {
  const [lead] = group.tests;
  return [
    `Still failing in the latest automated run (${group.tests.map((test) => test.project).join(', ')}).`,
    lead === undefined ? '' : `Error: ${clamp(firstErrorLine(lead), 600)}`,
    lead === undefined || failedStep(lead) === undefined
      ? ''
      : `Failed at step: ${failedStep(lead)}`,
    runLine(context),
    context.reportUrl === undefined ? '' : `Full report: ${context.reportUrl}`,
  ];
}

/** Resolves an attachment path from the model, refusing anything that escapes the report folder. */
function screenshotFor(
  test: ExtentTest,
  reportDir: string,
): { path: string; name: string } | undefined {
  const shot = test.attachments.find((attachment) => attachment.kind === 'screenshot');
  if (shot === undefined) return undefined;
  const absolute = resolve(reportDir, shot.path);
  const rel = relative(reportDir, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  if (!existsSync(absolute) || statSync(absolute).size > MAX_SCREENSHOT_BYTES) return undefined;
  return { path: absolute, name: `failure-${test.project}${extname(absolute) || '.png'}` };
}

const MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export async function triagePerTest(
  client: JiraClient,
  settings: TriageSettings,
  unlinkedFailures: readonly ExtentTest[],
  context: IntegrationContext,
  budget: TriageBudget,
): Promise<TriageOutcome> {
  const created: string[] = [];
  const updated: string[] = [];
  const recovered: string[] = [];
  const failures: string[] = [];
  let skippedByBudget = 0;
  let truncation: 'cap' | 'time' | undefined;

  const groups = settings.createIssues ? groupByFingerprint(unlinkedFailures) : [];
  if (groups.length === 0 && !settings.noteRecoveries) {
    return { created, updated, recovered, failures, skippedByBudget, truncation };
  }

  /* 1. One search for every open auto-filed bug in the project. */
  const stop = budget.take();
  if (stop !== undefined) {
    return {
      created,
      updated,
      recovered,
      failures,
      skippedByBudget: groups.length,
      truncation: stop,
    };
  }
  let open: readonly JiraIssueSummary[];
  let complete: boolean;
  try {
    const result = await client.searchIssues(
      `project = ${jqlString(settings.projectKey)} AND labels = ${jqlString(AUTO_LABEL)} AND statusCategory != Done ORDER BY created DESC`,
      ['summary', 'status', 'labels'],
      100,
      budget.remainingMs(),
    );
    open = result.issues;
    complete = !result.hasMore;
  } catch (error) {
    /* Without the search there is no de-duplication, and filing blind is exactly the spam this
       module exists to prevent — so nothing is created. */
    failures.push(`open-bug search failed, no bugs filed to avoid duplicates: ${describe(error)}`);
    return { created, updated, recovered, failures, skippedByBudget: groups.length, truncation };
  }

  const byFingerprint = new Map<string, JiraIssueSummary>();
  for (const issue of open) {
    for (const label of issue.labels) {
      if (label.startsWith(FINGERPRINT_PREFIX) && !byFingerprint.has(label))
        byFingerprint.set(label, issue);
    }
  }

  /* 2 + 3. Comment on, or file, one bug per failing test. */
  for (const group of groups) {
    let existing = byFingerprint.get(group.fingerprint);

    /* More than 100 open auto bugs: the first page missed some, so ask about this one directly. */
    if (existing === undefined && !complete) {
      const reason = budget.take();
      if (reason !== undefined) {
        truncation ??= reason;
        skippedByBudget += 1;
        continue;
      }
      try {
        const direct = await client.searchIssues(
          `project = ${jqlString(settings.projectKey)} AND labels = ${jqlString(group.fingerprint)} AND statusCategory != Done`,
          ['summary', 'status', 'labels'],
          1,
          budget.remainingMs(),
        );
        existing = direct.issues[0];
      } catch (error) {
        failures.push(`${group.fingerprint}: lookup failed, not filed: ${describe(error)}`);
        continue;
      }
    }

    const reason = budget.take();
    if (reason !== undefined) {
      truncation ??= reason;
      skippedByBudget += 1;
      continue;
    }

    if (existing !== undefined) {
      try {
        await client.addComment(
          existing.key,
          adfDocument(stillFailingComment(group, context)),
          budget.remainingMs(),
        );
        updated.push(existing.key);
        if (existing.labels.includes(PASSING_LABEL) && budget.take() === undefined) {
          await client
            .updateLabels(existing.key, [], [PASSING_LABEL], budget.remainingMs())
            .catch((error: unknown) => {
              failures.push(
                `${existing?.key ?? '?'}: could not clear ${PASSING_LABEL}: ${describe(error)}`,
              );
            });
        }
      } catch (error) {
        failures.push(`${existing.key}: ${describe(error)}`);
      }
      continue;
    }

    const [lead] = group.tests;
    if (lead === undefined) continue;
    try {
      const issue = await client.createIssue(
        {
          project: { key: settings.projectKey },
          issuetype: { name: settings.issueType },
          summary: clamp(
            `[Playwright] ${normaliseTitleForSummary(lead.name)} — ${firstErrorLine(lead)}`,
            240,
          ),
          description: adfDocument(bugDescription(group, context)),
          labels: [
            ...new Set(['playwright', AUTO_LABEL, group.fingerprint, ...settings.extraLabels]),
          ],
        },
        budget.remainingMs(),
      );
      created.push(issue.key);

      if (settings.attachScreenshots) {
        const shot = screenshotFor(lead, context.reportDir);
        if (shot !== undefined && budget.take() === undefined) {
          try {
            await client.addAttachment(
              issue.key,
              shot.name,
              readFileSync(shot.path),
              MIME[extname(shot.path).toLowerCase()] ?? 'application/octet-stream',
              budget.remainingMs(),
            );
          } catch (error) {
            failures.push(`${issue.key}: screenshot not attached: ${describe(error)}`);
          }
        }
      }
    } catch (error) {
      failures.push(`create bug for "${clamp(lead.name, 80)}": ${describe(error)}`);
    }
  }

  /* 4. Note recoveries once per bug. */
  if (settings.noteRecoveries) {
    const failingNow = new Set(groups.map((group) => group.fingerprint));
    const passedNow = new Map<string, ExtentTest>();
    for (const test of context.model.tests) {
      if (test.status === 'PASS' || test.status === 'FLAKY')
        passedNow.set(fingerprintOf(test), test);
    }
    for (const test of context.model.tests) {
      if (test.status === 'FAIL' || test.status === 'TIMEOUT') failingNow.add(fingerprintOf(test));
    }

    for (const [fingerprint, issue] of byFingerprint) {
      if (failingNow.has(fingerprint) || issue.labels.includes(PASSING_LABEL)) continue;
      const test = passedNow.get(fingerprint);
      if (test === undefined) continue;
      const reason = budget.take();
      if (reason !== undefined) {
        truncation ??= reason;
        break;
      }
      try {
        await client.addComment(
          issue.key,
          adfDocument([
            `The automated test for this issue PASSED in the latest run (${test.project}${test.status === 'FLAKY' ? ', after a retry — still flaky' : ''}).`,
            runLine(context),
            context.reportUrl === undefined ? '' : `Report: ${context.reportUrl}`,
            `If the fix is confirmed this issue can be closed. Label ${PASSING_LABEL} was added so this note is posted only once; it is removed automatically if the test fails again.`,
          ]),
          budget.remainingMs(),
        );
        recovered.push(issue.key);
        if (budget.take() === undefined) {
          await client
            .updateLabels(issue.key, [PASSING_LABEL], [], budget.remainingMs())
            .catch((error: unknown) => {
              failures.push(`${issue.key}: could not add ${PASSING_LABEL}: ${describe(error)}`);
            });
        }
      } catch (error) {
        failures.push(`${issue.key}: recovery note failed: ${describe(error)}`);
      }
    }
  }

  return { created, updated, recovered, failures, skippedByBudget, truncation };
}

/** Summary-friendly title: tags removed, original casing kept. */
function normaliseTitleForSummary(title: string): string {
  return title
    .replace(/(^|\s)@[\w:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
