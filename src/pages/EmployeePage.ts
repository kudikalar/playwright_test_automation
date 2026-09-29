/**
 * Employee management screen.
 *
 * Composes the table, search, pagination, modal, date-picker and toast components, and exposes
 * business-level workflows (`createEmployee`, `updateEmployee`, `deleteEmployee`) so specs read
 * as workflows rather than DOM scripts.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { DatePickerComponent } from '../components/DatePickerComponent';
import { HeaderComponent } from '../components/HeaderComponent';
import { ModalComponent } from '../components/ModalComponent';
import { PaginationComponent } from '../components/PaginationComponent';
import { SearchComponent } from '../components/SearchComponent';
import { SidebarComponent } from '../components/SidebarComponent';
import { TableComponent } from '../components/TableComponent';
import { ToastComponent } from '../components/ToastComponent';
import type { EmployeeCreateRequest } from '../types/ApiModels';
import { BasePage } from './BasePage';

/** What the UI form accepts; a superset of the API create payload plus the "active" switch. */
export interface EmployeeFormInput extends EmployeeCreateRequest {
  readonly active?: boolean;
}

export class EmployeePage extends BasePage {
  protected readonly path = '/employees';
  public readonly rootIndicator: Locator;

  public readonly header: HeaderComponent;
  public readonly sidebar: SidebarComponent;
  public readonly table: TableComponent;
  public readonly search: SearchComponent;
  public readonly pagination: PaginationComponent;
  public readonly toast: ToastComponent;
  public readonly formModal: ModalComponent;
  public readonly confirmModal: ModalComponent;
  public readonly joiningDatePicker: DatePickerComponent;

  public readonly heading: Locator;
  public readonly addEmployeeButton: Locator;
  public readonly emptyState: Locator;

  /* form fields */
  public readonly nameInput: Locator;
  public readonly emailInput: Locator;
  public readonly departmentSelect: Locator;
  public readonly designationInput: Locator;
  public readonly salaryInput: Locator;
  public readonly activeCheckbox: Locator;
  public readonly saveButton: Locator;

  constructor(page: Page) {
    super(page);

    this.heading = page.getByRole('heading', { name: 'Employees', level: 1 });
    this.rootIndicator = this.heading;
    this.emptyState = page.getByTestId('employee-empty-state');

    this.header = new HeaderComponent(page);
    this.sidebar = new SidebarComponent(page);
    this.toast = new ToastComponent(page);
    this.table = new TableComponent(page, {
      testId: 'employee-table',
      rowTestId: 'employee-row',
      emptyState: this.emptyState,
    });
    this.search = new SearchComponent(page);
    this.pagination = new PaginationComponent(page);
    this.formModal = new ModalComponent(page, { root: page.getByTestId('employee-modal') });
    this.confirmModal = new ModalComponent(page, { root: page.getByTestId('confirm-modal') });
    this.joiningDatePicker = new DatePickerComponent(page);

    this.addEmployeeButton = page.getByRole('button', { name: 'Add employee' });

    /* Form fields are scoped to the dialog: the filter bar also renders a "Department" label. */
    const form = this.formModal.root;
    this.nameInput = form.getByLabel('Full name');
    this.emailInput = form.getByLabel('Work email');
    this.departmentSelect = form.getByLabel('Department', { exact: true });
    this.designationInput = form.getByLabel('Designation');
    this.salaryInput = form.getByLabel('Annual salary');
    this.activeCheckbox = form.getByLabel('Employee is active');
    this.saveButton = form.getByRole('button', { name: 'Save employee' });
  }

  /* -------------------------------------------------------- form access -- */

  public async openCreateForm(): Promise<void> {
    await this.click(this.addEmployeeButton);
    await this.formModal.expectOpen();
    await expect(this.formModal.title).toHaveText('Add employee');
  }

  public async openEditForm(employeeName: string): Promise<void> {
    await this.table.clickRowAction(employeeName, 'Edit');
    await this.formModal.expectOpen();
    await expect(this.formModal.title).toHaveText('Edit employee');
  }

  /** Fills whichever fields the caller supplied, leaving the rest untouched. */
  public async fillEmployeeForm(input: Partial<EmployeeFormInput>): Promise<void> {
    if (input.name !== undefined) await this.clearAndFill(this.nameInput, input.name);
    if (input.email !== undefined) await this.clearAndFill(this.emailInput, input.email);
    if (input.department !== undefined)
      await this.selectByValue(this.departmentSelect, input.department);
    if (input.designation !== undefined)
      await this.clearAndFill(this.designationInput, input.designation);
    if (input.salary !== undefined) await this.clearAndFill(this.salaryInput, String(input.salary));
    if (input.joiningDate !== undefined) await this.joiningDatePicker.selectDate(input.joiningDate);
    if (input.active !== undefined) await this.setChecked(this.activeCheckbox, input.active);
  }

  public async submitForm(): Promise<void> {
    await this.click(this.saveButton);
  }

  /* ---------------------------------------------------------- workflows -- */

  /** Creates an employee through the UI and waits for the success toast. */
  public async createEmployee(input: EmployeeFormInput): Promise<void> {
    await this.openCreateForm();
    await this.fillEmployeeForm(input);
    await this.submitForm();
    await this.formModal.expectClosed();
    await this.toast.expectSuccess('Employee created');
  }

  /** Submits the create form expecting rejection; returns the inline validation message. */
  public async attemptInvalidCreate(input: Partial<EmployeeFormInput>): Promise<string> {
    await this.openCreateForm();
    await this.fillEmployeeForm(input);
    await this.submitForm();
    await expect(this.formModal.errorMessage).toBeVisible();
    return (await this.formModal.getErrorMessage()) ?? '';
  }

  /** Edits an existing employee, identified by the name currently rendered in the table. */
  public async updateEmployee(
    employeeName: string,
    changes: Partial<EmployeeFormInput>,
  ): Promise<void> {
    await this.openEditForm(employeeName);
    await this.fillEmployeeForm(changes);
    await this.submitForm();
    await this.formModal.expectClosed();
    await this.toast.expectSuccess('Employee updated');
  }

  /** Deletes an employee through the confirmation dialog. */
  public async deleteEmployee(employeeName: string): Promise<void> {
    await this.table.clickRowAction(employeeName, 'Delete');
    await this.confirmModal.expectOpen();
    await expect(this.confirmModal.root.getByTestId('confirm-message')).toContainText(employeeName);
    await this.confirmModal.root.getByTestId('confirm-accept').click();
    await this.confirmModal.expectClosed();
  }

  /** Starts a delete and cancels it; the record must survive. */
  public async cancelDelete(employeeName: string): Promise<void> {
    await this.table.clickRowAction(employeeName, 'Delete');
    await this.confirmModal.expectOpen();
    await this.confirmModal.root.getByTestId('confirm-cancel').click();
    await this.confirmModal.expectClosed();
  }

  public async searchFor(term: string): Promise<void> {
    await this.search.search(term);
  }

  public async filterByDepartment(department: string): Promise<void> {
    await this.search.filterByDepartment(department);
  }

  public async clearFilters(): Promise<void> {
    await this.search.clearFilters();
  }

  /* --------------------------------------------------------- assertions -- */

  public async expectLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
    await expect(this.table.root).toBeVisible();
  }

  public async expectEmployeeVisible(name: string): Promise<void> {
    await this.table.expectContainsText(name);
  }

  public async expectEmployeeAbsent(name: string): Promise<void> {
    await this.table.expectDoesNotContainText(name);
  }

  /** Verifies the rendered row matches the values that were submitted. */
  public async expectEmployeeRow(input: EmployeeFormInput): Promise<void> {
    await this.table.expectRowMatching({
      Name: input.name,
      Email: input.email,
      Department: input.department,
      Designation: input.designation,
    });
  }

  public async getVisibleEmployeeNames(): Promise<string[]> {
    return this.table.getColumnValues('Name');
  }

  /** Employee id attribute of a row — used to hand a UI-created record to the API layer. */
  public async getEmployeeIdByName(name: string): Promise<string> {
    const id = await this.table.rowByText(name).getAttribute('data-employee-id');
    if (!id) {
      throw new Error(`Employee row "${name}" is missing its data-employee-id attribute`);
    }
    return id;
  }
}
