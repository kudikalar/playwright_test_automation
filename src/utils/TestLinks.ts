/**
 * Links a test to Jira issues and Zephyr Scale test cases.
 *
 * The integrations read keys from a test's tags and annotations, so linking is just metadata —
 * no extra API call at run time. Two styles, use whichever reads better:
 *
 * ```ts
 * import { links, linkJira, linkZephyr } from '@utils/TestLinks';
 *
 * // Declarative — visible in `--list`, the HTML report and the Extent report:
 * test('Reset link is sent', links({ jira: 'PAY-3214', zephyr: ['PAY-T101', 'PAY-T102'] }), async () => { … });
 *
 * // Imperative — inside a test or a beforeEach:
 * linkJira('PAY-3214');
 * linkZephyr('PAY-T101');
 * ```
 *
 * What the keys do once the integrations are enabled:
 *  - **Jira key** → a failing test comments on that issue (one comment per issue per run).
 *  - **Zephyr key** → every run records a Pass/Fail execution against that test case.
 */

import { test } from '@playwright/test';

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const ZEPHYR_KEY = /^[A-Z][A-Z_0-9]+-T\d+$/;

export interface TestLinkRefs {
  readonly jira?: string | readonly string[];
  readonly zephyr?: string | readonly string[];
}

export interface TestLinkAnnotation {
  readonly type: 'jira' | 'zephyr';
  readonly description: string;
}

const asList = (value: string | readonly string[] | undefined): string[] =>
  value === undefined
    ? []
    : (typeof value === 'string' ? [value] : [...value]).map((key) => key.trim().toUpperCase());

function validate(keys: readonly string[], pattern: RegExp, kind: string): void {
  const bad = keys.filter((key) => !pattern.test(key));
  if (bad.length > 0) {
    /* Fail loudly at definition time: a typo'd key silently never reports anywhere. */
    throw new Error(
      `Invalid ${kind} key(s): ${bad.join(', ')}. Expected ${kind === 'Jira' ? 'PROJ-123' : 'PROJ-T123'}.`,
    );
  }
}

/** Builds the annotation list for a test. */
export function linkAnnotations(refs: TestLinkRefs): TestLinkAnnotation[] {
  const jira = asList(refs.jira);
  const zephyr = asList(refs.zephyr);
  validate(jira, JIRA_KEY, 'Jira');
  validate(zephyr, ZEPHYR_KEY, 'Zephyr');
  return [
    ...jira.map((key) => ({ type: 'jira' as const, description: key })),
    ...zephyr.map((key) => ({ type: 'zephyr' as const, description: key })),
  ];
}

/** Test details object for `test(title, details, body)`. */
export function links(refs: TestLinkRefs): { annotation: TestLinkAnnotation[] } {
  return { annotation: linkAnnotations(refs) };
}

/** Adds Jira links to the currently running test. */
export function linkJira(...keys: string[]): void {
  test.info().annotations.push(...linkAnnotations({ jira: keys }));
}

/** Adds Zephyr Scale test-case links to the currently running test. */
export function linkZephyr(...keys: string[]): void {
  test.info().annotations.push(...linkAnnotations({ zephyr: keys }));
}
