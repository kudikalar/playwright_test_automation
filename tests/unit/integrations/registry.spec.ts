import { tmpdir } from 'node:os';

import { expect, test } from '@playwright/test';

import {
  publishIntegrations,
  type Integration,
  type IntegrationContext,
} from '../../../src/integrations/index';
import { buildRunSummaryMessage } from '../../../src/integrations/slack/SlackBlocks';
import { links, linkAnnotations } from '../../../src/utils/TestLinks';
import { makeModel, makeTest } from './helpers';

function fake(
  name: string,
  phase: 'record' | 'notify',
  behaviour: (context: IntegrationContext) => Promise<void> = () => Promise.resolve(),
  enabled = true,
): Integration & { seen: IntegrationContext[] } {
  const seen: IntegrationContext[] = [];
  return {
    name,
    phase,
    seen,
    isEnabled: () => enabled,
    disabledReason: () => `${name} not configured`,
    publish: async (context) => {
      seen.push(context);
      await behaviour(context);
      return {
        name,
        status: 'published',
        detail: `${name} done`,
        url: `https://example.com/${name}`,
        durationMs: 1,
      };
    },
  };
}

const context = (): IntegrationContext => ({
  model: makeModel([makeTest({ name: 'a', status: 'FAIL' })]),
  reportDir: tmpdir(),
});

test.describe('Integration registry @unit', () => {
  test('notifiers run after systems of record and receive their results', async () => {
    const jira = fake('Jira', 'record');
    const slack = fake('Slack', 'notify');
    const results = await publishIntegrations(context(), { env: {}, integrations: [slack, jira] });
    expect(results.map((r) => r.name)).toEqual(['Slack', 'Jira']);
    expect(slack.seen[0]?.priorResults?.map((r) => r.name)).toEqual(['Jira']);
    expect(jira.seen[0]?.priorResults).toBeUndefined();
  });

  test('a hung integration is cut off by the phase budget without blocking the others', async () => {
    const hung = fake('Zephyr Scale', 'record', () => new Promise(() => undefined));
    const jira = fake('Jira', 'record');
    const email = fake('Email', 'notify');
    const started = Date.now();
    const results = await publishIntegrations(context(), {
      env: {},
      budgetMs: 300,
      integrations: [hung, jira, email],
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(results.find((r) => r.name === 'Zephyr Scale')?.status).toBe('failed');
    expect(results.find((r) => r.name === 'Jira')?.status).toBe('published');
    expect(results.find((r) => r.name === 'Email')?.status).toBe('published');
  });

  test('a throwing integration is contained', async () => {
    const broken = fake('Jira', 'record', () => Promise.reject(new Error('kaboom')));
    const [result] = await publishIntegrations(context(), { env: {}, integrations: [broken] });
    expect(result?.status).toBe('failed');
    expect(result?.detail).toContain('kaboom');
  });

  test('INTEGRATIONS_DISABLED and INTEGRATIONS_ONLY are honoured', async () => {
    const jira = fake('Jira', 'record');
    const sauce = fake('Sauce Labs', 'record');
    expect(
      await publishIntegrations(context(), {
        env: { INTEGRATIONS_DISABLED: 'true' },
        integrations: [jira],
      }),
    ).toEqual([]);
    const results = await publishIntegrations(context(), {
      env: { INTEGRATIONS_ONLY: 'sauce' },
      integrations: [jira, sauce],
    });
    expect(results.map((r) => r.name)).toEqual(['Sauce Labs']);
    expect(jira.seen).toHaveLength(0);
  });

  test('disabled integrations are reported with their reason', async () => {
    const off = fake('Email', 'notify', undefined, false);
    const on = fake('Jira', 'record');
    const results = await publishIntegrations(context(), { env: {}, integrations: [on, off] });
    expect(results.find((r) => r.name === 'Email')).toMatchObject({
      status: 'skipped',
      detail: 'Email not configured',
    });
  });

  test('Slack message links to where the run was recorded', () => {
    const payload = buildRunSummaryMessage({
      model: makeModel([makeTest({ name: 'a', status: 'FAIL' })]),
      priorResults: [
        {
          name: 'Jira',
          status: 'published',
          detail: 'x',
          url: 'https://acme.atlassian.net/browse/PAY-1',
          durationMs: 1,
        },
        { name: 'Zephyr Scale', status: 'failed', detail: 'x', durationMs: 1 },
      ],
    });
    const text = JSON.stringify(payload.blocks);
    expect(text).toContain('Recorded in');
    expect(text).toContain('<https://acme.atlassian.net/browse/PAY-1|Jira>');
    expect(text).not.toContain('Zephyr Scale');
  });
});

test.describe('Test links @unit', () => {
  test('builds jira and zephyr annotations and rejects malformed keys', () => {
    expect(links({ jira: 'pay-3214', zephyr: ['PAY-T1'] })).toEqual({
      annotation: [
        { type: 'jira', description: 'PAY-3214' },
        { type: 'zephyr', description: 'PAY-T1' },
      ],
    });
    expect(() => linkAnnotations({ jira: 'PAY3214' })).toThrow(/Invalid Jira key/);
    expect(() => linkAnnotations({ zephyr: 'PAY-101' })).toThrow(/Invalid Zephyr key/);
  });
});
