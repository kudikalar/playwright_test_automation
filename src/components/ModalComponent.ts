/**
 * Dialog wrapper.
 *
 * Constructed from a `role="dialog"`/`role="alertdialog"` root, so it works for any modal in the
 * application without knowing which screen opened it.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { BaseComponent } from './BaseComponent';

export interface ModalOptions {
  /** Accessible name of the dialog, when a screen renders more than one. */
  readonly name?: string;
  readonly role?: 'dialog' | 'alertdialog';
  /** Explicit root, when the dialog cannot be addressed by role. */
  readonly root?: Locator;
}

export class ModalComponent extends BaseComponent {
  public readonly title: Locator;
  public readonly closeButton: Locator;
  public readonly cancelButton: Locator;
  public readonly errorMessage: Locator;

  constructor(page: Page, options: ModalOptions = {}) {
    super(
      page,
      options.root ??
        page.getByRole(options.role ?? 'dialog', options.name ? { name: options.name } : {}),
    );
    this.title = this.root.getByRole('heading').first();
    this.closeButton = this.root.getByTestId('modal-close');
    this.cancelButton = this.root.getByTestId('modal-cancel');
    this.errorMessage = this.root.getByTestId('modal-error');
  }

  public async getTitle(): Promise<string> {
    return this.perform('getTitle', 'modal.title', async () =>
      this.title.innerText().then((text) => text.trim()),
    );
  }

  public async expectOpen(): Promise<void> {
    await expect(this.root).toBeVisible();
  }

  public async expectClosed(): Promise<void> {
    await expect(this.root).toBeHidden();
  }

  /** Clicks a button inside the dialog by its accessible name. */
  public async clickButton(name: string): Promise<void> {
    await this.perform('clickButton', `modal."${name}"`, async () =>
      this.root.getByRole('button', { name, exact: false }).click(),
    );
  }

  public async close(): Promise<void> {
    await this.perform('close', 'modal.closeButton', async () => {
      await this.closeButton.click();
      await expect(this.root).toBeHidden();
    });
  }

  public async cancel(): Promise<void> {
    await this.perform('cancel', 'modal.cancelButton', async () => {
      await this.cancelButton.click();
      await expect(this.root).toBeHidden();
    });
  }

  public async dismissWithEscape(): Promise<void> {
    await this.perform('dismissWithEscape', 'modal', async () => {
      await this.page.keyboard.press('Escape');
      await expect(this.root).toBeHidden();
    });
  }

  /** Returns the inline validation message, or null when the dialog shows none. */
  public async getErrorMessage(): Promise<string | null> {
    if (await this.errorMessage.isHidden()) return null;
    return this.errorMessage.innerText().then((text) => text.trim());
  }
}
