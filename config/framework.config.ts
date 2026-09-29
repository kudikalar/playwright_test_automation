/**
 * Execution configuration: how a run behaves, as opposed to what it targets.
 *
 * Every value has a safe default and may be overridden by an environment variable, so the same
 * configuration serves an engineer's laptop and a CI matrix without conditional logic in tests.
 */

import { cpus } from 'node:os';

import { getEnvironment } from './environment.config';
import type { LogLevel } from '../src/types/Environment';

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const environment = getEnvironment();
const isCi = environment.isCi;

export interface FrameworkExecutionConfig {
  readonly isCi: boolean;
  readonly headless: boolean;
  readonly slowMoMs: number;
  readonly workers: number;
  readonly retries: number;
  readonly logLevel: LogLevel;
  readonly logToFile: boolean;
  readonly extentEnabled: boolean;
  readonly reuseAuthState: boolean;
  /** Start the bundled reference application for this run (local sandbox only). */
  readonly startReferenceApp: boolean;
  readonly referenceAppPort: number;
  /** Capture request/response bodies in API logs (never secrets — those are masked). */
  readonly verboseApiLogging: boolean;
  readonly runId: string;
}

const referenceAppPort = int(process.env.DEMO_APP_PORT, 4321);

export const frameworkConfig: FrameworkExecutionConfig = {
  isCi,
  /*
   * Headed locally so a run can be watched; always headless on CI, where there is no display
   * server and a headed launch simply fails. Override either way with HEADLESS=true|false.
   * Watching a run is worth knowing the cost of: headed browsers inherit the desktop's display
   * scaling (which shifts visual baselines by a pixel unless the project pins the scale factor)
   * and contend for the GPU, so the slower engines start timing out well before six workers.
   */
  headless: bool(process.env.HEADLESS, isCi),
  slowMoMs: int(process.env.SLOW_MO, 0),
  workers: int(
    process.env.WORKERS,
    isCi ? 2 : Math.max(1, Math.min(2, Math.floor(cpus().length / 2))),
  ),
  retries: int(process.env.RETRIES, isCi ? environment.retries.ci : environment.retries.local),
  logLevel: (process.env.LOG_LEVEL as LogLevel | undefined) ?? (isCi ? 'INFO' : 'DEBUG'),
  logToFile: bool(process.env.LOG_TO_FILE, true),
  extentEnabled: bool(process.env.EXTENT_REPORT, true),
  reuseAuthState: bool(process.env.REUSE_AUTH_STATE, true),
  startReferenceApp:
    bool(process.env.START_REFERENCE_APP, environment.name === 'dev') &&
    environment.ui.baseUrl.includes(String(referenceAppPort)),
  referenceAppPort,
  verboseApiLogging: bool(process.env.VERBOSE_API_LOGGING, !isCi),
  runId: process.env.RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-'),
};
