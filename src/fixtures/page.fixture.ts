/**
 * Page Object fixtures.
 *
 * A test declares the screens it works with and receives ready-made Page Objects, so no spec
 * ever constructs one — or a locator — by hand.
 */

import { baseTest } from './base.fixture';
import { DashboardPage } from '../pages/DashboardPage';
import { EmployeePage } from '../pages/EmployeePage';
import { LoginPage } from '../pages/LoginPage';
import { ProfilePage } from '../pages/ProfilePage';
import { RegisterPage } from '@pages/RegisterPage';
import { ForgotPasswordPage } from '@pages/ForgotPasswordPage';

export interface PageObjectFixtures {
  readonly loginPage: LoginPage;
  readonly dashboardPage: DashboardPage;
  readonly employeePage: EmployeePage;
  readonly profilePage: ProfilePage;
  readonly registerPage: RegisterPage;
  readonly forgotPasswordPage: ForgotPasswordPage;
}

export const pageTest = baseTest.extend<PageObjectFixtures>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  dashboardPage: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },
  employeePage: async ({ page }, use) => {
    await use(new EmployeePage(page));
  },
  profilePage: async ({ page }, use) => {
    await use(new ProfilePage(page));
  },
  registerPage: async ({ page }, use) => {
    await use(new RegisterPage(page));
  },
  forgotPasswordPage: async ({ page }, use) => {
    await use(new ForgotPasswordPage(page));
  }
});
