import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { fingerprintOf, PASSING_LABEL } from '../../../src/integrations/jira/JiraBugTriage';
import { JiraNotifier } from '../../../src/integrations/jira/JiraNotifier';
import {
  makeModel,
  makeTest,
  startMockServer,
  type MockServer,
  type RecordedRequest,
} from './helpers';

interface FakeIssue {
  key: string;
  labels: string[];
  done: boolean;
}

interface JiraBody {
  jql?: string;
  fields?: { summary?: string; labels?: string[]; description?: unknown };
  update?: { labels?: { add?: string; remove?: string }[] };
}

/** A tiny in-memory Jira that understands exactly the calls the notifier makes. */
function fakeJira(issues: FakeIssue[], options: { failSearch?: boolean } = {}) {
  let next = 100;
  return (request: RecordedRequest) => {
    const { method, path } = request;
    const body = request.json as JiraBody | undefined;
    if (method === 'GET' && path === '/rest/api/3/myself')
      return { status: 200, body: { accountId: 'bot', displayName: 'QA Bot' } };
    if (method === 'POST' && path === '/rest/api/3/search/jql') {
      if (options.failSearch) return { status: 500, body: { errorMessages: ['boom'] } };
      const jql = String(body?.jql ?? '');
      const labels = [...jql.matchAll(/labels = "([^"]+)"/g)].map((m) => m[1]);
      const hits = issues.filter(
        (issue) => !issue.done && labels.every((label) => issue.labels.includes(label!)),
      );
      return {
        status: 200,
        body: {
          issues: hits.map((issue) => ({
            id: issue.key,
            key: issue.key,
            fields: { summary: 's', status: { name: 'Open' }, labels: issue.labels },
          })),
        },
      };
    }
    if (method === 'POST' && path === '/rest/api/3/issue') {
      next += 1;
      const key = `PAY-${next}`;
      issues.push({ key, labels: [...(body?.fields?.labels ?? [])], done: false });
      return { status: 201, body: { id: String(next), key, self: `x/${key}` } };
    }
    const comment = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(path);
    if (method === 'POST' && comment)
      return { status: 201, body: { id: 'c1', self: 'x', created: 'now' } };
    const attach = /^\/rest\/api\/3\/issue\/([^/]+)\/attachments$/.exec(path);
    if (method === 'POST' && attach) return { status: 200, body: [{ id: 'a1' }] };
    const edit = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
    if (method === 'PUT' && edit) {
      const issue = issues.find((candidate) => candidate.key === decodeURIComponent(edit[1]!));
      for (const op of body?.update?.labels ?? []) {
        if (op.add && issue && !issue.labels.includes(op.add)) issue.labels.push(op.add);
        if (op.remove && issue) issue.labels = issue.labels.filter((label) => label !== op.remove);
      }
      return { status: 204 };
    }
    return undefined;
  };
}

const envFor = (server: MockServer, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  JIRA_ENABLED: 'true',
  JIRA_BASE_URL: server.url,
  JIRA_EMAIL: 'bot@example.com',
  JIRA_API_TOKEN: 'secret-token',
  JIRA_PROJECT_KEY: 'PAY',
  JIRA_ISSUE_KEY_PREFIXES: 'PAY',
  JIRA_CREATE_ISSUE_ON_FAILURE: 'true',
  JIRA_BUG_MODE: 'per-test',
  JIRA_NOTE_RECOVERIES: 'true',
  ...extra,
});

const calls = (server: MockServer, method: string, pattern: RegExp): RecordedRequest[] =>
  server.requests.filter((request) => request.method === method && pattern.test(request.path));

test.describe('Jira per-test bug triage @unit', () => {
  test('fingerprint ignores tags, case and browser project', () => {
    const a = makeTest({
      name: 'Login › Rejects bad password @smoke',
      status: 'FAIL',
      project: 'chromium',
    });
    const b = makeTest({
      name: 'login › rejects  bad password @regression @critical',
      status: 'FAIL',
      project: 'firefox',
    });
    const c = makeTest({
      name: 'Login › Rejects bad password',
      status: 'FAIL',
      file: 'tests/other.spec.ts',
    });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(c));
    expect(fingerprintOf(a)).toMatch(/^pw-fp-[0-9a-f]{12}$/);
  });

  test('files one bug per failing test, then comments instead of duplicating, then notes recovery once', async () => {
    const issues: FakeIssue[] = [];
    const server = await startMockServer(fakeJira(issues));
    try {
      const reportDir = mkdtempSync(join(tmpdir(), 'pw-jira-'));
      mkdirSync(join(reportDir, 'attachments'));
      writeFileSync(join(reportDir, 'attachments', 'shot.png'), Buffer.from([137, 80, 78, 71]));

      const loginChromium = makeTest({
        name: 'Login › Rejects bad password @smoke',
        status: 'FAIL',
        errorMessage: 'Expected "Invalid" but got "Welcome"',
        attachments: [{ name: 'screenshot', path: 'attachments/shot.png', kind: 'screenshot' }],
        steps: [{ title: 'Submit the form', durationMs: 5, failed: true, depth: 0 }],
      });
      const loginFirefox = { ...loginChromium, id: 'ff', project: 'firefox', attachments: [] };
      const search = makeTest({
        name: 'Search › Finds employee',
        status: 'TIMEOUT',
        errorMessage: 'Test timeout of 30000ms exceeded',
      });
      const green = makeTest({ name: 'Dashboard › Loads', status: 'PASS' });

      /* Run 1 — two distinct failing tests (login fails on two browsers = one bug). */
      const first = await new JiraNotifier(envFor(server)).publish({
        model: makeModel([loginChromium, loginFirefox, search, green]),
        reportDir,
        reportUrl: 'https://ci.example.com/report',
      });
      expect(first.status).toBe('published');
      expect(first.detail).toContain('filed 2 new bug(s)');
      expect(calls(server, 'POST', /\/issue$/)).toHaveLength(2);
      expect(calls(server, 'POST', /\/attachments$/)).toHaveLength(1);
      const attachment = calls(server, 'POST', /\/attachments$/)[0]!;
      expect(attachment.headers['x-atlassian-token']).toBe('no-check');

      const loginBug = issues.find((issue) => issue.labels.includes(fingerprintOf(loginChromium)))!;
      expect(loginBug.labels).toEqual(expect.arrayContaining(['playwright', 'pw-auto']));
      const created = calls(server, 'POST', /\/issue$/)
        .map((request) => (request.json as JiraBody).fields)
        .find((fields) => String(fields?.summary).includes('Login'));
      expect(created?.summary).toMatch(/^\[Playwright\] Login › Rejects bad password — Expected/);
      expect(created?.summary).not.toContain('@smoke');
      expect(JSON.stringify(created?.description)).toContain('chromium, firefox');
      expect(first.url).toContain('/browse/PAY-');

      /* Run 2 — same failures: zero new bugs, one comment each. */
      server.requests.length = 0;
      const second = await new JiraNotifier(envFor(server)).publish({
        model: makeModel([loginChromium, search, green]),
        reportDir,
      });
      expect(calls(server, 'POST', /\/issue$/)).toHaveLength(0);
      expect(calls(server, 'POST', /\/comment$/)).toHaveLength(2);
      expect(second.detail).toContain('2 known bug(s) still failing');

      /* Run 3 — login passes again: one recovery note + label. */
      server.requests.length = 0;
      const third = await new JiraNotifier(envFor(server)).publish({
        model: makeModel([{ ...loginChromium, status: 'PASS', errorMessage: undefined }, search]),
        reportDir,
      });
      expect(third.detail).toContain('1 bug(s) now passing');
      expect(loginBug.labels).toContain(PASSING_LABEL);

      /* Run 4 — still passing: no second note. */
      server.requests.length = 0;
      await new JiraNotifier(envFor(server)).publish({
        model: makeModel([{ ...loginChromium, status: 'PASS', errorMessage: undefined }, search]),
        reportDir,
      });
      const recoveryComments = calls(server, 'POST', new RegExp(`/issue/${loginBug.key}/comment$`));
      expect(recoveryComments).toHaveLength(0);

      /* Run 5 — regresses: comment and the passing label is removed. */
      await new JiraNotifier(envFor(server)).publish({
        model: makeModel([loginChromium]),
        reportDir,
      });
      expect(loginBug.labels).not.toContain(PASSING_LABEL);
    } finally {
      await server.close();
    }
  });

  test('a failed duplicate search files nothing rather than risking duplicates', async () => {
    const server = await startMockServer(fakeJira([], { failSearch: true }));
    try {
      const result = await new JiraNotifier(envFor(server)).publish({
        model: makeModel([makeTest({ name: 'A › fails', status: 'FAIL', errorMessage: 'x' })]),
        reportDir: tmpdir(),
      });
      expect(result.status).toBe('failed');
      expect(result.detail).toContain('no bugs filed to avoid duplicates');
      expect(calls(server, 'POST', /\/issue$/)).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  test('a failure linked to an issue comments there and files nothing new', async () => {
    const server = await startMockServer(fakeJira([]));
    try {
      const result = await new JiraNotifier(envFor(server)).publish({
        model: makeModel([
          makeTest({
            name: 'Pay › refund',
            status: 'FAIL',
            errorMessage: 'x',
            annotations: [{ type: 'jira', description: 'PAY-7' }],
          }),
        ]),
        reportDir: tmpdir(),
      });
      expect(result.detail).toContain('commented on 1 issue(s): PAY-7');
      expect(calls(server, 'POST', /\/issue$/)).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  test('the API token never appears in the result', async () => {
    const server = await startMockServer(() => ({
      status: 401,
      body: { errorMessages: ['nope'] },
    }));
    try {
      const result = await new JiraNotifier(envFor(server)).publish({
        model: makeModel([makeTest({ name: 'x', status: 'FAIL' })]),
        reportDir: tmpdir(),
      });
      expect(result.status).toBe('failed');
      expect(JSON.stringify(result)).not.toContain('secret-token');
      const auth = String(server.requests[0]?.headers.authorization ?? '');
      expect(auth.startsWith('Basic ')).toBe(true);
    } finally {
      await server.close();
    }
  });
});
