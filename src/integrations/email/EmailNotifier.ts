/**
 * EmailNotifier — sends one run-summary email over SMTP.
 *
 * Works with any SMTP relay: Microsoft 365 (`smtp.office365.com:587`), Google Workspace
 * (`smtp.gmail.com:587` with an app password), Amazon SES, SendGrid (`smtp.sendgrid.net`, user
 * `apikey`), Mailgun, or an internal relay. Port 465 uses implicit TLS; any other port upgrades
 * with STARTTLS and refuses to send in clear text.
 *
 * Same contract as every integration:
 *  - **Opt-in**: `EMAIL_ENABLED=true` plus host, sender and at least one recipient.
 *  - **Never fails the run**: `publish()` always resolves with a result.
 *  - **No secrets out**: the SMTP password is never logged and is scrubbed from error text.
 *
 * It runs in the `notify` phase, after Jira/Zephyr/Sauce, so the email can say where the run was
 * recorded.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import nodemailer from 'nodemailer';

import type {
  Integration,
  IntegrationContext,
  IntegrationResult,
  IntegrationStatus,
} from '../IntegrationTypes';
import { renderExtentHtml } from '../../reporting/ExtentHtml';
import { failingTestsOf, renderEmail } from './EmailTemplate';

export type EmailNotifyOn = 'always' | 'failure';

export interface EmailSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly notifyOn: EmailNotifyOn;
  readonly subjectPrefix: string;
  readonly attachReport: boolean;
  readonly maxAttachmentBytes: number;
  readonly timeoutMs: number;
  /** For internal relays with a self-signed certificate. Never needed for public providers. */
  readonly allowSelfSigned: boolean;
  readonly reportUrl?: string;
}

/** Minimal surface of a nodemailer transport, so tests can inject a fake. */
export interface MailTransport {
  sendMail(
    message: Record<string, unknown>,
  ): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[] }>;
  verify(): Promise<unknown>;
  close?(): void;
}

export type TransportFactory = (settings: EmailSettings) => MailTransport;

const truthy = (value: string | undefined): boolean =>
  ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());

const read = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value.replace(/^(['"])(.*)\1$/, '$2');
};

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Bare-bones address check: catches a typo'd variable, not RFC 5322 corner cases. */
const looksLikeAddress = (value: string): boolean => /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/.test(value);

export function readEmailSettings(env: NodeJS.ProcessEnv = process.env): EmailSettings | undefined {
  const host = read(env, 'SMTP_HOST');
  const from = read(env, 'EMAIL_FROM');
  const to = list(read(env, 'EMAIL_TO'));
  if (!truthy(env.EMAIL_ENABLED) || host === undefined || from === undefined || to.length === 0) {
    return undefined;
  }
  const port = int(read(env, 'SMTP_PORT'), 587);
  const secureRaw = read(env, 'SMTP_SECURE');
  const user = read(env, 'SMTP_USER');
  const password = read(env, 'SMTP_PASSWORD');
  const reportUrl = read(env, 'REPORT_URL');
  return {
    host,
    port,
    secure: secureRaw === undefined ? port === 465 : truthy(secureRaw),
    ...(user === undefined ? {} : { user }),
    ...(password === undefined ? {} : { password }),
    from,
    to,
    cc: list(read(env, 'EMAIL_CC')),
    bcc: list(read(env, 'EMAIL_BCC')),
    notifyOn: read(env, 'EMAIL_NOTIFY_ON')?.toLowerCase() === 'failure' ? 'failure' : 'always',
    subjectPrefix: read(env, 'EMAIL_SUBJECT_PREFIX') ?? '[Playwright]',
    attachReport: env.EMAIL_ATTACH_REPORT === undefined ? true : truthy(env.EMAIL_ATTACH_REPORT),
    maxAttachmentBytes: int(read(env, 'EMAIL_MAX_ATTACHMENT_MB'), 10) * 1024 * 1024,
    timeoutMs: int(read(env, 'EMAIL_TIMEOUT_MS'), 30_000),
    allowSelfSigned: truthy(env.SMTP_ALLOW_SELF_SIGNED),
    ...(reportUrl === undefined ? {} : { reportUrl }),
  };
}

export const createSmtpTransport: TransportFactory = (settings) =>
  nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    /* On a non-465 port, refuse to fall back to plain text if STARTTLS is not offered. */
    requireTLS: !settings.secure,
    ...(settings.user === undefined
      ? {}
      : { auth: { user: settings.user, pass: settings.password ?? '' } }),
    connectionTimeout: settings.timeoutMs,
    greetingTimeout: settings.timeoutMs,
    socketTimeout: settings.timeoutMs,
    ...(settings.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
  });

/** Removes the SMTP password from text that ends up in a result detail. */
function scrub(message: string, settings: EmailSettings | undefined): string {
  let out = message;
  for (const secret of [settings?.password]) {
    if (secret !== undefined && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 300);
}

const describe = (error: unknown): string =>
  error instanceof Error
    ? `${error.message}${(error as { code?: string }).code ? ` (${(error as { code?: string }).code})` : ''}`
    : String(error);

export interface EmailNotifierOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly transportFactory?: TransportFactory;
}

export class EmailNotifier implements Integration {
  public readonly name = 'Email';
  public readonly phase = 'notify' as const;

  private readonly env: NodeJS.ProcessEnv;
  private readonly transportFactory: TransportFactory;

  constructor(options: EmailNotifierOptions = {}) {
    this.env = options.env ?? process.env;
    this.transportFactory = options.transportFactory ?? createSmtpTransport;
  }

  public isEnabled(): boolean {
    return readEmailSettings(this.env) !== undefined;
  }

  public disabledReason(): string {
    const missing: string[] = [];
    if (!truthy(this.env.EMAIL_ENABLED)) missing.push('EMAIL_ENABLED=true');
    if (read(this.env, 'SMTP_HOST') === undefined) missing.push('SMTP_HOST');
    if (read(this.env, 'EMAIL_FROM') === undefined) missing.push('EMAIL_FROM');
    if (list(read(this.env, 'EMAIL_TO')).length === 0) missing.push('EMAIL_TO');
    return missing.length === 0
      ? 'Email reporting is enabled.'
      : `Email reporting is off: set ${missing.join(', ')}.`;
  }

  /** Opens an SMTP session and authenticates without sending anything. Used by the doctor. */
  public async verify(): Promise<{ ok: boolean; detail: string }> {
    const settings = readEmailSettings(this.env);
    if (settings === undefined) return { ok: false, detail: this.disabledReason() };
    const transport = this.transportFactory(settings);
    try {
      await transport.verify();
      return {
        ok: true,
        detail: `SMTP ${settings.host}:${settings.port} accepted the connection${settings.user ? ` and login for ${settings.user}` : ''}.`,
      };
    } catch (error) {
      return { ok: false, detail: `SMTP check failed: ${scrub(describe(error), settings)}` };
    } finally {
      transport.close?.();
    }
  }

  public async publish(context: IntegrationContext): Promise<IntegrationResult> {
    const started = Date.now();
    let status: IntegrationStatus = 'skipped';
    let detail: string;
    let settings: EmailSettings | undefined;

    try {
      settings = readEmailSettings(this.env);
      if (settings === undefined) {
        detail = this.disabledReason();
      } else if (settings.notifyOn === 'failure' && failingTestsOf(context.model).length === 0) {
        detail = 'No failures and EMAIL_NOTIFY_ON=failure — no email sent.';
      } else {
        const problems = [settings.from, ...settings.to, ...settings.cc, ...settings.bcc].filter(
          (address) => !looksLikeAddress(address),
        );
        if (problems.length > 0) {
          status = 'failed';
          detail = `Not sent: ${problems.length} address(es) in EMAIL_FROM/TO/CC/BCC look malformed.`;
        } else {
          ({ status, detail } = await this.send(settings, context));
        }
      }
    } catch (error) {
      status = 'failed';
      detail = `Email failed: ${scrub(describe(error), settings)}`;
    }

    return { name: this.name, status, detail, durationMs: Date.now() - started };
  }

  private async send(
    settings: EmailSettings,
    context: IntegrationContext,
  ): Promise<{ status: IntegrationStatus; detail: string }> {
    const reportUrl = context.reportUrl ?? settings.reportUrl;
    const rendered = renderEmail({
      model: context.model,
      ...(reportUrl === undefined ? {} : { reportUrl }),
      ...(context.priorResults === undefined ? {} : { priorResults: context.priorResults }),
      subjectPrefix: settings.subjectPrefix,
    });

    const attachments: Record<string, unknown>[] = [];
    let attachmentNote = '';
    if (settings.attachReport) {
      /*
       * The reporter publishes integrations *before* it writes index.html (so the report can show
       * their outcome), so during a live run the file does not exist yet and the report is rendered
       * here from the same model. A re-publish uses the finished file on disk.
       */
      const reportFile = resolve(context.reportDir, 'index.html');
      const html = existsSync(reportFile)
        ? readFileSync(reportFile, 'utf8')
        : renderExtentHtml(context.model);
      const size = Buffer.byteLength(html, 'utf8');
      if (size <= settings.maxAttachmentBytes) {
        attachments.push({
          filename: `playwright-report-${context.model.runId}.html`,
          content: html,
          contentType: 'text/html; charset=utf-8',
        });
      } else {
        attachmentNote = ` (report not attached: ${(size / 1024 / 1024).toFixed(1)}MB exceeds EMAIL_MAX_ATTACHMENT_MB)`;
      }
    }

    const transport = this.transportFactory(settings);
    try {
      const info = await transport.sendMail({
        from: settings.from,
        to: settings.to.join(', '),
        ...(settings.cc.length > 0 ? { cc: settings.cc.join(', ') } : {}),
        ...(settings.bcc.length > 0 ? { bcc: settings.bcc.join(', ') } : {}),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        attachments,
        headers: { 'X-Playwright-Run-Id': context.model.runId },
      });
      const rejected = Array.isArray(info.rejected) ? info.rejected.length : 0;
      const recipients = settings.to.length + settings.cc.length + settings.bcc.length;
      if (rejected > 0 && rejected >= recipients) {
        return { status: 'failed', detail: `SMTP server rejected all ${recipients} recipient(s).` };
      }
      return {
        status: 'published',
        detail:
          `Emailed ${recipients - rejected} recipient(s) via ${settings.host}` +
          `${rejected > 0 ? `; ${rejected} rejected` : ''}${attachments.length > 0 ? ', report attached' : ''}${attachmentNote}.`,
      };
    } finally {
      transport.close?.();
    }
  }
}
