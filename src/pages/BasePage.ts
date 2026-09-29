/**
 * BasePage — every reusable browser interaction in the framework.
 *
 * Page Objects extend this class and add only locators and business-level actions. Nothing here
 * knows about a specific application screen.
 *
 * Conventions enforced by this layer:
 *  - Playwright's auto-waiting is the waiting strategy; there are no arbitrary sleeps.
 *  - Every action logs `action -> target` at DEBUG and wraps failures in {@link UiActionError}
 *    with the operation, target, page and URL, so a CI failure is debuggable from the log alone.
 *  - Actions accept a `Locator` or a selector string, so callers can pass either.
 *  - Inside a running test every action is also a `test.step`, so the Extent and HTML reports
 *    list each click, fill and check — with the value typed, unless the field is sensitive.
 */

import type { Download, Frame, FrameLocator, Locator, Page, Response } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { getEnvironment } from '../../config/environment.config';
import { DEFAULT_TIMEOUTS, MASKED_VALUE, PATHS } from '../constants/FrameworkConstants';
import type { ResolvedEnvironment } from '../types/Environment';
import { UiActionError } from '../utils/FrameworkError';
import { createLogger, type Logger } from '../utils/Logger';
import { ensureDirectory } from '../utils/FileUtils';
import { resolve } from 'node:path';

/** Anything that can identify an element: a Locator, or a selector string. */
export type Target = Locator | string;

export interface ActionOptions {
  readonly timeout?: number;
  /** Human-readable name used in logs and error messages. */
  readonly description?: string;
  /**
   * The value typed into this target is a secret: it is replaced by the mask in logs and report
   * steps. Targets whose name mentions a password, secret or token are treated as sensitive even
   * without the flag, so forgetting it cannot leak a credential.
   */
  readonly sensitive?: boolean;
}

const SENSITIVE_TARGET = /pass(word)?|secret|token/i;

/** True while a Playwright test is executing; false in global setup and plain scripts. */
function insideRunningTest(): boolean {
  try {
    test.info();
    return true;
  } catch {
    return false;
  }
}

export interface ClickOptions extends ActionOptions {
  readonly force?: boolean;
  readonly clickCount?: number;
  readonly position?: { readonly x: number; readonly y: number };
  readonly modifiers?: readonly ('Alt' | 'Control' | 'Meta' | 'Shift')[];
}

export interface TypeOptions extends ActionOptions {
  /** Per-character delay, for inputs that listen to individual key events. */
  readonly delayMs?: number;
}

export abstract class BasePage {
  protected readonly page: Page;
  protected readonly log: Logger;
  protected readonly environment: ResolvedEnvironment;

  /** Application path this page owns, e.g. `/employees`. Used by {@link navigate}. */
  protected abstract readonly path: string;

  /** An element whose presence proves this page is rendered. Used by {@link waitUntilLoaded}. */
  public abstract readonly rootIndicator: Locator;

  constructor(page: Page) {
    this.page = page;
    this.environment = getEnvironment();
    this.log = createLogger(new.target.name);
  }

  /* ============================================================ internals == */

  /** Normalises a {@link Target} into a Locator. */
  protected locator(target: Target): Locator {
    return typeof target === 'string' ? this.page.locator(target) : target;
  }

  protected describe(target: Target, fallback?: string): string {
    return fallback ?? (typeof target === 'string' ? target : String(target));
  }

  /**
   * Runs a browser interaction with uniform logging and error enrichment.
   * Never swallows an error: it re-throws a {@link UiActionError} that preserves the cause.
   */
  protected async perform<T>(
    operation: string,
    target: Target | undefined,
    action: () => Promise<T>,
    options: ActionOptions = {},
  ): Promise<T> {
    const label =
      target === undefined
        ? (options.description ?? '')
        : this.describe(target, options.description);
    this.log.action(operation, label);
    /* Outside a test (global setup minting sessions) there is no step tree to attach to. */
    if (!insideRunningTest()) return this.run(operation, label, action, options);
    /* `box` points a failure at the page-object call site, not at this wrapper. */
    return test.step(
      label ? `${operation} → ${label}` : operation,
      async () => this.run(operation, label, action, options),
      { box: true },
    );
  }

  private async run<T>(
    operation: string,
    label: string,
    action: () => Promise<T>,
    options: ActionOptions,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw new UiActionError(
        `UI action "${operation}" failed`,
        {
          operation,
          target: label,
          page: this.constructor.name,
          url: this.safeUrl(),
          environment: this.environment.name,
          timeout: options.timeout ?? this.environment.timeouts.action,
        },
        error,
      );
    }
  }

  private safeUrl(): string {
    try {
      return this.page.url();
    } catch {
      return '(page closed)';
    }
  }

  /** The underlying Playwright page, for the rare case a caller needs raw access. */
  public get rawPage(): Page {
    return this.page;
  }

  /* =========================================================== navigation == */

  /** Navigates to this page's path (or an explicit path) using the environment base URL. */
  public async navigate(pathOverride?: string, options: ActionOptions = {}): Promise<void> {
    const target = pathOverride ?? this.path;
    const url = `${this.environment.ui.baseUrl}${target.startsWith('/') ? target : `/${target}`}`;
    await this.perform(
      'navigate',
      undefined,
      async () => {
        await this.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: options.timeout ?? this.environment.timeouts.navigation,
        });
      },
      { ...options, description: url },
    );
  }

  /** Navigates and then waits for this page's identifying element. */
  public async open(pathOverride?: string): Promise<this> {
    await this.navigate(pathOverride);
    await this.waitUntilLoaded();
    return this;
  }

  /** Waits until the page's identifying element is visible. */
  public async waitUntilLoaded(options: ActionOptions = {}): Promise<void> {
    await this.perform(
      'waitUntilLoaded',
      this.rootIndicator,
      async () => {
        await this.rootIndicator.waitFor({
          state: 'visible',
          timeout: options.timeout ?? this.environment.timeouts.navigation,
        });
      },
      options,
    );
  }

  /** True when this page is currently rendered — never throws, for conditional flows. */
  public async isLoaded(timeout = DEFAULT_TIMEOUTS.shortPoll): Promise<boolean> {
    try {
      await this.rootIndicator.waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  }

  public async reload(): Promise<void> {
    await this.perform('reload', undefined, async () => {
      await this.page.reload({ waitUntil: 'domcontentloaded' });
    });
  }

  public async goBack(): Promise<void> {
    await this.perform('goBack', undefined, async () => {
      await this.page.goBack({ waitUntil: 'domcontentloaded' });
    });
  }

  public async goForward(): Promise<void> {
    await this.perform('goForward', undefined, async () => {
      await this.page.goForward({ waitUntil: 'domcontentloaded' });
    });
  }

  public getCurrentUrl(): string {
    return this.page.url();
  }

  public async getTitle(): Promise<string> {
    return this.page.title();
  }

  /* ================================================================ clicks == */

  public async click(target: Target, options: ClickOptions = {}): Promise<void> {
    await this.perform(
      'click',
      target,
      async () => {
        await this.locator(target).click({
          timeout: options.timeout ?? this.environment.timeouts.action,
          force: options.force ?? false,
          clickCount: options.clickCount ?? 1,
          ...(options.position ? { position: options.position } : {}),
          ...(options.modifiers ? { modifiers: [...options.modifiers] } : {}),
        });
      },
      options,
    );
  }

  public async doubleClick(target: Target, options: ClickOptions = {}): Promise<void> {
    await this.perform(
      'doubleClick',
      target,
      async () => {
        await this.locator(target).dblclick({
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      options,
    );
  }

  public async rightClick(target: Target, options: ClickOptions = {}): Promise<void> {
    await this.perform(
      'rightClick',
      target,
      async () => {
        await this.locator(target).click({
          button: 'right',
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      options,
    );
  }

  /**
   * Clicks bypassing actionability checks. Use only for elements an overlay legitimately covers;
   * a force click that hides a real defect is worse than a failing test.
   */
  public async forceClick(target: Target, options: ClickOptions = {}): Promise<void> {
    await this.click(target, { ...options, force: true });
  }

  /** Clicks the first element whose accessible name or text matches. */
  public async clickByText(
    text: string,
    options: ClickOptions & { readonly exact?: boolean } = {},
  ): Promise<void> {
    const locator = this.page.getByText(text, { exact: options.exact ?? false }).first();
    await this.click(locator, { ...options, description: `text="${text}"` });
  }

  /** Clicks a control and waits for the navigation it triggers to commit. */
  public async clickAndWaitForNavigation(
    target: Target,
    options: ClickOptions & { readonly urlPattern?: string | RegExp } = {},
  ): Promise<void> {
    await this.perform(
      'clickAndWaitForNavigation',
      target,
      async () => {
        await Promise.all([
          this.page.waitForURL(options.urlPattern ?? /.*/, {
            timeout: options.timeout ?? this.environment.timeouts.navigation,
            waitUntil: 'domcontentloaded',
          }),
          this.locator(target).click({
            timeout: options.timeout ?? this.environment.timeouts.action,
          }),
        ]);
      },
      options,
    );
  }

  /** Clicks a control and returns the response of the API call it triggers. */
  public async clickAndWaitForResponse(
    target: Target,
    urlFragment: string,
    options: ClickOptions = {},
  ): Promise<Response> {
    return this.perform(
      'clickAndWaitForResponse',
      target,
      async () => {
        const [response] = await Promise.all([
          this.page.waitForResponse((candidate) => candidate.url().includes(urlFragment), {
            timeout: options.timeout ?? this.environment.timeouts.navigation,
          }),
          this.locator(target).click({
            timeout: options.timeout ?? this.environment.timeouts.action,
          }),
        ]);
        return response;
      },
      options,
    );
  }

  /* ================================================================= input == */

  public async fill(target: Target, value: string, options: ActionOptions = {}): Promise<void> {
    await this.perform(
      'fill',
      target,
      async () => {
        await this.locator(target).fill(value, {
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      { ...options, description: this.describeValue(target, value, options) },
    );
  }

  /** `<target> = "<value>"` for logs and report steps, with secrets replaced by the mask. */
  protected describeValue(target: Target, value: string, options: ActionOptions): string {
    const name = this.describe(target, options.description);
    const sensitive =
      options.sensitive === true ||
      SENSITIVE_TARGET.test(name) ||
      SENSITIVE_TARGET.test(this.describe(target));
    const shown = sensitive ? MASKED_VALUE : value === '' ? '(empty)' : `"${value}"`;
    return `${name} = ${shown}`;
  }

  /** Clears an input and fills it, tolerating fields that ignore a plain `fill`. */
  public async clearAndFill(
    target: Target,
    value: string,
    options: ActionOptions = {},
  ): Promise<void> {
    await this.perform(
      'clearAndFill',
      target,
      async () => {
        const locator = this.locator(target);
        await locator.click({ timeout: options.timeout ?? this.environment.timeouts.action });
        await locator.press('ControlOrMeta+a');
        await locator.press('Delete');
        await locator.fill(value, { timeout: options.timeout ?? this.environment.timeouts.action });
      },
      options,
    );
  }

  public async clear(target: Target, options: ActionOptions = {}): Promise<void> {
    await this.perform(
      'clear',
      target,
      async () => {
        await this.locator(target).clear({
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      options,
    );
  }

  /** Types character by character, for inputs bound to key events (autocomplete, masks). */
  public async type(target: Target, value: string, options: TypeOptions = {}): Promise<void> {
    await this.perform(
      'type',
      target,
      async () => {
        await this.locator(target).pressSequentially(value, {
          delay: options.delayMs ?? 25,
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      options,
    );
  }

  public async press(target: Target, key: string, options: ActionOptions = {}): Promise<void> {
    await this.perform(
      'press',
      target,
      async () => {
        await this.locator(target).press(key, {
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      { ...options, description: `${this.describe(target)} [${key}]` },
    );
  }

  public async pressEnter(target: Target, options: ActionOptions = {}): Promise<void> {
    await this.press(target, 'Enter', options);
  }

  public async pressTab(target: Target, options: ActionOptions = {}): Promise<void> {
    await this.press(target, 'Tab', options);
  }

  /** Presses a key at page level (Escape to close a dialog, keyboard shortcuts). */
  public async pressKey(key: string): Promise<void> {
    await this.perform('pressKey', undefined, async () => this.page.keyboard.press(key), {
      description: key,
    });
  }

  /* ============================================================= dropdowns == */

  public async selectByLabel(
    target: Target,
    label: string,
    options: ActionOptions = {},
  ): Promise<void> {
    await this.perform(
      'selectByLabel',
      target,
      async () => {
        await this.locator(target).selectOption({ label }, { timeout: options.timeout });
      },
      { ...options, description: `${this.describe(target)} = "${label}"` },
    );
  }

  public async selectByValue(
    target: Target,
    value: string,
    options: ActionOptions = {},
  ): Promise<void> {
    await this.perform(
      'selectByValue',
      target,
      async () => {
        await this.locator(target).selectOption({ value }, { timeout: options.timeout });
      },
      { ...options, description: `${this.describe(target)} = "${value}"` },
    );
  }

  public async selectByIndex(
    target: Target,
    index: number,
    options: ActionOptions = {},
  ): Promise<void> {
    await this.perform(
      'selectByIndex',
      target,
      async () => {
        await this.locator(target).selectOption({ index }, { timeout: options.timeout });
      },
      { ...options, description: `${this.describe(target)} [${index}]` },
    );
  }

  public async getSelectedOptionText(target: Target): Promise<string> {
    return this.perform('getSelectedOptionText', target, async () =>
      this.locator(target)
        .locator('option:checked')
        .first()
        .innerText()
        .then((text) => text.trim()),
    );
  }

  public async getOptionLabels(target: Target): Promise<string[]> {
    return this.perform('getOptionLabels', target, async () => {
      const texts = await this.locator(target).locator('option').allInnerTexts();
      return texts.map((text) => text.trim());
    });
  }

  /**
   * Selects from a non-native dropdown: opens the trigger, then picks the option by its
   * accessible name from the list container.
   */
  public async customDropdownSelect(
    trigger: Target,
    optionLabel: string,
    options: ActionOptions & {
      readonly listContainer?: Target;
      readonly optionRole?: 'option' | 'menuitem' | 'button';
    } = {},
  ): Promise<void> {
    await this.perform(
      'customDropdownSelect',
      trigger,
      async () => {
        await this.locator(trigger).click({
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
        const scope = options.listContainer ? this.locator(options.listContainer) : this.page;
        const option = scope
          .getByRole(options.optionRole ?? 'option', { name: optionLabel, exact: false })
          .first();
        await option.click({ timeout: options.timeout ?? this.environment.timeouts.action });
      },
      { ...options, description: `${this.describe(trigger)} -> "${optionLabel}"` },
    );
  }

  /* ==================================================== checkbox / radio == */

  public async check(target: Target, options: ActionOptions = {}): Promise<void> {
    await this.perform(
      'check',
      target,
      async () => {
        await this.locator(target).check({
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      options,
    );
  }

  public async uncheck(target: Target, options: ActionOptions = {}): Promise<void> {
    await this.perform(
      'uncheck',
      target,
      async () => {
        await this.locator(target).uncheck({
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      options,
    );
  }

  /** Sets a checkbox to an explicit state, regardless of its current one. */
  public async setChecked(
    target: Target,
    checked: boolean,
    options: ActionOptions = {},
  ): Promise<void> {
    await this.perform(
      'setChecked',
      target,
      async () => {
        await this.locator(target).setChecked(checked, {
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      { ...options, description: `${this.describe(target)} = ${checked}` },
    );
  }

  public async isChecked(target: Target): Promise<boolean> {
    return this.perform('isChecked', target, async () => this.locator(target).isChecked());
  }

  /** Selects a radio button by its accessible name within an optional group. */
  public async selectRadio(label: string, groupName?: string): Promise<void> {
    const scope = groupName ? this.page.getByRole('group', { name: groupName }) : this.page;
    const radio = scope.getByRole('radio', { name: label, exact: false });
    await this.perform('selectRadio', radio, async () => radio.check(), {
      description: `radio "${label}"`,
    });
  }

  /* ======================================================== element state == */

  public async isVisible(target: Target, timeout = DEFAULT_TIMEOUTS.shortPoll): Promise<boolean> {
    try {
      await this.locator(target).first().waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  }

  public async isHidden(target: Target, timeout = DEFAULT_TIMEOUTS.shortPoll): Promise<boolean> {
    try {
      await this.locator(target).first().waitFor({ state: 'hidden', timeout });
      return true;
    } catch {
      return false;
    }
  }

  public async isEnabled(target: Target): Promise<boolean> {
    return this.perform('isEnabled', target, async () => this.locator(target).isEnabled());
  }

  public async isDisabled(target: Target): Promise<boolean> {
    return this.perform('isDisabled', target, async () => this.locator(target).isDisabled());
  }

  public async isEditable(target: Target): Promise<boolean> {
    return this.perform('isEditable', target, async () => this.locator(target).isEditable());
  }

  public async waitForVisible(target: Target, options: ActionOptions = {}): Promise<void> {
    await this.perform(
      'waitForVisible',
      target,
      async () => {
        await this.locator(target).waitFor({
          state: 'visible',
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      options,
    );
  }

  public async waitForHidden(target: Target, options: ActionOptions = {}): Promise<void> {
    await this.perform(
      'waitForHidden',
      target,
      async () => {
        await this.locator(target).waitFor({
          state: 'hidden',
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      options,
    );
  }

  public async waitForAttached(target: Target, options: ActionOptions = {}): Promise<void> {
    await this.perform(
      'waitForAttached',
      target,
      async () => {
        await this.locator(target).waitFor({
          state: 'attached',
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      options,
    );
  }

  /** Waits for a control to become enabled, using a web-first assertion (auto-retrying). */
  public async waitForEnabled(target: Target, options: ActionOptions = {}): Promise<void> {
    await this.perform(
      'waitForEnabled',
      target,
      async () => {
        await expect(this.locator(target)).toBeEnabled({
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      options,
    );
  }

  /* ====================================================== data extraction == */

  public async getText(target: Target): Promise<string> {
    return this.perform('getText', target, async () => {
      const text = await this.locator(target).first().innerText();
      return text.trim();
    });
  }

  public async getAllTexts(target: Target): Promise<string[]> {
    return this.perform('getAllTexts', target, async () => {
      const texts = await this.locator(target).allInnerTexts();
      return texts.map((text) => text.trim());
    });
  }

  public async getAttribute(target: Target, attribute: string): Promise<string | null> {
    return this.perform(
      'getAttribute',
      target,
      async () => this.locator(target).first().getAttribute(attribute),
      {
        description: `${this.describe(target)}@${attribute}`,
      },
    );
  }

  public async getInputValue(target: Target): Promise<string> {
    return this.perform('getInputValue', target, async () =>
      this.locator(target).first().inputValue(),
    );
  }

  public async getCount(target: Target): Promise<number> {
    return this.perform('getCount', target, async () => this.locator(target).count());
  }

  /* ================================================================ mouse == */

  public async hover(target: Target, options: ActionOptions = {}): Promise<void> {
    await this.perform(
      'hover',
      target,
      async () => {
        await this.locator(target).hover({
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      options,
    );
  }

  public async dragAndDrop(
    source: Target,
    destination: Target,
    options: ActionOptions = {},
  ): Promise<void> {
    await this.perform(
      'dragAndDrop',
      source,
      async () => {
        await this.locator(source).dragTo(this.locator(destination), {
          timeout: options.timeout ?? this.environment.timeouts.action,
        });
      },
      { ...options, description: `${this.describe(source)} -> ${this.describe(destination)}` },
    );
  }

  /** Clicks at absolute viewport coordinates; for canvas and map interactions. */
  public async mouseClick(x: number, y: number): Promise<void> {
    await this.perform('mouseClick', undefined, async () => this.page.mouse.click(x, y), {
      description: `(${x}, ${y})`,
    });
  }

  /* ======================================================== file transfer == */

  public async uploadFile(target: Target, filePath: string): Promise<void> {
    await this.perform(
      'uploadFile',
      target,
      async () => this.locator(target).setInputFiles(filePath),
      {
        description: `${this.describe(target)} <- ${filePath}`,
      },
    );
  }

  public async uploadMultipleFiles(target: Target, filePaths: readonly string[]): Promise<void> {
    await this.perform(
      'uploadMultipleFiles',
      target,
      async () => this.locator(target).setInputFiles([...filePaths]),
      { description: `${this.describe(target)} <- ${filePaths.length} file(s)` },
    );
  }

  public async clearUploadedFiles(target: Target): Promise<void> {
    await this.perform('clearUploadedFiles', target, async () =>
      this.locator(target).setInputFiles([]),
    );
  }

  /** Clicks a control that triggers a download and saves the file, returning its path. */
  public async downloadFile(target: Target, options: ActionOptions = {}): Promise<string> {
    return this.perform(
      'downloadFile',
      target,
      async () => {
        const [download] = await Promise.all([
          this.page.waitForEvent('download', {
            timeout: options.timeout ?? this.environment.timeouts.navigation,
          }),
          this.locator(target).click(),
        ]);
        return this.saveDownload(download);
      },
      options,
    );
  }

  /** Waits for a download started by some other interaction. */
  public async waitForDownload(options: ActionOptions = {}): Promise<Download> {
    return this.perform('waitForDownload', undefined, async () =>
      this.page.waitForEvent('download', {
        timeout: options.timeout ?? this.environment.timeouts.navigation,
      }),
    );
  }

  /** Persists a download under `reports/downloads` and returns the absolute path. */
  public async saveDownload(download: Download): Promise<string> {
    const target = resolve(ensureDirectory(PATHS.downloads), download.suggestedFilename());
    await download.saveAs(target);
    this.log.info('download saved', { file: download.suggestedFilename() });
    return target;
  }

  /* =================================================== browser interaction == */

  /** Accepts the next native dialog, returning its message. */
  public async acceptDialog(trigger: () => Promise<void>, promptText?: string): Promise<string> {
    return this.perform('acceptDialog', undefined, async () => {
      let message = '';
      const handler = (dialog: {
        message(): string;
        accept(text?: string): Promise<void>;
      }): void => {
        message = dialog.message();
        void dialog.accept(promptText);
      };
      this.page.once('dialog', handler);
      await trigger();
      return message;
    });
  }

  /** Dismisses the next native dialog, returning its message. */
  public async dismissDialog(trigger: () => Promise<void>): Promise<string> {
    return this.perform('dismissDialog', undefined, async () => {
      let message = '';
      this.page.once('dialog', (dialog) => {
        message = dialog.message();
        void dialog.dismiss();
      });
      await trigger();
      return message;
    });
  }

  /** Performs an action that opens a new tab and returns the new page, already loaded. */
  public async switchToNewTab(
    trigger: () => Promise<void>,
    options: ActionOptions = {},
  ): Promise<Page> {
    return this.perform('switchToNewTab', undefined, async () => {
      const context = this.page.context();
      const [newPage] = await Promise.all([
        context.waitForEvent('page', {
          timeout: options.timeout ?? this.environment.timeouts.navigation,
        }),
        trigger(),
      ]);
      await newPage.waitForLoadState('domcontentloaded');
      return newPage;
    });
  }

  /** Alias of {@link switchToNewTab} for popup windows opened by `window.open`. */
  public async handlePopup(
    trigger: () => Promise<void>,
    options: ActionOptions = {},
  ): Promise<Page> {
    return this.switchToNewTab(trigger, options);
  }

  public async closeTab(target: Page): Promise<void> {
    await this.perform('closeTab', undefined, async () => target.close(), {
      description: target.url(),
    });
  }

  /** Brings this page to the front (multi-tab flows). */
  public async focusTab(): Promise<void> {
    await this.perform('focusTab', undefined, async () => this.page.bringToFront());
  }

  /* =============================================================== frames == */

  /** Returns a FrameLocator for an iframe, addressed by selector or title. */
  public getFrame(selector: string): FrameLocator {
    return this.page.frameLocator(selector);
  }

  /** Returns the underlying Frame object, for APIs that need it (URL, evaluation). */
  public frameByName(nameOrUrlFragment: string): Frame {
    const frame =
      this.page.frame({ name: nameOrUrlFragment }) ??
      this.page.frames().find((candidate) => candidate.url().includes(nameOrUrlFragment));
    if (!frame) {
      throw new UiActionError('Frame not found', {
        operation: 'frameByName',
        target: nameOrUrlFragment,
        page: this.constructor.name,
        url: this.safeUrl(),
        actual: `frames: ${this.page
          .frames()
          .map((f) => f.url())
          .join(', ')}`,
      });
    }
    return frame;
  }

  /** Runs an interaction scoped to an iframe. */
  public async interactWithFrame<T>(
    frameSelector: string,
    interaction: (frame: FrameLocator) => Promise<T>,
  ): Promise<T> {
    return this.perform('interactWithFrame', frameSelector, async () =>
      interaction(this.getFrame(frameSelector)),
    );
  }

  /* ========================================================== screenshots == */

  /** Captures the viewport and returns the buffer (attach it to a report, don't assert on it). */
  public async takeScreenshot(name: string): Promise<Buffer> {
    return this.perform('takeScreenshot', undefined, async () => {
      const file = resolve(ensureDirectory(PATHS.screenshots), `${name}.png`);
      return this.page.screenshot({ path: file });
    });
  }

  public async fullPageScreenshot(name: string): Promise<Buffer> {
    return this.perform('fullPageScreenshot', undefined, async () => {
      const file = resolve(ensureDirectory(PATHS.screenshots), `${name}-full.png`);
      return this.page.screenshot({ path: file, fullPage: true });
    });
  }

  public async elementScreenshot(target: Target, name: string): Promise<Buffer> {
    return this.perform('elementScreenshot', target, async () => {
      const file = resolve(ensureDirectory(PATHS.screenshots), `${name}-element.png`);
      return this.locator(target).screenshot({ path: file });
    });
  }

  /* ============================================================ scrolling == */

  public async scrollIntoView(target: Target): Promise<void> {
    await this.perform('scrollIntoView', target, async () =>
      this.locator(target).scrollIntoViewIfNeeded(),
    );
  }

  public async scrollToTop(): Promise<void> {
    await this.perform('scrollToTop', undefined, async () =>
      this.page.evaluate(() => window.scrollTo({ top: 0 })),
    );
  }

  public async scrollToBottom(): Promise<void> {
    await this.perform('scrollToBottom', undefined, async () =>
      this.page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight })),
    );
  }

  /* ============================================================= network == */

  /** Blocks requests matching a pattern (third-party noise, analytics, heavy assets). */
  public async abortRequests(urlPattern: string | RegExp): Promise<void> {
    await this.perform(
      'abortRequests',
      undefined,
      async () => this.page.route(urlPattern, (route) => route.abort()),
      { description: String(urlPattern) },
    );
  }

  /** Serves a canned JSON payload for a route, for deterministic edge-case rendering. */
  public async mockJsonResponse(
    urlPattern: string | RegExp,
    body: unknown,
    status = 200,
  ): Promise<void> {
    await this.perform(
      'mockJsonResponse',
      undefined,
      async () =>
        this.page.route(urlPattern, (route) =>
          route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
        ),
      { description: `${String(urlPattern)} -> ${status}` },
    );
  }

  /** Removes every route handler registered on this page. */
  public async clearRoutes(): Promise<void> {
    await this.perform('clearRoutes', undefined, async () =>
      this.page.unrouteAll({ behavior: 'ignoreErrors' }),
    );
  }

  /* ============================================================= storage == */

  /** Reads a `localStorage` value from the application origin. */
  public async getLocalStorageItem(key: string): Promise<string | null> {
    return this.perform(
      'getLocalStorageItem',
      undefined,
      async () => this.page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key),
      { description: key },
    );
  }
}
