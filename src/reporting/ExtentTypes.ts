/** Shared shapes for the Extent reporting layer. */

import type { IntegrationResult } from '../integrations/IntegrationTypes';

export type ExtentStatus = 'PASS' | 'FAIL' | 'SKIP' | 'FLAKY' | 'TIMEOUT' | 'INTERRUPTED';

export interface ExtentAttachment {
  readonly name: string;
  /** Path relative to the report folder, ready to use in an `href`/`src`. */
  readonly path: string;
  readonly kind: 'screenshot' | 'video' | 'trace' | 'other';
}

/** What kind of step a row is, so the report can tell an action from a check. */
export type ExtentStepKind = 'step' | 'assertion' | 'hook';

export interface ExtentStep {
  readonly title: string;
  readonly durationMs: number;
  readonly failed: boolean;
  readonly depth: number;
  /** Absent on reports written before step kinds existed; read as `step`. */
  readonly kind?: ExtentStepKind;
  /** First line of the step's own error, only on the step that failed. */
  readonly error?: string;
  /** `file:line` of the spec or page-object call that opened the step. */
  readonly location?: string;
}

/**
 * One execution attempt. A retried test collapses to a single row in the report, but the attempt
 * history is what explains *why* it is flaky — which try failed, on which worker, and with what.
 */
export interface ExtentAttempt {
  readonly retry: number;
  readonly status: ExtentStatus;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly workerIndex: number;
  readonly errorMessage?: string;
}

export interface ExtentTest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly suite: string;
  readonly module: string;
  readonly file: string;
  readonly tags: readonly string[];
  readonly project: string;
  readonly status: ExtentStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly retries: number;
  /** Worker process that ran the deciding attempt; drives the parallel-execution timeline. */
  readonly workerIndex: number;
  /** Every attempt in order, oldest first. A test that passed first time has exactly one. */
  readonly attempts: readonly ExtentAttempt[];
  readonly steps: readonly ExtentStep[];
  readonly errorMessage?: string;
  readonly errorStack?: string;
  readonly attachments: readonly ExtentAttachment[];
  readonly annotations: readonly { readonly type: string; readonly description: string }[];
}

export interface ExtentEnvironment {
  readonly name: string;
  readonly displayName: string;
  readonly uiBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly ci: boolean;
  readonly workers: number;
  readonly retries: number;
  readonly headless: boolean;
  readonly projects: readonly string[];
  readonly node: string;
  readonly framework: string;
  readonly playwright: string;
}

export interface ExtentSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly flaky: number;
  readonly passRate: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

/**
 * One previous run, as recorded in `reports/extent/history.json`.
 *
 * Deliberately tiny — a trend needs counts and timings, not payloads — so fifty runs of history
 * stay a few kilobytes and can be committed or shipped with the report.
 */
export interface ExtentHistoryEntry {
  readonly runId: string;
  readonly finishedAt: string;
  readonly environment: string;
  readonly ci: boolean;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly flaky: number;
  readonly skipped: number;
  readonly passRate: number;
  readonly durationMs: number;
}

export interface ExtentReportModel {
  readonly runId: string;
  readonly summary: ExtentSummary;
  readonly environment: ExtentEnvironment;
  readonly tests: readonly ExtentTest[];
  /**
   * Outcome of each outbound integration for this run. Optional on purpose: a run with nothing
   * configured carries no field at all and the report shows an honest empty state rather than
   * inventing rows. The import above is type-only, so the cycle with the integrations layer is
   * erased at compile time.
   */
  readonly integrations?: readonly IntegrationResult[];
  /**
   * Earlier runs, oldest first, excluding this one. Absent on a first run — the trend panel then
   * says so rather than drawing a chart out of a single point.
   */
  readonly history?: readonly ExtentHistoryEntry[];
}
