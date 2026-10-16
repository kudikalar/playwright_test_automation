/**
 * Sign-in screen.
 *
 * Credentials are never passed in from a spec as literals: a test names a role and this page
 * resolves the secret through the environment (env vars / CI secrets).
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { ToastComponent } from '../components/ToastComponent';
import type { UserRole } from '../types/Environment';
import { BasePage } from './BasePage';

export class LoginPage extends BasePage {
  protected readonly path: string;
  public readonly rootIndicator: Locator;

  public readonly emailInput: Locator;
  public readonly passwordInput: Locator;
  public readonly rememberMeCheckbox: Locator;
  public readonly signInButton: Locator;
  public readonly errorMessage: Locator;
  public readonly forgotPasswordLink: Locator;
  public readonly heading: Locator;
  /** Sign-in failures also raise a transient notification. */
  public readonly toast: ToastComponent;

  constructor(page: Page) {
    super(page);
    this.path = this.environment.ui.loginPath;
    this.toast = new ToastComponent(page);

    this.heading = page.getByRole('heading', { name: 'Sign in' });
    this.rootIndicator = this.heading;
    this.emailInput = page.getByLabel('Email');
    this.passwordInput = page.getByPlaceholder('Enter your password');
    this.rememberMeCheckbox = page.getByLabel('Remember me on this device');
    this.signInButton = page.getByRole('button', { name: 'Sign in' });
    /* The page also publishes other role="alert" regions (toasts, the staging-storage banner),
       so match only the sign-in validation message by its wording. */
    this.errorMessage = page.getByRole('alert').filter({ hasText: /incorrect|invalid|required/i });
    this.forgotPasswordLink = page.getByRole('link', { name: 'Forgot password?' });
  }

  /* ------------------------------------------------------- interactions -- */

  /** Fills the form and submits, without asserting the outcome. */
  public async submitCredentials(
    username: string,
    password: string,
    rememberMe = false,
  ): Promise<void> {
    await this.fill(this.emailInput, username);
    await this.fill(this.passwordInput, password);
    if (rememberMe) await this.check(this.rememberMeCheckbox);
    await this.click(this.signInButton);
  }

  /** Signs in and waits for the dashboard — the happy path used by most UI journeys. */
  public async login(username: string, password: string, rememberMe = false): Promise<void> {
    await this.submitCredentials(username, password, rememberMe);
    await this.page.waitForURL(this.dashboardUrlPattern(), {
      timeout: this.environment.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
  }

  /** Signs in as a configured role, resolving the secret from the environment. */
  public async loginAs(role: UserRole, rememberMe = false): Promise<void> {
    const { username, password } = this.environment.credentialsFor(role);
    this.log.info('signing in', { role, environment: this.environment.name });
    await this.login(username, password, rememberMe);
  }

  /** Submits credentials expected to be rejected, leaving the user on the login screen. */
  public async attemptInvalidLogin(username: string, password: string): Promise<string> {
    await this.submitCredentials(username, password);
    await expect(this.errorMessage).toBeVisible();
    return this.getText(this.errorMessage);
  }

  /* ---------------------------------------------------------- assertions -- */

  public async expectLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
    await expect(this.emailInput).toBeEditable();
    await expect(this.signInButton).toBeEnabled();
  }

  public async expectErrorMessage(expected: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible();
    await expect(this.errorMessage).toContainText(expected);
  }

  public async expectNoErrorMessage(): Promise<void> {
    await expect(this.errorMessage).toBeHidden();
  }

  /**
   * True when the browser holds a signed-in session.
   * The Vision Health Care build keeps its session in an httpOnly `vhc_sid` cookie; older builds
   * stored a `pk.auth.token` entry in localStorage, so both are accepted.
   */
  public async hasSessionToken(): Promise<boolean> {
    const cookies = await this.page.context().cookies();
    if (cookies.some((cookie) => cookie.name === 'vhc_sid' && cookie.value.length > 0)) return true;
    return (await this.getLocalStorageItem('pk.auth.token')) !== null;
  }

  public async attemptValidLogin(username: string, password: string): Promise<void> {
    await this.submitCredentials(username, password);
    await expect(this.page).toHaveURL(this.dashboardUrlPattern(), {
      timeout: this.environment.timeouts.navigation,
    });
  }

  /**
   * Matches the post-login landing URL for the active environment.
   * A RegExp is used on purpose: Playwright resolves string patterns against `baseURL`, which turns
   * a glob like `** /dashboard` into `https://host/** /dashboard` and never matches.
   */
  private dashboardUrlPattern(): RegExp {
    const path = this.environment.ui.dashboardPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return new RegExp(`^https?://[^/]+${path}/?(?:[?#].*)?$`);
  }
}
