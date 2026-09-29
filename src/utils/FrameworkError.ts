/** Typed errors carrying debugging context (rule 26: never swallow, always explain). */

export interface ErrorContext {
  readonly operation: string;
  readonly target?: string;
  readonly page?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly environment?: string;
  readonly url?: string;
  readonly [key: string]: unknown;
}

/** Stringifies an unknown cause without relying on Object's default representation. */
const describe = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  try {
    return JSON.stringify(value) ?? 'unknown cause';
  } catch {
    return 'unserialisable cause';
  }
};

const renderContext = (context: ErrorContext): string =>
  Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');

/** Base class for every framework-raised error; always preserves the original cause. */
export class FrameworkError extends Error {
  public readonly context: ErrorContext;

  constructor(message: string, context: ErrorContext, cause?: unknown) {
    const causeMessage =
      cause instanceof Error
        ? cause.message
        : cause === undefined || cause === null
          ? undefined
          : describe(cause);
    super(
      [message, renderContext(context), causeMessage ? `  cause: ${causeMessage}` : undefined]
        .filter(Boolean)
        .join('\n'),
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = new.target.name;
    this.context = context;
  }
}

/** A UI interaction failed (click, fill, wait …). */
export class UiActionError extends FrameworkError {}

/** An API call failed at the transport level or returned an unusable payload. */
export class ApiRequestError extends FrameworkError {}

/** A JSON dataset is missing, unreadable or does not match its declared shape. */
export class TestDataError extends FrameworkError {}

/** A validation/assertion helper detected a contract breach. */
export class ValidationError extends FrameworkError {}
