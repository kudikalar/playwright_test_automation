/** Pagination controls: page movement, page size and the summary line. */

import { expect, type Locator, type Page } from '@playwright/test';

import { UiActionError } from '../utils/FrameworkError';
import { BaseComponent } from './BaseComponent';

export interface PaginationState {
  readonly page: number;
  readonly totalPages: number;
  readonly totalRecords: number;
}

export class PaginationComponent extends BaseComponent {
  public readonly summary: Locator;
  public readonly previousButton: Locator;
  public readonly nextButton: Locator;
  public readonly pageSizeSelect: Locator;

  constructor(page: Page, root?: Locator) {
    super(page, root ?? page.locator('.pagination'));
    this.summary = this.root.getByTestId('pagination-summary');
    this.previousButton = this.root.getByTestId('pagination-previous');
    this.nextButton = this.root.getByTestId('pagination-next');
    this.pageSizeSelect = this.root.getByTestId('page-size');
  }

  /** Parses `Page 2 of 4 · 37 employees` into structured state. */
  public async getState(): Promise<PaginationState> {
    return this.perform('getState', 'pagination.summary', async () => {
      const text = (await this.summary.innerText()).trim();
      const match = /Page\s+(\d+)\s+of\s+(\d+).*?(\d+)\s+\w+/i.exec(text);
      if (!match) {
        throw new UiActionError('Unable to parse pagination summary', {
          operation: 'getState',
          target: 'pagination.summary',
          page: this.constructor.name,
          url: this.page.url(),
          expected: 'Page <n> of <n> · <total> records',
          actual: text,
        });
      }
      return {
        page: Number(match[1]),
        totalPages: Number(match[2]),
        totalRecords: Number(match[3]),
      };
    });
  }

  public async goToNextPage(): Promise<void> {
    await this.perform('goToNextPage', 'pagination.next', async () => {
      await expect(this.nextButton).toBeEnabled();
      const before = await this.getState();
      await this.nextButton.click();
      await expect(this.summary).toContainText(`Page ${before.page + 1} of`);
    });
  }

  public async goToPreviousPage(): Promise<void> {
    await this.perform('goToPreviousPage', 'pagination.previous', async () => {
      await expect(this.previousButton).toBeEnabled();
      const before = await this.getState();
      await this.previousButton.click();
      await expect(this.summary).toContainText(`Page ${before.page - 1} of`);
    });
  }

  /** Steps forward until the requested page is displayed. */
  public async goToPage(target: number): Promise<void> {
    const state = await this.getState();
    if (target < 1 || target > state.totalPages) {
      throw new UiActionError('Requested page is out of range', {
        operation: 'goToPage',
        target: String(target),
        page: this.constructor.name,
        url: this.page.url(),
        expected: `1..${state.totalPages}`,
      });
    }
    let current = state.page;
    while (current !== target) {
      if (current < target) await this.goToNextPage();
      else await this.goToPreviousPage();
      current = (await this.getState()).page;
    }
  }

  public async setPageSize(size: number): Promise<void> {
    await this.perform('setPageSize', `pagination.pageSize=${size}`, async () => {
      await this.pageSizeSelect.selectOption(String(size));
      await expect(this.summary).toContainText('Page 1 of');
    });
  }

  public async isFirstPage(): Promise<boolean> {
    return this.previousButton.isDisabled();
  }

  public async isLastPage(): Promise<boolean> {
    return this.nextButton.isDisabled();
  }
}
