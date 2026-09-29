/**
 * Primary navigation rail.
 *
 * The application collapses the rail behind a menu button on narrow viewports, so every method
 * here first makes navigation reachable. That keeps a spec identical across desktop, tablet and
 * mobile projects — the component absorbs the responsive difference instead of the test.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { DEFAULT_TIMEOUTS } from '../constants/FrameworkConstants';
import { BaseComponent } from './BaseComponent';

export class SidebarComponent extends BaseComponent {
  public readonly links: Locator;
  /** Control that reveals the rail when the viewport is too narrow to show it. */
  public readonly menuToggle: Locator;

  constructor(page: Page) {
    super(page, page.getByRole('navigation', { name: 'Primary' }));
    this.links = this.root.getByRole('link');
    this.menuToggle = page.getByTestId('menu-toggle');
  }

  public link(label: string): Locator {
    return this.root.getByRole('link', { name: label, exact: true });
  }

  /**
   * Ensures the navigation is on screen, opening the drawer when the layout has collapsed it.
   * Safe to call repeatedly.
   */
  public async ensureVisible(): Promise<void> {
    await this.perform('ensureVisible', 'sidebar', async () => {
      if (await this.root.isVisible()) return;
      await expect(this.menuToggle, 'a collapsed rail must offer a menu control').toBeVisible();
      await this.menuToggle.click();
      await expect(this.root).toBeVisible({ timeout: DEFAULT_TIMEOUTS.shortPoll });
    });
  }

  /** True when the rail is rendered inline rather than behind the menu control. */
  public async isExpandedLayout(): Promise<boolean> {
    return this.root.isVisible();
  }

  /** Navigates via the sidebar and waits for the destination to commit. */
  public async navigateTo(label: string): Promise<void> {
    await this.ensureVisible();
    await this.perform('navigateTo', `sidebar."${label}"`, async () => {
      await this.link(label).click();
      await this.page.waitForLoadState('domcontentloaded');
    });
  }

  public async getItemLabels(): Promise<string[]> {
    await this.ensureVisible();
    return this.perform('getItemLabels', 'sidebar.links', async () => {
      const texts = await this.links.allInnerTexts();
      return texts.map((text) => text.trim());
    });
  }

  /** The label of the item marked `aria-current="page"`. */
  public async getActiveItem(): Promise<string> {
    await this.ensureVisible();
    return this.perform('getActiveItem', 'sidebar[aria-current]', async () =>
      this.root
        .locator('[aria-current="page"]')
        .innerText()
        .then((text) => text.trim()),
    );
  }

  public async expectActiveItem(label: string): Promise<void> {
    await this.ensureVisible();
    await expect(this.root.locator('[aria-current="page"]')).toHaveText(label);
  }

  /** Asserts navigation is reachable, whichever layout the viewport produces. */
  public async expectAvailable(): Promise<void> {
    const visibleInline = await this.root.isVisible();
    if (visibleInline) {
      await expect(this.root).toBeVisible();
      return;
    }
    await expect(
      this.menuToggle,
      'navigation must be reachable on a narrow viewport',
    ).toBeVisible();
  }
}
