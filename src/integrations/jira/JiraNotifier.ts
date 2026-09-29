/**
 * JiraNotifier — writes a finished run back to the tickets that asked for it.
 *
 * The design constraint that shapes everything here is that a ticket is read by people. A comment
 * per failing test turns a five-failure regression into five notifications on the same issue, so
 * failures are grouped: each referenced issue receives exactly ONE comment covering every failure
 * that named it, and the failures that named nothing collapse into at most one Bug.
 *
 * Three guarantees hold, in line with the integration contract:
 *
 *  - **Off by default.** `isEnabled()` requires JIRA_ENABLED *and* every credential, so a fork or
 *    a CI job without secrets makes no network call at all.
 *  - **Never fails the run.** `publish()` is wrapped end to end; every path returns an
 *    {@link IntegrationResult} and nothing rejects.
 *  - **Bounded.** A call cap and a wall-clock deadline together bound the work, and whenever
 *    either one cuts the report short the detail says so instead of quietly dropping issues.
 */

import type {
  Integration,
  IntegrationContext,
  IntegrationResult,
  IntegrationStatus,
} from '../IntegrationTypes';
import { issueKeysFor } from '../IntegrationTypes';
import type { ExtentStatus, ExtentTest } from '../../reporting/ExtentTypes';
import { adfDocument, JiraApiError, JiraClient } from './JiraClient';

/** Without all four, no call can be made; the token alone is not enough to address an issue. */
const REQUIRED_VARS = [
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT_KEY',
] as const;

/**
 * Issue type names are per-site and per-project — a team-managed project may have no type called
 * "Bug" at all, and a wrong name is a 400 — so this is only the default, not an assumption.
 */
const DEFAULT_ISSUE_TYPE = 'Bug';

/** Covers a normal regression without letting a catastrophic run write hundreds of comments. */
const DEFAULT_MAX_CALLS = 20;

/** Ceiling on JIRA_MAX_COMMENTS: past this, a misconfigured run spams a project either way. */
const MAX_MAX_CALLS = 200;

/** The per-call socket deadline handed to the client; the wall clock below can only shorten it. */
const PER_CALL_TIMEOUT_MS = 15_000;

/**
 * Wall-clock ceiling for the whole publish, credential preflight included. The per-call timeout
 * bounds one hung request; this bounds a Jira instance that is merely slow, so reporting can never
 * become the longest part of a CI job.
 */
const MAX_TOTAL_MS = 60_000;

/** Below this much remaining budget a call is not worth starting; it would only abort mid-write. */
const MIN_CALL_MS = 2_000;

/**
 * How many failure lines one body carries. Jira rejects a body past 32,767 characters outright,
 * and long before that a wall of failures stops being something a human reads on a ticket. The
 * remainder is counted in the comment, never dropped in silence.
 */
const MAX_FAILURE_LINES = 25;

/** How many issue keys / call failures the one-line `detail` enumerates before summarising. */
const MAX_LISTED = 8;

/** Why the report stopped short — reported rather than silently dropping the remaining issues. */
type TruncationCause = 'cap' | 'time' | undefined;

/**
 * FLAKY is excluded on purpose: it passed on retry, and reopening a conversation on a ticket for a
 * test that ultimately went green is noise. INTERRUPTED means the run was cut short, which is a
 * fact about the runner rather than about the code under test.
 */
const FAILING_STATUSES: ReadonlySet<ExtentStatus> = new Set<ExtentStatus>(['FAIL', 'TIMEOUT']);

const truthy = (value: string | undefined): boolean =>
  ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;

const formatDuration = (ms: number): string =>
  ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` : `${(ms / 1_000).toFixed(1)}s`;

const describe = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' && error.trim() !== '' ? error : 'unknown failure';
};

/**
 * The first meaningful line of the assertion. The reporter has already stripped ANSI and masked
 * secrets, so this only has to pick a line and keep it short enough to read inside a ticket.
 */
const firstErrorLine = (test: ExtentTest): string => {
  const line = (test.errorMessage ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? 'no error message captured' : clamp(line, 220);
};

const failureLine = (test: ExtentTest): string =>
  `FAILED ${test.name} [${test.project}] — ${firstErrorLine(test)} (${formatDuration(test.durationMs)})`;

/** The failure lines a body carries, with any remainder named rather than dropped. */
const failureLines = (tests: readonly ExtentTest[]): string[] => {
  const shown = tests.slice(0, MAX_FAILURE_LINES).map(failureLine);
  const hidden = tests.length - shown.length;
  return hidden > 0
    ? [...shown, `... and ${hidden} further failing test(s), all listed in the full report.`]
    : shown;
};

const runTotals = (context: IntegrationContext): string => {
  const { summary } = context.model;
  return `Run totals: ${summary.failed} failed, ${summary.passed} passed of ${summary.total} (${summary.passRate}% pass) in ${formatDuration(summary.durationMs)}.`;
};

/** One comment body per issue, however many of its tests failed. */
const commentLines = (
  issueKey: string,
  tests: readonly ExtentTest[],
  context: IntegrationContext,
): string[] => [
  `Automated Playwright run on ${context.model.environment.displayName} recorded ${tests.length} failing test(s) referencing ${issueKey}.`,
  ...failureLines(tests),
  runTotals(context),
  context.reportUrl === undefined ? '' : `Full report: ${context.reportUrl}`,
];

const bugLines = (tests: readonly ExtentTest[], context: IntegrationContext): string[] => [
  `${tests.length} Playwright test(s) failed on ${context.model.environment.displayName} without referencing an existing issue.`,
  ...failureLines(tests),
  runTotals(context),
  `Environment: ${context.model.environment.name} | UI ${context.model.environment.uiBaseUrl} | API ${context.model.environment.apiBaseUrl}`,
  context.reportUrl === undefined ? '' : `Full report: ${context.reportUrl}`,
];

interface JiraSettings {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly projectKey: string;
  readonly issueType: string;
  readonly cloudId?: string;
  readonly createIssueOnFailure: boolean;
  readonly maxCalls: number;
  /** Project prefixes this reporter is allowed to write to; empty means "any key it finds". */
  readonly issueKeyPrefixes: readonly string[];
}

/** What `report()` decided, before the caller-facing timing is attached. */
interface JiraOutcome {
  readonly status: IntegrationStatus;
  readonly detail: string;
  readonly url?: string;
}

export class JiraNotifier implements Integration {
  public readonly name = 'Jira';

  private readonly env: NodeJS.ProcessEnv;

  /** The environment is injected rather than read globally so a test can drive this class. */
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  public isEnabled(): boolean {
    return truthy(this.env.JIRA_ENABLED) && this.missingVars().length === 0;
  }

  public disabledReason(): string {
    const missing = this.missingVars();
    if (missing.length > 0) {
      return `Jira reporting is off: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`;
    }
    if (!truthy(this.env.JIRA_ENABLED)) {
      return 'Jira reporting is off: credentials are present but JIRA_ENABLED is not set to true.';
    }
    return 'Jira reporting is enabled.';
  }

  public async publish(context: IntegrationContext): Promise<IntegrationResult> {
    const started = Date.now();

    /*
     * One try around everything, not just around the network work. The contract is that publish
     * never rejects, and reading configuration is code too: an exotic `env` object or a model
     * missing a field must still come back as a `failed` result rather than as an unhandled
     * rejection attributed to the suite that just went green.
     */
    let outcome: JiraOutcome;
    try {
      const settings = this.settings();
      outcome =
        settings === undefined
          ? { status: 'skipped', detail: this.disabledReason() }
          : await report(settings, context);
    } catch (error) {
      outcome = { status: 'failed', detail: `Jira reporting failed: ${describe(error)}` };
    }

    return {
      name: this.name,
      status: outcome.status,
      detail: outcome.detail,
      ...(outcome.url === undefined ? {} : { url: outcome.url }),
      durationMs: Date.now() - started,
    };
  }

  private missingVars(): string[] {
    return REQUIRED_VARS.filter((name) => (this.env[name] ?? '').trim() === '');
  }

  /** Resolved configuration, or `undefined` when the integration is not fully configured. */
  private settings(): JiraSettings | undefined {
    if (!this.isEnabled()) return undefined;

    const read = (name: string): string => (this.env[name] ?? '').trim();
    const cloudId = read('JIRA_CLOUD_ID');
    const issueType = read('JIRA_ISSUE_TYPE');

    return {
      baseUrl: read('JIRA_BASE_URL'),
      email: read('JIRA_EMAIL'),
      apiToken: read('JIRA_API_TOKEN'),
      projectKey: read('JIRA_PROJECT_KEY').toUpperCase(),
      issueType: issueType === '' ? DEFAULT_ISSUE_TYPE : issueType,
      ...(cloudId === '' ? {} : { cloudId }),
      createIssueOnFailure: truthy(this.env.JIRA_CREATE_ISSUE_ON_FAILURE),
      maxCalls: Math.min(
        MAX_MAX_CALLS,
        Math.max(1, int(this.env.JIRA_MAX_COMMENTS, DEFAULT_MAX_CALLS)),
      ),
      issueKeyPrefixes: read('JIRA_ISSUE_KEY_PREFIXES')
        .split(',')
        .map((prefix) => prefix.trim().toUpperCase())
        .filter((prefix) => prefix !== ''),
    };
  }
}

/**
 * ISSUE_KEY_PATTERN is deliberately broad, so a browser-version tag like `@CHROME-131` or a stray
 * `TODO-4` in an annotation reads as an issue key — and this integration *writes*, so a false
 * positive posts a comment on a stranger's ticket. JIRA_ISSUE_KEY_PREFIXES narrows the match to
 * the projects a team actually files against. Unset, behaviour is unchanged and every key counts.
 */
const isAddressable = (key: string, prefixes: readonly string[]): boolean =>
  prefixes.length === 0 || prefixes.includes(key.slice(0, key.lastIndexOf('-')).toUpperCase());

interface GroupedFailures {
  /** Failures keyed by every issue their tags or annotations name. */
  readonly byIssue: Map<string, ExtentTest[]>;
  /** Failures that named no addressable issue — the candidates for a new Bug. */
  readonly unlinked: ExtentTest[];
}

/** Groups the run's failures by the issue keys their tags and annotations reference. */
function groupFailures(tests: readonly ExtentTest[], prefixes: readonly string[]): GroupedFailures {
  const byIssue = new Map<string, ExtentTest[]>();
  const unlinked: ExtentTest[] = [];

  for (const test of tests) {
    const keys = issueKeysFor(test.tags, test.annotations).filter((key) =>
      isAddressable(key, prefixes),
    );
    if (keys.length === 0) {
      unlinked.push(test);
      continue;
    }
    /* A test may name several issues; each of them hears about it exactly once. */
    for (const key of keys) {
      const bucket = byIssue.get(key);
      if (bucket === undefined) byIssue.set(key, [test]);
      else bucket.push(test);
    }
  }

  return { byIssue, unlinked };
}

async function report(settings: JiraSettings, context: IntegrationContext): Promise<JiraOutcome> {
  /*
   * The clock starts before the preflight, not after it. A site that takes forty seconds to answer
   * /myself has already spent most of the budget, and a deadline that ignored the preflight would
   * let this reporter run for MAX_TOTAL_MS on top of however long the credential check took.
   */
  const deadline = Date.now() + MAX_TOTAL_MS;
  const remainingMs = (): number => deadline - Date.now();

  const failures = context.model.tests.filter((test) => FAILING_STATUSES.has(test.status));
  if (failures.length === 0) {
    return {
      status: 'skipped',
      detail: 'No failing tests in this run — nothing to report to Jira.',
    };
  }

  const { byIssue, unlinked } = groupFailures(failures, settings.issueKeyPrefixes);
  const client = new JiraClient({
    baseUrl: settings.baseUrl,
    email: settings.email,
    apiToken: settings.apiToken,
    ...(settings.cloudId === undefined ? {} : { cloudId: settings.cloudId }),
    timeoutMs: PER_CALL_TIMEOUT_MS,
  });

  /*
   * The cap counts every API call, and the credential check is the first of them. It earns its
   * slot: an expired token (they now expire within a year) otherwise shows up as a 404 from the
   * comment endpoint, which reads as "wrong issue key" and sends the reader hunting in the wrong
   * place.
   */
  let budget = settings.maxCalls - 1;
  try {
    await client.verifyCredentials(remainingMs());
  } catch (error) {
    /* Only a 401 is actually about the credentials; anything else is the network or the site. */
    const rejected = error instanceof JiraApiError && error.status === 401;
    return {
      status: 'failed',
      detail: rejected
        ? `Jira credentials were rejected: ${describe(error)}`
        : `Jira credential check failed: ${describe(error)}`,
    };
  }

  const commented: string[] = [];
  const callFailures: string[] = [];
  let uncommentedIssues = 0;
  let truncation: TruncationCause;

  /** Whether another call may start, and if not, which limit stopped it. */
  const stopReason = (): TruncationCause =>
    budget <= 0 ? 'cap' : remainingMs() < MIN_CALL_MS ? 'time' : undefined;

  /*
   * Sequential on purpose. Jira rate-limits writes per issue, and a burst of parallel comments is
   * the fastest way to earn a 429 on a reporter that has no business retrying non-idempotent
   * writes. Sequential also means slow calls add up, hence the wall-clock deadline alongside the
   * call cap: a per-call timeout alone still lets twenty sluggish writes hold CI for minutes after
   * the suite has finished.
   */
  for (const issueKey of [...byIssue.keys()].sort((a, b) => a.localeCompare(b))) {
    const tests = byIssue.get(issueKey) ?? [];
    const stop = stopReason();
    if (stop !== undefined) {
      truncation ??= stop;
      uncommentedIssues += 1;
      continue;
    }
    budget -= 1;
    try {
      await client.addComment(
        issueKey,
        adfDocument(commentLines(issueKey, tests, context)),
        remainingMs(),
      );
      commented.push(issueKey);
    } catch (error) {
      callFailures.push(`${issueKey}: ${describe(error)}`);
    }
  }

  let createdKey: string | undefined;
  let bugSkipped = false;

  if (unlinked.length > 0 && settings.createIssueOnFailure) {
    const stop = stopReason();
    if (stop !== undefined) {
      truncation ??= stop;
      bugSkipped = true;
    } else {
      budget -= 1;
      try {
        /*
         * One Bug for the whole run, and no dedupe against previous runs: Jira has no idempotency
         * key on create, and a search-then-create check races its own eventual consistency. Leave
         * this flag off for per-commit runs, or a recurring failure files a bug every build.
         */
        const issue = await client.createIssue(
          {
            project: { key: settings.projectKey },
            issuetype: { name: settings.issueType },
            summary: clamp(
              `Playwright: ${unlinked.length} unlinked failure(s) on ${context.model.environment.displayName} (${context.model.summary.finishedAt})`,
              240,
            ),
            description: adfDocument(bugLines(unlinked, context)),
            labels: ['playwright'],
          },
          remainingMs(),
        );
        createdKey = issue.key;
      } catch (error) {
        callFailures.push(
          `create ${settings.issueType} in ${settings.projectKey}: ${describe(error)}`,
        );
      }
    }
  }

  return summarise({
    settings,
    client,
    commented,
    callFailures,
    uncommentedIssues,
    createdKey,
    bugSkipped,
    truncation,
    unlinkedCount: unlinked.length,
  });
}

interface OutcomeInput {
  readonly settings: JiraSettings;
  readonly client: JiraClient;
  readonly commented: readonly string[];
  readonly callFailures: readonly string[];
  readonly uncommentedIssues: number;
  readonly createdKey: string | undefined;
  readonly bugSkipped: boolean;
  readonly truncation: TruncationCause;
  readonly unlinkedCount: number;
}

/** Renders a list into the one-line detail, saying how much of it is not shown. */
const listed = (entries: readonly string[], separator: string): string => {
  const shown = entries.slice(0, MAX_LISTED);
  const hidden = entries.length - shown.length;
  return hidden > 0
    ? `${shown.join(separator)}${separator}(+${hidden} more, not listed here)`
    : shown.join(separator);
};

/** Turns what happened into one line an engineer can act on, including what was left undone. */
function summarise(input: OutcomeInput): JiraOutcome {
  const parts: string[] = [];

  if (input.commented.length > 0) {
    parts.push(`commented on ${input.commented.length} issue(s): ${listed(input.commented, ', ')}`);
  }
  if (input.createdKey !== undefined) {
    parts.push(`created ${input.createdKey} for ${input.unlinkedCount} unlinked failure(s)`);
  }
  if (input.unlinkedCount > 0 && !input.settings.createIssueOnFailure) {
    parts.push(
      `${input.unlinkedCount} failure(s) referenced no issue and JIRA_CREATE_ISSUE_ON_FAILURE is off`,
    );
  }
  if (input.truncation !== undefined) {
    const left = [
      input.uncommentedIssues > 0 ? `${input.uncommentedIssues} issue(s) not commented` : undefined,
      input.bugSkipped ? 'no bug created' : undefined,
    ]
      .filter((entry) => entry !== undefined)
      .join(' and ');
    const cause =
      input.truncation === 'cap'
        ? `at the JIRA_MAX_COMMENTS cap of ${input.settings.maxCalls} API call(s)`
        : `after the ${formatDuration(MAX_TOTAL_MS)} Jira time budget`;
    parts.push(`truncated ${cause}: ${left}`);
  }
  if (input.callFailures.length > 0) {
    parts.push(
      `${input.callFailures.length} call(s) failed — ${listed(input.callFailures, ' | ')}`,
    );
  }

  const wrote = input.commented.length + (input.createdKey === undefined ? 0 : 1);
  const status: IntegrationStatus =
    wrote > 0 ? 'published' : input.callFailures.length > 0 ? 'failed' : 'skipped';

  const linkKey = input.createdKey ?? input.commented[0];
  const detail = parts.length > 0 ? `Jira ${parts.join('; ')}.` : 'Nothing to report to Jira.';

  return {
    status,
    detail,
    ...(linkKey === undefined ? {} : { url: input.client.browseUrl(linkKey) }),
  };
}
