/**
 * Registration screen of the public Tricentis Demo Web Shop.
 *
 * Only reachable under `TEST_ENV=demoshop`, which points `environment.ui.baseUrl` at that host.
 * Every interaction goes through {@link BasePage}, so a failure names the operation, the target
 * and the URL rather than surfacing a bare locator timeout.
 */

import type { Locator, Page } from '@playwright/test';

import type { Gender } from '../types/TestData';
import { BasePage } from './BasePage';

/** What a registration needs; `confirmPassword` defaults to `password` when omitted. */
export interface RegisterDetails {
  /** Defaults to `male`. */
  readonly gender?: Gender;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly password: string;
  readonly confirmPassword?: string;
}

export class RegisterPage extends BasePage {
  protected override path = '/register';
  public override rootIndicator: Locator;

  /* form controls */
  public readonly header: Locator;
  public readonly maleRadio: Locator;
  public readonly femaleRadio: Locator;
  public readonly firstNameInput: Locator;
  public readonly lastNameInput: Locator;
  public readonly emailInput: Locator;
  public readonly passwordInput: Locator;
  public readonly confirmPasswordInput: Locator;
  public readonly registerButton: Locator;

  /* outcomes */
  public readonly resultMessage: Locator;
  public readonly fieldErrors: Locator;

  constructor(page: Page) {
    super(page);
    this.header = page.getByRole('heading', { name: 'Register', level: 1 });
    this.rootIndicator = this.header;

    this.maleRadio = page.locator('#gender-male');
    this.femaleRadio = page.locator('#gender-female');
    this.firstNameInput = page.locator('#FirstName');
    this.lastNameInput = page.locator('#LastName');
    this.emailInput = page.locator('#Email');
    this.passwordInput = page.locator('#Password');
    this.confirmPasswordInput = page.locator('#ConfirmPassword');
    this.registerButton = page.locator('#register-button');

    /* Success renders one `.result`; a rejected form renders one `.field-validation-error` per
       offending field and never renders `.result` at all. */
    this.resultMessage = page.locator('.result');
    this.fieldErrors = page.locator('.field-validation-error');
  }

  /* ------------------------------------------------------------- actions -- */

  /* Every control is named, so the report reads "fill First name = …" rather than a raw locator. */

  public async selectGender(gender: Gender = 'male'): Promise<void> {
    const radio = gender === 'female' ? this.femaleRadio : this.maleRadio;
    await this.check(radio, { description: `Gender: ${gender}` });
  }

  public async selectMaleRadioButton(): Promise<void> {
    await this.selectGender('male');
  }

  public async enterFirstName(firstName: string): Promise<void> {
    await this.fill(this.firstNameInput, firstName, { description: 'First name' });
  }

  public async enterLastName(lastName: string): Promise<void> {
    await this.fill(this.lastNameInput, lastName, { description: 'Last name' });
  }

  public async enterEmail(email: string): Promise<void> {
    await this.fill(this.emailInput, email, { description: 'Email' });
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

  public async clickRegisterButton(): Promise<void> {
    await this.click(this.registerButton, { description: 'Register button' });
  }

  /**
   * Fills and submits the whole form. Registration is one business action, so a spec that just
   * wants "register this person" should not have to sequence six field writes itself.
   */
  public async register(details: RegisterDetails): Promise<void> {
    await this.selectGender(details.gender);
    await this.enterFirstName(details.firstName);
    await this.enterLastName(details.lastName);
    await this.enterEmail(details.email);
    await this.enterPassword(details.password);
    await this.enterConfirmPassword(details.confirmPassword ?? details.password);
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
