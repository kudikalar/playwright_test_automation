#!/usr/bin/env node
/**
 * Opens the most recent Extent report in the default browser.
 *
 * The report path is handed to the platform opener as a percent-encoded `file://` URL and the
 * child is spawned WITHOUT a shell. Both matter: with `shell: true` Node concatenates arguments
 * unescaped, so a checkout under a path containing spaces (`.../playwright-framework 3/...`)
 * reaches cmd's `start` as several tokens and nothing opens.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const latestJson = resolve(root, 'reports/extent/latest.json');
const latestHtml = resolve(root, 'reports/extent/latest.html');

if (!existsSync(latestHtml)) {
  console.error('No Extent report found. Run a suite first (for example: npm run test:smoke).');
  process.exit(1);
}

/* The summary is a convenience, never a reason to fail: a truncated file must not block the open. */
if (existsSync(latestJson)) {
  try {
    const { summary } = JSON.parse(readFileSync(latestJson, 'utf8'));
    console.log(
      `Last run: ${summary.passed} passed · ${summary.failed} failed · ${summary.flaky} flaky · ` +
        `${summary.skipped} skipped (${summary.passRate}% pass rate)`,
    );
  } catch (error) {
    console.warn(`Could not read reports/extent/latest.json: ${error.message}`);
  }
}

const target = pathToFileURL(latestHtml).href;

/* `start` needs an empty first argument: it would otherwise read the URL as the window title. */
const [command, args] =
  process.platform === 'darwin'
    ? ['open', [target]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : ['xdg-open', [target]];

const child = spawn(command, args, { detached: true, stdio: 'ignore' });

/* Without this listener a missing opener surfaces as an unhandled 'error' event, not a message. */
child.on('error', (error) => {
  console.error(`Could not launch "${command}": ${error.message}`);
  console.error(`Open the report manually: ${latestHtml}`);
  process.exitCode = 1;
});

child.unref();
console.log(`Opening ${latestHtml}`);
