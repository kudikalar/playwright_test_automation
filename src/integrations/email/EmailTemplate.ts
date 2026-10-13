/**
 * Renders a finished run as an email: an HTML body that survives Outlook and Gmail, and a
 * plain-text alternative for clients (and spam filters) that prefer one.
 *
 * Email HTML is not web HTML. Outlook renders with Word's engine, so everything here is a table,
 * every style is inline, colours are hex literals rather than custom properties, and nothing
 * depends on `<style>`, flexbox, grid, SVG or web fonts. Every interpolated value is escaped:
 * test titles and assertion messages are arbitrary text and some contain markup.
 */

import type { ExtentReportModel, ExtentTest } from '../../reporting/ExtentTypes';
import { issueKeysFor, type IntegrationResult } from '../IntegrationTypes';

export interface EmailRenderOptions {
  readonly model: ExtentReportModel;
  readonly reportUrl?: string;
  readonly priorResults?: readonly IntegrationResult[];
  readonly subjectPrefix?: string;
  /** Failures listed in the body before the remainder is summarised. */
  readonly maxFailures?: number;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const COLORS = {
  pass: '#1a7f37',
  fail: '#cf222e',
  flaky: '#9a6700',
  skip: '#57606a',
  ink: '#1f2328',
  muted: '#57606a',
  rule: '#d0d7de',
  panel: '#f6f8fa',
  white: '#ffffff',
  link: '#0969da',
} as const;

const DEFAULT_MAX_FAILURES = 15;
const ERROR_LINE_LIMIT = 280;

const FAILING = new Set(['FAIL', 'TIMEOUT', 'INTERRUPTED']);

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const clamp = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;

/** Only http(s) links are rendered as anchors; anything else is shown as text, never as a href. */
const isSafeUrl = (value: string | undefined): value is string =>
  value !== undefined && /^https?:\/\/[^\s"'<>]+$/i.test(value.trim());

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes < 60 ? `${minutes}m ${rest}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const firstErrorLine = (test: ExtentTest): string =>
  clamp(
    (test.errorMessage ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? 'No error message captured.',
    ERROR_LINE_LIMIT,
  );

export function failingTestsOf(model: ExtentReportModel): ExtentTest[] {
  return model.tests.filter((test) => FAILING.has(test.status));
}

export type RunVerdict = 'PASSED' | 'FAILED' | 'PASSED WITH FLAKY TESTS' | 'NO TESTS EXECUTED';

export function verdictOf(model: ExtentReportModel): RunVerdict {
  const { summary } = model;
  if (summary.total === 0 || summary.total === summary.skipped) return 'NO TESTS EXECUTED';
  if (summary.failed > 0) return 'FAILED';
  if (summary.flaky > 0) return 'PASSED WITH FLAKY TESTS';
  return 'PASSED';
}

const verdictColor = (verdict: RunVerdict): string =>
  verdict === 'FAILED'
    ? COLORS.fail
    : verdict === 'PASSED'
      ? COLORS.pass
      : verdict === 'PASSED WITH FLAKY TESTS'
        ? COLORS.flaky
        : COLORS.skip;

export function buildSubject(model: ExtentReportModel, prefix = '[Playwright]'): string {
  const verdict = verdictOf(model);
  const { summary, environment } = model;
  const counts =
    verdict === 'FAILED'
      ? `${summary.failed} failed / ${summary.total}`
      : `${summary.passed + summary.flaky}/${summary.total - summary.skipped} passed`;
  const icon = verdict === 'FAILED' ? '❌' : verdict === 'PASSED' ? '✅' : '⚠️';
  /* Subjects are single-line headers; a newline in a display name would be header injection. */
  return `${prefix} ${icon} ${verdict} · ${environment.displayName} · ${counts} · ${summary.passRate}%`
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/* ---------------------------------------------------------------- HTML -- */

const kpiCell = (label: string, value: string, color: string): string => `
  <td align="center" style="padding:12px 6px;border:1px solid ${COLORS.rule};background:${COLORS.white};">
    <div style="font:700 22px/1.2 Arial,Helvetica,sans-serif;color:${color};">${escapeHtml(value)}</div>
    <div style="font:12px/1.4 Arial,Helvetica,sans-serif;color:${COLORS.muted};text-transform:uppercase;letter-spacing:.5px;">${escapeHtml(label)}</div>
  </td>`;

const row = (label: string, value: string): string => `
  <tr>
    <td style="padding:4px 12px 4px 0;font:13px Arial,Helvetica,sans-serif;color:${COLORS.muted};white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:4px 0;font:13px Arial,Helvetica,sans-serif;color:${COLORS.ink};">${value}</td>
  </tr>`;

const linkOrText = (label: string, url: string | undefined): string =>
  isSafeUrl(url)
    ? `<a href="${escapeHtml(url)}" style="color:${COLORS.link};text-decoration:none;">${escapeHtml(label)}</a>`
    : escapeHtml(label);

const statusColor = (status: IntegrationResult['status']): string =>
  status === 'published' ? COLORS.pass : status === 'failed' ? COLORS.fail : COLORS.skip;

function failuresHtml(failures: readonly ExtentTest[], max: number): string {
  if (failures.length === 0) return '';
  const shown = failures.slice(0, max);
  const rows = shown
    .map((test) => {
      const keys = issueKeysFor(test.tags, test.annotations);
      return `
      <tr>
        <td style="padding:10px;border-bottom:1px solid ${COLORS.rule};vertical-align:top;">
          <div style="font:700 13px Arial,Helvetica,sans-serif;color:${COLORS.ink};">${escapeHtml(clamp(test.name, 200))}</div>
          <div style="font:12px Arial,Helvetica,sans-serif;color:${COLORS.muted};padding-top:2px;">
            ${escapeHtml(test.file)} · ${escapeHtml(test.project)} · ${escapeHtml(formatDuration(test.durationMs))}${test.retries > 0 ? ` · ${test.retries} retr${test.retries === 1 ? 'y' : 'ies'}` : ''}${keys.length > 0 ? ` · ${escapeHtml(keys.join(', '))}` : ''}
          </div>
          <div style="font:12px/1.5 Consolas,Menlo,monospace;color:${COLORS.fail};background:#fff8f8;border-left:3px solid ${COLORS.fail};padding:6px 8px;margin-top:6px;word-break:break-word;">${escapeHtml(firstErrorLine(test))}</div>
        </td>
      </tr>`;
    })
    .join('');
  const hidden = failures.length - shown.length;
  const more =
    hidden > 0
      ? `<tr><td style="padding:10px;font:12px Arial,Helvetica,sans-serif;color:${COLORS.muted};">… and ${hidden} more failing test(s) — see the full report.</td></tr>`
      : '';
  return `
  <tr><td style="padding:24px 24px 8px;font:700 15px Arial,Helvetica,sans-serif;color:${COLORS.ink};">Failures (${failures.length})</td></tr>
  <tr><td style="padding:0 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${COLORS.rule};border-collapse:collapse;">${rows}${more}</table>
  </td></tr>`;
}

function integrationsHtml(results: readonly IntegrationResult[]): string {
  if (results.length === 0) return '';
  const rows = results
    .map(
      (result) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid ${COLORS.rule};font:700 12px Arial,Helvetica,sans-serif;color:${COLORS.ink};white-space:nowrap;vertical-align:top;">${linkOrText(result.name, result.url)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid ${COLORS.rule};font:700 11px Arial,Helvetica,sans-serif;color:${statusColor(result.status)};text-transform:uppercase;white-space:nowrap;vertical-align:top;">${escapeHtml(result.status)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid ${COLORS.rule};font:12px Arial,Helvetica,sans-serif;color:${COLORS.muted};">${escapeHtml(clamp(result.detail, 400))}</td>
      </tr>`,
    )
    .join('');
  return `
  <tr><td style="padding:24px 24px 8px;font:700 15px Arial,Helvetica,sans-serif;color:${COLORS.ink};">Where this run was recorded</td></tr>
  <tr><td style="padding:0 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${COLORS.rule};border-collapse:collapse;">${rows}</table>
  </td></tr>`;
}

export function renderEmail(options: EmailRenderOptions): RenderedEmail {
  const { model } = options;
  const { summary, environment } = model;
  const verdict = verdictOf(model);
  const color = verdictColor(verdict);
  const failures = failingTestsOf(model);
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const prior = options.priorResults ?? [];
  const reportUrl = isSafeUrl(options.reportUrl) ? options.reportUrl : undefined;

  const button = reportUrl
    ? `<tr><td style="padding:20px 24px 0;">
        <a href="${escapeHtml(reportUrl)}" style="display:inline-block;background:${COLORS.ink};color:${COLORS.white};font:700 14px Arial,Helvetica,sans-serif;text-decoration:none;padding:10px 18px;border-radius:6px;">Open full report →</a>
       </td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(buildSubject(model, options.subjectPrefix))}</title></head>
<body style="margin:0;padding:0;background:${COLORS.panel};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.panel};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:${COLORS.white};border:1px solid ${COLORS.rule};border-radius:8px;">
  <tr><td style="background:${color};padding:18px 24px;border-radius:8px 8px 0 0;">
    <div style="font:700 12px Arial,Helvetica,sans-serif;color:${COLORS.white};opacity:.85;letter-spacing:1px;text-transform:uppercase;">Playwright test run</div>
    <div style="font:700 22px/1.3 Arial,Helvetica,sans-serif;color:${COLORS.white};padding-top:4px;">${escapeHtml(verdict)} · ${escapeHtml(environment.displayName)}</div>
  </td></tr>
  <tr><td style="padding:20px 24px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
      ${kpiCell('Total', String(summary.total), COLORS.ink)}
      ${kpiCell('Passed', String(summary.passed), COLORS.pass)}
      ${kpiCell('Failed', String(summary.failed), summary.failed > 0 ? COLORS.fail : COLORS.ink)}
      ${kpiCell('Flaky', String(summary.flaky), summary.flaky > 0 ? COLORS.flaky : COLORS.ink)}
      ${kpiCell('Skipped', String(summary.skipped), COLORS.skip)}
      ${kpiCell('Pass rate', `${summary.passRate}%`, color)}
    </tr></table>
  </td></tr>
  ${button}
  <tr><td style="padding:20px 24px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0">
      ${row('Environment', `${escapeHtml(environment.displayName)} (${escapeHtml(environment.name)})`)}
      ${row('Application', linkOrText(environment.uiBaseUrl, environment.uiBaseUrl))}
      ${row('Projects', escapeHtml(environment.projects.join(', ') || '—'))}
      ${row('Duration', escapeHtml(formatDuration(summary.durationMs)))}
      ${row('Started', escapeHtml(summary.startedAt))}
      ${row('Run ID', escapeHtml(model.runId))}
      ${row('Runner', escapeHtml(`${environment.ci ? 'CI' : 'Local'} · ${environment.workers} worker(s) · Playwright ${environment.playwright} · Node ${environment.node}`))}
    </table>
  </td></tr>
  ${failuresHtml(failures, maxFailures)}
  ${integrationsHtml(prior)}
  <tr><td style="padding:24px;font:11px/1.5 Arial,Helvetica,sans-serif;color:${COLORS.muted};border-top:1px solid ${COLORS.rule};margin-top:24px;">
    Sent automatically by ${escapeHtml(environment.framework)}. Secrets in error messages are masked before sending.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const textLines = [
    `PLAYWRIGHT RUN: ${verdict} — ${environment.displayName} (${environment.name})`,
    '',
    `Total ${summary.total} | Passed ${summary.passed} | Failed ${summary.failed} | Flaky ${summary.flaky} | Skipped ${summary.skipped} | Pass rate ${summary.passRate}%`,
    `Duration ${formatDuration(summary.durationMs)} | Started ${summary.startedAt} | Run ${model.runId}`,
    reportUrl ? `Report: ${reportUrl}` : '',
    '',
    ...(failures.length > 0
      ? [
          `FAILURES (${failures.length})`,
          ...failures
            .slice(0, maxFailures)
            .map((test) => `- ${test.name} [${test.project}] — ${firstErrorLine(test)}`),
          failures.length > maxFailures ? `… and ${failures.length - maxFailures} more` : '',
          '',
        ]
      : []),
    ...(prior.length > 0
      ? [
          'RECORDED IN',
          ...prior.map(
            (r) => `- ${r.name}: ${r.status} — ${r.detail}${r.url ? ` (${r.url})` : ''}`,
          ),
        ]
      : []),
  ];

  return {
    subject: buildSubject(model, options.subjectPrefix),
    html,
    text: textLines
      .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
      .join('\n'),
  };
}
