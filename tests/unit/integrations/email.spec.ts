import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import { SMTPServer } from 'smtp-server';

import {
  EmailNotifier,
  readEmailSettings,
  type MailTransport,
} from '../../../src/integrations/email/EmailNotifier';
import { buildSubject, renderEmail } from '../../../src/integrations/email/EmailTemplate';
import { makeModel, makeTest } from './helpers';

const baseEnv = {
  EMAIL_ENABLED: 'true',
  SMTP_HOST: 'smtp.example.com',
  EMAIL_FROM: 'QA <qa@example.com>',
  EMAIL_TO: 'a@example.com, b@example.com',
};

const failingModel = () =>
  makeModel([
    makeTest({
      name: 'Checkout › pays <script>alert(1)</script>',
      status: 'FAIL',
      errorMessage: 'Expected 200\nReceived 500',
    }),
    makeTest({ name: 'Home › loads', status: 'PASS' }),
  ]);

test.describe('Email integration @unit', () => {
  test('is off until enabled with host, sender and recipient', () => {
    const enabledWith = (env: NodeJS.ProcessEnv): boolean => new EmailNotifier({ env }).isEnabled();
    expect(enabledWith({})).toBe(false);
    expect(new EmailNotifier({ env: { ...baseEnv, EMAIL_TO: '' } }).disabledReason()).toContain(
      'EMAIL_TO',
    );
    expect(enabledWith(baseEnv)).toBe(true);
    expect(readEmailSettings({ ...baseEnv, SMTP_PORT: '465' })?.secure).toBe(true);
    expect(readEmailSettings(baseEnv)?.secure).toBe(false);
  });

  test('renders an escaped, client-safe summary with failures and recorded-in links', () => {
    const rendered = renderEmail({
      model: failingModel(),
      reportUrl: 'https://ci.example.com/report',
      priorResults: [
        {
          name: 'Jira',
          status: 'published',
          detail: 'filed 1 new bug(s): PAY-101',
          url: 'https://x.atlassian.net/browse/PAY-101',
          durationMs: 5,
        },
      ],
    });
    expect(rendered.subject).toContain('FAILED');
    expect(rendered.subject).toContain('1 failed / 2');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).toContain('https://ci.example.com/report');
    expect(rendered.html).toContain('PAY-101');
    expect(rendered.text).toContain('FAILURES (1)');
    expect(rendered.text).toContain('Expected 200');
  });

  test('never renders a non-http link as an href', () => {
    const rendered = renderEmail({ model: failingModel(), reportUrl: 'javascript:alert(1)' });
    expect(rendered.html).not.toContain('javascript:');
  });

  test('subject cannot carry a header-injection newline', () => {
    const model = makeModel([makeTest({ name: 'x', status: 'PASS' })]);
    const subject = buildSubject({
      ...model,
      environment: { ...model.environment, displayName: 'QA\r\nBcc: evil@x.com' },
    });
    expect(subject).not.toMatch(/[\r\n]/);
  });

  test('EMAIL_NOTIFY_ON=failure keeps a green run quiet', async () => {
    const sent: unknown[] = [];
    const transport: MailTransport = {
      sendMail: (m) => (sent.push(m), Promise.resolve({ accepted: ['a'] })),
      verify: () => Promise.resolve(true),
    };
    const result = await new EmailNotifier({
      env: { ...baseEnv, EMAIL_NOTIFY_ON: 'failure' },
      transportFactory: () => transport,
    }).publish({
      model: makeModel([makeTest({ name: 'ok', status: 'PASS' })]),
      reportDir: tmpdir(),
    });
    expect(result.status).toBe('skipped');
    expect(sent).toHaveLength(0);
  });

  test('a transport error becomes a failed result with the password scrubbed', async () => {
    const result = await new EmailNotifier({
      env: { ...baseEnv, SMTP_PASSWORD: 'hunter2-very-secret' },
      transportFactory: () => ({
        sendMail: () => Promise.reject(new Error('535 auth failed for hunter2-very-secret')),
        verify: () => Promise.resolve(true),
      }),
    }).publish({ model: failingModel(), reportDir: tmpdir() });
    expect(result.status).toBe('failed');
    expect(result.detail).not.toContain('hunter2-very-secret');
    expect(result.detail).toContain('[redacted]');
  });

  test('delivers over real SMTP (STARTTLS + AUTH) with the report attached', async () => {
    const received: { from?: string; to: string[]; raw: string; user?: string }[] = [];
    const server = new SMTPServer({
      authOptional: false,
      onAuth(auth, _session, callback) {
        if (auth.username === 'mailer' && auth.password === 'pw-123456')
          return callback(null, { user: auth.username });
        return callback(new Error('bad credentials'));
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          received.push({
            ...(session.envelope.mailFrom ? { from: session.envelope.mailFrom.address } : {}),
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
            raw: Buffer.concat(chunks).toString('utf8'),
            user: String(session.user),
          });
          callback();
        });
      },
      logger: false,
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const { port } = server.server.address() as AddressInfo;

    try {
      const reportDir = mkdtempSync(join(tmpdir(), 'pw-mail-'));
      writeFileSync(join(reportDir, 'index.html'), '<html><body>full report</body></html>');
      const env = {
        ...baseEnv,
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(port),
        SMTP_USER: 'mailer',
        SMTP_PASSWORD: 'pw-123456',
        SMTP_ALLOW_SELF_SIGNED: 'true',
        EMAIL_CC: 'lead@example.com',
      };

      expect((await new EmailNotifier({ env }).verify()).ok).toBe(true);

      const result = await new EmailNotifier({ env }).publish({ model: failingModel(), reportDir });
      expect(result.status, result.detail).toBe('published');
      expect(result.detail).toContain('Emailed 3 recipient(s)');
      expect(result.detail).toContain('report attached');
      expect(received).toHaveLength(1);
      const mail = received[0]!;
      expect(mail.user).toBe('mailer');
      expect(mail.to.sort()).toEqual(['a@example.com', 'b@example.com', 'lead@example.com']);
      expect(mail.raw).toMatch(/^Subject: .*Playwright/m);
      expect(mail.raw).toMatch(/^x-playwright-run-id: run-unit-1/im);
      expect(mail.raw).toMatch(/filename="?playwright-report-run-unit-1\.html/);
      expect(mail.raw).toContain('multipart/alternative');

      const rejected = await new EmailNotifier({
        env: { ...env, SMTP_PASSWORD: 'wrong-password' },
      }).verify();
      expect(rejected.ok).toBe(false);
      expect(rejected.detail).not.toContain('wrong-password');
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
