/**
 * ApiClient — the single HTTP entry point for every API interaction.
 *
 * Domain services build on this class; tests never call it directly with raw paths. It owns base
 * URL resolution, headers, authentication, query/path parameters, timeouts, retries for
 * idempotent calls, response parsing and masked request/response logging.
 */

import type { APIRequestContext, APIResponse } from '@playwright/test';

import { getEnvironment } from '../../../config/environment.config';
import { frameworkConfig } from '../../../config/framework.config';
import {
  CONTENT_TYPES,
  HTTP_HEADERS,
  IDEMPOTENT_METHODS,
  RETRYABLE_STATUS_CODES,
} from '../../constants/ApiConstants';
import type { ApiEnvelope, ApiResponse, HttpMethod } from '../../types/ApiModels';
import type { ResolvedEnvironment } from '../../types/Environment';
import { maskHeaders, maskUrl, maskValue } from '../../utils/DataMasker';
import { ApiRequestError } from '../../utils/FrameworkError';
import { createLogger, type Logger } from '../../utils/Logger';
import { withRetry } from '../../utils/RetryUtils';

export interface RequestOptions {
  /** Values substituted into `:name` placeholders in the path. */
  readonly pathParams?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Send a raw string body (malformed-JSON negative tests). */
  readonly rawBody?: string;
  readonly timeout?: number;
  /** Omit the Authorization header for this call (unauthenticated negative tests). */
  readonly skipAuth?: boolean;
  /** Use the API key instead of the bearer token. */
  readonly useApiKey?: boolean;
  /** Correlation id echoed into logs and reports. */
  readonly correlationId?: string;
  /** Overrides the client's retry policy for this call. */
  readonly maxAttempts?: number;
}

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly timeout?: number;
  readonly maxAttempts?: number;
  readonly logger?: Logger;
}

export class ApiClient {
  private readonly request: APIRequestContext;
  private readonly environment: ResolvedEnvironment;
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeout: number;
  private readonly maxAttempts: number;
  private readonly log: Logger;
  private authToken: string | undefined;

  constructor(request: APIRequestContext, options: ApiClientOptions = {}) {
    this.request = request;
    this.environment = getEnvironment();
    this.baseUrl = (options.baseUrl ?? this.environment.api.baseUrl).replace(/\/+$/, '');
    this.timeout = options.timeout ?? this.environment.timeouts.api;
    this.maxAttempts = options.maxAttempts ?? this.environment.retries.apiMaxAttempts;
    this.log = options.logger ?? createLogger('ApiClient');
    this.defaultHeaders = {
      [HTTP_HEADERS.accept]: CONTENT_TYPES.json,
      [HTTP_HEADERS.contentType]: CONTENT_TYPES.json,
      ...options.defaultHeaders,
    };
  }

  /* ------------------------------------------------------ authentication -- */

  /** Stores the bearer token used by subsequent calls. Never logged. */
  public setAuthToken(token: string): void {
    this.authToken = token;
    this.log.debug('bearer token set for API client');
  }

  public clearAuthToken(): void {
    this.authToken = undefined;
  }

  public get isAuthenticated(): boolean {
    return this.authToken !== undefined;
  }

  /** Returns a client bound to the same context with an explicit token (role impersonation). */
  public withToken(token: string): ApiClient {
    const clone = new ApiClient(this.request, {
      baseUrl: this.baseUrl,
      defaultHeaders: this.defaultHeaders,
      timeout: this.timeout,
      maxAttempts: this.maxAttempts,
      logger: this.log,
    });
    clone.setAuthToken(token);
    return clone;
  }

  /* -------------------------------------------------------------- verbs -- */

  public async get<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.send<T>('GET', path, options);
  }

  public async post<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.send<T>('POST', path, options);
  }

  public async put<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.send<T>('PUT', path, options);
  }

  public async patch<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.send<T>('PATCH', path, options);
  }

  public async delete<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.send<T>('DELETE', path, options);
  }

  /* ------------------------------------------------------------ internals -- */

  private buildUrl(path: string, options: RequestOptions): string {
    let resolvedPath = path;
    for (const [key, value] of Object.entries(options.pathParams ?? {})) {
      resolvedPath = resolvedPath.replace(`:${key}`, encodeURIComponent(String(value)));
    }
    const remaining = /:([A-Za-z_][A-Za-z0-9_]*)/.exec(resolvedPath);
    if (remaining) {
      throw new ApiRequestError('Unresolved path parameter', {
        operation: 'buildUrl',
        target: path,
        expected: `a value for ":${remaining[1] ?? ''}" in pathParams`,
      });
    }

    const url = new URL(
      `${this.baseUrl}${resolvedPath.startsWith('/') ? resolvedPath : `/${resolvedPath}`}`,
    );
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private buildHeaders(options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = { ...this.defaultHeaders, ...options.headers };

    if (!options.skipAuth) {
      if (options.useApiKey) {
        const apiKey = this.environment.apiKey();
        if (apiKey) headers[HTTP_HEADERS.apiKey] = apiKey;
      } else if (this.authToken) {
        headers[HTTP_HEADERS.authorization] = `Bearer ${this.authToken}`;
      }
    } else {
      delete headers[HTTP_HEADERS.authorization];
      delete headers[HTTP_HEADERS.apiKey];
    }

    if (options.correlationId) headers[HTTP_HEADERS.correlationId] = options.correlationId;
    return headers;
  }

  private async send<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions,
  ): Promise<ApiResponse<T>> {
    const url = this.buildUrl(path, options);
    const headers = this.buildHeaders(options);
    const timeout = options.timeout ?? this.timeout;
    const attempts =
      options.maxAttempts ?? (IDEMPOTENT_METHODS.includes(method) ? this.maxAttempts : 1);

    this.log.debug(`-> ${method} ${maskUrl(url)}`, {
      headers: maskHeaders(headers),
      body: frameworkConfig.verboseApiLogging ? maskValue(options.body) : undefined,
    });

    const started = Date.now();
    const raw = await withRetry(
      async () => {
        const response = await this.request.fetch(url, {
          method,
          headers,
          timeout,
          /*
           * A raw body is sent as bytes: Playwright re-serialises a *string* body when the
           * content type is JSON, which would silently repair the malformed payload a negative
           * test is trying to send.
           */
          ...(options.rawBody !== undefined
            ? { data: Buffer.from(options.rawBody, 'utf8') }
            : options.body !== undefined
              ? { data: JSON.stringify(options.body) }
              : {}),
        });
        if (RETRYABLE_STATUS_CODES.includes(response.status()) && attempts > 1) {
          throw new ApiRequestError('Retryable status received', {
            operation: 'send',
            target: `${method} ${maskUrl(url)}`,
            actual: `HTTP ${response.status()}`,
          });
        }
        return response;
      },
      {
        maxAttempts: attempts,
        baseDelayMs: this.environment.retries.apiBackoffMs,
        description: `${method} ${maskUrl(url)}`,
        retryOn: (error) =>
          error instanceof ApiRequestError ||
          (error instanceof Error &&
            /ECONNRESET|ECONNREFUSED|socket hang up|timeout/i.test(error.message)),
      },
    ).catch((error: unknown) => {
      throw new ApiRequestError(
        'API request failed',
        {
          operation: `${method} request`,
          target: maskUrl(url),
          environment: this.environment.name,
          timeout,
          attempts,
        },
        error,
      );
    });

    return this.parse<T>(raw, method, url, Date.now() - started);
  }

  private async parse<T>(
    raw: APIResponse,
    method: HttpMethod,
    url: string,
    durationMs: number,
  ): Promise<ApiResponse<T>> {
    const status = raw.status();
    const headers = raw.headers();

    let body: ApiEnvelope<T>;
    if (status === 204) {
      body = { success: true };
    } else {
      const text = await raw.text();
      if (text.trim() === '') {
        body = { success: raw.ok() };
      } else {
        try {
          body = JSON.parse(text) as ApiEnvelope<T>;
        } catch (error) {
          throw new ApiRequestError(
            'API response was not valid JSON',
            {
              operation: 'parseResponse',
              target: `${method} ${maskUrl(url)}`,
              actual: text.slice(0, 300),
              status,
            },
            error,
          );
        }
      }
    }

    const response: ApiResponse<T> = {
      status,
      ok: raw.ok(),
      headers,
      body,
      data: body.data,
      error: body.error,
      meta: body.meta,
      durationMs,
      requestId: headers['x-request-id'],
      url,
      method,
    };

    this.log.debug(`<- ${status} ${method} ${maskUrl(url)} (${durationMs}ms)`, {
      requestId: response.requestId,
      body: frameworkConfig.verboseApiLogging ? maskValue(body) : undefined,
    });

    return response;
  }
}
