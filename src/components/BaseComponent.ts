/**
 * BaseComponent — the root of the Component Object Model.
 *
 * A component owns a *region* of a screen (a header, a table, a modal) and is scoped to a root
 * Locator. Pages compose components instead of duplicating their locators, so a header change is
 * made once regardless of how many screens render it.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { getEnvironment } from '../../config/environment.config';
import { DEFAULT_TIMEOUTS } from '../constants/FrameworkConstants';
import type { ResolvedEnvironment } from '../types/Environment';
import { UiActionError } from '../utils/FrameworkError';
import { createLogger, type Logger } from '../utils/Logger';

export abstract class BaseComponent {
  protected readonly page: Page;
  protected readonly log: Logger;
  protected readonly environment: ResolvedEnvironment;

  /** The element this component is scoped to. Every internal locator descends from it. */
  public readonly root: Locator;

  constructor(page: Page, root: Locator) {
    this.page = page;
    this.root = root;
    this.environment = getEnvironment();
    this.log = createLogger(new.target.name);
  }

  /** Runs a scoped interaction with uniform logging and error enrichment. */
  protected async perform<T>(
    operation: string,
    target: string,
    action: () => Promise<T>,
  ): Promise<T> {
    this.log.action(operation, target);
    try {
      return await action();
    } catch (error) {
      throw new UiActionError(
        `Component action "${operation}" failed`,
        {
          operation,
          target,
          page: this.constructor.name,
          url: this.page.url(),
          environment: this.environment.name,
        },
        error,
      );
    }
  }

  /** True when the component's root is visible. */
  public async isVisible(timeout = DEFAULT_TIMEOUTS.shortPoll): Promise<boolean> {
    try {
      await this.root.waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  }

  public async waitUntilVisible(timeout = DEFAULT_TIMEOUTS.shortPoll): Promise<void> {
    await this.perform('waitUntilVisible', String(this.root), async () => {
      await expect(this.root).toBeVisible({ timeout });
    });
  }

  public async waitUntilHidden(timeout = DEFAULT_TIMEOUTS.shortPoll): Promise<void> {
    await this.perform('waitUntilHidden', String(this.root), async () => {
      await expect(this.root).toBeHidden({ timeout });
    });
  }
}
