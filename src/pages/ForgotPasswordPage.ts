import { BasePage } from './BasePage';

import { expect, type Locator, type Page } from '@playwright/test';

import { ToastComponent } from '../components/ToastComponent';
import type { UserRole } from '../types/Environment';

export class ForgotPasswordPage extends BasePage {
  protected override path = '/passwordrecovery';
  public readonly rootIndicator: Locator;

  public readonly emailInput: Locator;
  public readonly recoverButton: Locator;
  public readonly successMessage: Locator;
  public readonly heading: Locator;

  constructor(page: Page) {
    super(page);
    this.path = this.environment.ui.forgotPasswordPath;
    this.heading = page.getByRole('heading', { name: 'Password recovery' });
    this.rootIndicator = this.heading;
    this.emailInput = page.locator('#Email');
    this.recoverButton = page.locator("input[name='send-email']");
    this.successMessage = page.locator('.result');
  }

   public async enterEmailAndSubmit(email: string): Promise<void> {
    await this.fill(this.emailInput, email);
    await this.click(this.recoverButton);
  }

  public async assertSuccessMessage(expectedMessage: string): Promise<void> {
    await expect(this.successMessage).toHaveText(expectedMessage);
  }
  
}
