/**
 * ZephyrNotifier — publishes a finished run to a Zephyr Scale Cloud test cycle.
 *
 * One Playwright test becomes one Zephyr test execution **per Zephyr test-case key it carries**, so
 * a test that covers `QA-T1` and `QA-T2` updates both. Tests without a key are counted and
 * reported, never invented: `POST /testexecutions` cannot create a test case, and guessing a key
 * would either 404 or — worse — write a result onto somebody else's test case.
 *
 * The integration is off unless `ZEPHYR_ENABLED` is truthy *and* the token and project key are
 * present. That third flag is not ceremony: executions are append-only, so a stray local run
 * silently doubles a real project's history and there is no undo.
 *
 * Two guarantees hold beyond that, in line with the integration contract:
 *
 *  - **Never fails the run.** Every path through {@link ZephyrNotifier.publish} returns an
 *    {@link IntegrationResult}; nothing throws, because a reporter's rejection is attributed to
 *    the suite and turns a green run red.
 *  - **Bounded.** The client's per-call timeout stops one hung request; `ZEPHYR_MAX_TOTAL_MS`
 *    stops a thousand merely-slow ones, and the detail says how many executions were left
 *    unattempted rather than dropping them quietly.
 */

import type { ExtentReportModel, ExtentStatus, ExtentTest } from '../../reporting/ExtentTypes';
import { maskString } from '../../utils/DataMasker';
import { createLogger, type Logger } from '../../utils/Logger';
import {
  issueKeysFor,
  type Integration,
  type IntegrationContext,
  type IntegrationResult,
  type IntegrationStatus,
} from '../IntegrationTypes';
import {
  ZEPHYR_DEFAULT_BASE_URL,
  ZEPHYR_PROJECT_KEY_PATTERN,
  ZEPHYR_TEST_CYCLE_KEY_PATTERN,
  ZephyrClient,
  toZephyrDateTime,
  type ZephyrTestExecutionInput,
} from './ZephyrClient';

/* --------------------------------------------------------------- tuning -- */

/**
 * In-flight executions. Zephyr Scale documents no rate limit at all, which is a reason to assume
 * one exists rather than that none does, and the endpoint is append-only so a throttled retry is
 * not an option. A small pool keeps a thousand-test suite from arriving as a thousand-request
 * burst while still finishing in seconds; `ZEPHYR_MAX_CONCURRENCY=1` makes it strictly sequential.
 */
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENCY_CEILING = 10;

/**
 * Wall-clock ceiling for the publishing loop. The client's per-call timeout bounds one hung
 * request; this bounds a Zephyr that is merely slow, where a large suite at four in flight would
 * otherwise hold CI for many minutes *after* the tests finished. The budget is checked before each
 * execution is dequeued and never cancels one in flight: aborting a POST that appends a row leaves
 * nobody able to say whether the row landed.
 */
const DEFAULT_MAX_TOTAL_MS = 120_000;
const MIN_MAX_TOTAL_MS = 5_000;

/** A comment is context for a human, not a log sink; the full stack lives in the report. */
const COMMENT_LIMIT = 1000;

/** How much of the first publish failure the run summary quotes. */
const FAILURE_DETAIL_LIMIT = 240;

const CYCLE_DESCRIPTION_LIMIT = 1000;

/** Zephyr caps a cycle name at 255; clamping here means the clamp is visible in the name. */
const CYCLE_NAME_LIMIT = 255;

/**
 * Zephyr test-case keys as they appear in a tag or annotation, e.g. `@QA-T123`.
 *
 * The shared `issueKeysFor` cannot find these — its pattern requires digits immediately after the
 * hyphen (`QA-123`), whereas a Zephyr Scale test case is `QA-T123`. So the scan is Zephyr-specific,
 * and `issueKeysFor` is used for something it *is* right for: telling a team that tagged with the
 * Jira **issue** key apart from a team that tagged nothing, which is the difference between "you
 * used the wrong key" and "you forgot".
 */
const ZEPHYR_KEY_PATTERN = /\b([A-Z][A-Z_0-9]+-T\d+)\b/g;

/** Built from a char code so the literal escape does not trip `no-control-regex`. */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/* --------------------------------------------------------------- config -- */

const read = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
};

const flag = (value: string | undefined): boolean =>
  value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

/** Truncation that admits it happened, rather than passing a clipped value off as the whole one. */
const clamp = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;

interface ZephyrSettings {
  readonly token: string;
  readonly projectKey: string;
  readonly baseUrl: string;
  readonly cycleKey?: string;
  readonly cycleName?: string;
  readonly environmentName?: string;
  readonly statusNames: Readonly<Record<ExtentStatus, string>>;
  readonly maxConcurrency: number;
  readonly maxTotalMs: number;
}

/**
 * Status names are **not** an API enum: they are per-project strings an administrator can rename,
 * and an unrecognised one is rejected with a 400 on every single execution. The four defaults are
 * the stock Zephyr Scale names, which is a sane starting point and nothing more — hence the
 * overrides, and hence {@link ZephyrNotifier.warnOnUnknownStatuses} checking them once per run.
 *
 * `FLAKY` maps to the pass name on purpose: Playwright reports a test as flaky when it *passed* on
 * a retry, and Zephyr has no equivalent state. The retry count goes into the comment so the result
 * is not silently laundered into a clean pass.
 */
function readStatusNames(env: NodeJS.ProcessEnv): Readonly<Record<ExtentStatus, string>> {
  const pass = read(env, 'ZEPHYR_STATUS_PASS') ?? 'Pass';
  const fail = read(env, 'ZEPHYR_STATUS_FAIL') ?? 'Fail';
  const blocked = read(env, 'ZEPHYR_STATUS_BLOCKED') ?? 'Blocked';
  const notExecuted = read(env, 'ZEPHYR_STATUS_NOT_EXECUTED') ?? 'Not Executed';
  return {
    PASS: pass,
    FLAKY: pass,
    FAIL: fail,
    TIMEOUT: fail,
    INTERRUPTED: blocked,
    SKIP: notExecuted,
  };
}

function readMaxConcurrency(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(read(env, 'ZEPHYR_MAX_CONCURRENCY') ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENCY;
  return Math.min(parsed, MAX_CONCURRENCY_CEILING);
}

function readMaxTotalMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(read(env, 'ZEPHYR_MAX_TOTAL_MS') ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOTAL_MS;
  return Math.max(MIN_MAX_TOTAL_MS, parsed);
}

/** The variables that must be present before a single request is made. */
function missingSettings(env: NodeJS.ProcessEnv): readonly string[] {
  const missing: string[] = [];
  if (!flag(read(env, 'ZEPHYR_ENABLED'))) missing.push('ZEPHYR_ENABLED=true');
  if (read(env, 'ZEPHYR_API_TOKEN') === undefined) missing.push('ZEPHYR_API_TOKEN');
  if (read(env, 'ZEPHYR_PROJECT_KEY') === undefined) missing.push('ZEPHYR_PROJECT_KEY');
  return missing;
}

function readSettings(env: NodeJS.ProcessEnv): ZephyrSettings | undefined {
  const token = read(env, 'ZEPHYR_API_TOKEN');
  const projectKey = read(env, 'ZEPHYR_PROJECT_KEY');
  if (!flag(read(env, 'ZEPHYR_ENABLED')) || token === undefined || projectKey === undefined) {
    return undefined;
  }
  return {
    token,
    projectKey: projectKey.toUpperCase(),
    baseUrl: read(env, 'ZEPHYR_BASE_URL') ?? ZEPHYR_DEFAULT_BASE_URL,
    cycleKey: read(env, 'ZEPHYR_TEST_CYCLE_KEY'),
    cycleName: read(env, 'ZEPHYR_TEST_CYCLE_NAME'),
    environmentName: read(env, 'ZEPHYR_ENVIRONMENT_NAME'),
    statusNames: readStatusNames(env),
    maxConcurrency: readMaxConcurrency(env),
    maxTotalMs: readMaxTotalMs(env),
  };
}

/* --------------------------------------------------------------- mapping -- */

/** One Playwright result aimed at one Zephyr test case. */
interface ZephyrTarget {
  readonly test: ExtentTest;
  readonly testCaseKey: string;
}

interface TargetScan {
  readonly targets: readonly ZephyrTarget[];
  /** Tests carrying no Zephyr-shaped key at all. */
  readonly withoutKey: number;
  /** Of those, the ones that carried a Jira issue key — a tagging mistake worth naming. */
  readonly issueKeyOnly: number;
  /** Tests whose only Zephyr keys named another project, which is a different mistake again. */
  readonly foreignOnly: number;
  /** Individual keys ignored as another project's, which this project's endpoint could only 404. */
  readonly foreignKeys: number;
}

interface CycleTarget {
  readonly key: string;
  readonly created: boolean;
}

interface PublishOutcome {
  readonly published: number;
  readonly failures: readonly string[];
  /** Executions never sent because the time budget ran out — reported, never quietly dropped. */
  readonly unattempted: number;
}

function zephyrKeysIn(test: ExtentTest): readonly string[] {
  const haystack = [
    ...test.tags,
    ...test.annotations.map((annotation) => `${annotation.type}:${annotation.description}`),
  ].join(' ');
  return [...new Set([...haystack.matchAll(ZEPHYR_KEY_PATTERN)].map((match) => match[1] ?? ''))]
    .filter((key) => key.length > 0)
    .sort();
}

function scanTargets(model: ExtentReportModel, projectKey: string): TargetScan {
  const targets: ZephyrTarget[] = [];
  let withoutKey = 0;
  let issueKeyOnly = 0;
  let foreignOnly = 0;
  let foreignKeys = 0;

  for (const test of model.tests) {
    const keys = zephyrKeysIn(test);
    /* A key from another project would be a guaranteed 404, since the execution is posted against
       one projectKey. Counting them beats sending them and beats hiding them. */
    const mine = keys.filter((key) => key.startsWith(`${projectKey}-T`));
    foreignKeys += keys.length - mine.length;

    if (mine.length === 0) {
      /* "Tagged for another project" and "not tagged at all" are different mistakes with different
         fixes, so they are counted apart rather than lumped into one misleading number. */
      if (keys.length > 0) foreignOnly += 1;
      else {
        withoutKey += 1;
        if (issueKeysFor(test.tags, test.annotations).length > 0) issueKeyOnly += 1;
      }
      continue;
    }
    for (const key of mine) targets.push({ test, testCaseKey: key });
  }

  return { targets, withoutKey, issueKeyOnly, foreignOnly, foreignKeys };
}

/** First line of the failure, stripped of terminal colour codes that would render as `[2m` noise. */
function executionComment(test: ExtentTest): string | undefined {
  const firstErrorLine = (test.errorMessage ?? '')
    .replace(ANSI_PATTERN, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const parts: string[] = [];
  if (test.status === 'FLAKY') {
    parts.push(`Passed on retry (${test.retries} attempt(s) failed first).`);
  }
  if (firstErrorLine !== undefined) parts.push(firstErrorLine);
  if (parts.length === 0) return undefined;
  /* Masked as well as clamped: an assertion message can quote a request that carried a token, and
     this string is written to a system other people read. */
  return clamp(maskString(parts.join(' ')), COMMENT_LIMIT);
}

/* -------------------------------------------------------------- notifier -- */

export interface ZephyrNotifierOptions {
  readonly logger?: Logger;
  /** Injected rather than read globally so a test can drive this class without touching the host. */
  readonly env?: NodeJS.ProcessEnv;
}

export class ZephyrNotifier implements Integration {
  public readonly name = 'Zephyr Scale';

  private readonly log: Logger;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ZephyrNotifierOptions = {}) {
    this.log = options.logger ?? createLogger('ZephyrNotifier');
    this.env = options.env ?? process.env;
  }

  public isEnabled(): boolean {
    return missingSettings(this.env).length === 0;
  }

  public disabledReason(): string {
    const missing = missingSettings(this.env);
    if (missing.length === 0) return '';
    return (
      `Not configured — set ${missing.join(', ')}. ` +
      'Zephyr executions are append-only, so publishing stays off until it is asked for explicitly.'
    );
  }

  /**
   * Never throws and never rejects: a Zephyr outage, a rotated token, a malformed `ZEPHYR_BASE_URL`
   * or a renamed status is reported as a `failed` integration result, not as a failed test run.
   * Reading the settings sits inside the guard too — cheap, and it removes the last statement that
   * could reject before the `try` was entered.
   */
  public async publish(context: IntegrationContext): Promise<IntegrationResult> {
    const startedAt = Date.now();
    try {
      const settings = readSettings(this.env);
      if (settings === undefined) return this.finish('skipped', this.disabledReason(), startedAt);
      return await this.publishRun(context, settings, startedAt);
    } catch (error) {
      return this.finish('failed', `Zephyr publish failed — ${describeError(error)}`, startedAt);
    }
  }

  private async publishRun(
    context: IntegrationContext,
    settings: ZephyrSettings,
    startedAt: number,
  ): Promise<IntegrationResult> {
    /* Both keys are checked before anything leaves the process, so a typo reads as its own
       sentence instead of arriving as a 400 from a service the operator cannot see. */
    if (!ZEPHYR_PROJECT_KEY_PATTERN.test(settings.projectKey)) {
      return this.finish(
        'failed',
        `ZEPHYR_PROJECT_KEY "${clamp(settings.projectKey, 40)}" (normalised to uppercase) is not a ` +
          'valid Jira project key: uppercase, at least two characters.',
        startedAt,
      );
    }
    if (settings.cycleKey !== undefined && !ZEPHYR_TEST_CYCLE_KEY_PATTERN.test(settings.cycleKey)) {
      return this.finish(
        'failed',
        `ZEPHYR_TEST_CYCLE_KEY "${clamp(settings.cycleKey, 40)}" is not a valid cycle key ` +
          '(expected <PROJECT>-R<number>, e.g. QA-R42).',
        startedAt,
      );
    }

    const scan = scanTargets(context.model, settings.projectKey);
    if (scan.targets.length === 0) {
      return this.finish(
        'skipped',
        this.nothingToPublishDetail(context.model, settings, scan),
        startedAt,
      );
    }

    /* Constructing the client validates ZEPHYR_BASE_URL, which is why it happens here rather than
       in the constructor: the failure belongs to this run's result, not to the reporter's setup. */
    const client = new ZephyrClient({ token: settings.token, baseUrl: settings.baseUrl });
    const deadline = startedAt + settings.maxTotalMs;

    await this.warnOnUnknownStatuses(client, settings, scan.targets);

    const cycle = await this.resolveCycleKey(client, settings, context);
    const outcome = await this.publishExecutions(
      client,
      settings,
      cycle.key,
      scan.targets,
      deadline,
    );

    const detail = [
      `${outcome.published}/${scan.targets.length} execution(s) published to cycle ${cycle.key}` +
        (cycle.created ? ' (created for this run)' : ' (existing cycle)'),
      outcome.failures.length > 0 ? `${outcome.failures.length} rejected` : undefined,
      outcome.unattempted > 0
        ? `${outcome.unattempted} not attempted — the ${settings.maxTotalMs}ms ZEPHYR_MAX_TOTAL_MS ` +
          'budget ran out and nothing is retried against an append-only endpoint'
        : undefined,
      ...this.skipNotes(scan),
      outcome.failures[0] === undefined
        ? undefined
        : `first failure — ${clamp(outcome.failures[0], FAILURE_DETAIL_LIMIT)}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join('; ');

    /*
     * Deliberately no `url`: the cycle's `self` link is an authenticated API endpoint that answers
     * 401 in a browser, and the tenant's Jira base URL is not something this process knows. The
     * cycle key in the detail is the thing a human can actually search for.
     */
    const incomplete = outcome.failures.length > 0 || outcome.unattempted > 0;
    return this.finish(incomplete ? 'failed' : 'published', detail, startedAt);
  }

  /**
   * Reuses the configured cycle, or creates one named after the run. Creating once per run — not
   * once per test — is what keeps shards and re-runs of the same suite in a single cycle.
   */
  private async resolveCycleKey(
    client: ZephyrClient,
    settings: ZephyrSettings,
    context: IntegrationContext,
  ): Promise<CycleTarget> {
    if (settings.cycleKey !== undefined) return { key: settings.cycleKey, created: false };

    const { summary, environment } = context.model;
    /* `name` is mandatory and must not be blank, so the fallback is derived from the run rather
       than left to the operator to remember. */
    const name = clamp(
      settings.cycleName ?? `Playwright ${environment.displayName} — ${summary.startedAt}`,
      CYCLE_NAME_LIMIT,
    );
    const description = clamp(
      [
        `${summary.total} test(s): ${summary.passed} passed, ${summary.failed} failed, ` +
          `${summary.skipped} skipped, ${summary.flaky} flaky.`,
        `Projects: ${environment.projects.length > 0 ? environment.projects.join(', ') : 'none'}.`,
        context.reportUrl === undefined ? undefined : `Report: ${context.reportUrl}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join(' '),
      CYCLE_DESCRIPTION_LIMIT,
    );

    const created = await client.createTestCycle({
      projectKey: settings.projectKey,
      name,
      description,
    });
    return { key: created.key, created: true };
  }

  /**
   * Drains the queue through a bounded pool. Each execution is independent, so one rejection is
   * recorded and the rest continue — a single missing test case must not cost the run every other
   * result. Nothing is retried, because this endpoint appends rather than upserts.
   *
   * The deadline is tested before a target is dequeued and never interrupts a request already in
   * flight: cancelling a POST that may already have appended a row trades a slow reporter for an
   * unanswerable question about whether the result landed.
   */
  private async publishExecutions(
    client: ZephyrClient,
    settings: ZephyrSettings,
    cycleKey: string,
    targets: readonly ZephyrTarget[],
    deadline: number,
  ): Promise<PublishOutcome> {
    const queue = [...targets];
    const failures: string[] = [];
    let published = 0;
    let unattempted = 0;

    const workers = Array.from(
      { length: Math.min(settings.maxConcurrency, queue.length) },
      async () => {
        for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
          if (Date.now() >= deadline) {
            unattempted += 1;
            continue;
          }
          try {
            await client.createTestExecution(toExecutionInput(target, settings, cycleKey));
            published += 1;
          } catch (error) {
            failures.push(`${target.testCaseKey}: ${describeError(error)}`);
          }
        }
      },
    );
    await Promise.all(workers);

    if (failures.length > 0) {
      this.log.warn(`${failures.length} execution(s) could not be published`, failures.slice(0, 5));
    }
    if (unattempted > 0) {
      this.log.warn(
        `${unattempted} execution(s) were not sent: the ${settings.maxTotalMs}ms publish budget ` +
          'ran out. Raise ZEPHYR_MAX_TOTAL_MS or narrow the suite; nothing was retried.',
      );
    }
    return { published, failures, unattempted };
  }

  /**
   * Checks the status names this run will send against the ones the project actually defines. It
   * only warns — a mismatch is the single most likely misconfiguration, and finding out once up
   * front beats reading the same 400 once per test. A partial page is not evidence of anything, so
   * an incomplete listing warns about nothing at all rather than accusing a valid status.
   */
  private async warnOnUnknownStatuses(
    client: ZephyrClient,
    settings: ZephyrSettings,
    targets: readonly ZephyrTarget[],
  ): Promise<void> {
    const wanted = [
      ...new Set(targets.map((target) => statusNameFor(target.test.status, settings))),
    ].filter((name): name is string => name !== undefined);

    try {
      const page = await client.listExecutionStatuses(settings.projectKey);
      if (page.names.length === 0 || !page.complete) return;

      for (const name of wanted.filter((candidate) => !page.names.includes(candidate))) {
        const nearMiss = page.names.find(
          (candidate) => candidate.toLowerCase() === name.toLowerCase(),
        );
        this.log.warn(
          `status "${name}" is not configured in ${settings.projectKey}` +
            (nearMiss === undefined
              ? ` — the project accepts: ${page.names.join(', ')}`
              : ` — did you mean "${nearMiss}"? Names are matched exactly`) +
            '. Override with ZEPHYR_STATUS_*; executions using an unknown status are rejected.',
        );
      }
    } catch (error) {
      this.log.warn(
        `could not read the project's execution statuses (${describeError(error)}); ` +
          'publishing with the configured names',
      );
    }
  }

  /** Says what was found instead of publishing, so an empty run is explained rather than silent. */
  private nothingToPublishDetail(
    model: ExtentReportModel,
    settings: ZephyrSettings,
    scan: TargetScan,
  ): string {
    return [
      `No test carries a ${settings.projectKey} test-case key ` +
        `(tag a test @${settings.projectKey}-T123); ${model.tests.length} test(s) scanned`,
      ...this.skipNotes(scan),
    ].join('; ');
  }

  private skipNotes(scan: TargetScan): readonly string[] {
    return [
      scan.withoutKey > 0
        ? `${scan.withoutKey} test(s) skipped for carrying no Zephyr test-case key`
        : undefined,
      scan.issueKeyOnly > 0
        ? `${scan.issueKeyOnly} of those carried a Jira issue key instead of a -T test-case key`
        : undefined,
      scan.foreignOnly > 0
        ? `${scan.foreignOnly} test(s) skipped for naming only another project's test case`
        : undefined,
      scan.foreignKeys > 0
        ? `${scan.foreignKeys} key(s) ignored as belonging to another project`
        : undefined,
    ].filter((note): note is string => note !== undefined);
  }

  private finish(status: IntegrationStatus, detail: string, startedAt: number): IntegrationResult {
    /* Masked on the way out: this string is rendered into the HTML report, and a token that ever
       reached an error message must not survive the trip. */
    return {
      name: this.name,
      status,
      detail: maskString(detail),
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * The mapped status, or `undefined` for a status the model should not contain. The type says this
 * cannot happen; a report model that crossed a file or a version boundary is how it happens anyway,
 * and a missing entry would otherwise surface as an unreadable `undefined.trim()` deep in the
 * client. Nothing is substituted — inventing a result is worse than reporting the gap.
 */
function statusNameFor(status: ExtentStatus, settings: ZephyrSettings): string | undefined {
  const name: string | undefined = settings.statusNames[status];
  return typeof name === 'string' && name.trim().length > 0 ? name : undefined;
}

function toExecutionInput(
  target: ZephyrTarget,
  settings: ZephyrSettings,
  cycleKey: string,
): ZephyrTestExecutionInput {
  const { test } = target;
  const statusName = statusNameFor(test.status, settings);
  if (statusName === undefined) {
    throw new Error(
      `no Zephyr status is mapped for result "${test.status}" — set ZEPHYR_STATUS_* for it`,
    );
  }
  return {
    projectKey: settings.projectKey,
    testCaseKey: target.testCaseKey,
    testCycleKey: cycleKey,
    statusName,
    environmentName: settings.environmentName,
    executionTime: test.durationMs,
    actualEndDate: toZephyrDateTime(test.finishedAt),
    comment: executionComment(test),
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'unknown error';
}
