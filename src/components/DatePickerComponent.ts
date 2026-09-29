/** Custom calendar widget: single-date and range selection driven by month/year controls. */

import { expect, type Locator, type Page } from '@playwright/test';

import { MONTH_NAMES, toDateParts, toIsoDate } from '../utils/DateUtils';
import { BaseComponent } from './BaseComponent';

export interface DatePickerOptions {
  readonly root?: Locator;
  readonly testId?: string;
}

export class DatePickerComponent extends BaseComponent {
  public readonly input: Locator;
  public readonly trigger: Locator;
  public readonly popup: Locator;
  public readonly monthSelect: Locator;
  public readonly yearSelect: Locator;
  public readonly grid: Locator;

  constructor(page: Page, options: DatePickerOptions = {}) {
    super(page, options.root ?? page.getByTestId(options.testId ?? 'joining-date-picker'));
    this.input = this.root.getByTestId('date-input');
    this.trigger = this.root.getByTestId('date-picker-trigger');
    this.popup = this.root.getByTestId('date-picker-popup');
    this.monthSelect = this.popup.getByTestId('date-picker-month');
    this.yearSelect = this.popup.getByTestId('date-picker-year');
    this.grid = this.popup.getByTestId('date-picker-grid');
  }

  public async open(): Promise<void> {
    await this.perform('open', 'datepicker.trigger', async () => {
      if (await this.popup.isHidden()) await this.trigger.click();
      await expect(this.popup).toBeVisible();
    });
  }

  public async close(): Promise<void> {
    await this.perform('close', 'datepicker.popup', async () => {
      if (await this.popup.isVisible()) await this.trigger.click();
      await expect(this.popup).toBeHidden();
    });
  }

  /** Selects an ISO date (`YYYY-MM-DD`), navigating month and year first. */
  public async selectDate(isoDate: string): Promise<void> {
    const { year, monthIndex, day } = toDateParts(isoDate);
    await this.perform('selectDate', isoDate, async () => {
      await this.open();
      await this.yearSelect.selectOption(String(year));
      await this.monthSelect.selectOption(String(monthIndex));
      await this.grid.getByRole('button', { name: isoDate, exact: true }).click();
      await expect(this.popup).toBeHidden();
      await expect(this.input).toHaveValue(isoDate);
      this.log.debug('date selected', { isoDate, day });
    });
  }

  public async selectToday(): Promise<string> {
    const today = toIsoDate();
    await this.selectDate(today);
    return today;
  }

  /** Chooses month and year without committing a day — for calendars driven by header controls. */
  public async selectMonthAndYear(monthName: string, year: number): Promise<void> {
    await this.perform('selectMonthAndYear', `${monthName} ${year}`, async () => {
      await this.open();
      await this.yearSelect.selectOption(String(year));
      await this.monthSelect.selectOption(String(MONTH_NAMES.indexOf(monthName)));
      await expect(this.monthSelect).toHaveValue(String(MONTH_NAMES.indexOf(monthName)));
    });
  }

  /** Applies a range to two pickers (start and end), returning the pair. */
  public async selectRange(
    endPicker: DatePickerComponent,
    startIso: string,
    endIso: string,
  ): Promise<{ start: string; end: string }> {
    await this.selectDate(startIso);
    await endPicker.selectDate(endIso);
    return { start: startIso, end: endIso };
  }

  public async getValue(): Promise<string> {
    return this.input.inputValue();
  }

  public async clear(): Promise<void> {
    await this.perform('clear', 'datepicker.input', async () => {
      await this.input.evaluate((node: HTMLInputElement) => {
        node.value = '';
        node.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await expect(this.input).toHaveValue('');
    });
  }
}
