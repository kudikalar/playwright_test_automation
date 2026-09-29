/**
 * Integration registry.
 *
 * The reporter calls {@link publishIntegrations} once, after the run is complete and the model is
 * built. Everything here is deliberately conservative, because this code runs at the very end of
 * a suite and must never be the reason a run fails:
 *
 *  - integrations are constructed lazily, so a broken constructor disables one target, not all;
 *  - a disabled integration still returns a row, so the report says *why* it was inactive rather
 *    than silently omitting it;
 *  - the whole batch is bounded by a wall-clock budget, so an unresponsive endpoint cannot hold
 *    a CI job open.
 */

import { JiraNotifier } from './jira/JiraNotifier';
import { SauceNotifier } from './sauce/SauceNotifier';
import { SlackNotifier } from './slack/SlackNotifier';
import { ZephyrNotifier } from './zephyr/ZephyrNotifier';
import type { Integration, IntegrationContext, IntegrationResult } from './IntegrationTypes';
import { createLogger } from '../utils/Logger';

const log = createLogger('Integrations');

/** Total time the whole batch may take before the remaining targets are abandoned. */
const DEFAULT_BUDGET_MS = 60_000;

type IntegrationFactory = () => Integration;

/*
 * Factories, not instances: constructing a notifier reads the environment, and a throw there
 * would otherwise take down the module import — and with it the entire reporter.
 */
const FACTORIES: readonly IntegrationFactory[] = [
  () => new SlackNotifier(),
  () => new JiraNotifier(),
  () => new ZephyrNotifier(),
  () => new SauceNotifier(),
];

function instantiate(): Integration[] {
  const integrations: Integration[] = [];
  for (const factory of FACTORIES) {
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

/**
 * Runs every configured integration and returns one row per registered target.
 *
 * Never throws. Returns an empty array when nothing is configured, which is what lets the report
 * show an honest "no integrations configured" state instead of an invented one.
 */
export async function publishIntegrations(
  context: IntegrationContext,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<IntegrationResult[]> {
  const integrations = instantiate();
  const enabled = integrations.filter((integration) => {
    try {
      return integration.isEnabled();
    } catch {
      return false;
    }
  });

  if (enabled.length === 0) {
    log.debug('no integration is configured for this run', {
      registered: integrations.map((integration) => integration.name),
    });
    return [];
  }

  const deadline = Date.now() + budgetMs;
  const results: IntegrationResult[] = [];

  for (const integration of integrations) {
    if (!enabled.includes(integration)) {
      results.push(skipped(integration.name, safeReason(integration)));
      continue;
    }
    if (Date.now() >= deadline) {
      results.push(
        skipped(integration.name, `Not attempted: the ${budgetMs}ms integration budget was spent.`),
      );
      continue;
    }

    const startedAt = Date.now();
    try {
      results.push(await integration.publish(context));
    } catch (error) {
      /* The contract says publish() never throws; honour it here anyway rather than trust it. */
      results.push({
        name: integration.name,
        status: 'failed',
        detail: `Threw instead of returning a result: ${(error as Error).message}`,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  const published = results.filter((result) => result.status === 'published').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  log.info('integrations complete', { published, failed, total: results.length });
  return results;
}

function safeReason(integration: Integration): string {
  try {
    return integration.disabledReason();
  } catch (error) {
    return `Disabled; the reason could not be determined (${(error as Error).message}).`;
  }
}

export type {
  Integration,
  IntegrationContext,
  IntegrationResult,
  IntegrationStatus,
} from './IntegrationTypes';
export { issueKeysFor } from './IntegrationTypes';
export { SlackNotifier } from './slack/SlackNotifier';
export { JiraNotifier } from './jira/JiraNotifier';
export { ZephyrNotifier } from './zephyr/ZephyrNotifier';
export { SauceNotifier } from './sauce/SauceNotifier';
export { SAUCECTL_CONFIG, toSaucectlYaml, isSauceConfigured } from './sauce/SauceConfig';
