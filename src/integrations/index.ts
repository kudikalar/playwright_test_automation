/**
 * Integration registry.
 *
 * The reporter calls {@link publishIntegrations} once, after the run is complete and the model is
 * built. Publishing happens in two phases:
 *
 *   1. **record** — systems of record (Sauce Labs, Jira, Zephyr Scale) run in parallel.
 *   2. **notify** — human notifications (Slack, Email) run in parallel *after* phase 1, so the
 *      message can link straight to the Jira bug / Zephyr cycle / Sauce build it just produced.
 *
 * Everything here is deliberately conservative, because this code runs at the very end of a suite
 * and must never be the reason a run fails:
 *
 *  - integrations are constructed lazily, so a broken constructor disables one target, not all;
 *  - a disabled integration still returns a row, so the report says *why* it was inactive;
 *  - each phase is bounded by a wall-clock budget, so an unresponsive endpoint cannot hold a CI
 *    job open — and a slow Jira cannot starve the Slack message, because each phase has its own;
 *  - `INTEGRATIONS_DISABLED=true` is a master kill-switch and `INTEGRATIONS_ONLY=jira,slack`
 *    restricts a run (or a re-publish) to a subset.
 */

import { EmailNotifier } from './email/EmailNotifier';
import { JiraNotifier } from './jira/JiraNotifier';
import { SauceNotifier } from './sauce/SauceNotifier';
import { SlackNotifier } from './slack/SlackNotifier';
import { ZephyrNotifier } from './zephyr/ZephyrNotifier';
import type {
  Integration,
  IntegrationContext,
  IntegrationPhase,
  IntegrationResult,
} from './IntegrationTypes';
import { createLogger } from '../utils/Logger';

const log = createLogger('Integrations');

/** Per-phase wall-clock budget; override with INTEGRATIONS_BUDGET_MS. */
const DEFAULT_BUDGET_MS = 120_000;

type IntegrationFactory = () => Integration;

/*
 * Factories, not instances: constructing a notifier reads the environment, and a throw there
 * would otherwise take down the module import — and with it the entire reporter.
 */
export const INTEGRATION_FACTORIES: readonly IntegrationFactory[] = [
  () => new SauceNotifier(),
  () => new JiraNotifier(),
  () => new ZephyrNotifier(),
  () => new SlackNotifier(),
  () => new EmailNotifier(),
];

const truthy = (value: string | undefined): boolean =>
  ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());

export function instantiateIntegrations(
  factories: readonly IntegrationFactory[] = INTEGRATION_FACTORIES,
): Integration[] {
  const integrations: Integration[] = [];
  for (const factory of factories) {
    try {
      integrations.push(factory());
    } catch (error) {
      log.warn('integration could not be constructed', { reason: (error as Error).message });
    }
  }
  return integrations;
}

function skipped(name: string, detail: string): IntegrationResult {
  return { name, status: 'skipped', detail, durationMs: 0 };
}

function safeReason(integration: Integration): string {
  try {
    return integration.disabledReason();
  } catch (error) {
    return `Disabled; the reason could not be determined (${(error as Error).message}).`;
  }
}

function safeEnabled(integration: Integration): boolean {
  try {
    return integration.isEnabled();
  } catch {
    return false;
  }
}

/** Parses INTEGRATIONS_ONLY into lower-case names; empty means "no restriction". */
export function onlyFilter(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (env.INTEGRATIONS_ONLY ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
}

/** Runs one integration, converting a throw (which the contract forbids) into a failed row. */
async function runOne(
  integration: Integration,
  context: IntegrationContext,
): Promise<IntegrationResult> {
  const startedAt = Date.now();
  try {
    return await integration.publish(context);
  } catch (error) {
    return {
      name: integration.name,
      status: 'failed',
      detail: `Threw instead of returning a result: ${(error as Error).message}`,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Runs a phase in parallel under one deadline. A target still running at the deadline is reported
 * as `failed` with a timeout detail; its promise is left to settle on its own (every client has its
 * own socket timeout), so the reporter is not held open.
 */
async function runPhase(
  integrations: readonly Integration[],
  context: IntegrationContext,
  budgetMs: number,
): Promise<IntegrationResult[]> {
  return Promise.all(
    integrations.map(async (integration) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<IntegrationResult>((resolveTimeout) => {
        timer = setTimeout(
          () =>
            resolveTimeout({
              name: integration.name,
              status: 'failed',
              detail: `Did not finish within the ${budgetMs}ms integration budget (INTEGRATIONS_BUDGET_MS); its outcome is unknown.`,
              durationMs: budgetMs,
            }),
          budgetMs,
        );
        timer.unref?.();
      });
      try {
        return await Promise.race([runOne(integration, context), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
}

export interface PublishOptions {
  readonly budgetMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected for tests and the re-publish CLI; defaults to the registered integrations. */
  readonly integrations?: readonly Integration[];
}

/**
 * Runs every configured integration and returns one row per registered target.
 *
 * Never throws. Returns an empty array when nothing is configured, which is what lets the report
 * show an honest "no integrations configured" state instead of an invented one.
 */
export async function publishIntegrations(
  context: IntegrationContext,
  options: PublishOptions | number = {},
): Promise<IntegrationResult[]> {
  const opts: PublishOptions = typeof options === 'number' ? { budgetMs: options } : options;
  const env = opts.env ?? process.env;

  if (truthy(env.INTEGRATIONS_DISABLED)) {
    log.info('integrations disabled by INTEGRATIONS_DISABLED');
    return [];
  }

  const budgetFromEnv = Number.parseInt(env.INTEGRATIONS_BUDGET_MS ?? '', 10);
  const budgetMs =
    opts.budgetMs ??
    (Number.isFinite(budgetFromEnv) && budgetFromEnv > 0 ? budgetFromEnv : DEFAULT_BUDGET_MS);

  const only = onlyFilter(env);
  const integrations = (opts.integrations ?? instantiateIntegrations()).filter(
    (integration) =>
      only.size === 0 ||
      only.has(integration.name.toLowerCase().replace(/\s+/g, '')) ||
      only.has(integration.name.toLowerCase().split(/\s+/)[0] ?? ''),
  );
  const enabled = integrations.filter(safeEnabled);

  if (enabled.length === 0) {
    log.debug('no integration is configured for this run', {
      registered: integrations.map((integration) => integration.name),
    });
    return [];
  }

  const phaseOf = (integration: Integration): IntegrationPhase => integration.phase ?? 'record';
  const recordTargets = enabled.filter((integration) => phaseOf(integration) === 'record');
  const notifyTargets = enabled.filter((integration) => phaseOf(integration) === 'notify');

  const recorded = await runPhase(recordTargets, context, budgetMs);
  const notified = await runPhase(
    notifyTargets,
    { ...context, priorResults: [...(context.priorResults ?? []), ...recorded] },
    budgetMs,
  );

  /* One row per registered target, in registry order, so the report is stable run to run. */
  const byName = new Map([...recorded, ...notified].map((result) => [result.name, result]));
  const results = integrations.map(
    (integration) =>
      byName.get(integration.name) ?? skipped(integration.name, safeReason(integration)),
  );

  const published = results.filter((result) => result.status === 'published').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  log.info('integrations complete', { published, failed, total: results.length });
  for (const result of results.filter((entry) => entry.status === 'failed')) {
    log.warn(`${result.name} integration failed`, { detail: result.detail });
  }
  return results;
}

export type {
  Integration,
  IntegrationContext,
  IntegrationPhase,
  IntegrationResult,
  IntegrationStatus,
} from './IntegrationTypes';
export { issueKeysFor } from './IntegrationTypes';
export { SlackNotifier } from './slack/SlackNotifier';
export { JiraNotifier } from './jira/JiraNotifier';
export { ZephyrNotifier } from './zephyr/ZephyrNotifier';
export { SauceNotifier } from './sauce/SauceNotifier';
export { EmailNotifier } from './email/EmailNotifier';
export { SAUCECTL_CONFIG, toSaucectlYaml, isSauceConfigured } from './sauce/SauceConfig';
