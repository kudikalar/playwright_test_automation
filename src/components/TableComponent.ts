/**
 * Data table component.
 *
 * Covers the operations every enterprise grid needs — counts, lookup by text, cell access, row
 * actions, sorting and row validation — so no page object re-implements them.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { UiActionError } from '../utils/FrameworkError';
import { BaseComponent } from './BaseComponent';

export interface TableOptions {
  /** Test id of the table root. */
  readonly testId?: string;
  /** Explicit root locator, when the table has no test id. */
  readonly root?: Locator;
  /** Test id applied to each body row. */
  readonly rowTestId?: string;
  /** Locator for the "no results" panel that replaces rows. */
  readonly emptyState?: Locator;
}

/** One row rendered as a `header -> cell text` map. */
export type TableRowData = Record<string, string>;

export class TableComponent extends BaseComponent {
  public readonly headerCells: Locator;
  public readonly rows: Locator;
  public readonly emptyState: Locator | undefined;

  constructor(page: Page, options: TableOptions = {}) {
    super(page, options.root ?? page.getByTestId(options.testId ?? 'employee-table'));
    this.headerCells = this.root.getByRole('columnheader');
    this.rows = options.rowTestId
      ? this.root.getByTestId(options.rowTestId)
      : this.root.locator('tbody tr');
    this.emptyState = options.emptyState;
  }

  /* ------------------------------------------------------------- shape -- */

  public async getRowCount(): Promise<number> {
    return this.perform('getRowCount', 'table.rows', async () => this.rows.count());
  }

  public async getColumnCount(): Promise<number> {
    return this.perform('getColumnCount', 'table.headers', async () => this.headerCells.count());
  }

  public async getHeaders(): Promise<string[]> {
    return this.perform('getHeaders', 'table.headers', async () => {
      const texts = await this.headerCells.allInnerTexts();
      return texts.map((text) => text.trim());
    });
  }

  /** Zero-based index of a column, by header text. Throws listing the headers when absent. */
  public async getColumnIndex(header: string): Promise<number> {
    const headers = await this.getHeaders();
    const index = headers.findIndex(
      (candidate) => candidate.toLowerCase() === header.toLowerCase(),
    );
    if (index === -1) {
      throw new UiActionError('Column not found', {
        operation: 'getColumnIndex',
        target: header,
        page: this.constructor.name,
        url: this.page.url(),
        actual: `available columns: ${headers.join(', ')}`,
      });
    }
    return index;
  }

  /* -------------------------------------------------------------- rows -- */

  public row(index: number): Locator {
    return this.rows.nth(index);
  }

  /** The first row containing the given text anywhere in it. */
  public rowByText(text: string): Locator {
    return this.rows.filter({ hasText: text }).first();
  }

  /** The first row whose named column matches exactly. */
  public async rowByColumnValue(header: string, value: string): Promise<Locator> {
    const columnIndex = await this.getColumnIndex(header);
    return this.rows
      .filter({ has: this.page.locator(`td:nth-child(${columnIndex + 1})`, { hasText: value }) })
      .first();
  }

  /** Cell text by row index and column header. */
  public async getCell(rowIndex: number, header: string): Promise<string> {
    const columnIndex = await this.getColumnIndex(header);
    return this.perform('getCell', `row[${rowIndex}].${header}`, async () =>
      this.row(rowIndex)
        .locator('td')
        .nth(columnIndex)
        .innerText()
        .then((text) => text.trim()),
    );
  }

  /** Cell text from the row matched by `text`. */
  public async getCellByRowText(rowText: string, header: string): Promise<string> {
    const columnIndex = await this.getColumnIndex(header);
    return this.perform('getCellByRowText', `row("${rowText}").${header}`, async () =>
      this.rowByText(rowText)
        .locator('td')
        .nth(columnIndex)
        .innerText()
        .then((text) => text.trim()),
    );
  }

  /** A row as a `header -> value` map. */
  public async getRowData(rowIndex: number): Promise<TableRowData> {
    const headers = await this.getHeaders();
    const cells = await this.row(rowIndex).locator('td').allInnerTexts();
    return Object.fromEntries(
      headers.map((header, index) => [header, (cells[index] ?? '').trim()]),
    );
  }

  /** Every visible row as a `header -> value` map. */
  public async getAllRowData(): Promise<TableRowData[]> {
    const count = await this.getRowCount();
    const rows: TableRowData[] = [];
    for (let index = 0; index < count; index += 1) {
      rows.push(await this.getRowData(index));
    }
    return rows;
  }

  /** All values in one column, top to bottom. */
  public async getColumnValues(header: string): Promise<string[]> {
    const columnIndex = await this.getColumnIndex(header);
    const values = await this.rows.locator(`td:nth-child(${columnIndex + 1})`).allInnerTexts();
    return values.map((value) => value.trim());
  }

  /* -------------------------------------------------- assertions/actions -- */

  /**
   * Asserts a row exists whose cells match the expected subset.
   * Header keys are compared case-insensitively, because a stylesheet may transform their text.
   */
  public async expectRowMatching(expected: Readonly<TableRowData>): Promise<void> {
    const rows = await this.getAllRowData();
    const matched = rows.some((row) => {
      const normalised = new Map(
        Object.entries(row).map(([header, value]) => [header.toLowerCase(), value]),
      );
      return Object.entries(expected).every(([header, value]) =>
        (normalised.get(header.toLowerCase()) ?? '').includes(value),
      );
    });
    expect(
      matched,
      `No row matched ${JSON.stringify(expected)}. Rendered rows:\n${JSON.stringify(rows, undefined, 2)}`,
    ).toBe(true);
  }

  public async expectRowCount(expected: number): Promise<void> {
    await expect(this.rows).toHaveCount(expected);
  }

  public async expectContainsText(text: string): Promise<void> {
    await expect(this.rowByText(text)).toBeVisible();
  }

  public async expectDoesNotContainText(text: string): Promise<void> {
    await expect(this.rows.filter({ hasText: text })).toHaveCount(0);
  }

  /** Clicks a named action button inside the row identified by `rowText`. */
  public async clickRowAction(rowText: string, actionName: string): Promise<void> {
    await this.perform('clickRowAction', `row("${rowText}") -> ${actionName}`, async () => {
      const row = this.rowByText(rowText);
      await expect(row, `Row containing "${rowText}" was not rendered`).toBeVisible();
      await row
        .getByRole('button', { name: new RegExp(`^${actionName}`, 'i') })
        .first()
        .click();
    });
  }

  /** Sorts by clicking a column header, returning the resulting `aria-sort` direction. */
  public async sortByColumn(header: string): Promise<string> {
    return this.perform('sortByColumn', `header("${header}")`, async () => {
      const columnHeader = this.headerCells.filter({ hasText: header }).first();
      await columnHeader.getByRole('button').click();
      await expect(columnHeader).toHaveAttribute('aria-sort', /ascending|descending/);
      return (await columnHeader.getAttribute('aria-sort')) ?? 'none';
    });
  }

  /** True when the column's values are sorted in the given direction (string-aware). */
  public async isColumnSorted(header: string, direction: 'asc' | 'desc' = 'asc'): Promise<boolean> {
    const values = await this.getColumnValues(header);
    const sorted = [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const expected = direction === 'asc' ? sorted : sorted.reverse();
    return JSON.stringify(values) === JSON.stringify(expected);
  }

  public async isEmpty(): Promise<boolean> {
    if (this.emptyState && (await this.emptyState.isVisible())) return true;
    return (await this.getRowCount()) === 0;
  }

  public async expectEmpty(): Promise<void> {
    await expect(this.rows).toHaveCount(0);
    if (this.emptyState) await expect(this.emptyState).toBeVisible();
  }
}
