/** Transient notifications. Assertions are web-first so a toast is never chased with a sleep. */

import { expect, type Locator, type Page } from '@playwright/test';

import { DEFAULT_TIMEOUTS } from '../constants/FrameworkConstants';
import { BaseComponent } from './BaseComponent';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export class ToastComponent extends BaseComponent {
  public readonly toasts: Locator;

  constructor(page: Page) {
    super(page, page.locator('#toastRegion'));
    this.toasts = this.root.getByTestId('toast');
  }

  public get latest(): Locator {
    return this.toasts.last();
  }

  public byVariant(variant: ToastVariant): Locator {
    return this.root.locator(`[data-testid="toast"][data-variant="${variant}"]`);
  }

  /** Waits for a toast carrying the given text and returns its full message. */
  public async waitForMessage(
    text: string | RegExp,
    timeout = DEFAULT_TIMEOUTS.shortPoll,
  ): Promise<string> {
    return this.perform('waitForMessage', `toast~"${String(text)}"`, async () => {
      const toast = this.toasts.filter({ hasText: text }).first();
      await expect(toast).toBeVisible({ timeout });
      return toast.innerText().then((value) => value.trim());
    });
  }

  public async expectSuccess(
    text: string | RegExp,
    timeout = DEFAULT_TIMEOUTS.shortPoll,
  ): Promise<void> {
    await expect(this.byVariant('success').filter({ hasText: text }).first()).toBeVisible({
      timeout,
    });
  }

  public async expectError(
    text: string | RegExp,
    timeout = DEFAULT_TIMEOUTS.shortPoll,
  ): Promise<void> {
    await expect(this.byVariant('error').filter({ hasText: text }).first()).toBeVisible({
      timeout,
    });
  }

  public async getVisibleMessages(): Promise<string[]> {
    const texts = await this.toasts.allInnerTexts();
    return texts.map((text) => text.trim());
  }

  /** Waits for every toast to disappear — useful before a screenshot comparison. */
  public async waitUntilCleared(timeout = DEFAULT_TIMEOUTS.shortPoll * 2): Promise<void> {
    await expect(this.toasts).toHaveCount(0, { timeout });
  }
}
