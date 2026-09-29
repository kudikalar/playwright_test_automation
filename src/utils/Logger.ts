/**
 * Centralised structured logger.
 *
 * Emits `timestamp | level | scope | message` lines to the console and, optionally, to a
 * per-run file under `logs/`. Every payload passes through {@link maskValue} first, so a secret
 * cannot reach a log line even if a caller passes one in.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { frameworkConfig } from '../../config/framework.config';
import { LOG_LEVELS, PATHS } from '../constants/FrameworkConstants';
import type { LogLevel } from '../types/Environment';
import { maskString, maskValue } from './DataMasker';

interface LogScope {
  /** Test title, when logging from inside a test. */
  readonly test?: string;
  /** Business module or framework area, e.g. `EmployeePage`, `ApiClient`. */
  readonly module?: string;
}

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const ESC = String.fromCharCode(27);
const COLOURS: Readonly<Record<LogLevel, string>> = {
  DEBUG: `${ESC}[90m`,
  INFO: `${ESC}[36m`,
  WARN: `${ESC}[33m`,
  ERROR: `${ESC}[31m`,
};
const RESET = `${ESC}[0m`;
const useColour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

let logFilePath: string | undefined;
let fileLoggingBroken = false;

function resolveLogFile(): string | undefined {
  if (!frameworkConfig.logToFile || fileLoggingBroken) return undefined;
  if (logFilePath) return logFilePath;
  try {
    mkdirSync(PATHS.logs, { recursive: true });
    logFilePath = resolve(PATHS.logs, `run-${frameworkConfig.runId}.log`);
    return logFilePath;
  } catch (error) {
    fileLoggingBroken = true;
    console.warn(`[Logger] file logging disabled: ${(error as Error).message}`);
    return undefined;
  }
}

const configuredLevel: LogLevel = LOG_LEVELS.includes(frameworkConfig.logLevel)
  ? frameworkConfig.logLevel
  : 'INFO';

export class Logger {
  private readonly scope: LogScope;

  constructor(scope: LogScope = {}) {
    this.scope = scope;
  }

  /** Returns a logger that inherits this scope and narrows it further. */
  public child(scope: LogScope): Logger {
    return new Logger({ ...this.scope, ...scope });
  }

  public debug(message: string, payload?: unknown): void {
    this.write('DEBUG', message, payload);
  }

  public info(message: string, payload?: unknown): void {
    this.write('INFO', message, payload);
  }

  public warn(message: string, payload?: unknown): void {
    this.write('WARN', message, payload);
  }

  public error(message: string, payload?: unknown): void {
    this.write('ERROR', message, payload);
  }

  /** Logs a UI or API action in a consistent `action -> target` shape. */
  public action(action: string, target: string, payload?: unknown): void {
    this.write('DEBUG', `${action} -> ${target}`, payload);
  }

  /** Times an async operation and logs its duration, re-throwing any failure untouched. */
  public async step<T>(description: string, operation: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await operation();
      this.debug(`${description} (${Date.now() - started}ms)`);
      return result;
    } catch (error) {
      this.error(`${description} failed after ${Date.now() - started}ms`, error);
      throw error;
    }
  }

  private write(level: LogLevel, message: string, payload?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[configuredLevel]) return;

    const timestamp = new Date().toISOString();
    const scopeParts = [this.scope.module, this.scope.test].filter(Boolean).join(' | ');
    const safeMessage = maskString(message);
    const safePayload = payload === undefined ? '' : ` ${JSON.stringify(maskValue(payload))}`;
    const line = `${timestamp} | ${level.padEnd(5)} | ${scopeParts || 'framework'} | ${safeMessage}${safePayload}`;
    const decorated = useColour ? `${COLOURS[level]}${line}${RESET}` : line;

    if (level === 'ERROR') console.error(decorated);
    else if (level === 'WARN') console.warn(decorated);
    else process.stdout.write(`${decorated}\n`);

    const file = resolveLogFile();
    if (file) {
      try {
        appendFileSync(file, `${line}\n`, 'utf8');
      } catch (error) {
        fileLoggingBroken = true;
        console.warn(`[Logger] file sink stopped: ${(error as Error).message}`);
      }
    }
  }
}

/** Shared root logger for framework-level messages. */
export const logger = new Logger({ module: 'framework' });

/** Convenience factory for module-scoped loggers. */
export function createLogger(module: string, test?: string): Logger {
  return new Logger(test === undefined ? { module } : { module, test });
}
