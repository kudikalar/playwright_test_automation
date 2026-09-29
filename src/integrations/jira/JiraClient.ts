/**
 * JiraClient — the smallest useful slice of the Jira Cloud platform REST API v3: comment on an
 * issue, create an issue, and prove the credentials still work.
 *
 * v3 is not v2 with a bigger number, and two of its rules shape this whole file:
 *
 *  1. **Rich text must be Atlassian Document Format.** A plain string in a comment `body` or an
 *     issue `description` is a 400, which is the single most common way this integration breaks.
 *     {@link adfDocument} is therefore the only way a caller builds one. `summary` is the mirror
 *     image — it is a plain string and *rejects* ADF.
 *  2. **Writes are not idempotent and Jira offers no idempotency key.** Retrying a POST that timed
 *     out duplicates the comment or files the bug twice, so this client never retries a write. It
 *     reports the failure with enough detail to act on and lets the caller decide.
 *
 * Auth is Basic `base64(email:token)`. That blob is credential-equivalent to the token itself: it
 * is built per instance, held in a private field, and never logged, thrown or rendered. The site
 * URL gets the same suspicion — see {@link normaliseSiteUrl}, which exists because that value is
 * the one piece of this client's configuration that *is* published, as `IntegrationResult.url`.
 */

import { Buffer } from 'node:buffer';

/** Gateway host a *scoped* API token must use; a classic token talks to the tenant origin. */
const ATLASSIAN_GATEWAY = 'https://api.atlassian.com';

const API_PATH = '/rest/api/3';

/** Floor for a per-call deadline, so a caller passing a nearly-spent budget still gets a real try. */
const MIN_TIMEOUT_MS = 1_000;

/**
 * What each status actually means for *these* endpoints, which is not what a reader would guess:
 * add-comment masks a permission failure as 404, and a body Jira will not accept — wrong shape, or
 * simply too long — comes back as a 400 that names no field.
 *
 * The list is deliberately short. Every entry is behaviour Atlassian documents for the three
 * endpoints below; a plausible-sounding hint for a status nobody verified sends the reader
 * somewhere Jira never pointed, which is worse than showing the bare status code.
 */
const STATUS_HINTS: Readonly<Record<number, string>> = {
  400: 'malformed request — usually a non-ADF body, an over-long body, or a field missing from the create screen',
  401: 'credentials rejected — the token may have expired, or a scoped token needs JIRA_CLOUD_ID',
  403: 'authenticated but not permitted to perform this operation',
  404: 'issue not found, or not visible to this account (Jira reports both as 404 here)',
  429: 'rate limited — space the writes out rather than retrying immediately',
};

/* ------------------------------------------------------------------ ADF -- */

/** A paragraph longer than this stops being readable in a ticket well before Jira objects to it. */
const MAX_TEXT_NODE_CHARS = 800;

/**
 * Jira caps a comment body / issue description at 32,767 characters and rejects an over-long one
 * with a 400. Capping a single text node does *not* bound the document, so the whole thing is
 * budgeted here as well — with margin, because the ADF envelope is counted too.
 */
const MAX_DOCUMENT_CHARS = 28_000;

/** Shown when every line handed to {@link adfDocument} was blank — an empty text node is invalid ADF. */
const EMPTY_BODY_PLACEHOLDER = 'No detail was captured for this failure.';

export interface AdfText {
  readonly type: 'text';
  readonly text: string;
}

export interface AdfParagraph {
  readonly type: 'paragraph';
  readonly content: readonly AdfText[];
}

export interface AdfDocument {
  readonly type: 'doc';
  /** The literal number 1. A string `'1'` is a 400. */
  readonly version: 1;
  readonly content: readonly AdfParagraph[];
}

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;

const paragraph = (text: string): AdfParagraph => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

/**
 * Turns plain lines into one valid ADF document, one paragraph per line.
 *
 * Guards the three ways a generated document turns into a 400: an ADF text node may not be empty
 * (so blank lines are dropped, and an all-blank input still yields one real paragraph), a newline
 * inside a text node is not a line break in ADF (so whitespace is collapsed rather than smuggled
 * through), and the document as a whole must stay under Jira's character ceiling.
 *
 * Overflow is counted *inside the document*, never dropped quietly. A comment that silently lost
 * its last forty failures still reads as a complete report, which is exactly the kind of
 * confidently-wrong artifact this framework exists to avoid.
 */
export function adfDocument(lines: readonly string[]): AdfDocument {
  const cleaned = lines
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .map((line) => truncate(line, MAX_TEXT_NODE_CHARS));

  const kept: string[] = [];
  let remaining = MAX_DOCUMENT_CHARS;
  let omitted = 0;

  for (const line of cleaned) {
    /*
     * Once one line overflows, every later line goes with it. Skipping a long middle line and
     * keeping the tail would produce a body that reads as though nothing were missing.
     */
    if (omitted > 0 || line.length > remaining) {
      omitted += 1;
      continue;
    }
    remaining -= line.length;
    kept.push(line);
  }

  if (omitted > 0) {
    kept.push(`[${omitted} further line(s) omitted: this body reached Jira's length limit.]`);
  }

  return {
    type: 'doc',
    version: 1,
    content: kept.length > 0 ? kept.map(paragraph) : [paragraph(EMPTY_BODY_PLACEHOLDER)],
  };
}

/* -------------------------------------------------------------- payloads -- */

export interface JiraProjectRef {
  readonly key: string;
}

export interface JiraIssueTypeRef {
  readonly name: string;
}

/**
 * The create-issue `fields` object. The OpenAPI spec declares it free-form because the valid keys
 * come from the project's create screen, so the index signature stays open for custom fields —
 * remembering that a multi-line custom field wants ADF and a single-line one wants a string.
 */
export interface JiraIssueFields {
  readonly project: JiraProjectRef;
  readonly issuetype: JiraIssueTypeRef;
  /** Plain string. Sending ADF here is a 400. */
  readonly summary: string;
  readonly description?: AdfDocument;
  readonly labels?: readonly string[];
  readonly [field: string]: unknown;
}

/** The fields of the 201 response this framework uses; the payload carries more. */
export interface JiraComment {
  readonly id: string;
  readonly self: string;
  readonly created: string;
}

/** Create-issue answers with identity only — no `fields` echo, so re-read if you need them. */
export interface JiraCreatedIssue {
  readonly id: string;
  readonly key: string;
  readonly self: string;
}

export interface JiraUser {
  readonly accountId: string;
  readonly displayName: string;
}

export interface JiraClientOptions {
  /** Tenant origin, e.g. `https://your-domain.atlassian.net`. */
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  /** Present only for a scoped token, which must be routed through the Atlassian gateway. */
  readonly cloudId?: string;
  readonly timeoutMs?: number;
}

/**
 * A Jira call that did not succeed. Deliberately not a FrameworkError subclass: its message is
 * written to be one readable line of an `IntegrationResult.detail`, not a multi-line dump.
 */
export class JiraApiError extends Error {
  /** HTTP status, or 0 when no response arrived at all (timeout, DNS, TLS). */
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'JiraApiError';
    this.status = status;
  }
}

interface JiraRequestOptions {
  /** JSON body for a write; absent on a GET. */
  readonly body?: unknown;
  /** Shortens this one call's deadline. It can never lengthen it past the instance timeout. */
  readonly timeoutMs?: number;
  /**
   * Response fields the caller is about to dereference. `parsed as T` is a claim about Jira, not
   * proof about the bytes that arrived, and the gap is not academic: a 201 whose body carried no
   * `key` would surface upstream as "nothing was created" while the issue really exists, inviting
   * a duplicate on the next run. Better to report a write of unknown outcome than to deny it.
   */
  readonly requires?: readonly string[];
}

/** Only the headers a human can act on are kept; the rest are noise here. */
interface JiraRawResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
  readonly retryAfter: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const stringify = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? '');

/**
 * Keeps only the part of `JIRA_BASE_URL` that addresses the site.
 *
 * This is a credential guard rather than tidiness. `https://me:token@site.atlassian.net` is a
 * shape people genuinely paste into an env file, and this value — unlike the auth header — is
 * *published*: it becomes `IntegrationResult.url` and is rendered into the report. Userinfo, query
 * and fragment are stripped so a secret smuggled in through the URL cannot ride out with the
 * result. The path survives, because a Server/DC install can sit under a context path.
 */
function normaliseSiteUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    /* Unparseable, so it will fail at fetch time anyway — but strip userinfo before it is shown. */
    return trimmed.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
  }
}

/**
 * Renders an ErrorCollection. Both halves are rendered on purpose: the most common failure — a
 * malformed ADF body — comes back with an *empty* `errorMessages` array and the entire diagnostic
 * keyed by field name in `errors`, so showing only the former reports a blank reason.
 */
function describeErrorBody(body: string): string {
  const parsed = parseJson(body);
  if (!isRecord(parsed)) return truncate(body.trim(), 200);

  const messages = Array.isArray(parsed.errorMessages)
    ? parsed.errorMessages.map(stringify).filter((entry) => entry.length > 0)
    : [];
  const fields = isRecord(parsed.errors)
    ? Object.entries(parsed.errors).map(([field, reason]) => `${field}: ${stringify(reason)}`)
    : [];

  const rendered = [...messages, ...fields].join('; ');
  return rendered.length > 0 ? truncate(rendered, 300) : truncate(body.trim(), 200);
}

export class JiraClient {
  private readonly siteUrl: string;
  private readonly apiRoot: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;

  constructor(options: JiraClientOptions) {
    this.siteUrl = normaliseSiteUrl(options.baseUrl);
    /*
     * A scoped token 401s against the tenant origin and a classic token 401s against the
     * gateway, so the host follows the token flavour rather than being guessed at call time.
     */
    this.apiRoot = options.cloudId
      ? `${ATLASSIAN_GATEWAY}/ex/jira/${encodeURIComponent(options.cloudId.trim())}${API_PATH}`
      : `${this.siteUrl}${API_PATH}`;
    this.authHeader = `Basic ${Buffer.from(`${options.email.trim()}:${options.apiToken}`, 'utf8').toString('base64')}`;
    this.timeoutMs = Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? 15_000);
  }

  /** The human-facing link for an issue — always the tenant origin, never the gateway. */
  public browseUrl(issueKey: string): string {
    return `${this.siteUrl}/browse/${encodeURIComponent(issueKey)}`;
  }

  /**
   * Credential preflight. `/myself` is the only endpoint here with no anonymous fallback, so a
   * bad or expired token fails as a plain 401 instead of surfacing later as a confusing 404 from
   * the comment endpoint. `accountId` is required of the response as well, which catches the other
   * common misconfiguration: an SSO portal or proxy answering 200 with something that parses as
   * JSON but is not Jira.
   */
  public async verifyCredentials(timeoutMs?: number): Promise<JiraUser> {
    return this.send<JiraUser>('GET', '/myself', { timeoutMs, requires: ['accountId'] });
  }

  /** Adds one comment. `issueIdOrKey` accepts either the numeric id or a key such as `QA-123`. */
  public async addComment(
    issueKey: string,
    body: AdfDocument,
    timeoutMs?: number,
  ): Promise<JiraComment> {
    return this.send<JiraComment>('POST', `/issue/${encodeURIComponent(issueKey)}/comment`, {
      body: { body },
      timeoutMs,
      requires: ['id'],
    });
  }

  public async createIssue(fields: JiraIssueFields, timeoutMs?: number): Promise<JiraCreatedIssue> {
    return this.send<JiraCreatedIssue>('POST', '/issue', {
      body: { fields },
      timeoutMs,
      requires: ['key'],
    });
  }

  /* ----------------------------------------------------------- internals -- */

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    options: JiraRequestOptions,
  ): Promise<T> {
    const response = await this.exchange(method, path, options);

    if (!response.ok) {
      throw new JiraApiError(
        [
          `HTTP ${response.status} from ${method} ${path}`,
          STATUS_HINTS[response.status],
          response.retryAfter ? `retry after ${response.retryAfter}s` : undefined,
          describeErrorBody(response.body),
        ]
          .filter((part) => part !== undefined && part !== '')
          .join(' — '),
        response.status,
      );
    }

    const parsed = parseJson(response.body);
    if (!isRecord(parsed)) {
      throw new JiraApiError(
        `${method} ${path} returned HTTP ${response.status} with a non-JSON body`,
        response.status,
      );
    }

    for (const field of options.requires ?? []) {
      const value = parsed[field];
      if (typeof value !== 'string' || value.trim() === '') {
        /* Only a write can have half-happened; saying so on a GET would send the reader looking. */
        const caveat = method === 'POST' ? ' — the write may still have taken effect' : '';
        throw new JiraApiError(
          `${method} ${path} returned HTTP ${response.status} without a usable "${field}"${caveat}`,
          response.status,
        );
      }
    }

    return parsed as T;
  }

  /**
   * The one place a socket is opened. Every call carries an `AbortSignal.timeout`, because a
   * reporter runs after the suite has finished and a hung endpoint would otherwise hold the
   * process open long past the point anyone is watching. A caller spending a shared wall-clock
   * budget may shorten that deadline; nothing may extend it.
   */
  private async exchange(
    method: 'GET' | 'POST',
    path: string,
    options: JiraRequestOptions,
  ): Promise<JiraRawResponse> {
    const timeoutMs = Math.max(
      MIN_TIMEOUT_MS,
      Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs),
    );

    try {
      const response = await fetch(`${this.apiRoot}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      return {
        status: response.status,
        ok: response.ok,
        /*
         * Read inside the try, and inside the same signal: a server that sends headers and then
         * stalls mid-body aborts here rather than holding the reporter open indefinitely.
         */
        body: await response.text(),
        retryAfter: response.headers.get('retry-after') ?? undefined,
      };
    } catch (error) {
      /*
       * A timeout surfaces as an AbortError with an unhelpful message, and the path is safe to
       * quote because no credential ever travels in the URL — auth is a header, and the site URL
       * has already been through normaliseSiteUrl.
       */
      const reason =
        error instanceof Error
          ? error.name === 'TimeoutError' || error.name === 'AbortError'
            ? `no response within ${timeoutMs}ms`
            : error.message
          : 'unknown transport failure';
      throw new JiraApiError(`${method} ${path} did not complete: ${reason}`, 0);
    }
  }
}
