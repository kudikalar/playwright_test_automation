/**
 * Runs saucectl with the Sauce Labs credentials from `.env`.
 *
 * saucectl reads SAUCE_USERNAME / SAUCE_ACCESS_KEY only from the process environment (or its own
 * `saucectl configure` file) — it never looks at `.env`. This wrapper layers `.env` under the
 * current environment (shell/CI values win), fails fast with a clear message when a credential is
 * missing, and forwards every argument to `saucectl run`.
 *
 * Usage: node scripts/sauce-run.mjs [saucectl run args…]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(process.cwd(), '.env');

/* Minimal KEY=VALUE parser so this runs before `npm install` (dotenv lives in node_modules). */
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const [, key, raw] = match;
    const value = raw.replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

const missing = ['SAUCE_USERNAME', 'SAUCE_ACCESS_KEY'].filter((key) => !process.env[key]?.trim());
if (missing.length > 0) {
  console.error(
    `Sauce Labs credentials missing: ${missing.join(', ')}.\n` +
      'Set them in .env (see .env.example) or in your shell, then run again.',
  );
  process.exit(1);
}

const args = ['run', ...process.argv.slice(2)];
if (process.env.SAUCE_REGION && !args.some((arg) => arg === '--region' || arg.startsWith('--region='))) {
  args.push('--region', process.env.SAUCE_REGION);
}

console.log(`saucectl ${args.join(' ')}  (user: ${process.env.SAUCE_USERNAME})`);
/* On Windows the npm-installed saucectl is a .cmd shim, which needs a shell — and a shell splits
   unquoted arguments, so a suite name like "Demoshop Chrome - Windows 11" must be quoted. */
const isWindows = process.platform === 'win32';
const shellArgs = isWindows ? args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)) : args;
const result = spawnSync('saucectl', shellArgs, { stdio: 'inherit', shell: isWindows });
if (result.error) {
  console.error(
    `Could not start saucectl: ${result.error.message}\nInstall it with: npm install -g saucectl`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
