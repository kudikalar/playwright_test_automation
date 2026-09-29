/**
 * Shared contract for outbound integrations (Slack, Jira, Zephyr, Sauce Labs).
 *
 * An integration turns a finished {@link ExtentReportModel} into an action somewhere else. Three
 * rules hold for every one of them:
 *
 *  1. **Opt-in.** `isEnabled()` is false until its environment variables are present, so a normal
 *     run makes no network calls and needs no credentials.
 *  2. **Never fail the run.** `publish()` resolves with a `failed` result; it does not throw. A
 *     broken webhook must not turn a green suite red.
 *  3. **No secrets in code.** Tokens are read from the environment and never rendered, logged or
 *     written to an artifact.
 */

import type { ExtentReportModel } from '../reporting/ExtentTypes';

export interface IntegrationContext {
  /** The finished run, already masked. */
  readonly model: ExtentReportModel;
  /** Absolute path of the run's report folder. */
  readonly reportDir: string;
  /** Public URL of the report when CI publishes one (e.g. a Pages or artifact link). */
  readonly reportUrl?: string;
}

export type IntegrationStatus = 'published' | 'skipped' | 'failed';

export interface IntegrationResult {
  readonly name: string;
  readonly status: IntegrationStatus;
  /** One line a human can act on — why it was skipped, or what it did. */
  readonly detail: string;
  /** Where the result landed, when the target returns a link. */
  readonly url?: string;
  readonly durationMs: number;
}

export interface Integration {
  /** Display name used in logs and in the report's Integrations panel. */
  readonly name: string;
  /** True only when every required environment variable is present. */
  isEnabled(): boolean;
  /** Why the integration is inactive, shown in the report instead of silence. */
  disabledReason(): string;
  publish(context: IntegrationContext): Promise<IntegrationResult>;
}

/** Issue keys referenced by a test through a `@JIRA-123`-style tag or annotation. */
export const ISSUE_KEY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

/** Extracts unique issue keys from a test's tags and annotations. */
export function issueKeysFor(
  tags: readonly string[],
  annotations: readonly { readonly type: string; readonly description: string }[],
): string[] {
  const haystack = [...tags, ...annotations.map((a) => `${a.type}:${a.description}`)].join(' ');
  return [...new Set([...haystack.matchAll(ISSUE_KEY_PATTERN)].map((match) => match[1] ?? ''))]
    .filter((key) => key.length > 0)
    .sort();
}
