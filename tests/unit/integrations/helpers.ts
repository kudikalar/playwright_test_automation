/** Builders and a programmable mock HTTP server for integration self-tests. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type {
  ExtentReportModel,
  ExtentStatus,
  ExtentTest,
} from '../../../src/reporting/ExtentTypes';

let counter = 0;

export function makeTest(
  overrides: Partial<ExtentTest> & { name: string; status: ExtentStatus },
): ExtentTest {
  counter += 1;
  const now = new Date().toISOString();
  return {
    id: `t${counter}`,
    description: '',
    suite: 'Smoke',
    module: 'Platform',
    file: 'tests/ui/smoke/sample.spec.ts',
    tags: [],
    project: 'chromium',
    startedAt: now,
    finishedAt: now,
    durationMs: 1234,
    retries: 0,
    workerIndex: 0,
    attempts: [],
    steps: [],
    attachments: [],
    annotations: [],
    ...overrides,
  };
}

export function makeModel(
  tests: readonly ExtentTest[],
  overrides: Partial<ExtentReportModel> = {},
): ExtentReportModel {
  const failed = tests.filter((t) => t.status === 'FAIL' || t.status === 'TIMEOUT').length;
  const passed = tests.filter((t) => t.status === 'PASS').length;
  const flaky = tests.filter((t) => t.status === 'FLAKY').length;
  const skipped = tests.filter((t) => t.status === 'SKIP').length;
  const executed = tests.length - skipped;
  const now = new Date().toISOString();
  return {
    runId: 'run-unit-1',
    summary: {
      total: tests.length,
      passed,
      failed,
      skipped,
      flaky,
      passRate: executed > 0 ? Math.round(((passed + flaky) / executed) * 100) : 0,
      startedAt: now,
      finishedAt: now,
      durationMs: 65_000,
    },
    environment: {
      name: 'qa',
      displayName: 'Quality Assurance',
      uiBaseUrl: 'https://qa.example.com',
      apiBaseUrl: 'https://qa.example.com/api',
      ci: true,
      workers: 2,
      retries: 1,
      headless: true,
      projects: ['chromium'],
      node: 'v22',
      framework: 'Playwright Enterprise Framework',
      playwright: '1.61.1',
    },
    tests,
    ...overrides,
  };
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
  readonly json: unknown;
}

export type Handler = (request: RecordedRequest) => { status: number; body?: unknown } | undefined;

export interface MockServer {
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Starts an HTTP server on a random port; `handler` returns undefined for a 404. */
export async function startMockServer(handler: Handler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json: unknown;
      try {
        json = body ? JSON.parse(body) : undefined;
      } catch {
        json = undefined;
      }
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body,
        json,
      };
      requests.push(recorded);
      const answer = handler(recorded) ?? { status: 404, body: { errorMessages: ['not found'] } };
      res.statusCode = answer.status;
      if (answer.body === undefined) {
        res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer.body));
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
