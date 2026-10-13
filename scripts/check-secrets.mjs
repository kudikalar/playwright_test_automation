#!/usr/bin/env node
/**
 * Fails when a committed file contains something that looks like a live credential.
 *
 * Runs in CI (static-checks) and locally via `npm run secrets:check`. It scans every file git
 * tracks — not `.env`, which is ignored — for the credential shapes this framework handles:
 * Sauce Labs access keys, Atlassian API tokens, Slack webhooks / bot tokens, SMTP passwords and
 * generic `KEY=value` assignments to secret-named variables.
 *
 * Deliberately pattern-based and dependency-free so it can run before `npm ci`.
 */

import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  {
    name: 'Sauce Labs access key (UUID assigned to SAUCE_ACCESS_KEY)',
    pattern:
      /SAUCE_ACCESS_KEY[ \t]*[=:][ \t]*['"]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  },
  { name: 'Atlassian API token', pattern: /\bATATT[A-Za-z0-9_\-=]{20,}/ },
  {
    name: 'Slack incoming webhook',
    pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{16,}/,
  },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    name: 'Secret-named variable with a literal value',
    pattern:
      /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:PASSWORD|ACCESS_KEY|API_TOKEN|SECRET|PRIVATE_KEY)[ \t]*=[ \t]*['"]?(?!\$\{|<|your|changeme|xxx)[^\s'"#]{8,}/im,
    /* Only meaningful in env-style files; source code legitimately names these variables. */
    files: /(^|\/)\.env[^/]*$|\.(?:ya?ml|properties|ini|cfg)$/,
  },
];

const SKIP =
  /(^|\/)(node_modules|package-lock\.json|reports|test-results)(\/|$)|\.(png|jpe?g|gif|webm|zip|ico|woff2?)$/i;

let files;
try {
  files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  console.error('secrets:check must run inside a git checkout.');
  process.exit(2);
}

const findings = [];
for (const file of files) {
  if (SKIP.test(file)) continue;
  let text;
  try {
    if (statSync(file).size > 2_000_000) continue;
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const rule of RULES) {
    if (rule.files && !rule.files.test(file)) continue;
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split('\n').length;
    findings.push(`${file}:${line}  ${rule.name}`);
  }
}

if (findings.length > 0) {
  console.error('Possible credentials committed to the repository:\n');
  for (const finding of findings) console.error(`  ✖ ${finding}`);
  console.error(
    '\nMove the value to .env (git-ignored) or a CI secret, then ROTATE it — anything that was\n' +
      'pushed is in git history and must be treated as leaked.',
  );
  process.exit(1);
}

console.log(`secrets:check — ${files.length} tracked files scanned, no credentials found.`);
