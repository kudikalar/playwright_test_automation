/** Application header: identity, global actions and the responsive navigation toggle. */

import type { Locator, Page } from '@playwright/test';

import { BaseComponent } from './BaseComponent';

export class HeaderComponent extends BaseComponent {
  public readonly userName: Locator;
  public readonly userRole: Locator;
  public readonly logoutButton: Locator;
  public readonly menuToggle: Locator;
  public readonly brand: Locator;

  constructor(page: Page) {
    super(page, page.locator('header.app-header'));
    this.userName = this.root.getByTestId('current-user-name');
    this.userRole = this.root.getByTestId('current-user-role');
    this.logoutButton = this.root.getByTestId('logout-button');
    this.menuToggle = this.root.getByTestId('menu-toggle');
    this.brand = this.root.locator('.brand');
  }

  public async getSignedInUserName(): Promise<string> {
    return this.perform('getSignedInUserName', 'header.userName', async () =>
      this.userName.innerText().then((text) => text.trim()),
    );
  }

  public async getSignedInUserRole(): Promise<string> {
    return this.perform('getSignedInUserRole', 'header.userRole', async () =>
      this.userRole.innerText().then((text) => text.trim()),
    );
  }

  /** Logs out and waits for the login screen to take over. */
  public async logout(): Promise<void> {
    await this.perform('logout', 'header.logoutButton', async () => {
      await this.logoutButton.click();
      await this.page.waitForURL(/\/login/, { waitUntil: 'domcontentloaded' });
    });
  }

  /** Opens the collapsed navigation on narrow viewports. */
  public async openNavigationDrawer(): Promise<void> {
    await this.perform('openNavigationDrawer', 'header.menuToggle', async () =>
      this.menuToggle.click(),
    );
  }
}
