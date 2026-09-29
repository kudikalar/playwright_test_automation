/**
 * Slack run-summary notification over an incoming webhook.
 *
 * One message per run — never one per failure. A per-test loop would breach Slack's "1 request per
 * second" webhook limit and bury the signal; the summary names the first few failures and links to
 * the report for the rest.
 *
 * Three constraints shape everything below:
 *
 *  1. **Opt-in.** The webhook URL is the switch. Without `SLACK_WEBHOOK_URL` the integration is
 *     disabled, so a local or PR run stays silent and needs no credential. A blank or
 *     whitespace-only value counts as unset — CI exports empty variables constantly.
 *  2. **Never fail the run.** `publish()` resolves with a `failed` result and swallows every
 *     throw. A dead webhook must not turn a green suite red.
 *  3. **The URL is the credential.** `SLACK_WEBHOOK_URL` embeds the workspace/app/secret path
 *     segments — there is no Authorization header — so it is never logged, never rendered into a
 *     message, and scrubbed out of every piece of text that reaches a result detail. Scrubbing
 *     runs *before* truncation: half a leaked URL is still a leaked credential, and a URL cut in
 *     two no longer matches the pattern that would have caught it.
 *
 * Webhook mode posts to the single channel chosen when the app was installed; the `channel` field
 * is silently ignored. Retargeting means issuing a new webhook URL, not editing configuration.
 */

import type {
  Integration,
  IntegrationContext,
  IntegrationResult,
  IntegrationStatus,
} from '../IntegrationTypes';
import { buildRunSummaryMessage, clampText, DEFAULT_MAX_FAILURES } from './SlackBlocks';

/** `always` announces every run; `failure` (the default) keeps a green run quiet. */
export type SlackNotifyOn = 'always' | 'failure';

export interface SlackNotifierOptions {
  /** Defaults to `SLACK_WEBHOOK_URL`. Treated as a secret in every code path. */
  readonly webhookUrl?: string;
  /** Defaults to `SLACK_NOTIFY_ON`, itself defaulting to `failure`. */
  readonly notifyOn?: SlackNotifyOn;
  /** Defaults to `SLACK_REPORT_URL`, used only when the context carries no report URL. */
  readonly reportUrl?: string;
  /** Defaults to `SLACK_TIMEOUT_MS`, itself defaulting to 10s. */
  readonly timeoutMs?: number;
  readonly maxFailures?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Enough of a rejection body to identify the error code, short of pasting a wall of HTML. */
const ERROR_BODY_LIMIT = 200;

/** A `retry-after` is a small number of seconds; anything longer is a broken proxy, not a hint. */
const RETRY_AFTER_LIMIT = 40;

/**
 * Below this a webhook path carries no secret (`/`, `/hook`), and blanking it would scrub ordinary
 * words out of every error message instead of protecting anything.
 */
const REDACTABLE_PATH_LENGTH = 12;

const REDACTED = '[redacted]';

/** How far down an error's `cause` chain to look before giving up. */
const MAX_CAUSE_DEPTH = 5;

/** Treats blank and whitespace-only as absent, whether it came from the environment or a caller. */
function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envValue(name: string): string | undefined {
  return blankToUndefined(process.env[name]);
}

/**
 * Normalises a numeric setting to a whole number at or above `min`. `AbortSignal.timeout` throws on
 * a negative or non-finite argument, so a hand-passed `NaN` would otherwise surface as a Slack
 * "request failed" that has nothing to do with Slack.
 */
function boundedInt(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value) || value < min) return fallback;
  return Math.floor(value);
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = envValue(name);
  return raw === undefined ? fallback : boundedInt(Number(raw), fallback, min);
}

/** Anything other than an explicit `always` resolves to the quiet default. */
function resolveNotifyOn(raw: string | undefined): SlackNotifyOn {
  return raw?.toLowerCase() === 'always' ? 'always' : 'failure';
}

/**
 * A request aborted by `AbortSignal.timeout` surfaces as a `DOMException` named `TimeoutError`,
 * but undici does not always hand it over intact — a timeout during connect can arrive wrapped as
 * `TypeError: fetch failed` carrying the real reason on `cause`. Walking the chain is the
 * difference between "Slack did not respond within 10000ms" and a meaningless "fetch failed".
 */
function isTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const candidate = current as { readonly name?: unknown; readonly cause?: unknown };
    if (candidate.name === 'TimeoutError' || candidate.name === 'AbortError') return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * `fetch` reports every transport failure as the same opaque `fetch failed`; the DNS or TLS detail
 * that says *why* lives on `cause`, so the cause is folded in rather than dropped.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : '';
    return `${error.message}${cause}`;
  }
  return typeof error === 'string' ? error : 'unknown error';
}

export class SlackNotifier implements Integration {
  public readonly name = 'Slack';

  private readonly webhookUrl: string | undefined;
  /** Held apart from the URL so text quoting only the secret path is scrubbed too. */
  private readonly webhookPath: string | undefined;
  private readonly notifyOn: SlackNotifyOn;
  private readonly configuredReportUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxFailures: number;

  constructor(options: SlackNotifierOptions = {}) {
    /*
     * Caller-supplied options go through the same blank check as the environment: a
     * `webhookUrl: ''` built from an absent CI secret must disable the integration, not enable it
     * with an empty credential.
     */
    this.webhookUrl = blankToUndefined(options.webhookUrl) ?? envValue('SLACK_WEBHOOK_URL');
    this.webhookPath = SlackNotifier.secretPathOf(this.webhookUrl);
    this.notifyOn = options.notifyOn ?? resolveNotifyOn(envValue('SLACK_NOTIFY_ON'));
    this.configuredReportUrl = blankToUndefined(options.reportUrl) ?? envValue('SLACK_REPORT_URL');
    this.timeoutMs = boundedInt(
      options.timeoutMs,
      envInt('SLACK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1),
      1,
    );
    this.maxFailures = boundedInt(options.maxFailures, DEFAULT_MAX_FAILURES, 0);
  }

  /* ------------------------------------------------------------- gating -- */

  public isEnabled(): boolean {
    return this.webhookUrl !== undefined;
  }

  /** Never empty: the report renders this line, and a blank cell reads as a rendering bug. */
  public disabledReason(): string {
    if (this.webhookUrl === undefined) {
      return 'Slack notification is off: SLACK_WEBHOOK_URL is not set.';
    }
    return this.notifyOn === 'always'
      ? 'Slack notification is on for every run (SLACK_NOTIFY_ON=always).'
      : 'Slack notification is on for failing runs only (SLACK_NOTIFY_ON is not "always").';
  }

  /* ------------------------------------------------------------ publish -- */

  public async publish(context: IntegrationContext): Promise<IntegrationResult> {
    const startedAt = Date.now();

    try {
      const webhookUrl = this.webhookUrl;
      if (webhookUrl === undefined) {
        return this.result(startedAt, 'skipped', this.disabledReason());
      }

      const { summary } = context.model;
      if (this.notifyOn === 'failure' && summary.failed === 0) {
        /* `passed` excludes flaky, so both are named rather than calling the run simply green. */
        const flaky = summary.flaky > 0 ? `, ${summary.flaky} flaky` : '';
        return this.result(
          startedAt,
          'skipped',
          `No failures (${summary.passed}/${summary.total} passed${flaky}) and SLACK_NOTIFY_ON is ` +
            `not 'always'; set SLACK_NOTIFY_ON=always to announce passing runs too.`,
        );
      }

      if (!this.isWebhookUrlUsable(webhookUrl)) {
        return this.result(
          startedAt,
          'failed',
          'SLACK_WEBHOOK_URL is not a usable https URL (value withheld); expected a ' +
            'https://hooks.slack.com/services/... incoming-webhook URL.',
        );
      }

      const reportUrl = context.reportUrl ?? this.configuredReportUrl;
      const payload = buildRunSummaryMessage({
        model: context.model,
        ...(reportUrl === undefined ? {} : { reportUrl }),
        maxFailures: this.maxFailures,
      });

      /*
       * AbortSignal.timeout caps the whole exchange — request, response and body stream: a hung
       * hooks.slack.com connection would otherwise hold the reporter open long after the suite has
       * finished. `redirect: 'error'` is the other half of that guard: a webhook answering with a
       * redirect is either misconfigured or intercepted, and following it would POST the run
       * summary to a host nobody vetted.
       */
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      /*
       * A webhook answers with the plain text `ok`, not JSON — calling response.json() here would
       * throw on the success path. Errors arrive as a plain-text code in the body, and the body is
       * more reliable than the status, so the detail carries both.
       */
      const body = await this.readBody(response);
      const rendered = body === undefined ? '<body unreadable>' : this.safeText(body);

      if (!response.ok) {
        return this.result(
          startedAt,
          'failed',
          `Slack rejected the run summary: HTTP ${response.status}${this.retryAfterNote(response)}` +
            ` — ${rendered === '' ? '<empty body>' : rendered}`,
        );
      }

      /* A 2xx that is not the documented `ok` still delivered; say so rather than assert silence. */
      const oddity =
        body === 'ok'
          ? ''
          : ` (unexpected response: ${rendered === '' ? '<empty body>' : rendered})`;
      return this.result(
        startedAt,
        'published',
        `Posted the run summary to the channel bound to the webhook — ` +
          `${summary.passed}/${summary.total} passed, ${summary.failed} failed, ` +
          `${summary.flaky} flaky.${oddity}`,
      );
    } catch (error) {
      if (isTimeoutError(error)) {
        return this.result(
          startedAt,
          'failed',
          `Slack did not respond within ${this.timeoutMs}ms; the run summary was not posted.`,
        );
      }
      return this.result(
        startedAt,
        'failed',
        `Slack request failed: ${this.safeText(messageOf(error))}`,
      );
    }
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * The path is the entire secret in a webhook URL, so it is scrubbed on its own as well as inside
   * the full URL: an error quoting `/services/T000/B000/xxx` has leaked the credential just as
   * completely as one quoting the origin with it.
   */
  private static secretPathOf(webhookUrl: string | undefined): string | undefined {
    if (webhookUrl === undefined) return undefined;
    try {
      const { pathname } = new URL(webhookUrl);
      return pathname.length >= REDACTABLE_PATH_LENGTH ? pathname : undefined;
    } catch {
      return undefined;
    }
  }

  /** Rejects anything that is not an https URL, before it is handed to fetch. */
  private isWebhookUrlUsable(webhookUrl: string): boolean {
    try {
      return new URL(webhookUrl).protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * `undefined` means the body could not be read — an aborted stream, say — which is a different
   * fact from an empty body and is reported as such rather than flattened into `''`.
   */
  private async readBody(response: Response): Promise<string | undefined> {
    try {
      return (await response.text()).trim();
    } catch {
      return undefined;
    }
  }

  /**
   * The single gate every piece of server-controlled text passes through on its way into a result
   * detail. Redaction runs first and truncation second, and the clamp marks the cut so a shortened
   * body is never mistaken for the whole of Slack's answer.
   */
  private safeText(text: string, limit: number = ERROR_BODY_LIMIT): string {
    return clampText(this.redact(text), limit);
  }

  /**
   * Last line of defence before any text becomes a result detail: a webhook URL that leaked into
   * an error message would be a live credential published in a report.
   */
  private redact(text: string): string {
    let scrubbed =
      this.webhookUrl === undefined ? text : text.split(this.webhookUrl).join(REDACTED);
    if (this.webhookPath !== undefined) {
      scrubbed = scrubbed.split(this.webhookPath).join(REDACTED);
    }
    return scrubbed.replace(/https:\/\/hooks\.slack\.com\/\S*/gi, REDACTED);
  }

  /** 429s are surfaced rather than retried: stalling a finished run is the worse failure. */
  private retryAfterNote(response: Response): string {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter === null) return '';
    /* Quoted verbatim: Slack sends seconds, but the header is also allowed to carry a date. */
    return ` (retry-after: ${this.safeText(retryAfter, RETRY_AFTER_LIMIT)})`;
  }

  private result(startedAt: number, status: IntegrationStatus, detail: string): IntegrationResult {
    return { name: this.name, status, detail, durationMs: Date.now() - startedAt };
  }
}
