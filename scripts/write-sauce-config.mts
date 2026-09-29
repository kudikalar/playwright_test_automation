#!/usr/bin/env node
/**
 * Regenerates `.sauce/config.yml` from the typed definition in
 * `src/integrations/sauce/SauceConfig.ts`, so the file saucectl reads and the configuration the
 * framework reasons about cannot drift apart.
 *
 * The generated file references SAUCE_USERNAME / SAUCE_ACCESS_KEY by name and never contains a
 * credential: saucectl resolves them from the environment at run time.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SAUCECTL_CONFIG,
  saucectlRunCommand,
  toSaucectlYaml,
} from '../src/integrations/sauce/SauceConfig.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, '.sauce/config.yml');

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, toSaucectlYaml(SAUCECTL_CONFIG), 'utf8');

console.log(`wrote ${target}`);
console.log(`suites: ${SAUCECTL_CONFIG.suites.map((suite) => suite.name).join(', ')}`);
console.log('\nRun it with:\n  ' + saucectlRunCommand());
