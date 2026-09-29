#!/usr/bin/env node
/**
 * Release gate: runs the checks a pull request must pass, in the cheapest-first order, and
 * prints a single verdict. Used locally and by CI.
 */
import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'TypeScript', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'ESLint', command: 'npm', args: ['run', 'lint'] },
  { name: 'Prettier', command: 'npm', args: ['run', 'format:check'] },
  { name: 'API suite', command: 'npx', args: ['playwright', 'test', '--project=api'] },
  {
    name: 'UI smoke',
    command: 'npx',
    args: ['playwright', 'test', '--project=chromium', '--grep', '@smoke'],
  },
];

const results = [];
for (const step of steps) {
  process.stdout.write(`\n▶ ${step.name}\n`);
  const started = Date.now();
  const outcome = spawnSync(step.command, step.args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  results.push({ name: step.name, ok: outcome.status === 0, durationMs: Date.now() - started });
}

console.log('\n──────── verification summary ────────');
for (const result of results) {
  console.log(
    `${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(12)} ${Math.round(result.durationMs / 1000)}s`,
  );
}
const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0 ? '\nAll checks passed.' : `\n${failed.length} check(s) failed.`);
process.exit(failed.length === 0 ? 0 : 1);
