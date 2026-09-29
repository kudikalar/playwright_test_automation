/**
 * Renders the Extent report model to a self-contained HTML document.
 *
 * Kept separate from the reporter so presentation changes never touch result collection.
 * Nothing sensitive reaches this layer: values are masked before the model is built.
 *
 * Two properties drive every decision below:
 *
 *  1. **Single file.** Styles, script and chart geometry are inlined. The report is opened
 *     straight off disk over `file://` and mailed around as one attachment, so a CDN link or a
 *     web font would leave a client staring at an unstyled page on a locked-down laptop.
 *  2. **Content first.** Tabs and filter controls stay hidden until the script switches them on,
 *     so a script-less viewer gets every section stacked and readable — including the test list —
 *     instead of a blank shell. The donut and the bars animate from CSS keyframes for the same
 *     reason: their final geometry is the element's own resting style, not something JavaScript
 *     has to apply.
 */

import type { IntegrationResult } from '../integrations/IntegrationTypes';
import type {
  ExtentHistoryEntry,
  ExtentReportModel,
  ExtentStatus,
  ExtentSummary,
  ExtentTest,
} from './ExtentTypes';
import { humanDuration } from '../utils/DateUtils';

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The four buckets a reader reasons about; the six raw statuses collapse into them. */
type StatusBucket = 'PASS' | 'FAIL' | 'FLAKY' | 'SKIP';

const STATUS_CLASS: Readonly<Record<ExtentStatus, string>> = {
  PASS: 'pass',
  FAIL: 'fail',
  SKIP: 'skip',
  FLAKY: 'flaky',
  TIMEOUT: 'fail',
  INTERRUPTED: 'fail',
};

/**
 * TIMEOUT and INTERRUPTED are failures everywhere in this document — headline, donut, group
 * tables and filters — so a run can never present two different failure counts.
 */
function bucketOf(status: ExtentStatus): StatusBucket {
  if (status === 'FAIL' || status === 'TIMEOUT' || status === 'INTERRUPTED') return 'FAIL';
  if (status === 'FLAKY') return 'FLAKY';
  if (status === 'SKIP') return 'SKIP';
  return 'PASS';
}

const BUCKET_CLASS: Readonly<Record<StatusBucket, string>> = {
  PASS: 'pass',
  FAIL: 'fail',
  FLAKY: 'flaky',
  SKIP: 'skip',
};

const BUCKET_LABEL: Readonly<Record<StatusBucket, string>> = {
  PASS: 'Passed',
  FAIL: 'Failed',
  FLAKY: 'Flaky',
  SKIP: 'Skipped',
};

const BUCKET_ORDER: readonly StatusBucket[] = ['PASS', 'FAIL', 'FLAKY', 'SKIP'];

interface BucketCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly flaky: number;
  readonly skipped: number;
  /** Skipped tests never ran, so they are not part of any pass-rate denominator. */
  readonly executed: number;
  readonly passRate: number;
}

function countBuckets(tests: readonly ExtentTest[]): BucketCounts {
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  for (const test of tests) {
    const bucket = bucketOf(test.status);
    if (bucket === 'PASS') passed += 1;
    else if (bucket === 'FAIL') failed += 1;
    else if (bucket === 'FLAKY') flaky += 1;
    else skipped += 1;
  }
  const executed = tests.length - skipped;
  return {
    total: tests.length,
    passed,
    failed,
    flaky,
    skipped,
    executed,
    /* Same denominator as the headline KPI so one run cannot show two rates. */
    passRate: executed > 0 ? Math.round(((passed + flaky) / executed) * 100) : 0,
  };
}

/** One decimal, but only when it earns its place — "50%" reads better than "50.0%". */
function formatShare(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const rounded = Math.round((part / whole) * 1000) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/** Screen readers read these labels out loud, so "1 test" must not come out as "1 tests". */
const plural = (count: number): string => (count === 1 ? 'test' : 'tests');

const round2 = (value: number): number => Math.round(value * 100) / 100;

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((a, b) => a.localeCompare(b));

function groupBy(
  tests: readonly ExtentTest[],
  key: 'suite' | 'module' | 'project',
): Map<string, ExtentTest[]> {
  const groups = new Map<string, ExtentTest[]>();
  for (const test of tests) {
    const bucket = groups.get(test[key]) ?? [];
    bucket.push(test);
    groups.set(test[key], bucket);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/* ------------------------------------------------------------------ donut -- */

/*
 * Geometry lives in constants so the arc maths and the SVG markup can never drift apart. The
 * arcs are stroked circles rather than paths: a dash of `length` followed by a gap the size of
 * the whole circle leaves exactly one visible segment, and a negative dash offset rotates it to
 * where it belongs. That makes the draw-in animation a single interpolated dash length.
 */
const DONUT_BOX = 220;
const DONUT_CENTRE = DONUT_BOX / 2;
const DONUT_RADIUS = 84;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
/** Visual separation between neighbouring arcs, in user units. */
const DONUT_GAP = 3;

interface DonutSlice {
  readonly key: StatusBucket;
  readonly count: number;
}

function renderDonut(slices: readonly DonutSlice[], passRate: number, executed: number): string {
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  const visible = slices.filter((slice) => slice.count > 0);
  const gap = visible.length > 1 ? DONUT_GAP : 0;

  const arcs: string[] = [];
  let consumed = 0;
  visible.forEach((slice, index) => {
    const span = (slice.count / total) * DONUT_CIRCUMFERENCE;
    const length = Math.max(span - gap, 1);
    const label = `${BUCKET_LABEL[slice.key]}: ${slice.count} of ${total} ${plural(total)}, ${formatShare(slice.count, total)}. Show only these in the test list.`;
    arcs.push(
      `<circle class="arc ${BUCKET_CLASS[slice.key]}" cx="${DONUT_CENTRE}" cy="${DONUT_CENTRE}" r="${DONUT_RADIUS}"` +
        ` style="--len:${round2(length)};--ring:${round2(DONUT_CIRCUMFERENCE)};--off:${round2(-consumed)};--delay:${index * 130}ms"` +
        ` tabindex="0" role="button" data-filter-status="${slice.key}" aria-label="${escapeHtml(label)}"></circle>`,
    );
    consumed += span;
  });

  const centre =
    total === 0
      ? `<text class="donut-value" x="${DONUT_CENTRE}" y="${DONUT_CENTRE + 4}">&#8212;</text>
         <text class="donut-caption" x="${DONUT_CENTRE}" y="${DONUT_CENTRE + 26}">no tests recorded</text>`
      : `<text class="donut-value" x="${DONUT_CENTRE}" y="${DONUT_CENTRE - 2}">${passRate}%</text>
         <text class="donut-caption" x="${DONUT_CENTRE}" y="${DONUT_CENTRE + 20}">pass rate</text>
         <text class="donut-sub" x="${DONUT_CENTRE}" y="${DONUT_CENTRE + 40}">${executed} executed</text>`;

  return `<svg class="donut" viewBox="0 0 ${DONUT_BOX} ${DONUT_BOX}" role="group" aria-label="Result distribution">
    <g transform="rotate(-90 ${DONUT_CENTRE} ${DONUT_CENTRE})">
      <circle class="donut-track" cx="${DONUT_CENTRE}" cy="${DONUT_CENTRE}" r="${DONUT_RADIUS}"></circle>
      ${arcs.join('')}
    </g>
    <g class="donut-centre" aria-hidden="true">${centre}</g>
  </svg>`;
}

function renderDonutLegend(slices: readonly DonutSlice[]): string {
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  const rows = slices
    .map((slice) => {
      const label = BUCKET_LABEL[slice.key];
      return `<li>
        <button type="button" class="legend-row" data-filter-status="${slice.key}"
          aria-label="${escapeHtml(`${label}: ${slice.count} ${plural(slice.count)}, ${formatShare(slice.count, total)}. Show only these in the test list.`)}">
          <span class="swatch ${BUCKET_CLASS[slice.key]}" aria-hidden="true"></span>
          <span class="legend-label">${label}</span>
          <span class="legend-count ${BUCKET_CLASS[slice.key]}">${slice.count}</span>
          <span class="legend-share">${formatShare(slice.count, total)}</span>
        </button>
      </li>`;
    })
    .join('');
  return `<ul class="legend">${rows}</ul>`;
}

/* ----------------------------------------------------------------- panels -- */

interface KpiOptions {
  readonly tone?: string;
  readonly suffix?: string;
  readonly foot?: string;
}

function renderKpi(label: string, value: number, index: number, options: KpiOptions = {}): string {
  const tone = options.tone ? ` ${options.tone}` : '';
  const suffix = options.suffix ?? '';
  const foot = options.foot ? `<span class="kpi-foot">${escapeHtml(options.foot)}</span>` : '';
  return `<div class="kpi reveal" style="--delay:${index * 60}ms">
    <span class="kpi-label">${escapeHtml(label)}</span>
    <span class="kpi-value${tone}" data-count-to="${value}" data-count-suffix="${escapeHtml(suffix)}">${value}${escapeHtml(suffix)}</span>
    ${foot}
  </div>`;
}

function renderSuiteBars(groups: Map<string, ExtentTest[]>): string {
  if (groups.size === 0) return '<p class="empty">No suites recorded.</p>';
  const rows = [...groups.entries()]
    .map(([name, tests], index) => {
      const counts = countBuckets(tests);
      const segments = BUCKET_ORDER.map((bucket) => {
        const count =
          bucket === 'PASS'
            ? counts.passed
            : bucket === 'FAIL'
              ? counts.failed
              : bucket === 'FLAKY'
                ? counts.flaky
                : counts.skipped;
        if (count === 0) return '';
        const width = formatShare(count, counts.total);
        return `<span class="seg ${BUCKET_CLASS[bucket]}" style="width:${width}" title="${escapeHtml(`${BUCKET_LABEL[bucket]}: ${count}`)}"></span>`;
      }).join('');
      return `<li class="stack-row">
        <span class="stack-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="stack" style="--delay:${index * 70}ms">${segments}</span>
        <span class="stack-meta"><b>${counts.total}</b> ${plural(counts.total)} &middot; ${counts.passRate}% pass</span>
      </li>`;
    })
    .join('');
  return `<ul class="stack-list">${rows}</ul>`;
}

function renderGroupTable(title: string, groups: Map<string, ExtentTest[]>): string {
  if (groups.size === 0) {
    return `<section class="card"><h3>${escapeHtml(title)}</h3><p class="empty">No ${escapeHtml(title.toLowerCase())} data recorded.</p></section>`;
  }
  const rows = [...groups.entries()]
    .map(([name, tests]) => {
      const counts = countBuckets(tests);
      return `<tr>
        <td class="cell-name">${escapeHtml(name)}</td>
        <td class="num">${counts.total}</td>
        <td class="num pass">${counts.passed}</td>
        <td class="num fail">${counts.failed}</td>
        <td class="num flaky">${counts.flaky}</td>
        <td class="num skip">${counts.skipped}</td>
        <td class="cell-rate">
          <div class="bar"><span style="width:${counts.passRate}%"></span></div>
          <small>${counts.passRate}%</small>
        </td>
      </tr>`;
    })
    .join('');

  return `<section class="card">
    <h3>${escapeHtml(title)} breakdown</h3>
    <div class="table-scroll">
      <table class="grid">
        <thead><tr><th>${escapeHtml(title)}</th><th>Total</th><th>Pass</th><th>Fail</th><th>Flaky</th><th>Skip</th><th>Pass rate</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

/**
 * Attachment paths in the model are relative to the run folder that owns the files. A copy of
 * the document rendered anywhere else — `reports/extent/latest.html` sits one level up — must
 * prefix them, or every screenshot, video and trace link resolves to a path that does not exist.
 */
function renderAttachments(test: ExtentTest, assetBase: string): string {
  if (test.attachments.length === 0) return '';
  const images = test.attachments
    .filter((attachment) => attachment.kind === 'screenshot')
    .map(
      (attachment) =>
        `<figure><img loading="lazy" src="${escapeHtml(assetBase + attachment.path)}" alt="${escapeHtml(attachment.name)}" /><figcaption>${escapeHtml(attachment.name)}</figcaption></figure>`,
    )
    .join('');
  const videos = test.attachments
    .filter((attachment) => attachment.kind === 'video')
    .map(
      (attachment) =>
        `<figure><video controls preload="metadata" src="${escapeHtml(assetBase + attachment.path)}"></video><figcaption>${escapeHtml(attachment.name)}</figcaption></figure>`,
    )
    .join('');
  const links = test.attachments
    .filter((attachment) => attachment.kind !== 'screenshot' && attachment.kind !== 'video')
    .map(
      (attachment) =>
        `<a class="chip link" href="${escapeHtml(assetBase + attachment.path)}" target="_blank" rel="noopener">${escapeHtml(attachment.kind)}: ${escapeHtml(attachment.name)}</a>`,
    )
    .join('');
  return `<div class="attachments">${images}${videos}${links ? `<div class="chips">${links}</div>` : ''}</div>`;
}

const STEP_KIND_LABEL = { step: 'step', assertion: 'assert', hook: 'hook' } as const;

function renderSteps(test: ExtentTest): string {
  if (test.steps.length === 0) return '';
  const items = test.steps
    .map((step) => {
      const kind = step.kind ?? 'step';
      const where = step.location
        ? `<span class="step-where">${escapeHtml(step.location)}</span>`
        : '';
      const error = step.error ? `<div class="step-error">${escapeHtml(step.error)}</div>` : '';
      return `<li class="${step.failed ? 'fail' : 'pass'} kind-${kind}" style="--depth:${step.depth}">
          <span class="step-icon" aria-label="${step.failed ? 'failed' : 'passed'}">${step.failed ? '✗' : '✓'}</span>
          <span class="step-kind">${STEP_KIND_LABEL[kind]}</span>
          <span class="step-body"><span class="step-title">${escapeHtml(step.title)}</span>${where}${error}</span>
          <span class="step-time">${humanDuration(step.durationMs)}</span>
        </li>`;
    })
    .join('');
  const failed = test.steps.filter((step) => step.failed).length;
  const header = `<div class="steps-head">${test.steps.length} step(s)${failed > 0 ? ` · ${failed} failed` : ''}</div>`;
  return `${header}<ol class="steps">${items}</ol>`;
}

function renderTest(test: ExtentTest, assetBase: string): string {
  const bucket = bucketOf(test.status);
  const tags = test.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
  const error = test.errorMessage
    ? `<pre class="error">${escapeHtml(test.errorMessage)}${test.errorStack ? `\n\n${escapeHtml(test.errorStack)}` : ''}</pre>`
    : '';
  const annotations = test.annotations
    .map(
      (annotation) =>
        `<span class="chip subtle">${escapeHtml(annotation.type)}: ${escapeHtml(annotation.description)}</span>`,
    )
    .join('');
  /* Pre-computed haystack: the filter script then does one lowercase substring test per row. */
  const haystack = [test.name, test.suite, test.module, test.project, test.file, ...test.tags]
    .join(' ')
    .toLowerCase();

  return `<details class="test ${STATUS_CLASS[test.status]}" data-status="${test.status}" data-bucket="${bucket}" data-suite="${escapeHtml(test.suite)}" data-module="${escapeHtml(test.module)}" data-project="${escapeHtml(test.project)}" data-search="${escapeHtml(haystack)}">
    <summary>
      <span class="badge ${STATUS_CLASS[test.status]}">${test.status}</span>
      <span class="test-name">${escapeHtml(test.name)}</span>
      <span class="meta">${escapeHtml(test.suite)} &middot; ${escapeHtml(test.module)} &middot; ${escapeHtml(test.project)} &middot; ${humanDuration(test.durationMs)}${test.retries > 0 ? ` &middot; ${test.retries} retry(ies)` : ''}</span>
      <span class="tags">${tags}</span>
    </summary>
    <div class="test-body">
      <p class="description">${escapeHtml(test.description)}</p>
      <div class="chips">
        <span class="chip subtle">file: ${escapeHtml(test.file)}</span>
        <span class="chip subtle">started: ${escapeHtml(test.startedAt)}</span>
        <span class="chip subtle">finished: ${escapeHtml(test.finishedAt)}</span>
        ${annotations}
      </div>
      ${renderSteps(test)}
      ${error}
      ${renderAttachments(test, assetBase)}
    </div>
  </details>`;
}

const INTEGRATION_CLASS: Readonly<Record<IntegrationResult['status'], string>> = {
  published: 'pass',
  skipped: 'skip',
  failed: 'fail',
};

/**
 * Optional by design: a run with nothing configured says so instead of inventing rows. The link
 * column is the only outbound URL in the document, and it comes from the model — the report ships
 * no external reference of its own, which is what keeps it working offline.
 */
function renderIntegrations(integrations: readonly IntegrationResult[] | undefined): string {
  if (!integrations || integrations.length === 0) {
    return `<section class="card">
      <h3>Integrations</h3>
      <p class="empty">No integrations configured &mdash; nothing was published for this run.</p>
    </section>`;
  }
  const rows = integrations
    .map(
      (integration) => `<tr>
        <td class="cell-name">${escapeHtml(integration.name)}</td>
        <td><span class="badge ${INTEGRATION_CLASS[integration.status]}">${escapeHtml(integration.status)}</span></td>
        <td class="cell-detail">${escapeHtml(integration.detail)}</td>
        <td class="num">${humanDuration(integration.durationMs)}</td>
        <td>${integration.url ? `<a class="chip link" href="${escapeHtml(integration.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : '<span class="muted">&mdash;</span>'}</td>
      </tr>`,
    )
    .join('');
  return `<section class="card">
    <h3>Integrations</h3>
    <div class="table-scroll">
      <table class="grid">
        <thead><tr><th>Integration</th><th>Status</th><th>Detail</th><th>Duration</th><th>Link</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ trend -- */

/**
 * Pass rate and volume across the recorded runs.
 *
 * Only real recorded runs are drawn. On a first run there is nothing to compare against and the
 * panel says exactly that — a chart built from one point would imply a trend that does not exist.
 */
function renderTrend(history: readonly ExtentHistoryEntry[], current: ExtentSummary): string {
  if (history.length === 0) {
    return `<section class="card">
      <h3>Trend</h3>
      <p class="empty-note">No previous runs recorded yet. After the next run this panel compares
      pass rate, volume and duration against the runs before it.</p>
    </section>`;
  }

  const runs = [...history, { ...current, runId: 'current', finishedAt: current.finishedAt }];
  const maxTotal = Math.max(...runs.map((r) => r.total), 1);

  const bars = runs
    .map((run, index) => {
      const isCurrent = index === runs.length - 1;
      const height = Math.max(3, Math.round((run.total / maxTotal) * 100));
      const failShare = run.total > 0 ? (run.failed / run.total) * 100 : 0;
      const flakyShare = run.total > 0 ? (run.flaky / run.total) * 100 : 0;
      const label = `${new Date(run.finishedAt).toLocaleString()} — ${run.passRate}% pass, ${run.total} tests, ${humanDuration(run.durationMs)}`;
      return `<div class="trend-col${isCurrent ? ' now' : ''}" title="${escapeHtml(label)}" tabindex="0" role="img" aria-label="${escapeHtml(label)}">
        <div class="trend-stack" style="--h:${height}%">
          <span class="seg fail" style="--s:${failShare.toFixed(1)}%"></span>
          <span class="seg flaky" style="--s:${flakyShare.toFixed(1)}%"></span>
        </div>
        <span class="trend-rate">${run.passRate}%</span>
      </div>`;
    })
    .join('');

  const previous = history[history.length - 1];
  const delta = previous ? current.passRate - previous.passRate : 0;
  const deltaText = !previous
    ? ''
    : delta === 0
      ? 'unchanged from the previous run'
      : `${delta > 0 ? '+' : ''}${delta} points vs the previous run`;
  const durationDelta = previous ? current.durationMs - previous.durationMs : 0;

  return `<section class="card">
    <h3>Trend <span class="muted">last ${runs.length} runs</span></h3>
    <div class="trend">${bars}</div>
    <div class="trend-foot">
      <span class="trend-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${escapeHtml(deltaText)}</span>
      ${previous ? `<span class="muted">duration ${durationDelta >= 0 ? '+' : ''}${humanDuration(Math.abs(durationDelta))} vs previous</span>` : ''}
    </div>
    <p class="trend-legend"><span class="key pass"></span>passed <span class="key fail"></span>failed
      <span class="key flaky"></span>flaky — bar height is test volume</p>
  </section>`;
}

/* -------------------------------------------------------- failure analysis -- */

/**
 * Collapses a raw error message to a signature so the same root cause groups together.
 *
 * Ids, timings, quoted values, numbers and file paths are what differ between two reports of the
 * same defect, so they are removed; what remains is the shape of the failure.
 */
function errorSignature(message: string): string {
  return message
    .split('\n')[0]!
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b\d+(\.\d+)?m?s\b/g, '<time>')
    .replace(/["'`][^"'`]{1,80}["'`]/g, '<value>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function renderFailureAnalysis(tests: readonly ExtentTest[]): string {
  const failing = tests.filter(
    (test) => bucketOf(test.status) === 'FAIL' || bucketOf(test.status) === 'FLAKY',
  );
  if (failing.length === 0) {
    return `<section class="card">
      <h3>Failure analysis</h3>
      <p class="empty-note">Nothing failed and nothing was flaky in this run.</p>
    </section>`;
  }

  const clusters = new Map<string, ExtentTest[]>();
  for (const test of failing) {
    const key = test.errorMessage ? errorSignature(test.errorMessage) : 'No error message recorded';
    const bucket = clusters.get(key) ?? [];
    bucket.push(test);
    clusters.set(key, bucket);
  }

  const ordered = [...clusters.entries()].sort(([, a], [, b]) => b.length - a.length);
  const rows = ordered
    .map(
      ([signature, group]) => `<details class="cluster">
      <summary>
        <span class="cluster-n">${group.length}</span>
        <span class="cluster-sig">${escapeHtml(signature)}</span>
        <span class="cluster-meta">${escapeHtml(uniqueSorted(group.map((t) => t.project)).join(', '))}</span>
      </summary>
      <ul class="cluster-tests">
        ${group
          .map(
            (test) =>
              `<li><a href="#test-${escapeHtml(test.id)}"><span class="badge ${STATUS_CLASS[test.status]}">${test.status}</span>${escapeHtml(test.name)}</a>
               <span class="muted">${escapeHtml(test.project)} · ${escapeHtml(test.file)}</span></li>`,
          )
          .join('')}
      </ul>
    </details>`,
    )
    .join('');

  const headline =
    ordered.length === 1 && failing.length > 1
      ? `All ${failing.length} failures share one error signature — likely one root cause.`
      : `${failing.length} failing or flaky test${failing.length === 1 ? '' : 's'} across ${ordered.length} distinct error${ordered.length === 1 ? '' : 's'}.`;

  return `<section class="card">
    <h3>Failure analysis</h3>
    <p class="analysis-headline">${escapeHtml(headline)}</p>
    <div class="clusters">${rows}</div>
  </section>`;
}

/* ------------------------------------------------------------- slowest -- */

function renderSlowest(tests: readonly ExtentTest[]): string {
  const executed = tests.filter((test) => test.status !== 'SKIP');
  if (executed.length === 0) {
    return `<section class="card"><h3>Slowest tests</h3>
      <p class="empty-note">Nothing executed in this run.</p></section>`;
  }
  const top = [...executed].sort((a, b) => b.durationMs - a.durationMs).slice(0, 12);
  const max = top[0]?.durationMs ?? 1;
  const totalMs = executed.reduce((sum, test) => sum + test.durationMs, 0);

  return `<section class="card">
    <h3>Slowest tests <span class="muted">top ${top.length} of ${executed.length}</span></h3>
    <div class="slow">
      ${top
        .map(
          (test) => `<a class="slow-row" href="#test-${escapeHtml(test.id)}">
        <span class="slow-name">${escapeHtml(test.name)}</span>
        <span class="slow-bar"><span style="width:${Math.max(2, Math.round((test.durationMs / max) * 100))}%"></span></span>
        <span class="slow-time">${humanDuration(test.durationMs)}</span>
        <span class="slow-share">${formatShare(test.durationMs, totalMs)}</span>
      </a>`,
        )
        .join('')}
    </div>
  </section>`;
}

/* ------------------------------------------------------------ timeline -- */

/** Per-worker execution timeline, drawn from the real start and finish of each attempt. */
function renderTimeline(tests: readonly ExtentTest[], summary: ExtentSummary): string {
  const runStart = new Date(summary.startedAt).getTime();
  const runEnd = new Date(summary.finishedAt).getTime();
  const span = Math.max(runEnd - runStart, 1);

  const byWorker = new Map<number, ExtentTest[]>();
  for (const test of tests) {
    if (test.status === 'SKIP') continue;
    const bucket = byWorker.get(test.workerIndex) ?? [];
    bucket.push(test);
    byWorker.set(test.workerIndex, bucket);
  }
  if (byWorker.size === 0) {
    return `<section class="card"><h3>Execution timeline</h3>
      <p class="empty-note">Nothing executed in this run.</p></section>`;
  }

  const lanes = [...byWorker.entries()].sort(([a], [b]) => a - b);
  const busiest = Math.max(...lanes.map(([, list]) => list.reduce((s, t) => s + t.durationMs, 0)));

  const rows = lanes
    .map(([worker, list]) => {
      const busy = list.reduce((sum, test) => sum + test.durationMs, 0);
      const blocks = list
        .map((test) => {
          const start = new Date(test.startedAt).getTime() - runStart;
          const left = Math.max(0, (start / span) * 100);
          const width = Math.max(0.35, (test.durationMs / span) * 100);
          const label = `${test.name} — ${humanDuration(test.durationMs)} (${test.status})`;
          return `<a class="tl-block ${STATUS_CLASS[test.status]}" href="#test-${escapeHtml(test.id)}"
            style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${escapeHtml(label)}"
            aria-label="${escapeHtml(label)}"></a>`;
        })
        .join('');
      return `<div class="tl-row">
        <span class="tl-label">worker ${worker}</span>
        <span class="tl-track">${blocks}</span>
        <span class="tl-busy">${Math.round((busy / span) * 100)}%</span>
      </div>`;
    })
    .join('');

  return `<section class="card">
    <h3>Execution timeline <span class="muted">${lanes.length} worker${lanes.length === 1 ? '' : 's'} · ${humanDuration(span)} wall clock</span></h3>
    <div class="timeline">${rows}</div>
    <p class="tl-foot">Each bar is one test, positioned at its real start time. The percentage is
    how much of the wall clock that worker spent running tests — low numbers mean the run was
    waiting rather than working. Busiest worker: ${humanDuration(busiest)}.</p>
  </section>`;
}

interface TabSpec {
  readonly id: string;
  readonly label: string;
  readonly badge?: string;
  readonly body: string;
}

function renderTabs(specs: readonly TabSpec[]): string {
  const buttons = specs
    .map(
      (spec, index) =>
        `<button type="button" role="tab" id="tab-${spec.id}" aria-controls="panel-${spec.id}"
          aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${escapeHtml(spec.label)}${
            spec.badge ? `<span class="tab-badge">${escapeHtml(spec.badge)}</span>` : ''
          }</button>`,
    )
    .join('');
  const panels = specs
    .map(
      (
        spec,
      ) => `<section class="panel" id="panel-${spec.id}" role="tabpanel" aria-labelledby="tab-${spec.id}" tabindex="0">
        <h2 class="panel-title">${escapeHtml(spec.label)}</h2>
        ${spec.body}
      </section>`,
    )
    .join('');
  /* The tablist is hidden until the script wires it up: without JavaScript every panel stays
     visible and stacked, which is a usable report rather than a dead set of buttons. */
  return `<div class="tabs" data-tabs>
    <div class="tablist" role="tablist" aria-label="Report sections" hidden>${buttons}</div>
    ${panels}
  </div>`;
}

/* ------------------------------------------------------------------ shell -- */

const REPORT_STYLES = `
:root{
  color-scheme:light dark;
  --bg:#f3f5f9; --panel:#fff; --panel-alt:#f8fafc; --ink:#0f172a; --ink-soft:#334155;
  --muted:#64748b; --line:#e4e8ef; --line-strong:#cbd5e1; --track:#e7ebf3;
  --pass:#16794f; --fail:#c62828; --flaky:#b26a00; --skip:#64748b; --brand:#2f5bea;
  --pass-bg:#e9f5ef; --fail-bg:#fdecec; --flaky-bg:#fdf2e2; --skip-bg:#eef1f6; --brand-bg:#eef2ff;
  --shadow:0 1px 2px rgba(15,23,42,.05),0 12px 28px -22px rgba(15,23,42,.45);
  --radius:14px; --ease:cubic-bezier(.22,.61,.36,1);
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#080d18; --panel:#101728; --panel-alt:#151d31; --ink:#e8eefc; --ink-soft:#c3cee3;
    --muted:#8fa0bd; --line:#1e2941; --line-strong:#2c3a57; --track:#1a2438;
    --pass:#3ecf8e; --fail:#ff7a70; --flaky:#f0b03e; --skip:#93a3bf; --brand:#8aa4ff;
    --pass-bg:#11291f; --fail-bg:#2b1718; --flaky-bg:#2a2211; --skip-bg:#1a2233; --brand-bg:#19203a;
    --shadow:0 1px 2px rgba(0,0,0,.45),0 16px 32px -24px #000;
  }
}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px;border-radius:6px}
.wrap{max-width:1280px;margin:0 auto;padding:0 24px}
.muted{color:var(--muted)}
.empty{color:var(--muted);font-size:14px;margin:2px 0;padding:14px 0}

/* ---- masthead ---- */
header.top{background:linear-gradient(135deg,#0a1121 0%,#16203a 55%,#1d2a49 100%);color:#e9eefb;
  padding:28px 0 24px;border-bottom:1px solid rgba(255,255,255,.07)}
header.top .row{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;justify-content:space-between}
header.top h1{margin:0;font-size:23px;font-weight:650;letter-spacing:-.015em}
header.top .sub{margin:7px 0 0;color:#9db0d2;font-size:13px}
header.top .stamp{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px}
header.top .stamp span{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.09);
  border-radius:999px;padding:3px 11px;font-size:12px;color:#c6d3ea}
.verdict{display:inline-flex;align-items:center;gap:9px;border-radius:999px;padding:9px 18px;
  font-size:14px;font-weight:650;border:1px solid transparent;white-space:nowrap}
.verdict::before{content:"";width:9px;height:9px;border-radius:50%;background:currentColor}
.verdict.pass{background:rgba(62,207,142,.13);color:#5fe0a6;border-color:rgba(62,207,142,.3)}
.verdict.fail{background:rgba(255,122,112,.13);color:#ff9a92;border-color:rgba(255,122,112,.32)}
.verdict.flaky{background:rgba(240,176,62,.13);color:#f4c268;border-color:rgba(240,176,62,.3)}
.verdict.skip{background:rgba(147,163,191,.13);color:#b6c3da;border-color:rgba(147,163,191,.28)}

/* ---- cards ---- */
main{padding-bottom:64px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:18px;box-shadow:var(--shadow)}
.card+.card{margin-top:16px}
.card h3{margin:0 0 14px;font-size:11.5px;font-weight:700;letter-spacing:.09em;
  text-transform:uppercase;color:var(--muted)}
.table-scroll{overflow-x:auto;margin:0 -4px;padding:0 4px}

/* ---- tabs ---- */
.tabs{padding-top:18px}
.tablist{display:flex;gap:4px;overflow-x:auto;scrollbar-width:thin;
  background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:5px;
  box-shadow:var(--shadow);position:sticky;top:12px;z-index:5;margin-bottom:18px}
.tablist button{appearance:none;border:0;background:transparent;color:var(--muted);font:inherit;
  font-size:13.5px;font-weight:600;padding:8px 16px;border-radius:999px;cursor:pointer;
  white-space:nowrap;display:inline-flex;align-items:center;gap:7px;
  transition:background .18s var(--ease),color .18s var(--ease)}
.tablist button:hover{color:var(--ink);background:var(--panel-alt)}
.tablist button[aria-selected="true"]{background:var(--brand);color:#fff}
.tab-badge{background:var(--brand-bg);color:var(--brand);border-radius:999px;padding:1px 8px;
  font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}
.tablist button[aria-selected="true"] .tab-badge{background:rgba(255,255,255,.22);color:#fff}
.panel{margin-bottom:20px}
.panel-title{margin:0 0 12px;font-size:17px;font-weight:650;letter-spacing:-.01em}
.tabs--ready .panel{margin-bottom:0}
.sr-only,.tabs--ready .panel-title{position:absolute;width:1px;height:1px;margin:-1px;padding:0;
  overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.tabs--ready .panel:focus-visible{outline-offset:6px}

/* ---- overview ---- */
.overview{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:16px;align-items:start}
.overview-side{display:grid;gap:16px}
/* Explicit column counts rather than auto-fit: six tiles must never land as a row of five and
   a lonely orphan, which is what an intrinsic track size produces at common widths. */
.kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:14px 16px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:3px}
.kpi-label{color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.kpi-value{font-size:29px;font-weight:680;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.15}
.kpi-foot{color:var(--muted);font-size:11.5px}
.pass{color:var(--pass)}.fail{color:var(--fail)}.flaky{color:var(--flaky)}.skip{color:var(--skip)}

/* ---- donut ---- */
.donut-card{display:flex;flex-direction:column;gap:10px}
.donut{width:100%;max-width:280px;margin:2px auto 6px;display:block;overflow:visible}
.donut-track{fill:none;stroke:var(--track);stroke-width:24}
.arc{fill:none;stroke-width:24;stroke-linecap:butt;cursor:pointer;
  stroke-dasharray:var(--len) var(--ring);stroke-dashoffset:var(--off);
  animation:arc-draw 1s var(--ease) var(--delay) both;
  transition:stroke-width .2s var(--ease),opacity .2s var(--ease)}
.arc:hover,.arc:focus-visible{stroke-width:30}
.arc:focus-visible{outline:2px solid var(--brand);outline-offset:4px}
.arc.pass{stroke:var(--pass)}.arc.fail{stroke:var(--fail)}
.arc.flaky{stroke:var(--flaky)}.arc.skip{stroke:var(--skip)}
@keyframes arc-draw{from{stroke-dasharray:0 var(--ring)}}
.donut-centre text{text-anchor:middle;fill:var(--ink);font-family:inherit}
.donut-value{font-size:38px;font-weight:680;letter-spacing:-.03em}
.donut-caption{font-size:12px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;fill:var(--muted)}
.donut-sub{font-size:12px;fill:var(--muted)}
.legend{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.legend-row{display:grid;grid-template-columns:12px 1fr auto auto;align-items:center;gap:10px;
  width:100%;border:0;background:transparent;font:inherit;font-size:13.5px;color:var(--ink);
  padding:8px 10px;border-radius:9px;cursor:pointer;text-align:left;
  transition:background .16s var(--ease)}
.legend-row:hover{background:var(--panel-alt)}
.swatch{width:11px;height:11px;border-radius:3px;display:inline-block}
.swatch.pass{background:var(--pass)}.swatch.fail{background:var(--fail)}
.swatch.flaky{background:var(--flaky)}.swatch.skip{background:var(--skip)}
.legend-label{color:var(--ink-soft)}
.legend-count{font-weight:700;font-variant-numeric:tabular-nums}
.legend-share{color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums;min-width:46px;text-align:right}

/* ---- run facts ---- */
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin:0}
.facts>div{display:flex;flex-direction:column;gap:2px;min-width:0}
.facts dt{color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase}
.facts dd{margin:0;font-size:14px;font-weight:600;overflow-wrap:anywhere}

/* ---- suite bars ---- */
.stack-list{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.stack-row{display:grid;grid-template-columns:minmax(90px,150px) 1fr auto;gap:14px;align-items:center}
.stack-name{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stack{display:flex;height:12px;border-radius:999px;overflow:hidden;background:var(--track);
  transform-origin:left center;animation:bar-grow .8s var(--ease) var(--delay) both}
.stack .seg{display:block;height:100%}
.seg.pass{background:var(--pass)}.seg.fail{background:var(--fail)}
.seg.flaky{background:var(--flaky)}.seg.skip{background:var(--skip)}
.stack-meta{color:var(--muted);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
.stack-meta b{color:var(--ink);font-weight:650}
@keyframes bar-grow{from{transform:scaleX(0);opacity:.35}}

/* ---- tables ---- */
table.grid{width:100%;border-collapse:collapse;font-size:13.5px}
table.grid th,table.grid td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
table.grid tbody tr:last-child td{border-bottom:0}
table.grid thead th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
  font-weight:700;border-bottom:1px solid var(--line-strong)}
table.grid tbody tr:hover{background:var(--panel-alt)}
.cell-name{font-weight:600}
.cell-detail{color:var(--ink-soft);max-width:520px}
td.num{font-variant-numeric:tabular-nums;font-weight:650;white-space:nowrap}
.cell-rate{display:flex;align-items:center;gap:9px;min-width:150px}
.bar{background:var(--track);border-radius:999px;height:7px;overflow:hidden;flex:1;min-width:80px}
.bar span{display:block;height:100%;background:var(--pass);
  transform-origin:left center;animation:bar-grow .8s var(--ease) both}
.cell-rate small{color:var(--muted);font-variant-numeric:tabular-nums;min-width:34px;text-align:right}
table.env th{width:200px;color:var(--muted);font-weight:600;vertical-align:top}
table.env td{overflow-wrap:anywhere}

/* ---- test toolbar ---- */
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.search{flex:1 1 260px;min-width:200px;position:relative;display:flex}
.search input{width:100%;font:inherit;font-size:13.5px;color:var(--ink);background:var(--panel);
  border:1px solid var(--line-strong);border-radius:10px;padding:9px 13px}
.search input::placeholder{color:var(--muted)}
.search input:focus-visible{outline:2px solid var(--brand);outline-offset:1px;border-color:var(--brand)}
.toolbar select{font:inherit;font-size:13px;color:var(--ink);background:var(--panel);
  border:1px solid var(--line-strong);border-radius:10px;padding:9px 11px;max-width:220px}
.pills{display:flex;gap:6px;flex-wrap:wrap}
.pills button{border:1px solid var(--line-strong);background:var(--panel);color:var(--ink-soft);
  border-radius:999px;padding:7px 14px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;
  transition:background .16s var(--ease),color .16s var(--ease),border-color .16s var(--ease)}
.pills button:hover{border-color:var(--brand);color:var(--brand)}
.pills button[aria-pressed="true"]{background:var(--brand);border-color:var(--brand);color:#fff}
.link-btn{border:0;background:transparent;color:var(--brand);font:inherit;font-size:12.5px;
  font-weight:600;cursor:pointer;padding:7px 4px;text-decoration:underline}
.result-count{color:var(--muted);font-size:12.5px;margin:0 0 12px;font-variant-numeric:tabular-nums}

/* ---- test rows ---- */
.test{background:var(--panel);border:1px solid var(--line);border-left-width:3px;
  border-radius:11px;margin-bottom:8px;box-shadow:var(--shadow)}
.test.pass{border-left-color:var(--pass)}.test.fail{border-left-color:var(--fail)}
.test.skip{border-left-color:var(--skip)}.test.flaky{border-left-color:var(--flaky)}
.test summary{cursor:pointer;padding:12px 15px;display:flex;gap:11px;align-items:center;
  flex-wrap:wrap;list-style:none;border-radius:9px}
.test summary::-webkit-details-marker{display:none}
.test summary::after{content:"";width:7px;height:7px;border-right:2px solid var(--muted);
  border-bottom:2px solid var(--muted);transform:rotate(-45deg);margin-left:6px;
  transition:transform .2s var(--ease)}
.test[open] summary::after{transform:rotate(45deg)}
.badge{font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;
  border:1px solid transparent;text-transform:uppercase}
.badge.pass{background:var(--pass-bg);color:var(--pass);border-color:var(--pass)}
.badge.fail{background:var(--fail-bg);color:var(--fail);border-color:var(--fail)}
.badge.skip{background:var(--skip-bg);color:var(--skip);border-color:var(--skip)}
.badge.flaky{background:var(--flaky-bg);color:var(--flaky);border-color:var(--flaky)}
.test-name{font-weight:620;font-size:14px}
.meta{color:var(--muted);font-size:12px}
.tags{margin-left:auto;display:flex;gap:5px;flex-wrap:wrap}
.tag{background:var(--brand-bg);color:var(--brand);border-radius:999px;padding:2px 9px;
  font-size:11px;font-weight:650}
.test-body{padding:2px 15px 16px;border-top:1px solid var(--line)}
.description{color:var(--muted);font-size:13px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.chip{display:inline-block;background:var(--panel-alt);border:1px solid var(--line);border-radius:7px;
  padding:3px 10px;font-size:12px;color:var(--ink-soft);text-decoration:none}
.chip.subtle{color:var(--muted)}
.chip.link{color:var(--brand);border-color:var(--brand);font-weight:600}
ol.steps{list-style:none;margin:10px 0;padding:0;font-size:13px}
ol.steps li{display:flex;gap:10px;padding:5px 0 5px calc(var(--depth) * 16px);
  border-bottom:1px dashed var(--line)}
ol.steps li.fail .step-title{color:var(--fail);font-weight:650}
.steps-head{font-size:12px;color:var(--muted);margin-top:10px}
.step-icon{width:1em;text-align:center;color:var(--pass)}
ol.steps li.fail .step-icon{color:var(--fail)}
.step-kind{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);
  border:1px solid var(--line);border-radius:4px;padding:0 4px;height:fit-content;min-width:44px;text-align:center}
ol.steps li.kind-assertion .step-title{font-style:italic}
.step-body{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.step-where{font-size:11px;color:var(--muted);font-family:ui-monospace,monospace;overflow-wrap:anywhere}
.step-error{font-size:12px;color:var(--fail);font-family:ui-monospace,monospace;overflow-wrap:anywhere;
  white-space:pre-wrap;margin-top:2px}
.step-title{flex:1;overflow-wrap:anywhere}
.step-time{color:var(--muted);font-variant-numeric:tabular-nums}
pre.error{background:var(--fail-bg);border:1px solid var(--fail);color:var(--fail);padding:13px;
  border-radius:10px;overflow:auto;font-size:12.5px;line-height:1.5;white-space:pre-wrap;
  overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.attachments{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;margin-top:12px}
.attachments figure{margin:0;max-width:420px;flex:1 1 320px}
.attachments img,.attachments video{width:100%;border:1px solid var(--line);border-radius:10px;display:block}
.attachments figcaption{color:var(--muted);font-size:12px;margin-top:5px}

footer{color:var(--muted);font-size:12px;text-align:center;padding:26px 24px 34px}

/* ---- motion + responsive ---- */
.reveal{animation:rise .5s var(--ease) var(--delay,0ms) both}
@keyframes rise{from{opacity:0;transform:translateY(10px)}}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-delay:0ms!important;
    transition-duration:.001ms!important;scroll-behavior:auto!important}
}
@media (min-width:1240px){.kpis{grid-template-columns:repeat(6,minmax(0,1fr))}}
@media (max-width:900px){
  .overview{grid-template-columns:1fr}
  .stack-row{grid-template-columns:1fr;gap:6px}
  .stack-meta{justify-self:start}
}
@media (max-width:560px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:620px){
  .wrap{padding:0 14px}
  header.top h1{font-size:19px}
  .kpi-value{font-size:25px}
  .tablist{border-radius:12px;top:0}
  .tags{margin-left:0;width:100%}
  .facts{grid-template-columns:1fr 1fr}
}
.top-right{display:flex;flex-direction:column;align-items:flex-end;gap:10px}
.toolbar{display:flex;gap:6px;flex-wrap:wrap}
.toolbar button{font:inherit;font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:5px 10px;
  border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--muted);
  cursor:pointer;transition:border-color .16s,color .16s,background .16s}
.toolbar button:hover{border-color:var(--brand);color:var(--brand);background:var(--brand-bg)}
.toolbar button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}

/* ---- trend ---- */
.trend{display:flex;align-items:flex-end;gap:4px;height:132px;padding:10px 0 0;overflow-x:auto;
  justify-content:flex-start}
/* Capped so a two-run history reads as a chart rather than two slabs filling the card. */
.trend-col{flex:1 1 14px;min-width:14px;max-width:46px;display:flex;flex-direction:column;align-items:center;
  justify-content:flex-end;gap:5px;height:100%;border-radius:4px;padding:2px}
.trend-col:hover,.trend-col:focus-visible{background:var(--panel-alt);outline:none}
.trend-col.now .trend-rate{color:var(--brand);font-weight:700}
.trend-stack{width:100%;height:var(--h);min-height:3px;background:var(--pass);border-radius:3px 3px 0 0;
  display:flex;flex-direction:column;justify-content:flex-start;overflow:hidden}
.trend-stack .seg{display:block;width:100%;height:var(--s)}
.trend-stack .seg.fail{background:var(--fail)}
.trend-stack .seg.flaky{background:var(--flaky)}
.trend-rate{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.trend-foot{display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;margin-top:12px;
  font-size:13px;color:var(--muted)}
.trend-delta{font-weight:600;color:var(--ink)}
.trend-delta.up{color:var(--pass)} .trend-delta.down{color:var(--fail)}
.trend-legend{margin-top:8px;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.key{width:9px;height:9px;border-radius:2px;display:inline-block}
.key.pass{background:var(--pass)} .key.fail{background:var(--fail)} .key.flaky{background:var(--flaky)}

/* ---- failure analysis ---- */
.analysis-headline{font-size:14.5px;color:var(--ink);margin:0 0 14px}
.clusters{display:grid;gap:8px}
.cluster{border:1px solid var(--line);border-left:3px solid var(--fail);border-radius:0 6px 6px 0;
  background:var(--panel)}
.cluster>summary{display:flex;gap:10px;align-items:baseline;padding:10px 13px;cursor:pointer;
  list-style:none;flex-wrap:wrap}
.cluster>summary::-webkit-details-marker{display:none}
.cluster-n{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:700;color:#fff;background:var(--fail);
  border-radius:9px;padding:1px 8px;flex:none}
.cluster-sig{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--ink);word-break:break-word;flex:1 1 320px}
.cluster-meta{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;color:var(--muted);margin-left:auto}
.cluster-tests{margin:0;padding:0 13px 12px 13px;list-style:none;display:grid;gap:6px}
.cluster-tests li{display:flex;gap:9px;align-items:baseline;flex-wrap:wrap;font-size:13px}
.cluster-tests a{display:flex;gap:8px;align-items:baseline;text-decoration:none;color:var(--ink)}
.cluster-tests a:hover{color:var(--brand)}

/* ---- slowest ---- */
.slow{display:grid;gap:5px}
.slow-row{display:grid;grid-template-columns:minmax(140px,1fr) 120px 62px 46px;gap:11px;
  align-items:center;text-decoration:none;color:inherit;padding:4px 6px;border-radius:5px}
.slow-row:hover{background:var(--panel-alt)}
.slow-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slow-bar{height:7px;background:var(--panel-alt);border-radius:4px;overflow:hidden}
.slow-bar span{display:block;height:100%;background:var(--brand);border-radius:4px}
.slow-time,.slow-share{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--muted);text-align:right;
  font-variant-numeric:tabular-nums}

/* ---- timeline ---- */
.timeline{display:grid;gap:5px;margin-top:6px}
.tl-row{display:grid;grid-template-columns:76px 1fr 46px;gap:10px;align-items:center}
.tl-label{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;color:var(--muted)}
.tl-track{position:relative;height:17px;background:var(--panel-alt);border-radius:4px;overflow:hidden}
.tl-block{position:absolute;top:2px;bottom:2px;border-radius:2px;background:var(--pass);
  min-width:2px;display:block}
.tl-block.fail{background:var(--fail)} .tl-block.flaky{background:var(--flaky)}
.tl-block.skip{background:var(--skip)}
.tl-block:hover{outline:1px solid var(--ink);z-index:2}
.tl-busy{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;color:var(--muted);text-align:right;
  font-variant-numeric:tabular-nums}
.tl-foot{margin-top:11px;font-size:12.5px;color:var(--muted);max-width:76ch}
.empty-note{color:var(--muted);font-size:13.5px;margin:0}
h3 .muted{font-weight:400;font-size:.78em}

@media print{
  body{background:#fff}
  .tablist,.toolbar{display:none!important}
  .panel[hidden]{display:block!important}
  .tabs--ready .panel-title{position:static;width:auto;height:auto;clip:auto;margin:0 0 12px}
  .card,.kpi,.test{box-shadow:none;break-inside:avoid}
  .cluster,.slow-row,.tl-row{break-inside:avoid}
  .trend-col,.tl-block{print-color-adjust:exact;-webkit-print-color-adjust:exact}
  .skel-b,.timeline{max-height:none;overflow:visible}
}`;

/*
 * Written as a plain ES5-style IIFE on purpose: it is inlined into the document, so it must run
 * in whatever browser a client opens the file with, and it must not depend on any build step.
 * Every value it reads comes from a data attribute — no run data is ever interpolated into this
 * script, which keeps the escaping story to exactly one function.
 */
const REPORT_SCRIPT = `
(function () {
  'use strict';
  var reduceMotion =
    !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var toArray = function (nodes) { return Array.prototype.slice.call(nodes); };

  /* ---- export: CSV and JSON, built from the embedded payload ---- */
  var payload = null;
  var dataNode = document.getElementById('report-data');
  if (dataNode) { try { payload = JSON.parse(dataNode.textContent || 'null'); } catch (e) { payload = null; } }

  var save = function (text, mime, name) {
    try {
      var blob = new Blob([text], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch (e) { return false; }
  };

  var csvCell = function (value) {
    var s = value === null || value === undefined ? '' : String(value);
    /* A leading =, +, - or @ is executed as a formula by spreadsheet apps — neutralise it. */
    if (/^[=+\\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };

  toArray(document.querySelectorAll('[data-export]')).forEach(function (button) {
    button.addEventListener('click', function () {
      if (!payload) { button.textContent = 'No data'; return; }
      var kind = button.getAttribute('data-export');
      var stamp = (payload.runId || 'run');
      var ok;
      if (kind === 'json') {
        ok = save(JSON.stringify(payload, null, 2), 'application/json', 'report-' + stamp + '.json');
      } else {
        var cols = ['id','name','suite','module','project','file','status','durationMs','retries','workerIndex','tags','error'];
        var lines = [cols.join(',')];
        payload.tests.forEach(function (t) {
          lines.push(cols.map(function (c) {
            return csvCell(c === 'tags' ? (t.tags || []).join(' ') : t[c]);
          }).join(','));
        });
        /* BOM so Excel opens UTF-8 test names correctly. */
        ok = save('\\ufeff' + lines.join('\\r\\n'), 'text/csv;charset=utf-8', 'report-' + stamp + '.csv');
      }
      var original = button.textContent;
      button.textContent = ok ? 'Saved' : 'Blocked';
      setTimeout(function () { button.textContent = original; }, 1500);
    });
  });

  var printButton = document.querySelector('[data-print]');
  if (printButton) printButton.addEventListener('click', function () { window.print(); });

  /* ---- KPI tiles count up from zero; the final value is already in the DOM for no-JS ---- */
  toArray(document.querySelectorAll('[data-count-to]')).forEach(function (el) {
    var target = Number(el.getAttribute('data-count-to'));
    var suffix = el.getAttribute('data-count-suffix') || '';
    if (!isFinite(target)) return;
    if (reduceMotion) { el.textContent = String(target) + suffix; return; }
    var origin = 0;
    el.textContent = '0' + suffix;
    var step = function (now) {
      if (!origin) origin = now;
      var progress = Math.min(1, (now - origin) / 900);
      var eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = String(Math.round(target * eased)) + suffix;
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  /* ---- tabs ---- */
  var tabsRoot = document.querySelector('[data-tabs]');
  var tabs = tabsRoot ? toArray(tabsRoot.querySelectorAll('[role="tab"]')) : [];

  function selectTab(tab, moveFocus) {
    tabs.forEach(function (other) {
      var active = other === tab;
      other.setAttribute('aria-selected', active ? 'true' : 'false');
      other.tabIndex = active ? 0 : -1;
      var panel = document.getElementById(other.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
    });
    if (moveFocus) tab.focus();
  }

  if (tabsRoot && tabs.length) {
    var list = tabsRoot.querySelector('[role="tablist"]');
    if (list) list.hidden = false;
    tabsRoot.classList.add('tabs--ready');
    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () { selectTab(tab, false); });
      tab.addEventListener('keydown', function (event) {
        var next = null;
        if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
        else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
        else if (event.key === 'Home') next = tabs[0];
        else if (event.key === 'End') next = tabs[tabs.length - 1];
        if (!next) return;
        event.preventDefault();
        selectTab(next, true);
      });
    });
    /* A deep link such as latest.html#panel-tests opens on that section. */
    var requested = window.location.hash.replace('#', '');
    var opening = tabs.filter(function (tab) {
      return tab.getAttribute('aria-controls') === requested || tab.id === requested;
    })[0];
    selectTab(opening || tabs[0], false);
  }

  /* ---- test filtering ---- */
  var testList = document.getElementById('testList');
  if (!testList) return;

  var items = toArray(testList.querySelectorAll('.test'));
  var countEl = document.getElementById('resultCount');
  var emptyEl = document.getElementById('noMatches');
  var searchEl = document.getElementById('testSearch');
  var suiteEl = document.getElementById('suiteFilter');
  var projectEl = document.getElementById('projectFilter');
  var toolbar = document.getElementById('testToolbar');
  var statusButtons = toArray(document.querySelectorAll('[data-status-filter]'));
  var state = { status: 'ALL', suite: 'ALL', project: 'ALL', text: '' };

  if (toolbar) toolbar.hidden = false;

  function matches(el) {
    if (state.status !== 'ALL' && el.getAttribute('data-bucket') !== state.status) return false;
    if (state.suite !== 'ALL' && el.getAttribute('data-suite') !== state.suite) return false;
    if (state.project !== 'ALL' && el.getAttribute('data-project') !== state.project) return false;
    if (state.text && (el.getAttribute('data-search') || '').indexOf(state.text) === -1) return false;
    return true;
  }

  function apply() {
    var shown = 0;
    items.forEach(function (el) {
      var visible = matches(el);
      el.hidden = !visible;
      if (visible) shown += 1;
    });
    if (countEl) {
      countEl.textContent =
        'Showing ' + shown + ' of ' + items.length + (items.length === 1 ? ' test' : ' tests');
    }
    if (emptyEl) emptyEl.hidden = shown !== 0;
    statusButtons.forEach(function (button) {
      var on = button.getAttribute('data-status-filter') === state.status;
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function setStatus(next) { state.status = next; apply(); }

  statusButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      setStatus(button.getAttribute('data-status-filter'));
    });
  });
  if (searchEl) {
    searchEl.addEventListener('input', function () {
      state.text = searchEl.value.trim().toLowerCase();
      apply();
    });
  }
  if (suiteEl) {
    suiteEl.addEventListener('change', function () { state.suite = suiteEl.value; apply(); });
  }
  if (projectEl) {
    projectEl.addEventListener('change', function () { state.project = projectEl.value; apply(); });
  }
  var resetEl = document.getElementById('resetFilters');
  if (resetEl) {
    resetEl.addEventListener('click', function () {
      state = { status: 'ALL', suite: 'ALL', project: 'ALL', text: '' };
      if (searchEl) searchEl.value = '';
      if (suiteEl) suiteEl.value = 'ALL';
      if (projectEl) projectEl.value = 'ALL';
      apply();
    });
  }

  /* ---- donut slices and legend rows are shortcuts into the filtered list ---- */
  toArray(document.querySelectorAll('[data-filter-status]')).forEach(function (el) {
    var activate = function () {
      setStatus(el.getAttribute('data-filter-status'));
      var testsTab = document.getElementById('tab-tests');
      if (testsTab && tabs.length) selectTab(testsTab, false);
      var panel = document.getElementById('panel-tests');
      if (panel && panel.scrollIntoView) {
        panel.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
      }
    };
    el.addEventListener('click', activate);
    /* Native buttons already turn Enter/Space into a click; the SVG arcs do not. */
    if (el.tagName.toLowerCase() !== 'button') {
      el.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          activate();
        }
      });
    }
  });

  apply();
})();`;

/* ------------------------------------------------------------------ entry -- */

export function renderExtentHtml(model: ExtentReportModel, assetBase = ''): string {
  const { summary, environment, tests } = model;
  const executed = summary.total - summary.skipped;

  const slices: readonly DonutSlice[] = [
    { key: 'PASS', count: summary.passed },
    { key: 'FAIL', count: summary.failed },
    { key: 'FLAKY', count: summary.flaky },
    { key: 'SKIP', count: summary.skipped },
  ];

  const verdict =
    summary.total === 0
      ? { tone: 'skip', text: 'No tests recorded' }
      : summary.failed > 0
        ? { tone: 'fail', text: `${summary.failed} failed` }
        : summary.flaky > 0
          ? { tone: 'flaky', text: `Green with ${summary.flaky} flaky` }
          : { tone: 'pass', text: 'All tests passed' };

  const suites = groupBy(tests, 'suite');
  const modules = groupBy(tests, 'module');
  const projects = groupBy(tests, 'project');

  /* Slowest and average come from the tests themselves; with nothing to measure the card says so
     rather than printing a confident zero. */
  const executedTests = tests.filter((test) => test.status !== 'SKIP');
  const slowest = executedTests.reduce<ExtentTest | undefined>(
    (worst, test) => (!worst || test.durationMs > worst.durationMs ? test : worst),
    undefined,
  );
  const totalTestMs = executedTests.reduce((sum, test) => sum + test.durationMs, 0);
  const averageMs = executedTests.length > 0 ? totalTestMs / executedTests.length : 0;

  const environmentRows = Object.entries({
    Environment: `${environment.displayName} (${environment.name})`,
    'UI base URL': environment.uiBaseUrl,
    'API base URL': environment.apiBaseUrl,
    Projects: environment.projects.join(', '),
    Execution: environment.ci ? 'CI' : 'Local',
    Workers: String(environment.workers),
    Retries: String(environment.retries),
    Headless: String(environment.headless),
    Framework: environment.framework,
    Playwright: environment.playwright,
    Node: environment.node,
  })
    .map(
      ([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value))}</td></tr>`,
    )
    .join('');

  const failedFirst = [...tests].sort((a, b) => {
    const weight = (status: ExtentStatus): number =>
      status === 'FAIL' || status === 'TIMEOUT' || status === 'INTERRUPTED'
        ? 0
        : status === 'FLAKY'
          ? 1
          : status === 'SKIP'
            ? 3
            : 2;
    return weight(a.status) - weight(b.status) || a.name.localeCompare(b.name);
  });

  const optionsFor = (values: readonly string[], label: string): string =>
    [`<option value="ALL">All ${escapeHtml(label)}</option>`]
      .concat(
        uniqueSorted(values).map(
          (value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`,
        ),
      )
      .join('');

  const overviewPanel = `<div class="overview">
    <section class="card donut-card reveal">
      <h3>Result distribution</h3>
      ${renderDonut(slices, summary.passRate, executed)}
      ${renderDonutLegend(slices)}
    </section>
    <div class="overview-side">
      <div class="kpis">
        ${renderKpi('Total', summary.total, 0, { foot: `${executed} executed` })}
        ${renderKpi('Passed', summary.passed, 1, { tone: 'pass', foot: formatShare(summary.passed, summary.total) })}
        ${renderKpi('Failed', summary.failed, 2, { tone: 'fail', foot: formatShare(summary.failed, summary.total) })}
        ${renderKpi('Flaky', summary.flaky, 3, { tone: 'flaky', foot: formatShare(summary.flaky, summary.total) })}
        ${renderKpi('Skipped', summary.skipped, 4, { tone: 'skip', foot: formatShare(summary.skipped, summary.total) })}
        ${renderKpi('Pass rate', summary.passRate, 5, { suffix: '%', foot: 'of executed tests' })}
      </div>
      <section class="card reveal" style="--delay:360ms">
        <h3>Duration</h3>
        <dl class="facts">
          <div><dt>Wall clock</dt><dd>${humanDuration(summary.durationMs)}</dd></div>
          <div><dt>Total test time</dt><dd>${executedTests.length > 0 ? humanDuration(totalTestMs) : 'Not tracked'}</dd></div>
          <div><dt>Average test</dt><dd>${executedTests.length > 0 ? humanDuration(averageMs) : 'Not tracked'}</dd></div>
          <div><dt>Slowest test</dt><dd>${slowest ? `${escapeHtml(slowest.name)} <span class="muted">(${humanDuration(slowest.durationMs)})</span>` : 'Not tracked'}</dd></div>
          <div><dt>Started</dt><dd>${escapeHtml(summary.startedAt)}</dd></div>
          <div><dt>Finished</dt><dd>${escapeHtml(summary.finishedAt)}</dd></div>
        </dl>
      </section>
      <section class="card reveal" style="--delay:420ms">
        <h3>Per-suite breakdown</h3>
        ${renderSuiteBars(suites)}
      </section>
    </div>
  </div>`;

  const testsPanel = `<section class="card">
    <h3>Tests</h3>
    <div class="toolbar" id="testToolbar" hidden>
      <label class="search">
        <span class="sr-only">Search tests</span>
        <input type="search" id="testSearch" placeholder="Search name, suite, module, project or tag" autocomplete="off" />
      </label>
      <div class="pills" role="group" aria-label="Filter by status">
        <button type="button" data-status-filter="ALL" aria-pressed="true">All ${summary.total}</button>
        <button type="button" data-status-filter="FAIL" aria-pressed="false">Failed ${summary.failed}</button>
        <button type="button" data-status-filter="FLAKY" aria-pressed="false">Flaky ${summary.flaky}</button>
        <button type="button" data-status-filter="PASS" aria-pressed="false">Passed ${summary.passed}</button>
        <button type="button" data-status-filter="SKIP" aria-pressed="false">Skipped ${summary.skipped}</button>
      </div>
      <select id="suiteFilter" aria-label="Filter by suite">${optionsFor(
        tests.map((test) => test.suite),
        'suites',
      )}</select>
      <select id="projectFilter" aria-label="Filter by project">${optionsFor(
        tests.map((test) => test.project),
        'projects',
      )}</select>
      <button type="button" class="link-btn" id="resetFilters">Reset</button>
    </div>
    <p class="result-count" id="resultCount" role="status">Showing ${tests.length} of ${tests.length} ${tests.length === 1 ? 'test' : 'tests'}</p>
    <div id="testList">${failedFirst.map((test) => renderTest(test, assetBase)).join('')}</div>
    <p class="empty" id="noMatches"${tests.length > 0 ? ' hidden' : ''}>${tests.length > 0 ? 'No tests match these filters.' : 'No tests were recorded for this run.'}</p>
  </section>`;

  const environmentPanel = `<section class="card">
    <h3>Environment</h3>
    <div class="table-scroll"><table class="grid env"><tbody>${environmentRows}</tbody></table></div>
  </section>`;

  /*
   * A compact machine-readable copy of the run, embedded so Export works from the file itself
   * with no server and no sibling report.json. Stacks and steps are left out deliberately: this
   * is for spreadsheets and dashboards, and the full record is already in report.json.
   * `</script>` is escaped so a test name can never terminate the tag early.
   */
  const exportPayload = JSON.stringify({
    runId: model.runId,
    environment: environment.name,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    summary,
    tests: tests.map((test) => ({
      id: test.id,
      name: test.name,
      suite: test.suite,
      module: test.module,
      project: test.project,
      file: test.file,
      status: test.status,
      durationMs: test.durationMs,
      retries: test.retries,
      workerIndex: test.workerIndex,
      tags: test.tags,
      error: test.errorMessage ? test.errorMessage.split('\n')[0] : '',
    })),
  }).replace(/<\/script/gi, '<\\/script');

  const tabsHtml = renderTabs([
    { id: 'overview', label: 'Overview', body: overviewPanel },
    {
      id: 'suites',
      label: 'Suites',
      badge: String(suites.size),
      body: renderGroupTable('Suite', suites),
    },
    {
      id: 'modules',
      label: 'Modules',
      badge: String(modules.size),
      body: renderGroupTable('Module', modules),
    },
    {
      id: 'projects',
      label: 'Projects',
      badge: String(projects.size),
      body: renderGroupTable('Project', projects),
    },
    {
      id: 'analysis',
      label: 'Analysis',
      badge: String(summary.failed + summary.flaky),
      body: `${renderFailureAnalysis(tests)}${renderSlowest(tests)}`,
    },
    {
      id: 'timeline',
      label: 'Timeline',
      body: renderTimeline(tests, summary),
    },
    {
      id: 'trend',
      label: 'Trend',
      badge: model.history ? String(model.history.length) : undefined,
      body: renderTrend(model.history ?? [], summary),
    },
    { id: 'tests', label: 'Tests', badge: String(tests.length), body: testsPanel },
    { id: 'environment', label: 'Environment', body: environmentPanel },
    {
      id: 'integrations',
      label: 'Integrations',
      badge: model.integrations ? String(model.integrations.length) : undefined,
      body: renderIntegrations(model.integrations),
    },
  ]);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Execution report &middot; ${escapeHtml(environment.displayName)}</title>
<style>${REPORT_STYLES}
</style>
</head>
<body>
<header class="top">
  <div class="wrap row">
    <div>
      <h1>Execution report &mdash; ${escapeHtml(environment.displayName)}</h1>
      <p class="sub">${escapeHtml(summary.startedAt)} &rarr; ${escapeHtml(summary.finishedAt)} &middot; ${humanDuration(summary.durationMs)}</p>
      <div class="stamp">
        <span>${escapeHtml(environment.framework)}</span>
        <span>Playwright ${escapeHtml(environment.playwright)}</span>
        <span>Node ${escapeHtml(environment.node)}</span>
        <span>${environment.ci ? 'CI' : 'Local'} &middot; ${environment.workers} worker(s)</span>
        <span>${environment.headless ? 'Headless' : 'Headed'}</span>
      </div>
    </div>
    <div class="top-right">
      <span class="verdict ${verdict.tone}">${escapeHtml(verdict.text)}</span>
      <div class="toolbar">
        <button type="button" data-export="csv">Export CSV</button>
        <button type="button" data-export="json">Export JSON</button>
        <button type="button" data-print>Print / PDF</button>
      </div>
    </div>
  </div>
</header>
<main class="wrap">${tabsHtml}</main>
<footer>Generated by ${escapeHtml(environment.framework)} &middot; secrets are masked before they reach this report</footer>
<script type="application/json" id="report-data">${exportPayload}</script>
<script>${REPORT_SCRIPT}
</script>
</body>
</html>`;
}
