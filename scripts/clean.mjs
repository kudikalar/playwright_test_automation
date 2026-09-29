#!/usr/bin/env node
/**
 * Removes generated artifacts: reports, logs, traces, downloads, test results and stored
 * sessions. Baselines under tests/visual/__screenshots__ are never touched.
 */
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'reports/playwright',
  'reports/extent',
  'reports/json',
  'reports/junit',
  'reports/screenshots',
  'reports/videos',
  'reports/traces',
  'reports/downloads',
  'reports/run-context.json',
  'test-results',
  'playwright-report',
  'logs',
  'storage/auth',
];

/* Folders the repository keeps in git via a .gitkeep placeholder. */
const keepSkeleton = ['logs', 'storage/auth', 'reports'];

let removed = 0;
for (const target of targets) {
  const path = resolve(root, target);
  if (!existsSync(path)) continue;
  rmSync(path, { recursive: true, force: true });
  removed += 1;
  console.log(`removed ${target}`);
}

for (const target of keepSkeleton) {
  const path = resolve(root, target);
  mkdirSync(path, { recursive: true });
  writeFileSync(resolve(path, '.gitkeep'), '');
}

console.log(removed === 0 ? 'nothing to clean' : `cleaned ${removed} path(s)`);
