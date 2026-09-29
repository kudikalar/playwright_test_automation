/**
 * SauceNotifier — points a finished report at the Sauce Labs jobs that produced it.
 *
 * This integration publishes nothing *to* Sauce. saucectl already stamps a job's name, build and
 * tags at submit time, and the REST annotate endpoint (`PUT /rest/v1/{username}/jobs/{id}`) exists
 * to correct that metadata afterwards — rewriting a finished job's record from a reporter would
 * mean the Sauce UI and the run's own report disagree about what happened. So the job here is the
 * opposite one: find this run's jobs and hand the report a link back to them.
 *
 * Attribution is the hard part. Sauce has no "current run" concept, and
 * `GET /rest/v1/{username}/jobs` returns that user's recent jobs whatever produced them — which on
 * the shared machine account CI usually authenticates as means every other pipeline's jobs too.
 * The only reliable key is the build name, which is why this notifier links jobs only when
 * `SAUCE_BUILD_NAME` was also passed to `saucectl run --build`. Without it the honest answer is
 * `skipped`; guessing "the newest few jobs" would put someone else's run in this report.
 *
 * Two properties of that endpoint shape the lookup below, and getting either wrong yields a
 * confident wrong answer rather than an error:
 *
 *  1. **`full=true` is mandatory.** The default response carries each job's `id` and nothing else
 *     — no `build`, no `passed`. A build filter over that payload matches zero jobs on every run,
 *     and the integration then reports "nothing ran on Sauce" for a run that did.
 *  2. **The result set is a window, not the truth.** `limit`/`skip` page newest-first over an
 *     unbounded history, so "not found" only ever means "not found in the jobs I looked at". Every
 *     message below states how far the search reached instead of promoting an empty window into a
 *     conclusion about the run.
 *
 * There is likewise no documented build page URL — the API returns no UI link and only
 * `<app host>/tests/{jobId}` is specified — so this links a job, never an invented dashboard URL.
 */

import type { Integration, IntegrationContext, IntegrationResult } from '../IntegrationTypes';

import {
  isSauceConfigured,
  readSauceCredentials,
  resolveSauceRegion,
  sauceApiBaseUrl,
  sauceBasicAuthHeader,
  sauceBuildName,
  sauceConfigurationProblem,
  sauceEndpoints,
  sauceJobPageUrl,
  type SauceCredentials,
  type SauceRegion,
} from './SauceConfig';

/** A hung Sauce endpoint must not hold the reporter open; every call carries this deadline. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Ceiling on the whole lookup, not on one request. Paging multiplies the per-request timeout, so
 * without a shared budget a slow-but-not-dead endpoint could still stall the reporter for a
 * minute. Each request gets whatever is left of this, capped at {@link REQUEST_TIMEOUT_MS}.
 */
const LOOKUP_BUDGET_MS = 30_000;

/** Jobs per request. Comfortably inside the endpoint's cap, so the page size is never negotiated. */
const JOB_PAGE_SIZE = 100;

/**
 * How far back to page. A run's jobs land within minutes of each other, so three pages cover a
 * sharded suite even on an account with concurrent pipelines — and the search reports its own
 * boundary rather than pretending the window was the whole history.
 */
const MAX_JOB_PAGES = 3;

/** The subset of the job object this integration relies on, mapped off the wire's snake_case. */
interface SauceJob {
  readonly id: string;
  readonly build?: string;
  /** Sauce's own verdict: true, false, or null while a job is still running. */
  readonly passed?: boolean;
  readonly creationTimeSec?: number;
}

interface SauceHttpResult {
  readonly status: number;
  readonly payload: unknown;
  /**
   * True when a 2xx body would not parse as JSON. The body itself is deliberately dropped: a proxy
   * or captive-portal page is not information a report should carry, and V8's parse error quotes
   * the first bytes of whatever came back.
   */
  readonly unreadable: boolean;
}

/** What one paged sweep of the jobs endpoint learned, including the edges of what it could see. */
interface JobSearch {
  readonly matches: readonly SauceJob[];
  /** Distinct jobs actually examined — the denominator behind every "no match" message. */
  readonly scanned: number;
  /** True when paging stopped before the account's history did, so "not found" is not "absent". */
  readonly windowExhausted: boolean;
  /** True when jobs came back but not one carried a `build` field — the missing-`full` symptom. */
  readonly buildFieldAbsent: boolean;
}

export class SauceNotifier implements Integration {
  public readonly name = 'Sauce Labs';

  public isEnabled(): boolean {
    return isSauceConfigured();
  }

  public disabledReason(): string {
    const problem = sauceConfigurationProblem();
    return problem === undefined
      ? 'Sauce Labs credentials are present.'
      : `Sauce Labs lookup is off: ${problem}.`;
  }

  public async publish(context: IntegrationContext): Promise<IntegrationResult> {
    const startedAt = Date.now();
    try {
      if (!this.isEnabled()) {
        return this.result('skipped', this.disabledReason(), startedAt);
      }

      const credentials = readSauceCredentials();
      const region = resolveSauceRegion();
      /* isEnabled() already proved both; the guard is here so neither is asserted away. */
      if (credentials === undefined || region === undefined) {
        return this.result('skipped', this.disabledReason(), startedAt);
      }

      const build = sauceBuildName();
      if (build === undefined) {
        return this.result(
          'skipped',
          'SAUCE_BUILD_NAME is not set, so this run cannot be told apart from other jobs on the ' +
            'account. Pass the same value to `saucectl run --build` to link the run.',
          startedAt,
        );
      }

      /* `await`, not a bare `return`: returning the promise would settle it outside this try and
         hand the caller a rejection, which is precisely what rule 2 of the contract forbids. */
      return await this.linkBuild(context, credentials, region, build, startedAt);
    } catch (error) {
      /* Rule 2 of the integration contract: a Sauce outage never turns a green suite red. */
      return this.result('failed', `Sauce lookup failed: ${describeError(error)}`, startedAt);
    }
  }

  /* ------------------------------------------------------------ internals -- */

  /**
   * Pages the jobs endpoint newest-first, collecting every job stamped with this build. Ids are
   * deduplicated across pages so a server that ignores `skip` degrades to one page instead of
   * counting the same jobs three times.
   */
  private async linkBuild(
    context: IntegrationContext,
    credentials: SauceCredentials,
    region: SauceRegion,
    build: string,
    startedAt: number,
  ): Promise<IntegrationResult> {
    const deadlineAt = Date.now() + LOOKUP_BUDGET_MS;
    const seenIds = new Set<string>();
    const matches: SauceJob[] = [];
    let jobsCarryingBuild = 0;
    let windowExhausted = false;

    for (let page = 0; page < MAX_JOB_PAGES; page += 1) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        windowExhausted = true;
        break;
      }

      const skip = page * JOB_PAGE_SIZE;
      const response = await this.getJobsPage(credentials, region, skip, remainingMs);
      const failure = this.describeHttpFailure(response, region, startedAt);
      if (failure !== undefined) return failure;

      const jobs = toJobs(response.payload);
      const fresh = jobs.filter((job) => !seenIds.has(job.id));
      for (const job of fresh) seenIds.add(job.id);
      jobsCarryingBuild += fresh.filter((job) => job.build !== undefined).length;
      const pageMatches = fresh.filter((job) => job.build === build);
      matches.push(...pageMatches);

      if (fresh.length === 0) {
        /* A full page that adds no new ids means `skip` never moved the cursor. Stop rather than
           re-read the same page, and admit the search never got past the first window. */
        windowExhausted = jobs.length >= JOB_PAGE_SIZE;
        break;
      }
      /* A short page is the end of this user's job list, so the search was exhaustive. */
      if (jobs.length < JOB_PAGE_SIZE) break;
      /* Newest first, and one build's jobs start within minutes of each other: a page beyond the
         first match that carries none means the build's window has already been passed. */
      if (matches.length > 0 && pageMatches.length === 0) break;
      if (page === MAX_JOB_PAGES - 1) windowExhausted = true;
    }

    return this.describeSearch(
      {
        matches,
        scanned: seenIds.size,
        windowExhausted,
        buildFieldAbsent: jobsCarryingBuild === 0,
      },
      context,
      region,
      build,
      startedAt,
    );
  }

  /** Turns a completed sweep into a result. Nothing here asserts more than the sweep observed. */
  private describeSearch(
    search: JobSearch,
    context: IntegrationContext,
    region: SauceRegion,
    build: string,
    startedAt: number,
  ): IntegrationResult {
    const reach = search.windowExhausted
      ? `the newest ${search.scanned} job(s) on the ${region} account (the search stopped there)`
      : `all ${search.scanned} job(s) on the ${region} account`;

    if (search.matches.length === 0) {
      return this.result(
        'skipped',
        this.describeEmptySearch(search, region, build, reach),
        startedAt,
      );
    }

    /* Newest first, so the linked job is the one a reader most likely wants to open. */
    const [newest] = [...search.matches].sort(
      (a, b) => (b.creationTimeSec ?? 0) - (a.creationTimeSec ?? 0),
    );
    const passed = search.matches.filter((job) => job.passed === true).length;
    const failed = search.matches.filter((job) => job.passed === false).length;
    const unresolved = search.matches.length - passed - failed;

    const counts = [`${passed} passed`, `${failed} failed`]
      .concat(unresolved > 0 ? [`${unresolved} still running or unreported`] : [])
      .join(', ');
    /* Sauce counts jobs (one per suite/shard), the report counts tests — never conflate them. */
    const scope =
      `${search.matches.length} Sauce job(s) carry build "${build}" (${counts}) across ${reach}; ` +
      `this report covers ${context.model.summary.total} tests` +
      (search.windowExhausted ? ', so the job count is a lower bound' : '');

    const url = newest === undefined ? undefined : sauceJobPageUrl(region, newest.id);
    if (url === undefined) {
      /* A result with no link has linked nothing, whatever it learned on the way — say `skipped`
         rather than dress the shortfall up as a publish. */
      const appHostMissing = sauceEndpoints(region).appBaseUrl === undefined;
      return this.result(
        'skipped',
        appHostMissing
          ? `${scope}. Sauce documents no UI host for ${region}, so no job link is emitted.`
          : `${scope}. No linkable job id was returned.`,
        startedAt,
      );
    }

    return this.result('published', `${scope}. Linked the newest job.`, startedAt, url);
  }

  /**
   * Why a sweep matched nothing. The three cases read very differently to an operator, and only
   * the last one is even weak evidence that the run never reached Sauce — so none of them says so.
   */
  private describeEmptySearch(
    search: JobSearch,
    region: SauceRegion,
    build: string,
    reach: string,
  ): string {
    if (search.scanned === 0) {
      return `The ${region} account reported no jobs at all, so there is nothing to link to build "${build}".`;
    }
    if (search.buildFieldAbsent) {
      return (
        `Sauce returned ${search.scanned} job(s), none carrying a build field, so build ` +
        `"${build}" could not be matched. Nothing linked.`
      );
    }
    return (
      `No job in ${reach} carries build "${build}". ` +
      (search.windowExhausted
        ? 'An older job with that build may exist beyond the search window.'
        : 'Nothing on the account matches this run.')
    );
  }

  /** The result for a non-200 or unreadable response, or undefined when the page is usable. */
  private describeHttpFailure(
    response: SauceHttpResult,
    region: SauceRegion,
    startedAt: number,
  ): IntegrationResult | undefined {
    if (response.status === 401 || response.status === 403) {
      return this.result(
        'failed',
        `Sauce rejected the credentials (HTTP ${response.status}). Access keys are per data ` +
          `centre — this one must belong to the ${region} account.`,
        startedAt,
      );
    }
    if (response.status === 429) {
      return this.result(
        'failed',
        'Sauce rate-limited the jobs lookup (HTTP 429). The reporter does not retry, because a ' +
          'retry storm at the end of a run is what earns the limit in the first place.',
        startedAt,
      );
    }
    if (response.status !== 200) {
      return this.result(
        'failed',
        `GET /rest/v1/{username}/jobs returned HTTP ${response.status}.`,
        startedAt,
      );
    }
    if (response.unreadable) {
      return this.result(
        'failed',
        'Sauce answered 200 with a body that is not JSON — usually a proxy or SSO interception ' +
          'page rather than the API. The body is not reproduced here.',
        startedAt,
      );
    }
    return undefined;
  }

  /**
   * One page of the jobs endpoint.
   *
   * `full=true` is not an optimisation: without it the response is a list of bare ids, the build
   * filter matches nothing and the run silently looks as though it never reached Sauce. Non-2xx
   * bodies are drained rather than parsed — an error page only stacks a confusing JSON error on
   * top of the real status, and an unread body holds its socket open.
   */
  private async getJobsPage(
    credentials: SauceCredentials,
    region: SauceRegion,
    skip: number,
    remainingMs: number,
  ): Promise<SauceHttpResult> {
    const query = `limit=${JOB_PAGE_SIZE}&skip=${skip}&full=true`;
    const url = `${sauceApiBaseUrl(region)}/rest/v1/${encodeURIComponent(
      credentials.username,
    )}/jobs?${query}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: sauceBasicAuthHeader(credentials),
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remainingMs))),
    });

    if (!response.ok) {
      await discardBody(response);
      return { status: response.status, payload: undefined, unreadable: false };
    }
    try {
      const payload: unknown = await response.json();
      return { status: response.status, payload, unreadable: false };
    } catch {
      return { status: response.status, payload: undefined, unreadable: true };
    }
  }

  private result(
    status: IntegrationResult['status'],
    detail: string,
    startedAt: number,
    url?: string,
  ): IntegrationResult {
    return { name: this.name, status, detail, url, durationMs: Date.now() - startedAt };
  }
}

/* -------------------------------------------------------------- wire parsing -- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Maps the jobs array defensively: a job without a usable id is unlinkable, and every other field
 * is optional because a queued job carries far less than a finished one.
 */
function toJobs(payload: unknown): SauceJob[] {
  if (!Array.isArray(payload)) return [];
  const jobs: SauceJob[] = [];
  for (const entry of payload as unknown[]) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const id = record['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    const build = record['build'];
    const passed = record['passed'];
    const creationTime = record['creation_time'];
    jobs.push({
      id,
      build: typeof build === 'string' ? build : undefined,
      passed: typeof passed === 'boolean' ? passed : undefined,
      creationTimeSec: typeof creationTime === 'number' ? creationTime : undefined,
    });
  }
  return jobs;
}

/** Releases an unparsed response so its socket is not held until the GC gets round to it. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* The stream is already gone — there is nothing left to release. */
  }
}

/**
 * undici surfaces an aborted fetch either as the signal's own `DOMException` or as a
 * `TypeError: fetch failed` wrapping it, so the cause chain is walked rather than the top error
 * alone. Anything deeper than a few links is a cycle or a foreign error shape, not a timeout.
 */
function isAbort(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const record = asRecord(current);
    if (record === undefined) return false;
    const name = record['name'];
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    current = record['cause'];
  }
  return false;
}

/**
 * Error text safe to put in a report. Only the message survives — a stack carries the account name
 * — and an aborted fetch says nothing useful by default, so it is named explicitly.
 */
function describeError(error: unknown): string {
  if (isAbort(error)) return `no response within ${REQUEST_TIMEOUT_MS / 1000}s`;
  if (!(error instanceof Error) || error.message.length === 0) return 'unknown error';
  return redactUsername(error.message);
}

/**
 * Strips the account name out of a message that quotes the request URL — a malformed endpoint or a
 * proxy rejection can do that even though this module never formats one itself.
 *
 * Only the path-segment shape is rewritten, never the raw credential value: a blanket replace
 * corrupts unrelated text whenever the account is named something short or ordinary, and an
 * account called `u` would turn every "undefined" in a message into nonsense.
 */
function redactUsername(message: string): string {
  return message.replace(/(\/rest\/v1\/)[^/\s]+/g, '$1<sauce-username>');
}
