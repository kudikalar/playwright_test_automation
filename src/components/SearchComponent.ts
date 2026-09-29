/**
 * Search/filter bar.
 *
 * Search is debounced in the application, so this component waits on the *result* of the query
 * (the backing request, or a settled DOM state) rather than sleeping past the debounce.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { BaseComponent } from './BaseComponent';

export interface SearchOptions {
  readonly root?: Locator;
  readonly inputTestId?: string;
  readonly filterTestId?: string;
  readonly clearTestId?: string;
  /** URL fragment of the request the search triggers. */
  readonly requestFragment?: string;
}

export class SearchComponent extends BaseComponent {
  public readonly input: Locator;
  public readonly departmentFilter: Locator;
  public readonly clearButton: Locator;
  private readonly requestFragment: string;

  constructor(page: Page, options: SearchOptions = {}) {
    super(page, options.root ?? page.locator('section[aria-label="Employee filters"]'));
    this.input = this.root.getByTestId(options.inputTestId ?? 'employee-search');
    this.departmentFilter = this.root.getByTestId(options.filterTestId ?? 'department-filter');
    this.clearButton = this.root.getByTestId(options.clearTestId ?? 'clear-filters');
    this.requestFragment = options.requestFragment ?? '/employees?';
  }

  /** Types a term and waits for the resulting query to complete. */
  public async search(term: string): Promise<void> {
    await this.perform('search', `search="${term}"`, async () => {
      const responsePromise = this.page.waitForResponse(
        (response) =>
          response.url().includes(this.requestFragment) && response.request().method() === 'GET',
        { timeout: this.environment.timeouts.navigation },
      );
      await this.input.fill(term);
      await responsePromise;
    });
  }

  public async filterByDepartment(department: string): Promise<void> {
    await this.perform('filterByDepartment', `department="${department}"`, async () => {
      const responsePromise = this.page.waitForResponse(
        (response) => response.url().includes(this.requestFragment),
        { timeout: this.environment.timeouts.navigation },
      );
      await this.departmentFilter.selectOption(department);
      await responsePromise;
    });
  }

  public async clearFilters(): Promise<void> {
    await this.perform('clearFilters', 'search.clear', async () => {
      const responsePromise = this.page.waitForResponse(
        (response) => response.url().includes(this.requestFragment),
        { timeout: this.environment.timeouts.navigation },
      );
      await this.clearButton.click();
      await responsePromise;
      await expect(this.input).toHaveValue('');
    });
  }

  public async getSearchTerm(): Promise<string> {
    return this.input.inputValue();
  }

  public async getAvailableDepartments(): Promise<string[]> {
    const labels = await this.departmentFilter.locator('option').allInnerTexts();
    return labels.map((label) => label.trim());
  }
}
