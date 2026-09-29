/**
 * ZephyrClient — the Zephyr Scale Cloud v2 calls a finished run needs, and nothing more.
 *
 * This targets Zephyr **Scale** (formerly TM4J), not Zephyr Squad. Squad is a different product on
 * a different host that HMAC-signs a fresh JWT per request, so a static bearer token and every
 * payload below are meaningless there — a Squad tenant needs a rewrite, not a reconfiguration.
 *
 * Three design choices are worth explaining.
 *
 * *One cycle, then one execution per test* rather than a JUnit XML upload: only this path carries a
 * per-test comment, the real execution time and an environment label, and only this path lets
 * shards and re-runs land in a cycle we named. The bulk endpoint mints a brand-new cycle on every
 * upload and derives status from the XML instead of from our mapping.
 *
 * *No retries.* `POST /testexecutions` is not idempotent: it appends a row every time it is called,
 * so a retry after a timeout silently doubles a result and corrupts the project's pass rate for
 * weeks. A lost execution is reported loudly; a duplicated one is never noticed.
 *
 * *The token exists in exactly one place.* It is read into a private field and written into an
 * `Authorization` header — never into a URL, a message, a thrown error or a log line. Error text
 * quotes the method and path only, and any response body it quotes is masked first.
 */

import { maskString } from '../../utils/DataMasker';

/* ----------------------------------------------------------------- hosts -- */

/**
 * Zephyr Scale Cloud is data-resident and the token is bound to its region, so a US token answers
 * 401 against the EU host and vice versa. The base URL is therefore configuration, never a
 * constant.
 *
 * Only the two hosts SmartBear documents are named here. Other data-residency regions are set
 * verbatim through `ZEPHYR_BASE_URL` rather than guessed at in code: a hostname invented from a
 * pattern looks authoritative and fails as an unresolvable DNS name months later.
 */
export const ZEPHYR_REGION_BASE_URLS = {
  us: 'https://api.zephyrscale.smartbear.com/v2',
  eu: 'https://eu.api.zephyrscale.smartbear.com/v2',
} as const;

export const ZEPHYR_DEFAULT_BASE_URL: string = ZEPHYR_REGION_BASE_URLS.us;

/** Long enough for a cold serverless hop, short enough that a hung host cannot stall the run. */
const DEFAULT_TIMEOUT_MS = 15_000;

/* -------------------------------------------------------------- contract -- */

/** Server-side regex for `projectKey`: uppercase and at least **two** characters. */
export const ZEPHYR_PROJECT_KEY_PATTERN = /^[A-Z][A-Z_0-9]+$/;

/** Server-side regex for `testCycleKey`, e.g. `QA-R42`. */
export const ZEPHYR_TEST_CYCLE_KEY_PATTERN = /^[A-Z][A-Z_0-9]+-R\d+$/;

/**
 * `testCaseKey`, e.g. `QA-T123`. Kept as loose as the spec's own `.+-T\d+`, minus whitespace: a key
 * is echoed into an error message, and a value carrying newlines turns one failure line into a
 * paragraph of forged log output.
 */
export const ZEPHYR_TEST_CASE_KEY_PATTERN = /^\S+-T\d+$/;

/** `statusName` and the cycle `name` are both `1..255` characters server-side. */
const NAME_MAX_LENGTH = 255;

/** How much of a failure body is worth quoting back; the rest is stack noise. */
const ERROR_BODY_LIMIT = 300;

/** `GET /statuses` pages at 1000; a project with more execution statuses than that is fiction. */
const STATUS_PAGE_SIZE = 1000;

export interface ZephyrClientOptions {
  /** Zephyr Scale API token. Sent only as an `Authorization` header — never in a URL or a log. */
  readonly token: string;
  /** Region host including the `/v2` suffix; defaults to the US host. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

/** `POST /testexecutions` answers with an id and a self link — notably **no** key. */
export interface ZephyrCreatedResource {
  readonly id: number;
  readonly self: string;
}

/** `POST /testcycles` additionally answers with the `<PROJECT>-R<n>` key executions publish into. */
export interface ZephyrKeyedCreatedResource extends ZephyrCreatedResource {
  readonly key: string;
}

export interface ZephyrTestCycleInput {
  readonly projectKey: string;
  /** 1–255 characters and not blank; the API rejects a whitespace-only name. */
  readonly name: string;
  readonly description?: string;
  readonly plannedStartDate?: string;
  readonly plannedEndDate?: string;
  /** A TEST_CYCLE status — a different, separately configured set from execution statuses. */
  readonly statusName?: string;
  readonly folderId?: number;
  readonly jiraProjectVersion?: number;
  /** Atlassian account id, not a username. */
  readonly ownerId?: string;
  readonly customFields?: Readonly<Record<string, unknown>>;
}

export interface ZephyrTestScriptResult {
  readonly statusName: string;
  readonly actualEndDate?: string;
  readonly actualResult?: string;
}

export interface ZephyrTestExecutionInput {
  readonly projectKey: string;
  /** Must already exist: this endpoint cannot create a test case, it answers 404 instead. */
  readonly testCaseKey: string;
  readonly testCycleKey: string;
  /** Free-form and per-project configurable — see {@link ZephyrClient.listExecutionStatuses}. */
  readonly statusName: string;
  /** Must already exist in the project; an unknown environment is rejected, not created. */
  readonly environmentName?: string;
  /** Milliseconds. Playwright's own duration is already in this unit. */
  readonly executionTime?: number;
  /** `yyyy-MM-ddTHH:mm:ssZ` — see {@link toZephyrDateTime}. */
  readonly actualEndDate?: string;
  readonly comment?: string;
  readonly executedById?: string;
  readonly assignedToId?: string;
  readonly testScriptResults?: readonly ZephyrTestScriptResult[];
  /** Pass-through: a project that defines required execution custom fields 400s without them. */
  readonly customFields?: Readonly<Record<string, unknown>>;
}

export interface ZephyrExecutionStatus {
  readonly id: number;
  readonly name: string;
  /** Archived statuses are read-only and cannot be assigned to a new execution. */
  readonly archived: boolean;
}

/**
 * One page of execution statuses. `complete` matters more than it looks: a caller that warns
 * "this status is not configured" off a partial page is simply wrong, so the page says whether it
 * saw everything instead of letting the caller assume it did.
 */
export interface ZephyrExecutionStatusPage {
  readonly names: readonly string[];
  readonly complete: boolean;
}

/**
 * A Zephyr call that did not succeed. `status` is `0` when the request never reached the API —
 * a configuration or validation failure, a timeout or an unreachable host — so a caller can tell
 * "we sent something bad" from "they answered something bad" without parsing the message.
 */
export class ZephyrApiError extends Error {
  public readonly status: number;
  public readonly endpoint: string;

  constructor(message: string, endpoint: string, status: number, cause?: unknown) {
    super(`${endpoint}: ${message}`, cause instanceof Error ? { cause } : undefined);
    this.name = 'ZephyrApiError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

/* ------------------------------------------------------------- utilities -- */

/** Truncation that admits it happened, so a clipped body never reads as the whole answer. */
function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

/**
 * Formats a date the way the API documents it: `yyyy-MM-ddTHH:mm:ssZ`, with **no** fractional
 * seconds. `Date.toISOString()` emits `.sssZ`, which the documented format does not include, so the
 * milliseconds are stripped rather than gambled on. Returns `undefined` for an unparseable input so
 * a bad timestamp drops one optional field instead of failing the whole execution.
 */
export function toZephyrDateTime(value: Date | string): string | undefined {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * What each status code actually means here, which is not always what it means elsewhere. The 403
 * line is the important one: Zephyr answers 403 for a mistyped path (`/testexecution` singular) and
 * for an invalid key as well as for a genuine permission gap, so reporting it as "forbidden" alone
 * sends people to their Jira administrator for a typo.
 */
const HTTP_HINTS: Readonly<Record<number, string>> = {
  400: 'payload rejected — an unknown status or environment name reads as "... does not exist"',
  401: 'token missing or unverifiable — check ZEPHYR_API_TOKEN and that it was issued for this region',
  403: 'Zephyr returns 403 for an invalid token and for a wrong path as well as for a caller without EXECUTE_TEST_RUN',
  404: 'project, cycle or test case not found — this endpoint never creates a test case',
  429: 'rate limited — nothing here retries, because re-posting an execution appends a second result',
  500: 'Zephyr Scale reported a server error',
  503: 'Zephyr Scale is unavailable or throttling; the run is reported as unpublished rather than retried',
};

function describeHttpFailure(status: number, body: string): string {
  const snippet = clamp(maskString(body.replace(/\s+/g, ' ').trim()), ERROR_BODY_LIMIT);
  const hint = HTTP_HINTS[status];
  return [`HTTP ${status}`, hint, snippet].filter((part) => (part ?? '').length > 0).join(' — ');
}

function asRecord(payload: unknown, endpoint: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ZephyrApiError('response body was not a JSON object', endpoint, 0);
  }
  return payload as Record<string, unknown>;
}

function asCreatedResource(
  record: Record<string, unknown>,
  endpoint: string,
): ZephyrCreatedResource {
  const id = record['id'];
  const self = record['self'];
  if (typeof id !== 'number') {
    throw new ZephyrApiError('response carried no numeric id', endpoint, 0);
  }
  /* `self` is documented as always present; an empty string is preferable to rejecting a
     successful write over a cosmetic field. */
  return { id, self: typeof self === 'string' ? self : '' };
}

/**
 * Trims to the server's 1–255 window, and rejects a blank value the API would 400 on anyway. The
 * ellipsis is deliberate: a cycle silently renamed to its first 255 characters is a name nobody
 * can search for, whereas one ending in `...` explains itself.
 */
function requireName(value: string, field: string, endpoint: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ZephyrApiError(`${field} must not be blank`, endpoint, 0);
  }
  return clamp(trimmed, NAME_MAX_LENGTH);
}

function requireMatch(value: string, pattern: RegExp, field: string, endpoint: string): string {
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) {
    throw new ZephyrApiError(
      `${field} "${clamp(trimmed, 60)}" does not match ${pattern.source}`,
      endpoint,
      0,
    );
  }
  return trimmed;
}

/**
 * Rejects a base URL that cannot carry a bearer token safely.
 *
 * `ZEPHYR_BASE_URL` is operator input, and two ways of getting it wrong are worth their own
 * message: a typo otherwise surfaces as a bare `TypeError: Invalid URL` thrown from inside the
 * first request, and a plain-`http` host would put `Authorization: Bearer …` on the wire in clear
 * text. Loopback keeps a local mock usable. Neither the URL nor the token is echoed back — the
 * variable name is the actionable part, and the URL is untrusted text that may itself hold a
 * pasted credential.
 */
function normaliseBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ZephyrApiError(
      'ZEPHYR_BASE_URL is not a valid absolute base URL',
      'configuration',
      0,
    );
  }

  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new ZephyrApiError(
      'ZEPHYR_BASE_URL must be an https base URL — plain http would send the API token in clear text',
      'configuration',
      0,
    );
  }
  /* Query and fragment are dropped rather than carried onto every request: they are not part of a
     base URL, and a credential pasted into one would otherwise ride along in each URL. */
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/* ---------------------------------------------------------------- client -- */

export class ZephyrClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /** Throws {@link ZephyrApiError} for an unusable base URL, before any credential is in play. */
  constructor(options: ZephyrClientOptions) {
    this.token = options.token;
    this.baseUrl = normaliseBaseUrl(options.baseUrl ?? ZEPHYR_DEFAULT_BASE_URL);
    this.timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.round(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
  }

  /**
   * Creates the run's test cycle and returns its `<PROJECT>-R<n>` key. This is the only call that
   * hands back a key, so it is what every execution in the run is then attached to.
   */
  public async createTestCycle(input: ZephyrTestCycleInput): Promise<ZephyrKeyedCreatedResource> {
    const endpoint = 'POST /testcycles';
    const body: Record<string, unknown> = {
      projectKey: requireMatch(
        input.projectKey,
        ZEPHYR_PROJECT_KEY_PATTERN,
        'projectKey',
        endpoint,
      ),
      name: requireName(input.name, 'name', endpoint),
      description: input.description,
      plannedStartDate: input.plannedStartDate,
      plannedEndDate: input.plannedEndDate,
      statusName: input.statusName,
      folderId: input.folderId,
      jiraProjectVersion: input.jiraProjectVersion,
      ownerId: input.ownerId,
      customFields: input.customFields,
    };

    const record = asRecord(
      await this.send('POST', '/testcycles', undefined, body, endpoint),
      endpoint,
    );
    const created = asCreatedResource(record, endpoint);
    const key = record['key'];
    if (typeof key !== 'string' || key.trim().length === 0) {
      /* Without the key there is nothing to publish executions into, so this is fatal for the run
         rather than a field we can shrug off. */
      throw new ZephyrApiError('cycle was created but the response carried no key', endpoint, 0);
    }
    return { ...created, key: key.trim() };
  }

  /**
   * Records one test's outcome. Note the response deliberately has no key: there is no way to link
   * back to the created execution without a follow-up query, so callers must not promise one.
   */
  public async createTestExecution(
    input: ZephyrTestExecutionInput,
  ): Promise<ZephyrCreatedResource> {
    const endpoint = 'POST /testexecutions';
    const body: Record<string, unknown> = {
      projectKey: requireMatch(
        input.projectKey,
        ZEPHYR_PROJECT_KEY_PATTERN,
        'projectKey',
        endpoint,
      ),
      testCaseKey: requireMatch(
        input.testCaseKey,
        ZEPHYR_TEST_CASE_KEY_PATTERN,
        'testCaseKey',
        endpoint,
      ),
      testCycleKey: requireMatch(
        input.testCycleKey,
        ZEPHYR_TEST_CYCLE_KEY_PATTERN,
        'testCycleKey',
        endpoint,
      ),
      statusName: requireName(input.statusName, 'statusName', endpoint),
      environmentName: input.environmentName,
      /* int64, minimum 0: a negative or fractional duration is normalised rather than sent and
         rejected, since the run's outcome matters more than a millisecond of timing. */
      executionTime:
        input.executionTime === undefined || !Number.isFinite(input.executionTime)
          ? undefined
          : Math.max(0, Math.round(input.executionTime)),
      actualEndDate: input.actualEndDate,
      comment: input.comment,
      executedById: input.executedById,
      assignedToId: input.assignedToId,
      testScriptResults: input.testScriptResults,
      customFields: input.customFields,
    };

    return asCreatedResource(
      asRecord(await this.send('POST', '/testexecutions', undefined, body, endpoint), endpoint),
      endpoint,
    );
  }

  /**
   * The status names this project will actually accept for an execution. `statusName` is free-form
   * and per-project configurable — there is no enum in the API — so this is the only authoritative
   * way to check a mapping before a run sends the same wrong string a thousand times.
   *
   * Archived statuses are filtered out: they still exist, but they cannot be assigned. Only the
   * first page is read, and `complete` reports whether that was all of them; nothing here pages,
   * because a project with more than {@link STATUS_PAGE_SIZE} execution statuses does not exist.
   */
  public async listExecutionStatuses(projectKey: string): Promise<ZephyrExecutionStatusPage> {
    const endpoint = 'GET /statuses';
    const payload = await this.send(
      'GET',
      '/statuses',
      {
        projectKey: requireMatch(projectKey, ZEPHYR_PROJECT_KEY_PATTERN, 'projectKey', endpoint),
        statusType: 'TEST_EXECUTION',
        maxResults: String(STATUS_PAGE_SIZE),
      },
      undefined,
      endpoint,
    );

    const record = asRecord(payload, endpoint);
    const values = record['values'];
    if (!Array.isArray(values)) return { names: [], complete: false };

    const names = values
      .map((value): ZephyrExecutionStatus | undefined => {
        if (typeof value !== 'object' || value === null) return undefined;
        const status = value as Record<string, unknown>;
        const name = status['name'];
        if (typeof name !== 'string') return undefined;
        return {
          id: typeof status['id'] === 'number' ? status['id'] : 0,
          name,
          archived: status['archived'] === true,
        };
      })
      .filter((status): status is ZephyrExecutionStatus => status !== undefined && !status.archived)
      .map((status) => status.name);

    /* `isLast` is the documented signal; the total is the fallback for a payload that omits it. */
    const isLast = record['isLast'];
    const total = record['total'];
    const complete = isLast === true || (typeof total === 'number' && total <= values.length);

    return { names, complete };
  }

  /**
   * The one place a request leaves the process. Every call carries an `AbortSignal.timeout` that
   * covers the response body as well as the headers, so an unresponsive host costs the run a
   * bounded number of seconds instead of hanging the reporter. Every failure — transport, body
   * read or JSON parse — leaves as a {@link ZephyrApiError}, so a caller has exactly one error
   * shape to reason about.
   */
  private async send(
    method: 'GET' | 'POST',
    path: string,
    query: Readonly<Record<string, string>> | undefined,
    body: unknown,
    endpoint: string,
  ): Promise<unknown> {
    /* Safe by construction: the base URL was validated in the constructor and every path here is
       a literal, so this cannot throw on operator input. */
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    let status = 0;
    let ok = false;
    let text: string;
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        /* JSON.stringify drops `undefined` properties, which is exactly the desired behaviour for
           the many optional fields above: absent rather than explicitly null. */
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = response.status;
      ok = response.ok;
      /* Inside the try on purpose: the timeout also aborts a stalled body, and that rejection is
         thrown by `text()`, not by `fetch`. */
      text = await response.text();
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ZephyrApiError(
        timedOut
          ? `no complete response within ${this.timeoutMs}ms`
          : 'the host was unreachable or the connection failed',
        endpoint,
        0,
        error,
      );
    }

    if (!ok) throw new ZephyrApiError(describeHttpFailure(status, text), endpoint, status);
    if (text.trim().length === 0) return undefined;

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ZephyrApiError('response was not valid JSON', endpoint, status, error);
    }
  }
}
