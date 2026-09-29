/** Read-only account screen; used to verify identity carried by a stored session. */

import { expect, type Locator, type Page } from '@playwright/test';

import { HeaderComponent } from '../components/HeaderComponent';
import { SidebarComponent } from '../components/SidebarComponent';
import { BasePage } from './BasePage';

export interface ProfileDetails {
  readonly name: string;
  readonly email: string;
  readonly role: string;
}

export class ProfilePage extends BasePage {
  protected readonly path = '/profile';
  public readonly rootIndicator: Locator;

  public readonly header: HeaderComponent;
  public readonly sidebar: SidebarComponent;
  public readonly heading: Locator;
  public readonly name: Locator;
  public readonly email: Locator;
  public readonly role: Locator;

  constructor(page: Page) {
    super(page);
    this.header = new HeaderComponent(page);
    this.sidebar = new SidebarComponent(page);
    this.heading = page.getByRole('heading', { name: 'My profile', level: 1 });
    this.rootIndicator = this.heading;
    this.name = page.getByTestId('profile-name');
    this.email = page.getByTestId('profile-email');
    this.role = page.getByTestId('profile-role');
  }

  public async getDetails(): Promise<ProfileDetails> {
    await expect(this.email).not.toHaveText('—');
    return {
      name: await this.getText(this.name),
      email: await this.getText(this.email),
      role: await this.getText(this.role),
    };
  }

  public async expectRole(expected: string): Promise<void> {
    await expect(this.role).toHaveText(expected);
  }
}
