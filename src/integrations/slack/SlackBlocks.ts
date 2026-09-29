/**
 * Block Kit payload for the Slack run summary.
 *
 * Kept apart from the transport so the message can be built and inspected without a network call,
 * and so every one of Slack's ceilings is enforced in exactly one place. Slack does not trim an
 * oversized message — it rejects the whole payload with `invalid_payload` — so clamping is the
 * sender's job. A truncated line is a cosmetic loss; a rejected payload means the team never
 * hears that the suite went red.
 *
 * Block Kit is a payload format rather than an API feature, so these blocks are identical over an
 * incoming webhook and over `chat.postMessage`.
 */

import type { ExtentReportModel, ExtentStatus, ExtentTest } from '../../reporting/ExtentTypes';
import { humanDuration } from '../../utils/DateUtils';

/* --------------------------------------------------------------- limits -- */

/**
 * Slack's documented maxima (https://docs.slack.dev/reference/block-kit/blocks). They are counted
 * in characters, not bytes, which is why the clamps below work on code points.
 */
export const SLACK_LIMITS = {
  blocksPerMessage: 50,
  headerText: 150,
  sectionText: 3000,
  fieldText: 2000,
  fieldsPerSection: 10,
  contextElements: 10,
  buttonText: 75,
  buttonUrl: 3000,
} as const;

/** Failing tests named inline before the message defers to the full report. */
export const DEFAULT_MAX_FAILURES = 5;

/** One failing test never gets to eat the whole section budget. */
const FAILURE_LINE_LIMIT = 180;

/** Room held back inside a section for its heading and its `+N more` footer. */
const FAILURE_SECTION_RESERVE = 160;

/** A project name is a config value, not free text; this only guards a pathological one. */
const PROJECT_LABEL_LIMIT = 40;

/**
 * Context lines are supporting detail, not the message. Slack allows far more, but a wrapped
 * paragraph of project names would push the counts grid off a phone screen.
 */
const CONTEXT_ELEMENT_LIMIT = 400;

/** The statuses the Extent summary counts as failures — kept in step with the reporter. */
const FAILED_STATUSES: readonly ExtentStatus[] = ['FAIL', 'TIMEOUT', 'INTERRUPTED'];

/* ---------------------------------------------------------------- shapes -- */

export interface SlackPlainText {
  readonly type: 'plain_text';
  readonly text: string;
  readonly emoji?: boolean;
}

export interface SlackMrkdwnText {
  readonly type: 'mrkdwn';
  readonly text: string;
}

export type SlackTextObject = SlackPlainText | SlackMrkdwnText;

/** A header renders `plain_text` only; Slack rejects mrkdwn here, so no bold and no links. */
export interface SlackHeaderBlock {
  readonly type: 'header';
  readonly text: SlackPlainText;
}

export interface SlackSectionBlock {
  readonly type: 'section';
  readonly text?: SlackTextObject;
  readonly fields?: readonly SlackTextObject[];
}

export interface SlackContextBlock {
  readonly type: 'context';
  readonly elements: readonly SlackTextObject[];
}

export interface SlackButtonElement {
  readonly type: 'button';
  readonly text: SlackPlainText;
  readonly url: string;
  readonly action_id: string;
}

export interface SlackActionsBlock {
  readonly type: 'actions';
  readonly elements: readonly SlackButtonElement[];
}

export type SlackBlock =
  SlackHeaderBlock | SlackSectionBlock | SlackContextBlock | SlackActionsBlock;

/**
 * `text` is not decoration: it is the notification and accessibility fallback shown wherever the
 * blocks cannot render, and a webhook rejects a payload that has neither.
 */
export interface SlackMessagePayload {
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
}

export interface SlackMessageOptions {
  readonly model: ExtentReportModel;
  /** Rendered as a link button; omitted when CI publishes nothing to link to. */
  readonly reportUrl?: string;
  readonly maxFailures?: number;
}

/** The run's outcome in one word, plus the emoji shortcode that carries it at a glance. */
export interface RunVerdict {
  readonly icon: string;
  readonly word: string;
}

/* ----------------------------------------------------------- text safety -- */

/**
 * Escapes the three characters Slack reads as markup. Test output is full of them — `expected
 * <Foo />`, `a && b`, an XML snapshot diff — and a stray `<` swallows the rest of the line into a
 * malformed link.
 */
export function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Clamps on code points rather than UTF-16 units: cutting between the halves of a surrogate pair
 * leaves a lone surrogate in the JSON body, which Slack treats as a malformed payload.
 */
export function clampText(value: string, limit: number): string {
  if (limit <= 0) return '';
  const points = [...value];
  if (points.length <= limit) return value;
  return `${points.slice(0, limit - 1).join('')}…`;
}

/**
 * Escapes first, then clamps, then drops a half-written entity from the tail — clamping after
 * escaping is the only order that can never exceed the limit, since `&` grows to five characters.
 */
export function escapeAndClamp(value: string, limit: number): string {
  const clamped = clampText(escapeSlackText(value), limit);
  return clamped.replace(/&[a-z]{0,4}…$/, '…');
}

/* --------------------------------------------------------------- pieces -- */

const mrkdwn = (text: string): SlackMrkdwnText => ({ type: 'mrkdwn', text });

const field = (label: string, value: string): SlackMrkdwnText =>
  mrkdwn(`*${label}*\n${escapeAndClamp(value, SLACK_LIMITS.fieldText - label.length - 4)}`);

/** True for a URL safe to render as a button; anything else is dropped rather than guessed at. */
export function isRenderableUrl(value: string | undefined): value is string {
  if (value === undefined || value.trim().length === 0) return false;
  if ([...value].length > SLACK_LIMITS.buttonUrl) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The failing tests this run produced, in reporter order so the first failure stays first. */
export function failingTests(model: ExtentReportModel): readonly ExtentTest[] {
  return model.tests.filter((test) => FAILED_STATUSES.includes(test.status));
}

/**
 * Names the first few failures and says how many it left out. Dropping the tail silently would
 * misrepresent the run, so the omission is always spelled out as a `+N more` line.
 *
 * `qualify` appends the project on a multi-project run: the same spec failing on chromium and on
 * firefox produces two byte-identical lines otherwise, which reads as a duplicated bullet rather
 * than as two separate failures.
 */
function failureSectionText(
  failures: readonly ExtentTest[],
  maxShown: number,
  qualify: boolean,
): string {
  const budget = SLACK_LIMITS.sectionText - FAILURE_SECTION_RESERVE;
  const lines: string[] = [];
  let used = 0;

  for (const test of failures.slice(0, Math.max(0, maxShown))) {
    /*
     * The project is appended *after* the name is clamped, not before: a long test title would
     * otherwise push the qualifier off the end of the line and leave two bullets looking identical
     * again — the exact confusion it is here to prevent.
     */
    const project =
      qualify && test.project.length > 0
        ? ` [${escapeAndClamp(test.project, PROJECT_LABEL_LIMIT)}]`
        : '';
    const line = `• ${escapeAndClamp(`${test.suite} › ${test.name}`, FAILURE_LINE_LIMIT)}${project}`;
    const cost = [...line].length + 1;
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
  }

  const hidden = failures.length - lines.length;
  const heading = `*Failing tests (${lines.length} of ${failures.length})*`;
  const footer = hidden > 0 ? [`_+${hidden} more — see the full report_`] : [];
  return clampText([heading, ...lines, ...footer].join('\n'), SLACK_LIMITS.sectionText);
}

/**
 * Enforces the 50-block ceiling. This builder emits a handful of blocks, so the guard should never
 * fire — but it exists because a silently dropped block is indistinguishable from a passing run,
 * and because the cap is only *inferred* to apply identically to webhooks and `chat.postMessage`.
 */
export function clampBlocks(blocks: readonly SlackBlock[]): readonly SlackBlock[] {
  if (blocks.length <= SLACK_LIMITS.blocksPerMessage) return blocks;
  const kept = blocks.slice(0, SLACK_LIMITS.blocksPerMessage - 1);
  const dropped = blocks.length - kept.length;
  const notice: SlackContextBlock = {
    type: 'context',
    elements: [mrkdwn(`_+${dropped} more block(s) omitted to stay within Slack's 50-block limit_`)],
  };
  return [...kept, notice];
}

/* --------------------------------------------------------------- builder -- */

/**
 * The run's verdict in one word plus its emoji.
 *
 * A run with no tests is called out rather than folded into "passed": zero failures out of zero
 * tests is what a bad `--grep`, an unknown `--project` or a crashed global setup looks like, and
 * announcing that as a green run is the one message that would teach the channel to trust nothing.
 */
function runVerdict(failed: number, total: number): RunVerdict {
  if (total === 0) return { icon: ':warning:', word: 'reported no tests' };
  return failed === 0
    ? { icon: ':white_check_mark:', word: 'passed' }
    : { icon: ':x:', word: 'failed' };
}

/** Builds the single run-summary message: verdict, counts, context, failures, report link. */
export function buildRunSummaryMessage(options: SlackMessageOptions): SlackMessagePayload {
  const { summary, environment } = options.model;
  const failures = failingTests(options.model);
  const { icon, word: verdict } = runVerdict(summary.failed, summary.total);

  const header: SlackHeaderBlock = {
    type: 'header',
    text: {
      type: 'plain_text',
      emoji: true,
      /* Escaped like every other text object: an environment named "QA <EU>" is not markup. */
      text: escapeAndClamp(
        `${icon} Test run ${verdict} — ${environment.displayName}`,
        SLACK_LIMITS.headerText,
      ),
    },
  };

  /* Fields render as a two-column grid, so they are supplied in pairs. */
  const counts: SlackSectionBlock = {
    type: 'section',
    fields: [
      field('Total', String(summary.total)),
      field('Pass rate', `${summary.passRate}%`),
      field('Passed', String(summary.passed)),
      field('Failed', String(summary.failed)),
      field('Flaky', String(summary.flaky)),
      field('Skipped', String(summary.skipped)),
      field('Duration', humanDuration(summary.durationMs)),
      field('Environment', `${environment.displayName} (${environment.name})`),
    ].slice(0, SLACK_LIMITS.fieldsPerSection),
  };

  const projects = environment.projects.length > 0 ? environment.projects.join(', ') : 'none';
  const context: SlackContextBlock = {
    type: 'context',
    elements: [
      mrkdwn(`*Projects:* ${escapeAndClamp(projects, CONTEXT_ELEMENT_LIMIT)}`),
      mrkdwn(
        escapeAndClamp(
          `Playwright ${environment.playwright} · Node ${environment.node} · ` +
            `${environment.ci ? 'CI' : 'local'} · ${environment.workers} worker(s)`,
          CONTEXT_ELEMENT_LIMIT,
        ),
      ),
    ].slice(0, SLACK_LIMITS.contextElements),
  };

  const blocks: SlackBlock[] = [header, counts, context];

  if (failures.length > 0) {
    blocks.push({
      type: 'section',
      text: mrkdwn(
        failureSectionText(
          failures,
          options.maxFailures ?? DEFAULT_MAX_FAILURES,
          environment.projects.length > 1,
        ),
      ),
    });
  }

  if (isRenderableUrl(options.reportUrl)) {
    /*
     * A `url` button still delivers an interaction payload to the app's Request URL, which a
     * webhook-only app does not have. The link opens regardless; only the app-side acknowledgement
     * is missing, which is why nothing here depends on a response.
     */
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            emoji: false,
            text: clampText('View full report', SLACK_LIMITS.buttonText),
          },
          url: options.reportUrl,
          action_id: 'view_report',
        },
      ],
    });
  }

  const fallback = escapeAndClamp(
    `${environment.displayName}: test run ${verdict} — ${summary.passed}/${summary.total} passed, ` +
      `${summary.failed} failed, ${summary.flaky} flaky, ${summary.skipped} skipped ` +
      `(${summary.passRate}% pass rate in ${humanDuration(summary.durationMs)})`,
    SLACK_LIMITS.sectionText,
  );

  return { text: fallback, blocks: clampBlocks(blocks) };
}
