import { BasePage } from './BasePage';

import { expect, type Locator, type Page } from '@playwright/test';

/** "Reset your password" screen of the Vision Health Care demo (`/forgot-password`). */
export class ForgotPasswordPage extends BasePage {
  protected override path = '/forgot-password';
  public readonly rootIndicator: Locator;

  public readonly emailInput: Locator;
  public readonly recoverButton: Locator;
  public readonly successMessage: Locator;
  public readonly errorMessage: Locator;
  public readonly fieldError: Locator;
  public readonly heading: Locator;

  constructor(page: Page) {
    super(page);
    this.path = this.environment.ui.forgotPasswordPath ?? this.path;
    this.heading = page.getByRole('heading', { name: 'Reset your password', level: 1 });
    this.rootIndicator = this.heading;
    this.emailInput = page.locator('form input[type="email"]');
    this.recoverButton = page.getByRole('button', { name: 'Send reset link' });
    /* The server's confirmation renders as an `ok` alert; request failures as an `error` alert. */
    this.successMessage = page.locator('.alert.ok');
    this.errorMessage = page.locator('.alert.error');
    this.fieldError = page.locator('form .field .err');
  }

  public async enterEmailAndSubmit(email: string): Promise<void> {
    await this.fill(this.emailInput, email, { description: 'Email address' });
    await this.click(this.recoverButton, { description: 'Send reset link button' });
  }

  public async assertSuccessMessage(expectedMessage: string): Promise<void> {
    await expect(this.successMessage).toContainText(expectedMessage);
  }
}
