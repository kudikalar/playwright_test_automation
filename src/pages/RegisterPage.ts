/**
 * "Create your account" screen of the public Vision Health Care demo.
 *
 * Only reachable under `TEST_ENV=demoshop`, which points `environment.ui.baseUrl` at that host.
 * Every interaction goes through {@link BasePage}, so a failure names the operation, the target
 * and the URL rather than surfacing a bare locator timeout.
 */

import type { Locator, Page } from '@playwright/test';

import { BasePage } from './BasePage';

/** What a registration needs; `confirmPassword` defaults to `password` when omitted. */
export interface RegisterDetails {
  readonly firstName: string;
  /** Optional on the form. */
  readonly lastName?: string;
  readonly email: string;
  /** 10-digit national number; the form prefixes +91 itself. */
  readonly mobile: string;
  readonly password: string;
  readonly confirmPassword?: string;
  /** Terms of use / privacy notice. Defaults to `true`. */
  readonly acceptTerms?: boolean;
  /** Product news opt-in. Defaults to `false`. */
  readonly marketingOptIn?: boolean;
}

export class RegisterPage extends BasePage {
  protected override path = '/register';
  public override rootIndicator: Locator;

  /* form controls */
  public readonly header: Locator;
  public readonly subtitle: Locator;
  public readonly passwordHint: Locator;
  public readonly showPasswordToggles: Locator;
  public readonly signInLink: Locator;
  public readonly firstNameInput: Locator;
  public readonly lastNameInput: Locator;
  public readonly emailInput: Locator;
  public readonly mobileInput: Locator;
  public readonly passwordInput: Locator;
  public readonly confirmPasswordInput: Locator;
  public readonly acceptTermsCheckbox: Locator;
  public readonly marketingCheckbox: Locator;
  public readonly registerButton: Locator;

  /* outcomes */
  public readonly resultMessage: Locator;
  public readonly formError: Locator;
  public readonly fieldErrors: Locator;

  constructor(page: Page) {
    super(page);
    this.header = page.getByRole('heading', { name: 'Create your account', level: 1 });
    this.rootIndicator = this.header;
    this.subtitle = page.locator('.auth-sub');
    this.passwordHint = page.locator('.hint-line');

    /* The inputs carry no ids or names; autocomplete hints are unique on this form and stable. */
    const form = page.locator('form');
    this.firstNameInput = form.locator('input[autocomplete="given-name"]');
    this.lastNameInput = form.locator('input[autocomplete="family-name"]');
    this.emailInput = form.locator('input[type="email"]');
    this.mobileInput = form.locator('input[type="tel"]');
    this.passwordInput = page.getByPlaceholder('12+ characters');
    this.confirmPasswordInput = page.getByPlaceholder('Re-enter password');
    this.acceptTermsCheckbox = page.getByRole('checkbox', { name: /I accept the terms of use/ });
    this.marketingCheckbox = page.getByRole('checkbox', { name: /product news and offers/ });
    this.registerButton = form.getByRole('button', { name: 'Create account' });
    /* One toggle per password field; its accessible name flips between Show and Hide password. */
    this.showPasswordToggles = form.locator('button.pw-toggle');
    this.signInLink = form.getByRole('link', { name: 'Sign in' });

    /* Success swaps the form for a "Check your email" card. A rejected form stays put, shows a
       "Please correct the highlighted fields." alert and one `.err` per offending field — except
       the terms checkbox, whose message is a sibling `.field-error` outside any `.field`. */
    this.resultMessage = page.getByRole('heading', { name: 'Check your email' });
    this.formError = page.locator('.alert.error');
    this.fieldErrors = form.locator('.field .err, .field-error');
  }

  /* ------------------------------------------------------------- actions -- */

  /* Every control is named, so the report reads "fill First name = …" rather than a raw locator. */

  public async enterFirstName(firstName: string): Promise<void> {
    await this.fill(this.firstNameInput, firstName, { description: 'First name' });
  }

  public async enterLastName(lastName: string): Promise<void> {
    await this.fill(this.lastNameInput, lastName, { description: 'Last name' });
  }

  public async enterEmail(email: string): Promise<void> {
    await this.fill(this.emailInput, email, { description: 'Email address' });
  }

  public async enterMobile(mobile: string): Promise<void> {
    await this.fill(this.mobileInput, mobile, { description: 'Mobile number' });
  }

  public async enterPassword(password: string): Promise<void> {
    await this.fill(this.passwordInput, password, { description: 'Password', sensitive: true });
  }

  public async enterConfirmPassword(confirmPassword: string): Promise<void> {
    await this.fill(this.confirmPasswordInput, confirmPassword, {
      description: 'Confirm password',
      sensitive: true,
    });
  }

  public async setAcceptTerms(accept = true): Promise<void> {
    await this.setChecked(this.acceptTermsCheckbox, accept, { description: 'Accept terms' });
  }

  public async setMarketingOptIn(optIn = false): Promise<void> {
    await this.setChecked(this.marketingCheckbox, optIn, { description: 'Marketing opt-in' });
  }

  /** Clicks Show/Hide on the password (`0`) or confirm-password (`1`) field. */
  public async togglePasswordVisibility(index: 0 | 1 = 0): Promise<void> {
    await this.click(this.showPasswordToggles.nth(index), {
      description: index === 0 ? 'Password Show/Hide' : 'Confirm password Show/Hide',
    });
  }

  public async clickRegisterButton(): Promise<void> {
    await this.click(this.registerButton, { description: 'Create account button' });
  }

  /**
   * Fills and submits the whole form. Registration is one business action, so a spec that just
   * wants "register this person" should not have to sequence every field write itself.
   */
  public async register(details: RegisterDetails): Promise<void> {
    await this.enterFirstName(details.firstName);
    await this.enterLastName(details.lastName ?? '');
    await this.enterEmail(details.email);
    await this.enterMobile(details.mobile);
    await this.enterPassword(details.password);
    await this.enterConfirmPassword(details.confirmPassword ?? details.password);
    await this.setAcceptTerms(details.acceptTerms ?? true);
    await this.setMarketingOptIn(details.marketingOptIn ?? false);
    await this.clickRegisterButton();
  }

  /* ---------------------------------------------------------- assertions -- */

  /** Text of every validation error the form is showing, in document order. */
  public async getValidationErrors(): Promise<string[]> {
    return this.perform(
      'getValidationErrors',
      this.fieldErrors,
      async () => this.fieldErrors.allInnerTexts(),
      { description: 'field validation errors' },
    );
  }
}
