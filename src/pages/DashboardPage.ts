/** Landing screen after sign-in: workforce metrics, onboarding documents and compliance. */

import { expect, type Locator, type Page } from '@playwright/test';

import { HeaderComponent } from '../components/HeaderComponent';
import { SidebarComponent } from '../components/SidebarComponent';
import { ToastComponent } from '../components/ToastComponent';
import { BasePage } from './BasePage';

export interface DashboardMetrics {
  readonly totalEmployees: number;
  readonly departments: number;
  readonly active: number;
  readonly averageSalary: string;
}

export class DashboardPage extends BasePage {
  protected readonly path: string;
  public readonly rootIndicator: Locator;

  public readonly header: HeaderComponent;
  public readonly sidebar: SidebarComponent;
  public readonly toast: ToastComponent;

  public readonly heading: Locator;
  public readonly totalEmployeesMetric: Locator;
  public readonly departmentsMetric: Locator;
  public readonly activeMetric: Locator;
  public readonly averageSalaryMetric: Locator;
  public readonly recentList: Locator;
  public readonly documentUpload: Locator;
  public readonly uploadSummary: Locator;
  public readonly exportButton: Locator;
  public readonly resetWorkspaceButton: Locator;
  public readonly openInNewTabLink: Locator;
  public readonly complianceFrame: Locator;

  constructor(page: Page) {
    super(page);
    this.path = this.environment.ui.dashboardPath;

    this.header = new HeaderComponent(page);
    this.sidebar = new SidebarComponent(page);
    this.toast = new ToastComponent(page);

    this.heading = page.getByRole('heading', { name: 'Dashboard', level: 1 });
    this.rootIndicator = this.heading;
    this.totalEmployeesMetric = page.getByTestId('metric-total');
    this.departmentsMetric = page.getByTestId('metric-departments');
    this.activeMetric = page.getByTestId('metric-active');
    this.averageSalaryMetric = page.getByTestId('metric-avg-salary');
    this.recentList = page.getByTestId('recent-list');
    this.documentUpload = page.getByLabel('Upload signed documents');
    this.uploadSummary = page.getByTestId('upload-summary');
    this.exportButton = page.getByRole('button', { name: 'Export employees CSV' });
    this.resetWorkspaceButton = page.getByRole('button', { name: 'Reset workspace' });
    this.openInNewTabLink = page.getByTestId('open-employees-new-tab');
    this.complianceFrame = page.getByTestId('compliance-frame');
  }

  /* ----------------------------------------------------------- metrics -- */

  /**
   * Opens the dashboard and captures the directory payload the page rendered its metrics from,
   * so a test can assert the tiles against that exact response rather than a second API call
   * that parallel workers may have changed in between.
   */
  public async openAndCaptureSource(): Promise<{ metrics: DashboardMetrics; total: number }> {
    const pending = this.page.waitForResponse(
      (response) => response.url().includes('/employees') && response.request().method() === 'GET',
      { timeout: this.environment.timeouts.navigation },
    );
    await this.open();
    const payload = (await (await pending).json()) as { meta?: { total?: number } };
    return { metrics: await this.getMetrics(), total: payload.meta?.total ?? -1 };
  }

  /** Reads the KPI row once the metrics have resolved (they start as a placeholder dash). */
  public async getMetrics(): Promise<DashboardMetrics> {
    await expect(this.totalEmployeesMetric).not.toHaveText('–');
    return {
      totalEmployees: Number(await this.getText(this.totalEmployeesMetric)),
      departments: Number(await this.getText(this.departmentsMetric)),
      active: Number(await this.getText(this.activeMetric)),
      averageSalary: await this.getText(this.averageSalaryMetric),
    };
  }

  public async getRecentEmployeeNames(): Promise<string[]> {
    const items = await this.getAllTexts(this.recentList.getByTestId('recent-item'));
    return items.map((item) => item.split('—')[0]?.trim() ?? item);
  }

  /* ----------------------------------------------------------- actions -- */

  /** Uploads onboarding documents and returns the confirmation summary. */
  public async uploadDocuments(filePaths: readonly string[]): Promise<string> {
    await this.uploadMultipleFiles(this.documentUpload, filePaths);
    await expect(this.uploadSummary).toContainText(`${filePaths.length} document(s) selected`);
    return this.getText(this.uploadSummary);
  }

  /** Exports the directory and returns the saved file path. */
  public async exportEmployeesCsv(): Promise<string> {
    return this.downloadFile(this.exportButton);
  }

  /** Confirms the native reset dialog and returns its message. */
  public async confirmWorkspaceReset(): Promise<string> {
    return this.acceptDialog(async () => {
      await this.resetWorkspaceButton.click();
    });
  }

  /** Dismisses the native reset dialog and returns its message. */
  public async cancelWorkspaceReset(): Promise<string> {
    return this.dismissDialog(async () => {
      await this.resetWorkspaceButton.click();
    });
  }

  /** Opens the employees screen in a second tab and returns that page. */
  public async openEmployeesInNewTab(): Promise<Page> {
    return this.switchToNewTab(async () => {
      await this.openInNewTabLink.click();
    });
  }

  /** Acknowledges the compliance widget rendered inside an iframe. */
  public async acknowledgeCompliance(): Promise<string> {
    return this.interactWithFrame('[data-testid="compliance-frame"]', async (frame) => {
      await frame.getByTestId('widget-acknowledge').click();
      const result = frame.getByTestId('widget-result');
      await expect(result).toBeVisible();
      return result.innerText();
    });
  }

  public async navigateToEmployees(): Promise<void> {
    await this.sidebar.navigateTo('Employees');
  }

  public async logout(): Promise<void> {
    await this.header.logout();
  }

  /* -------------------------------------------------------- assertions -- */

  public async expectLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
    await expect(this.header.root).toBeVisible();
    /* Navigation may be inline or behind the menu control, depending on viewport width. */
    await this.sidebar.expectAvailable();
  }

  public async expectSignedInAs(name: string, role: string): Promise<void> {
    await expect(this.header.userName).toHaveText(name);
    await expect(this.header.userRole).toHaveText(role);
  }
}
